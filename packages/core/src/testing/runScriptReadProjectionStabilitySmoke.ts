import assert from 'node:assert/strict';
import type { ScriptExport } from '@soulforge/shared';
import { projectScriptReadExport } from '../references/scriptReadProjection.js';

const sourceUri = 'file://script/test.luabnd.dcx';
const outerHash = 'outer-hash-v1';
const targetUri = `${sourceUri}!/target.lua`;
const beforeUri = `${sourceUri}!/before.lua`;
const afterUri = `${sourceUri}!/after.lua`;
const calls = [{ statementIndex: 3, callee: 'Target', literalArgs: ['x'], resolution: 'api' as const }];

const existing: ScriptExport = {
  sourceUri,
  containerKind: 'luabnd',
  outerFileHash: outerHash,
  sourceRevision: 100,
  catalogComplete: true,
  scripts: [
    {
      uri: beforeUri, sourceUri, childChain: ['before.lua'], entryIndex: 0,
      entryName: 'before.lua', contentKind: 'catalog-only', sourceHash: 'before-hash',
      outerFileHash: outerHash
    },
    {
      uri: targetUri, sourceUri, childChain: ['target.lua'], entryIndex: 1,
      entryName: 'target.lua', contentKind: 'source', sourceText: 'old()',
      encodingDiagnostics: ['old encoding note'], calls, sourceHash: 'target-hash',
      outerFileHash: outerHash, sourceRevision: 100
    },
    {
      uri: afterUri, sourceUri, childChain: ['after.lua'], entryIndex: 2,
      entryName: 'after.lua', contentKind: 'catalog-only', sourceHash: 'after-hash',
      outerFileHash: outerHash
    }
  ]
};

const sameRead = projectScriptReadExport({
  sourceUri,
  childPath: 'target.lua',
  sourceRevision: 200,
  existing,
  script: { isBytecode: false, sourceText: 'fresh()', sourceHash: 'target-hash', outerFileHash: outerHash }
});
assert.deepEqual(sameRead.scripts.map((item) => item.uri), [beforeUri, targetUri, afterUri],
  'same child identity must retain its physical position');
const sameTarget = sameRead.scripts.find((item) => item.uri === targetUri)!;
assert.equal(sameTarget.entryIndex, 1);
assert.deepEqual(sameTarget.encodingDiagnostics, ['old encoding note']);
assert.equal(sameTarget.calls, undefined, 'changed source representation must not retain derived calls');
assert.equal(sameTarget.sourceText, 'fresh()');
assert.equal(sameTarget.sourceRevision, 200);

const repeatedRead = projectScriptReadExport({
  sourceUri,
  childPath: 'target.lua',
  sourceRevision: 200,
  existing: sameRead,
  script: { isBytecode: false, sourceText: 'fresh()', sourceHash: 'target-hash', outerFileHash: outerHash }
});
assert.deepEqual(repeatedRead, sameRead, 'repeating the same native read must not churn the snapshot');

const changedChild = projectScriptReadExport({
  sourceUri,
  childPath: 'target.lua',
  sourceRevision: 201,
  existing: sameRead,
  script: { isBytecode: false, sourceText: 'changed()', sourceHash: 'target-hash-v2', outerFileHash: outerHash }
});
assert.deepEqual(changedChild.scripts.map((item) => item.uri), [beforeUri, targetUri, afterUri]);
const changedTarget = changedChild.scripts.find((item) => item.uri === targetUri)!;
assert.equal(changedTarget.encodingDiagnostics, undefined, 'changed child must not retain stale read metadata');
assert.equal(changedTarget.calls, undefined, 'changed child must not retain stale call projection');

const sameTextExisting: ScriptExport = {
  ...sameRead,
  scripts: sameRead.scripts.map((item) => item.uri === targetUri ? { ...item, calls } : item)
};
const sameTextRead = projectScriptReadExport({
  sourceUri,
  childPath: 'target.lua',
  sourceRevision: 201,
  existing: sameTextExisting,
  script: { isBytecode: false, sourceText: 'fresh()', sourceHash: 'target-hash', outerFileHash: outerHash }
});
assert.deepEqual(sameTextRead.scripts.find((item) => item.uri === targetUri)?.calls, calls,
  'same source representation may retain its derived calls');

const warnedRead = projectScriptReadExport({
  sourceUri,
  childPath: 'target.lua',
  sourceRevision: 202,
  existing: sameRead,
  script: {
    isBytecode: false, sourceText: 'fresh()', sourceHash: 'target-hash', outerFileHash: outerHash,
    warnings: ['new native warning']
  }
});
assert.deepEqual(warnedRead.scripts.find((item) => item.uri === targetUri)?.encodingDiagnostics,
  ['new native warning'], 'new native warnings replace old diagnostics');

const clearedWarnings = projectScriptReadExport({
  sourceUri,
  childPath: 'target.lua',
  sourceRevision: 203,
  existing: sameRead,
  script: {
    isBytecode: false, sourceText: 'fresh()', sourceHash: 'target-hash', outerFileHash: outerHash,
    warnings: []
  }
});
assert.deepEqual(clearedWarnings.scripts.find((item) => item.uri === targetUri)?.encodingDiagnostics, [],
  'an explicit empty native warning list clears stale diagnostics');

const changedOuter = projectScriptReadExport({
  sourceUri,
  childPath: 'target.lua',
  sourceRevision: 300,
  existing: sameRead,
  script: { isBytecode: false, sourceText: 'new outer()', sourceHash: 'target-hash-v3', outerFileHash: 'outer-hash-v2' }
});
assert.deepEqual(changedOuter.scripts.map((item) => item.uri), [targetUri],
  'a changed container identity must not carry old siblings');
assert.equal(changedOuter.catalogComplete, false,
  'a changed container identity cannot claim the old catalog is complete');

console.log(JSON.stringify({ ok: true, suite: 'script-read-projection-stability' }));
