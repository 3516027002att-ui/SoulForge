import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as runner from './run-suite.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function ownedRoot() {
  const base = join(repositoryRoot, 'node_modules/.cache/update-process-tests');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'run-'));
}

test('integration executes the production update core in a different process and retains concrete evidence', async () => {
  const outputRoot = await ownedRoot();
  try {
    const report = await runner.runSuite('integration', { repositoryRoot, outputRoot });
    assert.equal(report.status, 'passed');
    assert.equal(report.evidenceLevel, 'process-integration');
    assert.ok(report.cases.some(entry => entry.id === 'runtime-check-download' && entry.assertions.length > 0));
    assert.ok(report.cases.some(entry => entry.id === 'runtime-cancel-late-download'));
    const artifact = report.artifacts.find(entry => entry.relativePath.endsWith('/receipt.json'));
    const receipt = JSON.parse(await readFile(join(repositoryRoot, artifact.relativePath), 'utf8'));
    assert.notEqual(receipt.workerPid, process.pid);
    assert.ok(receipt.httpRequests > 0);
    assert.equal(receipt.installerPortCalls, 1);
    assert.match(report.untestedClaims.join(' '), /NSIS|GitHub/);
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});

test('runtime receipt validation refuses missing binding, stale runs and modified evidence', async () => {
  assert.equal(typeof runner.validateProbeReport, 'function', 'runner must validate the actual child receipt');
  const root = await ownedRoot();
  const bytes = Buffer.from('owned evidence');
  const relativePath = 'receipt.json';
  await writeFile(join(root, relativePath), bytes);
  const report = { runId: 'current', headSha: 'a'.repeat(40), entrypointSha256: 'b'.repeat(64), status: 'passed',
    cases: [{ id: 'required', status: 'passed', executed: true, evidenceLevel: 'process-integration', assertions: ['actual'], evidenceFiles: [relativePath] }],
    commands: [{ argv: ['node', 'owned'], exitCode: 0, status: 'executed' }],
    artifacts: [{ relativePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const expected = { runId: 'current', headSha: report.headSha, entrypointSha256: report.entrypointSha256, requiredIds: ['required'], evidenceRoot: root };
  try {
    await runner.validateProbeReport(report, expected);
    await assert.rejects(() => runner.validateProbeReport({ ...report, runId: 'stale' }, expected), /binding/);
    await assert.rejects(() => runner.validateProbeReport({ ...report, commands: [] }, expected), /command/);
    await assert.rejects(() => runner.validateProbeReport({ ...report, artifacts: [] }, expected), /evidence/);
    await writeFile(join(root, relativePath), 'tampered');
    await assert.rejects(() => runner.validateProbeReport(report, expected), /hash|evidence/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
