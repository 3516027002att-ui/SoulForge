import type { ReactElement } from 'react';
import type { ToolDescriptor } from '@soulforge/core';
import { formatBytes } from '../format/uiText.js';
import { AgentApprovalPanel } from './AgentApprovalPanel.js';
import type { AgentApprovalUserDecision } from './agentTaskState.js';
import {
  describeAgentTaskStatus,
  isAgentTaskCancellable,
  type AgentTaskState
} from './agentTaskState.js';

/** 会话摘要（apps/desktop/src/main/ipc.ts:497-509 的 AiAgentSessionSummaryIpc）。 */
export interface AgentSessionRow {
  sessionPath: string;
  fileName: string;
  sessionId: string | null;
  startedAt: string | null;
  messageCount: number;
  parseErrors: number;
  interrupted: boolean;
  compactedWindows: number;
  sizeBytes: number;
  modifiedAt: string;
}

/** 已载入会话的详情（ai.agent.session.load 的成功分支）。 */
export interface AgentSessionDetail {
  sessionPath: string;
  messageCount: number;
  parseErrors: number;
  interrupted: boolean;
  compactedWindows: number;
  /** 主进程只回尾部 20 条（ipc.ts:3069 的 slice(-20)）。 */
  loadedMessages: number;
  permissionMode: string | null;
  protocol: string | null;
}

export interface ModelServiceChoice {
  id: string;
  displayName: string;
  hasCredential: boolean;
  /** 8-A：protocol 决定 Composer 思考强度换表（OpenAI effort / Anthropic budget）。 */
  protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
}

export interface AgentTaskPanelProps {
  task: AgentTaskState;
  /** 可选模型服务；空数组时运行入口给出结构化原因而不是静默禁用。 */
  services: ModelServiceChoice[];
  selectedServiceId: string | null;
  /** 运行不可用的原因；null 表示可运行。由 describeRunBlocker 产出。 */
  runBlocker: string | null;
  sessions: AgentSessionRow[];
  sessionsError: string | null;
  sessionDetail: AgentSessionDetail | null;
  /** 主进程锁定的权限模式说明；renderer 不得在此之外另给授权入口。 */
  permissionLockReason: string;
  tools: ToolDescriptor[];
  onSelectService: (configId: string) => void;
  onRun: () => void;
  onCancel: () => void;
  onRefreshSessions: () => void;
  onLoadSession: (sessionPath: string) => void;
  onResumeSession: (sessionPath: string) => void;
  /** 回答一条审批请求。 */
  onRespondApproval: (callId: string, decision: AgentApprovalUserDecision) => void;
  /** 正在发送的审批 callId；期间禁用按钮避免重复提交。 */
  respondingApprovalCallId: string | null;
  /** 上一次审批回答失败的原因。 */
  approvalError: string | null;
}

function toolCallStatusLabel(status: 'running' | 'ok' | 'failed'): string {
  return ({ running: '进行中', ok: '成功', failed: '失败' } as const)[status];
}

function toolCallRowClass(status: 'running' | 'ok' | 'failed'): string {
  if (status === 'ok') return 'agent-log__row is-ok';
  if (status === 'failed') return 'agent-log__row is-danger';
  return 'agent-log__row';
}

/**
 * 参数展示：能解析成 JSON 就缩进显示，否则原样回显。
 *
 * 刻意不在解析失败时隐藏内容：模型发出的非法 JSON 正是需要被看见的东西，
 * 藏起来会让「模型一直发坏参数」变成一个查不到原因的失败。参数放在
 * `<details>` 折叠里，展开即可看全文（问题 5：单条文本不截断）。
 */
function formatToolArguments(argumentsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argumentsJson), null, 2);
  } catch {
    return argumentsJson;
  }
}

/**
 * AI agent 任务面板：运行、取消、进度、会话历史与承接。
 *
 * 接的六个通道（现状已逐个核实）：
 *   runAiAgent           → main ipc.ts:2922 handle('ai.agent.run')
 *   cancelAiAgent        → main ipc.ts:3027 handle('ai.agent.cancel')
 *   listAiAgentSessions  → main ipc.ts:3033 handle('ai.agent.sessions')
 *   loadAiAgentSession   → main ipc.ts:3052 handle('ai.agent.session.load')
 *   onAiAgentEvent       → 订阅 'ai:agent:event'（webContents.send，ipc.ts:2899）
 *   listAiTools          → main ipc.ts:2825 handle('ai.tools')
 *
 * 权限：本面板**不提供任何权限模式选择**。模式由主进程决定并在 session-accepted
 * 事件里回报，这里只显示它回报的值与锁定原因。给一个能选 fullPermission 的下拉
 * 等于让 renderer 抬高授权，而生产权限判定在 packages/core/src/ai/toolPermissions.ts
 * 的 isAiToolPermissionAllowed（由 ai/toolRegistry.ts:127 每次 run 调用），renderer
 * 侧另建一套判定只会得到两份会漂移的口径。
 *
 * 全部状态由 App 以受控 props 下发；本组件不持有全局状态、不直接调 IPC。
 */
export function AgentTaskPanel({
  task,
  services,
  selectedServiceId,
  runBlocker,
  sessions,
  sessionsError,
  sessionDetail,
  permissionLockReason,
  tools,
  onSelectService,
  onRun,
  onCancel,
  onRefreshSessions,
  onLoadSession,
  onResumeSession,
  onRespondApproval,
  respondingApprovalCallId,
  approvalError
}: AgentTaskPanelProps): ReactElement {
  const cancellable = isAgentTaskCancellable(task);

  return (
    <div className="agent-block" data-testid="agent-task-panel">
      <div className="agent-block__label">AI 任务</div>

      {/* 审批区置顶：等待审批是唯一一种「不操作就永远不会推进」的进行中状态。
          排在运行控件与进度日志之后，用户可能滚不到它就以为任务在正常跑。 */}
      <AgentApprovalPanel
        pending={task.pendingApprovals}
        decisions={task.approvalDecisions}
        onRespond={onRespondApproval}
        respondingCallId={respondingApprovalCallId}
        respondError={approvalError}
      />

      <div className="agent-controls__row">
        <label className="agent-controls__label" htmlFor="agent-task-service">模型服务</label>
        <select
          id="agent-task-service"
          value={selectedServiceId ?? ''}
          onChange={(event) => onSelectService(event.target.value)}
          aria-label="运行任务使用的模型服务"
        >
          {services.length === 0 && <option value="">尚未添加模型服务</option>}
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.displayName}{service.hasCredential ? '' : '（未配置凭据）'}
            </option>
          ))}
        </select>
        {/*
          权限模式只读回显：主进程受理后回报实际模式，此前显示锁定口径。

          class 刻意用 agent-task__lock 而不是复用 AgentSessionControls 的
          agent-controls__lock：后者是**会话控件**的锁定原因，这里是**任务面板**的
          权限回显，两者是不同关注点。更要紧的是复用会打破既有 e2e 断言的唯一性
          ——实测 renderer.spec.mjs:362 的 locator('.agent-controls__lock') 会
          resolved to 2 elements 而报 strict mode violation。同 class 表达不同
          语义时，Playwright 的严格模式会把它变成一条真实的回归。
        */}
        <p className="agent-task__lock" data-testid="agent-task-permission">
          权限模式：{task.mode ?? '计划模式（主进程锁定）'}。{permissionLockReason}
        </p>
      </div>

      <div className="row gap">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={runBlocker !== null}
          title={runBlocker ?? '运行 AI 任务'}
          data-testid="agent-task-run"
          onClick={onRun}
        >
          运行任务
        </button>
        {/* 取消必须真的发出 IPC（硬约束 16）。禁用条件只看「有没有在跑的会话」，
            不看别的状态——一个永远禁用的取消按钮等于没有取消能力。 */}
        <button
          type="button"
          className="btn btn--danger btn--sm"
          disabled={!cancellable}
          title={cancellable ? '取消当前任务' : '没有可取消的任务'}
          data-testid="agent-task-cancel"
          onClick={onCancel}
        >
          取消任务
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          data-testid="agent-sessions-refresh"
          onClick={onRefreshSessions}
        >
          刷新会话列表
        </button>
      </div>

      {runBlocker !== null && (
        <p className="muted" data-testid="agent-task-blocker">{runBlocker}</p>
      )}

      {/* 状态文案：在跑还是结束、到第几步、失败原因、能否取消，全部由
          describeAgentTaskStatus 回答（有单测锁定）。 */}
      <div className="agent-log" role="status" aria-live="polite">
        <div className="agent-log__row" data-testid="agent-task-status">
          {(task.phase === 'accepted' || task.phase === 'running' || task.phase === 'cancelling') && (
            <span className="spinner" aria-hidden="true"></span>
          )}
          <span>{describeAgentTaskStatus(task)}</span>
        </div>
        {task.retry !== null && (
          <div className="agent-log__row is-warn" data-testid="agent-task-retry">
            <span>
              第 {task.retry.attempt}/{task.retry.maxAttempts} 次重试，
              等待 {task.retry.delayMs} 毫秒（{task.retry.code}）
            </span>
          </div>
        )}
        {task.contextBytes !== null && (
          <div className="agent-log__row">
            <span>本步上下文 {formatBytes(task.contextBytes)}</span>
          </div>
        )}
        {task.compactedWindows > 0 && (
          <div className="agent-log__row is-warn">
            <span>历史已压缩 {task.compactedWindows} 次，早期消息不再逐字参与推理</span>
          </div>
        )}
        {task.rolloutFileName !== null && (
          <div className="agent-log__row">
            <span>会话记录：{task.rolloutFileName}</span>
          </div>
        )}
      </div>

      {task.toolCalls.length > 0 && (
        <div className="agent-log" data-testid="agent-task-tool-calls">
          {task.toolCalls.map((call) => (
            <div key={call.callId} className={toolCallRowClass(call.status)}>
              {call.status === 'running' && <span className="spinner" aria-hidden="true"></span>}
              <span>
                {call.name} · {toolCallStatusLabel(call.status)}
                {call.code !== undefined ? ` · ${call.code}` : ''}
              </span>
              {/* 参数折叠展示：只显示工具名时，「读了哪个文件」「写了什么」
                  全都看不见，用户无法判断 agent 是否在做自己要的事。参数在
                  loop 侧已脱敏（agentLoop 的 redactSecrets 在 push 时执行）。
                  展开即看全文（问题 5：不截断）。 */}
              {call.argumentsJson !== undefined && call.argumentsJson !== '' && (
                <details className="agent-log__args">
                  <summary>参数</summary>
                  <pre className="tool-output" data-testid="agent-tool-call-arguments">
                    {formatToolArguments(call.argumentsJson)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 工具清单来自 ai.tools（listAiTools），是权限阶梯的展示侧。真实权限判定
          在主进程，这里只显示 main 已注册的工具及其等级。 */}
      <details data-testid="agent-tool-inventory">
        <summary>已注册工具 {tools.length} 个</summary>
        <div className="agent-log">
          {tools.length === 0
            ? <div className="agent-log__row"><span className="muted">主进程未回报任何已注册工具</span></div>
            : tools.map((tool) => (
                <div key={tool.name} className="agent-log__row">
                  <span title={tool.description}>
                    {tool.name} · {tool.permissionLevel ?? tool.permission}
                  </span>
                </div>
              ))}
        </div>
      </details>

      <details data-testid="agent-session-history">
        <summary>会话历史 {sessions.length} 条</summary>
        {sessionsError !== null && <p className="danger">{sessionsError}</p>}
        {/* 主进程只回最近 50 条（ipc.ts:3034 的 listRolloutSessions(dir, 50)）。
            这不是渲染截断而是数据源上限，必须说明，否则用户会把 50 当成全部。 */}
        <p className="muted" data-testid="agent-sessions-source-limit">
          会话列表只回报最近 50 个会话文件；更早的记录仍在磁盘上，但不在此列表内。
        </p>
        <div className="agent-log">
          {sessions.length === 0
            ? <div className="agent-log__row"><span className="muted">没有会话记录</span></div>
            : sessions.map((session) => (
                <div key={session.sessionPath} className="agent-log__row">
                  {/* 文件名必须显示：只给时间戳与消息数时，同一分钟里的多个会话
                      在界面上无法区分，「承接哪一个」就成了盲选。 */}
                  <span>
                    {session.fileName} · {session.startedAt ?? session.modifiedAt}
                    · {session.messageCount} 条消息 · {formatBytes(session.sizeBytes)}
                    {session.interrupted ? ' · 曾中断' : ''}
                    {session.parseErrors > 0 ? ` · ${session.parseErrors} 行无法解析` : ''}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onLoadSession(session.sessionPath)}
                  >
                    查看
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onResumeSession(session.sessionPath)}
                  >
                    承接
                  </button>
                </div>
              ))}
        </div>
        {sessionDetail !== null && (
          <div className="agent-log" data-testid="agent-session-detail">
            <div className="agent-log__row">
              <span>
                已载入 {sessionDetail.sessionPath}：共 {sessionDetail.messageCount} 条消息，
                本次只取尾部 {sessionDetail.loadedMessages} 条
              </span>
            </div>
            <div className="agent-log__row">
              <span>
                权限模式 {sessionDetail.permissionMode ?? '未记录'} · 协议 {sessionDetail.protocol ?? '未记录'}
                {sessionDetail.interrupted ? ' · 曾中断' : ''}
                {sessionDetail.compactedWindows > 0 ? ` · 压缩 ${sessionDetail.compactedWindows} 次` : ''}
              </span>
            </div>
            {sessionDetail.parseErrors > 0 && (
              <div className="agent-log__row is-warn">
                <span>{sessionDetail.parseErrors} 行无法解析，已跳过——该会话记录不完整</span>
              </div>
            )}
          </div>
        )}
      </details>
    </div>
  );
}
