import assert from 'node:assert/strict';
import test from 'node:test';
import { createParamCacheFixture } from './param-ipc-cache-fixture.mjs';

for (const write of ['write', 'writeField']) test(`settled bare PARAM ${write} releases full-payload rows before knowledge refresh`, async () => {
  const fixture = await createParamCacheFixture();
  try {
    assert.equal((await fixture.readAll()).ok, true);
    assert.equal(fixture.state.caches.paramAllCache.size, 1);
    assert.equal((await fixture[write]()).ok, true);
    assert.deepEqual(fixture.state.refreshObservations, [{ allDocuments: 0, pageDocuments: 0, retainedRows: 0 }]);
    const current = await fixture.readAll();
    assert.equal(current.sourceHash, 'hash-1');
    assert.equal(current.rows[0].name, 'revision-1');
    assert.equal(fixture.state.reads, 2, 'post-write all-payload read must obtain the current native document');
  } finally { await fixture.dispose(); }
});

test('failed PARAM write retains valid full-payload cache and does not refresh', async () => {
  const fixture = await createParamCacheFixture();
  try {
    await fixture.readAll(); fixture.state.committed = false;
    assert.equal((await fixture.write()).ok, false);
    assert.equal(fixture.state.caches.paramAllCache.size, 1);
    assert.deepEqual(fixture.state.refreshObservations, []);
    assert.equal((await fixture.readAll()).sourceHash, 'hash-0');
    assert.equal(fixture.state.reads, 1);
  } finally { await fixture.dispose(); }
});

test('cache cleanup targets only the committed source and survives knowledge refresh failure', async () => {
  const fixture = await createParamCacheFixture({ fileCount: 2 });
  try {
    await fixture.readAll(fixture.files[0]); await fixture.readAll(fixture.files[1]);
    fixture.state.refreshFailure = true;
    const result = await fixture.write(fixture.files[0]);
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics[0].code, 'POSTCOMMIT_REFRESH_FAILED');
    assert.equal(fixture.state.caches.paramAllCache.has(fixture.files[0].sourceUri), false);
    assert.equal(fixture.state.caches.paramAllCache.has(fixture.files[1].sourceUri), true);
    assert.equal(fixture.state.refreshObservations.length, 1);
    assert.equal((await fixture.readAll(fixture.files[0])).sourceHash, 'hash-1');
    assert.equal((await fixture.readAll(fixture.files[1])).sourceHash, 'hash-0');
  } finally { await fixture.dispose(); }
});
