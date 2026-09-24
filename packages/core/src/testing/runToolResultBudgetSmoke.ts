import assert from 'node:assert/strict';
import { createAgentToolBridge, MAX_BOUNDED_TOOL_RESULT_BYTES } from '../ai/agentToolBridge.js';
import { ToolRegistry } from '../ai/toolRegistry.js';

const fields = Array.from({ length: 20 }, (_, index) => ({
  table: 'SpEffectParam', rowId: 9025, rowIndex: 2950, fieldId: `field${index}`,
  value: index, dataHash: 'd'.repeat(64), sourceHash: 's'.repeat(64), sourceRevision: 1,
  description: '原生字段含义必须保留。'.repeat(12)
}));
const registry = new ToolRegistry();
registry.register({ name: 'read_param_fields', description: 'wide native field fixture', permission: 'read',
  run: () => ({ ok: true, data: { fields, pagination: { offset: 0, returnedCount: 20, totalCount: 20, pageSize: 32, hasMore: false } } }) });
const bridge = createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'plan' } });
const result = await bridge.executeTool({ id: 'wide', name: 'read_param_fields', argumentsJson: '{}' });
assert.equal(result.ok, true, result.content);
const envelope = JSON.parse(result.content);
assert.deepEqual(envelope.data.record.fields, fields);
assert.ok(Buffer.byteLength(result.content, 'utf8') > 8192, 'exercise the previous rejected range');
assert.ok(Buffer.byteLength(result.content, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES);
assert.equal(MAX_BOUNDED_TOOL_RESULT_BYTES, 32768);
console.log('32 KiB native tool result budget smoke passed.');
