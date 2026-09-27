import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IndexedFile } from '@soulforge/shared';
import { analyzeWorkspace } from '@soulforge/core';
// @ts-ignore Focused runner executes this source with Node TypeScript stripping.
import { createPostCommitSemanticAnalysisOptions } from './postCommitSemanticAnalysis.ts';

test('post-commit native refresh avoids a duplicate Bridge export and inspection pass', async () => {
  const sourceUri = 'file://param/gameparam/gameparam.parambnd.dcx';
  const file: IndexedFile = {
    id: sourceUri,
    workspaceId: 'post-commit-analysis-smoke',
    sourceUri,
    sourcePath: 'param/gameparam/gameparam.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'partial',
    diagnostics: [],
    absolutePath: 'C:/post-commit-analysis/param/gameparam/gameparam.parambnd.dcx',
    relativePath: 'param/gameparam/gameparam.parambnd.dcx',
    extension: '.dcx',
    compoundExtension: '.parambnd.dcx',
    formatKind: 'dcx',
    formatLabel: 'DCX',
    size: 1,
    mtimeMs: 1
  };

  const options = createPostCommitSemanticAnalysisOptions({
    workspaceRoot: 'C:/post-commit-analysis',
    files: [file]
  });
  assert.equal(options.exportNativeCandidateResources, false);
  assert.equal(options.exportNativeMsgResources, false);
  assert.equal(options.inspectNativeResources, false);

  const result = await analyzeWorkspace({
    ...options,
    bridgeExecutablePath: 'C:/missing/SoulForge.Bridge.exe',
    bridgeTimeoutMs: 5
  });
  assert.equal(result.parsedFiles, 0, 'the authoritative native refresh owns PARAM decoding');
  assert.equal(result.inspectedFiles, 0, 'post-commit refresh does not run a redundant native inspect');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.index.getFile(sourceUri)?.sourceUri, sourceUri, 'the candidate still retains the changed file catalog');
  assert.equal(result.index.getStats().paramRows, 0, 'the analysis candidate must not materialize a second PARAM table');
});
