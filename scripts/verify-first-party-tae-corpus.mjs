import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/+([A-Z]):/, '$1:'));
const gameRoot = process.env.SOULFORGE_TAE_CORPUS_ROOT?.trim()
  || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
const bridge = process.env.SOULFORGE_BRIDGE_PATH?.trim()
  || join(repoRoot, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe');

if (!gameRoot || !existsSync(gameRoot)) {
  console.log(JSON.stringify({ status: 'not-attempted', code: 'TAE_CORPUS_ROOT_UNAVAILABLE' }));
  process.exit(0);
}
if (!existsSync(bridge)) {
  console.error(`TAE_BRIDGE_UNAVAILABLE: ${bridge}`);
  process.exit(2);
}

const schemaText = readFileSync(join(repoRoot, 'bridge', 'SoulForge.Bridge', 'FormatRules', 'sekiro-tae-schema.v1.json.gz.base64'), 'utf8');
const schema = JSON.parse(gunzipSync(Buffer.from(schemaText.replace(/\s+/gu, ''), 'base64')));
const candidates = new Map();
for (const bank of schema.banks) {
  for (const event of bank.events) {
    const entries = candidates.get(event.id) ?? [];
    entries.push({ bankId: bank.id, bankName: bank.name, ...event });
    candidates.set(event.id, entries);
  }
}

function run(command, file, options) {
  const args = [command, file];
  if (options !== undefined) args.push(JSON.stringify(options));
  const result = spawnSync(bridge, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  const text = String(result.stdout ?? '').trim();
  if (!text) throw new Error(`${command} 没有返回 JSON：${result.stderr ?? ''}`);
  const parsed = JSON.parse(text);
  if (parsed.parseStatus === 'failed') throw new Error(parsed.diagnostics?.[0]?.message ?? `${command} failed`);
  return parsed;
}

function collect(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path, output);
    else if (/\.anibnd(?:\.dcx)?$/iu.test(entry.name)) output.push(path);
  }
  return output;
}

const assertObservations = new Map();

function readNumeric(bytes, offset, type) {
  switch (type) {
    case 'u8': return bytes.readUInt8(offset);
    case 's8': return bytes.readInt8(offset);
    case 'u16': return bytes.readUInt16LE(offset);
    case 's16': return bytes.readInt16LE(offset);
    case 'u32': return bytes.readUInt32LE(offset);
    case 's32': return bytes.readInt32LE(offset);
    case 's64': return Number(bytes.readBigInt64LE(offset));
    case 'f32': return bytes.readFloatLE(offset);
    case 'b': return bytes.readUInt8(offset);
    default: return undefined;
  }
}

function parseTae(bytes, observations) {
  if (bytes.length < 0x50 || bytes.toString('ascii', 0, 4) !== 'TAE ') return;
  const i64 = (offset) => Number(bytes.readBigInt64LE(offset));
  const i32 = (offset) => bytes.readInt32LE(offset);
  const eventBank = i64(0x30);
  const section1 = i64(0x20);
  const count = i32(section1 + 0x04);
  const table = i64(section1 + 0x08) + 8;
  for (let animationIndex = 0; animationIndex < count; animationIndex += 1) {
    const animationEntry = table + animationIndex * 16;
    const animation = i64(animationEntry);
    const animationId = i64(animationEntry + 8);
    const eventCount = i32(animation + 0x20);
    const eventTable = i64(animation);
    const eventGroupTable = i64(animation + 0x08);
    for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
      const eventTableEntry = eventTable + eventIndex * 24;
      const eventData = i64(eventTableEntry + 16);
      const parameter = i64(eventData + 8);
      const next = eventIndex + 1 < eventCount
        ? i64(eventTable + (eventIndex + 1) * 24 + 16)
        : eventGroupTable > 0 ? eventGroupTable : bytes.length;
      const length = parameter === 0 ? 0 : next - parameter;
      const eventTypeId = i32(eventData);
      const key = `${eventBank}:${eventTypeId}`;
      const item = observations.get(key) ?? { bankId: eventBank, eventTypeId, count: 0, lengths: new Map() };
      item.count += 1;
      item.lengths.set(length, (item.lengths.get(length) ?? 0) + 1);
      observations.set(key, item);

      const eventCandidates = (candidates.get(eventTypeId) ?? [])
        .filter((candidate) => candidate.bankId === eventBank);
      const exact = eventCandidates.filter((candidate) => candidate.paramSize === length);
      const fitting = eventCandidates
        .filter((candidate) => candidate.paramSize <= length)
        .sort((left, right) => right.paramSize - left.paramSize);
      const selected = exact[0] ?? fitting[0];
      if (selected && parameter !== 0 && selected.fields) {
        for (const field of selected.fields) {
          if (field.assert === undefined || field.offset + field.size > length) continue;
          const value = readNumeric(bytes, parameter + field.offset, field.type);
          if (value === undefined || Object.is(value, field.assert)) continue;
          const assertKey = `${eventBank}:${eventTypeId}:${length}:${field.name}:${field.type}:${field.assert}:${value}`;
          const assertItem = assertObservations.get(assertKey) ?? {
            bankId: eventBank,
            eventTypeId,
            parameterLength: length,
            field: field.name,
            type: field.type,
            offset: field.offset,
            expected: field.assert,
            actual: value,
            count: 0,
            examples: []
          };
          assertItem.count += 1;
          if (assertItem.examples.length < 3) {
            assertItem.examples.push({
              animationId,
              eventIndex,
              parameterHex: bytes.subarray(parameter, parameter + length).toString('hex')
            });
          }
          assertObservations.set(assertKey, assertItem);
        }
      }
    }
  }
}

const filter = process.env.SOULFORGE_TAE_CORPUS_FILTER?.trim().toLowerCase();
const files = collect(resolve(gameRoot)).filter((file) => !filter || file.toLowerCase().includes(filter));
const limit = Number.isInteger(Number(process.env.SOULFORGE_TAE_CORPUS_LIMIT))
  ? Math.max(1, Number(process.env.SOULFORGE_TAE_CORPUS_LIMIT))
  : files.length;
const observations = new Map();
const unknown = [];
const lengthGaps = [];
let taeChildren = 0;
for (const file of files.slice(0, limit)) {
  const listed = run('list-bnd4-entries', file);
  const taeEntries = (listed.data?.entries ?? [])
    .filter((entry) => /\.tae$/iu.test(String(entry.name ?? '')));
  if (taeEntries.length === 0) continue;

  const document = run('read-tae-document', file, { animationPage: 0, animationPageSize: 1 });
  const bridgeCoverage = document.data?.schemaCoverage;
  if (!bridgeCoverage
    || bridgeCoverage.unknownEventCount !== 0
    || bridgeCoverage.lengthMismatchCount !== 0
    || bridgeCoverage.ambiguousEventCount !== 0
    || bridgeCoverage.assertFailureCount !== 0) {
    lengthGaps.push({
      file,
      code: 'TAE_BRIDGE_SCHEMA_COVERAGE_GAP',
      coverage: bridgeCoverage ?? null,
      diagnostics: document.diagnostics ?? []
    });
  }
  for (const entry of taeEntries) {
    const snapshot = run('snapshot-bnd4-child', file, { entryIndex: entry.index });
    parseTae(Buffer.from(snapshot.data.contentBase64, 'base64'), observations);
    taeChildren += 1;
  }
}

for (const [, observation] of observations) {
  const eventTypeId = observation.eventTypeId;
  const defs = (candidates.get(eventTypeId) ?? []).filter((item) => item.bankId === observation.bankId);
  if (defs.length === 0) {
    unknown.push({ eventBank: observation.bankId, eventTypeId, count: observation.count, lengths: Object.fromEntries(observation.lengths) });
    continue;
  }
  for (const [length, count] of observation.lengths) {
    if (!defs.some((item) => item.paramSize === length)) {
      lengthGaps.push({ eventBank: observation.bankId, eventTypeId, length, count, variants: defs });
    }
  }
}

console.log(JSON.stringify({
  status: 'verified-observed',
  files: Math.min(files.length, limit),
  taeChildren,
  eventTypes: new Set([...observations.values()].map((item) => item.eventTypeId)).size,
  events: [...observations.values()].reduce((sum, item) => sum + item.count, 0),
  ...(process.env.SOULFORGE_TAE_CORPUS_VERBOSE === '1'
    ? { observed: [...observations.values()].map((item) => ({ eventBank: item.bankId, eventTypeId: item.eventTypeId, count: item.count, lengths: Object.fromEntries(item.lengths) })) }
    : {}),
  ...(process.env.SOULFORGE_TAE_ASSERT_DETAILS === '1'
    ? { assertObservations: [...assertObservations.values()].sort((left, right) => right.count - left.count) }
    : {}),
  unknown,
  lengthGaps
}, null, 2));
if (unknown.length > 0 || lengthGaps.length > 0) process.exitCode = 2;
