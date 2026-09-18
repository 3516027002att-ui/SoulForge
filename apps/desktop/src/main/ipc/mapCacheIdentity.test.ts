import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMapCacheIdentity, type MapCacheIdentityInput } from './mapCacheIdentity.js';

const base: MapCacheIdentityInput = {
  workspaceSessionId: 'session-a',
  workspaceSessionGeneration: 1,
  workspaceId: 'workspace-a',
  indexedFilesRevision: 10,
  indexedFilesIdentityDigest: 'catalog-a',
  overlayRoot: 'D:/mods/a',
  baseRoot: 'D:/game/a'
};

test('map cache identity changes when a base/session/catalog changes', () => {
  const original = makeMapCacheIdentity(base);
  assert.notEqual(makeMapCacheIdentity({ ...base, baseRoot: 'D:/game/b', workspaceSessionId: 'session-b', workspaceSessionGeneration: 2 }), original);
  assert.notEqual(makeMapCacheIdentity({ ...base, indexedFilesRevision: 11, indexedFilesIdentityDigest: 'catalog-b' }), original);
  assert.equal(makeMapCacheIdentity({ ...base }), original);
});
