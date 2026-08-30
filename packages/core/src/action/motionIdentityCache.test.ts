import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionMotionIdentityCache } from './motionIdentityCache.js';

describe('ACTION motion identity cache', () => {
  it('keeps two animIds isolated in A-B-A order', () => {
    const cache = new ActionMotionIdentityCache<number>();
    cache.set('file:///chr/c0000.tae', 'rev-1', 10, 1_000_000_010);
    cache.set('file:///chr/c0000.tae', 'rev-1', 11, 1_000_000_011);

    assert.equal(cache.get('file:///chr/c0000.tae', 'rev-1', 10), 1_000_000_010);
    assert.equal(cache.get('file:///chr/c0000.tae', 'rev-1', 11), 1_000_000_011);
    assert.equal(cache.get('file:///chr/c0000.tae', 'rev-1', 10), 1_000_000_010);
  });

  it('keeps two animIds isolated in B-A order and rejects a new revision', () => {
    const cache = new ActionMotionIdentityCache<number>();
    cache.set('file:///chr/c0000.tae', 'rev-1', 11, 1_000_000_011);
    cache.set('file:///chr/c0000.tae', 'rev-1', 10, 1_000_000_010);

    assert.equal(cache.get('file:///chr/c0000.tae', 'rev-1', 11), 1_000_000_011);
    assert.equal(cache.get('file:///chr/c0000.tae', 'rev-1', 10), 1_000_000_010);
    assert.equal(cache.get('file:///chr/c0000.tae', 'rev-2', 10), undefined);
  });
});
