/** T11-D 批量调用：有序、依赖失败跳过、逐项结果；不是跨资源全局事务。 */
export interface BatchItem {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  dependsOn?: string[];
}

export type BatchItemStatus = 'success' | 'failed' | 'skipped_dependency';
export interface BatchItemResult {
  id: string;
  status: BatchItemStatus;
  result?: unknown;
  error?: string;
}

export interface BatchOutcome {
  results: BatchItemResult[];
  succeeded: number;
  failed: number;
  skipped: number;
}

export function validateBatch(items: BatchItem[]): void {
  if (items.length === 0 || items.length > 128) throw new Error('CLI_BATCH_SIZE_INVALID');
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) throw new Error('CLI_BATCH_ID_DUPLICATE');
  const seen = new Set<string>();
  for (const item of items) {
    for (const dep of item.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`CLI_BATCH_UNKNOWN_DEP:${dep}`);
      if (!seen.has(dep)) throw new Error(`CLI_BATCH_DEP_ORDER:${item.id}->${dep}`);
    }
    seen.add(item.id);
  }
}

export async function executeBatch(
  items: BatchItem[],
  call: (item: BatchItem) => Promise<unknown>,
  options: { continueOnError?: boolean } = {}
): Promise<BatchOutcome> {
  validateBatch(items);
  const byId = new Map<string, BatchItemResult>();
  const results: BatchItemResult[] = [];
  let failed = 0;
  let skipped = 0;
  for (const item of items) {
    const depFailed = (item.dependsOn ?? []).some((dep) => byId.get(dep)?.status !== 'success');
    if (depFailed) {
      skipped += 1;
      const result: BatchItemResult = { id: item.id, status: 'skipped_dependency' };
      byId.set(item.id, result);
      results.push(result);
      continue;
    }
    try {
      const result = await call(item);
      const ok: BatchItemResult = { id: item.id, status: 'success', result };
      byId.set(item.id, ok);
      results.push(ok);
    } catch (error) {
      failed += 1;
      const failure: BatchItemResult = { id: item.id, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      byId.set(item.id, failure);
      results.push(failure);
      if (!options.continueOnError) {
        // 遇错停止：剩余依赖项全部记为 skipped_dependency。
        const remaining = items.slice(items.indexOf(item) + 1);
        for (const rest of remaining) {
          skipped += 1;
          const skippedResult: BatchItemResult = { id: rest.id, status: 'skipped_dependency' };
          byId.set(rest.id, skippedResult);
          results.push(skippedResult);
        }
        break;
      }
    }
  }
  return { results, succeeded: results.length - failed - skipped, failed, skipped };
}

