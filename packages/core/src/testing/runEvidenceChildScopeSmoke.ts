/** Native child/table scope must participate in projected evidence identity. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { evidenceKey, evidenceResourceKey, projectEvidenceClaims } from '../model-services/evidenceIdentity.js';

const sourceHash = 'a'.repeat(64);
const options = { workspaceId: 'workspace-fixture', domain: 'param' };
const npcEntry = 'N:\\NTC\\data\\Target\\INTERROOT_win64\\param\\GameParam\\NpcParam.param';
const bulletEntry = 'N:\\NTC\\data\\Target\\INTERROOT_win64\\param\\GameParam\\Bullet.param';

export function runEvidenceChildScopeSmoke(): void {
  const payload = {
    containerPath: 'workspace/param/gameparam/gameparam.parambnd.dcx',
    sourceHash,
    sourceRevision: 123,
    fields: [
      { rowId: 100, fieldId: 'hp', table: 'NpcParam', entryName: npcEntry, value: 10 },
      { rowId: 100, fieldId: 'hp', table: 'Bullet', entryName: bulletEntry, value: 20 }
    ]
  };
  const claims = projectEvidenceClaims(payload, options);
  assert.equal(claims.length, 2);
  assert.equal(new Set(claims.map((claim) => claim.key)).size, 2);
  assert.equal(new Set(claims.map((claim) => claim.resourceKey)).size, 2);
  assert.deepEqual(claims.map((claim) => claim.identity.namespace), ['NpcParam', 'Bullet']);
  assert.deepEqual(claims.map((claim) => claim.identity.childChain), [[npcEntry], [bulletEntry]]);
  for (const claim of claims) {
    assert.equal(claim.key, evidenceKey(claim.identity));
    assert.equal(claim.resourceKey, evidenceResourceKey(claim.identity));
    assert.deepEqual(claim.version, { outerHash: sourceHash, revision: 123 });
    assert.equal(claim.identity.canonicalOuterId, payload.containerPath);
    assert.equal(claim.identity.objectHandle, '100');
    assert.equal(claim.identity.claimKind, 'hp');
  }
  assert.deepEqual(claims.map((claim) => claim.text), ['10', '20']);

  const childOnly = projectEvidenceClaims({
    ...payload,
    fields: payload.fields.map(({ table: _table, ...field }) => field)
  }, options);
  assert.equal(new Set(childOnly.map((claim) => claim.key)).size, 2);
  const namespaceOnly = projectEvidenceClaims({
    ...payload,
    fields: payload.fields.map(({ entryName: _entryName, ...field }) => field)
  }, options);
  assert.equal(new Set(namespaceOnly.map((claim) => claim.key)).size, 2);

  const nested = projectEvidenceClaims({
    ...payload,
    childChain: ['nested.bnd'],
    namespace: 'parent-container'
  }, options);
  assert.deepEqual(nested.map((claim) => claim.identity.childChain), [
    ['nested.bnd', npcEntry], ['nested.bnd', bulletEntry]
  ]);
  assert.deepEqual(nested.map((claim) => claim.identity.namespace), ['NpcParam', 'Bullet']);

  const explicit = projectEvidenceClaims({
    ...payload,
    fields: [{
      rowId: 100, fieldId: 'hp', table: 'NpcParam', entryName: npcEntry,
      identity: { namespace: 'native-table', childChain: ['explicit.bnd', npcEntry] },
      handle: 'native-handle', value: 10
    }]
  }, options);
  assert.equal(explicit[0]?.identity.namespace, 'native-table');
  assert.deepEqual(explicit[0]?.identity.childChain, ['explicit.bnd', npcEntry]);
  assert.equal(explicit[0]?.handle, 'native-handle');

  const hostScoped = projectEvidenceClaims(payload, {
    ...options, namespace: 'host-scope', childChain: ['host-child']
  });
  assert.ok(hostScoped.every((claim) => claim.identity.namespace === 'host-scope'));
  assert.ok(hostScoped.every((claim) => claim.identity.childChain.join('/') === 'host-child'));

  const sameEntry = projectEvidenceClaims({
    ...payload, entryName: npcEntry, fields: [payload.fields[0]]
  }, options);
  assert.deepEqual(sameEntry[0]?.identity.childChain, [npcEntry]);
  const inherited = projectEvidenceClaims({
    ...payload, namespace: 'root-namespace', childChain: ['root-child'],
    fields: [{ rowId: 100, fieldId: 'hp', value: 10 }]
  }, options);
  assert.equal(inherited[0]?.identity.namespace, 'root-namespace');
  assert.deepEqual(inherited[0]?.identity.childChain, ['root-child']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvidenceChildScopeSmoke();
  console.log('Evidence child scope smoke passed.');
}
