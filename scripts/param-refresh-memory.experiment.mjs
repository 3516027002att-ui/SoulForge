/** No-provider PARAM preflight -> staged native write -> production knowledge refresh.
 * Explicit inputs and an owned temporary overlay keep installed Mod bytes read-only.
 * Run with node --expose-gc --import ./scripts/param-memory-loader.mjs ...
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { Session } from 'node:inspector/promises';
import { getHeapStatistics } from 'node:v8';
import { scanWorkspace } from '../packages/core/dist/workspace/scanWorkspace.js';
import { analyzeWorkspace } from '../packages/core/dist/pipeline/workspacePipeline.js';
import { runBridge, disposeBridgeDaemonPool, disposeIdleBridgeDaemonPool } from '../packages/core/dist/bridge/runBridge.js';
import { refreshNativeSemanticSources } from '../packages/core/dist/indexing/nativeSemanticRefresh.js';
import { refreshKnowledgeAfterCommit, preparePostCommitRefreshBaseline } from '../packages/core/dist/indexing/knowledgeRefresh.js';
import { WorkspaceIndex } from '../packages/core/dist/indexing/workspaceIndex.js';
import { loadSymbolBundleIntoIndex } from '../packages/core/dist/workspace/semanticFileCache.js';
import { loadFirstPartyParamMetadata } from '../packages/core/dist/schema/sekiro/firstPartySchema.js';
import { decodeRowFields, encodeFieldMutation } from '../packages/core/dist/param/paramdefLayout.js';
import { saveRawReplace } from '../packages/core/dist/editing/saveRawResource.js';
import { openWorkspaceSession } from '../packages/core/dist/workspace/workspaceSession.js';
import { createConfirmationReceipt } from '../packages/core/dist/patch/writerContract.js';
import { MemoryOperationLogStore } from '../packages/core/dist/patch/operationLog.js';
import { buildRagCorpus } from '../packages/core/dist/rag/chunkBuilder.js';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const split = arg.indexOf('=');
  assert.ok(split > 0, 'Use --source=... --bridge=... --output=...');
  return [arg.slice(0, split).replace(/^--/u, ''), arg.slice(split + 1)];
}));
for (const key of ['source', 'bridge', 'output']) assert.ok(args[key], `--${key} is required`);
const rounds = Number(args.rounds ?? 2);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 5);
assert.equal(typeof global.gc, 'function', 'Use --expose-gc for comparable retained-heap boundaries');
const source = resolve(args.source);
const executable = resolve(args.bridge);
const output = resolve(args.output);
await mkdir(output, { recursive: true });
const runRoot = resolve(args['run-root'] ?? 'output/param-memory-runs');
await mkdir(runRoot, { recursive: true });
const root = await mkdtemp(join(runRoot, 'soulforge-param-memory-'));
const overlay = join(root, 'overlay');
const staging = join(root, 'staging');
const containerInput = !source.toLowerCase().endsWith('.param');
const destination = join(overlay, 'param/gameparam', containerInput ? 'gameparam.parambnd.dcx' : 'ActionGuideParam.param');
await mkdir(dirname(destination), { recursive: true });
await mkdir(staging, { recursive: true });
await copyFile(source, destination);
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const report = {
  experiment: 'param-preflight-write-refresh',
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDiff: execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }).trim(),
  sourceInputHash: await digest(source), bridgeHash: await digest(executable),
  inputKind: containerInput ? 'native-container' : 'single-native-table',
  runtime: { node: process.version, electron: process.versions.electron ?? null, v8: process.versions.v8,
    role: 'standalone-core-probe', pid: process.pid, heapLimit: getHeapStatistics().heap_size_limit },
  owners: ['core/analyzeWorkspace', 'core/WorkspaceIndex', 'core/refreshKnowledgeAfterCommit', 'core/refreshNativeSemanticSources', 'core/buildRagCorpus'],
  unexercisedOwners: ['desktop/ipc/param.ts caches', 'desktop/ipc.ts refresh composition', 'database utility'],
  budget: { samplingInterval: 100, allocationSamplingInterval: 1048576, snapshots: false,
    maxHeapUsed: 768 * 1024 * 1024, maxAggregateRss: 1536 * 1024 * 1024, maxDurationMs: 240000 },
  samples: [], boundaries: [], nativeProgress: [], rounds: [], status: 'running'
};
report.loadedOutputHashes = Object.fromEntries(await Promise.all([
  'packages/core/dist/pipeline/workspacePipeline.js', 'packages/core/dist/indexing/workspaceIndex.js',
  'packages/core/dist/indexing/knowledgeRefresh.js', 'packages/core/dist/indexing/nativeSemanticRefresh.js',
  'packages/core/dist/rag/chunkBuilder.js', 'packages/shared/dist/index.js', 'scripts/param-memory-loader.mjs'
].map(async (path) => [path, await digest(path)])));
const inspector = new Session();
inspector.connect();
await inspector.post('HeapProfiler.startSampling', { samplingInterval: report.budget.allocationSamplingInterval });
let phase = 'setup';
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(new Error('PARAM_MEMORY_PROBE_DURATION_BUDGET')), report.budget.maxDurationMs);
let aggregateRss = 0;
let rssSampleAt = -500;
let checkpointWrite = Promise.resolve();
const descendantRss = () => {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number));
  const descendants = new Set([process.pid]);
  let changed;
  do { changed = false; for (const [pid, parent] of rows) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; } } while (changed);
  return rows.reduce((total, [pid, , rss]) => total + (descendants.has(pid) ? rss * 1024 : 0), 0);
};
const sample = () => {
  const memory = process.memoryUsage();
  if (performance.now() - rssSampleAt >= 500) { aggregateRss = descendantRss(); rssSampleAt = performance.now(); }
  const item = { phase, elapsedMs: Math.round(performance.now()), heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal, external: memory.external, rss: memory.rss, aggregateRss };
  report.samples.push(item);
  if (!abort.signal.aborted && (memory.heapUsed > report.budget.maxHeapUsed || aggregateRss > report.budget.maxAggregateRss)) {
    report.budgetStop = item;
    abort.abort(new Error('PARAM_MEMORY_PROBE_MEMORY_BUDGET'));
    checkpointWrite = writeFile(join(output, 'budget-stop.json'), JSON.stringify(report, null, 2));
  }
  return item;
};
const tick = setInterval(sample, report.budget.samplingInterval);
tick.unref();
const boundary = async (name) => {
  phase = name;
  sample();
  global.gc();
  await new Promise((done) => setImmediate(done));
  global.gc();
  const item = { ...sample(), forcedGc: true };
  report.boundaries.push(item);
  console.log(JSON.stringify(item));
  const { profile } = await inspector.post('HeapProfiler.getSamplingProfile');
  await writeFile(join(output, `allocation-${name.replace(/[^a-z0-9-]/giu, '-')}.json`), JSON.stringify(profile));
  await writeFile(join(output, 'checkpoint.json'), JSON.stringify(report, null, 2));
};
const bridge = (options) => runBridge({ signal: abort.signal, timeoutMs: 180000, ...options, bridgeExecutablePath: executable });
const read = async (options) => {
  const result = await bridge({ ...options, timeoutMs: 180000 });
  assert.ok(result.data && result.parseStatus !== 'failed', JSON.stringify(result.diagnostics));
  return result.data;
};
const staged = (result) => assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code.endsWith('_STAGING_WRITE_VERIFIED')),
  JSON.stringify(result.diagnostics));
const counts = (index) => {
  const params = index.toSymbolBundle().params ?? [];
  return { tables: params.length, rows: params.reduce((n, table) => n + table.rows.length, 0),
    fields: params.reduce((n, table) => n + table.rows.reduce((m, row) => m + (row.fields?.length ?? 0), 0), 0) };
};

async function mutate(session, operationLog, file, round) {
  let entry;
  let child = destination;
  if (containerInput) {
    const bnd = await read({ command: 'list-bnd4-entries', filePath: destination, allowedRoots: [overlay],
      commandOptions: { includeContentHashes: true } });
    entry = bnd.entries.find((entry) => entry.name.endsWith('ActionGuideParam.param'));
    assert.ok(entry, 'Source must contain ActionGuideParam');
    child = join(staging, `action-guide-${round}.param`);
    await read({ command: 'extract-bnd4-child', filePath: destination, allowedRoots: [overlay, staging],
      writableRoots: [staging], commandOptions: { entryIndex: entry.index, outputPath: child } });
  }
  const doc = await read({ command: 'read-param-document', filePath: child, allowedRoots: [overlay, staging], commandOptions: { rowLimit: 1 } });
  const metadata = loadFirstPartyParamMetadata();
  assert.ok(metadata.ok);
  const definition = metadata.package.definitions.find(({ document }) => document.typeName === doc.typeName
    && document.rowDataSize === doc.rowDataSize && document.version === doc.dataVersion)?.document;
  assert.ok(definition, 'Native row must have trusted first-party metadata');
  const row = doc.rows[0];
  const decoded = decodeRowFields(Buffer.from(row.dataBase64, 'base64'), definition);
  const field = decoded.find((field) => typeof field.value === 'number');
  assert.ok(field);
  const encoded = encodeFieldMutation(Buffer.from(row.dataBase64, 'base64'), definition, field.fieldId, field.value + 1);
  assert.ok(encoded.ok, encoded.message);
  const changed = join(staging, `changed-${round}.param`);
  staged(await bridge({ command: 'write-param', filePath: child, allowedRoots: [overlay, staging], writableRoots: [staging],
    commandOptions: { outputPath: changed, expectedDocumentHash: doc.sourceHash, expectedRowDataSize: doc.rowDataSize,
      mutation: 'upsert', id: row.id, rowIndex: row.rowIndex, expectedDataHash: row.dataHash,
      dataBase64: encoded.next.toString('base64') } }));
  let committedPath = changed;
  if (containerInput) {
    committedPath = join(staging, `changed-${round}.parambnd.dcx`);
    staged(await bridge({ command: 'write-bnd4', filePath: destination, allowedRoots: [overlay, staging], writableRoots: [staging],
      commandOptions: { outputPath: committedPath, mutation: 'replace', expectedContainerHash: await digest(destination),
        entryIndex: entry.index, expectedChildHash: entry.contentHash, contentBase64: (await readFile(changed)).toString('base64') } }));
  }
  const committed = await saveRawReplace({ file, expectedHash: await digest(destination),
    newContentBase64: (await readFile(committedPath)).toString('base64'), session, operationLog,
    backupBaseDir: join(root, 'backups'), recoveryDir: join(root, 'recovery'), title: 'Owned PARAM memory probe',
    confirmation: createConfirmationReceipt({ subjects: [file.sourceUri, 'PARAM_MEMORY_PROBE'],
      sourceUri: file.sourceUri, riskLevel: 'high', note: 'Test-owned overlay only' }) });
  assert.ok(committed.ok, JSON.stringify(committed.diagnostics));
  return { table: 'ActionGuideParam', rowId: row.id, fieldId: field.fieldId, oldValue: field.value, newValue: field.value + 1 };
}

let index;
let corpus;
try {
  const scan = await scanWorkspace({ workspaceRoot: overlay, game: 'sekiro' });
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const operationLog = new MemoryOperationLogStore();
  await boundary('preflight:start');
  const analyzed = await analyzeWorkspace({ workspaceRoot: overlay, files: scan.files, inspectNativeResources: false,
    parseTextResources: false, parseJsonFixtures: false, signal: abort.signal, bridgeExecutablePath: executable, bridgeTimeoutMs: 180000 });
  index = analyzed.index;
  if (!containerInput) {
    const initial = await refreshNativeSemanticSources({ index, indexOwnership: 'isolated-candidate', sourceFiles: scan.files,
      stagingRoot: staging, allowedRoots: [overlay], timeoutMs: 180000, bridgeRunner: bridge, signal: abort.signal });
    assert.equal(initial.failedSources.length, 0, JSON.stringify(initial.diagnostics));
  }
  report.preflight = counts(index);
  corpus = buildRagCorpus(index);
  await boundary('preflight:complete');
  for (let round = 1; round <= rounds; round += 1) {
    const beforeFiles = index.getFiles();
    const file = beforeFiles.find((file) => file.absolutePath === destination);
    assert.ok(file);
    phase = `round${round}:write`;
    const mutation = await mutate(session, operationLog, file, round);
    await boundary(`round${round}:write:complete`);
    preparePostCommitRefreshBaseline(index, [file.sourceUri]);
    corpus = undefined;
    // Match the desktop post-commit boundary's existing idle native-reader cleanup.
    await disposeIdleBridgeDaemonPool();
    await boundary(`round${round}:nativeCleanup:complete`);
    await boundary(`round${round}:invalidated`);
    const after = await scanWorkspace({ workspaceRoot: overlay, game: 'sekiro' });
    phase = `round${round}:nativeDecode`;
    const refreshed = await refreshKnowledgeAfterCommit({ index, beforeFiles, afterFiles: after.files,
      requestedSources: [file.sourceUri], signal: abort.signal,
      reanalyze: async () => {
        const candidate = new WorkspaceIndex(after.workspaceId);
        candidate.setFiles(after.files);
        const native = await refreshNativeSemanticSources({ index: candidate, indexOwnership: 'isolated-candidate',
          sourceFiles: after.files, stagingRoot: staging, allowedRoots: [overlay], timeoutMs: 180000,
          bridgeRunner: bridge, signal: abort.signal, paramReadProgress: (item) => {
            const progress = { round, ...item };
            report.nativeProgress.push(progress);
            // Keep a bounded phase record even if V8 terminates before finally.
            // This is diagnostic observation, not a timing benchmark.
            appendFileSync(join(output, 'native-progress.ndjson'), `${JSON.stringify(progress)}\n`);
            sample();
          } });
        assert.equal(native.failedSources.length, 0, JSON.stringify(native.diagnostics));
        return { index: candidate, semanticState: native.partialSources.length ? 'partial' : 'reanalyzed' };
      },
      publish: (candidate) => {
        const published = index.cloneForRefreshShared();
        loadSymbolBundleIntoIndex(published, candidate.toSymbolBundle());
        return published;
      },
      onRefreshBoundary: (stage, event) => { phase = `round${round}:${stage}:${event}`; sample(); },
      persist: async (published) => { phase = `round${round}:ragBuild`; corpus = buildRagCorpus(published); sample(); }
    });
    assert.equal(refreshed.result.status, 'converged', JSON.stringify(refreshed.result));
    index = refreshed.index;
    const tables = index.toSymbolBundle().params;
    if (!containerInput) assert.equal(tables.length, 1);
    const row = (containerInput ? tables.find((table) => table.paramName === mutation.table) : tables[0])?.rows.find((row) => row.rowId === mutation.rowId);
    assert.equal(row?.fields.find((field) => field.fieldId === mutation.fieldId)?.value, mutation.newValue);
    report.rounds.push({ round, mutation, ...counts(index), chunks: corpus.chunks.length, refresh: refreshed.result.status });
    await boundary(`round${round}:complete`);
  }
  index = undefined;
  corpus = undefined;
  await boundary('released');
  report.status = 'verified';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  clearInterval(tick);
  clearTimeout(deadline);
  await checkpointWrite;
  const { profile } = await inspector.post('HeapProfiler.stopSampling');
  await writeFile(join(output, 'allocation-profile.json'), JSON.stringify(profile));
  inspector.disconnect();
  const peaks = {};
  for (const item of report.samples) {
    const peak = peaks[item.phase] ??= { heapUsed: 0, rss: 0, aggregateRss: 0 };
    peak.heapUsed = Math.max(peak.heapUsed, item.heapUsed);
    peak.rss = Math.max(peak.rss, item.rss);
    peak.aggregateRss = Math.max(peak.aggregateRss, item.aggregateRss);
  }
  report.peaks = peaks;
  report.sourceInputUnchanged = await digest(source) === report.sourceInputHash;
  assert.ok(report.sourceInputUnchanged);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, preflight: report.preflight, rounds: report.rounds, peaks }));
  await disposeBridgeDaemonPool();
  await rm(root, { recursive: true, force: true });
}
