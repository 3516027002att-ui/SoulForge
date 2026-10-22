#!/usr/bin/env node
// Compares SoulForge reads with the pinned reference tools on real game files. See compare/README.md.
// It needs the game and the reference CLI, so it is not part of the gate.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify, compareOrdered, emevdFromBridgePages, emevdFromReferenceGraph, emevdKeys, failedComparison, fmgEntriesFromBridge,
  fmgEntriesFromReferenceGraph, fmgEntryKey, groupStatus, msbFromBridge, msbFromReferenceGraph, msbKeys, paramFromReferenceGraph, paramKeys,
  readBridgeParam, referenceBlockingDiagnostic, referenceResultDirsToRemove, resolveReferenceResponse, staleKnownDiffs, taeAnimationsFromBridge,
  taeAnimationsFromReferenceGraph, taeEventsFromReferenceGraph } from './lib.mjs';
import { fmgWriteRoundtrip, taeWriteRoundtrip } from './roundtrip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/u, ''));
const corpus = readJson(join(root, 'compare/corpus.json'));
const pins = readJson(join(root, 'compare/references.json')).references;
const knownDiffs = readJson(join(root, 'compare/known-diffs.json'));
const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
const refcli = process.env.SOULFORGE_REFCLI?.trim();
const reportPath = join(root, 'output/compare/report.json');
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

// Exit codes: 0 every group matched or is a recorded known difference; 1 an unrecorded or stale difference;
// 2 the run itself failed; 3 something was not compared (missing game, reference CLI or pinned build).
if (!gameRoot || !existsSync(gameRoot)) {
  console.log(JSON.stringify({ status: 'not_run', reason: 'SOULFORGE_SEKIRO_GAME_ROOT must point at the game root' }));
  process.exit(3);
}
const coreDist = join(root, 'packages/core/dist');
const bridgeModule = join(coreDist, 'bridge/runBridge.js');
if (!existsSync(bridgeModule)) {
  console.log(JSON.stringify({ status: 'error', reason: 'packages/core/dist is missing; run npm run build first' }));
  process.exit(2);
}
const coreModule = path => import(pathToFileURL(join(coreDist, path)).href);
const { runBridge, disposeBridgeDaemonPool } = await coreModule('bridge/runBridge.js');
// The PARAM rule reads through the production reader and the editor's own row-width lookup, not a copy of them.
const { readParamDocumentViaBridge } = await coreModule('editing/paramBridgeCommit.js');
const { resolveTrustedParamRowWidth } = await coreModule('param/containerParamEdit.js');
// The TAE round trip writes through the production anibnd TAE writer, not a copy of it.
const { commitTaeEventContainerViaBridge } = await coreModule('editing/taeBridgeCommit.js');

// Reference CLI cost, reported with the run: refcli runs one request per project at a time (a concurrent one is
// status "blocked", PROJECT_BUSY), so the calls are sequential and their wall time adds up.
const referenceCalls = { count: 0, totalMs: 0 };
const referenceResultDirs = new Set();
function referenceCall(project, operation, args) {
  if (!refcli || !existsSync(refcli)) return { status: 'unavailable', reason: 'SOULFORGE_REFCLI must point at the reference CLI entry (refcli.mjs)' };
  const started = Date.now();
  const result = spawnSync(process.execPath, [refcli, '--stdin'], { input: JSON.stringify({ project, operation, args }),
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, windowsHide: true });
  referenceCalls.count++;
  referenceCalls.totalMs += Date.now() - started;
  if (result.error) return { status: 'unavailable', reason: result.error.message };
  let response;
  try { response = JSON.parse(result.stdout.replace(/^﻿/u, '')); }
  catch { return { status: 'unavailable', reason: `reference CLI exited ${result.status} without JSON` }; }
  try { response = resolveReferenceResponse(response, path => readFileSync(path)); }
  catch (error) { return { status: 'unavailable', reason: error.message }; }
  if (typeof response.resultDir === 'string') referenceResultDirs.add(response.resultDir);
  const reason = (response.diagnostics ?? []).map(item => item.code ?? item.message).filter(Boolean).join(', ') || response.status;
  // Checked before the status: a PARAMDEF_* diagnostic means the requested read did not happen, even if status is "ok".
  if (referenceBlockingDiagnostic(response)) return { status: 'unsupported', reason };
  if (response.status === 'unsupported') return { status: 'unsupported', reason };
  if (response.status !== 'ok') return { status: 'unavailable', reason };
  const pin = pins[project];
  const identity = response.source?.identity;
  if (!pin || response.source?.repository !== pin.repository || response.source?.commit !== pin.commit
    || identity?.matches !== true || identity?.clean !== true) {
    return { status: 'unavailable', reason: 'reference build does not match compare/references.json' };
  }
  return { status: 'ok', response };
}

function referenceArtifact(response, name) {
  const artifact = response.artifacts?.find(item => item.relativePath === name);
  if (!artifact) throw new Error(`reference result has no ${name}`);
  if (statSync(artifact.path).size > MAX_ARTIFACT_BYTES) throw new Error(`reference ${name} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  const bytes = readFileSync(artifact.path);
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error(`reference ${name} hash mismatch`);
  return JSON.parse(bytes.toString('utf8'));
}

async function bridgeCatalog(file, tableEntryIndex) {
  const result = await runBridge({ command: 'read-text-catalog', filePath: file, allowedRoots: [gameRoot],
    oodleRuntimeRoot: gameRoot, timeoutMs: 120_000, commandOptions: tableEntryIndex === undefined ? {} : { tableEntryIndex } });
  if (result.parseStatus === 'failed' || !result.data) return { error: result.diagnostics?.[0]?.code ?? 'BRIDGE_READ_FAILED' };
  return { data: result.data };
}

// FMG: the msgbnd table list (ordinal + entry name), then every table's ordered (id, text) entries.
async function compareFmg(testCase, input, items) {
  const file = join(gameRoot, ...input.split('/'));
  if (!existsSync(file)) throw new Error(`corpus input is missing from the game root: ${input}`);
  const key = `${testCase.game}/${testCase.format}/${testCase.operation}/${input}`;
  const inputSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const add = (suffix, reference, comparison) => items.push({ key: `${key}#${suffix}`, group: testCase, input, inputSha256,
    reference: reference.status, referenceReason: reference.reason, comparison });

  const catalog = await bridgeCatalog(file);
  const listing = referenceCall(testCase.reference, 'entries', { input: file });
  if (listing.status !== 'ok') { add('tables', listing, null); return; }
  const referenceTables = referenceArtifact(listing.response, 'entries.json').entries
    .filter(entry => entry.name.toLowerCase().endsWith('.fmg'))
    .map(entry => ({ ordinal: entry.ordinal, id: entry.id, name: entry.name }));
  add('tables', listing, catalog.error ? failedComparison(catalog.error)
    : compareOrdered(referenceTables, catalog.data.tables, table => `${table.ordinal ?? table.entryIndex} ${table.name ?? table.entryName}`));

  for (const table of referenceTables) {
    const decoded = referenceCall(testCase.reference, 'decode',
      { input: file, format: 'SoulsFormats.FMG', entryChain: [{ ordinal: table.ordinal, id: table.id, name: table.name }] });
    if (decoded.status !== 'ok') { add(table.ordinal, decoded, null); continue; }
    const referenceEntries = fmgEntriesFromReferenceGraph(referenceArtifact(decoded.response, 'structure.json'));
    const soulforge = await bridgeCatalog(file, table.ordinal);
    add(table.ordinal, decoded, soulforge.error ? failedComparison(soulforge.error)
      : compareOrdered(referenceEntries, fmgEntriesFromBridge(soulforge.data.entries ?? []), fmgEntryKey));
  }
}

// Reference read of a whole msgbnd: the FMG table list and every table's ordered (id, text).
function readFmgTables(project, file) {
  const listing = referenceCall(project, 'entries', { input: file });
  if (listing.status !== 'ok') return listing;
  const tables = referenceArtifact(listing.response, 'entries.json').entries
    .filter(entry => entry.name.toLowerCase().endsWith('.fmg'))
    .map(entry => ({ ordinal: entry.ordinal, id: entry.id, name: entry.name }));
  const entries = new Map();
  for (const table of tables) {
    const decoded = referenceCall(project, 'decode',
      { input: file, format: 'SoulsFormats.FMG', entryChain: [{ ordinal: table.ordinal, id: table.id, name: table.name }] });
    if (decoded.status !== 'ok') return decoded;
    entries.set(table.ordinal, fmgEntriesFromReferenceGraph(referenceArtifact(decoded.response, 'structure.json')));
  }
  return { status: 'ok', tables, entries };
}

// FMG write round trip: L0 identity write and L1 one-entry text edit into a temp staging root (compare/roundtrip.mjs).
// byteIdentical (output sha256 == source sha256) is recorded only; it is not part of the status.
async function compareFmgWriteRoundtrip(testCase, input, items) {
  const file = join(gameRoot, ...input.split('/'));
  if (!existsSync(file)) throw new Error(`corpus input is missing from the game root: ${input}`);
  const key = `${testCase.game}/${testCase.format}/${testCase.operation}/${input}`;
  const inputSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const add = (suffix, reference, comparison, extra = {}) => items.push({ key: `${key}#${suffix}`, group: testCase, input, inputSha256,
    reference: reference.status, referenceReason: reference.reason, comparison, ...extra });
  const result = await fmgWriteRoundtrip({ file, gameRoot, runBridge, readTables: path => readFmgTables(testCase.reference, path) });
  if (result.reference.status !== 'ok') { add('L0', result.reference, null); add('L1', result.reference, null); return; }
  for (const level of result.levels) {
    const extra = { target: result.target, outputSha256: level.outputSha256, byteIdentical: level.byteIdentical };
    if (level.write.error) { add(level.level, { status: 'ok' }, failedComparison(level.write.error), extra); continue; }
    if (level.reference.status !== 'ok') { add(level.level, level.reference, null, extra); continue; }
    for (const [part, comparison] of Object.entries(level.comparisons)) add(`${level.level}/${part}`, level.reference, comparison, extra);
  }
}

// TAE: the anibnd's TAE entry list (ordinal, id, name), then every TAE's ordered (animation id, hkx name, event count).
async function compareTae(testCase, input, items) {
  const file = join(gameRoot, ...input.split('/'));
  if (!existsSync(file)) throw new Error(`corpus input is missing from the game root: ${input}`);
  const key = `${testCase.game}/${testCase.format}/${testCase.operation}/${input}`;
  const inputSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const add = (suffix, reference, comparison) => items.push({ key: `${key}#${suffix}`, group: testCase, input, inputSha256,
    reference: reference.status, referenceReason: reference.reason, comparison });

  const listing = referenceCall(testCase.reference, 'entries', { input: file });
  if (listing.status !== 'ok') { add('tae-entries', listing, null); return; }
  const baseName = name => name.split(/[\\/]/u).pop();
  const referenceTae = referenceArtifact(listing.response, 'entries.json').entries
    .filter(entry => entry.name.toLowerCase().endsWith('.tae'))
    .map(entry => ({ ordinal: entry.ordinal, id: entry.id, name: entry.name }));
  const result = await runBridge({ command: 'read-tae-document', filePath: file, allowedRoots: [gameRoot],
    oodleRuntimeRoot: gameRoot, timeoutMs: 300_000 });
  const code = result.diagnostics?.[0]?.code ?? 'BRIDGE_READ_FAILED';
  const bridge = result.parseStatus === 'failed' || !result.data
    // Both sides agree there is no TAE in this container: an empty list, not a failure.
    ? (referenceTae.length === 0 && code === 'TAE_ANIBND_NO_TAE_ENTRY' ? { taeEntries: [], animations: [] } : { error: code })
    : result.data.animationsTruncated ? { error: 'BRIDGE_TAE_ANIMATIONS_TRUNCATED' } : result.data;
  const entryKey = entry => `${entry.ordinal ?? entry.entryIndex} ${entry.id ?? entry.entryId} ${baseName(entry.name ?? entry.entryName)}`;
  add('tae-entries', listing, bridge.error ? failedComparison(bridge.error) : compareOrdered(referenceTae, bridge.taeEntries, entryKey));
  if (bridge.error) return;

  for (const tae of referenceTae) {
    const decoded = referenceCall(testCase.reference, 'decode',
      { input: file, format: 'SoulsFormats.TAE', entryChain: [{ ordinal: tae.ordinal, id: tae.id, name: tae.name }] });
    if (decoded.status !== 'ok') { add(tae.ordinal, decoded, null); continue; }
    const referenceAnimations = taeAnimationsFromReferenceGraph(referenceArtifact(decoded.response, 'structure.json'));
    add(tae.ordinal, decoded, compareOrdered(referenceAnimations, taeAnimationsFromBridge(bridge.animations, tae.ordinal),
      animation => `${animation.id} ${animation.file} ${animation.events}`));
  }
}

// TAE write round trip: L0 rewrites one event's times unchanged, L1 moves them by one frame, into a temp staging root
// (compare/roundtrip.mjs). childByteIdentical (edited child bytes unchanged) is recorded only; it is not part of the status.
async function compareTaeWriteRoundtrip(testCase, input, items) {
  const file = join(gameRoot, ...input.split('/'));
  if (!existsSync(file)) throw new Error(`corpus input is missing from the game root: ${input}`);
  const key = `${testCase.game}/${testCase.format}/${testCase.operation}/${input}`;
  const inputSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const add = (suffix, reference, comparison, extra = {}) => items.push({ key: `${key}#${suffix}`, group: testCase, input, inputSha256,
    reference: reference.status, referenceReason: reference.reason, comparison, ...extra });
  const readEntries = path => {
    const listing = referenceCall(testCase.reference, 'entries', { input: path });
    if (listing.status !== 'ok') return listing;
    return { status: 'ok', entries: referenceArtifact(listing.response, 'entries.json').entries
      .filter(entry => entry.name.toLowerCase().endsWith('.tae'))
      .map(entry => ({ ordinal: entry.ordinal, id: entry.id, name: entry.name, size: entry.size, sha256: entry.sha256 })) };
  };
  const decodeEntry = (path, entry) => {
    const decoded = referenceCall(testCase.reference, 'decode',
      { input: path, format: 'SoulsFormats.TAE', entryChain: [{ ordinal: entry.ordinal, id: entry.id, name: entry.name }] });
    return decoded.status !== 'ok' ? decoded
      : { status: 'ok', animations: taeEventsFromReferenceGraph(referenceArtifact(decoded.response, 'structure.json')) };
  };
  const result = await taeWriteRoundtrip({ file, gameRoot, commitTae: commitTaeEventContainerViaBridge, readEntries, decodeEntry });
  if (result.reference.status !== 'ok') { add('L0', result.reference, null); add('L1', result.reference, null); return; }
  for (const level of result.levels) {
    const extra = { entry: result.entry, target: result.target, refused: result.refused, outputSha256: level.outputSha256,
      childByteIdentical: level.childByteIdentical };
    if (level.write.error) { add(level.level, { status: 'ok' }, failedComparison(level.write.error), extra); continue; }
    if (level.reference.status !== 'ok') { add(level.level, level.reference, null, extra); continue; }
    for (const [part, comparison] of Object.entries(level.comparisons)) add(`${level.level}/${part}`, level.reference, comparison, extra);
  }
}

// The Bridge's read-emevd-document page-size ceiling (BridgeCommandService MaxInstructionPageSize); a larger request
// silently falls back to 256. Pages after the first reuse its document session, so every page comes from one parse.
const EMEVD_INSTRUCTION_PAGE_SIZE = 65536;
async function bridgeEmevd(file) {
  const pages = [];
  let documentSession;
  for (let page = 0; ; page++) {
    const result = await runBridge({ command: 'read-emevd-document', filePath: file, allowedRoots: [gameRoot], oodleRuntimeRoot: gameRoot,
      timeoutMs: 300_000, commandOptions: { instructionPage: page, instructionPageSize: EMEVD_INSTRUCTION_PAGE_SIZE,
        ...(documentSession ? { documentSession } : {}) } });
    if (result.parseStatus === 'failed' || !result.data) return { error: result.diagnostics?.[0]?.code ?? 'BRIDGE_READ_FAILED' };
    documentSession ??= result.data.documentSession;
    pages.push(result.data);
    if (!(page + 1 < result.data.instructionPageCount)) break;
  }
  try { return { data: emevdFromBridgePages(pages) }; }
  catch (error) { return { error: `BRIDGE_EMEVD_INCONSISTENT: ${error.message}` }; }
}

// EMEVD: per file, the ordered events (id, rest behavior, instruction and parameter counts), the flat instructions
// (event/index, bank, id, args length + sha256, has layer) and the flat parameters. Layer values are not compared.
async function compareEmevd(testCase, input, items) {
  const file = join(gameRoot, ...input.split('/'));
  if (!existsSync(file)) throw new Error(`corpus input is missing from the game root: ${input}`);
  const key = `${testCase.game}/${testCase.format}/${testCase.operation}/${input}`;
  const inputSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const add = (suffix, reference, comparison) => items.push({ key: `${key}#${suffix}`, group: testCase, input, inputSha256,
    reference: reference.status, referenceReason: reference.reason, comparison });

  const decoded = referenceCall(testCase.reference, 'decode', { input: file, format: 'SoulsFormats.EMEVD' });
  if (decoded.status !== 'ok') { add('events', decoded, null); return; }
  const reference = emevdFromReferenceGraph(referenceArtifact(decoded.response, 'structure.json'));
  const bridge = await bridgeEmevd(file);
  for (const part of ['events', 'instructions', 'parameters']) {
    add(part, decoded, bridge.error ? failedComparison(bridge.error) : compareOrdered(reference[part], bridge.data[part], emevdKeys[part]));
  }
}

// MSB: per map, the models (type, name, sib path), parts (type, name, model name, position/rotation/scale float bits,
// entity id), regions (type, name, shape, position/rotation float bits, entity id) and events (type, name, event id), each
// in MSBS type order and then file order. Per-type payloads beyond these fields are not compared: the Bridge does not
// read them. The reference structure.json is large (60 MB for the smallest map); only the compact rows are kept.
async function compareMsb(testCase, input, items) {
  const file = join(gameRoot, ...input.split('/'));
  if (!existsSync(file)) throw new Error(`corpus input is missing from the game root: ${input}`);
  const key = `${testCase.game}/${testCase.format}/${testCase.operation}/${input}`;
  const inputSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const add = (suffix, reference, comparison) => items.push({ key: `${key}#${suffix}`, group: testCase, input, inputSha256,
    reference: reference.status, referenceReason: reference.reason, comparison });
  const parts = ['models', 'parts', 'regions', 'events'];

  const decoded = referenceCall(testCase.reference, 'decode', { input: file, format: 'SoulsFormats.MSBS' });
  if (decoded.status !== 'ok') { for (const part of parts) add(part, decoded, null); return; }
  const reference = msbFromReferenceGraph(referenceArtifact(decoded.response, 'structure.json'));
  const result = await runBridge({ command: 'read-msb-document', filePath: file, allowedRoots: [gameRoot], oodleRuntimeRoot: gameRoot,
    timeoutMs: 300_000 });
  let bridge;
  if (result.parseStatus === 'failed' || !result.data) bridge = { error: result.diagnostics?.[0]?.code ?? 'BRIDGE_READ_FAILED' };
  else {
    try { bridge = { data: msbFromBridge(result.data) }; }
    catch (error) { bridge = { error: `BRIDGE_MSB_INCONSISTENT: ${error.message}` }; }
  }
  for (const part of parts) {
    add(part, decoded, bridge.error ? failedComparison(bridge.error) : compareOrdered(reference[part], bridge.data[part], msbKeys[part]));
  }
}

// The Bridge reads PARAM from a loose .param only (read-param-document reads filePath directly; ParamDocumentSessionCache
// GetOrOpen), so each parambnd entry is extracted to a run-private scratch directory first, as containerParamEdit.ts does.
// The extracted entry must be the one the reference decoded (same index, id and name), or the read is a failure. The read
// itself is the production chain: readParamDocumentViaBridge with the editor's resolveTrustedParamRowWidth
// (containerParamEdit.ts). A param with no trusted width fails as PARAM_METADATA_ROW_WIDTH_UNRESOLVED.
async function bridgeParam(file, entry, scratch, game) {
  const out = join(scratch, `${entry.ordinal}.param`);
  const extracted = await runBridge({ command: 'extract-bnd4-child', filePath: file, allowedRoots: [gameRoot, scratch], writableRoots: [scratch],
    oodleRuntimeRoot: gameRoot, timeoutMs: 60_000, commandOptions: { entryIndex: entry.ordinal, outputPath: out } });
  if (extracted.parseStatus === 'failed' || !extracted.data) return { error: extracted.diagnostics?.[0]?.code ?? 'BRIDGE_EXTRACT_FAILED' };
  if (extracted.data.index !== entry.ordinal || extracted.data.id !== entry.id || extracted.data.name !== entry.name) {
    return { error: 'BRIDGE_PARAM_ENTRY_MISMATCH' };
  }
  return readBridgeParam(readParamDocumentViaBridge, { sourcePath: out, allowedRoots: [gameRoot, scratch],
    resolveRowDataSize: header => resolveTrustedParamRowWidth(header, game) });
}

// PARAM: the parambnd entry list (ordinal, id, name), then every param's (ParamType, rowCount) and ordered row (id, name).
// Field values are not compared. The reference decodes without a paramdef: format "SoulsFormats.PARAM" does not take the
// refcli paramdef path, and the row index does not depend on it (measured; see the param-impl report).
async function compareParam(testCase, input, items) {
  const file = join(gameRoot, ...input.split('/'));
  if (!existsSync(file)) throw new Error(`corpus input is missing from the game root: ${input}`);
  const key = `${testCase.game}/${testCase.format}/${testCase.operation}/${input}`;
  const inputSha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  const add = (suffix, reference, comparison) => items.push({ key: `${key}#${suffix}`, group: testCase, input, inputSha256,
    reference: reference.status, referenceReason: reference.reason, comparison });

  const listing = referenceCall(testCase.reference, 'entries', { input: file });
  if (listing.status !== 'ok') { add('entries', listing, null); return; }
  const referenceEntries = referenceArtifact(listing.response, 'entries.json').entries
    .filter(entry => entry.name.toLowerCase().endsWith('.param'))
    .map(entry => ({ ordinal: entry.ordinal, id: entry.id, name: entry.name }));
  const dcx = await runBridge({ command: 'read-dcx-document', filePath: file, allowedRoots: [gameRoot], oodleRuntimeRoot: gameRoot, timeoutMs: 120_000 });
  const bridgeEntries = dcx.parseStatus === 'failed' || !Array.isArray(dcx.data?.nested?.entries) ? null
    : dcx.data.nested.entries.filter(entry => String(entry.name ?? '').toLowerCase().endsWith('.param'));
  add('entries', listing, bridgeEntries ? compareOrdered(referenceEntries, bridgeEntries, paramKeys.entries)
    : failedComparison(dcx.diagnostics?.[0]?.code ?? 'BRIDGE_READ_FAILED'));

  const scratch = mkdtempSync(join(tmpdir(), 'soulforge-compare-param-'));
  try {
    for (const entry of referenceEntries) {
      const decoded = referenceCall(testCase.reference, 'decode', { input: file, format: 'SoulsFormats.PARAM', entryChain: [entry] });
      if (decoded.status !== 'ok') { add(`${entry.ordinal}/header`, decoded, null); add(`${entry.ordinal}/rows`, decoded, null); continue; }
      const reference = paramFromReferenceGraph(referenceArtifact(decoded.response, 'structure.json'));
      const bridge = await bridgeParam(file, entry, scratch, testCase.game);
      add(`${entry.ordinal}/header`, decoded, bridge.error ? failedComparison(bridge.error)
        : compareOrdered([reference.header], [bridge.data.header], paramKeys.header));
      add(`${entry.ordinal}/rows`, decoded, bridge.error ? failedComparison(bridge.error)
        : compareOrdered(reference.rows, bridge.data.rows, paramKeys.rows));
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const RULES = { 'fmg/read-text': compareFmg, 'fmg/write-roundtrip': compareFmgWriteRoundtrip, 'tae/read-animations': compareTae,
  'tae/write-roundtrip': compareTaeWriteRoundtrip, 'emevd/read-events': compareEmevd, 'msb/read-map': compareMsb,
  'param/read-rows': compareParam };
let exitCode = 2;
try {
  const items = [];
  for (const testCase of corpus.cases) {
    const rule = RULES[`${testCase.format}/${testCase.operation}`];
    if (!rule) throw new Error(`no comparison rule for ${testCase.format}/${testCase.operation}`);
    for (const input of testCase.inputs) await rule(testCase, input, items);
  }
  for (const item of items) item.status = classify(item, knownDiffs);
  const groups = corpus.cases.map(testCase => {
    const statuses = items.filter(item => item.group === testCase).map(item => item.status);
    const counts = Object.fromEntries([...new Set(statuses)].map(status => [status, statuses.filter(value => value === status).length]));
    return { game: testCase.game, format: testCase.format, operation: testCase.operation, reference: testCase.reference,
      status: groupStatus(statuses), counts };
  });
  const stale = staleKnownDiffs(items, knownDiffs);
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), references: pins, referenceCalls, groups, staleKnownDiffs: stale,
    items: items.map(({ group, ...item }) => item) };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  exitCode = items.some(item => item.status === 'diff') || stale.length ? 1
    : groups.every(group => ['match', 'known-diff'].includes(group.status)) ? 0 : 3;
  // A clean run deletes the refcli result directories it created; anything else keeps them to inspect.
  const removable = referenceResultDirsToRemove([...referenceResultDirs],
    { exitCode, keep: process.env.SOULFORGE_COMPARE_KEEP_REFERENCE_RESULTS === '1' });
  for (const dir of removable) rmSync(dir, { recursive: true, force: true });
  const referenceResults = { created: referenceResultDirs.size, removed: removable.length };
  // stdout carries statuses and counts only; the report file also holds extracted game text and stays local.
  console.log(JSON.stringify({ status: ['match', 'diff', 'error', 'incomplete'][[0, 1, 2, 3].indexOf(exitCode)], groups,
    staleKnownDiffs: stale, referenceCalls, referenceResults, report: 'output/compare/report.json' }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'error', reason: error instanceof Error ? error.message : String(error) }));
} finally {
  await disposeBridgeDaemonPool();
}
process.exit(exitCode);
