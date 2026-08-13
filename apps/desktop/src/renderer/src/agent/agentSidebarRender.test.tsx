/**
 * Agent 侧边栏的**区块结构**渲染断言（AGENT-60A dock 壳）。
 *
 * 为什么需要这一层:侧边栏此前没有任何渲染测试,区块顺序与标签只被一条 e2e
 * 覆盖(renderer.spec.mjs 的「设置归属」)。而 e2e 要真实 Electron、跑得慢,
 * 且它断言的是「控件可见」这类点,抓不到「两个下拉同名」这种结构问题 ——
 * 实测就有:`AgentSessionControls` 的下拉和 `AgentTaskPanel` 的下拉都叫
 * 「模型服务」并排出现。
 *
 * AGENT-60A 之后这里额外覆盖三块只有 DOM 层才看得见的东西:
 * 1. dock 壳固定结构 —— 48px header(SoulForge + 新任务|历史|展开|分隔|关闭)、
 *    4px resizer 的 separator 语义、conversation viewport 的 role="log";
 * 2. 空闲欢迎态只渲染 §12.4 固定文案,旧 task panel / 工具库存 / 会话数量不得
 *    进入空闲 DOM;
 * 3. §12.7 绝对禁止语音 —— DOM 与 agent 目录源码都不得出现语音相关 token。
 *
 * 用 react-dom/server 真渲染侧边栏(与旧测试同一范式)。
 *
 * 不声称覆盖:CSS 布局、折叠动画、点击行为(那是 e2e 的 __fixtureIpcCalls 断言)、
 * 真实 provider 调用。拖拽/键盘 resize 只测纯函数(clamp 与 16px 步长);真实
 * pointer/keyboard 事件属于 e2e。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSidebar, type AgentSidebarProps } from './AgentSidebar.js';
import { INITIAL_AGENT_TASK_STATE } from './agentTaskState.js';
import {
  AGENT_DOCK_KEYBOARD_STEP,
  clampAgentDockWidth,
  dockWidthForResizeKey
} from './AgentDockResizer.js';

/** renderer 源码根,由测试入口在编译期注入(不能用 import.meta.url:打包后指向缓存目录)。 */
declare const __SOULFORGE_RENDERER_ROOT__: string;

function render(overrides: Partial<AgentSidebarProps> = {}): string {
  const props: AgentSidebarProps = {
    open: true,
    overlay: false,
    agentWidth: 440,
    agentMinWidth: 340,
    agentMaxWidth: 620,
    onAgentWidthChange: () => undefined,
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
    task: render0Task(),
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

describe('Agent 壳层遵循右 dock 信息架构（§12.1/12.3）', () => {
  it('header 产品名是 SoulForge，右侧控件顺序固定', () => {
    const html = render();
    assert.match(html, />SoulForge</, 'header 左侧应是产品名 SoulForge（§12.3）');
    assert.match(html, /title="新任务"/);
    assert.match(html, /title="历史"/);
    assert.match(html, /title="展开 Agent"/);
    assert.match(html, /class="agent__header-separator"/);
    assert.match(html, /title="关闭"/);
    assert.ok(!html.includes('Agent 设置'), '设置不应占据 header');
    // 反向前提:欢迎标题才是 Agent,header 不该把「Agent」当产品名重复一遍。
    const headerElement = /<header class="agent__header">([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
    assert.ok(!headerElement.includes('>Agent<'), 'header 文本不应出现独立的 >Agent< 标题');
  });

  it('展开态把按钮换成恢复宽度', () => {
    const html = render({ expanded: true });
    assert.match(html, /title="恢复 Agent 宽度"/);
    assert.ok(!html.includes('title="展开 Agent"'));
  });

  it('conversation viewport 保持 role="log" 会话记录语义', () => {
    const html = render();
    assert.match(html, /class="agent-conversation" role="log"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /aria-label="Agent 会话记录"/);
  });

  it('composer 把交互意图与权限锁定分开显示', () => {
    const html = render();
    assert.match(html, /@Agent/);
    assert.match(html, /Ask/);
    assert.match(html, /权限：计划模式（主进程锁定）/);
  });
});

describe('AgentDockResizer（§12.2）', () => {
  it('渲染为 4px 垂直 separator，带当前宽度与范围', () => {
    const html = render();
    assert.match(html, /role="separator"/);
    assert.match(html, /aria-orientation="vertical"/);
    assert.match(html, /aria-label="调整 Agent 面板宽度"/);
    assert.match(html, /aria-valuenow="440"/);
    assert.match(html, /aria-valuemin="340"/);
    assert.match(html, /aria-valuemax="620"/);
  });

  it('overlay 或收起时隐藏且不可聚焦', () => {
    const overlayHtml = render({ overlay: true });
    assert.match(overlayHtml, /agent-dock-resizer is-hidden/);
    assert.match(overlayHtml, /tabindex="-1"/);
    const closedHtml = render({ open: false });
    assert.match(closedHtml, /agent-dock-resizer is-hidden/);
    assert.match(closedHtml, /class="agent is-collapsed"/);
  });

  it('宽度收敛到 340/620 并取整', () => {
    assert.equal(AGENT_DOCK_KEYBOARD_STEP, 16, '键盘每次 16px（§12.2）');
    assert.equal(clampAgentDockWidth(440, 340, 620), 440);
    assert.equal(clampAgentDockWidth(330, 340, 620), 340);
    assert.equal(clampAgentDockWidth(700, 340, 620), 620);
    assert.equal(clampAgentDockWidth(441.6, 340, 620), 442);
  });

  it('键盘 ArrowLeft/Right 每次 16px，Home/End 到边界', () => {
    assert.equal(dockWidthForResizeKey('ArrowLeft', 440, 340, 620), 456);
    assert.equal(dockWidthForResizeKey('ArrowRight', 440, 340, 620), 424);
    assert.equal(dockWidthForResizeKey('ArrowLeft', 610, 340, 620), 620, '超过上限收敛到 620');
    assert.equal(dockWidthForResizeKey('ArrowRight', 345, 340, 620), 340, '低于下限收敛到 340');
    assert.equal(dockWidthForResizeKey('Home', 500, 340, 620), 340);
    assert.equal(dockWidthForResizeKey('End', 400, 340, 620), 620);
  });
});

describe('区块顺序与默认折叠状态', () => {
  it('空闲态只渲染 §12.4 固定欢迎文案', () => {
    const html = render();
    assert.match(html, /data-testid="agent-empty-state"/);
    assert.match(html, /面向 Sekiro Mod 的安全协作编辑/);
    assert.match(html, /理解当前参数、文本、事件与资源选区/);
    assert.match(html, /先分析与规划，再生成可审查的修改/);
    assert.match(html, /经 Patch Engine 提交，验证失败自动回滚/);
    // 旧欢迎文案不得残留。
    assert.ok(!html.includes('先读取工作区证据'), '旧欢迎文案已替换');
    assert.ok(!html.includes('从证据出发'), '旧欢迎文案已替换');
  });

  it('空闲态不渲染旧 task panel / 工具库存 / 会话数量', () => {
    const html = render();
    assert.ok(!html.includes('data-testid="agent-task-panel"'));
    assert.ok(!html.includes('已注册工具'));
    assert.ok(!html.includes('agent-tool-inventory'));
    assert.ok(!html.includes('agent-session-history'));
    assert.ok(!html.includes('会话历史'));
    assert.ok(!html.includes('条消息'), '空闲欢迎不得回显会话数量');
    // 反向前提:不空闲时才允许这些出现。
    const running = { ...INITIAL_AGENT_TASK_STATE, sessionId: 's', phase: 'running' as const };
    const active = render({ task: { ...render0Task(), task: running } });
    assert.match(active, /data-testid="agent-task-panel"/);
  });

  it('有任务时才挂载任务面板，且不再显示欢迎态', () => {
    const running = { ...INITIAL_AGENT_TASK_STATE, sessionId: 's', phase: 'running' as const };
    const active = render({ task: { ...render0Task(), task: running } });
    assert.match(active, /data-testid="agent-task-panel"/);
    assert.ok(!active.includes('data-testid="agent-empty-state"'));
  });
});

describe('隐藏 dock 不清状态（§12.2）', () => {
  it('收起后 aside 仍挂载并折叠，内容与欢迎态保留', () => {
    const closed = render({ open: false });
    assert.match(closed, /class="agent is-collapsed"/);
    assert.match(closed, /data-testid="agent-empty-state"/, '收起不卸载欢迎区');
    assert.match(closed, /aria-label="关闭 Agent 面板"/, 'header 控件仍在 DOM');
    assert.match(closed, /class="agent__composer"/, 'composer 仍在 DOM');
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
    assert.match(html, /class="composer-permission"/);
  });
});

describe('空状态保持克制且可执行', () => {
  it('给出 Agent 角色与三条状态边界，不展示教程示例', () => {
    const html = render();
    assert.match(html, /data-testid="agent-empty-state"/);
    assert.match(html, /面向 Sekiro Mod 的安全协作编辑/);
    assert.match(html, /理解当前参数、文本、事件与资源选区/);
    assert.match(html, /先分析与规划，再生成可审查的修改/);
    assert.match(html, /经 Patch Engine 提交，验证失败自动回滚/);
    assert.ok(!html.includes('可以这样问'), '空状态不展示示例教程');
    assert.ok(!html.includes('推荐问题'), '禁止推荐问题按钮');
  });

  it('有目标时不再显示空状态', () => {
    const html = render({ goal: '把伤药葫芦上限调到 8' });
    assert.ok(!html.includes('data-testid="agent-empty-state"'));
    assert.match(html, /把伤药葫芦上限调到 8/);
  });
});

describe('§12.7 绝对禁止语音能力', () => {
  const FORBIDDEN_TOKENS = [
    'microphone',
    'mediarecorder',
    'getusermedia',
    'speech recognition',
    'audio ipc'
  ];

  it('DOM 不包含任何语音相关标记', () => {
    const html = render().toLowerCase();
    for (const needle of FORBIDDEN_TOKENS) {
      assert.ok(!html.includes(needle), `DOM 不应包含 ${needle}`);
    }
  });

  it('agent 生产源码不包含任何语音相关 token', () => {
    const agentDir = join(__SOULFORGE_RENDERER_ROOT__, 'agent');
    // 只扫生产源码,排除 *.test.*:测试文件自身要列出禁词清单,不能把清单算成能力。
    const source = readdirSync(agentDir)
      .filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.includes('.test.'))
      .map((name) => readFileSync(join(agentDir, name), 'utf8'))
      .join('\n')
      .toLowerCase();
    for (const needle of FORBIDDEN_TOKENS) {
      assert.ok(!source.includes(needle), `agent 生产源码不应包含 ${needle}`);
    }
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
