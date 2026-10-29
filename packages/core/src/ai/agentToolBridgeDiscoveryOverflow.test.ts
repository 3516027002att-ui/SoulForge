import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_BOUNDED_TOOL_RESULT_CHARS,
  createAgentToolBridge
} from './agentToolBridge.js';
import { ToolRegistry } from './toolRegistry.js';

/**
 * 发现结果信封的两条硬契约：
 * 1. 只要工具还返回 nextCursor / hasMore，pagination.truncated 就必须是 true，
 *    否则模型拿到游标却被告知「没有后页」。
 * 2. 当前逻辑页超预算时按可行动性分两种：能推出更小 limit 可以无损重读本页就
 *    fail closed（RESULT_DISCOVERY_WINDOW_TOO_LARGE + retry.limit）；生产者不给
 *    页窗口时交付有界前缀并标 truncated:true。
 */

function makeBridge(data: unknown, name = 'search_events') {
  const registry = new ToolRegistry();
  registry.register({
    name,
    description: 'synthetic discovery page',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', limit: 'safe-integer?', cursor: 'string?' },
    run: () => ({ ok: true as const, state: 'completed' as const, data })
  });
  return createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'normal' } });
}

function pageWithMatches(count: number, bodyRepeat: number) {
  return {
    query: 'synthetic',
    matches: Array.from({ length: count }, (_item, index) => ({
      score: 100 - index,
      item: {
        uri: `file://event/synthetic#${index}`,
        sourceUri: 'file://event/synthetic',
        eventId: index,
        body: 'candidate detail '.repeat(bodyRepeat)
      }
    })),
    matchesTotalCount: count,
    matchesReturnedCount: count,
    total: count,
    totalCount: count,
    offset: 0,
    returned: count,
    returnedCount: count
  };
}

describe('discovery envelope cursor/truncation consistency', () => {
  it('treats a returned nextCursor as proof of a further page', async () => {
    const bridge = makeBridge({ ...pageWithMatches(3, 1), nextCursor: 'page-2' });
    const result = await bridge.executeTool({
      id: 'cursor-only',
      name: 'search_events',
      argumentsJson: '{"query":"synthetic"}'
    });
    assert.equal(result.ok, true, result.content);
    const envelope = JSON.parse(result.content) as {
      pagination?: { truncated?: boolean; cursors?: Record<string, string> };
    };
    assert.equal(envelope.pagination?.truncated, true);
    assert.equal(envelope.pagination?.cursors?.nextCursor, 'page-2');
  });

  it('keeps truncated false when the producer explicitly closes the page', async () => {
    const bridge = makeBridge({ ...pageWithMatches(3, 1), truncated: false, hasMore: false });
    const result = await bridge.executeTool({
      id: 'closed-page',
      name: 'search_events',
      argumentsJson: '{"query":"synthetic"}'
    });
    assert.equal(result.ok, true, result.content);
    const envelope = JSON.parse(result.content) as { pagination?: { truncated?: boolean } };
    assert.equal(envelope.pagination?.truncated, false);
  });
});

describe('discovery envelope overflow handling', () => {
  it('fails closed with an actionable retry when the page window is known', async () => {
    const wide = pageWithMatches(40, 900);
    const bridge = makeBridge({ ...wide, limit: 40, nextCursor: 'beyond-budget-next' });
    const result = await bridge.executeTool({
      id: 'overflow-actionable',
      name: 'search_events',
      argumentsJson: '{"query":"synthetic","limit":40}'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RESULT_DISCOVERY_WINDOW_TOO_LARGE');
    const envelope = JSON.parse(result.content) as {
      error?: { details?: { retry?: { limit?: number }; nextPageCursor?: string } };
    };
    assert.equal(envelope.error?.details?.retry?.limit, 20);
    assert.equal(envelope.error?.details?.nextPageCursor, 'beyond-budget-next');
  });

  it('delivers a bounded truncated prefix when the producer exposes no page window', async () => {
    const wide = pageWithMatches(240, 40);
    const withoutWindow: Record<string, unknown> = { ...wide };
    for (const key of ['offset', 'returned', 'returnedCount', 'matchesReturnedCount']) {
      delete withoutWindow[key];
    }
    const bridge = makeBridge({ ...withoutWindow, nextCursor: 'opaque-page-2' });
    const result = await bridge.executeTool({
      id: 'overflow-opaque',
      name: 'search_events',
      argumentsJson: '{"query":"synthetic"}'
    });
    assert.equal(result.ok, true, result.content);
    assert.ok(result.content.length <= MAX_BOUNDED_TOOL_RESULT_CHARS);
    const envelope = JSON.parse(result.content) as {
      data?: { itemsKey?: string; record?: Record<string, unknown> };
      pagination?: { truncated?: boolean };
      truncated?: boolean;
    };
    assert.equal(envelope.pagination?.truncated, true);
    assert.equal(envelope.truncated, true);
    assert.ok(result.content.includes('opaque-page-2'), 'producer cursor must survive');
    assert.ok(result.content.includes('本页其余候选未交付'), 'partial-page hint must reach the model');
    const pageKey = envelope.data?.itemsKey;
    assert.equal(typeof pageKey, 'string');
    const page = pageKey ? envelope.data?.record?.[pageKey] : undefined;
    assert.ok(Array.isArray(page) && page.length > 0 && page.length < 240, `page must be bounded: ${JSON.stringify(page)?.slice(0, 120)}`);
  });
});
