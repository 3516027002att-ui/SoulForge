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
    onRespondApproval: () => undefined,
    respondingApprovalCallId: null,
    approvalError: null,
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

describe('审批卡片真的渲染出来', () => {
  /** 制造一条待审批状态。 */
  function withApproval(overrides: {
    toolName?: string;
    permissionLevel?: string;
    argumentsJson?: string;
  } = {}): AgentTaskState {
    return feed(
      startAgentTask(SESSION),
      { type: 'turn-started', step: 1 },
      {
        type: 'approval-requested',
        step: 1,
        callId: 'call-render',
        toolName: overrides.toolName ?? 'propose_text_patch',
        permissionLevel: overrides.permissionLevel ?? 'stage',
        argumentsJson: overrides.argumentsJson
          ?? JSON.stringify({ targetUri: 'file://x', targetPath: 'mods/event/common.txt', newText: '新内容' })
      }
    );
  }

  it('待审批时出现卡片、四档按钮与目标文件', () => {
    const html = render({ task: withApproval() });
    assert.match(html, /data-testid="agent-approval-card"/);
    // 四档决定必须都能点到：少任何一档，用户就只能在「批准」和「关窗」之间选。
    for (const testid of [
      'agent-approval-once',
      'agent-approval-reject',
      'agent-approval-always',
      'agent-approval-never',
      // abort 与 Codex 的 ReviewDecision 对齐；它是用户「不想让这轮继续」的
      // 唯一入口，缺了就只能靠拒绝每一次调用来间接达到。
      'agent-approval-abort'
    ]) {
      assert.match(html, new RegExp(`data-testid="${testid}"`), `缺少审批按钮 ${testid}`);
    }
    assert.match(html, /mods\/event\/common\.txt/, '必须显示目标文件——只给工具名等于让用户批准一个未知动作');
    assert.match(html, /新内容/, '必须显示将写入的内容');
    assert.match(html, /data-testid="agent-approval-level"/);
  });

  it('无待审批时不渲染卡片', () => {
    // 前提断言：确认初始状态确实没有待审批，否则「没渲染」证明不了任何事。
    assert.equal(INITIAL_AGENT_TASK_STATE.pendingApprovals.length, 0);
    const html = render();
    assert.ok(!html.includes('data-testid="agent-approval-card"'));
  });

  it('参数无法解析时明说无法预览，并仍然给出原始参数', () => {
    const html = render({ task: withApproval({ argumentsJson: '{oops' }) });
    assert.match(html, /data-testid="agent-approval-no-preview"/);
    // 原始参数必须仍在：模型发出的坏参数正是需要被看见的东西。
    assert.match(html, /data-testid="agent-approval-arguments"/);
    assert.match(html, /\{oops/);
  });

  it('有 diff 时渲染真正的 before/after diff 并按增删着色', () => {
    const task = feed(
      startAgentTask(SESSION),
      { type: 'turn-started', step: 1 },
      {
        type: 'approval-requested',
        step: 1,
        callId: 'call-diff',
        toolName: 'propose_text_patch',
        permissionLevel: 'stage',
        argumentsJson: '{"targetPath":"mods/event/common.txt","newText":"新内容"}',
        diff: {
          targetPath: 'mods/event/common.txt',
          unifiedDiff: '--- mods/event/common.txt\n+++ mods/event/common.txt\n@@ -1,2 +1,2 @@\n 保留行\n-旧内容\n+新内容',
          addedLines: 1,
          removedLines: 1,
          newFile: false
        }
      }
    );
    const html = render({ task });
    assert.match(html, /data-testid="agent-approval-diff"/);
    assert.match(html, /data-testid="agent-approval-diff-body"/);
    // 删除侧必须出现：单侧「将写入什么」预览看不到被删掉的内容，
    // 而「删了什么」往往比「加了什么」更需要审批者看清。
    assert.match(html, /旧内容/, 'diff 必须显示被删除的原内容');
    assert.match(html, /新内容/);
    // 增删各自有样式类，不只靠文本前缀。
    assert.match(html, /class="diff-line is-remove"/);
    assert.match(html, /class="diff-line is-add"/);
    assert.match(html, /class="diff-line is-hunk"/);
    // 文件头不得被染成增删行。
    assert.ok(
      !/class="diff-line is-add">\+\+\+/.test(html),
      '文件头 +++ 不应被当成新增行'
    );
    // 增删统计必须锚定到统计元素**内部**。
    //
    // 第一版写的是 `assert.match(html, /\+1/)`，实测报绿：diff 正文里的
    // `+新内容` 和 hunk 头 `@@ -1,2 +1,2 @@` 都含 `+1`，把统计整块删掉也能过。
    // 判据串在正文里必然出现时，全文匹配没有鉴别力（本轮第三次踩到同一形态）。
    const addMatch = /<span class="is-add">([^<]*)<\/span>/.exec(html);
    const removeMatch = /<span class="is-remove">([^<]*)<\/span>/.exec(html);
    assert.ok(addMatch, '必须有新增行数元素');
    assert.ok(removeMatch, '必须有删除行数元素');
    assert.equal(addMatch[1], '+1', `新增统计应为 +1，实际 ${addMatch[1]}`);
    assert.equal(removeMatch[1], '-1', `删除统计应为 -1，实际 ${removeMatch[1]}`);
  });

  it('无 diff 时明说主进程未能生成，而不是留空', () => {
    const html = render({ task: withApproval() });
    // withApproval 不带 diff：必须出现显式说明。空着会让用户以为没有改动。
    assert.match(html, /data-testid="agent-approval-no-diff"/);
    assert.match(html, /未能为这次调用生成 diff/);
  });

  it('diff 截断时说明截了多少', () => {
    const task = feed(
      startAgentTask(SESSION),
      {
        type: 'approval-requested',
        step: 1,
        callId: 'call-trunc',
        toolName: 'propose_text_patch',
        permissionLevel: 'stage',
        argumentsJson: '{"targetPath":"a","newText":"b"}',
        diff: {
          targetPath: 'a',
          unifiedDiff: '--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y',
          addedLines: 900,
          removedLines: 800,
          newFile: false,
          truncatedNote: 'diff 共 2000 行，此处只显示前 400 行；完整改动为 +900 / -800 行。'
        }
      }
    );
    const html = render({ task });
    assert.match(html, /data-testid="agent-approval-diff-truncation"/);
    assert.match(html, /只显示前 400 行/);
  });

  it('高危等级带高危样式类', () => {
    const html = render({ task: withApproval({ permissionLevel: 'rollback', toolName: 'rollback_operation' }) });
    assert.match(html, /agent-approval is-high/, 'commit/rollback 不可能靠再跑一次撤销，必须一眼可辨');
    const staged = render({ task: withApproval({ permissionLevel: 'stage' }) });
    assert.match(staged, /agent-approval is-medium/);
  });

  it('发送中禁用按钮，避免同一条审批被回答两次', () => {
    const html = render({
      task: withApproval(),
      respondingApprovalCallId: 'call-render'
    });
    // React 把 disabled 渲染在 data-testid **之前**，属性顺序不由我们控制，
    // 所以两个方向都要容许（第一版只写了 testid→disabled 一个方向，实测假红）。
    assert.match(
      html,
      /<button[^>]*disabled[^>]*data-testid="agent-approval-once"|data-testid="agent-approval-once"[^>]*disabled/,
      '发送中必须禁用按钮，否则同一条审批会被回答两次'
    );
    // 前提断言：不传 respondingApprovalCallId 时按钮不该是禁用的，
    // 否则「恒定 disabled」也能让上面那条通过。
    const enabled = render({ task: withApproval() });
    assert.ok(
      !/<button[^>]*disabled[^>]*data-testid="agent-approval-once"/.test(enabled),
      '未发送时按钮必须可点——一个恒定禁用的批准按钮等于没有审批能力'
    );
  });

  it('回答失败时显示结构化原因', () => {
    const html = render({
      task: withApproval(),
      approvalError: '这条审批已失效（会话已结束或等待超时），你的回答未被采纳。'
    });
    assert.match(html, /data-testid="agent-approval-error"/);
    assert.match(html, /已失效/);
  });

  it('等待审批时状态行显示等待，而不是只显示进行中', () => {
    const html = render({ task: withApproval({ toolName: 'rollback_operation', permissionLevel: 'rollback' }) });
    assert.match(html, /等待你批准/);
    assert.match(html, /rollback_operation/);
  });

  it('超时与拒绝在历史里显示成不同的话', () => {
    const task = feed(
      withApproval(),
      {
        type: 'approval-resolved',
        step: 1, callId: 'call-render', toolName: 'propose_text_patch',
        decision: 'timed_out', fromMemory: false
      }
    );
    const html = render({ task });
    assert.match(html, /超时未回答/);
    // 把超时显示成「已拒绝」会让事后回看时「没人在场」看起来像
    // 「用户认真拒绝过」，而这两种情况该采取的下一步不同。
    assert.ok(!/已拒绝<\/span>/.test(html), '超时不应被显示成已拒绝');
  });

  it('放弃任务在历史里有独立文案', () => {
    const task = feed(
      withApproval(),
      {
        type: 'approval-resolved',
        step: 1, callId: 'call-render', toolName: 'propose_text_patch',
        decision: 'abort', fromMemory: false
      }
    );
    assert.match(render({ task }), /已放弃整个任务/);
  });

  it('来自会话记忆的自动处理被显式标注', () => {
    const task = feed(
      withApproval(),
      {
        type: 'approval-resolved',
        step: 1,
        callId: 'call-render',
        toolName: 'propose_text_patch',
        decision: 'always',
        fromMemory: true
      }
    );
    const html = render({ task });
    assert.match(html, /data-testid="agent-approval-history"/);
    // 不标注的话，「按上次决定自动放行」会被读成「用户刚刚批准了这一次」。
    assert.match(html, /按本会话既有决定自动处理/);
  });
});

describe('工具调用参数渲染出来', () => {
  it('带参数的调用显示参数块', () => {
    const task = feed(
      startAgentTask(SESSION),
      {
        type: 'tool-call-begin',
        step: 1,
        callId: 'c-args',
        name: 'search_events',
        argumentsJson: '{"query":"葫芦"}'
      }
    );
    const html = render({ task });
    assert.match(html, /data-testid="agent-tool-call-arguments"/);
    // 只显示工具名时，「读了哪个文件」「写了什么」全都看不见。
    assert.match(html, /葫芦/);
  });

  it('无参数的调用不显示空参数块', () => {
    const task = feed(
      startAgentTask(SESSION),
      { type: 'tool-call-begin', step: 1, callId: 'c-noargs', name: 'workspace_stats' }
    );
    const html = render({ task });
    assert.ok(!html.includes('data-testid="agent-tool-call-arguments"'));
  });
});
