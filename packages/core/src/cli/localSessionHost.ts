/** T11-B/C 本地会话 host：同用户同工作区复用 CoreToolSession；协议校验与请求去重。 */
import { randomBytes } from 'node:crypto';
import { CoreToolSession } from '../runtime/coreToolSession.js';

export interface SessionRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface SessionError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SessionResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: SessionError;
}

export type SessionRequestState = 'queued' | 'running' | 'cancel_requested' | 'cancelled' | 'completed' | 'failed';

export interface SessionRequestStatus {
  id: string;
  state: SessionRequestState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequestedAt?: number;
  lateResultDiscarded?: boolean;
  outcome?: SessionResult;
}

export function sessionError(code: string, message: string, retryable = false): SessionError {
  return { code, message, retryable };
}

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_QUEUE = 64;

interface TrackedRequest {
  payloadHash: string;
  outcome: SessionResult;
}

interface RequestRecord extends SessionRequestStatus {
  payloadHash: string;
  controller: AbortController;
  promise?: Promise<SessionResult>;
}

function payloadHash(request: SessionRequest): string {
  return JSON.stringify({ tool: request.tool, args: request.args });
}

export class LocalSessionHost {
  readonly sessionName: string;
  readonly workspaceId: string;
  readonly authToken: string;
  readonly coreSession: CoreToolSession;
  private tracked = new Map<string, TrackedRequest>();
  private inFlight = new Map<string, { payloadHash: string; promise: Promise<SessionResult>; controller: AbortController }>();
  private requests = new Map<string, RequestRecord>();
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private closed = false;
  private writerCalls = 0;

  constructor(sessionName: string, workspaceId: string, principal: string, coreSession?: CoreToolSession) {
    this.sessionName = sessionName;
    this.workspaceId = workspaceId;
    this.authToken = randomBytes(32).toString('hex');
    this.coreSession = coreSession ?? new CoreToolSession({ principal, workspaceId });
  }

  async dispatch(
    request: SessionRequest,
    call: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal
  ): Promise<SessionResult> {
    if (this.closed) throw new Error('CLI_SESSION_CLOSED');
    const frameBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
    if (frameBytes > MAX_FRAME_BYTES) throw new Error('CLI_FRAME_TOO_LARGE');
    const seen = this.tracked.get(request.id);
    const hash = payloadHash(request);
    if (seen) {
      if (seen.payloadHash !== hash) throw new Error('CLI_REQUEST_ID_CONFLICT');
      return seen.outcome;
    }
    const active = this.inFlight.get(request.id);
    if (active) {
      if (active.payloadHash !== hash) throw new Error('CLI_REQUEST_ID_CONFLICT');
      return active.promise;
    }
    if (this.pendingCount >= MAX_QUEUE) throw new Error('CLI_QUEUE_FULL');

    this.pendingCount += 1;
    const controller = new AbortController();
    const requestRecord: RequestRecord = {
      id: request.id,
      payloadHash: hash,
      state: 'queued',
      queuedAt: Date.now(),
      controller
    };
    this.requests.set(request.id, requestRecord);
    const abortFromCaller = () => {
      if (requestRecord.state === 'queued' || requestRecord.state === 'running') {
        requestRecord.state = 'cancel_requested';
        requestRecord.cancelRequestedAt = Date.now();
      }
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) abortFromCaller();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const task = this.tail.then(async () => {
      if (this.closed) {
        const cancelled = controller.signal.aborted || requestRecord.state === 'cancel_requested';
        requestRecord.state = cancelled ? 'cancelled' : 'failed';
        requestRecord.finishedAt = Date.now();
        return {
          id: request.id,
          ok: false,
          error: sessionError(cancelled ? 'CLI_REQUEST_CANCELLED' : 'CLI_SESSION_CLOSED', cancelled ? '请求已取消；本地会话随后关闭。' : '本地会话已关闭。', cancelled)
        } satisfies SessionResult;
      }
      try {
        if (controller.signal.aborted) {
          requestRecord.state = 'cancelled';
          requestRecord.finishedAt = Date.now();
          return {
            id: request.id,
            ok: false,
            error: sessionError('CLI_REQUEST_CANCELLED', '本地会话请求已取消。', true)
          } satisfies SessionResult;
        }
        requestRecord.state = requestRecord.state === 'cancel_requested' ? 'cancel_requested' : 'running';
        requestRecord.startedAt = Date.now();
        const result = await call(request.tool, request.args, controller.signal);
        // An executor may not observe AbortSignal. A result that arrives after
        // cancellation is never allowed to become a successful result for a
        // later request with the same id.
        if (controller.signal.aborted || requestRecord.state === 'cancel_requested') {
          requestRecord.state = 'cancelled';
          requestRecord.finishedAt = Date.now();
          requestRecord.lateResultDiscarded = true;
          return {
            id: request.id,
            ok: false,
            error: sessionError('CLI_REQUEST_CANCELLED', '请求已取消；迟到的工具结果已丢弃。', true)
          } satisfies SessionResult;
        }
        requestRecord.state = 'completed';
        requestRecord.finishedAt = Date.now();
        if (request.tool.startsWith('mutate_') || request.tool.startsWith('apply_') || request.tool.startsWith('commit_')) {
          this.writerCalls += 1;
        }
        return { id: request.id, ok: true, result } satisfies SessionResult;
      } catch (error) {
        const cancelled = controller.signal.aborted || requestRecord.state === 'cancel_requested';
        requestRecord.state = cancelled ? 'cancelled' : 'failed';
        requestRecord.finishedAt = Date.now();
        if (cancelled) requestRecord.lateResultDiscarded = true;
        return {
          id: request.id,
          ok: false,
          error: sessionError(
            cancelled
              ? 'CLI_REQUEST_CANCELLED'
              : error instanceof Error && /^CLI_[A-Z0-9_]+/u.test(error.message)
              ? error.message.split(':', 1)[0]!
              : 'CLI_TOOL_FAILED',
            cancelled ? '请求已取消；执行方已返回终态。' : error instanceof Error ? error.message : String(error),
            cancelled
          )
        } satisfies SessionResult;
      }
    });
    requestRecord.promise = task;
    this.tail = task.then(() => undefined, () => undefined);
    this.inFlight.set(request.id, { payloadHash: hash, promise: task, controller });
    try {
      const outcome = await task;
      requestRecord.outcome = outcome;
      this.tracked.set(request.id, { payloadHash: hash, outcome });
      return outcome;
    } finally {
      signal?.removeEventListener('abort', abortFromCaller);
      this.inFlight.delete(request.id);
      this.pendingCount -= 1;
    }
  }

  /** Request cancellation is separate from the terminal cancelled state. */
  requestCancel(requestId: string): { ok: true; status: SessionRequestStatus } | { ok: false; code: string; message: string } {
    const record = this.requests.get(requestId);
    if (!record) return { ok: false, code: 'CLI_REQUEST_NOT_FOUND', message: `没有找到请求 ${requestId}。` };
    if (record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled') {
      return { ok: true, status: this.requestStatus(requestId)! };
    }
    if (record.state !== 'cancel_requested') {
      record.state = 'cancel_requested';
      record.cancelRequestedAt = Date.now();
      record.controller.abort();
    }
    return { ok: true, status: this.requestStatus(requestId)! };
  }

  requestStatus(requestId: string): SessionRequestStatus | undefined {
    const record = this.requests.get(requestId);
    if (!record) return undefined;
    const { payloadHash: _payloadHash, controller: _controller, promise: _promise, ...status } = record;
    return status;
  }

  listRequestStatuses(): SessionRequestStatus[] {
    return [...this.requests.keys()].map((id) => this.requestStatus(id)).filter((item): item is SessionRequestStatus => item !== undefined);
  }

  get writerCallCount(): number {
    return this.writerCalls;
  }

  /** host 重启语义：proof 清空，审计保留（由 operationLog 持有）。 */
  restart(): void {
    this.coreSession.proofStore.invalidateAll('host-restart');
    this.tracked.clear();
    this.requests.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.inFlight.values()) entry.controller.abort();
    for (const record of this.requests.values()) {
      if (record.state === 'queued' || record.state === 'running' || record.state === 'cancel_requested') {
        record.state = 'cancel_requested';
        record.cancelRequestedAt ??= Date.now();
        record.controller.abort();
      }
    }
    this.coreSession.close();
  }
}

const HOSTS = new Map<string, LocalSessionHost>();

export function openLocalSession(sessionName: string, workspaceId: string, principal: string, coreSession?: CoreToolSession): LocalSessionHost {
  const key = `${principal}|${workspaceId}|${sessionName}`;
  const existing = HOSTS.get(key);
  if (existing) return existing;
  const host = new LocalSessionHost(sessionName, workspaceId, principal, coreSession);
  HOSTS.set(key, host);
  return host;
}

export function closeLocalSession(sessionName: string, workspaceId: string, principal: string): void {
  const key = `${principal}|${workspaceId}|${sessionName}`;
  HOSTS.get(key)?.close();
  HOSTS.delete(key);
}
