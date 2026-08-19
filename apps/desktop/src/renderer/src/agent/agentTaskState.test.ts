/**
 * AI agent 任务事件折叠与状态文案的单测。
 *
 * 为什么这一层必须存在：`ai:agent:event` 是推送通道，进度只能靠事件到达来推进。
 * 「事件到了、界面不更新」这类缺陷不抛异常、不影响编译，只让用户对着一个不动的
 * 面板等——而任务面板的全部动态都来自 reduceAgentTaskEvent。把折叠规则留在组件
 * 里就只能靠真实 Electron 才能测，那一层断言的是渲染结果，抓不到规则本身的错。
 *
 * 不声称覆盖：真实 IPC 传输、真实 provider 调用、DOM 事件。渲染期断言在
 * agentTaskRender.test.tsx，真实 Electron 行为在 test:renderer-e2e。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INITIAL_AGENT_TASK_STATE,
  approvalSeverity,
  classifyDiffLines,
  describeAgentTaskStatus,
  describeApprovalLevel,
  describeRunBlocker,
  extractApprovalPreview,
  isAgentTaskActive,
  isAgentTaskAwaitingApproval,
  isAgentTaskCancellable,
  markAgentTaskCancelling,
  reduceAgentTaskEvent,
  startAgentTask,
  type AgentTaskEventEnvelope,
  type AgentTaskState
} from './agentTaskState.js';

const SESSION = 'session-0001';

/** 按顺序折叠一串事件，模拟推送到达。 */
function feed(state: AgentTaskState, ...events: AgentTaskEventEnvelope['event'][]): AgentTaskState {
  return events.reduce(
    (current, event) => reduceAgentTaskEvent(current, { sessionId: SESSION, event }),
    state
  );
}

describe('进度事件真的推进状态', () => {
  it('turn-started 把任务从 accepted 推进到 running 并记录步号', () => {
    const started = startAgentTask(SESSION);
    assert.equal(started.phase, 'accepted');
    const running = feed(started, { type: 'turn-started', step: 3 });
    assert.equal(running.phase, 'running', '事件到达后阶段必须变化，否则界面永远停在受理态');
    assert.equal(running.step, 3);
  });

  it('步号只前进不后退（乱序到达的旧事件不能把进度拨回去）', () => {
    const state = feed(
      startAgentTask(SESSION),
      { type: 'turn-started', step: 5 },
      { type: 'turn-started', step: 2 }
    );
    assert.equal(state.step, 5, '旧事件迟到时进度回退，用户会看到步数来回跳');
  });

  it('流式增量累加为可见的产出字符数', () => {
    const state = feed(
      startAgentTask(SESSION),
      { type: 'agent-message-delta', step: 1, text: '前四个字' },
      { type: 'agent-message-delta', step: 1, text: '再三字' }
    );
    assert.equal(state.deltaChars, 7);
  });

  it('工具调用 begin/end 配对，失败码被保留', () => {
    const state = feed(
      startAgentTask(SESSION),
      { type: 'tool-call-begin', step: 1, callId: 'c1', name: 'search_resources' },
      { type: 'tool-call-begin', step: 1, callId: 'c2', name: 'stage_patch' },
      { type: 'tool-call-end', step: 1, callId: 'c1', name: 'search_resources', ok: true },
      { type: 'tool-call-end', step: 1, callId: 'c2', name: 'stage_patch', ok: false, code: 'PERMISSION_DENIED' }
    );
    assert.equal(state.toolCalls.length, 2);
    assert.equal(state.toolCalls[0]?.status, 'ok');
    assert.equal(state.toolCalls[1]?.status, 'failed');
    assert.equal(
      state.toolCalls[1]?.code,
      'PERMISSION_DENIED',
      '失败必须带结构化码（硬约束 8：不得吞异常）'
    );
  });

  it('retry / context / compaction 事件都落到可见字段', () => {
    const state = feed(
      startAgentTask(SESSION),
      { type: 'retry-scheduled', step: 1, attempt: 2, maxAttempts: 3, delayMs: 800, code: 'RATE_LIMITED' },
      { type: 'context-assembled', step: 1, sections: 4, totalBytes: 2048 },
      { type: 'context-compacted', step: 1, reason: 'auto', tokenLimit: 8000 }
    );
    assert.equal(state.retry?.code, 'RATE_LIMITED');
    assert.equal(state.contextBytes, 2048);
    assert.equal(state.compactedWindows, 1);
  });

  it('session-done 写终态并带上会话文件名', () => {
    const state = feed(
      startAgentTask(SESSION),
      { type: 'turn-started', step: 1 },
      { type: 'session-done', finishReason: 'stop', steps: 2, rolloutFileName: 'rollout-0001.jsonl' }
    );
    assert.equal(state.phase, 'done');
    assert.equal(state.steps, 2);
    assert.equal(state.rolloutFileName, 'rollout-0001.jsonl');
  });

  it('session-error 写错误码与原因，不吞异常', () => {
    const state = feed(
      startAgentTask(SESSION),
      { type: 'session-error', code: 'AGENT_SESSION_FAILED', message: '适配器连接失败' }
    );
    assert.equal(state.phase, 'error');
    assert.equal(state.error?.code, 'AGENT_SESSION_FAILED');
    assert.match(describeAgentTaskStatus(state), /AGENT_SESSION_FAILED/);
  });
});

describe('会话隔离：别的会话的事件不能改当前任务', () => {
  it('sessionId 不符时原样返回', () => {
    const started = startAgentTask(SESSION);
    const next = reduceAgentTaskEvent(started, {
      sessionId: 'other-session',
      event: { type: 'session-done', finishReason: 'stop', steps: 9, rolloutFileName: 'x.jsonl' }
    });
    assert.equal(next, started, '上一次运行的迟到事件会把新任务标成已结束');
    assert.equal(next.phase, 'accepted');
  });

  it('没有在跑的会话时任何事件都不生效', () => {
    const next = reduceAgentTaskEvent(INITIAL_AGENT_TASK_STATE, {
      sessionId: SESSION,
      event: { type: 'turn-started', step: 1 }
    });
    assert.equal(next.phase, 'idle');
  });
});

describe('取消：可用性判据与中间态', () => {
  it('idle 下不可取消（不给用户一个不发 IPC 的按钮）', () => {
    assert.equal(isAgentTaskCancellable(INITIAL_AGENT_TASK_STATE), false);
  });

  it('accepted 与 running 都可取消——首步未回也必须能停', () => {
    assert.equal(isAgentTaskCancellable(startAgentTask(SESSION)), true);
    assert.equal(
      isAgentTaskCancellable(feed(startAgentTask(SESSION), { type: 'turn-started', step: 1 })),
      true
    );
  });

  it('终态不可取消', () => {
    const done = feed(
      startAgentTask(SESSION),
      { type: 'session-done', finishReason: 'stop', steps: 1, rolloutFileName: 'a.jsonl' }
    );
    assert.equal(isAgentTaskCancellable(done), false);
  });

  it('cancelling 是中间态：终态仍由主进程决定', () => {
    const cancelling = markAgentTaskCancelling(feed(
      startAgentTask(SESSION),
      { type: 'turn-started', step: 2 }
    ));
    assert.equal(cancelling.phase, 'cancelling');
    assert.equal(isAgentTaskActive(cancelling), true, '取消中仍算进行中，不能立刻放行新任务');
    assert.match(describeAgentTaskStatus(cancelling), /取消/);

    // 取消中步骤继续推进时不得回退到 running，否则界面在「已请求取消」与
    // 「进行中」之间闪烁，用户无法判断取消到底有没有生效。
    const stillCancelling = feed(cancelling, { type: 'turn-started', step: 3 });
    assert.equal(stillCancelling.phase, 'cancelling');

    const finished = feed(cancelling, { type: 'session-done', finishReason: 'cancelled', steps: 3, rolloutFileName: 'b.jsonl' });
    assert.equal(finished.phase, 'done');
    assert.match(describeAgentTaskStatus(finished), /已被取消/);
  });

  it('markAgentTaskCancelling 对不可取消的状态是恒等的', () => {
    assert.equal(markAgentTaskCancelling(INITIAL_AGENT_TASK_STATE), INITIAL_AGENT_TASK_STATE);
  });
});

describe('状态文案回答四个问题：在跑/进度/失败原因/可否取消', () => {
  it('运行中报步号并明说可取消', () => {
    const text = describeAgentTaskStatus(feed(
      startAgentTask(SESSION),
      { type: 'turn-started', step: 4 },
      { type: 'agent-message-delta', step: 4, text: '十个字十个字' }
    ));
    assert.match(text, /第 4 步/);
    assert.match(text, /可随时取消/);
  });

  it('结束时报总步数与失败的工具调用次数', () => {
    const text = describeAgentTaskStatus(feed(
      startAgentTask(SESSION),
      { type: 'tool-call-begin', step: 1, callId: 'c1', name: 'commit_patch' },
      { type: 'tool-call-end', step: 1, callId: 'c1', name: 'commit_patch', ok: false, code: 'DENIED' },
      { type: 'session-done', finishReason: 'stop', steps: 3, rolloutFileName: 'c.jsonl' }
    ));
    assert.match(text, /共 3 步/);
    assert.match(text, /1 次工具调用失败/);
  });

  it('不使用无证据形容词（anti-ai-design §2）', () => {
    const samples = [
      INITIAL_AGENT_TASK_STATE,
      startAgentTask(SESSION),
      feed(startAgentTask(SESSION), { type: 'turn-started', step: 1 })
    ].map(describeAgentTaskStatus);
    for (const text of samples) {
      for (const banned of ['智能', '高效', '无缝', '强大', '革命性']) {
        assert.ok(!text.includes(banned), `状态文案不得含无证据形容词「${banned}」：${text}`);
      }
    }
  });
});

describe('运行前置条件给出结构化原因，不静默禁用', () => {
  it('缺 bridge / 缺服务 / 空描述 / 已有任务各有专属原因', () => {
    const base = { hasBridge: true, configId: 'svc-1', prompt: '调整伤药葫芦上限', active: false };
    assert.equal(describeRunBlocker(base), null);
    assert.match(describeRunBlocker({ ...base, hasBridge: false }) ?? '', /桌面版/);
    assert.match(describeRunBlocker({ ...base, configId: null }) ?? '', /模型服务/);
    assert.match(describeRunBlocker({ ...base, prompt: '   ' }) ?? '', /任务描述为空/);
    assert.match(describeRunBlocker({ ...base, active: true }) ?? '', /已有任务/);
  });
});

describe('审批请求折叠成待办队列', () => {
  it('approval-requested 入队，approval-resolved 出队并留下记录', () => {
    const requested = feed(startAgentTask(SESSION), { type: 'turn-started', step: 1 }, {
      type: 'approval-requested',
      step: 1,
      callId: 'call-1',
      toolName: 'rollback_operation',
      permissionLevel: 'rollback',
      argumentsJson: '{"opId":"op-1"}'
    });
    assert.equal(requested.pendingApprovals.length, 1);
    assert.equal(requested.pendingApprovals[0]?.toolName, 'rollback_operation');
    assert.ok(isAgentTaskAwaitingApproval(requested), '有待审批且任务在进行中时必须判为等待审批');

    const resolved = feed(requested, {
      type: 'approval-resolved',
      step: 1,
      callId: 'call-1',
      toolName: 'rollback_operation',
      decision: 'once',
      fromMemory: false
    });
    assert.equal(resolved.pendingApprovals.length, 0, 'resolved 之后必须出队');
    assert.equal(resolved.approvalDecisions.length, 1);
    assert.equal(resolved.approvalDecisions[0]?.decision, 'once');
    assert.equal(resolved.approvalDecisions[0]?.fromMemory, false);
  });

  it('同一 callId 重复到达不会入队两次', () => {
    const event = {
      type: 'approval-requested' as const,
      step: 1,
      callId: 'dup',
      toolName: 'propose_text_patch',
      permissionLevel: 'stage',
      argumentsJson: '{}'
    };
    const state = feed(startAgentTask(SESSION), event, event);
    assert.equal(state.pendingApprovals.length, 1, '推送通道不保证只送一次，去重必须在折叠层');
  });

  it('多条待审批按到达顺序排队，不互相覆盖', () => {
    const state = feed(
      startAgentTask(SESSION),
      { type: 'approval-requested', step: 1, callId: 'a', toolName: 't1', permissionLevel: 'stage', argumentsJson: '{}' },
      { type: 'approval-requested', step: 1, callId: 'b', toolName: 't2', permissionLevel: 'commit', argumentsJson: '{}' }
    );
    // 只保留一条会让第二条在界面上消失，而 loop 仍在等它——表现为任务卡住且查不到原因。
    assert.deepEqual(state.pendingApprovals.map((entry) => entry.callId), ['a', 'b']);
  });

  it('终态清空待审批队列', () => {
    const pending = feed(
      startAgentTask(SESSION),
      { type: 'approval-requested', step: 1, callId: 'x', toolName: 't', permissionLevel: 'commit', argumentsJson: '{}' }
    );
    const done = feed(pending, {
      type: 'session-done', finishReason: 'stop', steps: 1, rolloutFileName: 'f.jsonl'
    });
    assert.equal(done.pendingApprovals.length, 0, '会话结束后留着按钮点了没用的卡片，会让用户以为任务还在等自己');
    const errored = feed(pending, { type: 'session-error', code: 'X', message: 'y' });
    assert.equal(errored.pendingApprovals.length, 0);
  });

  it('等待审批时状态文案与普通进行中可区分', () => {
    const pending = feed(
      startAgentTask(SESSION),
      { type: 'turn-started', step: 2 },
      { type: 'approval-requested', step: 2, callId: 'c', toolName: 'rollback_operation', permissionLevel: 'rollback', argumentsJson: '{}' }
    );
    const text = describeAgentTaskStatus(pending);
    // 「模型在想」和「停下来等你」表面上都是进行中，但后者不操作就永远不会推进。
    assert.match(text, /等待你批准/);
    assert.match(text, /rollback_operation/);
    const running = feed(startAgentTask(SESSION), { type: 'turn-started', step: 2 });
    assert.ok(!describeAgentTaskStatus(running).includes('等待你批准'));
  });

  it('timed_out 与 reject 在记录里可区分', () => {
    // 与 Codex 的 ReviewDecision 对齐：timed_out 是与 denied 平级的独立取值。
    // 并成一个会让「审批通道没人看」在事后看起来像「用户认真拒绝过」。
    const base = feed(startAgentTask(SESSION), {
      type: 'approval-requested',
      step: 1,
      callId: 'c-timeout',
      toolName: 'rollback_operation',
      permissionLevel: 'rollback',
      argumentsJson: '{}'
    });
    const timedOut = feed(base, {
      type: 'approval-resolved',
      step: 1,
      callId: 'c-timeout',
      toolName: 'rollback_operation',
      decision: 'timed_out',
      fromMemory: false
    });
    assert.equal(timedOut.approvalDecisions[0]?.decision, 'timed_out');
    assert.equal(timedOut.pendingApprovals.length, 0, '超时也要出队');
  });

  it('abort 被记录为独立结果', () => {
    const state = feed(
      startAgentTask(SESSION),
      {
        type: 'approval-requested',
        step: 1, callId: 'c-abort', toolName: 'propose_text_patch',
        permissionLevel: 'stage', argumentsJson: '{}'
      },
      {
        type: 'approval-resolved',
        step: 1, callId: 'c-abort', toolName: 'propose_text_patch',
        decision: 'abort', fromMemory: false
      }
    );
    assert.equal(state.approvalDecisions[0]?.decision, 'abort');
  });

  it('审批等级分档把不可撤销的操作标为高危', () => {
    assert.equal(approvalSeverity('commit'), 'high');
    assert.equal(approvalSeverity('rollback'), 'high');
    assert.equal(approvalSeverity('stage'), 'medium');
    assert.equal(approvalSeverity('read'), 'low');
    // 未知等级不得被当成高危也不得被当成安全——原样降级到 low 但说明可查。
    assert.equal(approvalSeverity('unknown-level'), 'low');
    assert.equal(describeApprovalLevel('unknown-level'), 'unknown-level', '未知等级原样回显，不猜语义');
  });
});

describe('unified diff 逐行分类', () => {
  it('文件头不被当成增删行', () => {
    // 顺序错了的话 `---` / `+++` 会被判成 remove / add，文件头被染成一条删除行
    // 和一条新增行——这是最容易被忽略的错色，因为它看起来「像是」改动的一部分。
    const lines = classifyDiffLines('--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c');
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['header', 'header', 'hunk', 'context', 'remove', 'add']
    );
  });

  it('保留原始文本供渲染', () => {
    const lines = classifyDiffLines('-old\n+new');
    assert.equal(lines[0]?.text, '-old');
    assert.equal(lines[1]?.text, '+new');
  });
});

describe('审批请求携带主进程算出的 diff', () => {
  it('diff 随 approval-requested 事件进入待办队列', () => {
    const state = feed(startAgentTask(SESSION), {
      type: 'approval-requested',
      step: 1,
      callId: 'c-diff',
      toolName: 'propose_text_patch',
      permissionLevel: 'stage',
      argumentsJson: '{"targetPath":"mods/a.txt","newText":"b"}',
      diff: {
        targetPath: 'mods/a.txt',
        unifiedDiff: '--- mods/a.txt\n+++ mods/a.txt\n@@ -1 +1 @@\n-a\n+b',
        addedLines: 1,
        removedLines: 1,
        newFile: false
      }
    });
    assert.equal(state.pendingApprovals[0]?.diff?.addedLines, 1);
    assert.equal(state.pendingApprovals[0]?.diff?.removedLines, 1);
    assert.match(state.pendingApprovals[0]?.diff?.unifiedDiff ?? '', /^--- mods\/a\.txt/);
  });

  it('事件不带 diff 时字段为 null 而不是 undefined', () => {
    // null 与 undefined 在界面上要走不同分支：null 表示「主进程没能给出 diff」，
    // 必须显式说出来；undefined 会让可选链静默跳过整个提示。
    const state = feed(startAgentTask(SESSION), {
      type: 'approval-requested',
      step: 1,
      callId: 'c-nodiff',
      toolName: 'rollback_operation',
      permissionLevel: 'rollback',
      argumentsJson: '{"opId":"op-1"}'
    });
    assert.equal(state.pendingApprovals[0]?.diff, null);
  });
});

describe('审批预览只从参数里已有的字段提取', () => {
  it('提取 targetPath 与 newText', () => {
    const preview = extractApprovalPreview(JSON.stringify({
      targetUri: 'file://x', targetPath: 'mods/a.txt', newText: 'hello'
    }));
    assert.equal(preview?.targetPath, 'mods/a.txt');
    assert.equal(preview?.newText, 'hello');
    assert.equal(preview?.truncatedBytes, 0);
  });

  it('从 PatchProposal 形态的 changes 里取第一条', () => {
    const preview = extractApprovalPreview(JSON.stringify({
      opId: 'op1',
      workspaceId: 'w1',
      changes: [
        { targetUri: 'file://y', targetPath: 'mods/b.txt', kind: 'text', structuredEdit: { newText: 'body' } }
      ]
    }));
    assert.equal(preview?.targetPath, 'mods/b.txt');
    assert.equal(preview?.newText, 'body');
    assert.equal(preview?.changeCount, 1);
  });

  it('超长内容保留全文（问题 5：不截断，由界面展开/折叠看全文）', () => {
    const long = 'x'.repeat(10_000);
    const preview = extractApprovalPreview(JSON.stringify({ targetPath: 'a', newText: long }));
    assert.equal(preview?.newText?.length, 10_000, '必须保留完整内容，不得切成前若干字符');
    assert.equal(preview?.truncatedBytes, 0);
  });

  it('参数不是 JSON 或不含可识别字段时返回 null，而不是编一个预览', () => {
    // 「大概是这个文件」的预览会让用户以为自己看清了改动，那比不显示更危险。
    assert.equal(extractApprovalPreview('{oops'), null);
    assert.equal(extractApprovalPreview('"a string"'), null);
    assert.equal(extractApprovalPreview('[1,2]'), null);
    assert.equal(extractApprovalPreview('{"query":"unrelated"}'), null);
  });
});
