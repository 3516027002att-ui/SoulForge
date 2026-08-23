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
  /** stdoutBuffer 的 UTF-8 字节数，增量维护，避免每 chunk 重算。 */
  private stdoutBufferBytes = 0;
  /** stdoutBuffer 中已确认不含换行的前缀长度（字符数）。 */
  private stdoutScanned = 0;
  private stderrTail = '';
  private closed = false;
  private negotiatedMaxFrameBytes: number;
  /**
   * 进行中的请求数。构造时子进程被 unref（见构造函数注释），所以有请求在飞时
   * 必须临时 ref 回来，否则宿主可能在响应到达前就退出而把请求静默丢掉。
   * 用计数而不是布尔：并发请求下先完成的那个不能把仍在等的请求的引用撤掉。
   */
  private inFlight = 0;

  private constructor(public readonly options: BridgeDaemonClientOptions) {
    this.negotiatedMaxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.child = spawn(options.executable, [...(options.args ?? []), 'daemon'], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // daemon 子进程与其 stdio 都是活跃句柄，会让宿主 node 进程无法退出。
    // 实测后果：runNativeFlverSmoke 的成功路径漏调 disposeBridgeDaemonPool()，
    // 于是进程挂死 4 小时（CPU 全程 0.1s 无增长）、锁住 bin 下的 SoulForge.Bridge.exe，
    // 使后续 bridge:build 与整个 native 层失败。仓库里 37 个用 runBridge 的
    // smoke/probe 全都没把 dispose 放进 finally，靠调用方记得关是不可靠的。
    //
    // unref 让「忘记 dispose」退化为「进程正常退出」而不是「挂死」。这不会产生
    // 孤儿进程：BridgeDaemonHost 在 ReadLineAsync 返回 null（stdin 关闭）时会
    // break 退出主循环，宿主退出即断管道即触发它自行终止。
    // 显式 dispose() 仍是首选路径（它会等 close 并在 2s 后 kill），unref 只是兜底。
    this.child.unref();
    this.setStdioRef('unref');
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
    // 关闭期间同样要 ref：子进程处于 unref 状态时，'close' 事件不足以维持事件
    // 循环，宿主可能在收到它之前就退出，使这个 await 永远拿不到结果。
    this.retain();
    this.child.stdin.end();
    const close = once(this.child, 'close');
    const timeout = setTimeout(() => this.child.kill(), 2_000);
    try {
      await close;
    } finally {
      clearTimeout(timeout);
      this.release();
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
    this.retain();
    try {
      return await this.sendAndWaitInner(
        kind, payload, terminalKinds, timeoutMs, resourceUri, onProgress, signal
      );
    } finally {
      this.release();
    }
  }

  /** 请求期间把子进程 ref 回来；见 inFlight 字段说明。 */
  private retain(): void {
    this.inFlight += 1;
    if (this.inFlight === 1) {
      this.child.ref();
      this.setStdioRef('ref');
    }
  }

  private release(): void {
    this.inFlight -= 1;
    if (this.inFlight === 0) {
      this.child.unref();
      this.setStdioRef('unref');
    }
  }

  /**
   * child.unref() 只脱开进程句柄，三条 stdio 管道仍是活跃句柄。实测：只调
   * child.unref() 时进程仍挂死，`process._getActiveHandles()` 显示 6 个 Socket
   * （两个 daemon 客户端 × stdin/stdout/stderr）。
   *
   * Node 的类型声明把 stdio 标为 Readable/Writable，其上没有 ref/unref；但在
   * 管道模式下它们的实际实现是 net.Socket，确实带这两个方法。这里按运行期能力
   * 探测调用，而不是断言类型——某个平台上若真的不是 Socket，就安静跳过而不是崩。
   */
  private setStdioRef(mode: 'ref' | 'unref'): void {
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      const fn = (stream as unknown as Partial<Record<typeof mode, () => void>>)[mode];
      if (typeof fn === 'function') fn.call(stream);
    }
  }

  private async sendAndWaitInner(
    kind: BridgeDaemonFrame['kind'],
    payload: unknown,
    terminalKinds: Set<string>,
    timeoutMs: number,
    resourceUri?: string,
    onProgress?: (payload: unknown) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<BridgeDaemonFrame<unknown>> {
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
    // 单帧可达数 MB（read-emevd-document 一页装满时 33266 条指令约 4-5 MB），
    // 会被 stdout 切成上百个 chunk。此处两处扫描必须增量，否则每个 chunk 都
    // 重扫整个缓冲，规模上是 O(n²)。实测量级要说清：common.emevd.dcx 一次
    // 65536 页整读，改成增量后总耗时 274.5 ms → 257.7 ms，只省 ~17 ms —— 这条
    // 是复杂度正确性修复，不是打开路径的主要瓶颈（主瓶颈在反汇编，见
    // darkScriptRenderer）。页大小再涨或帧再大时这一项才会变显著。
    this.stdoutBuffer += chunk;
    this.stdoutBufferBytes += Buffer.byteLength(chunk, 'utf8');
    if (this.stdoutBufferBytes > this.negotiatedMaxFrameBytes * 2) {
      this.failAll(new BridgeDaemonError('BRIDGE_FRAME_TOO_LARGE', 'Bridge stdout exceeded the frame buffer limit.'));
      this.child.kill();
      return;
    }
    while (true) {
      // 已确认无换行的前缀不再重扫；消费掉一帧后归零。
      const newline = this.stdoutBuffer.indexOf('\n', this.stdoutScanned);
      if (newline < 0) {
        this.stdoutScanned = this.stdoutBuffer.length;
        return;
      }
      const rawLine = this.stdoutBuffer.slice(0, newline);
      const line = rawLine.trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      // '\n' 在 UTF-8 里恒为 1 字节。
      this.stdoutBufferBytes -= Buffer.byteLength(rawLine, 'utf8') + 1;
      this.stdoutScanned = 0;
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
