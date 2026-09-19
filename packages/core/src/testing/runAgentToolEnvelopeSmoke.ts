/** Regression for historical workspace_stats projection failures and audit parity. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { createDefaultToolRegistry, ToolRegistry, type ToolResult } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { projectEvidenceClaims } from '../model-services/evidenceIdentity.js';
import { encodeEvidenceClaims, expandEvidenceClaims } from '../model-services/evidenceTransport.js';
import { createOpaqueCursor } from '@soulforge/shared';

async function execute(result: ToolResult) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'workspace_stats',
    description: 'Return the fixture payload through the production envelope.',
    permission: 'read',
    run: () => result
  });
  const bridge = createAgentToolBridge({
    registry,
    context: { workspaceIndex: null, mode: 'plan' }
  });
  const outer = await bridge.executeTool({
    id: 'envelope-regression', name: 'workspace_stats', argumentsJson: '{}'
  });
  return { outer, envelope: JSON.parse(outer.content) };
}

export async function runAgentToolEnvelopeSmoke(): Promise<void> {
  const claimFixture = projectEvidenceClaims({
    sourceUri: `workspace://mods/${'long-native-path/'.repeat(6)}gameparam.parambnd.dcx`,
    sourceHash: 'a'.repeat(64), sourceRevision: 123, table: 'NpcParam', entryName: 'NpcParam.param',
    rowId: 50800000,
    fields: ['npcType', 'ninsatuNum', 'itemLotId_1', 'itemLotId_2', 'itemLotId_3', 'hp', 'isSoulGetByBoss', 'getSoul']
      .map(fieldId => ({ fieldId, value: 10, rowId: 50800000 }))
  }, { workspaceId: 'transport-fixture', domain: 'param', authorityClass: 'native' });
  assert.equal(claimFixture.length, 8);
  const wire = encodeEvidenceClaims(claimFixture);
  assert.deepEqual(expandEvidenceClaims(wire), claimFixture);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < Buffer.byteLength(JSON.stringify({ claims: claimFixture })) / 2);
  const customHandle = claimFixture.map((claim, index) => ({ ...claim, handle: `custom:${index}` }));
  assert.deepEqual(expandEvidenceClaims(encodeEvidenceClaims(customHandle)), customHandle);
  assert.deepEqual(expandEvidenceClaims({ claims: claimFixture }), claimFixture);
  assert.deepEqual(expandEvidenceClaims({ claims: [{ identity: {}, text: 'invalid' }] }), [null]);

  const nativeFields = claimFixture.map((claim, i) => ({
    fieldId: claim.identity.claimKind, rowId: 50800000, table: 'NpcParam', entryName: 'NpcParam.param',
    value: i, sourceUri: claim.identity.canonicalOuterId, sourceHash: 'a'.repeat(64), sourceRevision: 123
  }));
  const nativeRegistry = new ToolRegistry();
  let verboseFields = false;
  nativeRegistry.register({
    name: 'read_param_fields', description: 'Eight-field native output fixture', permission: 'read',
    run: () => ({ ok: true, data: {
      sourceUri: claimFixture[0]!.identity.canonicalOuterId, sourceHash: 'a'.repeat(64), sourceRevision: 123,
      sourcePath: verboseFields
        ? `C:\\合成\\参数\\${'长路径/'.repeat(500)}gameparam.parambnd.dcx`
        : 'C:\\synthetic\\param\\gameparam.parambnd.dcx',
      outerFileHash: 'b'.repeat(64),
      fields: nativeFields.map(field => ({ ...field, ...(verboseFields ? { auxiliaryNativeMetadata: 'x'.repeat(2500) } : {}) }))
    } })
  });
  const nativeBridge = createAgentToolBridge({
    registry: nativeRegistry, context: { workspaceIndex: new WorkspaceIndex('native-fields-fixture'), mode: 'plan' }
  });
  const nativeResult = await nativeBridge.executeTool({ id: 'eight-fields', name: 'read_param_fields', argumentsJson: '{}' });
  assert.equal(nativeResult.ok, true, nativeResult.content);
  const nativeEnvelope = JSON.parse(nativeResult.content);
  assert.equal(nativeEnvelope.truncated, false);
  assert.equal(expandEvidenceClaims(nativeEnvelope.evidence).length, 8);
  assert.deepEqual(nativeEnvelope.data.record.fields, nativeFields);
  verboseFields = true;
  const verboseResult = await nativeBridge.executeTool({ id: 'eight-verbose-fields', name: 'read_param_fields', argumentsJson: '{}' });
  assert.equal(verboseResult.ok, true, verboseResult.content);
  const verboseEnvelope = JSON.parse(verboseResult.content);
  assert.equal(verboseEnvelope.data.record.fieldsReturnedCount, 8);
  assert.equal(verboseEnvelope.data.record.fieldsTruncated, undefined);
  assert.equal(verboseEnvelope.data.record.sourceHash, 'a'.repeat(64));
  assert.equal(verboseEnvelope.data.record.outerFileHash, 'b'.repeat(64));
  assert.equal(verboseEnvelope.data.record.sourceRevision, 123);
  assert.equal(typeof verboseEnvelope.data.record.sourcePath, 'string');
  assert.ok(verboseEnvelope.data.record.sourcePath.length <= 421);
  assert.equal(verboseEnvelope.evidence.claimDefaults?.identity?.workspaceId, 'workspace://active');
  assert.doesNotMatch(verboseResult.content, /[A-Za-z]:[\\/][^/]/u);
  assert.deepEqual(verboseEnvelope.data.record.fields.map((field: { fieldId: string; value: number }) => [field.fieldId, field.value]),
    nativeFields.map(field => [field.fieldId, field.value]));

  // Search projections must retain the content that made a candidate useful:
  // text/URI, native row fields, and the exact event instruction plus typed
  // arguments.  These are model-facing candidates, not proof receipts.
  const contentRegistry = new ToolRegistry();
  const textSourceUri = 'workspace://mods/msg/item.msgbnd#engus';
  const paramSourceUri = 'file://param/gameparam.parambnd.dcx';
  const eventSourceUri = 'workspace://mods/event/m11_00_00_00.emevd.dcx';
  contentRegistry.register({
    name: 'search_text_entries', description: 'text search fixture', permission: 'read',
    run: () => ({ ok: true, data: [{
      item: {
        uri: `${textSourceUri}#text/1001`, sourceUri: textSourceUri, category: 'item',
        textId: 1001, entryIndex: 4, language: 'engus', text: '葫芦种子',
        confidence: 'high'
      },
      score: 0.98, highlights: ['葫芦种子']
    }] })
  });
  contentRegistry.register({
    name: 'search_param_rows', description: 'param search fixture', permission: 'read',
    run: () => ({ ok: true, data: [{
      item: {
        uri: `${paramSourceUri}#NpcParam/4400`, sourceUri: paramSourceUri,
        paramName: 'NpcParam', entryName: 'NpcParam.param', entryIndex: 0,
        rowId: 4400, rowIndex: 12, rowName: '葫芦种子',
        fields: [{ fieldId: 'hp', name: 'HP', type: 'int32', description: '生命值', value: 100 }]
      },
      score: 0.91, highlights: ['rowName:葫芦种子']
    }] })
  });
  contentRegistry.register({
    name: 'search_events', description: 'event search fixture', permission: 'read',
    run: () => ({ ok: true, data: {
      query: 'DisplayBossHealthBar', authority: 'native-read-event-search',
      matches: [{
        sourceUri: eventSourceUri, eventId: 1000, instructionIndex: 7,
        instruction: {
          index: 7, bank: 2003, id: 5, unknown: false,
          emedfName: 'DisplayBossHealthBar', argsBase64: 'AQ==',
          typedArgs: [{ name: 'display', type: 'bool', value: true, parameterSymbol: 'BossHealth' }],
          diagnostics: []
        }, authority: 'native-read-event'
      }], total: 1, offset: 0, limit: 20, returned: 1, truncated: false
    } })
  });
  const referenceCursor = 'rf1:{"offset":1}';
  contentRegistry.register({
    name: 'find_references', description: 'reference page fixture', permission: 'analyze',
    inputSchema: { uri: 'string?', cursor: 'string?' },
    run: (input) => ({ ok: true, data: {
      resolution: 'resolved',
      relations: [{
        relationId: 'rel-1', relationKind: 'calls_event', certainty: 'confirmed', path: [],
        from: { workspaceId: 'fixture', domain: 'emevd', sourceUri: eventSourceUri, eventId: 1000 },
        to: { workspaceId: 'fixture', domain: 'fmg', sourceUri: textSourceUri, textId: 1001 },
        evidence: [{ sourceUri: eventSourceUri, statement: {
          kind: 'native-rendered', text: 'DisplayBossHealthBar(1001)',
          location: { instructionIndex: 7 }
        } }]
      }],
      coverage: { scope: 'workspace-bundle', status: 'complete', domains: [], predicateComplete: true, negativeConclusionAllowed: true },
      nextActions: [], diagnostics: [],
      page: { returnedCount: 1, hasMore: typeof (input as Record<string, unknown>).cursor === 'string', ...(typeof (input as Record<string, unknown>).cursor === 'string' ? { nextCursor: referenceCursor } : {}) }
    } })
  });
  const luaSourceUri = 'workspace://mods/script/test.luabnd.dcx';
  const luaSourceHash = 'l'.repeat(64);
  const luaCursor = createOpaqueCursor({
    sessionId: 'source-text-v1', offset: 120, sourceHash: 'lua-page-fingerprint',
    domain: 'script', scope: JSON.stringify({ sourceKey: `${luaSourceUri}!/test.lua`, limit: 120 })
  });
  const luaFirstText = 'function test()\n' + '  print("😀")\n'.repeat(55);
  const luaSecondText = 'return true\n';
  const luaRegistry = contentRegistry;
  luaRegistry.register({
    name: 'read_luabnd_script', description: 'lua read fixture', permission: 'read',
    inputSchema: { file: 'string', childPath: 'string?', sourceOffset: 'safe-integer?', sourceLimit: 'safe-integer?', cursor: 'string?' },
    run: (input) => {
      const hasCursor = typeof (input as Record<string, unknown>).cursor === 'string';
      const sourceText = hasCursor ? luaSecondText : luaFirstText;
      const offset = hasCursor ? 120 : 0;
      const total = luaFirstText.length + luaSecondText.length;
      return { ok: true, data: {
        containerPath: luaSourceUri, childPath: 'test.lua', sourceUri: luaSourceUri,
        offset, limit: 120, total, totalCount: total, returned: sourceText.length,
        returnedCount: sourceText.length, truncated: !hasCursor, hasMore: !hasCursor,
        sourceTextComplete: false,
        ...(hasCursor ? {} : { nextCursor: luaCursor }),
        script: {
          sanitizedName: 'test.lua', sourceText, textPreview: hasCursor ? undefined : 'function test()',
          sourceHash: luaSourceHash, outerFileHash: 'o'.repeat(64), contentKind: 'source',
          isBytecode: false, size: sourceText.length, uncompressedSize: total,
          embeddedSymbols: [], magic: 'TEXT', variant: 'source', isPlainText: true
        }
      } };
    }
  });
  const contentBridge = createAgentToolBridge({
    registry: contentRegistry,
    context: { workspaceIndex: null, mode: 'plan' }
  });
  const textSearch = await contentBridge.executeTool({ id: 'text-search', name: 'search_text_entries', argumentsJson: '{"query":"葫芦种子"}' });
  assert.equal(textSearch.ok, true, textSearch.content);
  const textSearchEnvelope = JSON.parse(textSearch.content);
  assert.equal(textSearchEnvelope.data.items[0].item.text, '葫芦种子');
  assert.equal(textSearchEnvelope.data.items[0].item.sourceUri, textSourceUri);
  assert.equal(textSearchEnvelope.data.items[0].item.entryIndex, 4);
  assert.deepEqual(textSearchEnvelope.data.items[0].highlights, ['葫芦种子']);
  const paramSearch = await contentBridge.executeTool({ id: 'param-search', name: 'search_param_rows', argumentsJson: '{"query":"葫芦种子"}' });
  assert.equal(paramSearch.ok, true, paramSearch.content);
  const paramSearchEnvelope = JSON.parse(paramSearch.content);
  assert.equal(paramSearchEnvelope.data.items[0].item.rowId, 4400);
  assert.equal(paramSearchEnvelope.data.items[0].item.uri, `${paramSourceUri}#NpcParam/4400`);
  assert.equal(paramSearchEnvelope.data.items[0].item.fields[0].fieldId, 'hp');
  assert.equal(paramSearchEnvelope.data.items[0].item.fields[0].value, 100);
  const eventSearch = await contentBridge.executeTool({ id: 'event-search', name: 'search_events', argumentsJson: '{"query":"DisplayBossHealthBar"}' });
  assert.equal(eventSearch.ok, true, eventSearch.content);
  const eventSearchEnvelope = JSON.parse(eventSearch.content);
  assert.equal(eventSearchEnvelope.data.record.matches[0].instructionIndex, 7);
  assert.equal(eventSearchEnvelope.data.record.matches[0].instruction.typedArgs[0].parameterSymbol, 'BossHealth');
  assert.equal(eventSearchEnvelope.data.record.matches[0].instruction.emedfName, 'DisplayBossHealthBar');
  const referenceSearch = await contentBridge.executeTool({ id: 'reference-search', name: 'find_references', argumentsJson: JSON.stringify({ cursor: referenceCursor }) });
  assert.equal(referenceSearch.ok, true, referenceSearch.content);
  const referenceSearchEnvelope = JSON.parse(referenceSearch.content);
  assert.equal(referenceSearchEnvelope.data.record.relations[0].content.text, 'DisplayBossHealthBar(1001)');
  assert.equal(referenceSearchEnvelope.data.record.relations[0].evidence, undefined);
  assert.equal(referenceSearchEnvelope.data.record.page.nextCursor, referenceCursor);
  assert.equal(referenceSearchEnvelope.truncated, true);
  assert.deepEqual(referenceSearchEnvelope.evidence.sourceHashes, []);
  assert.deepEqual(referenceSearchEnvelope.evidence.sourceRevisions, []);
  const pagingRegistry = new ToolRegistry();
  const longCursor = createOpaqueCursor({ sessionId: 'content-search-v1', offset: 1, sourceHash: 'search-hash', domain: 'fmg', scope: 'scope:'.repeat(80) });
  pagingRegistry.register({ name: 'search_text_entries', description: 'paged content', permission: 'read', run: () => ({ ok: true, data: {
    matches: [{ item: { textId: 1, text: '命中内容' } }], total: 9, offset: 0, limit: 1, returned: 1, truncated: true,
    nextCursor: longCursor, nextActions: [{ tool: 'search_text_entries', args: { cursor: longCursor }, reason: '下一页' }]
  } }) });
  const pagingBridge = createAgentToolBridge({ registry: pagingRegistry, context: { workspaceIndex: null, mode: 'plan' } });
  const paged = await pagingBridge.executeTool({ id: 'paging-contract', name: 'search_text_entries', argumentsJson: '{}' });
  assert.equal(paged.ok, true, paged.content);
  const pagedEnvelope = JSON.parse(paged.content);
  assert.equal(pagedEnvelope.data.record.nextCursor, longCursor);
  assert.equal(pagedEnvelope.data.record.nextActions[0].args.cursor, longCursor);
  assert.equal(pagedEnvelope.pagination.cursors.nextCursor, longCursor);
  assert.deepEqual(pagedEnvelope.pagination.continuationParams, { cursor: longCursor });
  const luaFirst = await contentBridge.executeTool({
    id: 'lua-first', name: 'read_luabnd_script',
    argumentsJson: JSON.stringify({ file: luaSourceUri, childPath: 'test.lua' })
  });
  assert.equal(luaFirst.ok, true, luaFirst.content);
  const luaFirstEnvelope = JSON.parse(luaFirst.content);
  assert.ok(['windowed', 'partial'].includes(luaFirstEnvelope.completeness));
  assert.equal(luaFirstEnvelope.truncated, true);
  assert.equal(luaFirstEnvelope.data.record.script.sourceText, luaFirstText);
  assert.doesNotMatch(luaFirstEnvelope.data.record.script.sourceText, /…$/u);
  assert.equal(luaFirstEnvelope.data.record.sourceTextComplete, false);
  assert.equal(luaFirstEnvelope.pagination.cursors.nextCursor, luaCursor);
  const luaSecond = await contentBridge.executeTool({
    id: 'lua-second', name: 'read_luabnd_script',
    argumentsJson: JSON.stringify({ file: luaSourceUri, childPath: 'test.lua', cursor: luaCursor })
  });
  assert.equal(luaSecond.ok, true, luaSecond.content);
  const luaSecondEnvelope = JSON.parse(luaSecond.content);
  assert.equal(luaSecondEnvelope.data.record.script.sourceText, luaSecondText);
  assert.equal(luaSecondEnvelope.data.record.script.sourceText.endsWith('…'), false);

  // A complete native EMEVD body that is too large for one model envelope
  // must not be returned as a 421-character "complete" DSL receipt.
  contentRegistry.register({
    name: 'read_emevd_event', description: 'event read fixture', permission: 'read',
    inputSchema: { file: 'string', eventId: 'safe-integer', format: 'string?' },
    run: () => ({ ok: true, data: {
      sourceUri: eventSourceUri, sourcePath: eventSourceUri, filePath: eventSourceUri,
      eventId: 1000, resourceKind: 'event', game: 'sekiro', format: 'darkscript',
      sourceHash: 'e'.repeat(64), outerFileHash: 'f'.repeat(64), sourceRevision: 9,
      registryFingerprint: 'registry-fixture', instructionCount: 2, total: 2,
      offset: 0, limit: 256, returned: 2, truncated: false, darkScriptComplete: true,
      readRange: { start: 0, end: 2 },
      darkScript: '$Event(1000, {\n' + '  DisplayBossHealthBar(1001),\n'.repeat(500) + '})',
      instructions: [{ index: 0, bank: 2003, id: 5, unknown: false, emedfName: 'DisplayBossHealthBar', typedArgs: [], diagnostics: [] },
        { index: 1, bank: 2003, id: 6, unknown: false, emedfName: 'End', typedArgs: [], diagnostics: [] }], diagnostics: []
    } })
  });
  const longEvent = await contentBridge.executeTool({ id: 'long-event', name: 'read_emevd_event', argumentsJson: JSON.stringify({ file: eventSourceUri, eventId: 1000 }) });
  assert.equal(longEvent.ok, false, longEvent.content);
  assert.equal(longEvent.code, 'RESULT_EVENT_WINDOW_TOO_LARGE');
  assert.equal(JSON.parse(longEvent.content).error.details.completeness, 'windowed');
  assert.equal(JSON.parse(longEvent.content).error.details.truncated, true);
  assert.doesNotMatch(longEvent.content, /complete_native_dsl/u);

  const index = new WorkspaceIndex('stats-summary-fixture');
  const sourceVersions = Array.from({ length: 128 }, (_, i) => ({
    sourceUri: `workspace://mods/event/m11_00_00_00/${String(i).padStart(8, '0')}.emevd.dcx`,
    sourceRevision: 123
  }));
  index.setCoverageState({
    scope: 'workspace', status: 'partial', coveredResources: 127, expectedResources: 128,
    coveredResourceIds: sourceVersions.slice(0, 127).map((source) => source.sourceUri),
    expectedResourceIds: sourceVersions.map((source) => source.sourceUri), sourceVersions,
    staleSources: [sourceVersions[0]!.sourceUri], diagnostics: ['source is stale'],
    predicateCompleteness: { kind: 'unknown', status: 'partial', exhaustive: false, predicate: '', reason: 'fixture' }
  });
  const statistics = createAgentToolBridge({ registry: createDefaultToolRegistry(), context: { workspaceIndex: index, mode: 'plan' } });
  const statsResult = await statistics.executeTool({ id: 'stats-summary', name: 'workspace_stats', argumentsJson: '{}' });
  assert.equal(statsResult.ok, true, statsResult.content);
  const statsEnvelope = JSON.parse(statsResult.content);
  const coverage = statsEnvelope.data.record.coverage.find((item: { scope: string; domain?: string }) => item.scope === 'workspace' && item.domain === undefined);
  assert.equal(coverage.status, 'partial');
  assert.equal(coverage.sourceVersionCount, 128);
  assert.equal(coverage.staleSourceCount, 1);
  assert.equal(coverage.expectedResources, 128);
  assert.equal(coverage.sourceVersions, undefined);
  assert.equal(coverage.detail, 'summary-only');
  // The historical statistics payload included every coverage source identity.
  // Exercise the real serializer guard; do not mock its failed response.
  const oversized = await execute({
    ok: true,
    data: {
      files: 277,
      coverage: [{
        sourceVersions: Array.from({ length: 128 }, (_, index) => ({
          sourceUri: `workspace://mods/event/m11_00_00_00/${String(index).padStart(8, '0')}.emevd.dcx`,
          sourceRevision: 123
        }))
      }]
    }
  });
  assert.equal(oversized.outer.ok, true, oversized.outer.content);
  assert.equal(oversized.envelope.state, 'completed');
  assert.equal(oversized.envelope.truncated, true);
  assert.equal(oversized.envelope.data.record.coverage[0].sourceVersions.totalCount, 128);
  assert.equal(oversized.envelope.data.record.coverage[0].sourceVersions.truncated, true);

  // A reference query can carry its coverage certificate below data.record.
  // The outer Agent envelope must not call that result complete merely because
  // the top-level tool returned successfully.
  const nestedPartial = await execute({
    ok: true,
    data: {
      resolution: 'resolved',
      relations: [],
      coverage: {
        status: 'partial',
        domains: [{ domain: 'script', status: 'not_indexed' }],
        predicateComplete: false,
        negativeConclusionAllowed: false
      },
      page: { returnedCount: 0, hasMore: false }
    }
  });
  assert.equal(nestedPartial.envelope.completeness, 'partial');

  // Entity resolution is a discovery result, not a native proof.  A real
  // resolver can return many candidates and relationship edges; the model
  // must receive a bounded, useful candidate window rather than losing the
  // entire result to the stable-identity budget.
  const resolutionRegistry = new ToolRegistry();
  resolutionRegistry.register({
    name: 'resolve_entity',
    description: 'Resolve a model entity through the production resolver.',
    permission: 'read',
    run: () => ({ ok: true, data: {
      status: 'candidate',
      query: 'Gyoubu',
      domain: 'param',
      candidates: Array.from({ length: 64 }, (_, index) => ({
        candidateId: `candidate:${index}`,
        namespace: 'param-row',
        domain: 'param',
        nativeHandle: `row:${50800000 + index}`,
        label: `Gyoubu candidate ${index}`,
        sourceUri: `workspace://mods/gameparam/NpcParam/${50800000 + index}`,
        nativeVerified: index === 0,
        evidence: [{ kind: 'structured-index', sourceProperty: 'rowName', value: 'Gyoubu' }]
      })),
      verifiedEdges: Array.from({ length: 64 }, (_, index) => ({
        ruleId: 'param-row-to-source',
        fromUri: `workspace://mods/gameparam/NpcParam/${50800000 + index}`,
        toUri: `workspace://mods/gameparam/NpcParam/${50800000 + index}/fields`,
        targetNamespace: 'param-field',
        targetConfirmed: index === 0,
        reason: 'structured candidate edge'
      })),
      diagnostics: Array.from({ length: 64 }, (_, index) => `diagnostic-${index}`)
    } })
  });
  resolutionRegistry.register({
    name: 'search_param_fields',
    description: 'Return trusted PARAM field definitions.',
    permission: 'read',
    run: () => ({ ok: true, data: {
      table: 'NpcParam',
      rowIds: [50800000],
      sourceHash: 'a'.repeat(64),
      fields: [{ fieldId: 'ninsatuNum', name: '必要忍殺回数', type: 'int32' }]
    } })
  });
  const resolutionBridge = createAgentToolBridge({
    registry: resolutionRegistry,
    context: { workspaceIndex: new WorkspaceIndex('entity-resolution-fixture'), mode: 'plan' }
  });
  const resolutionResult = await resolutionBridge.executeTool({
    id: 'large-entity-resolution', name: 'resolve_entity', argumentsJson: '{"query":"Gyoubu"}'
  });
  assert.equal(resolutionResult.ok, true, resolutionResult.content);
  assert.ok(Buffer.byteLength(resolutionResult.content, 'utf8') <= 8_192);
  const resolutionEnvelope = JSON.parse(resolutionResult.content);
  assert.equal(resolutionEnvelope.data.record.candidatesReturnedCount, 8);
  assert.equal(resolutionEnvelope.data.record.candidatesTotalCount, 64);
  assert.equal(resolutionEnvelope.data.record.candidatesTruncated, true);
  assert.equal(resolutionEnvelope.data.record.verifiedEdgesTotalCount, 64);
  assert.equal(resolutionEnvelope.data.record.verifiedEdgesTruncated, true);
  assert.equal(resolutionEnvelope.data.record.candidates[0].sourceUri, 'workspace://mods/gameparam/NpcParam/50800000');
  assert.equal(resolutionEnvelope.error, undefined);
  const fieldResult = await resolutionBridge.executeTool({
    id: 'param-definition-projection', name: 'search_param_fields', argumentsJson: '{}'
  });
  assert.equal(fieldResult.ok, true, fieldResult.content);
  const fieldEnvelope = JSON.parse(fieldResult.content);
  assert.equal(fieldEnvelope.data.record.fields[0].fieldId, 'ninsatuNum');
  assert.equal(fieldEnvelope.data.record.fields[0].name, '必要忍殺回数');

  // A committed write must not be converted into a retryable ordinary
  // failure merely because its stable identity list is too large. Keep the
  // small transaction lifecycle and reread locator available to the model;
  // the oversized identity itself remains explicitly unavailable.
  const committedOversized = await execute({
    ok: true,
    state: 'committed',
    data: {
      operationId: 'fixture-committed-op',
      sourceUri: 'workspace://mods/NpcParam.parambnd.dcx',
      sourceHash: 'b'.repeat(64),
      lifecycle: {
        transaction: 'committed',
        nativeVerification: { status: 'verified', sourceUri: 'workspace://mods/NpcParam.parambnd.dcx' },
        knowledgeRefresh: 'failed'
      },
      sourceVersions: Array.from({ length: 128 }, (_, index) => ({
        sourceUri: `workspace://mods/event/${String(index).padStart(8, '0')}/${'long-source-name/'.repeat(3)}.emevd.dcx`,
        sourceRevision: 123
      }))
    }
  });
  assert.equal(committedOversized.outer.ok, true, committedOversized.outer.content);
  assert.equal(committedOversized.envelope.ok, true);
  assert.equal(committedOversized.envelope.state, 'committed');
  assert.equal(committedOversized.envelope.data.record.operationId, 'fixture-committed-op');
  assert.equal(committedOversized.envelope.data.record.lifecycle.transaction, 'committed');
  assert.equal(committedOversized.envelope.data.record.lifecycle.nativeVerification.status, 'verified');
  assert.equal(committedOversized.envelope.data.record.lifecycle.knowledgeRefresh, 'failed');
  assert.equal(committedOversized.envelope.data.record.sourceVersions, undefined);
  assert.equal(committedOversized.envelope.truncated, true);
  assert.equal(committedOversized.envelope.data.record.outputBudget, undefined);
  assert.ok(
    Buffer.byteLength(committedOversized.outer.content, 'utf8') <= 8192,
    `committed oversized envelope exceeded byte budget: ${Buffer.byteLength(committedOversized.outer.content, 'utf8')}`
  );
  assert.ok(
    committedOversized.outer.content.length <= 8192,
    `committed oversized envelope exceeded character budget: ${committedOversized.outer.content.length}`
  );

  const partialOversized = await execute({
    ok: true,
    state: 'partial' as unknown as NonNullable<ToolResult['state']>,
    data: {
      sourceVersions: Array.from({ length: 128 }, (_, index) => ({
        sourceUri: `workspace://mods/event/partial/${String(index).padStart(8, '0')}/${'long-source-name/'.repeat(3)}.emevd.dcx`,
        sourceRevision: 123
      }))
    }
  });
  assert.equal(partialOversized.outer.ok, true, partialOversized.outer.content);
  assert.equal(partialOversized.envelope.state, 'partial');
  assert.equal(partialOversized.envelope.truncated, true);
  assert.equal(partialOversized.envelope.completeness, 'summary_only');
  assert.deepEqual(partialOversized.envelope.data.record, {});

  // Force the strictest committed fallback: long opaque locators and nested
  // diagnostics make the projected lifecycle itself too large.  The fallback
  // must retain the committed lifecycle and expose why auxiliary data was
  // omitted, without inviting a duplicate write.
  const committedMinimal = await execute({
    ok: true,
    state: 'committed',
    data: {
      operationId: '操作'.repeat(400),
      lifecycle: {
        transaction: 'committed',
        nativeVerification: { status: 'verified', sourceUri: '地图'.repeat(400) },
        knowledgeRefresh: { status: 'failed', semanticState: 'empty' },
        diagnostics: Array.from({ length: 8 }, () => ({ message: '诊断'.repeat(600) }))
      },
      sourceVersions: Array.from({ length: 128 }, (_, index) => ({
        sourceUri: `workspace://mods/event/${String(index).padStart(8, '0')}/${'长路径/'.repeat(12)}.emevd.dcx`,
        sourceRevision: 123
      }))
    }
  });
  assert.equal(committedMinimal.outer.ok, true, committedMinimal.outer.content);
  assert.equal(committedMinimal.envelope.state, 'committed');
  assert.equal(committedMinimal.envelope.data.record.lifecycle.knowledgeRefresh.status, 'failed');
  assert.equal(typeof committedMinimal.envelope.data.record.operationId, 'string');
  assert.equal(committedMinimal.envelope.data.record.outputBudget.code, 'RESULT_IDENTITY_TOO_LARGE');
  assert.equal(committedMinimal.envelope.data.record.outputBudget.projection, 'committed_lifecycle');
  assert.ok(Buffer.byteLength(committedMinimal.outer.content, 'utf8') <= 8192);
  assert.ok(committedMinimal.outer.content.length <= 8192);

  // An explicitly failed lifecycle must not be silently promoted to completed,
  // even if a registry handler returned an inconsistent ok flag.
  for (const ok of [false, true]) {
    const failed = await execute({
      ok,
      state: 'failed',
      error: { code: 'NATIVE_READ_FAILED', message: 'fixture failure' }
    });
    assert.equal(failed.outer.ok, false);
    assert.equal(failed.outer.code, 'NATIVE_READ_FAILED');
    assert.equal(failed.envelope.ok, false);
    assert.equal(failed.envelope.state, 'failed');
    assert.deepEqual(failed.envelope.error, {
      code: 'NATIVE_READ_FAILED', message: 'fixture failure'
    });
  }
  const missingError = await execute({ ok: true, state: 'failed' });
  assert.equal(missingError.outer.ok, false);
  assert.equal(missingError.outer.code, 'TOOL_FAILED');
  assert.equal(missingError.envelope.error.code, 'TOOL_FAILED');

  // Small errors retain the registry's exact details schema. The bounded
  // projection below must only activate after the original response exceeds
  // the dual byte/character budget.
  const exactError = {
    code: 'EXACT_TOOL_FAILURE',
    message: 'small failure',
    details: {
      vendorField: 'preserve-me',
      nested: { arbitrary: true },
      diagnostics: [{ severity: 'warning', code: 'D0', message: 'small' }]
    }
  };
  const exact = await execute({ ok: false, state: 'failed', error: exactError });
  assert.equal(exact.outer.ok, false);
  assert.deepEqual(exact.envelope.error, exactError);

  // Non-ok tool results must obey the same envelope budget as successful
  // results. Exercise repeated 1,000-entry diagnostic arrays so this does
  // not pass merely because one small fixture happened to fit. Stable
  // locators/hashes/handles remain whole; ordinary text is UTF-8 bounded.
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const failed = await execute({
      ok: false,
      state: 'failed',
      error: {
        code: 'SYNTHETIC_NATIVE_READ_FAILED',
        message: `失败诊断 ${attempt}：${'模型消息'.repeat(4_000)}`,
        details: {
          sourceUri: `workspace://mods/event/m11_00_00_00-${attempt}.emevd.dcx`,
          sourcePath: `D:\\synthetic\\event\\m11_00_00_00-${attempt}.emevd.dcx`,
          sourceHash: 'c'.repeat(64),
          outerFileHash: 'd'.repeat(64),
          sourceRevision: 123,
          handle: `event-handle:${attempt}`,
          detail: '细节'.repeat(4_000),
          diagnostics: Array.from({ length: 1_000 }, (_value, index) => ({
            severity: index % 2 === 0 ? 'error' : 'warning',
            code: `D-${index}`,
            message: `诊断 ${index}：${'原生字段布局'.repeat(120)}`,
            sourceUri: `workspace://diagnostic/${index}`
          }))
        }
      }
    });
    assert.equal(failed.outer.ok, false);
    assert.equal(failed.outer.code, 'SYNTHETIC_NATIVE_READ_FAILED');
    assert.equal(failed.envelope.ok, false);
    assert.equal(failed.envelope.state, 'failed');
    const error = failed.envelope.error as {
      message?: string;
      messageTruncated?: boolean;
      details?: {
        sourceHash?: string;
        outerFileHash?: string;
        handle?: string;
        detail?: string;
        diagnostics?: { items?: unknown[]; total?: number; returned?: number; truncated?: boolean };
      };
    };
    assert.equal(error.messageTruncated, true);
    assert.ok((error.message?.length ?? 0) < 2_000);
    assert.equal(error.details?.sourceHash, 'c'.repeat(64));
    assert.equal(error.details?.outerFileHash, 'd'.repeat(64));
    assert.equal(error.details?.handle, `event-handle:${attempt}`);
    assert.ok((error.details?.detail?.length ?? 0) < 500);
    assert.equal(error.details?.diagnostics?.total, 1_000);
    assert.ok((error.details?.diagnostics?.returned ?? 0) <= 8);
    assert.equal(error.details?.diagnostics?.truncated, true);
    assert.ok(Buffer.byteLength(failed.outer.content, 'utf8') <= 8_192);
    assert.ok(failed.outer.content.length <= 8_192);
  }

  // Some callers put stable identity and diagnostics on the error object
  // itself. They must survive the same bounded projection as nested details.
  const topLevelFailure = await execute({
    ok: false,
    state: 'failed',
    error: {
      code: 'TOP_LEVEL_NATIVE_READ_FAILED',
      message: '顶层失败'.repeat(4_000),
      sourcePath: 'D:\\synthetic\\event\\top-level.emevd.dcx',
      sourceHash: 'f'.repeat(64),
      handle: 'top-level-event-handle',
      diagnostics: Array.from({ length: 1000 }, (_value, index) => ({
        severity: 'error', code: `TOP-${index}`, message: `诊断 ${index}`
      }))
    } as NonNullable<ToolResult['error']>
  });
  assert.equal(topLevelFailure.outer.ok, false);
  assert.equal(topLevelFailure.envelope.error.code, 'TOP_LEVEL_NATIVE_READ_FAILED');
  assert.equal(topLevelFailure.envelope.error.sourcePath, 'D:\\synthetic\\event\\top-level.emevd.dcx');
  assert.equal(topLevelFailure.envelope.error.sourceHash, 'f'.repeat(64));
  assert.equal(topLevelFailure.envelope.error.handle, 'top-level-event-handle');
  assert.equal(topLevelFailure.envelope.error.diagnostics.total, 1000);
  assert.ok(topLevelFailure.envelope.error.diagnostics.returned <= 8);
  assert.equal(topLevelFailure.envelope.error.diagnostics.truncated, true);
  assert.ok(Buffer.byteLength(topLevelFailure.outer.content, 'utf8') <= 8_192);
  assert.ok(topLevelFailure.outer.content.length <= 8_192);

  // A post-commit failure state is not an ordinary retryable failure. The
  // bridge must preserve the lifecycle state even when the error is non-ok;
  // in particular it must not turn verification_failed/committed/partial
  // into a successful or generic failed envelope.
  for (const state of ['committed', 'verification_failed', 'partial'] as const) {
    const postCommit = await execute({
      ok: false,
      state: state as unknown as NonNullable<ToolResult['state']>,
      error: {
        code: 'POST_COMMIT_REFRESH_FAILED',
        message: 'write result requires reread',
        details: { operationId: 'op-committed', sourceHash: 'e'.repeat(64) }
      }
    });
    assert.equal(postCommit.outer.ok, false);
    assert.equal(postCommit.envelope.ok, false);
    assert.equal(postCommit.envelope.state, state);
    assert.equal(postCommit.envelope.error.code, 'POST_COMMIT_REFRESH_FAILED');
  }

  // verification_failed means a write already committed. It must retain its
  // lifecycle so callers cannot mistake it for a safe-to-retry ordinary error.
  for (const state of ['completed', 'staged', 'committed', 'verification_failed'] as const) {
    const data = { operationId: 'fixture-op', sourceHash: 'a'.repeat(64) };
    const succeeded = await execute({ ok: true, state, data });
    assert.equal(succeeded.outer.ok, true);
    assert.equal(succeeded.outer.code, undefined);
    assert.equal(succeeded.envelope.ok, true);
    assert.equal(succeeded.envelope.state, state);
    assert.deepEqual(succeeded.envelope.data.record, data);
  }
  const legacySuccess = await execute({ ok: true, data: { files: 1 } });
  assert.equal(legacySuccess.outer.ok, true);
  assert.equal(legacySuccess.envelope.state, 'completed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentToolEnvelopeSmoke().then(() => {
    console.log('Agent tool envelope smoke passed.');
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
