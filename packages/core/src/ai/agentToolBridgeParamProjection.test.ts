import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgentToolBridge, MAX_BOUNDED_TOOL_RESULT_BYTES } from './agentToolBridge.js';
import { ToolRegistry } from './toolRegistry.js';

function makeField(index: number) {
  return {
    fieldId: `field${index}`,
    name: `字段 ${index}`,
    type: 's32',
    description: 'long native field description '.repeat(12),
    value: index,
    refs: [{ param: 'OtherParam' }],
    refsProvenance: 'trusted-metadata'
  };
}

function makeRow(rowId: number, fieldCount = 30) {
  return {
    uri: `file://param/gameparam/gameparam.parambnd.dcx#NpcParam/${rowId}`,
    sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx',
    paramName: 'NpcParam',
    entryName: 'NpcParam.param',
    entryIndex: 4,
    rowId,
    rowName: `候选 ${rowId}`,
    sourceHash: `hash-${rowId}`,
    outerFileHash: `outer-${rowId}`,
    sourceRevision: 1,
    fields: Array.from({ length: fieldCount }, (_, index) => makeField(index))
  };
}

function makeResolveCandidate(index: number, label: string) {
  return {
    candidateId: `file://param/gameparam/gameparam.parambnd.dcx#NpcParam/${50800000 + index}`,
    domain: 'param',
    nativeHandle: `NpcParam#${50800000 + index}`,
    label,
    sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx',
    sourceSnapshot: { sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx', sourceHash: `hash-${index}` },
    nativeVerified: true,
    status: 'verified'
  };
}

function registerFixtureTool(registry: ToolRegistry, name: string, data: unknown) {
  registry.register({
    name,
    description: 'fixture',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', limit: 'safe-integer?' },
    run: () => ({ ok: true, state: 'completed', data })
  });
}

describe('Agent bridge resolve_entity candidate budget', () => {
  it('delivers the full candidate set when the budget allows, without a retry hint', async () => {
    const registry = new ToolRegistry();
    registerFixtureTool(registry, 'resolve_entity', {
      status: 'partial',
      query: '鬼形部',
      domain: 'unknown',
      candidateSetComplete: true,
      candidates: Array.from({ length: 64 }, (_, index) => makeResolveCandidate(index, `候选${index}`)),
      candidatesReturnedCount: 64,
      candidatesTotalCount: 64,
      candidatesTruncated: false,
      relationshipsTruncated: false,
      coverage: { status: 'partial' }
    });
    const bridge = createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'plan' } });
    const result = await bridge.executeTool({
      id: 'resolve-full',
      name: 'resolve_entity',
      argumentsJson: JSON.stringify({ query: '鬼形部', maxCandidates: 64 })
    });
    assert.equal(result.ok, true);
    const envelope = JSON.parse(result.content) as { data?: { record?: any } };
    const record = envelope.data?.record;
    assert.equal(record.candidates.length, 64);
    assert.equal(record.candidatesTruncated, false);
    assert.equal(record.candidateSetComplete, true);
    assert.equal(record.relationshipsTruncated, false);
    assert.equal((record.nextReadPlan ?? []).some((step: any) => step.tool === 'search_param_rows'), false);
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES);
  });

  it('guides toward param search when the budget truncates the candidate set', async () => {
    const registry = new ToolRegistry();
    registerFixtureTool(registry, 'resolve_entity', {
      status: 'partial',
      query: '鬼刑部',
      domain: 'unknown',
      candidateSetComplete: true,
      candidates: Array.from({ length: 64 }, (_, index) => makeResolveCandidate(index, `候选标签${index}-` + '描述文本'.repeat(200))),
      candidatesReturnedCount: 64,
      candidatesTotalCount: 64,
      candidatesTruncated: false,
      relationshipsTruncated: false,
      coverage: { status: 'partial' }
    });
    const bridge = createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'plan' } });
    const result = await bridge.executeTool({
      id: 'resolve-truncated',
      name: 'resolve_entity',
      argumentsJson: JSON.stringify({ query: '鬼刑部', maxCandidates: 64 })
    });
    assert.equal(result.ok, true);
    const envelope = JSON.parse(result.content) as { data?: { record?: any } };
    const record = envelope.data?.record;
    assert.ok(record.candidates.length < 64);
    assert.equal(record.candidatesTruncated, true);
    assert.equal(record.candidateSetComplete, false);
    const retry = record.nextReadPlan.filter((step: any) => step.tool === 'search_param_rows');
    assert.equal(retry.length, 1);
    assert.deepEqual(retry[0].args, { query: '鬼刑部', limit: 8 });
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES);
  });
});

describe('Agent bridge resource identity redaction', () => {
  it('drops absolute workspace ids while keeping logical identity', async () => {
    const registry = new ToolRegistry();
    registerFixtureTool(registry, 'search_resources', {
      matches: [
        {
          score: 170,
          item: {
            id: 'file:///D:/mystream/Sekiro%20Shadows%20Die%20Twice/Sekiro/mods:chr/c0000.anibnd.dcx',
            sourceUri: 'file://chr/c0000.anibnd.dcx',
            relativePath: 'chr/c0000.anibnd.dcx',
            resourceKind: 'chr'
          }
        },
        {
          score: 100,
          item: {
            id: 'file://param/gameparam/gameparam.parambnd.dcx',
            sourceUri: 'file://param/gameparam/gameparam.parambnd.dcx',
            relativePath: 'param/gameparam/gameparam.parambnd.dcx',
            resourceKind: 'param'
          }
        }
      ],
      total: 2,
      totalCount: 2,
      offset: 0,
      limit: 2,
      returned: 2,
      returnedCount: 2,
      truncated: false
    });
    const bridge = createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'plan' } });
    const result = await bridge.executeTool({
      id: 'resource-identity',
      name: 'search_resources',
      argumentsJson: JSON.stringify({ query: 'anibnd', limit: 2 })
    });
    assert.equal(result.ok, true);
    const raw = result.content;
    assert.equal(raw.includes('mystream'), false);
    assert.equal(raw.includes('file:///D:'), false);
    const envelope = JSON.parse(raw) as { data?: { record?: any } };
    const items = envelope.data?.record?.matches?.map((match: any) => match.item ?? match);
    assert.equal(items.length, 2);
    assert.equal('id' in items[0], false);
    assert.equal(items[0].sourceUri, 'file://chr/c0000.anibnd.dcx');
    assert.equal(items[1].id, 'file://param/gameparam/gameparam.parambnd.dcx');
  });
});

describe('Agent bridge PARAM discovery projection', () => {
  it('keeps two wide candidate identities deliverable with bounded fields and recovery metadata', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'search_param_rows',
      description: 'fixture',
      permission: 'read',
      permissionLevel: 'read',
      inputSchema: { query: 'string?', limit: 'safe-integer?', paramNames: 'array?', cursor: 'string?' },
      run: () => ({
        ok: true,
        state: 'completed',
        data: {
          query: 'fixture',
          matches: [
            { score: 100, highlights: ['fixture'], item: makeRow(1) },
            { score: 99, highlights: ['fixture'], item: makeRow(2) }
          ],
          total: 2,
          totalCount: 2,
          offset: 0,
          limit: 2,
          returned: 2,
          returnedCount: 2,
          truncated: false
        }
      })
    });

    const bridge = createAgentToolBridge({
      registry,
      context: { workspaceIndex: null, mode: 'plan' }
    });
    const result = await bridge.executeTool({
      id: 'param-discovery',
      name: 'search_param_rows',
      argumentsJson: JSON.stringify({ query: 'fixture', limit: 2 })
    });

    assert.equal(result.ok, true);
    const envelope = JSON.parse(result.content) as { data?: { record?: any } };
    const matches = envelope.data?.record?.matches;
    assert.equal(Array.isArray(matches), true);
    assert.equal(matches.length, 2);
    for (const match of matches) {
      const row = match.item;
      assert.equal(row.fieldsComplete, false);
      assert.equal(row.fieldCount, 30);
      assert.equal(row.fieldPreview.length, 2);
      assert.equal('description' in row.fieldPreview[0], false);
      assert.equal(row.fieldPreview[0].fieldId, 'field0');
      assert.equal(row.readAction.tool, 'read_param_fields');
      assert.deepEqual(row.readAction.args.table, 'NpcParam');
      assert.deepEqual(row.readAction.args.rowIds, [row.rowId]);
      assert.equal(row.readAction.args.containerPath, row.sourceUri);
      assert.equal(row.entryIndex, 4);
      assert.equal(row.outerFileHash, `outer-${row.rowId}`);
      assert.equal(row.readAction.args.pageSize, 4);
      assert.equal(row.readAction.scope, 'preview-fields');
      assert.match(row.recovery, /search_param_fields/);
      assert.match(row.recovery, /containerPath/);
    }
    assert.equal(envelope.data?.record?.total, 2);
    assert.equal(envelope.data?.record?.returned, 2);
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES);
  });

  it('uses all known field ids for a bounded row while keeping cursor pages conservative', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'search_param_rows',
      description: 'fixture',
      permission: 'read',
      permissionLevel: 'read',
      inputSchema: { query: 'string?', limit: 'safe-integer?' },
      run: () => ({
        ok: true,
        state: 'completed',
        data: {
          query: 'fixture',
          matches: [{ score: 100, item: makeRow(7, 4) }],
          total: 1,
          totalCount: 1,
          offset: 0,
          limit: 1,
          returned: 1,
          returnedCount: 1,
          truncated: false
        }
      })
    });
    const bridge = createAgentToolBridge({ registry, context: { workspaceIndex: null, mode: 'plan' } });
    const result = await bridge.executeTool({
      id: 'param-discovery-all-known',
      name: 'search_param_rows',
      argumentsJson: JSON.stringify({ query: 'fixture', limit: 1 })
    });
    assert.equal(result.ok, true);
    const envelope = JSON.parse(result.content) as { data?: { record?: any } };
    const row = envelope.data?.record?.matches?.[0]?.item;
    assert.equal(row.fieldsComplete, false);
    assert.equal(row.fieldCount, 4);
    assert.equal(row.readAction.scope, 'all-known-fields');
    assert.equal(row.readAction.args.fieldIds.length, 4);
    assert.equal(row.readAction.args.containerPath, row.sourceUri);
    assert.equal(row.readAction.args.pageSize, 4);
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES);
  });
});
