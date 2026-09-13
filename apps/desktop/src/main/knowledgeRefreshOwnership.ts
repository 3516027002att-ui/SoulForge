import type { Diagnostic } from '@soulforge/shared';

/**
 * 统一 Patch Engine 提交后的 knowledge-refresh 归属。
 *
 * `port` 是默认路径：提交成功后由 commit port 刷新一次；`caller` 只给必须
 * 先清理域缓存/预览的 handler 使用，刷新责任随提交结果返回给调用方。
 * 刷新失败不得把已经提交的写入变成普通提交失败，也不得触发重试。
 */
export type KnowledgeRefreshOwner = 'port' | 'caller';

export interface KnowledgeCommitResult {
  ok: boolean;
}

export function appendPostCommitFailureDiagnostic(
  result: { diagnostics: Diagnostic[] },
  code: string,
  sourceUri: string,
  error: unknown,
  message = '写入已提交，但提交后的刷新失败；已保留已提交结果。'
): void {
  result.diagnostics.push({
    severity: 'warning',
    code,
    message,
    sourceUri,
    details: error instanceof Error
      ? { name: error.name, message: error.message }
      : { value: String(error) }
  });
}

export interface CallerOwnedPostCommitHooks<T extends KnowledgeCommitResult> {
  /** Invalidate domain caches and/or rebuild the post-commit preview. */
  prepare: () => void | Promise<void>;
  /** The one knowledge refresh owned by the domain handler. */
  refresh: (result: T) => Promise<unknown>;
  onPrepareError?: (result: T, error: unknown) => void;
  onRefreshError?: (result: T, error: unknown) => void;
}

/**
 * Run the caller-owned post-commit sequence exactly once.
 *
 * The committed result is the boundary: failed/cancelled results do not run
 * any post-commit callback; a projection or refresh failure is reported to the
 * caller hooks without changing `result.ok` or retrying the refresh.
 */
export async function runCallerOwnedPostCommit<T extends KnowledgeCommitResult>(
  result: T,
  hooks: CallerOwnedPostCommitHooks<T>
): Promise<T> {
  if (!result.ok) return result;
  try {
    await hooks.prepare();
  } catch (error) {
    hooks.onPrepareError?.(result, error);
  }
  try {
    await hooks.refresh(result);
  } catch (error) {
    hooks.onRefreshError?.(result, error);
  }
  return result;
}

export async function commitWithKnowledgeRefresh<T extends KnowledgeCommitResult>(
  commit: () => Promise<T>,
  owner: KnowledgeRefreshOwner,
  refresh: (result: T) => Promise<unknown>,
  onRefreshError?: (result: T, error: unknown) => void
): Promise<T> {
  const result = await commit();
  if (result.ok && owner === 'port') {
    try {
      await refresh(result);
    } catch (error) {
      // The production refresh boundary returns a failed status. Keep this
      // guard for alternate/test adapters: the Patch Engine result is already
      // committed, so it must remain the returned result and must not retry.
      onRefreshError?.(result, error);
    }
  }
  return result;
}
