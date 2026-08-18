/**
 * AGENT-60C §12.11 资源引用接线测试。
 *
 * 覆盖三层：
 * 1. reduceAgentResourceReferenceDraft 纯状态机（create-requested / succeeded /
 *    failed / remove / §12.11 上限 16 / token 去重）；
 * 2. createResourceReferenceFlow 编排：触发 → bridge.createAgentResourceReference
 *    (selection) → 成功写引用 / 失败写诊断 / IPC 抛异常也写诊断（不吞异常）；
 * 3. SSR 渲染：AgentResourceReferencePicker（创建中禁用、诊断渲染、无选区禁用）与
 *    AgentSidebar（桥接可用时「添加资源引用」真实可用；无选区诚实禁用）。
 *
 * 与 agentSidebarRender.test.tsx 的边界：那边 window={}（bridge 缺失 → 诚实
 * disabled）；本文件给 window.soulforge 一个假 bridge，验证「桥接可用」的真实
 * 可用路径。node:test 按文件隔离打包，两个文件的 rendererRuntime 缓存互不干扰。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AgentResourceReference,
  EditorSelectionContext
} from '@soulforge/shared';
import type { AgentSidebarProps } from './AgentSidebar.js';
import { AgentSidebar } from './AgentSidebar.js';
import { AgentResourceReferencePicker } from './AgentResourceReferencePicker.js';
import {
  AGENT_RESOURCE_REFERENCE_MAX,
  canAddResourceReference,
  createInitialResourceReferenceDraft,
  createResourceReferenceFlow,
  reduceAgentResourceReferenceDraft,
  type AgentResourceReferenceDraftEvent
} from './agentResourceReferences.js';
import { INITIAL_AGENT_TASK_STATE } from './agentTaskState.js';

// node 环境没有 window；getRendererBridge 读 window.soulforge。给一个带
// createAgentResourceReference 的假 bridge（openWorkspaceDialog/scanWorkspace 是
// rendererRuntime 判 electron 的必需入口），让本文件验证「桥接可用」路径。
(globalThis as unknown as { window: Record<string, unknown> }).window = {
  soulforge: {
    openWorkspaceDialog: () => undefined,
    scanWorkspace: () => undefined,
    createAgentResourceReference: async () => ({
      ok: false as const,
      error: { code: 'NOT_USED', message: 'not used in SSR' }
    })
  }
};

function selection0(domain: EditorSelectionContext['domain'] = 'param'): EditorSelectionContext {
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

function ref(token: string, label: string, domain: EditorSelectionContext['domain'] = 'param'): AgentResourceReference {
  return { token, domain, label, expiresAt: '2026-01-01T00:00:00.000Z' };
}

/** main 签发结果的形状（与 AgentResourceReferenceCreateIpcResult 结构一致）。 */
type CreateResult =
  | { ok: true; reference: AgentResourceReference }
  | { ok: false; error: { code: string; message: string } };

describe('§12.11 资源引用草稿状态机（reduceAgentResourceReferenceDraft）', () => {
  it('create-requested 进入创建中并清旧诊断（重试不残留上一次错误）', () => {
    const state = reduceAgentResourceReferenceDraft(
      { resources: [], creating: false, error: '上一次失败' },
      { type: 'create-requested' }
    );
    assert.equal(state.creating, true);
    assert.equal(state.error, null);
  });

  it('create-succeeded 把引用追加进草稿并退出创建中', () => {
    const state = reduceAgentResourceReferenceDraft(
      createInitialResourceReferenceDraft(),
      { type: 'create-requested' }
    );
    const done = reduceAgentResourceReferenceDraft(state, {
      type: 'create-succeeded',
      reference: ref('agent-ref:tok-1', 'PARAM · 文档')
    });
    assert.equal(done.creating, false);
    assert.equal(done.error, null);
    assert.equal(done.resources.length, 1);
    assert.equal(done.resources[0]?.label, 'PARAM · 文档');
  });

  it('同一 token 重复添加只去重，不无限累积', () => {
    const once = reduceAgentResourceReferenceDraft(
      createInitialResourceReferenceDraft(),
      { type: 'create-succeeded', reference: ref('agent-ref:tok-dup', 'PARAM · A') }
    );
    const twice = reduceAgentResourceReferenceDraft(once, {
      type: 'create-succeeded',
      reference: ref('agent-ref:tok-dup', 'PARAM · A')
    });
    assert.equal(twice.resources.length, 1, '同 token 应去重');
  });

  it('超过 §12.11 上限 16 时拒绝并给诊断', () => {
    const maxed = createInitialResourceReferenceDraft(
      Array.from({ length: AGENT_RESOURCE_REFERENCE_MAX }, (_, index) =>
        ref(`agent-ref:max-${index}`, `标签 ${index}`))
    );
    assert.ok(!canAddResourceReference(maxed), '前提：已到上限');
    const denied = reduceAgentResourceReferenceDraft(maxed, {
      type: 'create-succeeded',
      reference: ref('agent-ref:max-extra', '标签 extra')
    });
    assert.equal(denied.resources.length, AGENT_RESOURCE_REFERENCE_MAX);
    assert.ok(denied.error !== null && denied.error.includes(String(AGENT_RESOURCE_REFERENCE_MAX)));
  });

  it('create-failed 记录结构化诊断，不吞异常', () => {
    const failed = reduceAgentResourceReferenceDraft(
      createInitialResourceReferenceDraft(),
      { type: 'create-failed', message: 'WORKSPACE_NOT_ANALYZED：请先分析工作区再引用资源。' }
    );
    assert.equal(failed.creating, false);
    assert.match(failed.error ?? '', /WORKSPACE_NOT_ANALYZED/);
  });

  it('remove 按 token 移除，不影响其他引用', () => {
    const state = createInitialResourceReferenceDraft([
      ref('agent-ref:a', 'A'),
      ref('agent-ref:b', 'B'),
      ref('agent-ref:c', 'C')
    ]);
    const removed = reduceAgentResourceReferenceDraft(state, { type: 'remove', token: 'agent-ref:b' });
    assert.deepEqual(removed.resources.map((r) => r.label), ['A', 'C']);
  });
});

describe('createResourceReferenceFlow（触发 → main 签发 → 写回草稿）', () => {
  it('触发后调用 createAgentResourceReference(selection)，成功把引用写进草稿', async () => {
    const calls: EditorSelectionContext[] = [];
    const selection = selection0('param');
    const create = async (s: EditorSelectionContext): Promise<CreateResult> => {
      calls.push(s);
      return { ok: true, reference: ref('agent-ref:tok-1', 'PARAM · 文档') };
    };
    const events: AgentResourceReferenceDraftEvent[] = [];
    const dispatch = (event: AgentResourceReferenceDraftEvent): void => { events.push(event); };

    await createResourceReferenceFlow(create, selection, dispatch);

    assert.deepEqual(calls, [selection], 'bridge.createAgentResourceReference 必须收到当前选区');
    assert.deepEqual(events.map((e) => e.type), ['create-requested', 'create-succeeded']);
    const success = events[1];
    assert.ok(success !== undefined && success.type === 'create-succeeded');
    if (success !== undefined && success.type === 'create-succeeded') {
      assert.equal(success.reference.label, 'PARAM · 文档');
      assert.ok(!success.reference.token.includes('\\'), 'opaque token 不应携带路径');
    }
  });

  it('main 返回失败时写结构化诊断', async () => {
    const create = async (_s: EditorSelectionContext): Promise<CreateResult> => ({
      ok: false,
      error: { code: 'AGENT_SELECTION_UNSAFE', message: 'documentId 不得包含绝对路径。' }
    });
    const events: AgentResourceReferenceDraftEvent[] = [];
    await createResourceReferenceFlow(create, selection0(), (e) => { events.push(e); });
    assert.deepEqual(events.map((e) => e.type), ['create-requested', 'create-failed']);
    const failed = events[1];
    assert.ok(failed !== undefined && failed.type === 'create-failed');
    if (failed !== undefined && failed.type === 'create-failed') {
      assert.match(failed.message, /AGENT_SELECTION_UNSAFE/);
    }
  });

  it('IPC 抛异常时也写诊断，不吞异常', async () => {
    const create = async (_s: EditorSelectionContext): Promise<CreateResult> => {
      throw new Error('ipcRenderer.invoke 拒绝');
    };
    const events: AgentResourceReferenceDraftEvent[] = [];
    await createResourceReferenceFlow(create, selection0(), (e) => { events.push(e); });
    assert.deepEqual(events.map((e) => e.type), ['create-requested', 'create-failed']);
    const failed = events[1];
    assert.ok(failed !== undefined && failed.type === 'create-failed');
    if (failed !== undefined && failed.type === 'create-failed') {
      assert.match(failed.message, /拒绝/);
    }
  });
});

describe('AgentResourceReferencePicker 渲染', () => {
  it('创建中禁用按钮并显示创建中，防重复提交', () => {
    const html = renderToStaticMarkup(
      <AgentResourceReferencePicker
        resources={[]}
        selection={selection0()}
        creating
        onCreate={() => undefined}
      />
    );
    const addButton = /<button[^>]*aria-label="添加资源引用"[^>]*>/.exec(html)?.[0];
    assert.ok(addButton, '添加资源引用按钮必须存在');
    assert.ok(addButton.includes('disabled'), '创建中应禁用按钮');
    assert.match(html, /创建中/);
  });

  it('失败诊断渲染出来（role=alert），不携带 token', () => {
    const html = renderToStaticMarkup(
      <AgentResourceReferencePicker
        resources={[]}
        selection={selection0()}
        error="WORKSPACE_NOT_ANALYZED：请先分析工作区再引用资源。"
        onCreate={() => undefined}
      />
    );
    assert.match(html, /data-testid="agent-resource-ref-error"/);
    assert.match(html, /WORKSPACE_NOT_ANALYZED/);
    assert.match(html, /role="alert"/, '诊断必须有可访问的 alert 语义');
    assert.ok(!html.includes('agent-ref:'), '诊断渲染不得引入 token');
  });

  it('无选区时诚实 disabled', () => {
    const html = renderToStaticMarkup(
      <AgentResourceReferencePicker
        resources={[]}
        selection={null}
        onCreate={() => undefined}
      />
    );
    const addButton = /<button[^>]*aria-label="添加资源引用"[^>]*>/.exec(html)?.[0];
    assert.ok(addButton !== undefined && addButton.includes('disabled'), '无选区应 disabled');
  });

  it('有选区且有真实回调时可用', () => {
    const html = renderToStaticMarkup(
      <AgentResourceReferencePicker
        resources={[]}
        selection={selection0()}
        onCreate={() => undefined}
      />
    );
    const addButton = /<button[^>]*aria-label="添加资源引用"[^>]*>/.exec(html)?.[0];
    assert.ok(addButton !== undefined && !addButton.includes('disabled'), '有选区+回调应可用');
  });

  it('已达 §12.11 上限时禁用并给上限说明', () => {
    const maxed = Array.from({ length: AGENT_RESOURCE_REFERENCE_MAX }, (_, index) =>
      ref(`agent-ref:max-${index}`, `标签 ${index}`));
    const html = renderToStaticMarkup(
      <AgentResourceReferencePicker
        resources={maxed}
        selection={selection0()}
        onCreate={() => undefined}
      />
    );
    const addButton = /<button[^>]*aria-label="添加资源引用"[^>]*>/.exec(html)?.[0];
    assert.ok(addButton !== undefined && addButton.includes('disabled'), '达上限应禁用');
    assert.match(html, new RegExp(String(AGENT_RESOURCE_REFERENCE_MAX)));
  });
});

describe('AgentSidebar 资源引用接线（桥接可用）', () => {
  function render(overrides: Partial<AgentSidebarProps> = {}): string {
    const props: AgentSidebarProps = {
      open: true,
      agentWidth: 440,
      agentMinWidth: 96,
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

  function render0Task(): AgentSidebarProps['task'] {
    return {
      task: INITIAL_AGENT_TASK_STATE,
      services: [{ id: 'svc-1', displayName: '本地兼容模型服务', hasCredential: true, protocol: 'openai-compatible' }],
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

  it('桥接可用且有选区时「添加资源引用」真实可用（不再是占位 disabled）', () => {
    const html = render({
      selection: { ...selection0('param'), documentId: 'm12b/param/gameparam.parambnd.dcx' }
    });
    const addButton = /<button[^>]*aria-label="添加资源引用"[^>]*>/.exec(html)?.[0];
    assert.ok(addButton, '添加资源引用按钮必须存在');
    assert.ok(!addButton.includes('disabled'), '60C 接线后桥接可用+有选区应可点');
  });

  it('没有可用选区时入口诚实禁用并给说明', () => {
    const html = render({ selection: null, selectedFilePath: null });
    const addButton = /<button[^>]*aria-label="添加资源引用"[^>]*>/.exec(html)?.[0];
    assert.ok(addButton !== undefined && addButton.includes('disabled'), '无选区应 disabled');
    assert.match(html, /没有可引用的语义选区/);
  });

  it('已添加的引用渲染 label 并提供移除入口，token 不进入 DOM', () => {
    const html = render({
      selection: selection0('param'),
      resources: [ref('agent-ref:sidebar-token', 'PARAM · 文档')]
    });
    assert.match(html, /PARAM · 文档/);
    assert.match(html, /aria-label="移除引用 PARAM · 文档"/);
    assert.ok(!html.includes('agent-ref:sidebar-token'), 'token 不应进入 DOM');
  });
});
