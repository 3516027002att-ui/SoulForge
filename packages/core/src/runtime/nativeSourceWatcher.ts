/** T03 外层源外部变化监听：显式绝对路径轮询，无目录递归、无 symlink 跟随。 */
import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export type NativeSourceChangeKind = 'modified' | 'deleted' | 'created';

export interface NativeSourceChangeEvent {
  absolutePath: string;
  kind: NativeSourceChangeKind;
  /** 观测到的新状态；deleted 时为最后已知状态。 */
  mtimeMs: number;
  size: number;
}

export interface NativeSourceWatcherOptions {
  /** 轮询间隔毫秒；宿主按需调优，默认 1000。 */
  pollIntervalMs?: number;
  onEvent: (event: NativeSourceChangeEvent) => void;
  /** 回调异常隔离出口；缺席则吞掉并继续轮询（宿主应提供以便可观测）。 */
  onError?: (error: unknown, absolutePath?: string) => void;
}

interface WatchedBaseline {
  present: boolean;
  mtimeMs: number;
  size: number;
}

function validateWatchPath(absolutePath: string): void {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0 || !isAbsolute(absolutePath)) {
    throw new Error('NATIVE_WATCH_PATH_INVALID');
  }
}

export class NativeSourceWatcher {
  private readonly watched = new Map<string, WatchedBaseline | null>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly onEvent: (event: NativeSourceChangeEvent) => void;
  private readonly onError: ((error: unknown, absolutePath?: string) => void) | undefined;

  constructor(options: NativeSourceWatcherOptions) {
    if (options.pollIntervalMs !== undefined
      && (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0)) {
      throw new Error('NATIVE_WATCH_INTERVAL_INVALID');
    }
    if (typeof options.onEvent !== 'function') throw new Error('NATIVE_WATCH_EVENT_HANDLER_REQUIRED');
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, options.pollIntervalMs ?? 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * 注册监听：同步建立基线（注册与首轮之间的写入不丢失），不 firing；
   * 重复注册保持原基线。基线不可读时留空，由首轮 poll 建立并上报错误。
   */
  watch(absolutePath: string): void {
    if (this.closed) throw new Error('NATIVE_WATCHER_CLOSED');
    validateWatchPath(absolutePath);
    if (this.watched.has(absolutePath)) return;
    let baseline: WatchedBaseline | null = null;
    try {
      const attributes = statSync(absolutePath);
      baseline = { present: true, mtimeMs: attributes.mtimeMs, size: attributes.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        baseline = { present: false, mtimeMs: 0, size: 0 };
      }
    }
    this.watched.set(absolutePath, baseline);
  }

  unwatch(absolutePath: string): void {
    this.watched.delete(absolutePath);
  }

  get watchedCount(): number {
    return this.watched.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 单轮比对：首次观测只建基线；每次变化最多 firing 一次（轮询间多次写入合并）。
   * 宿主亦可主动驱动（测试/低频场景），与定时轮询互斥无关。
   */
  async pollOnce(): Promise<void> {
    if (this.closed) return;
    for (const [absolutePath, baseline] of [...this.watched.entries()]) {
      if (this.closed || !this.watched.has(absolutePath)) continue;
      let current: WatchedBaseline;
      try {
        const attributes = await stat(absolutePath);
        current = { present: true, mtimeMs: attributes.mtimeMs, size: attributes.size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          this.reportError(error, absolutePath);
          continue;
        }
        current = { present: false, mtimeMs: baseline?.mtimeMs ?? 0, size: baseline?.size ?? 0 };
      }
      if (baseline === null) {
        this.watched.set(absolutePath, current);
        continue;
      }
      if (!baseline.present && current.present) {
        this.fire({ absolutePath, kind: 'created', mtimeMs: current.mtimeMs, size: current.size });
      } else if (baseline.present && !current.present) {
        this.fire({ absolutePath, kind: 'deleted', mtimeMs: baseline.mtimeMs, size: baseline.size });
      } else if (current.present && (current.mtimeMs !== baseline.mtimeMs || current.size !== baseline.size)) {
        this.fire({ absolutePath, kind: 'modified', mtimeMs: current.mtimeMs, size: current.size });
      } else {
        continue;
      }
      this.watched.set(
        absolutePath,
        current.present ? current : { present: false, mtimeMs: baseline.mtimeMs, size: baseline.size }
      );
    }
  }

  private fire(event: NativeSourceChangeEvent): void {
    try {
      this.onEvent(event);
    } catch (error) {
      this.reportError(error, event.absolutePath);
    }
  }

  private reportError(error: unknown, absolutePath?: string): void {
    try {
      this.onError?.(error, absolutePath);
    } catch {
      // 兜底：轮询永不因错误出口自身异常而死。
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.watched.clear();
  }
}

