#!/usr/bin/env node
// Compares SoulForge reads with the pinned reference tools on real game files. See compare/README.md.
// It needs the game and the reference CLI, so it is not part of the gate.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify, compareOrdered, emevdFromBridgePages, emevdFromReferenceGraph, emevdKeys, failedComparison, fmgEntriesFromBridge,
  fmgEntriesFromReferenceGraph, groupStatus, staleKnownDiffs, taeAnimationsFromBridge, taeAnimationsFromReferenceGraph } from './lib.mjs';

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
const bridgeModule = join(root, 'packages/core/dist/bridge/runBridge.js');
if (!existsSync(bridgeModule)) {
  console.log(JSON.stringify({ status: 'error', reason: 'packages/core/dist is missing; run npm run build first' }));
  process.exit(2);
}
const { runBridge, disposeBridgeDaemonPool } = await import(pathToFileURL(bridgeModule).href);

function referenceCall(project, operation, args) {
  if (!refcli || !existsSync(refcli)) return { status: 'unavailable', reason: 'SOULFORGE_REFCLI must point at the reference CLI entry (refcli.mjs)' };
  const result = spawnSync(process.execPath, [refcli, '--stdin'], { input: JSON.stringify({ project, operation, args }),
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, windowsHide: true });
  if (result.error) return { status: 'unavailable', reason: result.error.message };
  let response;
  try { response = JSON.parse(result.stdout.replace(/^﻿/u, '')); }
  catch { return { status: 'unavailable', reason: `reference CLI exited ${result.status} without JSON` }; }
  const reason = (response.diagnostics ?? []).map(item => item.code ?? item.message).filter(Boolean).join(', ') || response.status;
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
      : compareOrdered(referenceEntries, fmgEntriesFromBridge(soulforge.data.entries ?? []), entry => `${entry.id} ${JSON.stringify(entry.text)}`));
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

const RULES = { fmg: compareFmg, tae: compareTae, emevd: compareEmevd };
let exitCode = 2;
try {
  const items = [];
  for (const testCase of corpus.cases) {
    const rule = RULES[testCase.format];
    if (!rule) throw new Error(`no comparison rule for format ${testCase.format}`);
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
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), references: pins, groups, staleKnownDiffs: stale,
    items: items.map(({ group, ...item }) => item) };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  exitCode = items.some(item => item.status === 'diff') || stale.length ? 1
    : groups.every(group => ['match', 'known-diff'].includes(group.status)) ? 0 : 3;
  // stdout carries statuses and counts only; the report file also holds extracted game text and stays local.
  console.log(JSON.stringify({ status: ['match', 'diff', 'error', 'incomplete'][[0, 1, 2, 3].indexOf(exitCode)], groups,
    staleKnownDiffs: stale, report: 'output/compare/report.json' }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'error', reason: error instanceof Error ? error.message : String(error) }));
} finally {
  await disposeBridgeDaemonPool();
}
process.exit(exitCode);
