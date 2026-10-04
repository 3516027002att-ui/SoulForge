import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { summarizeNativeReads, verifyFileCoverage } from './native-read-acceptance.mjs';

const sourcePath = 'packages/core/src/testing/runWorkspaceCompletenessMatrixSmoke.ts';
const source = readFileSync(sourcePath, 'utf8');
const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const mainDeclaration = sourceFile.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'main');
assert.ok(mainDeclaration, 'workspace-completeness main function must exist');
const mainCode = ts.transpileModule(mainDeclaration.getText(sourceFile), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;

async function runMain({ files, diagnostics = [], probeFile }) {
  const logged = [];
  const dependencies = {
    resolveWorkspaceRoot: () => 'C:/fixture',
    existsSync: () => true,
    scanWorkspace: async () => ({ files, diagnostics }),
    skipIndexedPath: () => false,
    probeFile: probeFile ?? (async (_absolutePath, relativePath, size) => ({
      relativePath,
      familyId: 'text',
      openKind: 'plain-text',
      size,
      status: 'opened'
    })),
    isSemanticOpenKind: () => false,
    verifyFileCoverage,
    summarizeNativeReads,
    process: { env: {} },
    console: { log: (value) => logged.push(JSON.parse(value)) }
  };
  const main = new Function(...Object.keys(dependencies), `${mainCode}; return main;`)(
    ...Object.values(dependencies)
  );
  let thrown;
  try {
    await main();
  } catch (error) {
    thrown = error;
  }
  assert.equal(logged.length, 1, 'main must emit one JSON summary');
  return { summary: logged[0], thrown };
}

const oneFile = [{ absolutePath: 'C:/fixture/opened.txt', relativePath: 'opened.txt', size: 1 }];
const blockedDirectory = {
  severity: 'warning', code: 'DIRECTORY_READ_FAILED', message: 'CONTROLLED_EACCES',
  details: { directoryPath: 'C:/fixture/blocked' }
};
const unstatableFile = {
  severity: 'warning', code: 'FILE_STAT_FAILED', message: 'CONTROLLED_EACCES',
  details: { absolutePath: 'C:/fixture/lost.txt' }
};

test('incomplete directory and file-stat scans cannot pass workspace coverage', async () => {
  for (const diagnostic of [blockedDirectory, unstatableFile]) {
    const { summary, thrown } = await runMain({ files: oneFile, diagnostics: [diagnostic] });

    assert.equal(summary.status, 'failed', diagnostic.code);
    assert.equal(summary.ok, false, diagnostic.code);
    assert.equal(summary.coverage.inputOutputOk, true, 'indexed outputs can match without proving scanner completeness');
    assert.equal(summary.coverage.scanComplete, false, diagnostic.code);
    assert.equal(summary.coverage.ok, false, diagnostic.code);
    assert.deepEqual(summary.scanDiagnostics, [diagnostic]);
    assert.deepEqual(summary.incompleteScanDiagnostics, [diagnostic]);
    assert.ok(thrown instanceof Error, 'a failed completeness gate must exit through the smoke failure path');
  }
});

test('zero indexed files with a scan error are failed, not reported as an empty corpus', async () => {
  const { summary, thrown } = await runMain({ files: [], diagnostics: [blockedDirectory] });

  assert.equal(summary.status, 'failed');
  assert.equal(summary.ok, false);
  assert.equal(summary.reason, 'WORKSPACE_SCAN_INCOMPLETE');
  assert.equal(summary.scanned, 0);
  assert.equal(summary.coverage.inputOutputOk, true);
  assert.equal(summary.coverage.scanComplete, false);
  assert.equal(summary.coverage.ok, false);
  assert.deepEqual(summary.scanDiagnostics, [blockedDirectory]);
  assert.ok(thrown instanceof Error);
});

test('zero indexed files without a blocking scan diagnostic remain not_run', async () => {
  const { summary, thrown } = await runMain({ files: [] });

  assert.equal(summary.status, 'not_run');
  assert.equal(summary.ok, null);
  assert.equal(summary.reason, 'NATIVE_CORPUS_EMPTY');
  assert.deepEqual(summary.scanDiagnostics, []);
  assert.equal(thrown, undefined);
});

test('scanner hash failure preserves the warning but cannot prove the same source version', async () => {
  const hashWarning = {
    severity: 'warning', code: 'FILE_HASH_FAILED', message: 'CONTROLLED_HASH_FAILURE',
    details: { absolutePath: oneFile[0].absolutePath }
  };
  const { summary, thrown } = await runMain({ files: oneFile, diagnostics: [hashWarning] });

  assert.equal(summary.status, 'unavailable');
  assert.equal(summary.ok, null);
  assert.equal(summary.coverage.inputOutputOk, true, 'the file remains in the indexed result set');
  assert.equal(summary.coverage.scanComplete, true, 'hash enrichment did not lose the indexed file');
  assert.equal(summary.coverage.scanHashesComplete, false);
  assert.equal(summary.coverage.ok, false);
  assert.deepEqual(summary.scanDiagnostics, [hashWarning]);
  assert.deepEqual(summary.sourceHashUnverifiedDiagnostics, [hashWarning]);
  assert.equal(summary.acceptanceUnavailable.length, 1);
  assert.equal(summary.acceptanceUnavailable[0].relativePath, 'opened.txt');
  assert.equal(summary.counts.passed, 0);
  assert.equal(summary.counts.unavailable, 1);
  assert.equal(thrown, undefined);
});

test('a native read failure takes precedence over hash-unverified unavailability', async () => {
  const hashWarning = {
    severity: 'warning', code: 'FILE_HASH_FAILED', message: 'CONTROLLED_HASH_FAILURE',
    details: { absolutePath: oneFile[0].absolutePath }
  };
  const { summary, thrown } = await runMain({
    files: oneFile,
    diagnostics: [hashWarning],
    probeFile: async (_absolutePath, relativePath, size) => ({
      relativePath, familyId: 'text', openKind: 'plain-text', size, status: 'failed'
    })
  });

  assert.equal(summary.status, 'failed');
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.unavailable, 0);
  assert.equal(summary.acceptanceUnavailable.length, 0);
  assert.equal(summary.failed.length, 1);
  assert.ok(thrown instanceof Error);
});

test('native read failures remain failed and history rows are explicit acceptance exclusions', async () => {
  const files = [
    oneFile[0],
    { absolutePath: 'C:/fixture/history.txt', relativePath: 'history.txt', size: 1 }
  ];
  const { summary, thrown } = await runMain({
    files,
    probeFile: async (_absolutePath, relativePath, size) => ({
      relativePath,
      familyId: relativePath === 'history.txt' ? 'history' : 'text',
      openKind: relativePath === 'history.txt' ? 'history' : 'plain-text',
      size,
      status: relativePath === 'history.txt' ? 'history' : 'failed'
    })
  });

  assert.equal(summary.status, 'failed');
  assert.equal(summary.ok, false);
  assert.equal(summary.coverage.inputCount, 2);
  assert.equal(summary.coverage.processedCount, 2);
  assert.equal(summary.coverage.inputOutputOk, true);
  assert.equal(summary.acceptanceScope.fourStateInputCount, 1);
  assert.equal(summary.acceptanceScope.excluded.history.count, 1);
  assert.match(summary.acceptanceScope.excluded.history.reason, /history/i);
  assert.equal(summary.counts.failed, 1);
  assert.ok(thrown instanceof Error);
});
