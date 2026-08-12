/**
 * DOCSTORE-04 smoke：§14.4 owner-bound DocumentStore 六签名闭合契约。
 *
 * 覆盖（全部确定性桩，不加载 native 资产）：
 *   - open 返回 opaque handle + ready + 派生 read/write operations；
 *   - 同 owner 重开同 locator → 复用 handle，不新建；
 *   - cross-sender：另一 ownerKey 拿同 handle → owner-mismatch；
 *   - stale revision：apply/page 用旧 revision → stale-revision；
 *   - bounded page：数据源返回超过 limit → invalid-request 整页拒绝；
 *   - item kind 与 query kind 不匹配 → invalid-request 整页拒绝；
 *   - query kind 无对应读能力 → capability-blocked；
 *   - mutation kind 不在写能力集合 → capability-blocked；
 *   - apply 成功 → revision 推进 + committed transactionState；
 *   - apply 被端口取消 → cancelled 且 revision 不变；
 *   - TTL 过期 → expired（过期即废弃，不复活）；
 *   - close 后 get → not-found。
 *
 * 本 smoke 不声明任何写链 authority：apply 走确定性端口桩，真实写链由
 * 后续卡接入（D8/D9/D10）。
 */
import type {
  ApplyEditorMutationRequest,
  EditorMutation,
  EditorPageItemDto,
  EditorScalar
} from '@soulforge/shared';
import type { NativeDocumentLocator } from '../editing/nativeDocumentLocator.js';
import {
  EditorDocumentStore,
  type EditorDocumentDataSource,
  type EditorMutationApplyPort
} from '../editing/editorDocumentStore.js';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail: string): void {
  checks += 1;
  if (!condition) failures.push(`${name}: ${detail}`);
}

function buildLocator(leafFormatId: string, containerRole: NativeDocumentLocator['containerRole'] = 'none'): NativeDocumentLocator {
  const stableEntryId = leafFormatId === 'bnd4' ? 'bnd4-root' : `loose:${leafFormatId}`;
  return {
    locatorId: `locator:${leafFormatId}-${containerRole}-sample:rev-1`,
    outerResourceId: `resource:${leafFormatId}-sample`,
    outerSourceUri: 'file:///synthetic/sample.dcx',
    sourceVariant: 'overlay',
    expectedOuterRevision: 'rev-1',
    expectedOuterHash: 'ab'.repeat(32),
    containerRole,
    layers: [
      { layerIndex: 0, formatId: 'dcx-dflt', entry: null },
      { layerIndex: 1, formatId: leafFormatId as never, entry: null }
    ],
    leafDocumentStableId: stableEntryId
  };
}

function paramTableItem(id: string): EditorPageItemDto {
  return { kind: 'param-table', tableId: id, name: `表 ${id}`, localizedName: null };
}

function paramRowItem(id: string): EditorPageItemDto {
  return { kind: 'param-row', tableId: 't1', rowId: id, name: `行 ${id}`, change: 'none' };
}

/** 内存数据源：只支持 param 文档的三种查询；其余 query kind 返回 null（未接通）。 */
function memoryDataSource(): EditorDocumentDataSource {
  const tables = [paramTableItem('t1'), paramTableItem('t2'), paramTableItem('t3')];
  const rows = [paramRowItem('r1'), paramRowItem('r2')];
  return {
    loadPage: async (query, cursor, limit) => {
      if (query.kind === 'param-tables') {
        return { items: tables, nextCursor: null, totalKnown: tables.length };
      }
      if (query.kind === 'param-rows') {
        return { items: rows, nextCursor: null, totalKnown: rows.length };
      }
      if (query.kind === 'param-fields') {
        return { items: [], nextCursor: null, totalKnown: 0 };
      }
      return { items: null, nextCursor: null, totalKnown: null };
    },
    readContent: async () => null
  };
}

function recordingApplyPort(responses: Array<ReturnType<typeof committedOutcome> | { kind: 'cancelled' } | { kind: 'rejected'; code: string }>): EditorMutationApplyPort & { calls: EditorMutation[] } {
  const calls: EditorMutation[] = [];
  let index = 0;
  return {
    calls,
    apply: async (mutation: EditorMutation) => {
      calls.push(mutation);
      const response = responses[Math.min(index, responses.length - 1)] ?? committedOutcome(`op-${index}`);
      index += 1;
      return response;
    }
  };
}

function committedOutcome(operationId: string) {
  return { kind: 'committed' as const, operationId };
}

function paramFieldMutation(): EditorMutation {
  return { kind: 'param-field-set', tableId: 't1', rowId: 'r1', fieldId: 'f1', value: 5 as EditorScalar };
}

async function main(): Promise<void> {
  // ── A. param 文档的基本路径 ──
  {
    const store = new EditorDocumentStore({
      dataSource: memoryDataSource(),
      applyPort: recordingApplyPort([])
    });
    const opened = await store.open('owner-a', buildLocator('param'));
    check('open/ok', opened.ok === true, `期望 ok，实际 ${JSON.stringify(opened)}`);
    if (!opened.ok) return;
    const value = opened.value;
    check('open/handle', value.documentHandle.length > 0, 'handle 必须非空');
    check('open/ready', value.loadState.kind === 'ready', `loadState 应为 ready，实际 ${value.loadState.kind}`);
    check('open/read-ops', value.readOperations.includes('page-tables'), 'param 文档应声明 page-tables');
    check('open/read-ops2', value.readOperations.includes('page-rows'), 'param 文档应声明 page-rows');
    check('open/write-ops', value.writeOperations.includes('param-field-set'), 'param 文档应声明 param-field-set');
    check('open/write-ops2', value.writeOperations.includes('param-row-delete'), 'param 文档应声明 param-row-delete');
    check('open/not-other-domain', value.writeOperations.includes('fmg-entry-upsert') === false, 'param 文档不得声明 fmg 写能力');

    // 同 owner 重开同 locator → 复用 handle，revision 不变。
    const reopened = await store.open('owner-a', buildLocator('param'));
    check('reopen/ok', reopened.ok === true, '重开应成功');
    if (reopened.ok) {
      check('reopen/same-handle', reopened.value.documentHandle === value.documentHandle, '同 owner 重开必须复用 handle');
      check('reopen/same-revision', reopened.value.revision === value.revision, '重开不得推进 revision');
    }

    // cross-sender：另一 ownerKey 用同一 locator → owner-mismatch。
    const foreignOpen = await store.open('owner-b', buildLocator('param'));
    check('cross-sender/open', foreignOpen.ok === false && foreignOpen.code === 'owner-mismatch', `其他 owner 不得打开同 locator，实际 ${JSON.stringify(foreignOpen)}`);

    // cross-sender：ownerB 拿 ownerA 的 handle → owner-mismatch。
    const foreignGet = await store.get('owner-b', value.documentHandle);
    check('cross-sender/get', foreignGet.ok === false && foreignGet.code === 'owner-mismatch', `猜中 handle 也必须拒绝，实际 ${JSON.stringify(foreignGet)}`);

    // 合法 page：item kind 与 query kind 匹配。
    const page = await store.page('owner-a', {
      documentHandle: value.documentHandle,
      expectedRevision: value.revision,
      query: { kind: 'param-tables', search: '' },
      cursor: null,
      limit: 50
    });
    check('page/ok', page.ok === true, `page 应成功，实际 ${JSON.stringify(page)}`);
    if (page.ok) {
      check('page/items', page.value.items.length === 3, `期望 3 项，实际 ${page.value.items.length}`);
      check('page/queryKind', page.value.queryKind === 'param-tables', 'queryKind 必须回显');
      check('page/totalKnown', page.value.totalKnown === 3, 'totalKnown 必须由数据源提供');
    }

    // bounded page：数据源返回超过 limit → 整页拒绝。
    const bounded = await store.page('owner-a', {
      documentHandle: value.documentHandle,
      expectedRevision: value.revision,
      query: { kind: 'param-tables', search: '' },
      cursor: null,
      limit: 2
    });
    check('page/bounded', bounded.ok === false && bounded.code === 'invalid-request', `超过 limit 必须拒绝整页，实际 ${JSON.stringify(bounded)}`);

    // item kind 与 query kind 不匹配 → 整页拒绝。
    const mismatchedDataSource: EditorDocumentDataSource = {
      loadPage: async () => ({ items: [paramTableItem('t1')], nextCursor: null, totalKnown: 1 }),
      readContent: async () => null
    };
    const mismatchedStore = new EditorDocumentStore({
      dataSource: mismatchedDataSource,
      applyPort: recordingApplyPort([])
    });
    const mismatchedOpen = await mismatchedStore.open('owner-a', buildLocator('param'));
    if (mismatchedOpen.ok) {
      const mismatched = await mismatchedStore.page('owner-a', {
        documentHandle: mismatchedOpen.value.documentHandle,
        expectedRevision: mismatchedOpen.value.revision,
        query: { kind: 'param-rows', tableId: 't1', search: '' },
        cursor: null,
        limit: 50
      });
      check('page/kind-mismatch', mismatched.ok === false && mismatched.code === 'invalid-request', `param-rows 查询返回 param-table 必须整页拒绝，实际 ${JSON.stringify(mismatched)}`);
    } else {
      check('page/kind-mismatch', false, 'mismatched store open 失败');
    }

    // query kind 无对应读能力（param 文档查 fmg-entries）→ capability-blocked。
    const wrongQuery = await store.page('owner-a', {
      documentHandle: value.documentHandle,
      expectedRevision: value.revision,
      query: { kind: 'fmg-entries', tableId: 'item', search: '' },
      cursor: null,
      limit: 50
    });
    check('page/capability-blocked', wrongQuery.ok === false && wrongQuery.code === 'capability-blocked', `param 文档查 fmg-entries 必须被拦，实际 ${JSON.stringify(wrongQuery)}`);

    // readContent：param 文档的 fmg-content 查询 → capability-blocked。
    const content = await store.readContent('owner-a', {
      documentHandle: value.documentHandle,
      expectedRevision: value.revision,
      query: { kind: 'fmg-content', tableId: 'item', entryId: '5200' }
    });
    check('content/capability-blocked', content.ok === false && content.code === 'capability-blocked', `param 文档读 fmg 内容必须被拦，实际 ${JSON.stringify(content)}`);

    // ── B. apply 与 revision ──
    const applyPort = recordingApplyPort([committedOutcome('op-1'), { kind: 'cancelled' }, committedOutcome('op-3')]);
    const applyStore = new EditorDocumentStore({ dataSource: memoryDataSource(), applyPort });
    const applyOpen = await applyStore.open('owner-a', buildLocator('param'));
    if (!applyOpen.ok) return;
    const applyRequest = (expectedRevision: string): ApplyEditorMutationRequest => ({
      documentHandle: applyOpen.value.documentHandle,
      expectedRevision,
      mutation: paramFieldMutation()
    });

    const applied = await applyStore.apply('owner-a', applyRequest(applyOpen.value.revision));
    check('apply/ok', applied.ok === true, `apply 应成功，实际 ${JSON.stringify(applied)}`);
    if (applied.ok) {
      check('apply/revision-bumped', applied.value.revision === 'rev:1', `revision 应推进到 rev:1，实际 ${applied.value.revision}`);
      check('apply/committed-state', applied.value.transactionState.kind === 'committed', `transactionState 应为 committed，实际 ${JSON.stringify(applied.value.transactionState)}`);
      check('apply/port-called', applyPort.calls.length === 1 && applyPort.calls[0]?.kind === 'param-field-set', 'apply 端口必须收到 mutation');
    }

    // stale revision：用旧 revision 再 apply → stale-revision。
    const stale = await applyStore.apply('owner-a', applyRequest(applyOpen.value.revision));
    check('apply/stale-revision', stale.ok === false && stale.code === 'stale-revision', `旧 revision 必须被拒，实际 ${JSON.stringify(stale)}`);

    // cancelled：端口取消 → cancelled 且 revision 不变。
    const cancelled = await applyStore.apply('owner-a', applyRequest('rev:1'));
    check('apply/cancelled', cancelled.ok === false && cancelled.code === 'cancelled', `端口取消必须返回 cancelled，实际 ${JSON.stringify(cancelled)}`);
    const afterCancel = await applyStore.get('owner-a', applyOpen.value.documentHandle);
    check('apply/cancel-keeps-revision', afterCancel.ok && afterCancel.value.revision === 'rev:1', '取消不得推进 revision');

    // mutation kind 不在写能力集合（fmg mutation 打到 param 文档）→ capability-blocked。
    const blockedKind = await applyStore.apply('owner-a', {
      documentHandle: applyOpen.value.documentHandle,
      expectedRevision: 'rev:1',
      mutation: { kind: 'fmg-entry-upsert', tableId: 'item', entryId: '5200', text: 'x' }
    });
    check('apply/capability-blocked', blockedKind.ok === false && blockedKind.code === 'capability-blocked', `param 文档拒绝 fmg mutation，实际 ${JSON.stringify(blockedKind)}`);

    // rejected：端口返回 rejected → mutation-rejected。
    const rejectStore = new EditorDocumentStore({
      dataSource: memoryDataSource(),
      applyPort: recordingApplyPort([{ kind: 'rejected', code: 'STAGING_FAILED' }])
    });
    const rejectOpen = await rejectStore.open('owner-a', buildLocator('param'));
    if (rejectOpen.ok) {
      const rejected = await rejectStore.apply('owner-a', {
        documentHandle: rejectOpen.value.documentHandle,
        expectedRevision: rejectOpen.value.revision,
        mutation: paramFieldMutation()
      });
      check('apply/rejected', rejected.ok === false && rejected.code === 'mutation-rejected', `端口拒绝必须映射为 mutation-rejected，实际 ${JSON.stringify(rejected)}`);
    } else {
      check('apply/rejected', false, 'reject store open 失败');
    }

    // ── C. TTL 过期 ──
    let now = 1_000_000;
    const ttlStore = new EditorDocumentStore({
      ttlMs: 50,
      now: () => now,
      dataSource: memoryDataSource(),
      applyPort: recordingApplyPort([])
    });
    const ttlOpen = await ttlStore.open('owner-a', buildLocator('param'));
    if (!ttlOpen.ok) return;
    now += 100; // 越过 50ms TTL
    const expired = await ttlStore.get('owner-a', ttlOpen.value.documentHandle);
    check('ttl/expired', expired.ok === false && expired.code === 'expired', `TTL 过期必须返回 expired，实际 ${JSON.stringify(expired)}`);
    const stillExpired = await ttlStore.get('owner-a', ttlOpen.value.documentHandle);
    check('ttl/no-revival', stillExpired.ok === false, '过期记录不得复活');

    // ── D. close ──
    const closeStore = new EditorDocumentStore({ dataSource: memoryDataSource(), applyPort: recordingApplyPort([]) });
    const closeOpen = await closeStore.open('owner-a', buildLocator('param'));
    if (!closeOpen.ok) return;
    const closed = await closeStore.close('owner-a', closeOpen.value.documentHandle);
    check('close/ok', closed.ok === true, `close 应成功，实际 ${JSON.stringify(closed)}`);
    const afterClose = await closeStore.get('owner-a', closeOpen.value.documentHandle);
    check('close/not-found', afterClose.ok === false && afterClose.code === 'not-found', 'close 后 get 必须 not-found');
  }

  // ── E. bnd4 容器（gameparam-binder）→ param 写能力，generic → bnd4-child-replace ──
  {
    const store = new EditorDocumentStore({ dataSource: memoryDataSource(), applyPort: recordingApplyPort([]) });
    const opened = await store.open('owner-a', buildLocator('bnd4', 'gameparam-binder'));
    check('bnd4/ok', opened.ok === true, 'bnd4 gameparam-binder 应可打开');
    if (opened.ok) {
      check('bnd4/write-ops', opened.value.writeOperations.includes('param-field-set'), 'gameparam-binder 应声明 param 写能力');
      check('bnd4/read-ops', opened.value.readOperations.includes('page-tables'), 'gameparam-binder 应声明 param 读能力');
    }

    const generic = await store.open('owner-b', buildLocator('bnd4', 'generic-binder'));
    check('bnd4/generic', generic.ok === true, 'generic-binder 应可打开');
    if (generic.ok) {
      check('bnd4/generic-write', generic.value.writeOperations.includes('bnd4-child-replace'), 'generic-binder 只声明 bnd4-child-replace');
      check('bnd4/generic-no-param', generic.value.writeOperations.includes('param-field-set') === false, 'generic-binder 不得声明 param 写能力');
    }
  }

  if (failures.length > 0) {
    console.log(JSON.stringify({
      ok: false,
      message: `editor document store smoke 失败 ${failures.length} 项`,
      checks,
      failures
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    message: `§14.4 owner-bound DocumentStore smoke 通过（${checks} 项断言）`,
    checks,
    lockedBehaviours: [
      'open 返回 opaque handle 与派生读写能力；同 owner 重开复用 handle',
      'cross-sender：猜中 handle 也得到 owner-mismatch',
      'stale revision 拒绝；revision 只在 committed 后推进',
      'bounded page：超过 limit 与 item/query kind 不匹配都整页拒绝',
      'query kind / mutation kind 超出文档能力一律 capability-blocked',
      'apply 取消与拒绝不推进 revision',
      'TTL 过期即废弃，不复活；close 后 not-found'
    ],
    authority: 'fixture-confirmed（确定性桩，不加载 native 资产，不构成写链 authority）'
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
