/**
 * Local IPC session host: holds tool execution for same-user CLI reuse.
 * Accepts only tool name + args + session control — never arbitrary ToolContext/code.
 */
import { randomBytes } from 'node:crypto';
import { MemoryOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { openSqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';

export type LocalSessionExecute = (
  tool: string,
  args: Record<string, unknown>
) => Promise<unknown>;

export interface LocalSessionHostOptions {
  sessionKey: string;
  modeCeiling?: 'plan' | 'normal' | 'fullPermission';
  idleMs?: number;
  /** Optional executor; tests/hosts may inject ToolRegistry via setExecutor. */
  execute?: LocalSessionExecute;
  /** External operation log. When provided the host does not own/dispose it. */
  operationLog?: OperationLogStore;
  /** Force SQLite open for this host write path. */
  openSqlite?: boolean;
  /** Durable SQLite operation-log path. Presence implies openSqlite write path. */
  databasePath?: string;
  workspaceId?: string;
  rootPath?: string;
  game?: string;
  nativeBinding?: string;
}

export interface LocalSessionRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface LocalSessionRequestState {
  instanceId: string;
  requestId: string;
  payloadHash: string;
  result: unknown;
}

export class LocalSessionHost {
  readonly sessionKey: string;
  readonly modeCeiling: 'plan' | 'normal' | 'fullPermission';
  readonly instanceId = randomBytes(16).toString('hex');
  readonly operationLog: OperationLogStore;
  private execute: LocalSessionExecute | undefined;
  private readonly idleMs: number;
  private readonly ownsOperationLog: boolean;
  private closed = false;
  private lastActive = Date.now();
  private readonly requestStates = new Map<string, LocalSessionRequestState>();

  constructor(options: LocalSessionHostOptions) {
    this.sessionKey = options.sessionKey;
    this.modeCeiling = options.modeCeiling ?? 'normal';
    this.execute = options.execute;
    this.idleMs = options.idleMs ?? 10 * 60 * 1000;

    if (options.operationLog) {
      this.operationLog = options.operationLog;
      this.ownsOperationLog = false;
    } else if (options.databasePath || options.openSqlite) {
      // Production write path must open the real store or fail closed.
      // Never silently fall back to MemoryOperationLogStore.
      if (!options.databasePath) {
        throw cliOperationLogUnavailable('openSqlite=true 需要 databasePath。');
      }
      if (!options.workspaceId || !options.rootPath) {
        throw cliOperationLogUnavailable('SQLite operation log 需要 workspaceId 与 rootPath。');
      }
      try {
        this.operationLog = openSqliteOperationLogStore({
          databasePath: options.databasePath,
          workspaceId: options.workspaceId,
          rootPath: options.rootPath,
          ...(options.game ? { game: options.game } : {}),
          ...(options.nativeBinding ? { nativeBinding: options.nativeBinding } : {})
        });
        this.ownsOperationLog = true;
      } catch (error) {
        throw cliOperationLogUnavailable(
          error instanceof Error ? error.message : String(error)
        );
      }
    } else {
      // Non-durable path: in-memory log for read/validate-only session hosts.
      this.operationLog = new MemoryOperationLogStore();
      this.ownsOperationLog = true;
    }
  }

  /** Inject production ToolRegistry executor after construction. */
  setExecutor(execute: LocalSessionExecute): void {
    this.execute = execute;
  }

  getOperationLogStore(): OperationLogStore {
    return this.operationLog;
  }

  isIdle(now = Date.now()): boolean {
    return !this.closed && now - this.lastActive > this.idleMs;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async handleRequest(request: LocalSessionRequest): Promise<unknown> {
    if (this.closed) {
      return { ok: false, error: { code: 'CLI_SESSION_CLOSED', message: '会话已关闭。' } };
    }
    this.lastActive = Date.now();
    const payloadHash = hashPayload(request.tool, request.args);
    const stateKey = `${this.instanceId}::${request.id}`;
    const prior = this.requestStates.get(stateKey);
    if (prior) {
      if (prior.instanceId === this.instanceId && prior.payloadHash === payloadHash) {
        return prior.result;
      }
      return {
        ok: false,
        error: {
          code: 'CLI_REQUEST_ID_CONFLICT',
          message: '相同 requestId 对应不同 payload。'
        }
      };
    }
    const execute = this.execute;
    if (!execute) {
      return {
        ok: false,
        error: {
          code: 'CLI_SESSION_EXECUTOR_REQUIRED',
          message: '会话宿主尚未注入 ToolRegistry executor。'
        }
      };
    }
    const result = await execute(request.tool, request.args);
    this.requestStates.set(stateKey, {
      instanceId: this.instanceId,
      requestId: request.id,
      payloadHash,
      result
    });
    return result;
  }

  close(): void {
    this.closed = true;
    this.requestStates.clear();
    if (this.ownsOperationLog) {
      disposeOwnedStore(this.operationLog);
    }
  }
}

function cliOperationLogUnavailable(message: string): Error & { code: string } {
  const error = new Error(`CLI_OPERATION_LOG_UNAVAILABLE: ${message}`) as Error & { code: string };
  error.code = 'CLI_OPERATION_LOG_UNAVAILABLE';
  return error;
}

function disposeOwnedStore(store: OperationLogStore): void {
  const candidate = store as OperationLogStore & { dispose?: () => void; close?: () => void };
  try {
    if (typeof candidate.dispose === 'function') candidate.dispose();
    else if (typeof candidate.close === 'function') candidate.close();
  } catch {
    // Dispose is best-effort on process teardown.
  }
}

function hashPayload(tool: string, args: Record<string, unknown>): string {
  const json = JSON.stringify({ tool, args: sortValue(args) });
  let hash = 0;
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0;
  }
  return `${json.length}:${hash}`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function createLocalSessionHost(options: LocalSessionHostOptions): LocalSessionHost {
  return new LocalSessionHost(options);
}
