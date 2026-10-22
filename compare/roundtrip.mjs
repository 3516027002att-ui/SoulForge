// FMG write round trip for compare/run.mjs (operation "write-roundtrip"). The Bridge writes into a fresh staging root
// under the OS temp directory; the pinned reference tool reads both the source and the output, and lib.mjs
// fmgRoundtripComparisons decides. The expectation never comes from the Bridge result. Dependencies are injected so the
// rule can be driven without run.mjs: runBridge (packages/core dist), readTables(file) -> { status, reason, tables,
// entries } read by the reference tool.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { float32Bits, fmgRoundtripComparisons, pickFmgEditTarget, taeRoundtripComparisons } from './lib.mjs';

export const L1_TEXT_SUFFIX = ' [soulforge-roundtrip-L1]';
// One frame at 30 fps: the TAE L1 edit moves one event's start and end by this.
export const TAE_L1_SHIFT_SECONDS = 1 / 30;
// Candidate events tried in native order; the writer refuses an event whose time slot a sibling shares.
const TAE_TARGET_CANDIDATES = 8;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (child, parent) => { const rel = relative(resolve(parent), resolve(child)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

async function writeFmg(runBridge, file, gameRoot, stagingRoot, outputPath, sourceSha256, target, text) {
  const result = await runBridge({ command: 'write-fmg', filePath: file, allowedRoots: [gameRoot], writableRoots: [stagingRoot],
    oodleRuntimeRoot: gameRoot, timeoutMs: 120_000,
    commandOptions: { outputPath, expectedDocumentHash: sourceSha256, entryIndex: target.ordinal, disallowAmbiguous: true,
      mutations: [{ kind: 'upsert', id: target.id, text }] } });
  const verified = (result.diagnostics ?? []).some(item => item.code === 'FMG_STAGING_WRITE_VERIFIED');
  if (!verified || !existsSync(outputPath)) return { error: result.diagnostics?.[0]?.code ?? 'BRIDGE_WRITE_FAILED' };
  return { ok: true };
}

// Returns { target, levels: [{ level, edit, write, outputSha256, byteIdentical, reference, comparisons }] }.
export async function fmgWriteRoundtrip({ file, gameRoot, runBridge, readTables }) {
  const sourceBefore = sha256(readFileSync(file));
  const stagingRoot = join(tmpdir(), `soulforge-roundtrip-${randomUUID()}`);
  // The staging root must not be inside the game root (which also holds mods/).
  if (inside(stagingRoot, gameRoot)) throw new Error('staging root resolves inside the game root');
  mkdirSync(stagingRoot, { recursive: false });
  try {
    const source = readTables(file);
    if (source.status !== 'ok') return { reference: source, levels: [] };
    const target = pickFmgEditTarget(source.tables.map(table => ({ ordinal: table.ordinal, entries: source.entries.get(table.ordinal) })));
    const levels = [];
    for (const [level, text, edit] of [
      ['L0', target.text, null],
      ['L1', target.text + L1_TEXT_SUFFIX, { ordinal: target.ordinal, id: target.id, text: target.text + L1_TEXT_SUFFIX }]]) {
      const outputPath = join(stagingRoot, level, file.split(/[\\/]/u).pop());
      if (!inside(outputPath, stagingRoot)) throw new Error('output path escapes the staging root');
      mkdirSync(join(stagingRoot, level));
      const write = await writeFmg(runBridge, file, gameRoot, stagingRoot, outputPath, sourceBefore, target, text);
      if (write.error) { levels.push({ level, edit, write }); continue; }
      const outputBytes = readFileSync(outputPath);
      const output = readTables(outputPath);
      levels.push({ level, edit, write, outputSha256: sha256(outputBytes), byteIdentical: sha256(outputBytes) === sourceBefore,
        reference: { status: output.status, reason: output.reason },
        comparisons: output.status === 'ok' ? fmgRoundtripComparisons(source, output, edit) : null });
    }
    return { reference: { status: 'ok' }, target: { ordinal: target.ordinal, id: target.id }, levels };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    const sourceAfter = sha256(readFileSync(file));
    if (sourceAfter !== sourceBefore) throw new Error(`SOURCE_CHANGED: ${file} sha256 changed during the round trip`);
  }
}

// float32 bits (lib.mjs float32Bits text) -> the exact float as a JS number, so an unchanged time writes the same bits.
export function float32FromBits(bits) {
  if (!/^[0-9A-Fa-f]{8}$/u.test(bits)) throw new Error(`not float32 bits: ${bits}`);
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, Number.parseInt(bits, 16));
  return view.getFloat32(0);
}
const bitsToSeconds = float32FromBits;

// TAE write round trip for compare/run.mjs (operation "write-roundtrip"): the production anibnd TAE writer
// (core commitTaeEventContainerViaBridge: extract child, write-tae-document, write-bnd4) writes into a fresh staging
// root; the pinned reference reads source and output, and lib.mjs taeRoundtripComparisons decides. L0 rewrites one
// event's times unchanged, L1 moves them by one frame. Dependencies are injected: commitTae(request) -> { ok,
// diagnostics }, readEntries(file) -> { status, reason, entries }, decodeEntry(file, entry) -> { status, reason,
// animations } (taeEventsFromReferenceGraph shape).
export async function taeWriteRoundtrip({ file, gameRoot, commitTae, readEntries, decodeEntry }) {
  const sourceBefore = sha256(readFileSync(file));
  const stagingRoot = join(tmpdir(), `soulforge-roundtrip-${randomUUID()}`);
  if (inside(stagingRoot, gameRoot)) throw new Error('staging root resolves inside the game root');
  mkdirSync(stagingRoot, { recursive: false });
  try {
    const listing = readEntries(file);
    if (listing.status !== 'ok') return { reference: listing, levels: [] };
    let entry, source;
    for (const candidate of listing.entries) {
      const decoded = decodeEntry(file, candidate);
      if (decoded.status !== 'ok') return { reference: decoded, levels: [] };
      if (decoded.animations.some(animation => animation.events.length > 0)) { entry = candidate; source = decoded.animations; break; }
    }
    if (!entry) throw new Error('no TAE entry has an event to edit');
    const write = async (level, times) => {
      const outputPath = join(stagingRoot, level, file.split(/[\\/]/u).pop());
      if (!inside(outputPath, stagingRoot)) throw new Error('output path escapes the staging root');
      mkdirSync(join(stagingRoot, level), { recursive: true });
      const result = await commitTae({ sourcePath: file, outputPath, expectedDocumentHash: sourceBefore, allowedRoots: [gameRoot],
        writableRoots: [stagingRoot], oodleRuntimeRoot: gameRoot, taeEntryIndex: entry.ordinal,
        mutations: [{ mutation: 'update-event-times', taeEntryIndex: entry.ordinal, animId: Number(times.id), eventIndex: times.eventIndex,
          startTime: bitsToSeconds(times.start), endTime: bitsToSeconds(times.end) }] });
      return result.ok && existsSync(outputPath) ? { ok: true, outputPath }
        : { error: result.diagnostics?.find(item => item.severity === 'error')?.code ?? result.diagnostics?.[0]?.code ?? 'BRIDGE_WRITE_FAILED' };
    };
    // L1 picks the target: the first event, in native order, whose times the writer accepts moving.
    const candidates = source.flatMap(animation => animation.events.map((event, eventIndex) => ({ id: animation.id, eventIndex, event })))
      .slice(0, TAE_TARGET_CANDIDATES);
    const refused = [];
    let target, l1;
    for (const candidate of candidates) {
      const times = { id: candidate.id, eventIndex: candidate.eventIndex,
        start: float32Bits(bitsToSeconds(candidate.event.start) + TAE_L1_SHIFT_SECONDS),
        end: float32Bits(bitsToSeconds(candidate.event.end) + TAE_L1_SHIFT_SECONDS) };
      const attempt = await write(`L1-${refused.length}`, times);
      if (attempt.ok) { target = { ...candidate, times }; l1 = attempt; break; }
      refused.push({ id: candidate.id, eventIndex: candidate.eventIndex, code: attempt.error });
    }
    const sourceRead = { entries: listing.entries, animations: source };
    const levels = [];
    const check = (level, edit, attempt) => {
      if (attempt.error) return levels.push({ level, edit, write: attempt });
      const outputBytes = readFileSync(attempt.outputPath);
      const outputListing = readEntries(attempt.outputPath);
      if (outputListing.status !== 'ok') return levels.push({ level, edit, write: attempt, reference: outputListing });
      const outputEntry = outputListing.entries.find(item => item.ordinal === entry.ordinal);
      const decoded = outputEntry ? decodeEntry(attempt.outputPath, outputEntry) : { status: 'ok', animations: null };
      if (decoded.status !== 'ok') return levels.push({ level, edit, write: attempt, reference: decoded });
      levels.push({ level, edit, write: { ok: true }, outputSha256: sha256(outputBytes),
        childByteIdentical: outputEntry?.sha256 === entry.sha256, reference: { status: 'ok' },
        comparisons: taeRoundtripComparisons(sourceRead, { entries: outputListing.entries, animations: decoded.animations }, edit) });
    };
    if (!target) {
      // Every candidate was refused: report that as a failed write at both levels instead of a skip.
      levels.push({ level: 'L0', edit: null, write: { error: refused[0]?.code ?? 'TAE_NO_EVENT' } },
        { level: 'L1', edit: null, write: { error: refused[0]?.code ?? 'TAE_NO_EVENT' } });
      return { reference: { status: 'ok' }, entry: { ordinal: entry.ordinal, id: entry.id }, refused, levels };
    }
    const identity = { id: target.id, eventIndex: target.eventIndex, start: target.event.start, end: target.event.end };
    check('L0', { ordinal: entry.ordinal, times: null }, await write('L0', identity));
    check('L1', { ordinal: entry.ordinal, times: target.times }, l1);
    return { reference: { status: 'ok' }, entry: { ordinal: entry.ordinal, id: entry.id },
      target: { id: target.id, eventIndex: target.eventIndex }, refused, levels };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    const sourceAfter = sha256(readFileSync(file));
    if (sourceAfter !== sourceBefore) throw new Error(`SOURCE_CHANGED: ${file} sha256 changed during the round trip`);
  }
}
