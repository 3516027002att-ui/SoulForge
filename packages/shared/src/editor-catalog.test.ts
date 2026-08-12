/**
 * SCHEMA-02 负向优先的 decoder 契约测试（front-end.md §18.6）。
 *
 * 覆盖：合法 DTO 全链路解码；绝对路径、unknown extra field、非法枚举、
 * 缺失必填、limit 越界、负向路由（.bak→history、TPF→texture）与
 * reduceAgentComposer 固定状态机的允许/非法转换。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EditorCatalogDecodeError,
  decodeEditorCatalogSummary,
  decodeEditorCatalogSnapshot,
  decodeEditorMutation,
  decodePageEditorDocumentRequest,
  decodeEditorDocumentResult,
  decodeEditorPageItemDto,
  decodeLogicalDocumentRef,
  decodeOperationCapability,
  decodeDomainSummary,
  decodeDocumentLoadState,
  decodeEditTransactionState,
  resolveIntegrationForConfirmedLeaf
} from './editor-catalog.js';
import {
  reduceAgentComposer,
  decodeWorkbenchRoute,
  decodeAgentStreamEvent,
  decodeAgentMessagePageRequest,
  decodeSubmitAgentRunRequest
} from './editor-protocol.js';

const readyCapability = {
  read: {
    kind: 'ready',
    operationIds: ['catalog-open', 'page-tables'],
    verifiedStages: ['D3', 'D4', 'D5', 'D6'],
    resolverSnapshotId: 'snap-1'
  },
  write: {
    kind: 'blocked',
    reasonCode: 'writer-unverified',
    missingStages: ['D7', 'D8', 'D9', 'D10']
  }
};

const summaryFixture = {
  catalogRevision: 'rev-2026-08-13-01',
  domains: [
    {
      domain: 'param',
      label: 'PARAM',
      visibility: 'visible',
      capability: 'read-ready',
      defaultTarget: {
        resourceId: 'res-gameparam',
        domain: 'param',
        libraryId: 'game-parameters',
        bankId: null,
        documentId: 'game-parameters',
        sourceVariant: 'overlay'
      }
    },
    { domain: 'files', label: '文件', visibility: 'visible', capability: 'deferred', defaultTarget: null }
  ],
  libraries: [
    {
      libraryId: 'game-parameters',
      domain: 'param',
      label: 'Game Parameters',
      bankIds: [],
      documentIds: ['game-parameters'],
      counts: { libraries: 1, tables: 34 }
    }
  ],
  banks: [],
  documents: [
    {
      ref: {
        resourceId: 'res-gameparam',
        domain: 'param',
        libraryId: 'game-parameters',
        bankId: null,
        documentId: 'game-parameters',
        sourceVariant: 'overlay'
      },
      label: 'Game Parameters',
      recognition: {
        kind: 'confirmed',
        stack: {
          stackId: 'stack-1',
          layers: [
            { layerIndex: 0, formatId: 'dcx-dflt', confirmedBy: 'bridge', childStableId: null },
            { layerIndex: 1, formatId: 'bnd4', confirmedBy: 'bridge', childStableId: 'entry-gameparam' },
            { layerIndex: 2, formatId: 'param', confirmedBy: 'bridge', childStableId: null }
          ],
          leafFormatId: 'param',
          containerRole: 'gameparam-binder'
        }
      },
      capability: readyCapability,
      effectiveVariantId: 'variant-primary-1'
    }
  ],
  historyCount: 1
};

test('合法 EditorCatalogSummary 全链路解码', () => {
  const decoded = decodeEditorCatalogSummary(summaryFixture);
  assert.equal(decoded.domains.length, 2);
  assert.equal(decoded.domains[0]!.domain, 'param');
  assert.equal(decoded.documents[0]!.recognition.kind, 'confirmed');
  assert.equal(decoded.historyCount, 1);
});

test('unknown extra field 被拒绝', () => {
  const bad = { ...summaryFixture, extraField: 1 };
  assert.throws(() => decodeEditorCatalogSummary(bad), EditorCatalogDecodeError);
});

test('非法枚举值被拒绝', () => {
  const bad = structuredClone(summaryFixture) as any;
  bad.domains[0].visibility = 'glowing';
  assert.throws(() => decodeEditorCatalogSummary(bad), EditorCatalogDecodeError);
});

test('缺失必填字段被拒绝', () => {
  const bad = structuredClone(summaryFixture) as any;
  delete bad.catalogRevision;
  assert.throws(() => decodeEditorCatalogSummary(bad), EditorCatalogDecodeError);
});

test('绝对路径进入 renderer DTO 被拒绝', () => {
  const bad = structuredClone(summaryFixture) as any;
  bad.domains[0].defaultTarget.resourceId = 'D:\\mystream\\Sekiro\\gameparam.parambnd.dcx';
  assert.throws(() => decodeEditorCatalogSummary(bad), EditorCatalogDecodeError);
  const badPosix = structuredClone(summaryFixture) as any;
  badPosix.libraries[0].libraryId = '/var/soulforge/game-parameters';
  assert.throws(() => decodeEditorCatalogSummary(badPosix), EditorCatalogDecodeError);
});

test('LogicalDocumentRef 拒绝路径逃逸', () => {
  assert.throws(
    () => decodeLogicalDocumentRef({ resourceId: 'a/../b', domain: 'param', libraryId: 'l', bankId: null, documentId: 'd', sourceVariant: 'overlay' }),
    EditorCatalogDecodeError
  );
});

test('ready ReadCapability 缺 stage 被拒绝', () => {
  const bad = structuredClone(readyCapability) as any;
  bad.read.verifiedStages = ['D3', 'D4', 'D5'];
  assert.throws(() => decodeOperationCapability(bad), EditorCatalogDecodeError);
});

test('.bak → history 变体不能伪装成 primary/base（PhysicalVariantRef）', () => {
  // §5.3 负向路由：.bak 是 History-only。decoder 层保证 history 变体无法
  // 以 primary/base 形态进入（recoveryOfResourceId 必须存在且 sourceLayer
  // 必须为 history）；路由到 Param Editor 的否定由 ROUTE-06 保证。
  assert.throws(
    () => decodeEditorCatalogSnapshot({
      catalogRevision: 'r',
      libraries: [],
      banks: [],
      documents: [],
      history: [
        {
          variantId: 'v-bak', precedence: 50, contentHash: null, sourceRevision: null, provenanceDigest: null,
          role: 'backup', sourceLayer: 'overlay', recoveryOfResourceId: null
        }
      ],
      projections: []
    }),
    EditorCatalogDecodeError,
    'backup 变体 sourceLayer 必须为 history'
  );
});

test('EditorMutation 合法变体解码', () => {
  const m = decodeEditorMutation({ kind: 'param-field-set', tableId: 't1', rowId: 'r1', fieldId: 'f1', value: 42 });
  assert.equal(m.kind, 'param-field-set');
  assert.equal(m.value, 42);
  const m2 = decodeEditorMutation({ kind: 'fmg-entry-upsert', tableId: 't2', entryId: 'e2', text: '你好世界' });
  assert.equal(m2.kind, 'fmg-entry-upsert');
});

test('EditorMutation 非法 kind 被拒绝', () => {
  assert.throws(() => decodeEditorMutation({ kind: 'emevd-set-rest-behavior', tableId: 't' }), EditorCatalogDecodeError);
});

test('EditorMutation 字段类型错误被拒绝', () => {
  assert.throws(
    () => decodeEditorMutation({ kind: 'param-field-set', tableId: 't1', rowId: 'r1', fieldId: 'f1', value: { bad: true } }),
    EditorCatalogDecodeError
  );
});

test('EditorMutation 路径字段被拒绝', () => {
  assert.throws(
    () => decodeEditorMutation({ kind: 'bnd4-child-replace', childStableId: 'C:\\evil\\child', stagedPayloadToken: 'tok-1' }),
    EditorCatalogDecodeError
  );
});

test('PageEditorDocumentRequest limit 越界被拒绝', () => {
  assert.throws(
    () => decodePageEditorDocumentRequest({
      documentHandle: 'h-1',
      expectedRevision: 'rev-1',
      query: { kind: 'param-tables', search: '' },
      cursor: null,
      limit: 501
    }),
    EditorCatalogDecodeError
  );
  assert.throws(
    () => decodePageEditorDocumentRequest({
      documentHandle: 'h-1',
      expectedRevision: 'rev-1',
      query: { kind: 'param-tables', search: '' },
      cursor: null,
      limit: 0
    }),
    EditorCatalogDecodeError
  );
});

test('page item kind 与 query kind 不匹配被拒绝（§14.4）', () => {
  assert.throws(
    () => decodeEditorPageItemDto(
      { kind: 'param-table', tableId: 't', name: 'n', localizedName: null },
      'item',
      'param-rows'
    ),
    EditorCatalogDecodeError
  );
});

test('EditorDocumentResult 双形态解码', () => {
  assert.deepEqual(
    decodeEditorDocumentResult({ ok: false, code: 'stale-revision', retryable: true }),
    { ok: false, code: 'stale-revision', retryable: true }
  );
  const ok = decodeEditorDocumentResult({ ok: true, value: { closed: true } });
  assert.equal(ok.ok, true);
});

test('DocumentLoadState: blocked 缺 retryable 被拒绝; partial 不允许 retryable', () => {
  assert.throws(
    () => decodeDocumentLoadState({ kind: 'blocked', reasonCode: 'capability-blocked' }),
    EditorCatalogDecodeError
  );
  assert.throws(
    () => decodeDocumentLoadState({ kind: 'partial', reasonCode: 'native-parse-failed', retryable: true }),
    EditorCatalogDecodeError
  );
  const ok = decodeDocumentLoadState({ kind: 'empty', reason: 'true-empty' });
  assert.equal(ok.kind, 'empty');
});

test('EditTransactionState: 失败态需要 phase+reasonCode', () => {
  assert.throws(
    () => decodeEditTransactionState({ kind: 'failed', operationId: 'op-1', phase: 'patch' }),
    EditorCatalogDecodeError
  );
  const ok = decodeEditTransactionState({ kind: 'rolled-back', operationId: 'op-1', restoredRevision: 'rev-0' });
  assert.equal(ok.kind, 'rolled-back');
});

test('WorkbenchRoute: .bak 只能得到 history', () => {
  const route = decodeWorkbenchRoute({ kind: 'history', recoveryOfResourceId: 'res-gameparam' });
  assert.equal(route.kind, 'history');
  const bad = decodeWorkbenchRoute({ kind: 'ready', editorId: 'param', document: { resourceId: 'x', domain: 'param', libraryId: 'l', bankId: null, documentId: 'd', sourceVariant: 'overlay' }, readOnly: false });
  assert.equal(bad.kind, 'ready');
});

test('LogicalDocumentRef 的语义 ID 字段拒绝路径逃逸', () => {
  // 语义路由（TPF→Texture 而非 Text）由 CAT-05/ROUTE-06 判定；decoder 层
  // 保证语义 ID 字段不得携带 `..` 路径逃逸，防止冒充其他领域。
  assert.throws(
    () => decodeLogicalDocumentRef({
      resourceId: 'res-tpf',
      domain: 'text',
      libraryId: 'menu\\..\\..\\evil',
      bankId: null,
      documentId: 'hi.tpf.dcx',
      sourceVariant: 'overlay'
    }),
    EditorCatalogDecodeError,
    'libraryId 不得携带路径逃逸'
  );
});

test('AgentMessagePageRequest limit 1..100', () => {
  const ok = decodeAgentMessagePageRequest({ sessionId: 's1', cursor: null, limit: 100 });
  assert.equal(ok.limit, 100);
  assert.throws(
    () => decodeAgentMessagePageRequest({ sessionId: 's1', cursor: null, limit: 101 }),
    EditorCatalogDecodeError
  );
});

test('AgentStreamEvent seq 必须为整数', () => {
  assert.throws(
    () => decodeAgentStreamEvent({ seq: 1.5, sessionId: 's1', kind: 'message-finished', messageId: 'm1' }),
    EditorCatalogDecodeError
  );
  const ok = decodeAgentStreamEvent({ seq: 3, sessionId: 's1', kind: 'message-finished', messageId: 'm1' });
  assert.equal(ok.seq, 3);
});

test('SubmitAgentRunRequest: prompt 边界与附件上限', () => {
  assert.throws(
    () => decodeSubmitAgentRunRequest({
      sessionId: 's1', prompt: '', mode: 'ask', modelConfigId: 'm1',
      contextSnapshotId: 'c1', attachments: [], resources: []
    }),
    EditorCatalogDecodeError
  );
  const tooMany = Array.from({ length: 9 }, (_, i) => ({
    token: `tok-${i}`, mediaType: 'image/png', byteLength: 100, expiresAt: '2026-08-13T00:00:00Z'
  }));
  assert.throws(
    () => decodeSubmitAgentRunRequest({
      sessionId: 's1', prompt: 'hi', mode: 'ask', modelConfigId: 'm1',
      contextSnapshotId: 'c1', attachments: tooMany, resources: []
    }),
    EditorCatalogDecodeError
  );
});

test('reduceAgentComposer: 固定允许转换', () => {
  const s0 = reduceAgentComposer({ kind: 'idle', prompt: '' }, { type: 'PROMPT_CHANGED', prompt: 'p' });
  assert.equal(s0.state.kind, 'composing');
  const s1 = reduceAgentComposer(s0.state, { type: 'SUBMIT', runId: 'r1' });
  assert.equal(s1.state.kind, 'submitting');
  const s2 = reduceAgentComposer(s1.state, { type: 'STREAM_STARTED', runId: 'r1' });
  assert.equal(s2.state.kind, 'streaming');
  const s3 = reduceAgentComposer(s2.state, { type: 'TOOL_STARTED', runId: 'r1', toolActivityId: 't1' });
  assert.equal(s3.state.kind, 'tool-running');
  const s4 = reduceAgentComposer(s3.state, { type: 'TOOL_FINISHED', runId: 'r1' });
  assert.equal(s4.state.kind, 'streaming');
  const s5 = reduceAgentComposer(s4.state, { type: 'APPROVAL_REQUIRED', runId: 'r1', reviewId: 'rv1' });
  assert.equal(s5.state.kind, 'awaiting-approval');
  const s6 = reduceAgentComposer(s5.state, { type: 'APPROVE', runId: 'r1', reviewId: 'rv1' });
  assert.equal(s6.state.kind, 'committing');
  const s7 = reduceAgentComposer(s6.state, { type: 'COMMIT_FINISHED', runId: 'r1', reviewId: 'rv1' });
  assert.equal(s7.state.kind, 'verifying');
  const s8 = reduceAgentComposer(s7.state, { type: 'VERIFY_FINISHED', runId: 'r1', reviewId: 'rv1' });
  assert.equal(s8.state.kind, 'idle');
});

test('reduceAgentComposer: 非法转换返回原状态并记录诊断', () => {
  const s0 = reduceAgentComposer({ kind: 'idle', prompt: '' }, { type: 'SUBMIT', runId: 'r1' });
  assert.equal(s0.state.kind, 'idle');
  assert.equal(s0.diagnostic?.code, 'ILLEGAL_TRANSITION');
  const s1 = reduceAgentComposer({ kind: 'composing', prompt: 'p' }, { type: 'STOP', runId: 'r1' });
  assert.equal(s1.state.kind, 'composing');
  assert.ok(s1.diagnostic);
});

test('reduceAgentComposer: FAIL/STOP 只作用于活动态, REJECT → idle', () => {
  const f = reduceAgentComposer({ kind: 'streaming', runId: 'r1' }, { type: 'FAIL', prompt: 'p', reasonCode: 'timeout' });
  assert.equal(f.state.kind, 'failed');
  const reset = reduceAgentComposer(f.state, { type: 'RESET' });
  assert.equal(reset.state.kind, 'idle');
  const reject = reduceAgentComposer({ kind: 'awaiting-approval', runId: 'r1', reviewId: 'rv1' }, { type: 'REJECT', runId: 'r1', reviewId: 'rv1' });
  assert.equal(reject.state.kind, 'idle');
  const stopFromIdle = reduceAgentComposer({ kind: 'idle', prompt: '' }, { type: 'STOP', runId: 'r1' });
  assert.equal(stopFromIdle.state.kind, 'idle');
  assert.ok(stopFromIdle.diagnostic);
});

test('EditorCatalogSnapshot 全链解码(含 history/projection)', () => {
  const snapshot = {
    catalogRevision: 'rev-snap-1',
    libraries: summaryFixture.libraries,
    banks: summaryFixture.banks,
    documents: summaryFixture.documents.map(({ effectiveVariantId: _omit, ...d }) => ({
      ...d,
      effectiveVariant: {
        variantId: 'variant-primary-1', precedence: 100, contentHash: 'abc', sourceRevision: 'rev-0', provenanceDigest: null,
        role: 'primary', sourceLayer: 'overlay', recoveryOfResourceId: null
      },
      alternateVariantIds: []
    })),
    history: [
      {
        variantId: 'variant-bak-1', precedence: 50, contentHash: 'def', sourceRevision: null, provenanceDigest: null,
        role: 'backup', sourceLayer: 'history', recoveryOfResourceId: 'res-gameparam'
      }
    ],
    projections: []
  };
  const decoded = decodeEditorCatalogSnapshot(snapshot);
  assert.equal(decoded.history.length, 1);
  assert.equal(decoded.history[0]!.role, 'backup');
  assert.equal(decoded.documents[0]!.effectiveVariant.sourceLayer, 'overlay');
});

test('primary/base 变体不允许 recoveryOfResourceId 非 null', () => {
  assert.throws(
    () => decodeEditorCatalogSnapshot({
      catalogRevision: 'r',
      libraries: [],
      banks: [],
      documents: [],
      history: [
        {
          variantId: 'v', precedence: 1, contentHash: null, sourceRevision: null, provenanceDigest: null,
          role: 'primary', sourceLayer: 'overlay', recoveryOfResourceId: 'x'
        }
      ],
      projections: []
    }),
    EditorCatalogDecodeError
  );
});

test('DomainSummary decoder 拒绝 defaultTarget 路径字段', () => {
  assert.throws(
    () => decodeDomainSummary({
      domain: 'param', label: 'PARAM', visibility: 'visible', capability: 'read-ready',
      defaultTarget: {
        resourceId: 'C:\\Users\\asus\\gameparam.parambnd.dcx', domain: 'param',
        libraryId: 'game-parameters', bankId: null, documentId: 'd', sourceVariant: 'overlay'
      }
    }),
    EditorCatalogDecodeError
  );
});

// ---------------------------------------------------------------------------
// ROUTE-06：resolveIntegrationForConfirmedLeaf 只解释 priority-900
// confirmed-leaf 注册表，不产生自由分支（front-end.md §5.1/§4.4）。
// ---------------------------------------------------------------------------

test('ROUTE-06: confirmed leaf 按注册表解析为 integration', () => {
  const gameparam = resolveIntegrationForConfirmedLeaf('bnd4', 'gameparam-binder', 'gameparam-primary');
  assert.deepEqual(gameparam, { domain: 'param', integrationId: 'param-editor', libraryKey: 'game-parameters' });

  const gparam = resolveIntegrationForConfirmedLeaf('gparam', 'none', 'map-bank');
  assert.deepEqual(gparam, { domain: 'gparam', integrationId: 'gparam-editor', libraryKey: 'draw-graphics-parameters' });

  const msgbnd = resolveIntegrationForConfirmedLeaf('bnd4', 'msg-binder', null);
  assert.deepEqual(msgbnd, { domain: 'text', integrationId: 'text-editor', libraryKey: 'game-text' });

  const fmg = resolveIntegrationForConfirmedLeaf('fmg', 'none', 'loose-table');
  assert.deepEqual(fmg, { domain: 'text', integrationId: 'text-editor', libraryKey: 'loose-text' });

  const emevd = resolveIntegrationForConfirmedLeaf('emevd', 'none', null);
  assert.deepEqual(emevd, { domain: 'event', integrationId: 'event-editor', libraryKey: 'events' });

  const msb = resolveIntegrationForConfirmedLeaf('msb', 'none', null);
  assert.deepEqual(msb, { domain: 'map', integrationId: 'map-editor', libraryKey: 'maps' });

  const tpf = resolveIntegrationForConfirmedLeaf('tpf', 'none', null);
  assert.deepEqual(tpf, { domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' });

  const genericBnd4 = resolveIntegrationForConfirmedLeaf('bnd4', 'generic-binder', null);
  assert.deepEqual(genericBnd4, { domain: 'container', integrationId: 'container-editor', libraryKey: 'containers' });
});

test('ROUTE-06: 未确认 / 角色错配 / 语义子类型错配 → null', () => {
  // containerRole 决定具体规则：generic-binder 命中 generic-bnd4-confirmed，
  // 不会因 subtype 写着 gameparam-primary 而被 gameparam-confirmed 误选。
  assert.deepEqual(
    resolveIntegrationForConfirmedLeaf('bnd4', 'generic-binder', 'gameparam-primary'),
    { domain: 'container', integrationId: 'container-editor', libraryKey: 'containers' }
  );
  // semanticSubtype 错配
  assert.equal(resolveIntegrationForConfirmedLeaf('gparam', 'none', 'loose-table'), null);
  // containerRole 宽容：gparam 规则不要求 containerRole，与 leaf 一并确认即匹配
  assert.deepEqual(
    resolveIntegrationForConfirmedLeaf('gparam', 'drawparam-binder', 'map-bank'),
    { domain: 'gparam', integrationId: 'gparam-editor', libraryKey: 'draw-graphics-parameters' }
  );
  // 800 级 child 规则不参与解析（child 由容器导航呈现，不是独立路由）
  assert.equal(resolveIntegrationForConfirmedLeaf('param', 'drawparam-binder', null), null);
  // bnd4 但没有任何已注册 binder 角色 → 不匹配任何 900 规则
  assert.equal(resolveIntegrationForConfirmedLeaf('bnd4', 'none', null), null);
});
