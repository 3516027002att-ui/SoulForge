import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IndexedFile } from '@soulforge/shared';
import { analyzeWorkspace } from '@soulforge/core';
// @ts-ignore Focused runner executes this source with Node TypeScript stripping.
import { createPostCommitSemanticAnalysisOptions } from './postCommitSemanticAnalysis.ts';

test('post-commit native refresh avoids a duplicate Bridge export and inspection pass', async (context) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'soulforge-post-commit-analysis-'));
  context.after(() => rm(workspaceRoot, { recursive: true, force: true }));
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
    absolutePath: join(workspaceRoot, 'param/gameparam/gameparam.parambnd.dcx'),
    relativePath: 'param/gameparam/gameparam.parambnd.dcx',
    extension: '.dcx',
    compoundExtension: '.parambnd.dcx',
    formatKind: 'dcx',
    formatLabel: 'DCX',
    size: 1,
    mtimeMs: 1
  };

  const options = createPostCommitSemanticAnalysisOptions({
    workspaceRoot,
    files: [file]
  });
  assert.equal(options.exportNativeCandidateResources, false);
  assert.equal(options.exportNativeMsgResources, false);
  assert.equal(options.inspectNativeResources, false);

  const result = await analyzeWorkspace({
    ...options,
    bridgeExecutablePath: join(workspaceRoot, 'missing/SoulForge.Bridge.exe'),
    bridgeTimeoutMs: 5
  });
  assert.equal(result.parsedFiles, 0, 'the authoritative native refresh owns PARAM decoding');
  assert.equal(result.inspectedFiles, 0, 'post-commit refresh does not run a redundant native inspect');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.index.getFile(sourceUri)?.sourceUri, sourceUri, 'the candidate still retains the changed file catalog');
  assert.equal(result.index.getStats().paramRows, 0, 'the analysis candidate must not materialize a second PARAM table');
});
