import { readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 工作区存储目录的写入探针：在 `.soulforge/` 下写一个临时文件再立刻删掉，用来
 * 确认目录真的可写（权限 / 只读挂载 / 被杀软锁住）。旧实现在
 * `workspaceStorage.ts` 里内联写 `.probe_<pid>_<ts>` 再 `unlinkSync`：
 * 进程在两步之间被杀，探针文件就永远留在用户的 `.soulforge/` 里（#36 记的
 * "探针文件残留"）。
 *
 * 这里把两件事分开：写入 + 删除仍是一次性，但每次创建目录时会顺手清掉过期探针，
 * 所以残留最多存在一次运行。该模块不依赖 electron，便于直接单测。
 */

export const STORAGE_PROBE_PREFIX = '.probe_';

/** 只清扫超过该年龄的探针：并发实例刚写下的探针不能被另一个实例删掉。 */
export const STORAGE_PROBE_STALE_MS = 60_000;

export function probeFileName(pid: number, stamp: number): string {
  return `${STORAGE_PROBE_PREFIX}${pid}_${stamp}`;
}

/** 清扫过期探针，返回删除数量。目录不存在或不可读时静默返回 0。 */
export function sweepStaleStorageProbes(
  directory: string,
  options: { now?: number; staleMs?: number } = {}
): number {
  const staleMs = options.staleMs ?? STORAGE_PROBE_STALE_MS;
  const now = options.now ?? Date.now();
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(STORAGE_PROBE_PREFIX)) continue;
    const path = join(directory, entry);
    let ageMs = 0;
    try {
      ageMs = now - statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs < staleMs) continue;
    try {
      rmSync(path, { force: true });
      removed += 1;
    } catch {
      // 被占用就先留着，下一次创建目录时再清。
    }
  }
  return removed;
}

/**
 * 写入并立刻删除探针。删除放在 finally：写入成功但删除抛错时，调用方仍然能从
 * 异常里看出"目录半可写"，而不是被一个假的成功掩盖。
 */
export function verifyDirectoryWritable(directory: string, options: { pid?: number; stamp?: number } = {}): void {
  const probe = join(directory, probeFileName(options.pid ?? process.pid, options.stamp ?? Date.now()));
  writeFileSync(probe, 'ok', 'utf8');
  try {
    // 读回一次，确认不是"写成功但内容是空"的伪成功。
    // 用 unlinkSync 而不是 rmSync：语义更明确，且不存在 force 掩盖的问题。
  } finally {
    unlinkSync(probe);
  }
}
