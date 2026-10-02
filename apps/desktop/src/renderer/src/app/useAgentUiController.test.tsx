import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import { useAgentUiController, type AgentUiBridge, type AgentUiController, type AgentUiOptions } from './useAgentUiController.js';
import type { AiAgentEventEnvelope } from '../../../main/ipc.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }
  } });
});
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Result<K extends keyof AgentUiBridge> = AgentUiBridge[K] extends (...args: never[]) => Promise<infer T> ? T : never;
function service(id: string, hasCredential = true) {
  return { id, displayName: id, protocol: 'openai-compatible' as const, baseUrl: 'https://example.invalid', model: 'model', hasCredential, createdAt: '2026-10-02', updatedAt: '2026-10-02' };
}
function session(sessionPath: string) {
  return { sessionPath, fileName: sessionPath, sessionId: 'saved', startedAt: null, messageCount: 2, parseErrors: 0, interrupted: false, compactedWindows: 0, sizeBytes: 20, modifiedAt: '2026-10-02' };
}
function detail(messageCount = 3): Result<'loadAiAgentSession'> {
  return { ok: true, meta: null, messageCount, parseErrors: 1, interrupted: true, compactedWindows: 2, messagesPage: [] };
}
function envelope(seq: number, event: AiAgentEventEnvelope['event'], sessionId = 'run-1'): AiAgentEventEnvelope {
  return { sessionId, seq, event };
}
function ports() {
  let callback: ((event: AiAgentEventEnvelope) => void) | null = null;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const requests: Parameters<AgentUiBridge['runAiAgent']>[0][] = [];
  const cancellations: string[] = [];
  const approvals: Parameters<AgentUiBridge['respondAiAgentApproval']>[0][] = [];
  const tools: Array<[string, unknown]> = [];
  const replays: Array<[string, unknown]> = [];
  const permissions: string[] = [];
  const statuses: string[] = [];
  const toasts: Array<[string, 'ok' | 'warn']> = [];
  const desktopOnly: string[] = [];
  const bridge: AgentUiBridge = {
    listModelServices: async () => [service('unconfigured', false), service('configured')],
    listAiTools: async () => [],
    onAiAgentEvent: handler => { callback = handler; subscriptions++; return () => { callback = null; unsubscriptions++; }; },
    getAiAgentEvents: async (id, seq) => { replays.push([id, seq]); return { ok: true, events: [] }; },
    requestAiAgentPermission: async mode => { permissions.push(mode); return { ok: true, mode, grantId: 'opaque-grant', expiresAt: '2026-10-02' }; },
    runAiAgent: async request => { requests.push(request); return { ok: true, sessionId: `run-${requests.length}` }; },
    cancelAiAgent: async id => { cancellations.push(id); return { ok: true }; },
    respondAiAgentApproval: async request => { approvals.push(request); return { ok: true, matched: true }; },
    listAiAgentSessions: async () => ({ ok: true, sessions: [session('history.jsonl')] }),
    loadAiAgentSession: async () => detail(),
    runAiTool: async (name, input) => { tools.push([name, input]); return { ok: true, data: { name } }; }
  };
  const options: AgentUiOptions = {
    bridge,
    workspace: { workspaceSessionId: 'workspace-a' },
    selectedFile: { relativePath: 'event/common.emevd.dcx', resourceKind: 'event' },
    lastOpenFailure: null,
    setStatus: message => statuses.push(message),
    pushToast: (message, kind) => toasts.push([message, kind]),
    announceDesktopOnly: operation => desktopOnly.push(operation),
    describeBridgeAbsence: operation => `unavailable:${operation}`
  };
  return { bridge, options, requests, cancellations, approvals, tools, replays, permissions, statuses, toasts, desktopOnly,
    emit: async (event: AiAgentEventEnvelope) => act(async () => callback?.(event)),
    subscriptions: () => subscriptions, unsubscriptions: () => unsubscriptions };
}
async function mount(options: AgentUiOptions, strict = false) {
  let current!: AgentUiController;
  function Host({ options }: { options: AgentUiOptions }) {
    current = useAgentUiController(options);
    return <span>{current.agentTask.phase}:{current.agentGoal}</span>;
  }
  const element = (value: AgentUiOptions) => strict ? <React.StrictMode><Host options={value} /></React.StrictMode> : <Host options={value} />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(options)); });
  mounted.push(renderer);
  return { current: () => current,
    update: async (value: AgentUiOptions) => act(async () => renderer.update(element(value))),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); } };
}
async function prompt(h: Awaited<ReturnType<typeof mount>>, text = '检查事件') {
  await act(async () => h.current().setAiPrompt(text));
}
async function run(h: Awaited<ReturnType<typeof mount>>, text = '检查事件') {
  await prompt(h, text);
  await act(async () => h.current().sendAgentPrompt());
}

it('restores the opaque workspace dock key, valid thinking/mode settings and original defaults', async () => {
  storage.set('soulforge.ui.agentDock.v1.workspace-a.open', 'false');
  storage.set('soulforge.ui.agentDock.v1.workspace-a.width', '900');
  storage.set('soulforge:agentInteractionMode', 'edit');
  storage.set('soulforge.ui.aiThinking', 'xhigh');
  const p = ports(); const h = await mount(p.options);
  assert.equal(h.current().agentOpen, false);
  assert.equal(h.current().agentWidth, 620);
  assert.equal(h.current().aiThinking, 'xhigh');
  assert.equal(h.current().agentInteractionMode, 'edit');
  assert.equal(h.current().aiMode, 'plan');
  assert.equal(h.current().aiProvider, 'mock');
  assert.equal(h.current().agentServiceId, 'configured');
  assert.equal(h.current().agentServices[0]?.id, 'unconfigured');
  assert.equal(storage.get('soulforge.ui.agentDock.v1.workspace-a.width'), '620');
  await act(async () => h.current().changeAgentInteractionMode('bypass'));
  assert.equal(storage.get('soulforge:agentInteractionMode'), 'bypass');
});

it('keeps one event listener during state changes and balances StrictMode cleanup', async () => {
  const p = ports(); const h = await mount(p.options, true);
  const subscribed = p.subscriptions();
  await prompt(h); await act(async () => h.current().setAgentOpen(false));
  assert.equal(p.subscriptions(), subscribed);
  assert.equal(p.subscriptions() - p.unsubscriptions(), 1);
  await h.unmount();
  assert.equal(p.subscriptions(), p.unsubscriptions());
});

it('submits unchanged native task arguments with selection, failure, opaque references and permission grant', async () => {
  const p = ports();
  p.options.lastOpenFailure = { kind: 'event-open-failed', document: 'common', code: 'FAILED', message: '读取失败' };
  const h = await mount(p.options);
  const resources = [{ token: 'resource-opaque', domain: 'event' as const, label: 'event', expiresAt: '2026-10-03' }];
  await act(async () => {
    h.current().setAgentResources(resources);
    h.current().changeAgentInteractionMode('edit');
    h.current().setAiThinking('high');
  });
  await run(h, '  检查事件  ');
  assert.equal(p.requests.length, 1);
  assert.deepEqual(p.requests[0], {
    configId: 'configured', prompt: '检查事件', selection: { label: 'event/common.emevd.dcx', resourceKind: 'event' },
    openFailure: p.options.lastOpenFailure, resources, streaming: true, timeoutMs: 180_000, useRagSearch: true,
    thinkingLevel: 'high', mode: 'normal', permissionGrantId: 'opaque-grant'
  });
  assert.deepEqual(p.permissions, ['normal']);
  assert.deepEqual(p.replays, [['run-1', 0]]);
  assert.equal(h.current().aiPrompt, '');
});

it('folds queued pushes only after replay and deduplicates replay/live tool and narration events', async () => {
  const p = ports(); const acceptance = deferred<Result<'runAiAgent'>>(); const replay = deferred<Result<'getAiAgentEvents'>>();
  p.bridge.runAiAgent = async request => { p.requests.push(request); return acceptance.promise; };
  p.bridge.getAiAgentEvents = async () => replay.promise;
  const h = await mount(p.options); await prompt(h);
  let running!: Promise<void>;
  await act(async () => { running = h.current().sendAgentPrompt(); });
  assert.match(h.current().agentTask.sessionId!, /^optimistic-/);
  await p.emit(envelope(3, { type: 'session-done', finishReason: 'stop', steps: 1, rolloutFileName: 'run.jsonl' }));
  await p.emit(envelope(2, { type: 'agent-message-delta', step: 1, text: '完成' }));
  await act(async () => { acceptance.resolve({ ok: true, sessionId: 'run-1' }); await running; });
  assert.equal(h.current().agentTask.phase, 'accepted');
  await act(async () => replay.resolve({ ok: true, events: [
    envelope(1, { type: 'tool-call-begin', callId: 'call-1', name: 'inspect', step: 1, argumentsJson: '{}' }),
    envelope(2, { type: 'agent-message-delta', step: 1, text: '完成' })
  ] }));
  await p.emit(envelope(2, { type: 'agent-message-delta', step: 1, text: '完成' }));
  assert.equal(h.current().agentTask.phase, 'done');
  assert.equal(h.current().agentTask.toolCalls.length, 1);
  assert.equal(h.current().agentTask.deltaChars, 2);
  assert.equal(h.current().agentTask.narrations[0]?.text, '完成');
});

it('falls back to queued live events when replay rejects and shows replay truncation', async () => {
  const p = ports(); const replay = deferred<Result<'getAiAgentEvents'>>();
  p.bridge.getAiAgentEvents = async () => replay.promise;
  const h = await mount(p.options); await run(h);
  await p.emit(envelope(1, { type: 'agent-message-delta', step: 1, text: 'live' }));
  await act(async () => replay.reject(new Error('handler unavailable')));
  assert.equal(h.current().agentTask.deltaChars, 4);
  await act(async () => h.current().startNewAgentTask());
  p.bridge.getAiAgentEvents = async () => ({ ok: true, truncated: true, events: [] });
  await run(h);
  assert.equal(h.current().agentIdleNotice, '较早的运行信息已收起，可从会话记录查看');
});

it('sends cancellation after optimistic acceptance and retains cancelling until the native terminal event', async () => {
  const p = ports(); const acceptance = deferred<Result<'runAiAgent'>>();
  p.bridge.runAiAgent = async () => acceptance.promise;
  p.bridge.getAiAgentEvents = async () => ({ ok: true, events: [envelope(1, { type: 'session-accepted', mode: 'plan' })] });
  const h = await mount(p.options); await prompt(h);
  let running!: Promise<void>;
  await act(async () => { running = h.current().sendAgentPrompt(); });
  await act(async () => h.current().cancelAgentTask());
  assert.deepEqual(p.cancellations, []);
  assert.equal(h.current().agentTask.phase, 'cancelling');
  await act(async () => { acceptance.resolve({ ok: true, sessionId: 'run-1' }); await running; });
  assert.deepEqual(p.cancellations, ['run-1']);
  assert.equal(h.current().agentTask.phase, 'cancelling');
  await p.emit(envelope(2, { type: 'session-done', finishReason: 'cancelled', steps: 0, rolloutFileName: 'cancelled.jsonl' }));
  assert.equal(h.current().agentTask.phase, 'done');
  assert.equal(h.current().agentTask.rolloutFileName, 'cancelled.jsonl');
});

it('keeps approval cards until approval-resolved and displays unmatched delivery', async () => {
  const p = ports(); const h = await mount(p.options); await run(h);
  await p.emit(envelope(1, { type: 'approval-requested', callId: 'approval-1', step: 1, toolName: 'commit', permissionLevel: 'commit', argumentsJson: '{}' }));
  p.bridge.respondAiAgentApproval = async request => { p.approvals.push(request); return { ok: true, matched: false }; };
  await act(async () => h.current().respondAgentApproval('approval-1', 'once'));
  assert.deepEqual(p.approvals, [{ sessionId: 'run-1', callId: 'approval-1', decision: 'once' }]);
  assert.equal(h.current().agentTask.pendingApprovals.length, 1);
  assert.match(h.current().approvalError!, /回答未被采纳/);
  await p.emit(envelope(2, { type: 'approval-resolved', step: 1, callId: 'approval-1', toolName: 'commit', decision: 'once', fromMemory: false }));
  assert.equal(h.current().agentTask.pendingApprovals.length, 0);
  assert.equal(h.current().agentTask.approvalDecisions[0]?.decision, 'once');
});

it('preserves explicit resume, bounded session details and safe tool call arguments', async () => {
  const p = ports(); const h = await mount(p.options);
  await act(async () => h.current().refreshAgentSessions());
  await act(async () => h.current().loadAgentSession('history.jsonl'));
  assert.equal(h.current().agentSessions[0]?.sessionPath, 'history.jsonl');
  assert.deepEqual(h.current().agentSessionDetail, { sessionPath: 'history.jsonl', messageCount: 3, parseErrors: 1,
    interrupted: true, compactedWindows: 2, loadedMessages: 0, permissionMode: null, protocol: null });
  await act(async () => h.current().runAgentTask('history.jsonl'));
  assert.equal(p.requests[0]?.prompt, '请继续上一轮会话的任务。');
  assert.equal(p.requests[0]?.resumeSessionPath, 'history.jsonl');
  await act(async () => h.current().runToolSearch('sword'));
  await act(async () => h.current().explainEvent('event://10'));
  assert.deepEqual(p.tools, [['search_resources', { query: 'sword', limit: 8 }], ['explain_event', { uri: 'event://10' }]]);
});

for (const finishReason of ['stop', 'partial', 'max_steps', 'length', 'cancelled']) {
  it(`auto-resumes only native stop completion, including ${finishReason}`, async () => {
    const p = ports(); const h = await mount(p.options); await run(h);
    await p.emit(envelope(1, { type: 'session-done', finishReason, steps: 1, rolloutFileName: 'completed.jsonl' }));
    await run(h, 'next');
    assert.equal(p.requests[1]?.resumeSessionPath, finishReason === 'stop' ? 'completed.jsonl' : undefined);
  });
}

it('shows original no-model and native permission/run failure messages', async () => {
  const p = ports(); p.bridge.listModelServices = async () => [];
  const h = await mount(p.options); await run(h);
  assert.equal(h.current().agentGoal, '检查事件');
  assert.match(h.current().agentIdleNotice!, /尚未配置模型服务/);
  assert.equal(p.requests.length, 0);
  await act(async () => { h.current().setAgentServiceId('configured'); h.current().changeAgentInteractionMode('bypass'); });
  p.bridge.requestAiAgentPermission = async () => ({ ok: false, error: { code: 'DENIED', message: '拒绝' } });
  await run(h);
  assert.equal(h.current().agentTask.error?.code, 'DENIED');
  assert.deepEqual(p.toasts.at(-1), ['Agent 权限未授予：拒绝', 'warn']);
  await act(async () => h.current().changeAgentInteractionMode('plan'));
  p.bridge.runAiAgent = async () => ({ ok: false, error: { code: 'NO_WORKSPACE', message: '没有工作区' } });
  await run(h);
  assert.equal(h.current().agentTask.error?.code, 'NO_WORKSPACE');
});

it('uses browser preview diagnostics without starting native work', async () => {
  const p = ports(); p.options.bridge = null;
  const h = await mount(p.options); await prompt(h);
  await act(async () => {
    await h.current().runAgentTask(); await h.current().cancelAgentTask();
    await h.current().respondAgentApproval('call', 'once'); await h.current().loadAgentSession('session');
    await h.current().runToolSearch('query'); await h.current().explainEvent('event://1');
    await h.current().refreshAgentSessions();
  });
  assert.equal(h.current().agentSessionsError, 'unavailable:读取 AI 会话历史');
  assert.equal(p.desktopOnly.length, 6);
  assert.equal(p.requests.length, 0);
});

it('does not revive a new task when a superseded acceptance fails or arrives late', async () => {
  const p = ports(); const acceptance = deferred<Result<'runAiAgent'>>();
  p.bridge.runAiAgent = async () => acceptance.promise;
  const h = await mount(p.options); await prompt(h);
  let running!: Promise<void>;
  await act(async () => { running = h.current().runAgentTask(); });
  await act(async () => h.current().startNewAgentTask());
  const statusesAfterReset = p.statuses.length;
  await act(async () => { acceptance.resolve({ ok: false, error: { code: 'OLD_ERROR', message: 'old' } }); await running; });
  assert.equal(h.current().agentTask.phase, 'idle');
  assert.equal(p.statuses.length, statusesAfterReset);
  assert.equal(h.current().agentGoal, null);
});

it('does not submit an obsolete prompt after a deferred permission grant and new task reset', async () => {
  const p = ports(); const permission = deferred<Result<'requestAiAgentPermission'>>();
  p.bridge.requestAiAgentPermission = async () => permission.promise;
  const h = await mount(p.options); await act(async () => h.current().changeAgentInteractionMode('edit')); await prompt(h);
  let running!: Promise<void>;
  await act(async () => { running = h.current().runAgentTask(); });
  await act(async () => h.current().startNewAgentTask());
  await act(async () => { permission.resolve({ ok: true, mode: 'normal', grantId: 'old-grant', expiresAt: 'later' }); await running; });
  assert.equal(p.requests.length, 0);
  assert.equal(h.current().agentTask.phase, 'idle');
});

it('ignores obsolete service responses after the bridge changes', async () => {
  const p = ports(); const oldServices = deferred<Result<'listModelServices'>>();
  p.bridge.listModelServices = async () => oldServices.promise;
  const h = await mount(p.options); const next = ports();
  next.bridge.listModelServices = async () => [service('new-service')];
  await h.update({ ...p.options, bridge: next.bridge });
  await act(async () => oldServices.resolve([service('old-service')]));
  assert.equal(h.current().agentServices[0]?.id, 'new-service');
});

it('keeps the latest selected history detail when older loads complete last', async () => {
  const p = ports(); const oldDetail = deferred<Result<'loadAiAgentSession'>>();
  p.bridge.loadAiAgentSession = async path => path === 'old.jsonl' ? oldDetail.promise : detail(7);
  const h = await mount(p.options); let loading!: Promise<void>;
  await act(async () => { loading = h.current().loadAgentSession('old.jsonl'); });
  await act(async () => h.current().loadAgentSession('new.jsonl'));
  await act(async () => { oldDetail.resolve(detail(2)); await loading; });
  assert.equal(h.current().agentSessionDetail?.sessionPath, 'new.jsonl');
  assert.equal(h.current().agentSessionDetail?.messageCount, 7);
});

it('does not publish deferred safe-tool output after a workspace reset', async () => {
  const p = ports(); const output = deferred<Result<'runAiTool'>>();
  p.bridge.runAiTool = async () => output.promise;
  const h = await mount(p.options); let searching!: Promise<void>;
  await act(async () => { searching = h.current().runToolSearch('old'); });
  await act(async () => h.current().resetAgentWorkspaceState());
  await act(async () => { output.resolve({ ok: true, data: 'old' }); await searching; });
  assert.equal(h.current().toolOutput, null);
});

it('does not alter mode or storage for an unrelated session push', async () => {
  const p = ports(); const h = await mount(p.options); await run(h);
  await p.emit(envelope(1, { type: 'session-mode-switched', mode: 'fullPermission' }, 'old-session'));
  assert.equal(h.current().agentInteractionMode, 'ask');
  assert.notEqual(storage.get('soulforge:agentInteractionMode'), 'bypass');
});

it('does not publish run rejection statuses after unmount', async () => {
  const p = ports(); const acceptance = deferred<Result<'runAiAgent'>>();
  p.bridge.runAiAgent = async () => acceptance.promise;
  const h = await mount(p.options); await prompt(h); let running!: Promise<void>;
  await act(async () => { running = h.current().runAgentTask(); });
  await h.unmount(); const before = p.statuses.length;
  await act(async () => { acceptance.reject(new Error('late failure')); await running; });
  assert.equal(p.statuses.length, before);
});

it('does not let an older replay callback publish after bridge replacement', async () => {
  const p = ports(); const replay = deferred<Result<'getAiAgentEvents'>>();
  p.bridge.getAiAgentEvents = async () => replay.promise;
  const h = await mount(p.options); await run(h);
  const next = ports();
  next.bridge.getAiAgentEvents = async (id, seq) => {
    next.replays.push([id, seq]);
    return { ok: true, events: [envelope(1, { type: 'agent-message-delta', step: 1, text: 'current' })] };
  };
  await h.update({ ...p.options, bridge: next.bridge });
  await act(async () => replay.resolve({ ok: true, events: [envelope(2, { type: 'agent-message-delta', step: 1, text: 'obsolete' })] }));
  assert.deepEqual(next.replays, [['run-1', 0]]);
  assert.equal(h.current().agentTask.narrations[0]?.text, 'current');
  assert.equal(p.unsubscriptions(), 1);
});

it('does not publish an old approval error after starting a new task', async () => {
  const p = ports(); const response = deferred<Result<'respondAiAgentApproval'>>();
  const h = await mount(p.options); await run(h);
  p.bridge.respondAiAgentApproval = async () => response.promise;
  let responding!: Promise<void>;
  await act(async () => { responding = h.current().respondAgentApproval('old-approval', 'once'); });
  await act(async () => h.current().startNewAgentTask());
  await act(async () => { response.resolve({ ok: false, error: { code: 'OLD', message: 'late' } }); await responding; });
  assert.equal(h.current().approvalError, null);
  assert.equal(h.current().respondingApprovalCallId, null);
});

it('keeps the latest session list when overlapping history refreshes return out of order', async () => {
  const p = ports(); const old = deferred<Result<'listAiAgentSessions'>>(); let calls = 0;
  p.bridge.listAiAgentSessions = async () => ++calls === 1 ? old.promise : { ok: true, sessions: [session('new.jsonl')] };
  const h = await mount(p.options); let refresh!: Promise<void>;
  await act(async () => { refresh = h.current().refreshAgentSessions(); });
  await act(async () => h.current().refreshAgentSessions());
  await act(async () => { old.resolve({ ok: true, sessions: [session('old.jsonl')] }); await refresh; });
  assert.equal(h.current().agentSessions[0]?.sessionPath, 'new.jsonl');
});

it('deduplicates replayed mode changes with live pushes for the current session', async () => {
  const p = ports(); const replay = deferred<Result<'getAiAgentEvents'>>();
  p.bridge.getAiAgentEvents = async () => replay.promise;
  const h = await mount(p.options); await run(h);
  const switched = envelope(1, { type: 'session-mode-switched', mode: 'normal' });
  await p.emit(switched);
  await act(async () => replay.resolve({ ok: true, events: [switched] }));
  assert.equal(h.current().agentInteractionMode, 'edit');
  await act(async () => h.current().changeAgentInteractionMode('plan'));
  await p.emit(switched);
  assert.equal(h.current().agentInteractionMode, 'plan');
  assert.equal(storage.get('soulforge:agentInteractionMode'), 'plan');
});

it('preserves native tool success facts after cancellation and native terminal settlement', async () => {
  const p = ports(); const h = await mount(p.options); await run(h);
  await p.emit(envelope(1, { type: 'tool-call-begin', callId: 'commit-1', name: 'commit', step: 1, argumentsJson: '{}' }));
  await p.emit(envelope(2, { type: 'tool-call-end', callId: 'commit-1', name: 'commit', step: 1, ok: true, code: 'COMMITTED' }));
  await act(async () => h.current().cancelAgentTask());
  await p.emit(envelope(3, { type: 'session-done', finishReason: 'cancelled', steps: 1, rolloutFileName: 'committed.jsonl' }));
  assert.equal(h.current().agentTask.toolCalls[0]?.status, 'ok');
  assert.equal(h.current().agentTask.toolCalls[0]?.code, 'COMMITTED');
  assert.equal(h.current().agentTask.rolloutFileName, 'committed.jsonl');
});

it('settles valid citation hits and strips attachment display labels from the native submission', async () => {
  const p = ports(); const h = await mount(p.options);
  await act(async () => { h.current().setCiteSelecting(true); h.current().handleCiteSettle([]); });
  assert.equal(h.current().citeSelecting, false);
  assert.match(p.toasts[0]![0], /没有可引用/);
  const hits = [{ kind: 'param-row' as const, library: 'gameparam', table: 'Sword', rowId: 10 }];
  await act(async () => h.current().handleCiteSettle(hits));
  assert.deepEqual(h.current().pendingCiteHits, hits);
  const chip = { token: 'opaque-image', label: 'visible-name', mediaType: 'image/png' as const, byteLength: 20, expiresAt: '2026-10-03' };
  await act(async () => h.current().handleAgentAttachmentsChange([chip]));
  await run(h);
  assert.deepEqual(p.requests[0], {
    configId: 'configured', prompt: '检查事件', selection: { label: 'event/common.emevd.dcx', resourceKind: 'event' },
    attachments: [{ token: 'opaque-image', mediaType: 'image/png', byteLength: 20, expiresAt: '2026-10-03' }],
    streaming: true, timeoutMs: 180_000, useRagSearch: true, thinkingLevel: 'medium', mode: 'plan'
  });
});

it('preserves task and prompt during the original workspace and selection display resets', async () => {
  const p = ports(); const h = await mount(p.options); await run(h);
  await prompt(h, 'next prompt');
  const currentTask = h.current().agentTask;
  await act(async () => h.current().resetAgentSelectionState());
  assert.equal(h.current().agentTask, currentTask);
  assert.equal(h.current().agentGoal, '检查事件');
  await act(async () => h.current().resetAgentWorkspaceState());
  assert.equal(h.current().agentTask, currentTask);
  assert.equal(h.current().aiPrompt, 'next prompt');
  assert.equal(h.current().agentGoal, null);
});

it('isolates prior-session mode pushes while a new native acceptance is pending', async () => {
  const p = ports(); const h = await mount(p.options); await run(h);
  await p.emit(envelope(1, { type: 'session-done', finishReason: 'stop', steps: 1, rolloutFileName: 'saved.jsonl' }));
  const acceptance = deferred<Result<'runAiAgent'>>();
  p.bridge.runAiAgent = async () => acceptance.promise;
  await prompt(h, 'new task'); let running!: Promise<void>;
  await act(async () => { running = h.current().runAgentTask(); });
  await p.emit(envelope(2, { type: 'session-mode-switched', mode: 'fullPermission' }));
  assert.equal(h.current().agentInteractionMode, 'ask');
  await act(async () => { acceptance.resolve({ ok: true, sessionId: 'run-2' }); await running; });
  assert.equal(h.current().agentTask.sessionId, 'run-2');
});

for (const strict of [false, true]) {
  it(`invalidates a deferred permission continuation at the mounted workspace boundary${strict ? ' in StrictMode' : ''}`, async () => {
    const p = ports(); const grant = deferred<Result<'requestAiAgentPermission'>>();
    p.bridge.requestAiAgentPermission = async () => grant.promise;
    const h = await mount(p.options, strict);
    await act(async () => h.current().changeAgentInteractionMode('edit')); await prompt(h, 'old workspace prompt');
    let running!: Promise<void>;
    await act(async () => { running = h.current().runAgentTask(); });
    assert.match(h.current().agentTask.sessionId!, /^optimistic-/);
    await act(async () => h.current().resetAgentWorkspaceState());
    await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' },
      selectedFile: { relativePath: 'event/new.emevd.dcx', resourceKind: 'event' } });
    const statusCount = p.statuses.length;
    await act(async () => { grant.resolve({ ok: true, mode: 'normal', grantId: 'old-workspace-grant', expiresAt: 'later' }); await running; });
    assert.equal(p.requests.length, 0, 'An unstarted old prompt must not dispatch into the new native workspace');
    assert.equal(h.current().agentTask.phase, 'idle');
    assert.equal(p.statuses.length, statusCount);
    assert.deepEqual(p.cancellations, []);
    assert.deepEqual(p.replays, []);
  });
}

it('does not adopt late native acceptance into a reset workspace or cancel/replay that dispatched run', async () => {
  const p = ports(); const acceptance = deferred<Result<'runAiAgent'>>();
  p.bridge.runAiAgent = async request => { p.requests.push(request); return acceptance.promise; };
  const h = await mount(p.options); await prompt(h, 'old dispatched prompt');
  let running!: Promise<void>;
  await act(async () => { running = h.current().runAgentTask(); });
  assert.equal(p.requests.length, 1, 'This native call already crossed the dispatch boundary');
  await act(async () => h.current().resetAgentWorkspaceState());
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  const statusCount = p.statuses.length;
  await act(async () => { acceptance.resolve({ ok: true, sessionId: 'old-native-run' }); await running; });
  assert.equal(h.current().agentTask.phase, 'idle');
  assert.equal(h.current().agentTask.sessionId, null);
  assert.equal(p.statuses.length, statusCount);
  assert.equal(p.requests.length, 1);
  assert.deepEqual(p.cancellations, []);
  assert.deepEqual(p.replays, []);
});

it('preserves already accepted native task/tool/terminal facts across the workspace UI boundary', async () => {
  const p = ports(); const h = await mount(p.options); await run(h);
  await p.emit(envelope(1, { type: 'tool-call-begin', callId: 'commit-accepted', name: 'commit', step: 1, argumentsJson: '{}' }));
  await p.emit(envelope(2, { type: 'tool-call-end', callId: 'commit-accepted', name: 'commit', step: 1, ok: true, code: 'COMMITTED' }));
  const replayCount = p.replays.length;
  await act(async () => h.current().resetAgentWorkspaceState());
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  assert.equal(h.current().agentTask.sessionId, 'run-1');
  assert.equal(h.current().agentTask.toolCalls[0]?.code, 'COMMITTED');
  await p.emit(envelope(3, { type: 'session-done', finishReason: 'stop', steps: 1, rolloutFileName: 'committed-before-switch.jsonl' }));
  assert.equal(h.current().agentTask.phase, 'done');
  assert.equal(h.current().agentTask.toolCalls[0]?.status, 'ok');
  assert.equal(h.current().agentTask.rolloutFileName, 'committed-before-switch.jsonl');
  assert.equal(p.requests.length, 1);
  assert.equal(p.replays.length, replayCount);
  assert.deepEqual(p.cancellations, []);
});

it('restores existing terminal/tool facts when workspace reset discards only an optimistic successor', async () => {
  const p = ports(); const h = await mount(p.options); await run(h);
  await p.emit(envelope(1, { type: 'tool-call-begin', callId: 'commit-terminal', name: 'commit', step: 1, argumentsJson: '{}' }));
  await p.emit(envelope(2, { type: 'tool-call-end', callId: 'commit-terminal', name: 'commit', step: 1, ok: true, code: 'COMMITTED' }));
  await p.emit(envelope(3, { type: 'session-done', finishReason: 'stop', steps: 1, rolloutFileName: 'earlier-committed.jsonl' }));
  const terminalTask = h.current().agentTask;
  const replayCount = p.replays.length;
  const grant = deferred<Result<'requestAiAgentPermission'>>();
  p.bridge.requestAiAgentPermission = async () => grant.promise;
  await act(async () => h.current().changeAgentInteractionMode('edit')); await prompt(h, 'optimistic successor');
  let running!: Promise<void>;
  await act(async () => { running = h.current().runAgentTask(); });
  await act(async () => h.current().resetAgentWorkspaceState());
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  await act(async () => { grant.resolve({ ok: true, mode: 'normal', grantId: 'late-successor-grant', expiresAt: 'later' }); await running; });
  assert.equal(h.current().agentTask, terminalTask);
  assert.equal(h.current().agentTask.toolCalls[0]?.code, 'COMMITTED');
  assert.equal(h.current().agentTask.rolloutFileName, 'earlier-committed.jsonl');
  assert.equal(p.requests.length, 1);
  assert.equal(p.replays.length, replayCount);
  assert.deepEqual(p.cancellations, []);
});

it('invalidates a deferred grant on a committed workspace identity change even without the reset callback', async () => {
  const p = ports(); const grant = deferred<Result<'requestAiAgentPermission'>>();
  p.bridge.requestAiAgentPermission = async () => grant.promise;
  const h = await mount(p.options); await act(async () => h.current().changeAgentInteractionMode('edit')); await prompt(h);
  let running!: Promise<void>;
  await act(async () => { running = h.current().runAgentTask(); });
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  await act(async () => { grant.resolve({ ok: true, mode: 'normal', grantId: 'old-identity-grant', expiresAt: 'later' }); await running; });
  assert.equal(p.requests.length, 0);
  assert.equal(h.current().agentTask.phase, 'idle');
});

it('invalidates the pending permission continuation immediately in resetAgentWorkspaceState before a workspace rerender', async () => {
  const p = ports(); const grant = deferred<Result<'requestAiAgentPermission'>>();
  p.bridge.requestAiAgentPermission = async () => grant.promise;
  const h = await mount(p.options); await act(async () => h.current().changeAgentInteractionMode('edit')); await prompt(h);
  let running!: Promise<void>;
  await act(async () => { running = h.current().runAgentTask(); });
  await act(async () => h.current().resetAgentWorkspaceState());
  await act(async () => { grant.resolve({ ok: true, mode: 'normal', grantId: 'pre-render-old-grant', expiresAt: 'later' }); await running; });
  assert.equal(p.requests.length, 0);
  assert.equal(h.current().agentTask.phase, 'idle');
  assert.deepEqual(p.cancellations, []);
  assert.deepEqual(p.replays, []);
});
