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

export function sessionError(code: string, message: string, retryable = false): SessionError {
  return { code, message, retryable };
}

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_QUEUE = 64;

interface TrackedRequest {
  payloadHash: string;
  outcome: SessionResult;
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
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const task = this.tail.then(async () => {
      if (this.closed) {
        return {
          id: request.id,
          ok: false,
          error: sessionError('CLI_SESSION_CLOSED', '本地会话已关闭。', false)
        } satisfies SessionResult;
      }
      try {
        if (controller.signal.aborted) {
          return {
            id: request.id,
            ok: false,
            error: sessionError('CLI_REQUEST_CANCELLED', '本地会话请求已取消。', true)
          } satisfies SessionResult;
        }
        const result = await call(request.tool, request.args, controller.signal);
        if (request.tool.startsWith('mutate_') || request.tool.startsWith('apply_') || request.tool.startsWith('commit_')) {
          this.writerCalls += 1;
        }
        return { id: request.id, ok: true, result } satisfies SessionResult;
      } catch (error) {
        return {
          id: request.id,
          ok: false,
          error: sessionError(
            error instanceof Error && /^CLI_[A-Z0-9_]+/u.test(error.message)
              ? error.message.split(':', 1)[0]!
              : 'CLI_TOOL_FAILED',
            error instanceof Error ? error.message : String(error),
            false
          )
        } satisfies SessionResult;
      }
    });
    this.tail = task.then(() => undefined, () => undefined);
    this.inFlight.set(request.id, { payloadHash: hash, promise: task, controller });
    try {
      const outcome = await task;
      this.tracked.set(request.id, { payloadHash: hash, outcome });
      return outcome;
    } finally {
      signal?.removeEventListener('abort', abortFromCaller);
      this.inFlight.delete(request.id);
      this.pendingCount -= 1;
    }
  }

  get writerCallCount(): number {
    return this.writerCalls;
  }

  /** host 重启语义：proof 清空，审计保留（由 operationLog 持有）。 */
  restart(): void {
    this.coreSession.proofStore.invalidateAll('host-restart');
    this.tracked.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.inFlight.values()) entry.controller.abort();
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
