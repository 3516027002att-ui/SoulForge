export interface ToolEffect {
  reads: readonly string[];
  writes: readonly string[];
  costClass?: 'interactive' | 'foreground' | 'background';
  deadlineAt?: number;
  cancelMode?: 'cooperative' | 'process' | 'none';
}

export interface ScheduledToolJob<T = unknown> {
  id: string;
  dependsOn?: readonly string[];
  effect: ToolEffect;
  run: (signal: AbortSignal | undefined) => Promise<T> | T;
}

export type ScheduledToolResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message?: string };

export interface ToolScheduleOutcome<T> {
  results: Array<ScheduledToolResult<T> | undefined>;
  notificationErrors: string[];
  maxActive: number;
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((item) => item === '*' || right.includes('*') || right.includes(item));
}

export function effectsConflict(a: ToolEffect, b: ToolEffect): boolean {
  return overlaps(a.writes, [...b.reads, ...b.writes]) || overlaps(b.writes, [...a.reads, ...a.writes]);
}

function assertUniqueIds<T>(jobs: readonly ScheduledToolJob<T>[]): Map<string, number> {
  const ids = new Map<string, number>();
  jobs.forEach((job, index) => {
    if (!job.id || ids.has(job.id)) throw new Error('DUPLICATE_CALL_ID');
    ids.set(job.id, index);
  });
  return ids;
}

function validateGraph<T>(jobs: readonly ScheduledToolJob<T>[], ids: Map<string, number>): Set<number>[] {
  if (jobs.length > 32) throw new Error('TOOL_BATCH_TOO_LARGE');
  const deps = jobs.map((job, index) => {
    const result = new Set((job.dependsOn ?? []).map((id) => {
      const dep = ids.get(id);
      if (dep === undefined) throw new Error('DEPENDENCY_UNKNOWN');
      return dep;
    }));
    for (let previous = 0; previous < index; previous += 1) {
      if (effectsConflict(jobs[previous]!.effect, job.effect)) result.add(previous);
    }
    return result;
  });
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visiting.has(index)) throw new Error('DEPENDENCY_CYCLE');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of deps[index]!) visit(dependency);
    visiting.delete(index);
    visited.add(index);
  };
  jobs.forEach((_, index) => visit(index));
  return deps;
}

/** Run one model turn's jobs while retaining emission order and real active slots. */
export async function runScheduledTools<T>(
  jobs: readonly ScheduledToolJob<T>[],
  options: { concurrency?: number; signal?: AbortSignal; onEnd?: (event: { id: string; index: number; result: ScheduledToolResult<T> }) => void } = {}
): Promise<ToolScheduleOutcome<T>> {
  const concurrency = Math.max(1, Math.min(8, Math.trunc(options.concurrency ?? 4)));
  const ids = assertUniqueIds(jobs);
  const deps = validateGraph(jobs, ids);
  const pending = new Set(jobs.map((_, index) => index));
  const results: Array<ScheduledToolResult<T> | undefined> = new Array(jobs.length);
  const active = new Map<number, Promise<void>>();
  const notificationErrors: string[] = [];
  let maxActive = 0;
  const settle = (index: number, result: ScheduledToolResult<T>): void => {
    results[index] = result;
    try { options.onEnd?.({ id: jobs[index]!.id, index, result }); } catch (error) { notificationErrors.push(String(error)); }
  };
  const start = (index: number): void => {
    const job = jobs[index]!;
    pending.delete(index);
    const promise = Promise.resolve().then(async () => {
      if (job.effect.deadlineAt !== undefined && Date.now() >= job.effect.deadlineAt) {
        settle(index, { ok: false, code: 'DEADLINE_BEFORE_START' });
        return;
      }
      try {
        const value = await job.run(options.signal);
        if (!value || typeof value !== 'object' || !('ok' in (value as object))) {
          settle(index, { ok: true, value });
        } else {
          const toolResult = value as T & { ok?: unknown };
          // The scheduler only treats an explicitly boolean ok as a tool envelope;
          // payloads with an unrelated `ok` field remain successful values.
          if (typeof toolResult.ok === 'boolean') settle(index, toolResult.ok ? { ok: true, value } : { ok: false, code: 'TOOL_RETURNED_FALSE', message: '工具返回 ok:false。' });
          else settle(index, { ok: true, value });
        }
      } catch (error) {
        settle(index, { ok: false, code: (error as { code?: string })?.code ?? 'TOOL_THROWN', message: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => { active.delete(index); });
    active.set(index, promise);
    maxActive = Math.max(maxActive, active.size);
  };
  while (pending.size > 0 || active.size > 0) {
    if (options.signal?.aborted) {
      for (const index of [...pending]) {
        pending.delete(index);
        settle(index, { ok: false, code: 'CANCELLED_BEFORE_START' });
      }
    }
    for (const index of [...pending]) {
      if (active.size >= concurrency) break;
      const dependencyResults = [...deps[index]!].map((dependency) => results[dependency]);
      if (dependencyResults.some((result) => result === undefined)) continue;
      const explicit = new Set(jobs[index]!.dependsOn ?? []);
      if ([...explicit].some((id) => results[ids.get(id)!]?.ok === false)) {
        pending.delete(index);
        settle(index, { ok: false, code: 'DEPENDENCY_FAILED' });
        continue;
      }
      start(index);
    }
    if (active.size > 0) await Promise.race(active.values());
    else if (pending.size > 0) throw new Error('SCHEDULER_STUCK');
  }
  return { results, notificationErrors, maxActive };
}

export function effectForTool(name: string, input: unknown): ToolEffect {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const resource = typeof record.sourceUri === 'string' ? record.sourceUri : typeof record.filePath === 'string' ? record.filePath : name;
  const write = /^(commit|mutate|apply|rollback|write|import|delete|remove|batch_transform)/i.test(name);
  return write ? { reads: [resource], writes: [resource], costClass: 'foreground', cancelMode: 'cooperative' }
    : { reads: [resource], writes: [], costClass: 'interactive', cancelMode: 'cooperative' };
}
