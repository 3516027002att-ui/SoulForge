/** T11-B/C 本地 IPC 守护宿主：同用户同工作区跨进程复用会话；禁止 TCP。 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { CoreToolSession } from '../runtime/coreToolSession.js';
import { LocalSessionHost, MAX_FRAME_BYTES, sessionError } from './localSessionHost.js';

export interface DaemonHandshake {
  protocol: number;
  workspaceKey: string;
  sessionName: string;
  authToken: string;
}

export interface DaemonConfig {
  workspaceId: string;
  workspaceKey: string;
  sessionName: string;
  principal: string;
  pipePath: string;
  lockPath: string;
  authTokenPath: string;
}

export const DAEMON_PROTOCOL = 1;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export function daemonPaths(workspaceKey: string, sessionName: string): Omit<DaemonConfig, 'workspaceId' | 'workspaceKey' | 'sessionName' | 'principal'> & { dir: string } {
  const safe = createHash('sha256').update(`${workspaceKey}|${sessionName}`).digest('hex').slice(0, 24);
  const dir = join(tmpdir(), 'soulforge-sessions', safe);
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\soulforge-${safe}` : join(dir, 'session.sock');
  return { dir, pipePath, lockPath: join(dir, 'lock'), authTokenPath: join(dir, 'auth') };
}

function readPidLock(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface SessionDaemon {
  config: DaemonConfig;
  coreSession: CoreToolSession;
  /** 帧/排队/id 去重的请求宿主（证明归桥接会话，本宿主只做传输语义）。 */
  requestHost: LocalSessionHost;
  close(): Promise<void>;
}

/** 同一 key 只产生一个有效 host：独占锁 + 拥有者存活检查。 */
export function tryAcquireStartLock(lockPath: string): boolean {
  try {
    mkdirSync(join(lockPath, '..'), { recursive: true });
  } catch { /* 已存在则继续 */ }
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    const owner = readPidLock(lockPath);
    if (owner !== null && !pidAlive(owner)) {
      try {
        rmSync(lockPath, { force: true });
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export async function startSessionDaemon(input: {
  workspaceId: string;
  workspaceKey: string;
  sessionName: string;
  principal: string;
  /** 复用 openLocalCliSession 持有的真实 CoreToolSession。 */
  coreSession?: CoreToolSession;
  /** 宿主进程注入的真实执行（注册表 + 桥接 + 会话）；daemon 只做传输与握手。 */
  dispatch: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}): Promise<SessionDaemon> {
  const paths = daemonPaths(input.workspaceKey, input.sessionName);
  mkdirSync(paths.dir, { recursive: true });
  if (!tryAcquireStartLock(paths.lockPath)) {
    throw new Error('CLI_SESSION_ALREADY_RUNNING');
  }
  const authToken = randomBytes(32).toString('hex');
  writeFileSync(paths.authTokenPath, authToken, { mode: 0o600 });
  const coreSession = input.coreSession ?? new CoreToolSession({ principal: input.principal, workspaceId: input.workspaceId });
  const config: DaemonConfig = {
    workspaceId: input.workspaceId,
    workspaceKey: input.workspaceKey,
    sessionName: input.sessionName,
    principal: input.principal,
    pipePath: paths.pipePath,
    lockPath: paths.lockPath,
    authTokenPath: paths.authTokenPath
  };
  const requestHost = new LocalSessionHost(input.sessionName, input.workspaceId, input.principal, coreSession);
  const server: Server = createServer((socket) => handleDaemonSocket(socket, config, authToken, requestHost, input.dispatch));
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(paths.pipePath);
    });
  } catch (error) {
    requestHost.close();
    if (!input.coreSession) coreSession.close();
    try { rmSync(paths.lockPath, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
  return {
    config,
    coreSession,
    requestHost,
    close: async () => {
      if (!input.coreSession) coreSession.close();
      requestHost.close();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      try {
        rmSync(paths.lockPath, { force: true });
      } catch { /* 关闭时锁清理失败不掩盖结果 */ }
    }
  };
}

function handleDaemonSocket(
  socket: Socket,
  config: DaemonConfig,
  authToken: string,
  requestHost: LocalSessionHost,
  dispatch: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
): void {
  let buffer = '';
  let authed = false;
  let closed = false;
  let processing = Promise.resolve();
  const connectionAbort = new AbortController();
  const handshakeTimer = setTimeout(() => {
    if (authed || closed) return;
    write({ id: '', ok: false, error: sessionError('CLI_HANDSHAKE_TIMEOUT', '本地会话握手超时。', true) });
    connectionAbort.abort();
    socket.destroy();
    closed = true;
  }, HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();
  socket.setEncoding('utf8');
  const write = (frame: Record<string, unknown>): void => {
    if (closed || socket.destroyed) return;
    try {
      socket.write(`${JSON.stringify(frame)}\n`, () => undefined);
    } catch {
      closed = true;
      connectionAbort.abort();
    }
  };
  socket.on('error', () => {
    closed = true;
    connectionAbort.abort();
    clearTimeout(handshakeTimer);
  });
  socket.on('close', () => {
    closed = true;
    connectionAbort.abort();
    clearTimeout(handshakeTimer);
  });
  socket.on('data', (chunk: string) => {
    if (closed) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES + MAX_HANDSHAKE_BYTES) {
      write({ id: '', ok: false, error: sessionError('CLI_FRAME_TOO_LARGE', '管道帧超过大小上限。', false) });
      socket.destroy();
      closed = true;
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.trim() === '') continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        write({ id: '', ok: false, error: sessionError('CLI_FRAME_TOO_LARGE', '管道帧超过大小上限。', false) });
        socket.destroy();
        closed = true;
        return;
      }
      processing = processing
        .then(() => handleDaemonLine(write, socket, line, config, authToken, requestHost, dispatch, connectionAbort.signal, () => {
          authed = true;
          clearTimeout(handshakeTimer);
        }, () => authed))
        .catch(() => undefined);
    }
  });
}

async function handleDaemonLine(
  write: (frame: Record<string, unknown>) => void,
  socket: Socket,
  line: string,
  config: DaemonConfig,
  authToken: string,
  requestHost: LocalSessionHost,
  dispatch: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  markAuthed: () => void,
  isAuthed: () => boolean
): Promise<void> {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(line) as Record<string, unknown>;
  } catch {
    write({ id: '', ok: false, error: sessionError('CLI_FRAME_INVALID', '管道帧不是有效 JSON。', false) });
    return;
  }
  if (!isAuthed()) {
    const handshake = frame as Partial<DaemonHandshake>;
    if (handshake.protocol !== DAEMON_PROTOCOL
      || handshake.workspaceKey !== config.workspaceKey
      || handshake.sessionName !== config.sessionName
      || handshake.authToken !== authToken) {
      write({ id: '', ok: false, error: sessionError('CLI_SESSION_AUTH_FAILED', '本地会话握手认证失败。', false) });
      socket.end();
      return;
    }
    markAuthed();
    write({ id: 'handshake', ok: true, handshake: true });
    return;
  }
  const id = typeof frame.id === 'string' ? frame.id : '';
  const tool = typeof frame.tool === 'string' ? frame.tool : '';
  const args = typeof frame.args === 'object' && frame.args !== null ? frame.args as Record<string, unknown> : {};
  if (!id || !tool) {
    write({ id, ok: false, error: sessionError('CLI_REQUEST_INVALID', '本地会话请求格式无效。', false) });
    return;
  }
  try {
    const outcome = await requestHost.dispatch({ id, tool, args }, dispatch, signal);
    write(outcome as unknown as Record<string, unknown>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^CLI_[A-Z0-9_]+/u.exec(message)?.[0] ?? 'CLI_REQUEST_FAILED';
    write({ id, ok: false, error: sessionError(code, message, code === 'CLI_REQUEST_TIMEOUT' || code === 'CLI_DAEMON_DISCONNECTED') });
  }
}
