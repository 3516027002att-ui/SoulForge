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
  /** Redacted arguments as emitted by the model; absent for older events. */
  argumentsJson?: string;
}

/** 一条待用户回答的审批请求。 */
export interface AgentApprovalView {
  callId: string;
  step: number;
  toolName: string;
  permissionLevel: string;
  argumentsJson: string;
  /**
   * 主进程算出的 unified diff。
   *
   * 由主进程负责是因为算它要读当前文件,而 renderer 没有文件系统访问。
   * 为 null 表示「主进程没能给出 diff」——那与「没有改动」是两件事,
   * 界面必须说清是哪一种,不能显示一个空 diff 面板。
   */
  diff: AgentApprovalDiffView | null;
  /**
   * 从 argumentsJson 里解出的字段级预览。diff 在手时它退为辅助信息
   * (目标路径、改动条目数);diff 缺失时它是唯一能给出的具体内容。
   */
  preview: AgentApprovalPreview | null;
}

/** 主进程回报的 unified diff(与 core 的 ApprovalDiff 同形)。 */
export interface AgentApprovalDiffView {
  targetPath: string;
  unifiedDiff: string;
  addedLines: number;
  removedLines: number;
  newFile: boolean;
  truncatedNote?: string;
}

/** 把 unified diff 拆成带类型的行,供界面按增删着色。 */
export type DiffLineKind = 'header' | 'hunk' | 'add' | 'remove' | 'context';

export interface DiffLineView {
  kind: DiffLineKind;
  text: string;
}

/**
 * 逐行分类 unified diff。
 *
 * 顺序有讲究:`---` / `+++` 必须先判为 header,否则会被当成
 * remove / add —— 文件头会被染成一条删除行和一条新增行,而那是最容易
 * 被忽略的错色(它看起来"像是"改动的一部分)。
 */
export function classifyDiffLines(unifiedDiff: string): DiffLineView[] {
  return unifiedDiff.split('\n').map((text) => {
    if (text.startsWith('---') || text.startsWith('+++')) return { kind: 'header' as const, text };
    if (text.startsWith('@@')) return { kind: 'hunk' as const, text };
    if (text.startsWith('+')) return { kind: 'add' as const, text };
    if (text.startsWith('-')) return { kind: 'remove' as const, text };
    return { kind: 'context' as const, text };
  });
}

/**
 * 审批卡片上的改动预览。
 *
 * 只从工具参数里**已有**的字段取值,不去读磁盘、不重新解析资源:审批发生在
 * 工具执行之前,此刻磁盘上还没有任何改动可读。展示 targetPath 与 newText
 * 的意义是让用户看清「要写哪个文件、写成什么」,这是审批与「点一个写按钮」
 * 的区别所在。
 */
export interface AgentApprovalPreview {
  targetPath: string | null;
  targetUri: string | null;
  /** 新内容;超过阈值时截断,并由 truncatedBytes 说明截了多少。 */
  newText: string | null;
  truncatedBytes: number;
  /** 参数里声明的改动条目数(PatchProposal.changes 的长度)。 */
  changeCount: number | null;
}

/** 审批已回答后保留的记录,供界面显示「你批准/拒绝过什么」。 */
export interface AgentApprovalDecisionView {
  callId: string;
  toolName: string;
  /** 含主进程产生的 timed_out 与 abort，用于回看已发生的结果。 */
  decision: AgentApprovalDecisionKind;
  fromMemory: boolean;
}

/** 审批的全部结果种类，含主进程产生的。 */
export type AgentApprovalDecisionKind =
  | 'once' | 'always' | 'reject' | 'never' | 'timed_out' | 'abort';

/**
 * **用户可点**的决定。
 *
 * 比 AgentApprovalDecisionKind 少一个 `timed_out`：那只能由主进程的超时定时器
 * 产生。界面上给一个「我超时了」的按钮既无意义，也会让「没人回答」这个事实
 * 变得可以被伪造 —— 而审计正是靠它区分「用户拒绝」与「无人在场」。
 */
export type AgentApprovalUserDecision =
  | 'once' | 'always' | 'reject' | 'never' | 'abort';

/** 预览里 newText 的展示上限;超出部分截断并说明。 */
export const APPROVAL_PREVIEW_TEXT_LIMIT = 2_000;

/**
 * 从工具参数里提取改动预览。
 *
 * 参数不是 JSON、或不含任何可识别的目标字段时返回 null。刻意不做启发式猜测:
 * 一个「大概是这个文件」的预览会让用户以为自己看清了改动,那比不显示更危险。
 */
export function extractApprovalPreview(argumentsJson: string): AgentApprovalPreview | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const changes = Array.isArray(record.changes) ? record.changes : null;
  const firstChange = changes?.[0];
  const changeRecord = typeof firstChange === 'object' && firstChange !== null
    ? firstChange as Record<string, unknown>
    : null;

  const targetPath = pickString(record.targetPath) ?? pickString(changeRecord?.targetPath);
  const targetUri = pickString(record.targetUri) ?? pickString(changeRecord?.targetUri);
  const structuredEdit = typeof changeRecord?.structuredEdit === 'object' && changeRecord.structuredEdit !== null
    ? changeRecord.structuredEdit as Record<string, unknown>
    : null;
  const rawText = pickString(record.newText) ?? pickString(structuredEdit?.newText);

  if (targetPath === undefined && targetUri === undefined && rawText === undefined && changes === null) {
    return null;
  }

  const truncatedBytes = rawText !== undefined && rawText.length > APPROVAL_PREVIEW_TEXT_LIMIT
    ? rawText.length - APPROVAL_PREVIEW_TEXT_LIMIT
    : 0;
  return {
    targetPath: targetPath ?? null,
    targetUri: targetUri ?? null,
    newText: rawText === undefined
      ? null
      : rawText.slice(0, APPROVAL_PREVIEW_TEXT_LIMIT),
    truncatedBytes,
    changeCount: changes === null ? null : changes.length
  };
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
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
  /**
   * 待回答的审批请求,按到达顺序。
   *
   * 是队列而不是单个:模型一轮里可以发起多个写类调用,loop 会逐个等待。
   * 只保留一个会让第二条请求在界面上消失,而 loop 仍在等它 —— 表现为任务
   * 卡住且无从得知原因。
   */
  pendingApprovals: AgentApprovalView[];
  /** 已回答的审批记录(最近若干条),供用户回看自己批准过什么。 */
  approvalDecisions: AgentApprovalDecisionView[];
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
  rolloutFileName: null,
  pendingApprovals: [],
  approvalDecisions: []
});

/** 工具调用列表的渲染上限；超出部分由 formatListTruncation 显式说明。 */
export const AGENT_TOOL_CALL_LIMIT = 20;

/** 会话列表每页条数（纯 renderer 展示粒度，无对侧消费者）。 */
export const AGENT_SESSION_PAGE_SIZE = 10;

/** 已回答审批的保留条数;超出丢弃最早的。完整记录在会话文件里。 */
export const AGENT_APPROVAL_DECISION_LIMIT = 20;

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
          {
            callId: event.callId,
            name: event.name,
            step: event.step,
            status: 'running',
            ...(typeof event.argumentsJson === 'string'
              ? { argumentsJson: event.argumentsJson }
              : {})
          }
        ]
      };
    case 'approval-requested':
      // 去重:同一 callId 重复到达时不入队两次(推送通道不保证只送一次)。
      if (state.pendingApprovals.some((entry) => entry.callId === event.callId)) return state;
      return {
        ...state,
        pendingApprovals: [
          ...state.pendingApprovals,
          {
            callId: event.callId,
            step: event.step,
            toolName: event.toolName,
            permissionLevel: event.permissionLevel,
            argumentsJson: event.argumentsJson,
            diff: event.diff ?? null,
            preview: extractApprovalPreview(event.argumentsJson)
          }
        ]
      };
    case 'approval-resolved':
      // 出队必须发生在 resolved 事件上,而不是在本地点击时：只有主进程回了
      // resolved 才说明这次审批真的被受理。本地先出队会让「点了但没送到」
      // 表现为卡片消失而任务仍在等待。
      return {
        ...state,
        pendingApprovals: state.pendingApprovals.filter((entry) => entry.callId !== event.callId),
        approvalDecisions: [
          ...state.approvalDecisions.filter((entry) => entry.callId !== event.callId),
          {
            callId: event.callId,
            toolName: event.toolName,
            decision: event.decision,
            fromMemory: event.fromMemory
          }
        ].slice(-AGENT_APPROVAL_DECISION_LIMIT)
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
      // 终态必须清空待审批队列。留着一张按钮点了没有任何效果的卡片,
      // 会让用户以为任务还在等自己 —— 主进程那边早已按拒绝结算了。
      return {
        ...state,
        phase: 'done',
        finishReason: event.finishReason,
        steps: event.steps,
        rolloutFileName: event.rolloutFileName,
        pendingApprovals: []
      };
    case 'session-error':
      return {
        ...state,
        phase: 'error',
        error: { code: event.code, message: event.message },
        pendingApprovals: []
      };
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

/**
 * 任务是否卡在等用户批准。
 *
 * 界面要据此把审批区顶到最前并高亮：这是唯一一种「不操作就永远不会推进」的
 * 进行中状态，混在普通进度里会让用户干等。
 */
export function isAgentTaskAwaitingApproval(state: AgentTaskState): boolean {
  return state.pendingApprovals.length > 0 && isAgentTaskActive(state);
}

/** 审批等级的危险分档，决定卡片的视觉强度与默认按钮。 */
export function approvalSeverity(permissionLevel: string): 'high' | 'medium' | 'low' {
  // rollback 会动备份链，commit 会落盘——两者都不可能靠再跑一次撤销。
  if (permissionLevel === 'commit' || permissionLevel === 'rollback') return 'high';
  if (permissionLevel === 'stage' || permissionLevel === 'write') return 'medium';
  return 'low';
}

/** 审批等级的中文说明；未知等级原样回显而不是猜。 */
export function describeApprovalLevel(permissionLevel: string): string {
  return ({
    stage: '写入暂存区（不改动原文件）',
    validate: '对暂存产物跑校验',
    commit: '经 Patch Engine 提交到工作区',
    rollback: '从备份回滚一次已提交的操作',
    write: '写入资源'
  } as Record<string, string>)[permissionLevel] ?? permissionLevel;
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
      if (state.pendingApprovals.length > 0) {
        const first = state.pendingApprovals[0];
        return `等待你批准：要执行 ${first?.toolName ?? '未知工具'}`
          + `（${first?.permissionLevel ?? '未知等级'}）。批准或拒绝后任务才会继续。`;
      }
      return `任务已受理，等待模型首次响应${toolPart}。可随时取消。`;
    case 'running': {
      // 等待审批必须先说：此时 loop 停在工具阶段等用户回答，与「模型在想」
      // 表面上都是「进行中」，但前者要用户动手才会继续。不区分的话，用户会
      // 一直等一个永远不会自己走完的任务。
      if (state.pendingApprovals.length > 0) {
        const first = state.pendingApprovals[0];
        const more = state.pendingApprovals.length > 1
          ? `，另有 ${state.pendingApprovals.length - 1} 项排队`
          : '';
        return `等待你批准：第 ${first?.step ?? state.step} 步要执行 ${first?.toolName ?? '未知工具'}`
          + `（${first?.permissionLevel ?? '未知等级'}）${more}。批准或拒绝后任务才会继续。`;
      }
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
