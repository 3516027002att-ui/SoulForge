import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IndexedFile } from '@soulforge/shared';
import { WorkspaceIndex } from './workspaceIndex.js';
import { refreshKnowledgeAfterCommit } from './knowledgeRefresh.js';

const afterFile: IndexedFile = {
  id: 'changed-file',
  workspaceId: 'file:///mod',
  sourceUri: 'file:///mod/param/gameparam/gameparam.parambnd.dcx',
  sourcePath: 'param/gameparam/gameparam.parambnd.dcx',
  game: 'sekiro',
  resourceKind: 'param',
  parseStatus: 'parsed',
  diagnostics: [],
  absolutePath: 'C:/mod/param/gameparam/gameparam.parambnd.dcx',
  relativePath: 'param/gameparam/gameparam.parambnd.dcx',
  extension: '.dcx',
  compoundExtension: '.parambnd.dcx',
  formatKind: 'dcx',
  formatLabel: 'DCX',
  size: 1,
  mtimeMs: 2,
  sha256: 'after'
};

test('post-commit refresh reports publish and reference-build boundaries in order', async () => {
  const boundaries: string[] = [];
  const candidate = new WorkspaceIndex(afterFile.workspaceId);
  candidate.setFiles([afterFile]);
  const input = {
    index: new WorkspaceIndex(afterFile.workspaceId),
    beforeFiles: [{ ...afterFile, mtimeMs: 1, sha256: 'before' }],
    afterFiles: [afterFile],
    reanalyze: async () => candidate,
    publish: (index: WorkspaceIndex) => index,
    persist: async () => undefined,
    onRefreshBoundary: (stage: 'publish' | 'referenceBuild', phase: 'started' | 'completed' | 'failed') => {
      boundaries.push(`${stage}:${phase}`);
    }
  } as Parameters<typeof refreshKnowledgeAfterCommit>[0] & {
    onRefreshBoundary: (stage: 'publish' | 'referenceBuild', phase: 'started' | 'completed' | 'failed') => void;
  };

  const output = await refreshKnowledgeAfterCommit(input);

  assert.equal(output.result.status, 'converged');
  assert.deepEqual(boundaries, [
    'publish:started',
    'publish:completed',
    'referenceBuild:started',
    'referenceBuild:completed'
  ]);
});
