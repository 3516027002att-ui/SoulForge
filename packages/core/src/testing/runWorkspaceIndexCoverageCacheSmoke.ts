import assert from 'node:assert/strict';
import type { IndexedFile } from '@soulforge/shared';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

const index = new WorkspaceIndex('coverage-cache-fixture');
const file: IndexedFile = {
  id: 'file:coverage-cache-fixture',
  workspaceId: index.workspaceId,
  sourceUri: 'file:///fixture/param/gameparam.parambnd.dcx',
  sourcePath: 'param/gameparam.parambnd.dcx',
  absolutePath: 'param/gameparam.parambnd.dcx',
  relativePath: 'param/gameparam.parambnd.dcx',
  game: 'sekiro',
  resourceKind: 'param',
  parseStatus: 'parsed',
  diagnostics: [],
  extension: '.dcx',
  compoundExtension: '.parambnd.dcx',
  formatKind: 'param',
  formatLabel: 'PARAM',
  size: 1,
  mtimeMs: 1,
  sha256: 'coverage-cache-hash'
};

// Coverage recomputation must not rebuild a whole SymbolBundle just to derive
// source URI sets.  This fails against the pre-cache implementation, whose
// semanticSourceUris() calls the public bundle projection on every domain.
(index as unknown as { toSymbolBundle: () => never }).toSymbolBundle = () => {
  throw new Error('coverage recomputation unexpectedly rebuilt SymbolBundle');
};
assert.doesNotThrow(() => index.setFiles([file]));
assert.equal(index.getCoverageState('workspace', 'param').expectedResources, 1);
assert.equal(index.upsertParamExport({
  paramName: 'SyntheticParam',
  sourceUri: file.sourceUri,
  sourceHash: 'coverage-cache-hash',
  outerFileHash: 'coverage-cache-hash',
  sourceRevision: file.mtimeMs,
  rows: [{
    uri: `${file.sourceUri}#SyntheticParam/1`,
    sourceUri: file.sourceUri,
    paramName: 'SyntheticParam',
    rowId: 1,
    fields: []
  }]
}), true);
assert.deepEqual(
  index.getCoverageState('workspace', 'param').coveredResourceIds,
  [file.sourceUri]
);

const msgFile: IndexedFile = {
  ...file,
  id: 'file:coverage-cache-fixture-msg',
  sourceUri: 'file:///fixture/msg/menu.fmg',
  sourcePath: 'msg/menu.fmg',
  absolutePath: 'msg/menu.fmg',
  relativePath: 'msg/menu.fmg',
  resourceKind: 'msg',
  formatKind: 'fmg',
  formatLabel: 'FMG',
  compoundExtension: '.fmg'
};
const partialParamFile = { ...file, parseStatus: 'partial' as const };
const partialMsgFile = { ...msgFile, parseStatus: 'partial' as const };
const populated = new WorkspaceIndex('coverage-cache-clone-fixture');
populated.setFiles([partialParamFile, partialMsgFile]);
assert.equal(populated.upsertParamExport({
  paramName: 'SyntheticParam',
  sourceUri: partialParamFile.sourceUri,
  rows: [{
    uri: `${partialParamFile.sourceUri}#SyntheticParam/1`,
    sourceUri: partialParamFile.sourceUri,
    paramName: 'SyntheticParam',
    rowId: 1,
    fields: []
  }]
}), true);
assert.equal(populated.upsertMsgExport({
  category: 'menu',
  entries: [{
    uri: `${partialMsgFile.sourceUri}#1`,
    sourceUri: partialMsgFile.sourceUri,
    category: 'menu',
    textId: 1,
    text: 'synthetic'
  }]
}), true);
const populatedParamCoverage = populated.getCoverageState('workspace', 'param');
const populatedMsgCoverage = populated.getCoverageState('workspace', 'msg');
assert.deepEqual(populatedParamCoverage.coveredResourceIds, [partialParamFile.sourceUri]);
assert.deepEqual(populatedMsgCoverage.coveredResourceIds, [partialMsgFile.sourceUri]);

// cloneForRefresh assigns projection arrays directly after its constructor has
// populated empty URI caches.  Replacing the catalog must therefore rebuild
// those caches, or partial files lose their existing semantic coverage.
const clone = populated.cloneForRefresh();
clone.setFiles([partialParamFile, partialMsgFile]);
assert.deepEqual(
  clone.getCoverageState('workspace', 'param').coveredResourceIds,
  populatedParamCoverage.coveredResourceIds
);
assert.deepEqual(
  clone.getCoverageState('workspace', 'msg').coveredResourceIds,
  populatedMsgCoverage.coveredResourceIds
);

const invalidated = clone.invalidateSource(partialParamFile.sourceUri);
assert.equal(invalidated.removed.paramRows, 1);
assert.deepEqual(clone.getCoverageState('workspace', 'param').coveredResourceIds, []);
assert.equal(clone.upsertParamExport({
  paramName: 'SyntheticParam',
  sourceUri: partialParamFile.sourceUri,
  rows: [{
    uri: `${partialParamFile.sourceUri}#SyntheticParam/2`,
    sourceUri: partialParamFile.sourceUri,
    paramName: 'SyntheticParam',
    rowId: 2,
    fields: []
  }]
}), true);
assert.deepEqual(
  clone.getCoverageState('workspace', 'param').coveredResourceIds,
  [partialParamFile.sourceUri]
);

console.log('runWorkspaceIndexCoverageCacheSmoke: PASS');
