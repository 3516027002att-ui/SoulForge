import { strict as assert } from 'node:assert';
import { ToolRegistry } from '../ai/toolRegistry.js';
import { MAX_BOUNDED_TOOL_RESULT_BYTES, MAX_BOUNDED_TOOL_RESULT_CHARS, createAgentToolBridge } from '../ai/agentToolBridge.js';

function makeSearchBridge(data: Record<string, unknown>) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'search_events',
    description: 'synthetic paged event search',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', limit: 'number?' },
    run: async () => ({ ok: true as const, state: 'completed' as const, data })
  });
  return createAgentToolBridge({
    registry,
    context: { workspaceIndex: null, mode: 'normal' }
  });
}

const twentyMatches = Array.from({ length: 20 }, (_, index) => ({
  score: 20 - index,
  uri: `file://event/common.emevd.dcx#event/${965104 + index}`,
  sourceUri: 'file://event/common.emevd.dcx',
  eventId: 965104 + index,
  sourceHash: 'a'.repeat(64),
  outerFileHash: 'b'.repeat(64),
  sourceRevision: 123,
  instructionCount: 2
}));

const fullPage = await makeSearchBridge({
  query: 'AwardItemLot',
  matches: twentyMatches,
  total: 20,
  totalCount: 20,
  offset: 0,
  limit: 20,
  returned: 20,
  returnedCount: 20,
  truncated: true,
  nextCursor: 'event-cursor-offset-20',
  scope: 'selected-file',
  complete: true,
  negativeConclusionAllowed: false,
  scannedFiles: ['event/common.emevd.dcx']
}).executeTool({
  id: 'events-page-20',
  name: 'search_events',
  argumentsJson: JSON.stringify({ query: 'AwardItemLot', limit: 20 })
});

assert.equal(fullPage.ok, true, fullPage.content);
assert.ok(fullPage.content.length <= MAX_BOUNDED_TOOL_RESULT_CHARS);
const fullPageEnvelope = JSON.parse(fullPage.content) as {
  data?: { record?: { matches?: unknown[] } };
  pagination?: { returnedCount?: number; offset?: number; truncated?: boolean; cursors?: Record<string, string> };
};
assert.equal(fullPageEnvelope.data?.record?.matches?.length, 20, 'primary event candidates must not be dropped by the bridge');
assert.equal(fullPageEnvelope.pagination?.returnedCount, 20);
assert.equal(fullPageEnvelope.pagination?.offset, 0);
assert.equal(fullPageEnvelope.pagination?.truncated, true);
assert.ok(fullPage.content.includes('event-cursor-offset-20'), 'the producer cursor must survive after the complete current page');
assert.equal((fullPageEnvelope.data?.record?.matches?.[0] as Record<string, unknown>)?.eventId, 965104);
assert.equal((fullPageEnvelope.data?.record?.matches?.[0] as Record<string, unknown>)?.sourceHash, 'a'.repeat(64));
const scopedRecord = fullPageEnvelope.data?.record as Record<string, unknown> | undefined;
assert.equal(scopedRecord?.scope, 'selected-file');
assert.equal(scopedRecord?.complete, true);
assert.equal(scopedRecord?.negativeConclusionAllowed, false);
assert.deepEqual(scopedRecord?.scannedFiles, ['event/common.emevd.dcx']);

const nestedInstructions = Array.from({ length: 20 }, (_, index) => ({
  score: 20 - index,
  item: {
    uri: `file://event/common.emevd.dcx#event/${970000 + index}`,
    sourceUri: 'file://event/common.emevd.dcx',
    eventId: 970000 + index,
    instructions: Array.from({ length: 12 }, (_item, instructionIndex) => ({
      index: instructionIndex,
      name: instructionIndex === 11 ? 'AwardItemLot' : 'IFConditionGroup'
    }))
  }
}));
const nested = await makeSearchBridge({
  query: 'nested-instructions',
  matches: nestedInstructions,
  total: 20,
  totalCount: 20,
  offset: 0,
  limit: 20,
  returned: 20,
  returnedCount: 20,
  truncated: false
}).executeTool({
  id: 'events-nested-primary',
  name: 'search_events',
  argumentsJson: JSON.stringify({ query: 'nested-instructions', limit: 20 })
});
assert.equal(nested.ok, true, nested.content);
const nestedEnvelope = JSON.parse(nested.content) as {
  data?: { record?: { matches?: Array<{ item?: { uri?: string; instructions?: unknown[] } }> } };
};
assert.equal(nestedEnvelope.data?.record?.matches?.length, 20, 'nested instruction summaries must not truncate primary candidates');
assert.equal(nestedEnvelope.data?.record?.matches?.[19]?.item?.uri, 'file://event/common.emevd.dcx#event/970019');
assert.ok((nestedEnvelope.data?.record?.matches?.[0]?.item?.instructions?.length ?? 0) <= 12);

const newlyAdmittedDiscovery = await makeSearchBridge({
  query: 'too-wide',
  matches: Array.from({ length: 20 }, (_, index) => ({
    item: {
      uri: `file://event/too-wide#${index}`,
      sourceUri: 'file://event/too-wide',
      eventId: index,
      body: 'candidate detail '.repeat(900)
    }
  })),
  total: 40,
  totalCount: 40,
  offset: 0,
  limit: 20,
  returned: 20,
  returnedCount: 20,
  truncated: true,
  nextCursor: 'too-wide-next'
}).executeTool({
  id: 'events-new-budget',
  name: 'search_events',
  argumentsJson: JSON.stringify({ query: 'too-wide', limit: 20 })
});
assert.equal(newlyAdmittedDiscovery.ok, true, newlyAdmittedDiscovery.content);
assert.ok(Buffer.byteLength(newlyAdmittedDiscovery.content, 'utf8') > 32_768);
assert.ok(Buffer.byteLength(newlyAdmittedDiscovery.content, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES);
assert.ok(newlyAdmittedDiscovery.content.length <= MAX_BOUNDED_TOOL_RESULT_CHARS);
const newlyAdmittedEnvelope = JSON.parse(newlyAdmittedDiscovery.content) as {
  data?: { record?: { matches?: Array<{ item?: { uri?: string } }> } };
  pagination?: { cursors?: Record<string, string>; truncated?: boolean };
};
assert.equal(newlyAdmittedEnvelope.data?.record?.matches?.length, 20);
assert.equal(newlyAdmittedEnvelope.data?.record?.matches?.[19]?.item?.uri, 'file://event/too-wide#19');
assert.equal(newlyAdmittedEnvelope.pagination?.truncated, true);
assert.ok(newlyAdmittedDiscovery.content.includes('too-wide-next'));

const beyondBudgetDiscovery = await makeSearchBridge({
  query: 'beyond-budget',
  matches: Array.from({ length: 40 }, (_, index) => ({
    item: {
      uri: `file://event/beyond-budget#${index}`,
      sourceUri: 'file://event/beyond-budget',
      eventId: index,
      body: 'candidate detail '.repeat(900)
    }
  })),
  total: 80,
  totalCount: 80,
  offset: 0,
  limit: 40,
  returned: 40,
  returnedCount: 40,
  truncated: true,
  nextCursor: 'beyond-budget-next'
}).executeTool({
  id: 'events-beyond-budget',
  name: 'search_events',
  argumentsJson: JSON.stringify({ query: 'beyond-budget', limit: 40 })
});
assert.equal(beyondBudgetDiscovery.ok, false);
assert.equal(beyondBudgetDiscovery.code, 'RESULT_DISCOVERY_WINDOW_TOO_LARGE');
const oversizedEnvelope = JSON.parse(beyondBudgetDiscovery.content) as {
  error?: { details?: Record<string, unknown> };
};
const oversizedDetails = oversizedEnvelope.error?.details ?? {};
assert.equal((oversizedDetails.retry as Record<string, unknown>)?.limit, 20);
assert.equal(oversizedDetails.nextPageCursor, 'beyond-budget-next');

const referenceRegistry = new ToolRegistry();
referenceRegistry.register({
  name: 'find_references',
  description: 'synthetic oversized reference page',
  permission: 'read',
  permissionLevel: 'read',
  run: async () => ({
    ok: true as const,
    state: 'completed' as const,
    data: {
      query: 'AwardItemLot',
      relations: Array.from({ length: 40 }, (_, index) => ({
        relationId: `relation-${index}`,
        content: { text: 'x'.repeat(2_000) }
      })),
      page: { returnedCount: 40, hasMore: true, nextCursor: 'page-next-cursor' },
      scan: {
        sourceCursor: 'scan-source-cursor',
        nextAction: { tool: 'find_references', args: { sourceCursor: 'scan-source-cursor' } }
      }
    }
  })
});
const referenceBridge = createAgentToolBridge({
  registry: referenceRegistry,
  context: { workspaceIndex: null, mode: 'normal' }
});
const referenceResult = await referenceBridge.executeTool({
  id: 'reference-page-overflow',
  name: 'find_references',
  argumentsJson: JSON.stringify({ query: 'AwardItemLot', cursor: 'current-page-cursor', limit: 40 })
});
assert.equal(referenceResult.ok, false);
assert.equal(referenceResult.code, 'RESULT_REFERENCE_PAGE_TOO_LARGE');
const referenceEnvelope = JSON.parse(referenceResult.content) as {
  error?: { details?: Record<string, unknown> };
};
const referenceDetails = referenceEnvelope.error?.details ?? {};
assert.equal((referenceDetails.retry as Record<string, unknown>)?.cursor, 'current-page-cursor');
assert.equal((referenceDetails.retry as Record<string, unknown>)?.limit, 40);
assert.equal(referenceDetails.pageNextCursor, 'page-next-cursor');
assert.equal(referenceDetails.scanSourceCursor, 'scan-source-cursor');
assert.ok(referenceDetails.scanNextAction);
assert.equal('nextCursor' in referenceDetails, false, 'overflow must not expose a cursor that skips the undelivered page');

console.log(JSON.stringify({ ok: true, checks: 15, message: 'Agent bridge primary pagination preservation smoke passed' }));
