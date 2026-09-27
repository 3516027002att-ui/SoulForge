import { strict as assert } from 'node:assert';
import { ToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import {
  MAX_BOUNDED_TOOL_RESULT_BYTES,
  MAX_BOUNDED_TOOL_RESULT_CHARS,
  createAgentToolBridge
} from '../ai/agentToolBridge.js';
import type { NativeReadProofStore } from '../editing/nativeReadProofStore.js';

function makeBridge(
  name: 'read_hks_script' | 'search_hks_script',
  data: Record<string, unknown>,
  context: ToolContext = { workspaceIndex: null, mode: 'normal' }
) {
  const registry = new ToolRegistry();
  registry.register({
    name,
    description: `synthetic ${name}`,
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: name === 'read_hks_script'
      ? { file: 'string', sourceOffset: 'safe-integer?', sourceLimit: 'safe-integer?', cursor: 'string?' }
      : { file: 'string', query: 'string', cursor: 'string?', limit: 'safe-integer?' },
    run: async () => ({ ok: true as const, state: 'completed' as const, data })
  });
  return createAgentToolBridge({
    registry,
    context
  });
}

const sourceText = Array.from({ length: 36 }, (_, index) => `Action_${index}(\"target_${index}\")`).join('\n');
const read = await makeBridge('read_hks_script', {
  sourceUri: 'workspace://active/action/script/c0000_transition.hks',
  sourceHash: 'hks-source-hash',
  outerFileHash: 'hks-outer-hash',
  sourceText,
  sourceTextComplete: false,
  sourceOffset: 0,
  sourceLimit: sourceText.length,
  offset: 0,
  limit: sourceText.length,
  total: sourceText.length + 40,
  nextCursor: 'hks-source-cursor'
}).executeTool({
  id: 'hks-read',
  name: 'read_hks_script',
  argumentsJson: JSON.stringify({ file: 'action/script/c0000_transition.hks', sourceLimit: sourceText.length })
});
assert.equal(read.ok, true, read.content);
assert.ok(read.content.length <= MAX_BOUNDED_TOOL_RESULT_CHARS);
const readEnvelope = JSON.parse(read.content) as {
  data?: { record?: Record<string, unknown> };
  evidence?: { status?: string; sourceHashes?: string[]; nextActions?: string[] };
  completeness?: string;
};
assert.equal(readEnvelope.data?.record?.sourceText, sourceText, 'HKS source windows must not become a 420-char discovery excerpt');
assert.equal(readEnvelope.data?.record?.sourceTextComplete, false);
assert.equal(readEnvelope.evidence?.status, 'native-verified');
assert.deepEqual(readEnvelope.evidence?.sourceHashes, ['hks-source-hash']);
assert.match(readEnvelope.evidence?.nextActions?.[0] ?? '', /只读核对/u);
assert.doesNotMatch(readEnvelope.evidence?.nextActions?.[0] ?? '', /写入前/u);

const acceptedReads: unknown[] = [];
const proofStore: NativeReadProofStore = {
  acceptDeliveredRead: (value) => acceptedReads.push(value),
  requireCoverage: () => { throw new Error('not used'); },
  invalidateSource: () => undefined,
  invalidateAll: () => undefined,
  dispose: () => undefined
};
const readOnlyBridge = await makeBridge('read_hks_script', {
  sourceUri: 'workspace://active/action/script/complete.hks',
  sourceHash: 'complete-hks-hash',
  outerFileHash: 'complete-hks-outer-hash',
  sourceText: 'Action_Complete(target)',
  sourceTextComplete: true,
  sourceOffset: 0,
  sourceLimit: 24,
  total: 24
}, {
  workspaceIndex: { workspaceId: 'workspace-hks-test' } as never,
  mode: 'normal',
  nativeReadProofs: proofStore
}).executeTool({
  id: 'hks-read-only-proof',
  name: 'read_hks_script',
  argumentsJson: JSON.stringify({ file: 'action/script/complete.hks', sourceLimit: 24 })
});
assert.equal(readOnlyBridge.ok, true, readOnlyBridge.content);
assert.equal(acceptedReads.length, 0, 'HKS source hash must remain read-only and never mint a writer receipt');

const withinBudgetSourceText = 'local source window = true\n'.repeat(800);
const withinBudget = await makeBridge('read_hks_script', {
  sourceUri: 'workspace://active/action/script/within-budget.hks',
  sourceHash: 'within-budget-hks-hash',
  sourceText: withinBudgetSourceText,
  sourceTextComplete: true,
  sourceOffset: 0,
  sourceLimit: withinBudgetSourceText.length,
  total: withinBudgetSourceText.length
}).executeTool({
  id: 'hks-read-within-budget',
  name: 'read_hks_script',
  argumentsJson: JSON.stringify({ file: 'action/script/within-budget.hks', sourceLimit: withinBudgetSourceText.length })
});
assert.equal(withinBudget.ok, true, withinBudget.content);
const withinBudgetEnvelope = JSON.parse(withinBudget.content) as {
  data?: { record?: { sourceText?: unknown } };
};
assert.equal(withinBudgetEnvelope.data?.record?.sourceText, withinBudgetSourceText);
const PREVIOUS_TOOL_RESULT_BUDGET_BYTES = 8_192; // budget before the increase to MAX_BOUNDED_TOOL_RESULT_BYTES
const withinBudgetBytes = Buffer.byteLength(withinBudget.content, 'utf8');
assert.ok(withinBudgetBytes > PREVIOUS_TOOL_RESULT_BUDGET_BYTES, 'exercise HKS data admitted only by the raised budget');
assert.ok(withinBudgetBytes <= MAX_BOUNDED_TOOL_RESULT_BYTES);
assert.ok(withinBudget.content.length <= MAX_BOUNDED_TOOL_RESULT_CHARS);

const oversizedSourceText = 'local huge source = true\n'.repeat(1_500);
const oversizedSourceLimit = oversizedSourceText.length;
const newlyAdmitted = await makeBridge('read_hks_script', {
  sourceUri: 'workspace://active/action/script/huge.hks',
  sourceHash: 'huge-hks-hash',
  sourceText: oversizedSourceText,
  sourceTextComplete: true,
  sourceOffset: 0,
  sourceLimit: oversizedSourceLimit,
  total: oversizedSourceLimit
}).executeTool({
  id: 'hks-read-new-budget',
  name: 'read_hks_script',
  argumentsJson: JSON.stringify({ file: 'action/script/huge.hks', sourceLimit: oversizedSourceLimit })
});
assert.equal(newlyAdmitted.ok, true, newlyAdmitted.content);
const newlyAdmittedEnvelope = JSON.parse(newlyAdmitted.content) as {
  data?: { record?: { sourceText?: unknown } };
};
assert.equal(newlyAdmittedEnvelope.data?.record?.sourceText, oversizedSourceText);
assert.ok(Buffer.byteLength(newlyAdmitted.content, 'utf8') > 32_768);
assert.ok(Buffer.byteLength(newlyAdmitted.content, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES);
assert.ok(newlyAdmitted.content.length <= MAX_BOUNDED_TOOL_RESULT_CHARS);

const beyondBudgetSourceText = 'local beyond budget = true\n'.repeat(3_000);
const beyondBudgetSourceLimit = beyondBudgetSourceText.length;
const tooLarge = await makeBridge('read_hks_script', {
  sourceUri: 'workspace://active/action/script/beyond-budget.hks',
  sourceHash: 'beyond-budget-hks-hash',
  sourceText: beyondBudgetSourceText,
  sourceTextComplete: false,
  sourceOffset: 0,
  sourceLimit: beyondBudgetSourceLimit,
  total: beyondBudgetSourceLimit,
  nextCursor: 'beyond-budget-next'
}).executeTool({
  id: 'hks-read-too-large',
  name: 'read_hks_script',
  argumentsJson: JSON.stringify({ file: 'action/script/beyond-budget.hks', sourceLimit: beyondBudgetSourceLimit })
});
assert.equal(tooLarge.ok, false);
assert.equal(tooLarge.code, 'RESULT_SCRIPT_WINDOW_TOO_LARGE');
const tooLargeEnvelope = JSON.parse(tooLarge.content) as { error?: { details?: Record<string, unknown> } };
assert.equal((tooLargeEnvelope.error?.details?.retry as Record<string, unknown>)?.sourceLimit, Math.floor(beyondBudgetSourceLimit / 2));

const search = await makeBridge('search_hks_script', {
  sourceUri: 'workspace://active/action/script/c0000_transition.hks',
  sourceHash: 'hks-search-hash',
  matches: Array.from({ length: 6 }, (_, index) => ({
    sourceOffset: index * 20,
    matchOffset: index * 20 + 4,
    line: index + 1,
    snippet: `Action_${index}(target_${index})`,
    readAction: {
      tool: 'read_hks_script',
      args: { file: 'workspace://active/action/script/c0000_transition.hks', sourceOffset: index * 20, sourceLimit: 2400 }
    }
  })),
  returned: 6,
  returnedCount: 6,
  limit: 6,
  truncated: true,
  nextCursor: 'hks-search-cursor',
  searchComplete: false,
  hasMore: true,
  scan: { offset: 0, nextOffset: 124, complete: false }
}).executeTool({
  id: 'hks-search',
  name: 'search_hks_script',
  argumentsJson: JSON.stringify({ file: 'action/script/c0000_transition.hks', query: 'Action_', limit: 6 })
});
assert.equal(search.ok, true, search.content);
assert.ok(search.content.length <= MAX_BOUNDED_TOOL_RESULT_CHARS);
const searchEnvelope = JSON.parse(search.content) as {
  data?: { record?: { matches?: Array<Record<string, unknown>>; searchComplete?: boolean; hasMore?: boolean; scan?: Record<string, unknown> } };
  pagination?: { truncated?: boolean; cursors?: Record<string, string> };
};
assert.equal(searchEnvelope.data?.record?.matches?.length, 6);
assert.equal(searchEnvelope.data?.record?.searchComplete, false);
assert.equal(searchEnvelope.data?.record?.hasMore, true);
assert.deepEqual(searchEnvelope.data?.record?.scan, { offset: 0, nextOffset: 124, complete: false });
const firstMatch = searchEnvelope.data?.record?.matches?.[0];
assert.equal(firstMatch?.sourceOffset, 0);
assert.equal(firstMatch?.matchOffset, 4);
assert.equal(firstMatch?.line, 1);
assert.equal(firstMatch?.snippet, 'Action_0(target_0)');
assert.deepEqual(firstMatch?.readAction, {
  tool: 'read_hks_script',
  args: { file: 'workspace://active/action/script/c0000_transition.hks', sourceOffset: 0, sourceLimit: 2400 }
});
assert.equal(searchEnvelope.pagination?.truncated, true);
assert.ok(search.content.includes('hks-search-cursor'));

console.log(JSON.stringify({ ok: true, checks: 24, message: 'Agent bridge HKS source/search smoke passed' }));
