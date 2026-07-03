export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskProgress {
  current: number;
  total?: number;
  message?: string;
}

export interface TaskContext {
  signal: AbortSignal;
  reportProgress: (progress: TaskProgress) => void;
}

export interface QueuedTask<T> {
  id: string;
  title: string;
  status: TaskStatus;
  progress: TaskProgress;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  promise: Promise<T>;
  cancel: () => void;
}

type TaskHandler<T> = (context: TaskContext) => Promise<T>;
type InternalTask<T> = QueuedTask<T> & {
  handler: TaskHandler<T>;
  controller: AbortController;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export interface TaskQueueOptions {
  concurrency?: number;
}

/**
 * Small cancellable queue for parsing, indexing, bridge calls, and validations.
 * It keeps heavyweight work outside the renderer and provides progress/state hooks.
 */
export class TaskQueue {
  private readonly concurrency: number;
  private readonly pending: Array<InternalTask<unknown>> = [];
  private readonly tasks = new Map<string, InternalTask<unknown>>();
  private runningCount = 0;

  constructor(options: TaskQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 2);
  }

  enqueue<T>(title: string, handler: TaskHandler<T>): QueuedTask<T> {
    const id = makeTaskId();
    const controller = new AbortController();
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    const task: InternalTask<T> = {
      id,
      title,
      status: 'queued',
      progress: { current: 0 },
      createdAt: Date.now(),
      promise,
      handler,
      controller,
      resolve,
      reject,
      cancel: () => this.cancel(id)
    };

    this.tasks.set(id, task as InternalTask<unknown>);
    this.pending.push(task as InternalTask<unknown>);
    this.pump();
    return task;
  }

  list(): QueuedTask<unknown>[] {
    return [...this.tasks.values()].map(stripInternalFields);
  }

  get(id: string): QueuedTask<unknown> | undefined {
    const task = this.tasks.get(id);
    return task ? stripInternalFields(task) : undefined;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false;

    task.controller.abort();
    if (task.status === 'queued') {
      task.status = 'cancelled';
      task.completedAt = Date.now();
      task.reject(new Error(`Task cancelled: ${task.title}`));
      const index = this.pending.findIndex((item) => item.id === id);
      if (index !== -1) this.pending.splice(index, 1);
    }

    return true;
  }

  cancelAll(): void {
    for (const task of this.tasks.values()) this.cancel(task.id);
  }

  private pump(): void {
    while (this.runningCount < this.concurrency) {
      const task = this.pending.shift();
      if (!task) return;
      if (task.status === 'cancelled') continue;
      void this.runTask(task);
    }
  }

  private async runTask(task: InternalTask<unknown>): Promise<void> {
    this.runningCount += 1;
    task.status = 'running';
    task.startedAt = Date.now();

    try {
      const result = await task.handler({
        signal: task.controller.signal,
        reportProgress: (progress) => {
          task.progress = progress;
        }
      });

      if (task.controller.signal.aborted) {
        task.status = 'cancelled';
        task.completedAt = Date.now();
        task.reject(new Error(`Task cancelled: ${task.title}`));
        return;
      }

      task.status = 'completed';
      task.completedAt = Date.now();
      task.resolve(result);
    } catch (error) {
      task.status = task.controller.signal.aborted ? 'cancelled' : 'failed';
      task.completedAt = Date.now();
      task.error = error instanceof Error ? error.message : String(error);
      task.reject(error);
    } finally {
      this.runningCount -= 1;
      this.pump();
    }
  }
}

function stripInternalFields(task: InternalTask<unknown>): QueuedTask<unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(task.error === undefined ? {} : { error: task.error }),
    promise: task.promise,
    cancel: task.cancel
  };
}

function makeTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
