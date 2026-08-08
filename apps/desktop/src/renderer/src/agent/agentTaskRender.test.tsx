/**
 * AI 任务面板的**渲染期**断言。
 *
 * 为什么必须存在这一层（与 editors/truncationRender.test.tsx 同源）：
 * agentTaskState.test.ts 证明折叠规则正确，但**证明不了折叠结果真的显示出来**。
 * 实测把 `<span>{describeAgentTaskStatus(task)}</span>` 换成一个静态字符串后，
 * 纯逻辑测试全绿，而用户看到的进度永远不动。这里用 react-dom/server 真渲染面板，
 * 断言「喂进推进过的状态时，输出 HTML 里真的出现新的步号与状态文案」。
 *
 * 同样断言取消按钮的可用性随状态变化：一个恒定 disabled 的取消按钮编译得过、
 * 纯逻辑测试也过，但硬约束 16 要求的「可取消」并不成立。
 *
 * 不声称覆盖：点击是否真的发出 IPC（那是 e2e 的 __fixtureIpcCalls 断言）、
 * CSS 布局、真实 provider 调用。这里只有静态标记渲染。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentTaskPanel, type AgentTaskPanelProps } from './AgentTaskPanel.js';
import {
  INITIAL_AGENT_TASK_STATE,
  reduceAgentTaskEvent,
  startAgentTask,
  type AgentTaskEventEnvelope,
  type AgentTaskState
} from './agentTaskState.js';

const SESSION = 'render-session';

function feed(state: AgentTaskState, ...events: AgentTaskEventEnvelope['event'][]): AgentTaskState {
  return events.reduce(
    (current, event) => reduceAgentTaskEvent(current, { sessionId: SESSION, event }),
    state
  );
}

/** 最小 props：只有 task 与两三个展示字段随用例变化。 */
function render(overrides: Partial<AgentTaskPanelProps> = {}): string {
  const props: AgentTaskPanelProps = {
    task: INITIAL_AGENT_TASK_STATE,
    services: [{ id: 'svc-1', displayName: '本地兼容模型服务', hasCredential: true }],
    selectedServiceId: 'svc-1',
    runBlocker: null,
    sessions: [],
    sessionsPage: 0,
    sessionsError: null,
    sessionDetail: null,
    permissionLockReason: '由主进程锁定为计划模式；renderer 不能抬高授权。',
    tools: [],
    onSelectService: () => undefined,
    onRun: () => undefined,
    onCancel: () => undefined,
    onRefreshSessions: () => undefined,
    onSessionsPageChange: () => undefined,
    onLoadSession: () => undefined,
    onResumeSession: () => undefined,
    ...overrides
  };
  return renderToStaticMarkup(<AgentTaskPanel {...props} />);
}

/** 取出取消按钮那一段标记，用于判断 disabled 是否存在。 */
function cancelButtonMarkup(html: string): string {
  const match = /<button[^>]*data-testid="agent-task-cancel"[^>]*>/.exec(html);
  assert.ok(match, '渲染输出里必须有取消按钮；找不到说明靶标已变，请更新本用例');
  return match[0];
}

describe('进度事件到达后界面真的更新', () => {
  it('步号推进体现在渲染输出里', () => {
    const idle = render();
    assert.match(idle, /没有进行中的任务/, '空态必须说明当前没有任务');

    const running = render({
      task: feed(startAgentTask(SESSION), { type: 'turn-started', step: 1 })
    });
    assert.match(running, /第 1 步/, '第一步到达后界面必须显示步号');

    const later = render({
      task: feed(
        startAgentTask(SESSION),
        { type: 'turn-started', step: 1 },
        { type: 'turn-started', step: 7 }
      )
    });
    assert.match(later, /第 7 步/, '后续事件到达后步号必须跟着变——不变即「事件到了界面不更新」');
    assert.ok(
      !later.includes('第 1 步'),
      '旧步号必须被替换而不是并列显示，否则用户读不出当前进度'
    );
  });

  it('产出字符数与工具调用逐条出现在渲染输出里', () => {
    const html = render({
      task: feed(
        startAgentTask(SESSION),
        { type: 'turn-started', step: 2 },
        { type: 'agent-message-delta', step: 2, text: '十二个字的增量文本' },
        { type: 'tool-call-begin', step: 2, callId: 'c1', name: 'search_resources' },
        { type: 'tool-call-end', step: 2, callId: 'c1', name: 'search_resources', ok: true }
      )
    });
    assert.match(html, /data-testid="agent-task-tool-calls"/);
    assert.match(html, /search_resources/);
    assert.match(html, /成功/);
    assert.match(html, /已产出 9 字符/, '产出量必须报真实数字，不能只说「正在生成」');
  });

  it('失败与重试的结构化原因可见', () => {
    const failed = render({
      task: feed(
        startAgentTask(SESSION),
        { type: 'session-error', code: 'AGENT_SESSION_FAILED', message: '适配器连接失败' }
      )
    });
    assert.match(failed, /AGENT_SESSION_FAILED/, '失败必须报错误码（硬约束 8）');
    assert.match(failed, /适配器连接失败/);

    const retrying = render({
      task: feed(
        startAgentTask(SESSION),
        { type: 'retry-scheduled', step: 1, attempt: 2, maxAttempts: 3, delayMs: 500, code: 'RATE_LIMITED' }
      )
    });
    assert.match(retrying, /data-testid="agent-task-retry"/);
    assert.match(retrying, /RATE_LIMITED/);
  });
});

describe('取消按钮的可用性随状态变化（硬约束 16）', () => {
  it('idle 时禁用，运行中启用，结束后再次禁用', () => {
    assert.match(
      cancelButtonMarkup(render()),
      /disabled/,
      'idle 下取消必须禁用：可点却不会发出任何 IPC 的按钮是假入口'
    );

    const runningMarkup = cancelButtonMarkup(render({
      task: feed(startAgentTask(SESSION), { type: 'turn-started', step: 1 })
    }));
    assert.ok(
      !runningMarkup.includes('disabled'),
      '运行中取消必须可用，否则硬约束 16 的「可取消」在界面上不成立'
    );

    const doneMarkup = cancelButtonMarkup(render({
      task: feed(
        startAgentTask(SESSION),
        { type: 'session-done', finishReason: 'stop', steps: 1, rolloutFileName: 'a.jsonl' }
      )
    }));
    assert.match(doneMarkup, /disabled/, '终态不该还能取消');
  });

  it('取消请求已发出时界面显示中间态而不是直接说已取消', () => {
    const html = render({ task: { ...startAgentTask(SESSION), phase: 'cancelling', step: 3 } });
    assert.match(html, /已发出取消请求/);
    assert.ok(
      !html.includes('任务已结束'),
      '终态只能由主进程回报；本地就写「已结束」会在任务仍在跑时误报'
    );
  });
});

describe('权限模式只读回显，界面不提供抬高授权的入口', () => {
  it('显示锁定原因，且没有可选 fullPermission 的控件', () => {
    const html = render();
    assert.match(html, /data-testid="agent-task-permission"/);
    assert.match(html, /renderer 不能抬高授权/);
    assert.ok(
      !/<option[^>]*value="fullPermission"/.test(html),
      'renderer 不得提供选择 fullPermission 的入口——授权由主进程决定'
    );
    assert.ok(
      !/<option[^>]*value="normal"/.test(html),
      '同上：模式选择整体不在 renderer'
    );
  });

  it('主进程受理后回显它回报的模式', () => {
    const html = render({
      task: feed(startAgentTask(SESSION), { type: 'session-accepted', mode: 'plan' })
    });
    assert.match(html, /权限模式：plan/, '回显的是主进程回报的值，不是 renderer 自己的猜测');
  });
});

describe('运行前置不满足时给可见原因', () => {
  it('runBlocker 有值时按钮禁用且原因可读', () => {
    const html = render({ runBlocker: '尚未选择模型服务：请在模型服务管理里添加并配置凭据。' });
    assert.match(html, /data-testid="agent-task-blocker"/);
    assert.match(html, /尚未选择模型服务/);
    const runMarkup = /<button[^>]*data-testid="agent-task-run"[^>]*>/.exec(html);
    assert.ok(runMarkup, '找不到运行按钮：靶标已变，请更新本用例');
    assert.match(runMarkup[0], /disabled/);
  });

  it('没有模型服务时下拉给出明确空态而不是空白', () => {
    const html = render({ services: [], selectedServiceId: null });
    assert.match(html, /尚未添加模型服务/);
  });
});

describe('会话历史分页与数据源上限说明', () => {
  const sessions = Array.from({ length: 23 }, (_unused, index) => ({
    sessionPath: `2026/08/08/rollout-${String(index).padStart(4, '0')}.jsonl`,
    fileName: `rollout-${String(index).padStart(4, '0')}.jsonl`,
    sessionId: `s-${index}`,
    startedAt: `2026-08-08T10:${String(index).padStart(2, '0')}:00.000Z`,
    messageCount: index,
    parseErrors: 0,
    interrupted: false,
    compactedWindows: 0,
    sizeBytes: 4096,
    modifiedAt: `2026-08-08T10:${String(index).padStart(2, '0')}:00.000Z`
  }));

  it('分页文案报出区间与总数，翻页换内容', () => {
    const first = render({ sessions, sessionsPage: 0 });
    assert.match(first, /data-testid="agent-sessions-range"/);
    assert.match(first, /会话 1–10 \/ 共 23/, '必须回答「这一页覆盖第几到第几」');
    assert.match(first, /rollout-0000\.jsonl/);
    assert.ok(!first.includes('rollout-0010.jsonl'), '第一页不该出现第二页的条目');

    const second = render({ sessions, sessionsPage: 1 });
    assert.match(second, /rollout-0010\.jsonl/, '翻页必须换内容');
    assert.ok(!second.includes('rollout-0000.jsonl'));
  });

  it('明说数据源只回最近 50 个会话（不是渲染截断）', () => {
    const html = render({ sessions });
    assert.match(html, /data-testid="agent-sessions-source-limit"/);
    assert.match(html, /最近 50 个会话文件/, '不说明上限，用户会把 50 当成全部');
  });

  it('会话读取失败时保留结构化原因', () => {
    const html = render({ sessionsError: 'ROLLOUT_PATH_FORBIDDEN：会话路径必须位于会话目录内。' });
    assert.match(html, /ROLLOUT_PATH_FORBIDDEN/);
  });
});

describe('工具调用超上限时显式说明截断', () => {
  it('报真实总数与未显示数', () => {
    let task = startAgentTask(SESSION);
    const total = 26;
    for (let index = 0; index < total; index += 1) {
      task = feed(
        task,
        { type: 'tool-call-begin', step: 1, callId: `c${index}`, name: `tool_${index}` },
        { type: 'tool-call-end', step: 1, callId: `c${index}`, name: `tool_${index}`, ok: true }
      );
    }
    // 先断言前提成立：数据确实跨过了上限。前提不成立时截断说明本就不该出现，
    // 那种情况下「断言没报红」证明不了判据有效（本仓库已记录的假绿形态）。
    assert.ok(task.toolCalls.length > 20, `前提不成立：只有 ${task.toolCalls.length} 次调用，未跨过上限`);
    const html = render({ task });
    assert.match(html, /data-testid="agent-tool-calls-truncation"/);
    assert.match(html, new RegExp(String(total)), '必须报真实总数');
    assert.match(html, new RegExp(String(total - 20)), '必须报未显示数');
  });
});
