/**
 * Synthetic contract smoke for the Agent-facing EMEVD tools.
 *
 * This intentionally does not start the Bridge or read a game file. It proves
 * the model schema and handler gates while the core readEmevdEvent facade may
 * be supplied by another checkout/agent; it must never claim native success.
 */
import assert from 'node:assert/strict';
import {
  createDefaultToolRegistry,
  ToolRegistry,
  type ToolContext,
  validateToolInput
} from '../ai/toolRegistry.js';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';

const registry = createDefaultToolRegistry();
const bridge = createAgentToolBridge({
  registry,
  context: { workspaceIndex: null, mode: 'normal' }
});
const toolMap = new Map(bridge.tools.map((tool) => [tool.name, tool]));

const eventTool = toolMap.get('read_emevd_event');
assert.ok(eventTool, 'read_emevd_event must be advertised');
assert.equal(eventTool.permissionLevel, 'read');
assert.equal(eventTool.supportsParallel, true);
const eventSchema = eventTool.parametersJsonSchema as {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};
assert.deepEqual(eventSchema.properties?.file, { type: 'string' });
assert.deepEqual(eventSchema.properties?.eventId, {
  type: 'integer',
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER
});
assert.deepEqual(eventSchema.properties?.format, {
  type: 'string',
  enum: ['darkscript', 'json']
});
assert.deepEqual(eventSchema.properties?.instructionOffset, {
  type: 'integer',
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER
});
assert.deepEqual(eventSchema.properties?.instructionLimit, {
  type: 'integer',
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER
});
assert.deepEqual(eventSchema.required, ['file', 'eventId']);
assert.match(eventTool.description, /DarkScript/iu);
assert.match(eventTool.description, /provenance/iu);

const applyTool = toolMap.get('apply_emevd_dsl');
assert.ok(applyTool, 'apply_emevd_dsl must be advertised');
const applySchema = applyTool.parametersJsonSchema as {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};
assert.deepEqual(applySchema.properties?.eventId, {
  type: 'integer',
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER
});
assert.deepEqual(applySchema.properties?.scope, {
  type: 'string',
  enum: ['file', 'event']
});
assert.deepEqual(applySchema.properties?.sourceHash, { type: 'string' });
assert.deepEqual(applySchema.properties?.outerFileHash, { type: 'string' });
assert.deepEqual(applySchema.properties?.sourceRevision, { type: 'number' });
assert.deepEqual(applySchema.properties?.darkScriptComplete, { type: 'boolean' });
assert.deepEqual(applySchema.required, ['file', 'dsl']);
assert.match(applyTool.description, /完整文件模式/iu);
assert.match(applyTool.description, /event-only/iu);

assert.equal(validateToolInput({ eventId: 'safe-integer' }, { eventId: Number.MAX_SAFE_INTEGER }).ok, true);
assert.equal(validateToolInput({ eventId: 'safe-integer' }, { eventId: Number.MAX_SAFE_INTEGER + 1 }).ok, false);
assert.equal(validateToolInput({ eventId: 'safe-integer' }, { eventId: 1.5 }).ok, false);

const syntheticContext: ToolContext = { workspaceIndex: null, mode: 'normal' };
const readInvalidInputs: unknown[] = [
  { file: 'event/common.emevd.dcx', eventId: 1.5 },
  { file: 'event/common.emevd.dcx', eventId: Number.MAX_SAFE_INTEGER + 1 },
  { file: 'event/common.emevd.dcx', eventId: 1, format: 'yaml' }
];
for (const input of readInvalidInputs) {
  const result = await registry.run('read_emevd_event', input, syntheticContext);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_INPUT');
}
const validReadWithoutSession = await registry.run(
  'read_emevd_event',
  { file: 'event/common.emevd.dcx', eventId: 1, format: 'json' },
  syntheticContext
);
assert.equal(validReadWithoutSession.ok, false);
assert.equal(validReadWithoutSession.error?.code, 'WORKSPACE_REQUIRED');

const applyInvalidInputs: unknown[] = [
  { file: 'event/common.emevd.dcx', dsl: 'event 1 {}', scope: 'event' },
  { file: 'event/common.emevd.dcx', dsl: 'event 1 {}', scope: 'file', eventId: 1 },
  { file: 'event/common.emevd.dcx', dsl: 'event 1 {}', scope: 'event', eventId: 1.5 },
  { file: 'event/common.emevd.dcx', dsl: 'event 1 {}', scope: 'invalid' }
];
for (const input of applyInvalidInputs) {
  const result = await registry.run('apply_emevd_dsl', input, syntheticContext);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_INPUT');
}
const missingEventReadReceipt = await registry.run(
  'apply_emevd_dsl',
  { file: 'event/common.emevd.dcx', dsl: '$Event(1, Restart, function() {\n});', scope: 'event', eventId: 1 },
  syntheticContext
);
assert.equal(missingEventReadReceipt.ok, false);
assert.equal(missingEventReadReceipt.error?.code, 'EMEVD_DSL_READ_RECEIPT_REQUIRED');
const validFileApplyWithoutSession = await registry.run(
  'apply_emevd_dsl',
  { file: 'event/common.emevd.dcx', dsl: 'event 1 {}', scope: 'file' },
  syntheticContext
);
assert.equal(validFileApplyWithoutSession.ok, false);
assert.equal(validFileApplyWithoutSession.error?.code, 'WORKSPACE_REQUIRED');

const bridgedInvalidRead = await bridge.executeTool({
  id: 'synthetic-invalid-read',
  name: 'read_emevd_event',
  argumentsJson: JSON.stringify({ file: 'event/common.emevd.dcx', eventId: 1.5 })
});
assert.equal(bridgedInvalidRead.ok, false);
assert.equal(bridgedInvalidRead.code, 'INVALID_INPUT');
assert.match(bridgedInvalidRead.content, /INVALID_INPUT/iu);

// The bridge has an 8 KiB byte budget for discovery-shaped tools.  An event
// read must not inherit the generic "first six array items" projection: an
// actionable instruction can be at the end of the requested event window.
const boundedEventRegistry = new ToolRegistry();
const boundedEventInstructions = Array.from({ length: 20 }, (_, index) => ({
  index,
  bank: 2003,
  id: index === 18 ? 11 : 0,
  argsBase64: 'A'.repeat(520),
  unknown: false,
  emedfName: index === 18 ? 'DisplayBossHealthBar' : `SyntheticInstruction${index}`,
  typedArgs: [{
    name: index === 18 ? 'Entity ID' : 'Value',
    type: 2,
    value: index === 18 ? 1100800 : index,
    parameterSymbol: index === 18 ? 'entityId' : undefined
  }],
  diagnostics: []
}));
boundedEventRegistry.register({
  name: 'read_emevd_event',
  description: 'synthetic bounded event read',
  permission: 'read',
  permissionLevel: 'read',
  inputSchema: {},
  run: async () => ({
    ok: true as const,
    data: {
      ok: true,
      sourceUri: 'file:///synthetic/common.emevd.dcx',
      sourcePath: 'synthetic/common.emevd.dcx',
      filePath: 'synthetic/common.emevd.dcx',
      eventId: 11105810,
      restBehavior: 1,
      instructionCount: 20,
      total: 20,
      offset: 0,
      limit: 20,
      returned: 20,
      truncated: false,
      darkScriptComplete: true,
      format: 'darkscript',
      darkScript: '$Event(11105810, Restart, function() {\n  DisplayBossHealthBar(1, 1100800, 0, 905081);\n});',
      instructions: boundedEventInstructions,
      game: 'sekiro',
      resourceKind: 'event',
      diagnostics: []
    }
  })
});
const boundedEventBridge = createAgentToolBridge({
  registry: boundedEventRegistry,
  context: { workspaceIndex: null, mode: 'normal' }
});
const boundedEventResult = await boundedEventBridge.executeTool({
  id: 'synthetic-bounded-event',
  name: 'read_emevd_event',
  argumentsJson: '{}'
});
assert.equal(boundedEventResult.ok, true);
const boundedEventEnvelope = JSON.parse(boundedEventResult.content) as {
  data?: { record?: { instructions?: Array<{ index?: number; emedfName?: string }> } };
  pagination?: { truncated?: boolean };
};
const visibleBoundedInstructions = boundedEventEnvelope.data?.record?.instructions;
assert.equal(visibleBoundedInstructions?.length, 20);
assert.equal(visibleBoundedInstructions?.find((instruction) => instruction.index === 18)?.emedfName, 'DisplayBossHealthBar');
assert.equal(boundedEventEnvelope.pagination?.truncated, false);

console.log(JSON.stringify({
  ok: true,
  native: false,
  mode: 'synthetic-no-native-bridge',
  message: 'EMEVD Agent 工具 schema 与输入门禁 smoke 通过；未声明 native 读取成功。'
}, null, 2));
