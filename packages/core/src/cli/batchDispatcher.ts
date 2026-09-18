/**
 * Ordered batch dispatcher for CLI session host.
 * Structural validation first; dependency failures skip dependents without calling writers.
 */
export interface BatchItem {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  dependsOn?: string[];
}

export type BatchItemOutcome =
  | { id: string; status: 'ok'; result: unknown }
  | { id: string; status: 'failed'; error: { code: string; message: string } }
  | { id: string; status: 'skipped_dependency'; error: { code: string; message: string } }
  | { id: string; status: 'committed_unverified'; result: unknown };

export interface BatchDispatchResult {
  ok: boolean;
  items: BatchItemOutcome[];
  summary: {
    success: number;
    failed: number;
    skipped: number;
    committed: number;
    rolledBack: number;
  };
}

export interface BatchExecutePort {
  execute(tool: string, args: Record<string, unknown>): Promise<{
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
    lifecycle?: { state?: string; transaction?: string };
  }>;
}

export function validateBatchFile(raw: unknown): { ok: true; items: BatchItem[] } | { ok: false; code: string; message: string } {
  if (!Array.isArray(raw)) return { ok: false, code: 'CLI_BATCH_NOT_ARRAY', message: 'batch 文件必须是 JSON 数组。' };
  if (raw.length > 128) return { ok: false, code: 'CLI_BATCH_TOO_LARGE', message: 'batch 最多 128 项。' };
  const items: BatchItem[] = [];
  const ids = new Set<string>();
  for (const piece of raw) {
    if (typeof piece !== 'object' || piece === null) {
      return { ok: false, code: 'CLI_BATCH_ITEM_INVALID', message: 'batch 项必须是对象。' };
    }
    const record = piece as Record<string, unknown>;
    const id = record.id;
    const tool = record.tool;
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, code: 'CLI_BATCH_ID_REQUIRED', message: 'batch 项缺少 id。' };
    }
    if (ids.has(id)) return { ok: false, code: 'CLI_BATCH_ID_DUPLICATE', message: `重复 id：${id}` };
    if (typeof tool !== 'string' || tool.trim() === '') {
      return { ok: false, code: 'CLI_BATCH_TOOL_REQUIRED', message: `batch 项 ${id} 缺少 tool。` };
    }
    const args = record.args === undefined || record.args === null ? {} : record.args;
    if (typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, code: 'CLI_BATCH_ARGS_INVALID', message: `batch 项 ${id} 的 args 必须是对象。` };
    }
    const dependsOn = record.dependsOn;
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) {
        return { ok: false, code: 'CLI_BATCH_DEPENDS_INVALID', message: `batch 项 ${id} 的 dependsOn 非法。` };
      }
    }
    ids.add(id);
    items.push({
      id,
      tool,
      args: args as Record<string, unknown>,
      ...(Array.isArray(dependsOn) ? { dependsOn: dependsOn as string[] } : {})
    });
  }
  // Dependencies must point to earlier items only (acyclic by construction).
  const seen = new Set<string>();
  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      if (!seen.has(dep)) {
        return {
          ok: false,
          code: 'CLI_BATCH_DEPENDENCY_FORWARD',
          message: `batch 项 ${item.id} 依赖尚未出现的 ${dep}；依赖只允许指向数组中更早的项。`
        };
      }
    }
    seen.add(item.id);
  }
  return { ok: true, items };
}

export async function dispatchBatch(input: {
  items: BatchItem[];
  continueOnError?: boolean;
  port: BatchExecutePort;
  /** Emit each line after the item completes, before dependents run. */
  onItem?: (outcome: BatchItemOutcome) => void;
}): Promise<BatchDispatchResult> {
  const outcomes: BatchItemOutcome[] = [];
  const failedIds = new Set<string>();
  const okIds = new Set<string>();
  let stop = false;

  for (const item of input.items) {
    if (stop) {
      const skipped: BatchItemOutcome = {
        id: item.id,
        status: 'skipped_dependency',
        error: { code: 'CLI_BATCH_STOPPED', message: '前序失败后整批停止。' }
      };
      outcomes.push(skipped);
      input.onItem?.(skipped);
      continue;
    }

    const deps = item.dependsOn ?? [];
    const broken = deps.find((dep) => failedIds.has(dep) || !okIds.has(dep) && outcomes.some((o) => o.id === dep && o.status !== 'ok'));
    if (broken !== undefined || deps.some((dep) => failedIds.has(dep))) {
      const dep = deps.find((d) => failedIds.has(d) || outcomes.some((o) => o.id === d && o.status !== 'ok')) ?? broken ?? deps[0]!;
      const skipped: BatchItemOutcome = {
        id: item.id,
        status: 'skipped_dependency',
        error: { code: 'CLI_BATCH_DEPENDENCY_FAILED', message: `依赖项 ${dep} 未成功。` }
      };
      outcomes.push(skipped);
      input.onItem?.(skipped);
      continue;
    }

    const result = await input.port.execute(item.tool, item.args);
    let outcome: BatchItemOutcome;
    if (result.ok) {
      const lifecycleState = result.lifecycle?.state;
      if (lifecycleState === 'verification_failed') {
        outcome = { id: item.id, status: 'committed_unverified', result: result.data };
        failedIds.add(item.id);
        if (!input.continueOnError) stop = true;
      } else {
        outcome = { id: item.id, status: 'ok', result: result.data };
        okIds.add(item.id);
      }
    } else {
      outcome = {
        id: item.id,
        status: 'failed',
        error: {
          code: result.error?.code ?? 'CLI_BATCH_ITEM_FAILED',
          message: result.error?.message ?? 'batch item failed'
        }
      };
      failedIds.add(item.id);
      if (!input.continueOnError) stop = true;
    }
    outcomes.push(outcome);
    input.onItem?.(outcome);
  }

  const summary = {
    success: outcomes.filter((o) => o.status === 'ok').length,
    failed: outcomes.filter((o) => o.status === 'failed' || o.status === 'committed_unverified').length,
    skipped: outcomes.filter((o) => o.status === 'skipped_dependency').length,
    committed: outcomes.filter((o) => o.status === 'ok' || o.status === 'committed_unverified').length,
    rolledBack: 0
  };
  return { ok: summary.failed === 0, items: outcomes, summary };
}

/**
 * Human-readable batch summary for CLI stdout.
 * Never prints tokens or credentials — only ids, statuses and error codes.
 */
export function formatBatchSummary(result: BatchDispatchResult): string {
  const lines = [
    `batch ok=${result.ok ? 'true' : 'false'}`,
    `success=${result.summary.success} failed=${result.summary.failed} skipped=${result.summary.skipped} committed=${result.summary.committed} rolledBack=${result.summary.rolledBack}`
  ];
  for (const item of result.items) {
    const errorPart = item.status === 'ok' || item.status === 'committed_unverified'
      ? ''
      : ` ${item.error.code}`;
    lines.push(`- ${item.id}: ${item.status}${errorPart}`);
  }
  return lines.join('\n');
}
