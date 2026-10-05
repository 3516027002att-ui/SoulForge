import assert from 'node:assert/strict';
import { it } from 'node:test';
import { isValidElement, type CSSProperties } from 'react';
import { AgentSidebar, type AgentSidebarProps } from '../agent/AgentSidebar.js';
import { PanelErrorBoundary } from '../components/PanelErrorBoundary.js';
import { INITIAL_AGENT_TASK_STATE, type AgentTaskState } from '../agent/agentTaskState.js';
import { AgentDockView, type AgentDockViewProps } from './AgentDockView.js';

// This checks the real view's React element/command projection without mounting
// AgentSidebar's browser-backed resource, attachment and focus effects.
function fixture() {
  const calls: unknown[][] = [];
  let width = 440, expanded = false, selecting = false;
  const command = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const asyncCommand = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); };
  const props: AgentDockViewProps = {
    activeDomain: 'behavior', selectedFile: { relativePath: 'action/owned.tae' }, hasBridge: true,
    style: { '--agent-w': '440px' } as CSSProperties,
    fallbackTools: [{ name: 'workspace-tool', description: 'Workspace tool', permission: 'read' }],
    agent: {
      agentOpen: true, agentWidth: width, agentExpanded: expanded,
      setAgentOpen: command('open'),
      setAgentWidth: value => { width = typeof value === 'function' ? value(width) : value; calls.push(['width', width]); },
      setAgentExpanded: value => { expanded = typeof value === 'function' ? value(expanded) : value; calls.push(['expanded', expanded]); },
      aiBusy: false, aiProvider: 'mock', aiThinking: 'medium', aiMode: 'plan',
      agentGoal: 'Owned goal', agentIdleNotice: 'Owned idle notice', aiDraft: null, aiPrompt: 'Owned prompt',
      agentTask: INITIAL_AGENT_TASK_STATE,
      agentServices: [
        { id: 'openai', displayName: 'OpenAI', hasCredential: true, protocol: 'openai-compatible' },
        { id: 'responses', displayName: 'Responses', hasCredential: true, protocol: 'openai-responses' },
        { id: 'anthropic', displayName: 'Anthropic', hasCredential: false, protocol: 'anthropic-compatible' }
      ],
      agentServiceId: 'responses', agentTools: [], toolOutput: { ok: false, error: { code: 'OWNED', message: 'Owned failure' } },
      agentSessions: [{ sessionPath: 'owned.jsonl', fileName: 'owned.jsonl', sessionId: 'saved', startedAt: null,
        messageCount: 3, parseErrors: 1, interrupted: true, compactedWindows: 2, sizeBytes: 30, modifiedAt: 'owned-time' }],
      agentSessionsError: 'Owned history error', agentSessionDetail: { sessionPath: 'owned.jsonl', messageCount: 3,
        parseErrors: 1, interrupted: true, compactedWindows: 2, loadedMessages: 2, permissionMode: 'plan', protocol: 'openai-responses' },
      respondingApprovalCallId: 'owned-call', approvalError: 'Owned approval error',
      eventUri: 'resource://owned/event', citeSelecting: selecting, pendingCiteHits: [], agentInteractionMode: 'ask',
      setAgentResources: command('resources'), handleAgentAttachmentsChange: command('attachments'),
      setAgentServiceId: command('service'), setEventUri: command('event'), setAiProvider: command('provider'),
      setAiThinking: command('thinking'), setAiPrompt: command('prompt'), setPendingCiteHits: command('hits'),
      setCiteSelecting: value => { selecting = typeof value === 'function' ? value(selecting) : value; calls.push(['selecting', selecting]); },
      startNewAgentTask: command('new'), changeAgentInteractionMode: command('mode'),
      runAgentTask: asyncCommand('run'), cancelAgentTask: asyncCommand('cancel'),
      refreshAgentSessions: asyncCommand('refresh'), loadAgentSession: asyncCommand('load'),
      respondAgentApproval: asyncCommand('approval'), sendAgentPrompt: asyncCommand('send'),
      runToolSearch: asyncCommand('search'), explainEvent: asyncCommand('explain')
    }
  };
  return { props, calls };
}

function sidebar(props: AgentDockViewProps): AgentSidebarProps {
  const boundary = AgentDockView(props);
  assert.equal(boundary.type, PanelErrorBoundary);
  assert.equal(boundary.key, 'panel-boundary:agent');
  assert.ok(isValidElement<{ label: string; children: unknown }>(boundary));
  assert.equal(boundary.props.label, 'Agent 面板');
  const child = boundary.props.children;
  assert.ok(isValidElement<AgentSidebarProps>(child));
  assert.equal(child.type, AgentSidebar);
  assert.equal(child.key, null);
  return child.props;
}

it('preserves the boundary, selected resource/context and all controller facts by identity without mutating frozen input', () => {
  const { props } = fixture();
  const agent = props.agent;
  Object.freeze(agent.agentServices); Object.freeze(agent.agentSessions); Object.freeze(agent.agentTools);
  Object.freeze(agent.agentSessionDetail); Object.freeze(agent.pendingCiteHits); Object.freeze(agent.agentTask);
  Object.freeze(agent); Object.freeze(props.selectedFile); Object.freeze(props.style); Object.freeze(props.fallbackTools); Object.freeze(props);
  const result = sidebar(props);
  assert.equal(result.contextLabel, '动作'); assert.equal(result.selectedFilePath, 'action/owned.tae');
  for (const [key, expected] of Object.entries({ open: agent.agentOpen, style: props.style, expanded: agent.agentExpanded,
    busy: agent.aiBusy, provider: agent.aiProvider, thinking: agent.aiThinking, permissionMode: agent.aiMode,
    goal: agent.agentGoal, idleNotice: agent.agentIdleNotice, draft: agent.aiDraft, prompt: agent.aiPrompt,
    tools: props.fallbackTools, toolOutput: agent.toolOutput, eventUri: agent.eventUri, citeSelecting: agent.citeSelecting,
    pendingCiteHits: agent.pendingCiteHits, interactionMode: agent.agentInteractionMode })) {
    assert.equal(result[key as keyof AgentSidebarProps], expected, key);
  }
  assert.equal(result.permissionLockReason, '权限由应用安全设置控制。');
  for (const [key, expected] of Object.entries({ task: agent.agentTask, services: agent.agentServices,
    selectedServiceId: agent.agentServiceId, sessions: agent.agentSessions, sessionsError: agent.agentSessionsError,
    sessionDetail: agent.agentSessionDetail, respondingApprovalCallId: agent.respondingApprovalCallId, approvalError: agent.approvalError })) {
    assert.equal(result.task[key as keyof AgentSidebarProps['task']], expected, key);
  }
  for (const omitted of ['selection', 'resources', 'messages', 'onCreateResource', 'onRemoveResource', 'onClearContext']) {
    assert.equal(Object.hasOwn(result, omitted), false, `${omitted} retains Sidebar's existing ownership/default`);
  }
  assert.equal(sidebar({ ...props, selectedFile: null, activeDomain: 'map' }).selectedFilePath, null);
  assert.equal(sidebar({ ...props, selectedFile: null, activeDomain: 'map' }).contextLabel, '地图');
});

it('uses the selected service protocol and loaded tools, preserving fallback identity for missing selections and empty tools', () => {
  const { props } = fixture();
  for (const [id, protocol] of [['openai', 'openai-compatible'], ['responses', 'openai-responses'],
    ['anthropic', 'anthropic-compatible'], ['missing', 'openai-compatible'], [null, 'openai-compatible']] as const) {
    assert.equal(sidebar({ ...props, agent: { ...props.agent, agentServiceId: id } }).protocol, protocol);
  }
  const agentTools: AgentSidebarProps['tools'] = [{ name: 'loaded-tool', description: 'Loaded tool', permission: 'read' }];
  Object.freeze(agentTools);
  assert.equal(sidebar({ ...props, agent: { ...props.agent, agentTools } }).tools, agentTools);
  assert.equal(sidebar(props).tools, props.fallbackTools);
});

it('keeps run-blocker precedence and native task phases without changing task facts', () => {
  const { props } = fixture();
  const cases: Array<{ hasBridge: boolean; id: string | null; prompt: string; phase: AgentTaskState['phase']; blocker: string | null }> = [
    { hasBridge: false, id: null, prompt: '', phase: 'running', blocker: '浏览器预览：运行 AI 任务仅在 SoulForge 桌面版可用。' },
    { hasBridge: true, id: null, prompt: '', phase: 'running', blocker: '已有任务在进行中：先取消或等它结束。' },
    { hasBridge: true, id: null, prompt: '', phase: 'cancelling', blocker: '已有任务在进行中：先取消或等它结束。' },
    { hasBridge: true, id: null, prompt: 'Owned prompt', phase: 'idle', blocker: '尚未选择模型服务：请在模型服务管理里添加并配置凭据。' },
    { hasBridge: true, id: 'responses', prompt: '  ', phase: 'done', blocker: '任务描述为空：请先写清要做什么。' },
    { hasBridge: true, id: 'responses', prompt: 'Owned prompt', phase: 'error', blocker: null },
    { hasBridge: true, id: 'responses', prompt: 'Owned prompt', phase: 'done', blocker: null }
  ];
  for (const entry of cases) {
    const task: AgentTaskState = { ...INITIAL_AGENT_TASK_STATE, phase: entry.phase };
    const result = sidebar({ ...props, hasBridge: entry.hasBridge,
      agent: { ...props.agent, agentServiceId: entry.id, aiPrompt: entry.prompt, agentTask: task } });
    assert.equal(result.task.runBlocker, entry.blocker);
    assert.equal(result.task.task, task);
  }
});

it('retains direct callback identities and exact wrapped command arguments, including session and approval decisions', () => {
  const { props, calls } = fixture();
  const agent = props.agent, result = sidebar(props);
  assert.equal(result.onResourcesChange, agent.setAgentResources);
  assert.equal(result.onAttachmentsChange, agent.handleAgentAttachmentsChange);
  assert.equal(result.onEventUriChange, agent.setEventUri); assert.equal(result.onProviderChange, agent.setAiProvider);
  assert.equal(result.onThinkingChange, agent.setAiThinking); assert.equal(result.onPromptChange, agent.setAiPrompt);
  assert.equal(result.onNewTask, agent.startNewAgentTask); assert.equal(result.onInteractionModeChange, agent.changeAgentInteractionMode);
  assert.equal(result.task.onSelectService, agent.setAgentServiceId);
  result.onSend(); result.task.onRun(); result.task.onCancel(); result.task.onRefreshSessions();
  result.task.onLoadSession('owned-load.jsonl'); result.task.onResumeSession('owned-resume.jsonl');
  result.task.onRespondApproval('owned-call', 'once'); result.task.onRespondApproval('owned-call', 'reject');
  result.onRunToolSearch('owned query'); result.onExplainEvent('resource://owned/explain');
  result.onCiteHitsConsumed!(); result.onClose(); result.onToggleCiteSelect!(); result.onToggleCiteSelect!();
  assert.deepEqual(calls, [['send'], ['run'], ['cancel'], ['refresh'], ['load', 'owned-load.jsonl'],
    ['run', 'owned-resume.jsonl'], ['approval', 'owned-call', 'once'], ['approval', 'owned-call', 'reject'],
    ['search', 'owned query'], ['explain', 'resource://owned/explain'], ['hits', null], ['open', false],
    ['selecting', true], ['selecting', false]]);
});

it('preserves dock widths, expansion and collapse commands while leaving CSS overlay style in the shell', () => {
  const { props, calls } = fixture();
  const result = sidebar(props);
  assert.equal(result.agentMinWidth, 96); assert.equal(result.agentMaxWidth, 620); assert.equal(result.agentWidth, 440);
  result.onToggleExpand!(); result.onToggleExpand!();
  result.onAgentWidthChange(96); result.onAgentWidthChange(620); result.onClose();
  assert.deepEqual(calls, [['expanded', true], ['width', 620], ['expanded', false], ['width', 440],
    ['width', 96], ['expanded', false], ['width', 620], ['expanded', false], ['open', false]]);
  for (const width of [96, 440, 620]) {
    const style = { '--agent-w': `${width}px` } as CSSProperties;
    const projected = sidebar({ ...props, style, agent: { ...props.agent, agentWidth: width, agentOpen: false, agentExpanded: true } });
    assert.equal(projected.agentWidth, width); assert.equal(projected.style, style);
    assert.equal(projected.open, false); assert.equal(projected.expanded, true);
  }
});
