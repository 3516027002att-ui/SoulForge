import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createParamCacheFixture } from './param-ipc-cache-fixture.mjs';

// These are actual IPC handler behavior regressions with a fake native transport.
// Native DFLT/cache producer coverage is owned by the Bridge binder-cache suite.
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const f = await createParamCacheFixture({ container: true });
  const bytes = Buffer.from('owned PARAM child A');
  Object.assign(f.state, { sourceHash: A, calls: [] });
  f.state.native = async input => {
    f.state.calls.push(input);
    const childBytes = f.state.childBytes ?? bytes;
    const childHash = hash(childBytes);
    if (input.command === 'list-bnd4-entries') {
      if (f.state.onList) await f.state.onList();
      return { parseStatus: 'confirmed', diagnostics: [], data: {
        sourceHash: f.state.sourceHash, payloadHash: 'd'.repeat(64),
        entries: [{ index: 0, name: f.state.entryName ?? 'Owned.param', contentHash: childHash, uncompressedSize: bytes.length }] } };
    }
    if (input.command === 'extract-bnd4-child') {
      const extractSourceHash = f.state.extractSourceHash ?? f.state.sourceHash;
      if (f.state.onExtract) await f.state.onExtract(input);
      await writeFile(input.commandOptions.outputPath, childBytes);
      return { parseStatus: 'confirmed', diagnostics: [], data: {
        sourceHash: extractSourceHash,
        index: f.state.extractIndex ?? 0, name: 'Owned.param', contentHash: f.state.extractChildHash ?? childHash } };
    }
    assert.equal(input.command, 'read-param-document');
    const actual = await readFile(input.filePath);
    return { parseStatus: 'confirmed', diagnostics: [], data: { sourceHash: hash(actual),
      sessionToken: 'owned-token', typeName: 'FIXTURE_UNKNOWN_PARAM', rowDataSize: 4, rowCount: 1,
      rows: [{ rowIndex: 0, id: 7, name: 'child-A', dataHash: hash(Buffer.alloc(4)), dataBase64: 'AAAAAA==' }] } };
  };
  f.page = (loadAll = true) => f.invoke('resource.readContainerParamPage', f.files[0].sourceUri, 0, 0, 100, undefined, loadAll);
  f.list = () => f.invoke('resource.listContainerParams', f.files[0].sourceUri);
  f.index = () => f.invoke('resource.readContainerParamRowIndex', f.files[0].sourceUri, 0);
  return f;
}
function rejected(result, code) {
  assert.equal(result.ok, false, 'source/child mismatch must refuse the read');
  assert.ok(result.diagnostics.some(item => item.code === code), JSON.stringify(result.diagnostics));
}
function absentVersion(f, version) {
  for (const name of ['paramEntryTableCache', 'unpackedParamCache', 'containerParamAllCache', 'containerParamSessionCache']) {
    assert.ok(![...f.state.caches[name].keys()].some(key => key.includes(`#${version}`)), `${name} must not promote ${version}`);
  }
}
for (const read of ['page', 'index']) test(`${read} rejects stale native A enumeration under indexed B before migrating a cached child`, async () => {
  const f = await fixture();
  try {
    assert.equal((await f[read]()).ok, true);
    f.files[0].sha256 = B;
    rejected(await f[read](), 'PARAM_CONTAINER_SOURCE_HASH_MISMATCH');
    absentVersion(f, B);
    assert.equal(f.state.calls.filter(call => call.command === 'extract-bnd4-child').length, 1);
  } finally { await f.dispose(); }
});
test('list refuses mismatched native provenance before seeding its shared entry table', async () => {
  const f = await fixture();
  try {
    f.files[0].sha256 = B;
    rejected(await f.list(), 'PARAM_CONTAINER_SOURCE_HASH_MISMATCH');
    assert.deepEqual(f.state.caches.paramEntryTableCache.size, 0);
  } finally { await f.dispose(); }
});
for (const [field, value, code] of [
  ['extractSourceHash', B, 'PARAM_CONTAINER_SOURCE_HASH_MISMATCH'],
  ['extractIndex', 1, 'PARAM_UNPACK_CHILD_IDENTITY_MISMATCH'],
  ['extractChildHash', B, 'PARAM_UNPACK_CHILD_IDENTITY_MISMATCH']
]) test(`extraction refuses ${field} disagreement before child/document cache promotion`, async () => {
  const f = await fixture();
  try {
    f.state[field] = value;
    rejected(await f.page(), code);
    assert.equal(f.state.caches.unpackedParamCache.size, 0);
    assert.equal(f.state.caches.containerParamAllCache.size, 0);
    assert.equal(f.state.calls.filter(call => call.command === 'read-param-document').length, 0);
  } finally { await f.dispose(); }
});
test('missing physical hash keeps read-only path namespace and later promotes the same source without re-extraction', async () => {
  const f = await fixture();
  try {
    delete f.files[0].sha256;
    assert.equal((await f.list()).ok, true);
    const first = await f.page(false);
    assert.equal(first.ok, true);
    assert.equal(first.containerHash, '');
    const originalPath = [...f.state.caches.unpackedParamCache.values()][0].absolutePath;
    f.files[0].sha256 = A;
    const second = await f.page(false);
    assert.equal(second.ok, true);
    assert.equal(second.containerHash, A);
    assert.equal(second.sessionToken, first.sessionToken);
    assert.ok([...f.state.caches.unpackedParamCache.values()].every(child => child.absolutePath === originalPath));
    await f.page(false);
    assert.equal(f.state.calls.filter(call => call.command === 'list-bnd4-entries').length, 2);
    assert.equal(f.state.calls.filter(call => call.command === 'extract-bnd4-child').length, 1);
  } finally { await f.dispose(); }
});
test('async indexed hash update cannot advertise B for an A read started without an indexed hash', async () => {
  const f = await fixture();
  try {
    delete f.files[0].sha256;
    f.state.onList = () => { f.files[0].sha256 = B; };
    const result = await f.page();
    assert.equal(result.ok, true);
    assert.equal(result.containerHash, '', 'DTO must use the captured physical hash, never a newer index value');
    absentVersion(f, B);
  } finally { await f.dispose(); }
});
test('verified new parent B with identical stored child rebinds the existing staged path', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.page(false)).ok, true);
    const first = [...f.state.caches.unpackedParamCache.values()][0];
    f.files[0].sha256 = B;
    f.state.sourceHash = B;
    const result = await f.page(false);
    assert.equal(result.ok, true);
    assert.equal(result.containerHash, B);
    const rebound = f.state.caches.unpackedParamCache.get(`${f.files[0].sourceUri}#${B}#0`);
    assert.equal(rebound.absolutePath, first.absolutePath);
    assert.equal(rebound.sourceHash, B);
    assert.equal(f.state.calls.filter(call => call.command === 'extract-bnd4-child').length, 1);
  } finally { await f.dispose(); }
});
test('read-only full export with no physical hash can reach its save dialog', async () => {
  const f = await fixture();
  try {
    delete f.files[0].sha256;
    const result = await f.invoke('param.exportNamesCsv', f.files[0].sourceUri, '', 0);
    assert.ok(result.diagnostics.some(item => item.code === 'CSV_EXPORT_CANCELLED'), JSON.stringify(result.diagnostics));
    assert.equal(f.state.calls.filter(call => call.command === 'read-param-document').length, 1);
  } finally { await f.dispose(); }
});

test('rejected newer-source extraction cannot overwrite a retained older staged child when index hash is missing', async () => {
  const f = await fixture();
  try {
    delete f.files[0].sha256;
    assert.equal((await f.index()).ok, true);
    const first = [...f.state.caches.unpackedParamCache.values()][0];
    const original = await readFile(first.absolutePath);
    f.state.sourceHash = B;
    f.state.childBytes = Buffer.from('owned PARAM child B');
    assert.equal((await f.list()).ok, true);
    f.state.extractSourceHash = 'c'.repeat(64);
    rejected(await f.index(), 'PARAM_CONTAINER_SOURCE_HASH_MISMATCH');
    assert.deepEqual(await readFile(first.absolutePath), original, 'a refused extraction must preserve earlier retained child bytes');
  } finally { await f.dispose(); }
});

test('legacy full-document cache is bound to the freshly verified stored child hash under a path namespace', async () => {
  const f = await fixture();
  try {
    delete f.files[0].sha256;
    const first = await f.page();
    assert.equal(first.ok, true);
    f.state.sourceHash = B;
    f.state.childBytes = Buffer.from('owned PARAM child B');
    assert.equal((await f.list()).ok, true);
    const second = await f.page();
    assert.equal(second.ok, true);
    assert.equal(second.sourceHash, hash(f.state.childBytes));
    assert.notEqual(second.sourceHash, first.sourceHash);
  } finally { await f.dispose(); }
});
test('different verified sources under a path namespace cannot share an in-flight extraction', async () => {
  const f = await fixture();
  let releaseA;
  const blockedA = new Promise(resolve => { releaseA = resolve; });
  let enteredA;
  const firstEntered = new Promise(resolve => { enteredA = resolve; });
  try {
    delete f.files[0].sha256;
    let extractions = 0;
    f.state.onExtract = async () => { if (++extractions === 1) { enteredA(); await blockedA; } };
    const firstPending = f.page();
    await firstEntered;
    f.state.sourceHash = B;
    f.state.childBytes = Buffer.from('owned PARAM child B');
    assert.equal((await f.list()).ok, true);
    const secondPending = f.page();
    await new Promise(resolve => setImmediate(resolve));
    releaseA();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.sourceHash, hash(Buffer.from('owned PARAM child A')));
    assert.equal(second.sourceHash, hash(f.state.childBytes), 'B must receive its own staged child rather than joining A');
    assert.equal(extractions, 2);
  } finally { releaseA(); await f.dispose(); }
});

test('verified parent metadata rename rebinds display name while preserving staged child/session', async () => {
  const f = await fixture();
  try {
    const first = await f.page(false);
    assert.equal(first.ok, true);
    const originalPath = [...f.state.caches.unpackedParamCache.values()][0].absolutePath;
    f.files[0].sha256 = B;
    f.state.sourceHash = B;
    f.state.entryName = 'Renamed.param';
    const result = await f.page(false);
    assert.equal(result.ok, true);
    assert.equal(result.paramName, 'Renamed.param');
    assert.equal([...f.state.caches.unpackedParamCache.values()].at(-1).absolutePath, originalPath);
    assert.equal(result.sessionToken, first.sessionToken);
    assert.equal(f.state.calls.filter(call => call.command === 'extract-bnd4-child').length, 1);
  } finally { await f.dispose(); }
});

for (const read of ['list', 'page']) test(`${read} rejects malformed native physical source hashes before cache/extraction promotion`, async () => {
  const f = await fixture();
  try {
    delete f.files[0].sha256;
    f.state.sourceHash = '../malformed-native-source';
    rejected(await f[read](), 'PARAM_CONTAINER_SOURCE_HASH_MISMATCH');
    for (const name of ['paramEntryTableCache', 'unpackedParamCache', 'containerParamAllCache', 'containerParamSessionCache']) {
      assert.equal(f.state.caches[name].size, 0, `${name} must reject malformed physical provenance`);
    }
    assert.deepEqual(f.state.calls.map(call => call.command), ['list-bnd4-entries']);
    assert.equal(existsSync(join(f.root, 'staging', 'param-unpack')), false, 'no extraction directory may be created from native hash text');
  } finally { await f.dispose(); }
});
