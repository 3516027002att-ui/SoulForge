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
  AGENT_TOOL_CALL_LIMIT,
  INITIAL_AGENT_TASK_STATE,
  describeAgentTaskStatus,
  describeRunBlocker,
  isAgentTaskActive,
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

describe('工具调用列表上限是有限正整数', () => {
  it('上限可用于截断说明', () => {
    assert.ok(
      Number.isInteger(AGENT_TOOL_CALL_LIMIT) && AGENT_TOOL_CALL_LIMIT > 0,
      `上限必须是正整数，实际 ${AGENT_TOOL_CALL_LIMIT}`
    );
  });
});
