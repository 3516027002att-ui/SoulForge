import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import type {
  BridgeCancelPayload,
  BridgeDaemonFailurePayload,
  BridgeDaemonFrame,
  BridgeDaemonResultPayload,
  BridgeHandshakePayload,
  BridgeRequestPayload
} from '@soulforge/shared';
import { BRIDGE_PROTOCOL_VERSION } from '@soulforge/shared';

export interface BridgeDaemonClientOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  workspaceSessionId: string;
  allowedRoots: string[];
  writableRoots?: string[];
  oodleRuntimeRoot?: string;
  maxFrameBytes?: number;
  maxConcurrency?: number;
  startupTimeoutMs?: number;
}

export interface BridgeDaemonRequestOptions<T = unknown> {
  payload: BridgeRequestPayload;
  resourceUri: string;
  timeoutMs: number;
  onProgress?: (payload: T) => void | Promise<void>;
  signal?: AbortSignal;
}

interface PendingRequest {
  terminalKinds: Set<string>;
  resolve: (frame: BridgeDaemonFrame<unknown>) => void;
  reject: (error: Error) => void;
  onProgress?: (payload: unknown) => void | Promise<void>;
  progressChain: Promise<void>;
  terminalFrame?: BridgeDaemonFrame<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
}

export class BridgeDaemonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
  }
}

export class BridgeDaemonClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer = '';
  private stderrTail = '';
  private closed = false;
  private negotiatedMaxFrameBytes: number;

  private constructor(private readonly options: BridgeDaemonClientOptions) {
    this.negotiatedMaxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.child = spawn(options.executable, [...(options.args ?? []), 'daemon'], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-16 * 1024);
    });
    this.child.stdin.on('error', (error) => this.failAll(new BridgeDaemonError(
      'BRIDGE_STDIN_FAILED',
      error.message,
      true
    )));
    this.child.once('error', (error) => this.failAll(new BridgeDaemonError(
      'BRIDGE_SPAWN_FAILED',
      error.message,
      true
    )));
    this.child.once('close', (code, signal) => this.failAll(new BridgeDaemonError(
      'BRIDGE_PROCESS_EXITED',
      `Bridge process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}). ${this.stderrTail}`.trim(),
      true
    )));
  }

  static async start(options: BridgeDaemonClientOptions): Promise<BridgeDaemonClient> {
    const client = new BridgeDaemonClient(options);
    try {
      const payload: BridgeHandshakePayload = {
        allowedRoots: options.allowedRoots,
        ...(options.writableRoots?.length ? { writableRoots: options.writableRoots } : {}),
        ...(options.oodleRuntimeRoot ? { oodleRuntimeRoot: options.oodleRuntimeRoot } : {}),
        maxFrameBytes: options.maxFrameBytes ?? 1024 * 1024,
        maxConcurrency: options.maxConcurrency ?? 2
      };
      const frame = await client.sendAndWait(
        'handshake',
        payload,
        new Set(['handshake', 'failed']),
        options.startupTimeoutMs ?? 15_000
      );
      if (frame.kind === 'failed') throw failureFromFrame(frame);
      const response = asRecord(frame.payload);
      if (typeof response.maxFrameBytes === 'number') {
        client.negotiatedMaxFrameBytes = response.maxFrameBytes;
      }
      return client;
    } catch (error) {
      await client.dispose();
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async request<TResult = unknown, TProgress = unknown>(
    options: BridgeDaemonRequestOptions<TProgress>
  ): Promise<BridgeDaemonResultPayload<TResult>> {
    const frame = await this.sendAndWait(
      'request',
      options.payload,
      new Set(['result', 'failed', 'cancelled']),
      options.timeoutMs,
      options.resourceUri,
      options.onProgress as ((payload: unknown) => void | Promise<void>) | undefined,
      options.signal
    );
    if (frame.kind === 'failed') throw failureFromFrame(frame);
    if (frame.kind === 'cancelled') {
      throw new BridgeDaemonError('BRIDGE_REQUEST_CANCELLED', 'Bridge request was cancelled.', true);
    }
    return frame.payload as BridgeDaemonResultPayload<TResult>;
  }

  async health(timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const frame = await this.sendAndWait('health', {}, new Set(['health', 'failed']), timeoutMs);
    if (frame.kind === 'failed') throw failureFromFrame(frame);
    return asRecord(frame.payload);
  }

  async capabilities(timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const frame = await this.sendAndWait(
      'capabilities',
      {},
      new Set(['capabilities', 'failed']),
      timeoutMs
    );
    if (frame.kind === 'failed') throw failureFromFrame(frame);
    return asRecord(frame.payload);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    const close = once(this.child, 'close');
    const timeout = setTimeout(() => this.child.kill(), 2_000);
    try {
      await close;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sendAndWait(
    kind: BridgeDaemonFrame['kind'],
    payload: unknown,
    terminalKinds: Set<string>,
    timeoutMs: number,
    resourceUri?: string,
    onProgress?: (payload: unknown) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<BridgeDaemonFrame<unknown>> {
    if (this.closed) throw new BridgeDaemonError('BRIDGE_CLIENT_CLOSED', 'Bridge client is closed.');
    if (signal?.aborted) {
      throw new BridgeDaemonError('BRIDGE_REQUEST_CANCELLED', 'Bridge request was cancelled.', true);
    }
    const requestId = randomUUID();
    const deadlineUtc = new Date(Date.now() + timeoutMs).toISOString();
    const writeController = new AbortController();
    let registeredPending: PendingRequest | undefined;
    const result = new Promise<BridgeDaemonFrame<unknown>>((resolve, reject) => {
      const pending: PendingRequest = {
        terminalKinds,
        resolve,
        reject,
        progressChain: Promise.resolve(),
        ...(onProgress ? { onProgress } : {})
      };
      registeredPending = pending;
      pending.timer = setTimeout(() => {
        this.pending.delete(requestId);
        pending.abortCleanup?.();
        writeController.abort('timeout');
        void this.sendCancel(requestId);
        reject(new BridgeDaemonError(
          'BRIDGE_TIMEOUT',
          `Bridge request timed out after ${timeoutMs}ms.`,
          true
        ));
      }, timeoutMs);
      if (signal) {
        const onAbort = () => {
          this.pending.delete(requestId);
          if (pending.timer) clearTimeout(pending.timer);
          writeController.abort('cancelled');
          void this.sendCancel(requestId);
          reject(new BridgeDaemonError('BRIDGE_REQUEST_CANCELLED', 'Bridge request was cancelled.', true));
        };
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener('abort', onAbort, { once: true });
          pending.abortCleanup = () => signal.removeEventListener('abort', onAbort);
        }
      }
      if (!signal?.aborted) this.pending.set(requestId, pending);
    });
    // A backpressured write can outlive the request timer; keep the inner rejection observed.
    void result.catch(() => undefined);

    if (registeredPending === undefined
      || this.pending.get(requestId) !== registeredPending) return result;

    try {
      await this.writeFrame({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        kind,
        requestId,
        workspaceSessionId: this.options.workspaceSessionId,
        deadlineUtc,
        ...(resourceUri ? { resourceUri } : {}),
        payload
      }, writeController.signal);
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending !== undefined && pending === registeredPending) {
        this.pending.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.abortCleanup?.();
        pending.reject(error instanceof Error ? error : new BridgeDaemonError(
          'BRIDGE_WRITE_FAILED',
          'Bridge request frame could not be written.',
          true
        ));
      }
    }
    return result;
  }

  private async sendCancel(targetRequestId: string): Promise<void> {
    if (this.closed || !this.child.stdin.writable) return;
    const payload: BridgeCancelPayload = { targetRequestId };
    await this.writeFrame({
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      kind: 'cancel',
      requestId: randomUUID(),
      workspaceSessionId: this.options.workspaceSessionId,
      payload
    }).catch(() => undefined);
  }

  private async writeFrame(frame: BridgeDaemonFrame, signal?: AbortSignal): Promise<void> {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, 'utf8') > this.negotiatedMaxFrameBytes) {
      throw new BridgeDaemonError('BRIDGE_FRAME_TOO_LARGE', 'Outbound Bridge frame exceeds the negotiated limit.');
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        this.child.stdin.off('error', onStdinError);
        this.child.stdin.off('close', onStdinClose);
        this.child.off('close', onProcessClose);
        if (error) reject(error);
        else resolve();
      };
      const writeFailure = (message: string): BridgeDaemonError => new BridgeDaemonError(
        'BRIDGE_WRITE_FAILED',
        message,
        true
      );
      const onAbort = (): void => finish(writeFailure('Bridge frame write was cancelled.'));
      const onStdinError = (error: Error): void => finish(writeFailure(error.message));
      const onStdinClose = (): void => finish(writeFailure('Bridge stdin closed before the frame was written.'));
      const onProcessClose = (): void => finish(writeFailure('Bridge process exited before the frame was written.'));

      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (this.closed || !this.child.stdin.writable) {
        onStdinClose();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.child.stdin.once('error', onStdinError);
      this.child.stdin.once('close', onStdinClose);
      this.child.once('close', onProcessClose);
      try {
        this.child.stdin.write(line, 'utf8', (error?: Error | null) => {
          if (error) onStdinError(error);
          else finish();
        });
      } catch (error) {
        onStdinError(error instanceof Error ? error : writeFailure('Bridge frame write failed.'));
      }
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.negotiatedMaxFrameBytes * 2) {
      this.failAll(new BridgeDaemonError('BRIDGE_FRAME_TOO_LARGE', 'Bridge stdout exceeded the frame buffer limit.'));
      this.child.kill();
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > this.negotiatedMaxFrameBytes) {
        this.failAll(new BridgeDaemonError('BRIDGE_FRAME_TOO_LARGE', 'Inbound Bridge frame exceeds the negotiated limit.'));
        this.child.kill();
        return;
      }
      try {
        const frame = JSON.parse(line) as BridgeDaemonFrame<unknown>;
        this.handleFrame(frame);
      } catch (error) {
        this.failAll(new BridgeDaemonError(
          'BRIDGE_INVALID_JSON',
          error instanceof Error ? error.message : String(error)
        ));
        this.child.kill();
        return;
      }
    }
  }

  private handleFrame(frame: BridgeDaemonFrame<unknown>): void {
    if (frame.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      this.failAll(new BridgeDaemonError(
        'BRIDGE_PROTOCOL_MISMATCH',
        `Expected ${BRIDGE_PROTOCOL_VERSION}, received ${frame.protocolVersion}.`
      ));
      this.child.kill();
      return;
    }
    if (frame.workspaceSessionId
      && frame.workspaceSessionId !== this.options.workspaceSessionId) return;
    if (!frame.requestId) return;
    const pending = this.pending.get(frame.requestId);
    if (!pending) return;
    if (frame.kind === 'progress') {
      if (pending.terminalFrame !== undefined || pending.onProgress === undefined) return;
      const onProgress = pending.onProgress;
      pending.progressChain = pending.progressChain.then(() => onProgress(frame.payload));
      void pending.progressChain.catch(() => {
        this.failProgressHandler(frame.requestId!, pending);
      });
      return;
    }
    if (!pending.terminalKinds.has(frame.kind)) return;
    if (pending.terminalFrame !== undefined) return;
    pending.terminalFrame = frame;
    void pending.progressChain.then(
      () => this.resolvePending(frame.requestId!, pending, frame),
      () => this.failProgressHandler(frame.requestId!, pending)
    );
  }

  private resolvePending(
    requestId: string,
    pending: PendingRequest,
    frame: BridgeDaemonFrame<unknown>
  ): void {
    if (this.pending.get(requestId) !== pending) return;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.abortCleanup?.();
    pending.resolve(frame);
  }

  private failProgressHandler(requestId: string, pending: PendingRequest): void {
    if (this.pending.get(requestId) !== pending) return;
    this.pending.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.abortCleanup?.();
    if (pending.terminalFrame === undefined) void this.sendCancel(requestId);
    pending.reject(new BridgeDaemonError(
      'BRIDGE_PROGRESS_HANDLER_FAILED',
      'The Bridge progress handler failed while processing a progress frame.'
    ));
  }

  private failAll(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.abortCleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function failureFromFrame(frame: BridgeDaemonFrame<unknown>): BridgeDaemonError {
  const payload = asRecord(frame.payload) as Partial<BridgeDaemonFailurePayload>;
  return new BridgeDaemonError(
    typeof payload.code === 'string' ? payload.code : 'BRIDGE_REQUEST_FAILED',
    typeof payload.message === 'string' ? payload.message : 'Bridge request failed.',
    payload.retryable === true
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
