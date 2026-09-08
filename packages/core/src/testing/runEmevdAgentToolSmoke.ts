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
const evidenceSession = {
  meta: {
    workspaceId: 'workspace://emevd-agent-envelope',
    game: 'sekiro',
    openedAt: '2026-01-01T00:00:00.000Z',
    baseMissing: true,
    layers: { overlayRoot: 'C:\\synthetic\\overlay' }
  }
} as unknown as NonNullable<ToolContext['session']>;
const nativeEnvelopeContext: ToolContext = {
  workspaceIndex: null,
  mode: 'normal',
  session: evidenceSession
};
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
      sourcePath: `C:\\合成\\事件\\${'长路径/'.repeat(600)}common.emevd.dcx`,
      filePath: `C:\\合成\\事件\\${'长路径/'.repeat(600)}common.emevd.dcx`,
      sourceHash: 'a'.repeat(64),
      outerFileHash: 'b'.repeat(64),
      sourceRevision: 1788456410220.5247,
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
  context: nativeEnvelopeContext
});
const boundedEventResult = await boundedEventBridge.executeTool({
  id: 'synthetic-bounded-event',
  name: 'read_emevd_event',
  argumentsJson: '{}'
});
assert.equal(boundedEventResult.ok, true);
const boundedEventEnvelope = JSON.parse(boundedEventResult.content) as {
  data?: {
    record?: {
      instructions?: Array<{ index?: number; emedfName?: string }>;
      sourcePath?: string;
      sourceHash?: string;
      outerFileHash?: string;
      sourceRevision?: number;
    };
  };
  pagination?: { truncated?: boolean };
};
const visibleBoundedInstructions = boundedEventEnvelope.data?.record?.instructions;
assert.equal(visibleBoundedInstructions?.length, 20);
assert.equal(visibleBoundedInstructions?.find((instruction) => instruction.index === 18)?.emedfName, 'DisplayBossHealthBar');
assert.equal(boundedEventEnvelope.data?.record?.sourceHash, 'a'.repeat(64));
assert.equal(boundedEventEnvelope.data?.record?.outerFileHash, 'b'.repeat(64));
assert.equal(boundedEventEnvelope.data?.record?.sourceRevision, 1788456410220.5247);
assert.equal(boundedEventEnvelope.pagination?.truncated, false);
assert.ok(Buffer.byteLength(boundedEventResult.content, 'utf8') <= 8_192);
assert.ok(boundedEventResult.content.length <= 8_192);

// Regression for the final-envelope fast path: the raw `{ok,state,data,evidence}`
// payload can fit while pagination/identifier/evidence envelope overhead pushes
// the actual response over budget. The bounded event projection must retain all
// requested instructions and drop only redundant raw argument bytes.
const edgeEnvelopeInstructions = Array.from({ length: 15 }, (_, index) => ({
  index,
  bank: 2003,
  id: index,
  unknown: false,
  emedfName: `SyntheticEdge${index}`,
  argsBase64: 'A'.repeat(100),
  typedArgs: [
    { name: 'Value', type: 2, value: index },
    { name: 'Entity ID', type: 's32', value: 1100000 + index, parameterSymbol: 'entityId' }
  ],
  diagnostics: []
}));
const edgeEnvelopeData = {
  ok: true,
  sourceUri: 'file:///synthetic/edge-envelope.emevd.dcx',
  sourcePath: 'synthetic/edge-envelope.emevd.dcx',
  filePath: 'synthetic/edge-envelope.emevd.dcx',
  eventId: 999,
  instructionCount: 15,
  total: 15,
  offset: 0,
  limit: 15,
  returned: 15,
  truncated: false,
  darkScriptComplete: true,
  format: 'darkscript',
  darkScript: '$Event(999, Restart, function() {\n' + '  X'.repeat(350) + '\n});',
  instructions: edgeEnvelopeInstructions,
  game: 'sekiro',
  resourceKind: 'event',
  diagnostics: []
};
const edgeEnvelopeRegistry = new ToolRegistry();
edgeEnvelopeRegistry.register({
  name: 'read_emevd_event',
  description: 'synthetic raw-under-budget envelope-over-budget event read',
  permission: 'read',
  permissionLevel: 'read',
  inputSchema: {},
  run: async () => ({ ok: true as const, data: edgeEnvelopeData })
});
const edgeEnvelopeBridge = createAgentToolBridge({
  registry: edgeEnvelopeRegistry,
  context: nativeEnvelopeContext
});
const edgeEnvelopeResult = await edgeEnvelopeBridge.executeTool({
  id: 'synthetic-edge-envelope',
  name: 'read_emevd_event',
  argumentsJson: '{}'
});
assert.equal(edgeEnvelopeResult.ok, true, edgeEnvelopeResult.content);
const edgeEnvelope = JSON.parse(edgeEnvelopeResult.content) as {
  data: { record: { instructions: Array<{ index?: number; argsBase64?: string }> } };
  evidence: unknown;
  pagination: { offset?: number; total?: number; returnedCount?: number; truncated?: boolean };
};
const rawEdgeBytes = Buffer.byteLength(JSON.stringify({
  ok: true,
  state: 'completed',
  data: edgeEnvelopeData,
  evidence: edgeEnvelope.evidence
}), 'utf8');
const oldFastPathBytes = Buffer.byteLength(JSON.stringify({
  ...edgeEnvelope,
  data: { ...edgeEnvelope.data, record: edgeEnvelopeData }
}), 'utf8');
assert.ok(rawEdgeBytes <= 8_192, `raw edge fixture must fit: ${rawEdgeBytes}`);
assert.ok(oldFastPathBytes > 8_192, `old fast path must overflow: ${oldFastPathBytes}`);
assert.equal(edgeEnvelope.data.record.instructions.length, 15);
assert.deepEqual(edgeEnvelope.data.record.instructions.map((item) => item.index), Array.from({ length: 15 }, (_, index) => index));
assert.equal(edgeEnvelope.data.record.instructions[0]?.argsBase64, undefined);
assert.equal(edgeEnvelope.pagination.offset, 0);
assert.equal(edgeEnvelope.pagination.total, 15);
assert.equal(edgeEnvelope.pagination.returnedCount, 15);
assert.equal(edgeEnvelope.pagination.truncated, false);
assert.ok(Buffer.byteLength(edgeEnvelopeResult.content, 'utf8') <= 8_192);
assert.ok(edgeEnvelopeResult.content.length <= 8_192);

// Regression fixture copied from the real rollout step-14 shape: the native
// page is only five instructions, but the complete typed result (DarkScript,
// provenance and layout metadata) is larger than the 8 KiB bridge budget.
// Evidence claims must remain a bounded semantic summary instead of copying
// the complete root JSON into claims[0].text; otherwise a usable page is
// rejected before the Agent can inspect the DSL and instruction names.
const step14EventInstructions = [
  {
    index: 0, bank: 3, id: 0, argsBase64: 'AQAAAITYJAE=', unknown: false, emedfName: 'IFEventFlag',
    typedArgs: [
      { name: 'resultConditionGroup', type: 's8', value: 1, startByte: 0, byteCount: 1 },
      { name: 'desiredFlagState', type: 'u8', value: 0, startByte: 1, byteCount: 1 },
      { name: 'targetEventFlagType', type: 'u8', value: 0, startByte: 2, byteCount: 1 },
      { name: 'targetEventFlagId', type: 's32', value: 19191940, startByte: 4, byteCount: 4 }
    ],
    diagnostics: []
  },
  {
    index: 1, bank: 3, id: 2, argsBase64: 'AQEAABAnAADguzIAAQAAAA==', unknown: false, emedfName: 'IFInOutsideArea',
    typedArgs: [
      { name: 'resultConditionGroup', type: 's8', value: 1 },
      { name: 'desiredState', type: 'u8', value: 1 },
      { name: 'targetEntityId', type: 's32', value: 10000 },
      { name: 'areaEntityId', type: 's32', value: 3324896 },
      { name: 'numberOfTargetCharacters', type: 's32', value: 1 }
    ],
    diagnostics: []
  },
  {
    index: 2, bank: 3, id: 4, argsBase64: 'AQMAACgjAAABAAAA', unknown: false, emedfName: 'IFPlayerHasDoesntHaveItem',
    typedArgs: [
      { name: 'resultConditionGroup', type: 's8', value: 1 },
      { name: 'itemType', type: 'u8', value: 3 },
      { name: 'itemId', type: 's32', value: 9000 },
      { name: 'desiredPossessionState', type: 'u8', value: 1 }
    ],
    diagnostics: []
  },
  {
    index: 3, bank: 0, id: 0, argsBase64: 'AAEBAA==', unknown: false, emedfName: 'IFConditionGroup',
    typedArgs: [
      { name: 'resultConditionGroup', type: 's8', value: 0 },
      { name: 'desiredConditionGroupState', type: 'u8', value: 1 },
      { name: 'targetConditionGroup', type: 's8', value: 1 }
    ],
    diagnostics: []
  },
  {
    index: 4, bank: 2004, id: 50, argsBase64: 'pssQANwAAAAAAAAA', unknown: false, emedfName: 'SetLockOnPoint',
    typedArgs: [
      { name: 'entityId', type: 's32', value: 1100710 },
      { name: 'lockOnDummypolyId', type: 's32', value: 220 },
      { name: 'desiredState', type: 'u8', value: 0 }
    ],
    diagnostics: []
  }
];
const step14EventRegistry = new ToolRegistry();
step14EventRegistry.register({
  name: 'read_emevd_event',
  description: 'synthetic real-shape EMEVD page',
  permission: 'read',
  permissionLevel: 'read',
  inputSchema: {},
  run: async () => ({
    ok: true as const,
    data: {
      ok: true,
      sourceUri: 'file:///synthetic/step14.emevd.dcx',
      sourcePath: 'C:\\synthetic\\overlay\\event\\step14.emevd.dcx',
      filePath: 'C:\\synthetic\\overlay\\event\\step14.emevd.dcx',
      eventId: 11000751,
      restBehavior: 1,
      instructionCount: 16,
      total: 16,
      offset: 0,
      limit: 5,
      returned: 5,
      truncated: true,
      darkScriptComplete: false,
      readRange: { start: 0, end: 5 },
      crossesBlockBoundary: true,
      blocks: [{ index: 0, start: 0, end: 7 }, { index: 1, start: 7, end: 8 }],
      sourceHash: 'd'.repeat(64),
      outerFileHash: 'e'.repeat(64),
      sourceRevision: 1788456410220.5247,
      game: 'sekiro',
      resourceKind: 'event',
      registryOrigin: 'imported',
      registryFingerprint: 'sha256:' + 'f'.repeat(64),
      format: 'darkscript',
      darkScript: '$Event(11000751, Restart, function() {\n  SetLockOnPoint(1100710, 220, 0);\n});',
      instructions: step14EventInstructions,
      diagnostics: [],
      provenance: {
        authority: 'native-emevd-event',
        sourceUri: 'file:///synthetic/step14.emevd.dcx',
        sourceHash: 'd'.repeat(64),
        sourceRevision: 1788456410220.5247,
        registryFingerprint: 'sha256:' + 'f'.repeat(64)
      }
    }
  })
});
const step14EventBridge = createAgentToolBridge({
  registry: step14EventRegistry,
  context: nativeEnvelopeContext
});
const step14EventResult = await step14EventBridge.executeTool({
  id: 'synthetic-step14-event',
  name: 'read_emevd_event',
  argumentsJson: '{}'
});
assert.equal(step14EventResult.ok, true, step14EventResult.content);
const step14EventEnvelope = JSON.parse(step14EventResult.content) as {
  data?: { record?: { instructions?: unknown[]; darkScript?: string } };
  evidence?: { claims?: Array<{ text?: string }> };
};
assert.equal(step14EventEnvelope.data?.record?.instructions?.length, 5);
assert.match(step14EventEnvelope.data?.record?.darkScript ?? '', /SetLockOnPoint/);
const step14ClaimText = step14EventEnvelope.evidence?.claims?.[0]?.text ?? '';
assert.ok(step14ClaimText.length > 0 && step14ClaimText.length <= 640, `claim text must be bounded: ${step14ClaimText.length}`);
assert.match(step14ClaimText, /DisplayBossHealthBar|SetLockOnPoint|IFEventFlag/);
assert.equal(step14ClaimText.includes('AQAAAITYJAE='), false);
assert.equal(step14ClaimText.includes('$Event(11000751'), false);

// A native event read is not allowed to degrade to `ok=true, record=null`
// when the complete requested instruction window cannot fit the Agent result
// budget.  The caller must receive an actionable failure and page explicitly.
const oversizedEventRegistry = new ToolRegistry();
const oversizedEventInstructions = Array.from({ length: 64 }, (_, index) => ({
  index,
  bank: 2003,
  id: index,
  unknown: false,
  emedfName: `SyntheticInstruction-${index}-${'x'.repeat(420)}`,
  typedArgs: [{ name: 'Value', type: 2, value: index }],
  diagnostics: []
}));
oversizedEventRegistry.register({
  name: 'read_emevd_event',
  description: 'synthetic oversized event read',
  permission: 'read',
  permissionLevel: 'read',
  inputSchema: {},
  run: async () => ({
    ok: true as const,
    data: {
      ok: true,
      sourceUri: 'file:///synthetic/oversized.emevd.dcx',
      sourcePath: 'synthetic/oversized.emevd.dcx',
      filePath: 'synthetic/oversized.emevd.dcx',
      eventId: 222,
      restBehavior: 1,
      instructionCount: oversizedEventInstructions.length,
      total: oversizedEventInstructions.length,
      offset: 0,
      limit: oversizedEventInstructions.length,
      returned: oversizedEventInstructions.length,
      truncated: false,
      darkScriptComplete: true,
      format: 'darkscript',
      darkScript: '$Event(222, Restart, function() {})',
      instructions: oversizedEventInstructions,
      game: 'sekiro',
      resourceKind: 'event',
      sourceHash: 'a'.repeat(64),
      outerFileHash: 'b'.repeat(64),
      sourceRevision: 1788456410220.5247,
      diagnostics: []
    }
  })
});
const oversizedEventBridge = createAgentToolBridge({
  registry: oversizedEventRegistry,
  context: nativeEnvelopeContext
});
const oversizedEventResult = await oversizedEventBridge.executeTool({
  id: 'synthetic-oversized-event',
  name: 'read_emevd_event',
  argumentsJson: JSON.stringify({
    file: 'event/synthetic.emevd.dcx',
    eventId: 222,
    format: 'darkscript',
    instructionOffset: 0,
    instructionLimit: 64
  })
});
assert.equal(oversizedEventResult.ok, false);
assert.equal(oversizedEventResult.code, 'RESULT_EVENT_WINDOW_TOO_LARGE');
const oversizedEventEnvelope = JSON.parse(oversizedEventResult.content) as {
  ok?: boolean;
  data?: { record?: unknown };
  error?: {
    code?: string;
    details?: {
      sourceUri?: string;
      sourcePath?: string;
      file?: string;
      sourceHash?: string;
      outerFileHash?: string;
      sourceRevision?: number;
      eventId?: number;
      instructionOffset?: number;
      instructionLimit?: number;
      requestedInstructionLimit?: number;
      suggestedInstructionLimit?: number;
      canReduceInstructionLimit?: boolean;
      retryFormat?: string;
      retryHint?: string;
      retry?: {
        file?: string;
        eventId?: number;
        format?: string;
        instructionOffset?: number;
        instructionLimit?: number;
      };
    };
  };
};
assert.equal(oversizedEventEnvelope.ok, false);
assert.equal(oversizedEventEnvelope.data, undefined);
assert.equal(oversizedEventEnvelope.error?.code, 'RESULT_EVENT_WINDOW_TOO_LARGE');
assert.equal(oversizedEventEnvelope.error?.details?.sourceUri, 'file:///synthetic/oversized.emevd.dcx');
assert.equal(oversizedEventEnvelope.error?.details?.sourcePath, 'synthetic/oversized.emevd.dcx');
assert.equal(oversizedEventEnvelope.error?.details?.file, 'event/synthetic.emevd.dcx');
assert.equal(oversizedEventEnvelope.error?.details?.sourceHash, 'a'.repeat(64));
assert.equal(oversizedEventEnvelope.error?.details?.outerFileHash, 'b'.repeat(64));
assert.equal(oversizedEventEnvelope.error?.details?.sourceRevision, 1788456410220.5247);
assert.equal(oversizedEventEnvelope.error?.details?.eventId, 222);
assert.equal(oversizedEventEnvelope.error?.details?.instructionOffset, 0);
assert.equal(oversizedEventEnvelope.error?.details?.instructionLimit, 64);
assert.equal(oversizedEventEnvelope.error?.details?.requestedInstructionLimit, 64);
assert.equal(oversizedEventEnvelope.error?.details?.suggestedInstructionLimit, 32);
assert.equal(oversizedEventEnvelope.error?.details?.canReduceInstructionLimit, true);
assert.equal(oversizedEventEnvelope.error?.details?.retry?.file, 'event/synthetic.emevd.dcx');
assert.equal(oversizedEventEnvelope.error?.details?.retry?.eventId, 222);
assert.equal(oversizedEventEnvelope.error?.details?.retry?.format, 'darkscript');
assert.equal(oversizedEventEnvelope.error?.details?.retry?.instructionLimit, 32);

// Even one DarkScript instruction can be too verbose. At limit=1 there is no
// smaller native window; the diagnostic must say so and offer JSON once,
// without creating an unbounded retry loop.
const minimumOversizedEventRegistry = new ToolRegistry();
minimumOversizedEventRegistry.register({
  name: 'read_emevd_event',
  description: 'synthetic minimum oversized event read',
  permission: 'read',
  permissionLevel: 'read',
  inputSchema: {},
  run: async () => ({
    ok: true as const,
    data: {
      ok: true,
      sourceUri: 'file:///synthetic/minimum.emevd.dcx',
      sourcePath: 'synthetic/minimum.emevd.dcx',
      filePath: 'synthetic/minimum.emevd.dcx',
      eventId: 333,
      instructionCount: 1,
      total: 1,
      offset: 0,
      limit: 1,
      returned: 1,
      truncated: false,
      darkScriptComplete: true,
      format: 'darkscript',
      darkScript: '$Event(333, Restart, function() {\n' + '  ' + 'X'.repeat(12_000) + '\n});',
      instructions: [{
        index: 0,
        bank: 2003,
        id: 0,
        unknown: false,
        emedfName: 'SyntheticMinimum',
        typedArgs: [{ name: 'Value', type: 2, value: 0 }],
        diagnostics: []
      }],
      game: 'sekiro',
      resourceKind: 'event',
      diagnostics: []
    }
  })
});
const minimumOversizedEventBridge = createAgentToolBridge({
  registry: minimumOversizedEventRegistry,
  context: nativeEnvelopeContext
});
const minimumOversizedEventResult = await minimumOversizedEventBridge.executeTool({
  id: 'synthetic-minimum-oversized-event',
  name: 'read_emevd_event',
  argumentsJson: JSON.stringify({
    file: 'event/minimum.emevd.dcx',
    eventId: 333,
    format: 'darkscript',
    instructionOffset: 0,
    instructionLimit: 1
  })
});
assert.equal(minimumOversizedEventResult.ok, false);
assert.equal(minimumOversizedEventResult.code, 'RESULT_EVENT_WINDOW_TOO_LARGE');
const minimumOversizedEnvelope = JSON.parse(minimumOversizedEventResult.content) as {
  error?: {
    code?: string;
    details?: {
      instructionLimit?: number;
      suggestedInstructionLimit?: number;
      canReduceInstructionLimit?: boolean;
      retryFormat?: string;
      retryHint?: string;
      retry?: { file?: string; eventId?: number; format?: string; instructionLimit?: number };
    };
  };
};
assert.equal(minimumOversizedEnvelope.error?.code, 'RESULT_EVENT_WINDOW_TOO_LARGE');
assert.equal(minimumOversizedEnvelope.error?.details?.instructionLimit, 1);
assert.equal(minimumOversizedEnvelope.error?.details?.suggestedInstructionLimit, 1);
assert.equal(minimumOversizedEnvelope.error?.details?.canReduceInstructionLimit, false);
assert.equal(minimumOversizedEnvelope.error?.details?.retryFormat, 'json');
assert.equal(minimumOversizedEnvelope.error?.details?.retry?.file, 'event/minimum.emevd.dcx');
assert.equal(minimumOversizedEnvelope.error?.details?.retry?.eventId, 333);
assert.equal(minimumOversizedEnvelope.error?.details?.retry?.format, 'json');
assert.match(minimumOversizedEnvelope.error?.details?.retryHint ?? '', /无更小窗口/u);
assert.ok(Buffer.byteLength(minimumOversizedEventResult.content, 'utf8') <= 8_192);
assert.ok(minimumOversizedEventResult.content.length <= 8_192);

console.log(JSON.stringify({
  ok: true,
  native: false,
  mode: 'synthetic-no-native-bridge',
  message: 'EMEVD Agent 工具 schema 与输入门禁 smoke 通过；未声明 native 读取成功。'
}, null, 2));
