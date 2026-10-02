import type { CSSProperties, ReactElement } from 'react';
import type { EditorDomainId } from '@soulforge/shared';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { AgentSidebar, type AgentSidebarProps } from '../agent/AgentSidebar.js';
import { describeRunBlocker, isAgentTaskActive } from '../agent/agentTaskState.js';
import { PanelErrorBoundary } from '../components/PanelErrorBoundary.js';
import { domainLabel } from '../navigation/domainNavigation.js';
import {
  AGENT_MIN_WIDTH, AGENT_MAX_WIDTH, AGENT_DEFAULT_WIDTH,
  type AgentUiController
} from './useAgentUiController.js';

/** 权限模式由主进程锁定；这里只保留原来的只读说明。 */
const AI_PERMISSION_LOCK_REASON = '权限由应用安全设置控制。';

export interface AgentDockViewProps {
  readonly agent: Readonly<Pick<AgentUiController,
    | 'agentOpen' | 'setAgentOpen' | 'agentWidth' | 'setAgentWidth'
    | 'agentExpanded' | 'setAgentExpanded' | 'agentInteractionMode' | 'changeAgentInteractionMode'
    | 'setAgentResources' | 'handleAgentAttachmentsChange' | 'citeSelecting' | 'setCiteSelecting'
    | 'pendingCiteHits' | 'setPendingCiteHits' | 'aiProvider' | 'setAiProvider' | 'aiThinking' | 'setAiThinking'
    | 'aiMode' | 'aiPrompt' | 'setAiPrompt' | 'aiDraft' | 'aiBusy' | 'agentGoal' | 'agentIdleNotice'
    | 'agentTask' | 'agentServices' | 'agentServiceId' | 'setAgentServiceId' | 'agentSessions'
    | 'agentSessionsError' | 'agentSessionDetail' | 'respondingApprovalCallId' | 'approvalError'
    | 'agentTools' | 'toolOutput' | 'eventUri' | 'setEventUri' | 'sendAgentPrompt' | 'startNewAgentTask'
    | 'runAgentTask' | 'cancelAgentTask' | 'respondAgentApproval' | 'refreshAgentSessions'
    | 'loadAgentSession' | 'runToolSearch' | 'explainEvent'>>;
  readonly activeDomain: EditorDomainId;
  readonly selectedFile: Readonly<Pick<RendererIndexedFile, 'relativePath'>> | null;
  readonly hasBridge: boolean;
  readonly fallbackTools: AgentSidebarProps['tools'];
  /** The shell owns the dock width CSS variable and responsive overlay layout. */
  readonly style: CSSProperties;
}

/** Agent presentation projects the existing controller; native/task authority stays with its owner. */
export function AgentDockView({ agent, activeDomain, selectedFile, hasBridge, fallbackTools: tools, style: agentStyle }: AgentDockViewProps): ReactElement {
  const { agentOpen, setAgentOpen, agentWidth, setAgentWidth, agentExpanded, setAgentExpanded, agentInteractionMode,
    changeAgentInteractionMode, setAgentResources, handleAgentAttachmentsChange, citeSelecting, setCiteSelecting,
    pendingCiteHits, setPendingCiteHits, aiProvider, setAiProvider, aiThinking, setAiThinking, aiMode,
    aiPrompt, setAiPrompt, aiDraft, aiBusy, agentGoal, agentIdleNotice, agentTask, agentServices, agentServiceId,
    setAgentServiceId, agentSessions, agentSessionsError, agentSessionDetail, respondingApprovalCallId, approvalError,
    agentTools, toolOutput, eventUri, setEventUri, sendAgentPrompt, startNewAgentTask, runAgentTask, cancelAgentTask,
    respondAgentApproval, refreshAgentSessions, loadAgentSession, runToolSearch, explainEvent } = agent;
  const activeAgentProtocol = agentServices
    .find((service) => service.id === agentServiceId)?.protocol ?? 'openai-compatible';
  return (
    <PanelErrorBoundary key="panel-boundary:agent" label="Agent 面板">
      <AgentSidebar
        open={agentOpen}
        style={agentStyle}
        expanded={agentExpanded}
        agentWidth={agentWidth}
        agentMinWidth={AGENT_MIN_WIDTH}
        agentMaxWidth={AGENT_MAX_WIDTH}
        onAgentWidthChange={(width) => {
          setAgentWidth(width);
          setAgentExpanded(false);
        }}
        busy={aiBusy}
        provider={aiProvider}
        thinking={aiThinking}
        protocol={activeAgentProtocol}
        permissionMode={aiMode}
        permissionLockReason={AI_PERMISSION_LOCK_REASON}
        goal={agentGoal}
        idleNotice={agentIdleNotice}
        draft={aiDraft}
        prompt={aiPrompt}
        contextLabel={domainLabel(activeDomain)}
        selectedFilePath={selectedFile?.relativePath ?? null}
        onResourcesChange={setAgentResources}
        onAttachmentsChange={handleAgentAttachmentsChange}
        tools={agentTools.length > 0 ? agentTools : tools}
        toolOutput={toolOutput}
        task={{
          task: agentTask,
          services: agentServices,
          selectedServiceId: agentServiceId,
          runBlocker: describeRunBlocker({
            hasBridge,
            configId: agentServiceId,
            prompt: aiPrompt,
            active: isAgentTaskActive(agentTask)
          }),
          sessions: agentSessions,
          sessionsError: agentSessionsError,
          sessionDetail: agentSessionDetail,
          onSelectService: setAgentServiceId,
          onRun: () => void runAgentTask(),
          onCancel: () => void cancelAgentTask(),
          onRefreshSessions: () => void refreshAgentSessions(),
          onLoadSession: (sessionPath) => void loadAgentSession(sessionPath),
          onResumeSession: (sessionPath) => void runAgentTask(sessionPath),
          onRespondApproval: (callId, decision) => void respondAgentApproval(callId, decision),
          respondingApprovalCallId,
          approvalError
        }}
        eventUri={eventUri}
        onEventUriChange={setEventUri}
        onProviderChange={setAiProvider}
        onThinkingChange={setAiThinking}
        onPromptChange={setAiPrompt}
        onSend={() => void sendAgentPrompt()}
        citeSelecting={citeSelecting}
        onToggleCiteSelect={() => setCiteSelecting((selecting) => !selecting)}
        pendingCiteHits={pendingCiteHits}
        onCiteHitsConsumed={() => setPendingCiteHits(null)}
        onNewTask={startNewAgentTask}
        onToggleExpand={() => {
          setAgentExpanded((expanded) => !expanded);
          setAgentWidth((width) => width >= AGENT_MAX_WIDTH ? AGENT_DEFAULT_WIDTH : AGENT_MAX_WIDTH);
        }}
        interactionMode={agentInteractionMode}
        onInteractionModeChange={changeAgentInteractionMode}
        onClose={() => setAgentOpen(false)}
        onRunToolSearch={(toolQuery) => void runToolSearch(toolQuery)}
        onExplainEvent={(uri) => void explainEvent(uri)}
      />
    </PanelErrorBoundary>
  );
}
