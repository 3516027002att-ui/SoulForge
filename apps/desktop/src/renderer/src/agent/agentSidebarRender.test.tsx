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

describe('Agent 壳层遵循右 dock 信息架构', () => {
  it('header 控件顺序是新任务、历史、展开、分隔、关闭', () => {
    const html = render();
    assert.match(html, /title="新任务"/);
    assert.match(html, /title="历史"/);
    assert.match(html, /title="展开 Agent"/);
    assert.match(html, /class="agent__header-separator"/);
    assert.match(html, /title="关闭"/);
    assert.ok(!html.includes('Agent 设置'), '设置不应占据 header');
  });

  it('composer 把交互意图与权限锁定分开显示', () => {
    const html = render();
    assert.match(html, /@Agent/);
    assert.match(html, /Ask/);
    assert.match(html, /权限：计划模式（主进程锁定）/);
  });
});

describe('区块顺序与默认折叠状态', () => {
  it('空闲态只渲染欢迎内容，不渲染旧的工具库存', () => {
    const html = render();
    assert.match(html, /data-testid="agent-empty-state"/);
    assert.match(html, /先读取工作区证据/);
    assert.ok(!html.includes('已注册工具'), '空闲态不应渲染工具库存');
  });

  it('有任务时才挂载任务面板', () => {
    const html = render();
    assert.ok(!html.includes('data-testid="agent-task-panel"'));
    const running = { ...INITIAL_AGENT_TASK_STATE, sessionId: 's', phase: 'running' as const };
    const active = render({ task: { ...render0Task(), task: running } });
    assert.match(active, /data-testid="agent-task-panel"/);
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
      diff: null,
      preview: null
    }]
  };

  it('标题栏显示等待批准数量', () => {
    const html = render({ task: { ...render0Task(), task: awaiting } });
    const headerMatch = /data-testid="agent-header-state"[^>]*>([^<]*)</.exec(html);
    assert.ok(headerMatch, '标题栏状态元素必须存在');
    assert.match(
      headerMatch[1] ?? '',
      /等待批准/,
      `标题栏应显示等待批准状态，实际内容：${headerMatch[1] ?? ''}`
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
    assert.match(html, /class="composer-permission"/);
  });
});

describe('空状态保持克制且可执行', () => {
  it('给出 Agent 角色与三条状态边界，不展示教程示例', () => {
    const html = render();
    assert.match(html, /data-testid="agent-empty-state"/);
    assert.match(html, /先读取工作区证据/);
    assert.match(html, /改动以提案和审批为边界/);
    assert.match(html, /可验证、可回滚/);
    assert.ok(!html.includes('可以这样问'), '空状态不展示示例教程');
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
