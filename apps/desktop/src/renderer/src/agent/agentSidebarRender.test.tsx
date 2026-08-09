/**
 * Agent 侧边栏的**区块结构**渲染断言。
 *
 * 为什么需要这一层:侧边栏此前没有任何渲染测试,区块顺序与标签只被一条 e2e
 * 覆盖(renderer.spec.mjs 的「设置归属」)。而 e2e 要真实 Electron、跑得慢,
 * 且它断言的是「控件可见」这类点,抓不到「两个下拉同名」这种结构问题 ——
 * 实测就有:`AgentSessionControls` 的下拉和 `AgentTaskPanel` 的下拉都叫
 * 「模型服务」并排出现,前者只喂给离线草稿生成器、后者才决定任务用哪个服务,
 * 用户在前者里选 Anthropic 不会影响任务,而界面上没有任何东西说明这件事。
 *
 * 这里用 react-dom/server 真渲染侧边栏,断言区块的存在、顺序与作用域说明。
 *
 * 不声称覆盖:CSS 布局、折叠动画、点击行为(那是 e2e 的
 * __fixtureIpcCalls 断言)、真实 provider 调用。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSidebar, type AgentSidebarProps } from './AgentSidebar.js';
import { INITIAL_AGENT_TASK_STATE } from './agentTaskState.js';

function render(overrides: Partial<AgentSidebarProps> = {}): string {
  const props: AgentSidebarProps = {
    open: true,
    busy: false,
    provider: 'mock',
    thinking: 'normal',
    permissionMode: 'plan',
    permissionLockReason: '由主进程锁定为计划模式；renderer 不能抬高授权。',
    goal: null,
    draft: null,
    prompt: '',
    contextLabel: '未选择资源',
    selectedFilePath: null,
    tools: [],
    toolOutput: null,
    task: {
      task: INITIAL_AGENT_TASK_STATE,
      services: [{ id: 'svc-1', displayName: '本地兼容模型服务', hasCredential: true }],
      selectedServiceId: 'svc-1',
      runBlocker: null,
      sessions: [],
      sessionsPage: 0,
      sessionsError: null,
      sessionDetail: null,
      onSelectService: () => undefined,
      onRun: () => undefined,
      onCancel: () => undefined,
      onRefreshSessions: () => undefined,
      onSessionsPageChange: () => undefined,
      onLoadSession: () => undefined,
      onResumeSession: () => undefined,
      onRespondApproval: () => undefined,
      respondingApprovalCallId: null,
      approvalError: null
    },
    eventUri: '',
    onEventUriChange: () => undefined,
    onProviderChange: () => undefined,
    onThinkingChange: () => undefined,
    onPromptChange: () => undefined,
    onSend: () => undefined,
    onClose: () => undefined,
    onRunToolSearch: () => undefined,
    onExplainEvent: () => undefined,
    ...overrides
  };
  return renderToStaticMarkup(<AgentSidebar {...props} />);
}

describe('侧边栏区块划分把同名不同义的控件区分开', () => {
  it('草稿生成器与任务模型服务不再同名', () => {
    const html = render();
    // 两个 select 的 label 必须不同。同名会让用户以为在草稿区选了就生效，
    // 而它只喂给 buildAiSidebarDraft，任务实际用 agentServiceId。
    assert.match(html, /for="agent-provider">草稿生成器</, '草稿区下拉必须叫「草稿生成器」');
    assert.match(html, /for="agent-task-service">模型服务</, '任务区下拉保留「模型服务」');
    // 「模型服务」这个词只应出现在任务区那一处 label 上。
    const labelMatches = html.match(/class="agent-controls__label"[^>]*>模型服务</g) ?? [];
    assert.equal(
      labelMatches.length,
      1,
      `「模型服务」label 应只出现一次，实际 ${labelMatches.length} 次`
    );
  });

  it('草稿生成器旁必须写明作用范围', () => {
    const html = render();
    assert.match(html, /data-testid="agent-draft-scope"/);
    assert.match(html, /仅用于生成计划草稿/);
  });
});

describe('区块顺序与默认折叠状态', () => {
  it('草稿设置区默认折叠', () => {
    const html = render();
    const match = /<details class="agent-settings"([^>]*)>/.exec(html);
    assert.ok(match, '草稿设置区必须是 details 元素');
    // 默认展开会让用户以为必须先配它才能跑任务，而它不影响任务运行。
    assert.ok(
      !(match[1] ?? '').includes('open'),
      `草稿设置区应默认折叠，实际属性：${match[1] ?? ''}`
    );
  });

  it('手动工具台默认折叠且不占据会话流', () => {
    const html = render();
    assert.match(html, /data-testid="agent-manual-tools"/);
    const match = /<details class="agent-block" data-testid="agent-manual-tools"([^>]*)>/.exec(html);
    assert.ok(match, '手动工具台必须是可折叠区块');
    assert.ok(!(match[1] ?? '').includes('open'), '手动工具台应默认折叠');
  });

  it('任务面板排在草稿设置之前', () => {
    const html = render();
    const taskIndex = html.indexOf('data-testid="agent-task-panel"');
    const settingsIndex = html.indexOf('data-testid="agent-settings"');
    assert.ok(taskIndex >= 0 && settingsIndex >= 0, '两个区块都必须存在');
    // 正在跑的任务与待批准的操作是用户最需要先看到的东西。
    assert.ok(
      settingsIndex < taskIndex,
      '草稿设置区（折叠的 summary）应在任务面板之前，任务内容随后展开'
    );
  });
});

describe('等待审批在标题栏与输入区都可见', () => {
  const awaiting = {
    ...INITIAL_AGENT_TASK_STATE,
    sessionId: 'session-1',
    phase: 'running' as const,
    pendingApprovals: [{
      callId: 'c1',
      step: 1,
      toolName: 'rollback_operation',
      permissionLevel: 'rollback',
      argumentsJson: '{"opId":"op-1"}',
      preview: null
    }]
  };

  it('标题栏显示等待批准数量', () => {
    const html = render({ task: { ...render0Task(), task: awaiting } });
    // 断言必须锚定到标题栏那个元素**内部**的文本。
    //
    // 第一版写的是 `assert.match(html, /等待批准 1 项/)`，实测报绿：
    // AgentApprovalPanel 的区块标题也是「等待批准 N 项」，所以标题栏即使完全
    // 不显示，那句话仍在 HTML 里，断言恒真。判据串在另一处必然出现时，
    // 全文匹配没有任何鉴别力。
    const headerMatch = /data-testid="agent-header-state"[^>]*>([^<]*)</.exec(html);
    assert.ok(headerMatch, '标题栏状态元素必须存在');
    assert.match(
      headerMatch[1] ?? '',
      /等待批准 1 项/,
      `标题栏应显示等待批准数量，实际内容：${headerMatch[1] ?? ''}`
    );
    // 反向前提：不等待审批时标题栏不该说这句话，否则上面那条也可能恒真。
    const idleHeader = /data-testid="agent-header-state"[^>]*>([^<]*)</.exec(render());
    assert.ok(
      !/等待批准/.test(idleHeader?.[1] ?? ''),
      '空闲时标题栏不应显示等待批准'
    );
  });

  it('输入区把发送换成等待提示，而不是让用户再发一次', () => {
    const html = render({ task: { ...render0Task(), task: awaiting } });
    assert.match(html, /data-testid="composer-awaiting"/);
    assert.match(html, /等待你在上方批准/);
    // 等待审批时不该同时给一个可点的发送按钮。
    assert.ok(!html.includes('>发送</button>'), '等待审批时不应出现发送按钮');
  });

  it('任务进行中时输入区给停止而不是发送', () => {
    const running = { ...INITIAL_AGENT_TASK_STATE, sessionId: 's', phase: 'running' as const };
    const html = render({ task: { ...render0Task(), task: running } });
    assert.match(html, /data-testid="composer-stop"/);
    assert.ok(!html.includes('>发送</button>'), '任务在跑时不应出现发送按钮');
  });

  it('空闲时输入区给发送', () => {
    const html = render();
    assert.match(html, />发送</);
    assert.ok(!html.includes('data-testid="composer-stop"'));
  });

  it('输入区常驻显示当前权限模式', () => {
    const html = render();
    // 模式决定 agent 能不能写盘，而它此前只出现在任务面板深处。
    assert.match(html, /data-testid="composer-mode"/);
  });
});

describe('空状态承担引导职责', () => {
  it('给出可点击示例与四步流程', () => {
    const html = render();
    assert.match(html, /data-testid="agent-empty-state"/);
    assert.match(html, /data-testid="agent-empty-examples"/);
    // 示例必须是真的按钮而不是静态文字，否则「可点击示例」名不副实。
    const exampleButtons = html.match(/class="btn btn--ghost btn--sm"[^>]*>[^<]*葫芦/g) ?? [];
    assert.ok(exampleButtons.length >= 1, '至少一个示例应渲染成按钮');
    assert.match(html, /Agent 用只读工具查证据/);
    assert.match(html, /写类操作逐条弹审批/);
  });

  it('有目标时不再显示空状态', () => {
    const html = render({ goal: '把伤药葫芦上限调到 8' });
    assert.ok(!html.includes('data-testid="agent-empty-state"'));
    assert.match(html, /把伤药葫芦上限调到 8/);
  });
});

/** 复用默认 task props，避免每个用例重复整块字面量。 */
function render0Task(): AgentSidebarProps['task'] {
  return {
    task: INITIAL_AGENT_TASK_STATE,
    services: [{ id: 'svc-1', displayName: '本地兼容模型服务', hasCredential: true }],
    selectedServiceId: 'svc-1',
    runBlocker: null,
    sessions: [],
    sessionsPage: 0,
    sessionsError: null,
    sessionDetail: null,
    onSelectService: () => undefined,
    onRun: () => undefined,
    onCancel: () => undefined,
    onRefreshSessions: () => undefined,
    onSessionsPageChange: () => undefined,
    onLoadSession: () => undefined,
    onResumeSession: () => undefined,
    onRespondApproval: () => undefined,
    respondingApprovalCallId: null,
    approvalError: null
  };
}
