/** T11-C 本地 IPC 客户端：握手、请求与结果传输；只走本机管道，不走 TCP。 */
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { DAEMON_PROTOCOL, daemonPaths } from './sessionPipeDaemon.js';
import { MAX_FRAME_BYTES, type SessionError } from './localSessionHost.js';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface PipeSessionCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface PipeSessionResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: SessionError;
}

export class SessionPipeClient {
  private socket: Socket | null = null;
  private buffer = '';
  private pending = new Map<string, {
    resolve: (value: PipeSessionResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private handshakeDone = false;

  async connect(workspaceKey: string, sessionName: string): Promise<void> {
    const paths = daemonPaths(workspaceKey, sessionName);
    const authToken = readFileSync(paths.authTokenPath, 'utf8').trim();
    this.socket = connect(paths.pipePath);
    this.socket.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        this.socket?.removeListener('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.socket?.removeListener('connect', onConnect);
        reject(error);
      };
      this.socket!.once('connect', onConnect);
      this.socket!.once('error', onError);
    });
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (error) => this.failPending(error instanceof Error ? error : new Error(String(error))));
    this.socket.on('close', () => this.failPending(new Error('CLI_DAEMON_DISCONNECTED')));
    const ack = await this.roundTrip({
      id: 'handshake',
      protocol: DAEMON_PROTOCOL,
      workspaceKey,
      sessionName,
      authToken
    } as unknown as PipeSessionCall, HANDSHAKE_TIMEOUT_MS);
    if (!ack.ok) {
      const error = ack.error;
      throw new Error(`CLI_SESSION_AUTH_FAILED: ${error?.code ?? 'CLI_SESSION_AUTH_FAILED'} ${error?.message ?? ''}`);
    }
    this.handshakeDone = true;
  }

  async call(request: PipeSessionCall): Promise<PipeSessionResult> {
    if (!this.handshakeDone) throw new Error('CLI_SESSION_NOT_CONNECTED');
    return await this.roundTrip(request);
  }

  close(): void {
    this.failPending(new Error('CLI_SESSION_CLOSED'));
    this.socket?.end();
    this.socket = null;
    this.buffer = '';
    this.handshakeDone = false;
  }

  private roundTrip(frame: PipeSessionCall | Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<PipeSessionResult> {
    return new Promise<PipeSessionResult>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('CLI_DAEMON_DISCONNECTED'));
        return;
      }
      const id = typeof (frame as PipeSessionCall).id === 'string' && (frame as PipeSessionCall).id !== ''
        ? (frame as PipeSessionCall).id
        : `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.reject(new Error('CLI_REQUEST_TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const payload = `${JSON.stringify({ ...frame, id })}\n`;
      if (Buffer.byteLength(payload, 'utf8') > MAX_FRAME_BYTES) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('CLI_FRAME_TOO_LARGE'));
        return;
      }
      this.socket!.write(payload, (error) => {
        if (error) {
          const entry = this.pending.get(id);
          if (entry) clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
      this.failPending(new Error('CLI_FRAME_TOO_LARGE'));
      this.socket?.destroy();
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line.trim() === '') continue;
      let frame: PipeSessionResult;
      try {
        frame = JSON.parse(line) as PipeSessionResult;
      } catch {
        this.failPending(new Error('CLI_FRAME_INVALID'));
        continue;
      }
      if (typeof frame.id === 'string') {
        const entry = this.pending.get(frame.id);
        if (entry) {
          this.pending.delete(frame.id);
          clearTimeout(entry.timer);
          entry.resolve(frame);
        }
      }
    }
  }

  private failPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
