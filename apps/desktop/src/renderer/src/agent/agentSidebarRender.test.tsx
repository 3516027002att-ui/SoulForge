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
import type { AgentMessageDto, AgentResourceReference, EditorSelectionContext } from '@soulforge/shared';
import { AgentSidebar, type AgentSidebarProps } from './AgentSidebar.js';
import { AgentSecondaryDrawer } from './AgentSecondaryDrawer.js';
import {
  INITIAL_AGENT_TASK_STATE,
  type AgentApprovalView,
  type AgentTaskState
} from './agentTaskState.js';
import {
  AGENT_DOCK_KEYBOARD_STEP,
  clampAgentDockWidth,
  dockWidthForResizeKey
} from './AgentDockResizer.js';

// node 环境没有 window，而 AgentSidebar 现在经 getRendererBridge()（读 window.soulforge）
// 判定资源引用能力。设为空对象 → browser-preview 表面 → bridge null → 「添加资源
// 引用」诚实 disabled；与 ParamWorkbench.test.tsx 等 SSR 测试同一范式。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

/** renderer 源码根,由测试入口在编译期注入(不能用 import.meta.url:打包后指向缓存目录)。 */
declare const __SOULFORGE_RENDERER_ROOT__: string;

function render(overrides: Partial<AgentSidebarProps> = {}): string {
  const props: AgentSidebarProps = {
    open: true,
    agentWidth: 440,
    agentMinWidth: 200,
    agentMaxWidth: 620,
    onAgentWidthChange: () => undefined,
    busy: false,
    provider: 'mock',
    thinking: 'normal',
    protocol: 'openai-compatible',
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

describe('Composer 结构（§12.6 / S32 输入卡）', () => {
  it('S32 一块圆角输入卡：输入区在前、工具行在后，参与者条并入工具行', () => {
    const html = render();
    const bodyIdx = html.indexOf('agent-composer__body');
    const toolbarIdx = html.indexOf('agent-composer__toolbar');
    assert.ok(bodyIdx >= 0, '输入区存在');
    assert.ok(toolbarIdx > bodyIdx, '工具行在输入区之后');
    // participant 条不再独立一层：模式/权限下拉进工具行。
    const toolbarRegion = html.slice(toolbarIdx);
    assert.match(toolbarRegion, /agent-composer__participant/, '参与者条（权限下拉）在工具行内');
    assert.match(html, /data-testid="agent-composer"/);
  });

  it('participant 层 = @Agent + 模式选择 + 权限锁定', () => {
    const html = render();
    assert.match(html, /class="agent-participant"[^>]*>@Agent</);
    assert.match(html, /class="agent-mode-select"/);
    assert.match(html, /class="composer-permission"/);
  });

  it('prompt+chips 层 = context chips + 自动增高 textarea', () => {
    const html = render();
    assert.match(html, /data-testid="agent-context-chips"/);
    assert.match(html, /class="agent-composer__body"[\s\S]*?<textarea/);
    // e2e 依赖的 CSS 钩子：textarea 必须仍是 .agent__composer 的后代（§12.6 输入区）。
    assert.match(html, /class="agent__composer"[\s\S]*?<textarea/);
  });

  it('S32 工具行顺序：引用 | 附件 | 权限 | 模型 | 思考 | 发送（模型与思考是两个控件）', () => {
    const html = render();
    const toolbarStart = html.indexOf('class="agent-composer__toolbar"');
    assert.ok(toolbarStart >= 0, 'toolbar 层必须存在');
    const region = html.slice(toolbarStart);
    const markers = [
      'aria-label="引用框选"', // S10：@/# 合成「引用」框选钮
      'aria-label="添加附件"', // attachment
      'class="agent-mode-select"', // 权限（Ask/Plan/Edit 下拉）
      'aria-label="模型服务设置"', // model
      'aria-label="思考强度"', // S32：思考强度独立控件
      '>发送<' // send/stop
    ];
    let prev = -1;
    for (const marker of markers) {
      const idx = region.indexOf(marker);
      assert.ok(idx > prev, `toolbar 五项应按固定顺序出现，${marker} 顺序错误`);
      prev = idx;
    }
    // S10 拍死：工具栏不再有 @ / # 两个钮（引用是语义实体，不是文本 token）。
    assert.ok(!region.includes('aria-label="添加 Agent 参与者"'), '@ 按钮已移除');
    assert.ok(!region.includes('aria-label="添加当前文件上下文"'), '# 按钮已移除');
  });

  it('空输入时发送按钮 disabled，非空时可用（§12.6）', () => {
    const idleHtml = render();
    assert.match(idleHtml, />发送<\/button>/);
    assert.match(idleHtml, /<button[^>]*disabled[^>]*>发送<\/button>/, '空输入时发送按钮应 disabled');
    const filledHtml = render({ prompt: '把药葫芦上限调到 8' });
    assert.ok(!/<button[^>]*disabled[^>]*>发送<\/button>/.test(filledHtml), '非空输入时发送按钮不应 disabled');
  });

  it('未打通的能力诚实 disabled：附件按钮常驻 disabled 而不是假装可用', () => {
    const html = render();
    const attachmentButton = /<button[^>]*aria-label="添加附件"[^>]*>/.exec(html)?.[0];
    assert.ok(attachmentButton, '附件按钮必须存在（固定五项之一）');
    assert.ok(attachmentButton.includes('disabled'), '附件能力未接通（60C），应诚实 disabled');
  });

  it('S10：引用框选钮默认抬起，citeSelecting 时按下（aria-pressed）', () => {
    const idle = render();
    const idleButton = /<button[^>]*aria-label="引用框选"[^>]*>/.exec(idle)?.[0];
    assert.ok(idleButton?.includes('aria-pressed="false"'), '默认应为抬起态');
    const active = render({ citeSelecting: true });
    const activeButton = /<button[^>]*aria-label="引用框选"[^>]*>/.exec(active)?.[0];
    assert.ok(activeButton?.includes('aria-pressed="true"'), '框选模式开启时应为按下态');
  });
});

describe('AgentDockResizer（§12.2）', () => {
  it('渲染为 4px 垂直 separator，带当前宽度与范围', () => {
    const html = render();
    assert.match(html, /role="separator"/);
    assert.match(html, /aria-orientation="vertical"/);
    assert.match(html, /aria-label="调整 Agent 面板宽度"/);
    assert.match(html, /aria-valuenow="440"/);
    assert.match(html, /aria-valuemin="200"/);
    assert.match(html, /aria-valuemax="620"/);
  });

  it('dock 开着时 resizer 可拖且不隐藏（常驻文档流右列，无 overlay）', () => {
    const openHtml = render();
    assert.match(openHtml, /class="agent-dock-resizer"/, '开着必须渲染 agent-dock-resizer');
    assert.ok(!/agent-dock-resizer is-hidden/.test(openHtml), '开着时 resizer 不应隐藏');
    assert.ok(!openHtml.includes('is-overlay'), 'Agent 始终文档流右列，不再有 overlay 形态');
    const closedHtml = render({ open: false });
    assert.match(closedHtml, /agent-dock-resizer is-hidden/);
    assert.match(closedHtml, /tabindex="-1"/);
    assert.match(closedHtml, /class="agent is-collapsed"/);
  });

  it('宽度收敛到 200/620 并取整（S8：下限 200px）', () => {
    assert.equal(AGENT_DOCK_KEYBOARD_STEP, 16, '键盘每次 16px（§12.2）');
    assert.equal(clampAgentDockWidth(440, 200, 620), 440);
    assert.equal(clampAgentDockWidth(190, 200, 620), 200, '低于下限收敛到 200');
    assert.equal(clampAgentDockWidth(700, 200, 620), 620);
    assert.equal(clampAgentDockWidth(441.6, 200, 620), 442);
  });

  it('键盘 ArrowLeft/Right 每次 16px，Home/End 到边界', () => {
    assert.equal(dockWidthForResizeKey('ArrowLeft', 440, 200, 620), 456);
    assert.equal(dockWidthForResizeKey('ArrowRight', 440, 200, 620), 424);
    assert.equal(dockWidthForResizeKey('ArrowLeft', 610, 200, 620), 620, '超过上限收敛到 620');
    assert.equal(dockWidthForResizeKey('ArrowRight', 210, 200, 620), 200, '低于下限收敛到 200');
    assert.equal(dockWidthForResizeKey('Home', 500, 200, 620), 200);
    assert.equal(dockWidthForResizeKey('End', 400, 200, 620), 620);
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
    // 反向前提:不空闲时消息流出现（§12.10 任务进度进入消息流，面板不再常驻）。
    const running = { ...INITIAL_AGENT_TASK_STATE, sessionId: 's', phase: 'running' as const };
    const active = render({ task: { ...render0Task(), task: running } });
    assert.match(active, /data-testid="agent-task-status"/, '运行中应显示消息流状态行');
    assert.ok(!active.includes('data-testid="agent-task-panel"'), '运行中面板移出主栏，进入二级抽屉');
  });

  it('运行中消息流出现状态行与工具活动，不再显示欢迎态', () => {
    const running = {
      ...INITIAL_AGENT_TASK_STATE,
      sessionId: 's',
      phase: 'running' as const,
      toolCalls: [{
        callId: 'c1', name: 'search_resources', step: 1, status: 'running' as const
      }]
    };
    const active = render({ task: { ...render0Task(), task: running } });
    assert.match(active, /data-testid="agent-task-status"/);
    assert.ok(!active.includes('data-testid="agent-empty-state"'));
    assert.match(active, /data-testid="agent-tool-activity-c1"/, '运行中工具活动进入消息流');
    assert.match(active, /agent-tool-status--running/, '工具活动默认单行折叠，带运行徽标');
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

describe('§12.8/§12.11 上下文、资源引用与消息流（AGENT-60C）', () => {
  function selection0(domain: EditorSelectionContext['domain']): EditorSelectionContext {
    return {
      domain,
      libraryId: null,
      bankId: null,
      documentId: null,
      paramTableId: null,
      rowId: null,
      fieldId: null,
      fmgEntryId: null,
      eventId: null,
      cursor: null,
      revision: null
    };
  }

  it('绝对路径选区回退空态，不进入 DOM', () => {
    const leaking = {
      ...selection0('param'),
      documentId: 'D:\\mystream\\Sekiro\\param\\gameparam.parambnd.dcx'
    };
    const html = render({ selection: leaking });
    assert.ok(!html.includes('D:\\mystream'), 'DOM 不应包含绝对路径');
    assert.ok(!html.includes('gameparam.parambnd.dcx'), '泄漏的 documentId 不应进入 DOM');
    assert.match(html, /未选择逻辑资源/, '不合格选区应回退空态');
  });

  it('hex dump / raw parser 选区不进入 DOM', () => {
    const hex = { ...selection0('param'), documentId: '40 00 00 00 2C 01 00 00 00 00 00 00' };
    const html = render({ selection: hex });
    assert.ok(!html.includes('40 00 00 00'), 'hex dump 不应进入 DOM');
    assert.match(html, /未选择逻辑资源/);
  });

  it('安全选区以 opaque 摘要进入 DOM', () => {
    const safe = { ...selection0('param'), documentId: 'm12b/param/gameparam.parambnd.dcx' };
    const html = render({ selection: safe });
    assert.match(html, /param · m12b\/param\/gameparam\.parambnd\.dcx/);
    assert.match(html, /data-testid="agent-context-picker"/);
  });

  it('资源引用只显示 opaque label，token 不进入 DOM', () => {
    const resources: AgentResourceReference[] = [{
      token: 'agent-ref:opaque-token-value',
      domain: 'param',
      label: 'PARAM · 文档',
      expiresAt: '2026-01-01T00:00:00.000Z'
    }];
    const html = render({ resources });
    assert.match(html, /PARAM · 文档/);
    assert.ok(!html.includes('agent-ref:opaque-token-value'), 'token 不应进入 DOM');
  });

  it('资源引用渲染移除入口，移除按钮的 label 不携带 token', () => {
    const resources: AgentResourceReference[] = [{
      token: 'agent-ref:remove-me-token',
      domain: 'param',
      label: 'PARAM · 文档',
      expiresAt: '2026-01-01T00:00:00.000Z'
    }];
    const html = render({ resources });
    const removeButton = /<button[^>]*aria-label="移除引用 PARAM · 文档"[^>]*>/.exec(html)?.[0];
    assert.ok(removeButton, '资源引用必须提供移除入口（本地草稿可移除）');
    assert.ok(!html.includes('agent-ref:remove-me-token'), '移除按钮不得把 token 带进 DOM');
  });

  it('未挂载真实回调时不渲染清除按钮，添加资源引用诚实 disabled', () => {
    const html = render({ selection: selection0('param') });
    assert.ok(!html.includes('清除上下文'), '无 onClear 回调不应渲染清除按钮');
    const addButton = /<button[^>]*aria-label="添加资源引用"[^>]*>/.exec(html)?.[0];
    assert.ok(addButton, '添加资源引用按钮必须存在');
    assert.ok(addButton.includes('disabled'), '无 onCreate 回调时添加资源引用应 disabled');
  });

  it('消息流渲染 AgentMessageList，全量渲染（问题 5：不再只渲染尾部页）', () => {
    const messages: AgentMessageDto[] = Array.from({ length: 120 }, (_, index) => ({
      id: `m${index}`,
      kind: 'assistant',
      markdown: `body-${index}`,
      streaming: false,
      createdAt: '2026-01-01T00:00:00.000Z'
    }));
    const html = render({ messages });
    assert.match(html, /data-testid="agent-message-list"/);
    assert.ok(html.includes('agent-message-m0'), '最老消息也应渲染（全量，不按尾部页截断）');
    assert.ok(html.includes('agent-message-m119'), '最新消息应渲染');
    assert.ok(!html.includes('加载更早消息'), '不再有「加载更早消息」假分页按钮');
    assert.ok(!html.includes('查看更新消息'), '不再有「查看更新消息」按钮');
  });

  it('消息流为空时回落欢迎态 / legacy 内容', () => {
    const html = render({ messages: [] });
    assert.ok(!html.includes('data-testid="agent-message-list"'));
    assert.match(html, /data-testid="agent-empty-state"/);
  });

  it('agent 生产源码不含绝对路径字面量（负向扫描）', () => {
    const agentDir = join(__SOULFORGE_RENDERER_ROOT__, 'agent');
    const source = readdirSync(agentDir)
      .filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.includes('.test.'))
      .map((name) => readFileSync(join(agentDir, name), 'utf8'))
      .join('\n');
    // 盘符绝对路径（排除 soulforge:// 这类 scheme，用字母前导否定）。soulforge 里
    // 唯一合法的 `://` 是资源 URI，不携带本机路径。
    assert.ok(
      !/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/.test(source),
      'agent 生产源码不应包含盘符绝对路径字面量'
    );
  });
});

describe('AGENT-60D 消息流四态与 Change Review（§12.5/§12.9/§12.10）', () => {
  function approvalTask(overrides: {
    state?: Partial<ReturnType<typeof approvalFixture>>;
    panel?: Partial<AgentSidebarProps['task']>;
  } = {}) {
    const fixture = { ...approvalFixture(), ...(overrides.state ?? {}) };
    return render({ task: { ...render0Task(), ...(overrides.panel ?? {}), task: fixture } });
  }

  it('Change Review 卡显示操作/目标/diff/影响/验证/备份/回滚七要素', () => {
    const html = approvalTask();
    assert.match(html, /data-testid="agent-approval-card"/, '审批卡进入消息流');
    for (const row of ['operation', 'target', 'diff', 'impact', 'validation', 'backup', 'rollback']) {
      assert.match(html, new RegExp(`data-testid="approval-row-${row}"`), `七要素缺 ${row}`);
    }
    // 有 diff 时目标/diff/影响有真实内容，验证/备份/回滚如实显示不可用（不编造）。
    assert.match(html, /m12b\/param\/gameparam\.parambnd\.dcx/, '目标显示逻辑目标');
    assert.match(html, /agent-approval-card-diff-body/, 'diff 有真实内容');
    assert.match(html, /\+1 \/ -1 行/, '影响范围来自 diff 统计');
    const unavailableCount = (html.match(/approval-unavailable/g) ?? []).length;
    assert.ok(unavailableCount >= 3, `验证/备份/回滚至少 3 处不可用，实际 ${unavailableCount}`);
    assert.match(html, /批准并提交/, '唯一主按钮');
    assert.match(html, /data-testid="agent-approval-card-approve"/);
    assert.match(html, /data-testid="agent-approval-card-reject"/);
  });

  it('缺 diff 的审批如实显示不可用，不编造内容', () => {
    const html = approvalTask({
      state: {
        pendingApprovals: [{
          callId: 'c-no-diff',
          step: 2,
          toolName: 'rollback_operation',
          permissionLevel: 'rollback',
          argumentsJson: '{"opId":"op-1"}',
          diff: null,
          preview: null
        }]
      }
    });
    assert.match(html, /approval-unavailable/, '目标/diff/影响缺数据时如实显示不可用');
    assert.match(html, /主进程未能为该调用生成 diff/, 'diff 缺失的说明存在');
  });

  it('提交失败显示失败阶段与回滚结果（结构化诊断，不吞异常）', () => {
    const html = approvalTask({
      panel: { approvalError: 'AGENT_SESSION_ENDED——会话已结束，回答未采纳。' }
    });
    assert.match(html, /data-testid="agent-approval-card-failure"/);
    assert.match(html, /agent-approval-card-failure-stage/, '失败阶段必须显示');
    assert.match(html, /失败阶段：respond/, 'respond 阶段名显示');
    assert.match(html, /agent-approval-card-failure-rollback/, '回滚结果必须显示');
    assert.match(html, /自动回滚：未执行/, '回滚结果如实显示');
    assert.match(html, /AGENT_SESSION_ENDED/, '结构化诊断原文保留');
  });

  it('tool call 默认单行折叠，展开后才显示详情', () => {
    const running = {
      ...INITIAL_AGENT_TASK_STATE,
      sessionId: 's',
      phase: 'running' as const,
      toolCalls: [{
        callId: 'tool-1',
        name: 'propose_text_patch',
        step: 1,
        status: 'running' as const,
        argumentsJson: '{"targetPath":"m12b/param/x.dcx"}'
      }]
    };
    const html = render({ task: { ...render0Task(), task: running } });
    // 折叠 = details 不带 open 属性，单行摘要可见。
    assert.match(html, /data-testid="agent-tool-activity-tool-1"/);
    assert.match(html, /<details class="agent-tool-activity__details">/, '折叠态 details 不带 open');
    assert.match(html, /propose_text_patch/, '单行摘要显示工具名');
    // 详情仍在 DOM（details 内），展开才可见。
    assert.match(html, /data-testid="agent-tool-detail-tool-1"/);
    assert.match(html, /m12b\/param\/x\.dcx/, '参数详情在 details 内');
  });

  it('四态渲染：conversation / tool-running / approval / failure', () => {
    // conversation：消息流
    const conversation = render({
      messages: [{ id: 'm1', kind: 'user', text: '你好', contextSnapshotId: 'snap', createdAt: '2026-01-01T00:00:00.000Z' }]
    });
    assert.match(conversation, /data-testid="agent-message-list"/);
    assert.ok(!conversation.includes('data-testid="agent-approval-card"'));

    // approval：待审批卡
    const approvalHtml = approvalTask();
    assert.match(approvalHtml, /data-testid="agent-approval-card"/);
    assert.match(approvalHtml, /data-testid="agent-header-state"/);

    // failure：失败态有界诊断
    const failed = {
      ...INITIAL_AGENT_TASK_STATE,
      sessionId: 's',
      phase: 'error' as const,
      error: { code: 'AGENT_SESSION_FAILED', message: '模型调用超时。' }
    };
    const failureHtml = render({ task: { ...render0Task(), task: failed } });
    assert.match(failureHtml, /data-testid="agent-failure"/);
    assert.match(failureHtml, /AGENT_SESSION_FAILED/, '错误码显示');
  });

  it('失败态/审批态不替换整个 dock：header、composer 与上下文仍在', () => {
    const failed = {
      ...INITIAL_AGENT_TASK_STATE,
      sessionId: 's',
      phase: 'error' as const,
      error: { code: 'AGENT_SESSION_FAILED', message: '很长的失败信息，不会撑爆整个侧栏。' }
    };
    const html = render({ task: { ...render0Task(), task: failed } });
    assert.match(html, /data-testid="agent-failure"/);
    assert.match(html, /class="agent__header"/, 'header 仍在');
    assert.match(html, /class="agent__composer"/, 'composer 仍在');
    assert.match(html, /data-testid="agent-composer-context"/, '上下文仍在');
    // 失败卡有界：CSS 层限高（max-height），DOM 层不扩散到 sidebar 之外。
    assert.ok(html.includes('agent-failure-card'), '失败卡 class 存在');
  });

  it('模型/工具/历史迁到二级抽屉，主栏不再常驻', () => {
    const running = {
      ...INITIAL_AGENT_TASK_STATE,
      sessionId: 's',
      phase: 'running' as const,
      toolCalls: [{
        callId: 'tool-1', name: 'search_resources', step: 1, status: 'running' as const
      }]
    };
    const html = render({ task: { ...render0Task(), task: running } });
    // S11：抽屉收起时不渲染（整列换页）——主栏不常驻任务面板/工具库存，抽屉
    // 只在打开时作为第二个面出现。
    assert.ok(!html.includes('data-testid="agent-secondary-drawer"'), '抽屉收起时不占 DOM');
    assert.ok(!html.includes('data-testid="agent-task-panel"'), '主栏不再常驻任务面板');
    assert.ok(!html.includes('data-testid="agent-tool-inventory"'), '工具库存不在主栏');
    // 工具库存确实在抽屉内：直接渲染抽屉历史视图验证归属。
    const drawerHtml = renderToStaticMarkup(
      <AgentSecondaryDrawer
        open={true}
        view="history"
        onClose={() => undefined}
        onSwitchView={() => undefined}
        task={render0Task()}
        tools={[{ name: 'search_resources', description: '搜索资源', permission: 'read' }]}
        permissionLockReason="由主进程锁定为计划模式"
        settings={{
          provider: 'mock',
          permissionMode: 'plan',
          permissionLockReason: '锁',
          onProviderChange: () => undefined
        }}
      />
    );
    assert.match(drawerHtml, /data-testid="agent-tool-inventory"/, '工具库存迁入抽屉');
    assert.match(drawerHtml, /search_resources/, '抽屉内显示工具名');
  });

  it('S11 抽屉整列换页：打开面只有抽屉，不含欢迎/composer/资源引用', () => {
    // SSR 下 drawerView 是内部 state（null），侧边栏挂载面即主面；抽屉面用
    // 直接渲染验证——开关、标题独占一行，且不携带主栏任何元素。
    const drawerHtml = renderToStaticMarkup(
      <AgentSecondaryDrawer
        open={true}
        view="settings"
        onClose={() => undefined}
        onSwitchView={() => undefined}
        task={render0Task()}
        tools={[]}
        permissionLockReason="由主进程锁定为计划模式"
        settings={{
          provider: 'mock',
          permissionMode: 'plan',
          permissionLockReason: '锁',
          onProviderChange: () => undefined
        }}
      />
    );
    assert.match(drawerHtml, /aria-label="模型服务设置"/, '设置面标题');
    assert.match(drawerHtml, /aria-label="抽屉视图"/, '历史/设置切换在抽屉顶栏');
    assert.match(drawerHtml, /aria-pressed="true"/, '当前视图按下态');
    assert.ok(!drawerHtml.includes('agent__composer'), '抽屉面不含 composer');
    assert.ok(!drawerHtml.includes('agent-composer-context'), '抽屉面不含资源引用条');
    assert.ok(!drawerHtml.includes('agent-empty-state'), '抽屉面不含欢迎三勾');
    // S25：设置页只放模型服务表单——运行任务/取消/权限黄条/会话级思考强度全部离开。
    assert.ok(!drawerHtml.includes('运行任务'), '设置页没有运行任务按钮');
    assert.ok(!drawerHtml.includes('取消任务'), '设置页没有取消任务按钮');
    assert.ok(!drawerHtml.includes('agent-task-permission'), '设置页没有权限黄条');
    assert.ok(!drawerHtml.includes('agent-session-controls'), '设置页没有会话级控件');
    // 一列表单：协议 → 服务地址 → 模型 ID → 显示名称 → 密钥 → 高级 → 页脚按钮。
    assert.match(drawerHtml, /协议（API 格式）/);
    assert.match(drawerHtml, /服务地址/);
    assert.match(drawerHtml, /模型 ID/);
    assert.match(drawerHtml, /显示名称/);
    assert.match(drawerHtml, /API 密钥/);
    assert.match(drawerHtml, />取消</, '页脚取消按钮');
    assert.match(drawerHtml, />重置</, '页脚重置按钮');
    assert.match(drawerHtml, />保存</, '页脚保存按钮');
    // S26：抽屉面没有主栏产品名（AgentDockHeader 已卸掉），同一时刻只有一个标题。
    assert.ok(!drawerHtml.includes('agent-dock-header__product'), '抽屉面不含主栏产品名');
    assert.ok(!drawerHtml.includes('>SoulForge<'), '抽屉面不含 SoulForge 产品名');
    // 抽屉背景必须不透明：浅色主题 8% --forge-0 会把底下字透出来（叠字根因）。
    assert.match(
      readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css'), 'utf8'),
      /\.agent-secondary-drawer \{[\s\S]*?background: var\(--forge-1\);/,
      '抽屉背景是不透明实色'
    );
    // 历史/设置互相可达：历史视图里也有切换控件（不再只有「模型设置」一个方向）。
    const historyHtml = renderToStaticMarkup(
      <AgentSecondaryDrawer
        open={true}
        view="history"
        onClose={() => undefined}
        onSwitchView={() => undefined}
        task={render0Task()}
        tools={[]}
        permissionLockReason="由主进程锁定为计划模式"
        settings={{
          provider: 'mock',
          permissionMode: 'plan',
          permissionLockReason: '锁',
          onProviderChange: () => undefined
        }}
      />
    );
    assert.match(historyHtml, /aria-label="抽屉视图"/, '历史视图顶栏也有切换');
    assert.ok(!historyHtml.includes('agent__composer'), '历史面不含 composer');
  });

  it('关闭 dock 不取消 main-owned task：收起仍保留消息流，取消控件只在抽屉', () => {
    const running = {
      ...INITIAL_AGENT_TASK_STATE,
      sessionId: 's',
      phase: 'running' as const
    };
    const closed = render({ open: false, task: { ...render0Task(), task: running } });
    assert.match(closed, /class="agent is-collapsed"/);
    assert.match(closed, /data-testid="agent-task-status"/, '收起不卸载运行中状态');
    assert.match(closed, /class="agent__composer"/, 'composer 仍在');
    // 关闭按钮走 onClose（App 只隐藏 dock），不映射到取消通道。
    assert.match(closed, /aria-label="关闭 Agent 面板"/);
  });

  it('stop 只停当前生成：运行中 composer 停止键在场，任务级取消移入抽屉', () => {
    const running = {
      ...INITIAL_AGENT_TASK_STATE,
      sessionId: 's',
      phase: 'running' as const
    };
    const html = render({ task: { ...render0Task(), task: running } });
    assert.match(html, /data-testid="composer-stop"/, '运行中停止键在 composer');
    assert.ok(!html.includes('data-testid="agent-task-cancel"'), '任务级取消不在主栏');
    // 取消控件只存在于抽屉视图（打开时才有）：直接渲染抽屉验证归属。
    const cancelHtml = renderToStaticMarkup(
      <AgentSecondaryDrawer
        open={true}
        view="history"
        onClose={() => undefined}
        onSwitchView={() => undefined}
        task={render0Task()}
        tools={[]}
        permissionLockReason="由主进程锁定为计划模式"
        settings={{
          provider: 'mock',
          permissionMode: 'plan',
          permissionLockReason: '锁',
          onProviderChange: () => undefined
        }}
      />
    );
    assert.match(cancelHtml, /data-testid="agent-task-cancel"/, '任务级取消在二级抽屉(历史页)');
  });
});

/** AGENT-60D：带 unified diff 的待审批任务状态。 */
function approvalFixture(): AgentTaskState {
  const pendingApprovals: AgentApprovalView[] = [{
    callId: 'approval-1',
    step: 1,
    toolName: 'propose_text_patch',
    permissionLevel: 'commit',
    argumentsJson: '{"targetPath":"m12b/param/gameparam.parambnd.dcx","newText":"x"}',
    diff: {
      targetPath: 'm12b/param/gameparam.parambnd.dcx',
      unifiedDiff: '--- m12b/param/gameparam.parambnd.dcx\n+++ m12b/param/gameparam.parambnd.dcx\n@@ -1 +1 @@\n-old\n+new\n',
      addedLines: 1,
      removedLines: 1,
      newFile: false
    },
    preview: {
      targetPath: 'm12b/param/gameparam.parambnd.dcx',
      targetUri: null,
      newText: 'x',
      truncatedBytes: 0,
      changeCount: 1
    }
  }];
  return {
    ...INITIAL_AGENT_TASK_STATE,
    sessionId: 'session-1',
    phase: 'running' as const,
    pendingApprovals
  };
}

/** 复用默认 task props，避免每个用例重复整块字面量。 */
function render0Task(): AgentSidebarProps['task'] {
  return {
    task: INITIAL_AGENT_TASK_STATE,
    services: [{ id: 'svc-1', displayName: '本地兼容模型服务', hasCredential: true, protocol: 'openai-compatible' }],
    selectedServiceId: 'svc-1',
    runBlocker: null,
    sessions: [],
    sessionsError: null,
    sessionDetail: null,
    onSelectService: () => undefined,
    onRun: () => undefined,
    onCancel: () => undefined,
    onRefreshSessions: () => undefined,
    onLoadSession: () => undefined,
    onResumeSession: () => undefined,
    onRespondApproval: () => undefined,
    respondingApprovalCallId: null,
    approvalError: null
  };
}

describe('S9：Ask 菜单 portal 后 CSS 用 fixed（锚点是 viewport 坐标）', () => {
  it('agent-mode-menu 是 position:fixed，不是 absolute（absolute 相对初始包含块，滚动漂移）', () => {
    const css = readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css'),
      'utf8'
    );
    assert.match(css, /\.agent-mode-menu \{ position: fixed;/);
    assert.doesNotMatch(css, /\.agent-mode-menu \{ position: absolute;/);
  });

  it('菜单已 portal 到 document.body，锚点取 viewport 坐标（getBoundingClientRect）', () => {
    const source = readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'agent', 'AgentParticipantBar.tsx'),
      'utf8'
    );
    assert.match(source, /createPortal\(/);
    assert.match(source, /document\.body/);
    assert.match(source, /getBoundingClientRect\(\)/);
  });
});
