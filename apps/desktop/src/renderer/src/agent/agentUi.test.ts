/**
 * AGENT-60C 纯逻辑测试：§12.8/§12.11 的 renderer 安全判定。
 *
 * 覆盖卡片 Tests：
 *  - 切换 editor 不改变已发送 snapshot（freezeAgentSelectionSnapshot 深度冻结）；
 *  - 跨 sender token/handle 拒绝（validateAgentReferenceScope SENDER_MISMATCH）；
 *  - 绝对路径、raw parser / Hex 不进入 DTO（selectionRendererSafetyIssues 负向）；
 *  - 重复 / 倒序 seq 不重放（reduceAgentStreamToMessages / applyAgentStreamSeq）；
 *  - message pages（sliceAgentMessagePage / agentMessageTail / append…：
 *    运输分页，消息全量保留）。
 *
 * 无 DOM、无 IPC；DOM 侧负向断言在 agentSidebarRender.test.tsx。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentMessageDto, AgentStreamEvent, EditorSelectionContext } from '@soulforge/shared';
import {
  AGENT_MESSAGE_PAGE_SIZE,
  AGENT_RESUME_TAIL_MESSAGES,
  AGENT_SCROLL_THRESHOLD_PX,
  agentMessageTail,
  agentMessageWindow,
  agentOlderCursor,
  agentResumeStartIndex,
  agentSelectionSummary,
  appendAgentMessagePage,
  applyAgentStreamSeq,
  buildAgentResumePageRequest,
  clampAgentMessagePageLimit,
  createAgentStreamSeqState,
  decodeAgentContextSnapshot,
  freezeAgentSelectionSnapshot,
  isSelectionRendererSafe,
  isSelectionSnapshotFrozen,
  mintAgentReferenceToken,
  parseAgentReferenceToken,
  reduceAgentStreamToMessages,
  selectionRendererSafetyIssues,
  shouldAgentAutoScroll,
  isAgentScrollNearTop,
  sliceAgentMessagePage,
  validateAgentReferenceScope
} from '@soulforge/shared';

function selection(overrides: Partial<EditorSelectionContext>): EditorSelectionContext {
  return {
    domain: 'param',
    libraryId: null,
    bankId: null,
    documentId: null,
    paramTableId: null,
    rowId: null,
    fieldId: null,
    fmgEntryId: null,
    eventId: null,
    cursor: null,
    revision: null,
    ...overrides
  };
}

function makeAssistantMessage(id: string, markdown: string, streaming = false): AgentMessageDto {
  return { id, kind: 'assistant', markdown, streaming, createdAt: '2026-01-01T00:00:00.000Z' };
}

function makeUserMessage(id: string, text: string): AgentMessageDto {
  return { id, kind: 'user', text, contextSnapshotId: 'snap-x', createdAt: '2026-01-01T00:00:00.000Z' };
}

function makeMessages(count: number): AgentMessageDto[] {
  return Array.from({ length: count }, (_, index) => makeAssistantMessage(`m${index}`, `body-${index}`));
}

function assistantMarkdown(messages: readonly AgentMessageDto[], id: string): string | null {
  const message = messages.find((item) => item.id === id);
  return message !== undefined && message.kind === 'assistant' ? message.markdown : null;
}

function assistantStreaming(messages: readonly AgentMessageDto[], id: string): boolean | null {
  const message = messages.find((item) => item.id === id);
  return message !== undefined && message.kind === 'assistant' ? message.streaming : null;
}

describe('§12.8 选区快照冻结：切换 editor 不改变已发送 snapshot', () => {
  it('冻结后改动源选区不影响已发送快照，且快照深度冻结', () => {
    const source = selection({ documentId: 'm12b/param/gameparam.parambnd.dcx', paramTableId: 'chr_model' });
    const snapshot = freezeAgentSelectionSnapshot(source, {
      snapshotId: 'snap-1',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    assert.equal(snapshot.selection.documentId, 'm12b/param/gameparam.parambnd.dcx');
    assert.ok(isSelectionSnapshotFrozen(snapshot), '快照与 selection 都应深度冻结');
    if (snapshot.selection.cursor !== null) {
      assert.ok(Object.isFrozen(snapshot.selection.cursor), 'cursor 子对象也应冻结');
    }

    // 模拟「切换编辑器」：构造另一份选区，已发送快照必须仍是原来的文档。
    const other = selection({ documentId: 'another/doc.dcx', paramTableId: 'other' });
    assert.equal(snapshot.selection.documentId, 'm12b/param/gameparam.parambnd.dcx');
    assert.equal(snapshot.selection.paramTableId, 'chr_model');
    void other;

    // 带 cursor 的选区：cursor 子对象同样深度冻结。
    const withCursor = freezeAgentSelectionSnapshot(
      selection({ documentId: 'm12b/fmg/fmg_item.msgbnd.dcx', cursor: { line: 12, column: 3 } }),
      { snapshotId: 'snap-c', createdAt: '2026-01-01T00:00:00.000Z' }
    );
    assert.ok(Object.isFrozen(withCursor.selection.cursor as object), 'cursor 子对象应冻结');
    assert.equal((withCursor.selection.cursor as { line: number }).line, 12);
  });

  it('decodeAgentContextSnapshot 往返一致并拒绝未知字段与绝对路径', () => {
    const snapshot = freezeAgentSelectionSnapshot(
      selection({ documentId: 'm12b/param/gameparam.parambnd.dcx' }),
      { snapshotId: 'snap-2', createdAt: '2026-01-01T00:00:00.000Z' }
    );
    const decoded = decodeAgentContextSnapshot(JSON.parse(JSON.stringify(snapshot)));
    assert.equal(decoded.snapshotId, 'snap-2');
    assert.equal(decoded.selection.documentId, 'm12b/param/gameparam.parambnd.dcx');
    assert.throws(() => decodeAgentContextSnapshot({ ...decoded, extra: 1 }), /unknown field/);
    assert.throws(
      () => decodeAgentContextSnapshot({ ...decoded, selection: { ...decoded.selection, documentId: 'D:\\x\\y.parambnd.dcx' } }),
      /absolute path/
    );
  });
});

describe('跨 sender token/handle 拒绝', () => {
  it('A sender 签发的资源 token 被 B sender 提交时拒绝', () => {
    const token = mintAgentReferenceToken({
      kind: 'resource',
      tokenId: 'tok-1',
      ownerId: 'sender-A',
      domain: 'param',
      label: 'PARAM · 文档'
    });
    const own = validateAgentReferenceScope(token, 'sender-A');
    assert.ok(own.ok, '同一 sender 提交应通过');
    const cross = validateAgentReferenceScope(token, 'sender-B');
    assert.ok(!cross.ok, '跨 sender 必须拒绝');
    if (!cross.ok) assert.equal(cross.code, 'AGENT_TOKEN_SENDER_MISMATCH');
  });

  it('过期 token 拒绝', () => {
    const token = mintAgentReferenceToken({ kind: 'resource', tokenId: 'tok-2', ownerId: 'sender-A', now: 1_000, ttlMs: 500 });
    const result = validateAgentReferenceScope(token, 'sender-A', 2_000);
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.code, 'AGENT_TOKEN_EXPIRED');
  });

  it('token 载荷不携带路径（opaque，可解析出逻辑元数据）', () => {
    const token = mintAgentReferenceToken({
      kind: 'resource',
      tokenId: 'tok-3',
      ownerId: 'sender-A',
      domain: 'param',
      label: 'PARAM · 文档',
      now: 1_000,
      ttlMs: 60_000
    });
    assert.ok(token.startsWith('agent-ref:'), 'token 带可识别前缀');
    assert.ok(!/[\\/]/.test(token), 'token 字符串不应包含路径分隔符');
    const parsed = parseAgentReferenceToken(token);
    assert.equal(parsed.tokenId, 'tok-3');
    assert.equal(parsed.ownerId, 'sender-A');
    assert.equal(parsed.label, 'PARAM · 文档');
    assert.equal(parsed.kind, 'resource');
    assert.equal(parsed.exp, 61_000);
  });

  it('格式非法 token 拒绝并给结构化诊断', () => {
    const result = validateAgentReferenceScope('agent-ref:not-base64', 'sender-A');
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.code, 'AGENT_TOKEN_MALFORMED');
  });
});

describe('renderer 安全白名单：绝对路径 / raw parser / Hex 不进入 DTO', () => {
  it('绝对路径进入任一字符串字段即拒绝', () => {
    const drive = selection({ documentId: 'D:\\mystream\\Sekiro\\param\\gameparam.parambnd.dcx' });
    assert.ok(selectionRendererSafetyIssues(drive).some((issue) => issue.code === 'AGENT_SELECTION_ABSOLUTE_PATH'));
    assert.ok(!isSelectionRendererSafe(drive));

    const unc = selection({ documentId: '\\\\server\\share\\param.parambnd.dcx' });
    assert.ok(selectionRendererSafetyIssues(unc).some((issue) => issue.code === 'AGENT_SELECTION_ABSOLUTE_PATH'));

    const posix = selection({ documentId: '/home/user/sekiro/param.parambnd.dcx' });
    assert.ok(selectionRendererSafetyIssues(posix).some((issue) => issue.code === 'AGENT_SELECTION_ABSOLUTE_PATH'));
  });

  it('整行 hex dump 与 raw parser 标记拒绝', () => {
    const hex = selection({ documentId: '40 00 00 00 2C 01 00 00 00 00 00 00' });
    assert.ok(selectionRendererSafetyIssues(hex).some((issue) => issue.code === 'AGENT_SELECTION_HEX_DUMP'));

    const raw = selection({ documentId: 'raw://m12b/param/x.parambnd#hex' });
    assert.ok(selectionRendererSafetyIssues(raw).some((issue) => issue.code === 'AGENT_SELECTION_RAW_PARSER'));
  });

  it('相对路径与逻辑 id 是安全的', () => {
    const safe = selection({ documentId: 'm12b/param/gameparam.parambnd.dcx', paramTableId: 'chr_model', revision: 'sha256like' });
    assert.deepEqual(selectionRendererSafetyIssues(safe), []);
    assert.ok(isSelectionRendererSafe(safe));
  });

  it('agentSelectionSummary 是 opaque 摘要，不含路径字段', () => {
    assert.equal(agentSelectionSummary(null), '未选择逻辑资源');
    const summary = agentSelectionSummary(selection({ documentId: 'm12b/param/gameparam.parambnd.dcx' }));
    assert.match(summary, /^param · /);
    assert.ok(!/^[A-Za-z]:[\\/]/.test(summary), '摘要不应以盘符开头');
  });
});

describe('§12.11 严格 event seq：重复 / 倒序 seq 不重放', () => {
  it('重复与倒序事件被丢弃并记诊断，delta 不重放', () => {
    const events: AgentStreamEvent[] = [
      { seq: 1, sessionId: 's1', kind: 'message-started', message: makeAssistantMessage('m2', '', true) },
      { seq: 2, sessionId: 's1', kind: 'message-delta', messageId: 'm2', delta: 'a' },
      { seq: 2, sessionId: 's1', kind: 'message-finished', messageId: 'm2' },
      { seq: 1, sessionId: 's1', kind: 'message-delta', messageId: 'm2', delta: 'b' },
      { seq: 3, sessionId: 's1', kind: 'message-delta', messageId: 'm2', delta: 'c' },
      { seq: 4, sessionId: 's1', kind: 'message-finished', messageId: 'm2' }
    ];
    const result = reduceAgentStreamToMessages(events);
    assert.equal(result.dropped.length, 2, '应丢弃一条重复 + 一条倒序');
    assert.deepEqual(
      result.dropped.map((diagnostic) => diagnostic.code).sort(),
      ['DUPLICATE_SEQ', 'REVERSED_SEQ']
    );
    assert.equal(assistantMarkdown(result.messages, 'm2'), 'ac', '重复/倒序的 delta 不得重放');
    assert.equal(assistantStreaming(result.messages, 'm2'), false, 'message-finished 只应用一次');
  });

  it('applyAgentStreamSeq 对每个 session 独立跟踪', () => {
    const first = applyAgentStreamSeq(createAgentStreamSeqState(), { sessionId: 'sA', seq: 1 });
    assert.ok(first.verdict.accepted);
    const second = applyAgentStreamSeq(first.state, { sessionId: 'sB', seq: 1 });
    assert.ok(second.verdict.accepted, '不同 session 的 seq 互不干扰');
    const dupInA = applyAgentStreamSeq(second.state, { sessionId: 'sA', seq: 1 });
    assert.ok(!dupInA.verdict.accepted, '同一 session 重复 seq 拒绝');
    const nextInA = applyAgentStreamSeq(dupInA.state, { sessionId: 'sA', seq: 2 });
    assert.ok(nextInA.verdict.accepted);
  });
});

describe('message pages（运输分页；消息全量保留）', () => {
  it('sliceAgentMessagePage 按 limit 分页，nextCursor 指示后续', () => {
    const messages = makeMessages(120);
    const page1 = sliceAgentMessagePage(messages, null, AGENT_MESSAGE_PAGE_SIZE);
    assert.equal(page1.items.length, 50);
    assert.equal(page1.nextCursor, 'msg:50');
    const page2 = sliceAgentMessagePage(messages, page1.nextCursor, AGENT_MESSAGE_PAGE_SIZE);
    assert.equal(page2.items.length, 50);
    assert.equal(page2.nextCursor, 'msg:100');
    const page3 = sliceAgentMessagePage(messages, page2.nextCursor, AGENT_MESSAGE_PAGE_SIZE);
    assert.equal(page3.items.length, 20);
    assert.equal(page3.nextCursor, null);
  });

  it('agentMessageTail 只渲染尾部窗口，不渲染整张列表', () => {
    const messages = makeMessages(120);
    const tail = agentMessageTail(messages, AGENT_MESSAGE_PAGE_SIZE);
    assert.equal(tail.items.length, 50);
    assert.equal(tail.startIndex, 70);
    assert.ok(tail.hasOlder);
    assert.ok(!tail.hasNewer);
    assert.equal(tail.items[0]?.id, 'm70', '尾部窗口应从 m70 开始');
    assert.equal(tail.items[49]?.id, 'm119');
  });

  it('agentOlderCursor 指向更早一页；无更早时为 null', () => {
    const messages = makeMessages(120);
    const tail = agentMessageTail(messages, AGENT_MESSAGE_PAGE_SIZE);
    const older = agentOlderCursor(tail, AGENT_MESSAGE_PAGE_SIZE);
    assert.equal(older, 'msg:20');
    const fresh = agentMessageWindow(messages, 0, AGENT_MESSAGE_PAGE_SIZE);
    assert.equal(agentOlderCursor(fresh, AGENT_MESSAGE_PAGE_SIZE), null);
  });

  it('appendAgentMessagePage 按 id 去重（同 id 视为 streaming 更新）', () => {
    const prev = [makeAssistantMessage('m1', 'a'), makeAssistantMessage('m2', 'a')];
    const incoming = [makeAssistantMessage('m2', 'b'), makeAssistantMessage('m3', 'c')];
    const result = appendAgentMessagePage(prev, incoming);
    assert.equal(result.added, 1);
    assert.equal(result.replaced, 1);
    assert.deepEqual(result.messages.map((message) => message.id), ['m1', 'm2', 'm3']);
    assert.equal(assistantMarkdown(result.messages, 'm2'), 'b');
  });

  it('appendAgentMessagePage 全量保留——不再因条数上限丢弃更早消息（问题 5）', () => {
    const many = makeMessages(300);
    const result = appendAgentMessagePage([], many);
    assert.equal(result.messages.length, 300, '全部消息必须保留，最老的不得被丢弃');
    assert.equal(result.messages[0]?.id, 'm0', '最老消息仍应在列表里');
    assert.equal(result.messages[result.messages.length - 1]?.id, 'm299');
  });

  it('limit 收敛到 1..100', () => {
    assert.equal(clampAgentMessagePageLimit(0), 1);
    assert.equal(clampAgentMessagePageLimit(500), 100);
    assert.equal(clampAgentMessagePageLimit(AGENT_MESSAGE_PAGE_SIZE), AGENT_MESSAGE_PAGE_SIZE);
    assert.equal(clampAgentMessagePageLimit(Number.NaN), AGENT_MESSAGE_PAGE_SIZE);
  });
});

describe('scroll threshold 与 resume', () => {
  it('贴底判定：距底部不超过阈值才自动滚动', () => {
    assert.equal(AGENT_SCROLL_THRESHOLD_PX, 48);
    assert.ok(shouldAgentAutoScroll({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), '距底 0px 应贴底');
    assert.ok(shouldAgentAutoScroll({ scrollTop: 860, scrollHeight: 1000, clientHeight: 100 }), '距底 40px 应在阈值内');
    assert.ok(!shouldAgentAutoScroll({ scrollTop: 500, scrollHeight: 1000, clientHeight: 100 }), '距底 400px 不应贴底');
  });

  it('顶部判定：滚动到顶附近才加载更早', () => {
    assert.ok(isAgentScrollNearTop({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 }));
    assert.ok(isAgentScrollNearTop({ scrollTop: 30, scrollHeight: 1000, clientHeight: 100 }));
    assert.ok(!isAgentScrollNearTop({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 }));
  });

  it('resume 从尾部回放（AGENT_RESUME_TAIL_MESSAGES）', () => {
    assert.equal(AGENT_RESUME_TAIL_MESSAGES, 20);
    assert.equal(agentResumeStartIndex(120), 100);
    assert.equal(agentResumeStartIndex(10), 0, '不足尾部条数时从 0 开始');
    const request = buildAgentResumePageRequest('s1', 120, AGENT_MESSAGE_PAGE_SIZE);
    assert.equal(request.sessionId, 's1');
    assert.equal(request.cursor, 'msg:100');
    assert.equal(request.limit, AGENT_MESSAGE_PAGE_SIZE);
  });

  it('消息装配结果有序且全量保留（不按条数上限丢弃更早消息）', () => {
    const events: AgentStreamEvent[] = Array.from({ length: 250 }, (_, index) => ({
      seq: index + 1,
      sessionId: 's1',
      kind: 'message-started' as const,
      message: makeUserMessage(`m${index}`, `text-${index}`)
    }));
    const result = reduceAgentStreamToMessages(events);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.messages.length, 250, '装配结果必须保留全部消息，不得按 RETAIN_LIMIT 丢弃');
    assert.equal(result.messages[0]?.id, 'm0', '最老消息保留');
    assert.equal(result.messages[result.messages.length - 1]?.id, 'm249', '最新消息保留');
  });
});
