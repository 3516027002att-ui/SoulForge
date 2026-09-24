import assert from 'node:assert/strict';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { ToolRegistry } from '../ai/toolRegistry.js';
import { metadataPage } from '../ai/metadataPage.js';

const items = Array.from({ length: 15 }, (_, i) => ({ fieldId: `field${i}`, description: '字段'.repeat(20) }));
const options = { items, scope: { workspace: 'a', table: 'NpcParam' }, sourceHash: 'a', domain: 'param' as const, limit: 12 };
let page = metadataPage(options);
const delivered = [...page.items];
while (page.nextCursor) { page = metadataPage({ ...options, cursor: page.nextCursor }); delivered.push(...page.items); }
assert.deepEqual(delivered, items);
assert.throws(() => metadataPage({ ...options, cursor: metadataPage(options).nextCursor!, sourceHash: 'b' }), /改变/);
assert.throws(() => metadataPage({ ...options, cursor: metadataPage(options).nextCursor!, scope: { workspace: 'b' } }), /不匹配/);

const registry = new ToolRegistry();
registry.register({ name: 'resolve_entity', description: 'candidate transport regression', permission: 'read', run: () => ({ ok: true, data: {
  status: 'ambiguous', query: '鬼刑部', candidates: Array.from({ length: 6 }, (_, i) => ({
    candidateId: `param://NpcParam/${i}`, domain: 'param', label: '鬼形部'.repeat(50),
    sourceUri: 'file://param/gameparam.parambnd.dcx', sourceSnapshot: { sourceHash: 'a'.repeat(64) },
    evidence: [{ kind: 'index', detail: '证据'.repeat(300) }]
  })), candidateSet: [], coverage: { status: 'partial' }, nextReadPlan: []
} }) });
const bridge = createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'plan' } });
const result = await bridge.executeTool({ id: 'candidate', name: 'resolve_entity', argumentsJson: '{}' });
const envelope = JSON.parse(result.content);
assert.equal(envelope.evidence.status, 'candidate');
assert.ok(envelope.data.record?.candidates?.length > 0, result.content);
assert.ok(!envelope.evidence.nextActions.some((x: string) => x.includes('没有命中')));
assert.equal(envelope.pagination.deliveryTruncated, envelope.truncated);
assert.notEqual(envelope.completeness, 'complete');
assert.ok(Buffer.byteLength(result.content) <= 8192);
for (const tool of ['analyze_luabnd_script', 'search_param_fields']) {
  const text = '保留完整条件或字段描述'.repeat(50);
  const rows = tool === 'analyze_luabnd_script'
    ? { items: [{ conditionText: text }] }
    : { fields: [{ fieldId: 'hp', description: text }] };
  registry.register({ name: tool, description: 'lossless metadata window', permission: 'read', run: () => ({ ok: true, data: {
    ...rows, total: 1, returned: 1, offset: 0, limit: 1, truncated: false,
    sourceUri: 'file://fixture', sourceHash: 'a'.repeat(64)
  } }) });
  const b = createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'plan' } });
  const r = await b.executeTool({ id: tool, name: tool, argumentsJson: '{}' });
  const metadataEnvelope = JSON.parse(r.content);
  assert.equal(metadataEnvelope.evidence.status, 'candidate');
  const data = metadataEnvelope.data.record;
  assert.equal(tool === 'analyze_luabnd_script' ? data.items[0].conditionText : data.fields[0].description, text);
}
let hugeTae = false;
registry.register({ name: 'analyze_tae_structure', description: 'TAE metadata transport', permission: 'read', run: () => ({ ok: true, data: {
  filePath: 'C:\\private-mod\\chr\\c0000.anibnd.dcx', sourceHash: 'a'.repeat(64),
  events: [{ address: 'c0000#A0001.e0', animId: 1, parameterBytesHex: hugeTae ? 'ab'.repeat(20000) : 'ab'.repeat(300) }],
  pagination: { offset: 0, returnedCount: 1, totalCount: 1, hasMore: false, pageSize: 1 }
} }) });
const taeBridge = createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'plan' } });
const tae = await taeBridge.executeTool({ id: 'tae', name: 'analyze_tae_structure', argumentsJson: '{"file":"chr/c0000.anibnd.dcx","pageSize":1}' });
assert.doesNotMatch(tae.content, /private-mod/);
assert.equal(JSON.parse(tae.content).data.record.events[0].parameterBytesHex.length, 600);
hugeTae = true;
const oversizedTae = await taeBridge.executeTool({ id: 'tae-large', name: 'analyze_tae_structure', argumentsJson: '{"file":"chr/c0000.anibnd.dcx","pageSize":1}' });
assert.equal(oversizedTae.ok, false);
assert.equal(JSON.parse(oversizedTae.content).error.code, 'RESULT_METADATA_WINDOW_TOO_LARGE');
console.log('Tool workflow repair smoke passed.');

