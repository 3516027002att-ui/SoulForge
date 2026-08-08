/**
 * AI agent 任务的事件折叠与状态文案（纯逻辑，无 DOM、无 IPC）。
 *
 * 为什么单独一层：`ai:agent:event` 是**推送**通道，主进程按步推 turn-started /
 * tool-call-begin / step-complete / turn-complete 等事件（apps/desktop/src/main/
 * ipc.ts:2899 的 sendAgentEvent）。把「事件如何折叠成界面状态」留在组件里，
 * 就只能靠真实 Electron 才能测——而那一层跑得慢、且断言的是渲染结果，抓不到
 * 折叠规则本身的错。这里把折叠做成纯函数，让「事件到了、状态没变」这类缺陷
 * 在单测层就能报红。
 *
 * 硬约束 16（长任务必须可报告进度、可取消）在界面上的落点就是本文件的
 * `describeAgentTaskStatus` 与 `isAgentTaskCancellable`：前者回答「在跑还是结束、
 * 到第几步、失败原因」，后者决定取消按钮是否可用。
 */
import type { AgentEvent } from '@soulforge/core';

/** 主进程为会话生命周期额外推的三种事件（apps/desktop/src/main/ipc.ts:528-531）。 */
export type AgentSessionLifecycleEvent =
  | { type: 'session-accepted'; mode: 'plan' | 'normal' | 'fullPermission' }
  | { type: 'session-done'; finishReason: string; steps: number; rolloutFileName: string }
  | { type: 'session-error'; code: string; message: string };

/** 推送信封（apps/desktop/src/main/ipc.ts:534-537）。 */
export interface AgentTaskEventEnvelope {
  sessionId: string;
  event: AgentEvent | AgentSessionLifecycleEvent;
}

export type AgentTaskPhase =
  /** 没有发起过任务。 */
  | 'idle'
  /** 已发起、主进程已受理，模型还没回第一步。 */
  | 'accepted'
  /** 正在跑步骤。 */
  | 'running'
  /** 已请求取消，等主进程回终态——取消不是瞬时的，这个中间态必须可见。 */
  | 'cancelling'
  | 'done'
  | 'error';

export interface AgentToolCallView {
  callId: string;
  name: string;
  step: number;
  status: 'running' | 'ok' | 'failed';
  code?: string;
}

export interface AgentTaskState {
  sessionId: string | null;
  phase: AgentTaskPhase;
  /** 主进程受理时回报的实际权限模式；renderer 不据此放宽任何按钮。 */
  mode: 'plan' | 'normal' | 'fullPermission' | null;
  /** 已开始的步数（turn-started 的最大 step）。 */
  step: number;
  /** 终态时主进程回报的总步数。 */
  steps: number | null;
  finishReason: string | null;
  error: { code: string; message: string } | null;
  toolCalls: AgentToolCallView[];
  /** 累计流式增量字符数：模型正在产出内容的可见证据。 */
  deltaChars: number;
  retry: { attempt: number; maxAttempts: number; delayMs: number; code: string } | null;
  compactedWindows: number;
  contextBytes: number | null;
  rolloutFileName: string | null;
}

export const INITIAL_AGENT_TASK_STATE: AgentTaskState = Object.freeze({
  sessionId: null,
  phase: 'idle',
  mode: null,
  step: 0,
  steps: null,
  finishReason: null,
  error: null,
  toolCalls: [],
  deltaChars: 0,
  retry: null,
  compactedWindows: 0,
  contextBytes: null,
  rolloutFileName: null
});

/** 工具调用列表的渲染上限；超出部分由 formatListTruncation 显式说明。 */
export const AGENT_TOOL_CALL_LIMIT = 20;

/** 会话列表每页条数（纯 renderer 展示粒度，无对侧消费者）。 */
export const AGENT_SESSION_PAGE_SIZE = 10;

/** 发起新任务：sessionId 已知，但还没有任何事件到达。 */
export function startAgentTask(sessionId: string): AgentTaskState {
  return { ...INITIAL_AGENT_TASK_STATE, sessionId, phase: 'accepted' };
}

/**
 * 标记「已请求取消」。
 *
 * 单独成函数而不是塞进 reducer：取消是本地动作，不是推送事件。终态仍然只能由
 * 主进程的 session-done / session-error 决定——否则界面会在任务其实还在跑的时候
 * 显示「已取消」。
 */
export function markAgentTaskCancelling(state: AgentTaskState): AgentTaskState {
  if (!isAgentTaskCancellable(state)) return state;
  return { ...state, phase: 'cancelling' };
}

/**
 * 折叠一条推送事件。
 *
 * 会话隔离：信封里的 sessionId 与当前任务不一致时**原样返回**。上一次运行的尾部
 * 事件可能在新任务发起后才到达，若不隔离，旧任务的 turn-complete 会把新任务标成
 * 已结束——用户会以为任务跑完了，而它还在跑。
 */
export function reduceAgentTaskEvent(
  state: AgentTaskState,
  envelope: AgentTaskEventEnvelope
): AgentTaskState {
  if (state.sessionId === null || envelope.sessionId !== state.sessionId) return state;
  const event = envelope.event;
  switch (event.type) {
    case 'session-accepted':
      return { ...state, phase: 'accepted', mode: event.mode };
    case 'turn-started':
      // 已请求取消时不回退到 running：取消中的步骤推进仍然属于取消过程。
      return {
        ...state,
        phase: state.phase === 'cancelling' ? 'cancelling' : 'running',
        step: Math.max(state.step, event.step)
      };
    case 'agent-message-delta':
      return { ...state, deltaChars: state.deltaChars + event.text.length };
    case 'tool-call-begin':
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls,
          { callId: event.callId, name: event.name, step: event.step, status: 'running' }
        ]
      };
    case 'tool-call-end':
      return {
        ...state,
        toolCalls: state.toolCalls.map((call) => (
          call.callId === event.callId
            ? {
                ...call,
                status: event.ok ? 'ok' : 'failed',
                ...(event.code !== undefined ? { code: event.code } : {})
              }
            : call
        ))
      };
    case 'retry-scheduled':
      return {
        ...state,
        retry: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          code: event.code
        }
      };
    case 'context-assembled':
      return { ...state, contextBytes: event.totalBytes };
    case 'context-compacted':
      return { ...state, compactedWindows: state.compactedWindows + 1 };
    case 'step-complete':
      return { ...state, step: Math.max(state.step, event.step) };
    case 'turn-complete':
      // turn-complete 先到、session-done 后到；两者都写终态，取先到的那个。
      return { ...state, finishReason: event.finishReason, steps: event.steps };
    case 'session-done':
      return {
        ...state,
        phase: 'done',
        finishReason: event.finishReason,
        steps: event.steps,
        rolloutFileName: event.rolloutFileName
      };
    case 'session-error':
      return { ...state, phase: 'error', error: { code: event.code, message: event.message } };
    default:
      return state;
  }
}

/**
 * 取消是否可用。
 *
 * 只在「主进程已受理且未回终态」时为真。idle 下给一个可点的取消按钮，等于让
 * 用户点一个不会发出任何 IPC 的按钮——那正是任务书里点名要避免的「只放个禁用
 * 按钮」的反面形态。
 */
export function isAgentTaskCancellable(state: AgentTaskState): boolean {
  return state.sessionId !== null && (state.phase === 'accepted' || state.phase === 'running');
}

/** 任务是否仍在进行（含取消中）：决定「运行」按钮是否让位。 */
export function isAgentTaskActive(state: AgentTaskState): boolean {
  return state.phase === 'accepted' || state.phase === 'running' || state.phase === 'cancelling';
}

function describeFinishReason(reason: string): string {
  return ({
    stop: '正常结束',
    cancelled: '已被取消',
    length: '达到输出上限',
    tool_use: '停在工具调用',
    error: '因错误结束'
  } as Record<string, string>)[reason] ?? reason;
}

/**
 * 状态文案。必须回答：在跑还是结束、进度如何、失败原因、是否可取消。
 *
 * 刻意不写「智能」「高效」这类无证据形容词，也不用「A · B · C」串联宣传摘要
 * （docs/frontend-renovation/anti-ai-design.md §2）。
 */
export function describeAgentTaskStatus(state: AgentTaskState): string {
  const toolPart = state.toolCalls.length > 0 ? `，已调用 ${state.toolCalls.length} 次工具` : '';
  switch (state.phase) {
    case 'idle':
      return '没有进行中的任务。';
    case 'accepted':
      return `任务已受理，等待模型首次响应${toolPart}。可随时取消。`;
    case 'running': {
      const output = state.deltaChars > 0 ? `，已产出 ${state.deltaChars} 字符` : '';
      return `任务进行中：已进入第 ${state.step} 步${toolPart}${output}。可随时取消。`;
    }
    case 'cancelling':
      return `已发出取消请求，等待主进程结束第 ${state.step} 步后停止。取消需要等当前步骤让出。`;
    case 'done': {
      const failed = state.toolCalls.filter((call) => call.status === 'failed').length;
      const failPart = failed > 0 ? `，其中 ${failed} 次工具调用失败` : '';
      const reason = state.finishReason === null ? '未回报结束原因' : describeFinishReason(state.finishReason);
      return `任务已结束（${reason}）：共 ${state.steps ?? state.step} 步${toolPart}${failPart}。`;
    }
    case 'error':
      return `任务失败：${state.error?.code ?? '未回报错误码'}——${state.error?.message ?? '未回报原因'}。`;
    default:
      return '未知状态。';
  }
}

/** 运行前置条件不满足时的原因；null 表示可以运行。 */
export function describeRunBlocker(input: {
  hasBridge: boolean;
  configId: string | null;
  prompt: string;
  active: boolean;
}): string | null {
  if (!input.hasBridge) return '浏览器预览：运行 AI 任务仅在 SoulForge 桌面版可用。';
  if (input.active) return '已有任务在进行中：先取消或等它结束。';
  if (input.configId === null) return '尚未选择模型服务：请在模型服务管理里添加并配置凭据。';
  if (input.prompt.trim() === '') return '任务描述为空：请先写清要做什么。';
  return null;
}
