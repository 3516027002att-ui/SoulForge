// Source-bound contract tests only. Native transport is a recording test port;
// real native/Node timing evidence uses a separate actual client capture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require(process.env.SOULFORGE_TEST_TYPESCRIPT_PATH ?? 'typescript');
const filename = fileURLToPath(new URL('../../packages/core/src/editing/msbBridgeRead.ts', import.meta.url));
const source = readFileSync(filename, 'utf8');
function load(result, failure) {
  const calls = [];
  const compiled = ts.transpileModule(source, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  assert.deepEqual((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const exports = {};
  vm.runInNewContext(compiled.outputText, { exports, module: { exports }, require(name) {
    if (name === '../bridge/runBridge.js') return { runBridge: async options => {
      calls.push(options); if (failure) throw failure; return result;
    } };
    if (name === '../bridge/bridgeTransportTiming.js') return { BRIDGE_TRANSPORT_TIMING_CODE: 'BRIDGE_TRANSPORT_TIMINGS' };
    throw new Error(`Unexpected runtime import ${name}`);
  } }, { filename });
  return { read: exports.readMsbDocumentViaBridge, calls };
}
const plain = value => JSON.parse(JSON.stringify(value));
const input = { sourcePath: '/owned/map/m10.msb.dcx', allowedRoots: ['/owned/map'] };
const nativeDetails = { schemaVersion: 1, unit: 'ms', scope: 'msb-document', totalMs: 12, physicalSourceHash: 'a'.repeat(64), decodedSourceHash: 'b'.repeat(64), unavailablePhases: [] };
const transportDetails = { schemaVersion: 1, unit: 'ms', outcome: 'ok', totalMs: 20 };
const diagnostics = [
  { severity: 'info', code: 'MSB_NATIVE_TIMINGS', message: 'native', details: nativeDetails },
  { severity: 'info', code: 'BRIDGE_TRANSPORT_TIMINGS', message: 'transport', details: transportDetails },
  { severity: 'warning', code: 'MSB_OTHER', message: 'other', details: { absolutePath: '/PRIVATE' } }
];
const result = { parseStatus: 'partial', diagnostics, data: {
  sourceHash: 'b'.repeat(64), version: 3, modelCount: 1, partCount: 1, regionCount: 0, eventCount: 0, routeCount: 0,
  models: [{ name: 'MODEL', offset: 32, typeId: 0 }],
  parts: [{ name: 'PART', offset: 64, typeId: 0, modelIndex: 0, posX: 1, posY: 2, posZ: 3 }], regions: [], events: [], routes: []
} };

test('default and false keep existing native options and diagnostic DTO', async () => {
  for (const flag of [undefined, false, 'true']) {
    const port = load(result); const value = await port.read({ ...input, ...(flag === undefined ? {} : { diagnosticTimings: flag }) });
    assert.deepEqual(plain(port.calls[0]), { command: 'read-msb-document', filePath: input.sourcePath, allowedRoots: input.allowedRoots, timeoutMs: 120000 });
    assert.deepEqual(plain(value.diagnostics), diagnostics.map(({ severity, code, message }) => ({ severity, code, message })));
    assert.equal(value.data.sourceHash, result.data.sourceHash); assert.equal(value.data.parts.length, 1);
  }
});

test('opt-in forwards exact session and existing timing option while preserving data', async () => {
  const baseline = await load(result).read(input);
  const port = load(result); const value = await port.read({ ...input, diagnosticTimings: true, workspaceSessionId: 'captured-owner-A', timeoutMs: 456 });
  assert.deepEqual(plain(port.calls[0]), { command: 'read-msb-document', filePath: input.sourcePath, allowedRoots: input.allowedRoots, timeoutMs: 456,
    workspaceSessionId: 'captured-owner-A', commandOptions: { diagnosticTimings: true } });
  assert.deepEqual(plain(value.data), plain(baseline.data));
});

test('opt-in retains only the two known timing details without mutating native result', async () => {
  const before = JSON.stringify(result); const value = await load(result).read({ ...input, diagnosticTimings: true });
  assert.deepEqual(plain(value.diagnostics[0].details), nativeDetails);
  assert.deepEqual(plain(value.diagnostics[1].details), transportDetails);
  assert.equal(Object.hasOwn(value.diagnostics[2], 'details'), false);
  assert.equal(JSON.stringify(result), before);
});

test('failed read can carry opt-in missing-phase evidence without successful data', async () => {
  const port = load({ parseStatus: 'failed', diagnostics, data: null });
  const value = await port.read({ ...input, diagnosticTimings: true });
  assert.equal(value.ok, false); assert.equal(Object.hasOwn(value, 'data'), false);
  assert.deepEqual(plain(value.diagnostics[0].details), nativeDetails);
  assert.equal(Object.hasOwn(value.diagnostics[2], 'details'), false);
});

test('timing diagnostic with absent details does not synthesize measurement', async () => {
  const value = await load({ ...result, diagnostics: [{ severity: 'info', code: 'MSB_NATIVE_TIMINGS', message: 'missing' }] }).read({ ...input, diagnosticTimings: true });
  assert.equal(Object.hasOwn(value.diagnostics[0], 'details'), false);
});

test('bridge rejection identity is unchanged by diagnostic projection', async () => {
  const failure = new Error('cancelled original request'); const port = load(null, failure);
  await assert.rejects(port.read({ ...input, diagnosticTimings: true }), error => error === failure);
});
