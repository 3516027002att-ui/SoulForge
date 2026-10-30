import assert from 'node:assert/strict';
// @ts-ignore Focused runner uses Node TypeScript stripping.
import { WorkspaceReadLifetime } from './workspaceReadLifetime.ts';

// 无上限时保持原语义：全部保留
{
  const lifetime = new WorkspaceReadLifetime();
  const cache = lifetime.createCache<string, number>();
  for (let i = 0; i < 100; i += 1) cache.set(`k${i}`, i);
  assert.equal(cache.size, 100);
}

// 有上限时按插入序淘汰最旧（#27：这些缓存原先会无界增长）
{
  const lifetime = new WorkspaceReadLifetime();
  const cache = lifetime.createCache<string, number>({ maxEntries: 3 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.set('d', 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.has('a'), false, 'oldest entry must be evicted');
  assert.equal(cache.get('d'), 4, 'newest entry must survive');
}

// 覆盖已有键不触发淘汰
{
  const lifetime = new WorkspaceReadLifetime();
  const cache = lifetime.createCache<string, number>({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), 3);
}

// 上限为 0 / 负数视为不限制，避免误配置把小缓存清空
{
  const lifetime = new WorkspaceReadLifetime();
  const cache = lifetime.createCache<string, number>({ maxEntries: 0 });
  for (let i = 0; i < 10; i += 1) cache.set(`k${i}`, i);
  assert.equal(cache.size, 10);
}

console.log('workspaceReadLifetime bounds: ok');
