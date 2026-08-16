import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commitEmevdFullDocument, EmevdAuthorityCache } from './emevdAuthorityCache.js';

test('取消期间不得写入权威缓存', () => {
  const cache = new EmevdAuthorityCache<{ id: string }>();
  const controller = new AbortController();
  controller.abort();
  const committed = cache.commit('file://event/a.emevd', { id: 'abandoned' }, controller.signal);
  assert.equal(committed, false);
  assert.equal(cache.size, 0, '被取消的文档不得进入权威缓存');
});

test('未取消时写入权威缓存', () => {
  const cache = new EmevdAuthorityCache<{ id: string }>();
  const controller = new AbortController();
  const document = { id: 'live' };
  const committed = cache.commit('file://event/a.emevd', document, controller.signal, 'hash-a');
  assert.equal(committed, true);
  assert.equal(cache.get('file://event/a.emevd'), document);
});

test('容量上界淘汰最久未使用项', () => {
  const cache = new EmevdAuthorityCache<{ id: string }>();
  const live = new AbortController().signal;
  for (let i = 0; i < EmevdAuthorityCache.Capacity + 2; i += 1) {
    cache.commit(`file://event/${i}.emevd`, { id: String(i) }, live);
  }
  assert.equal(cache.size, EmevdAuthorityCache.Capacity);
  assert.equal(cache.get('file://event/0.emevd'), undefined);
  assert.ok(cache.get(`file://event/${EmevdAuthorityCache.Capacity + 1}.emevd`));
});

test('hash 漂移时不得返回陈旧文档', () => {
  const cache = new EmevdAuthorityCache<{ id: string }>();
  cache.commit('file://event/a.emevd', { id: 'old' }, new AbortController().signal, 'aaa');
  assert.equal(cache.get('file://event/a.emevd', 'bbb'), undefined);
});

test('clear 清空工作区残留', () => {
  const cache = new EmevdAuthorityCache<{ id: string }>();
  cache.commit('file://event/a.emevd', { id: 'x' }, new AbortController().signal);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('commitEmevdFullDocument 兼容 Map 闸门', () => {
  const map = new Map<string, { id: string }>();
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(commitEmevdFullDocument(map, 'file://a', { id: 'x' }, aborted.signal), false);
  assert.equal(map.size, 0);
});
