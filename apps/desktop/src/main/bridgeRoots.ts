/**
 * ROOT-07：Bridge allowed-root 生命周期（front-end.md §13.2 / §18.11）。
 *
 * Bridge 收到的每个 allowed root 必须在调用前存在且经过 main 验证。只读调用
 * 只传真实存在的 overlay/base roots；不得为方便统一附加一个尚不存在的
 * staging 目录——那正是 Bridge 报 `Every allowed root must be an existing
 * directory.` 的根因之一。
 *
 * 需要 staging 的调用顺序固定为（§13.2）：
 *
 * ```text
 * mkdir recursive
 * → realpath
 * → verify main-owned workspace storage boundary
 * → register allowed root
 * → Bridge open/extract/write
 * ```
 *
 * 本 helper 由所有 Bridge production handler 复用（§18.11「不得只修一个
 * PARAM handler」）。`'read'` 不创建任何目录；`'stage'` 幂等——staging
 * 已存在时重复调用只做验证，不重建。
 *
 * 本文件不依赖 Electron（storageRoot 由调用方显式传入），以便
 * scripts/verify-bridge-roots-gate.mjs 用真实文件系统直接运行期验证。
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyPathInsideRoot } from '@soulforge/core';

export interface BridgeRootSession {
  /** Mod 工作区 overlay 根（必须存在）。 */
  readonly overlayRoot: string;
  /** 原版 base 根（可选；存在才加入 allowed roots）。 */
  readonly baseRoot: string | null;
  /** main 拥有的 workspace storage 根（staging 的边界；staging 是其子目录）。 */
  readonly storageRoot: string;
}

export type BridgeRootOperation = 'read' | 'stage';

export type PrepareBridgeRootsResult =
  | { ok: true; allowedRoots: readonly string[]; writableRoots: readonly string[] }
  | {
      ok: false;
      code: 'root-missing' | 'staging-creation-failed' | 'staging-boundary-escape';
      message: string;
      details: unknown;
    };

export async function prepareBridgeRoots(
  session: BridgeRootSession,
  operation: BridgeRootOperation
): Promise<PrepareBridgeRootsResult> {
  const readRoots = [
    session.overlayRoot,
    ...(session.baseRoot ? [session.baseRoot] : [])
  ];
  const missing = readRoots.filter((root) => !existsSync(root));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'root-missing',
      message: `允许根目录不存在：${missing.join('、')}`,
      details: { missing }
    };
  }

  if (operation === 'read') {
    // 只读调用：只返回已存在并 verified 的 roots，绝不创建目录、绝不含 staging。
    return { ok: true, allowedRoots: readRoots, writableRoots: [] };
  }

  const stagingRoot = join(session.storageRoot, 'staging');
  try {
    await mkdir(session.storageRoot, { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      code: 'staging-creation-failed',
      message: `无法创建安全暂存目录：${errorMessage(error)}`,
      details: { errorName: error instanceof Error ? error.name : undefined }
    };
  }

  // realpath + reparse-point 检查：staging 不得经符号链接/联接点逃出
  // main 拥有的 workspace storage 边界。
  const boundary = await verifyPathInsideRoot(session.storageRoot, stagingRoot);
  if (!boundary.ok) {
    return {
      ok: false,
      code: 'staging-boundary-escape',
      message: '暂存目录经过指向边界之外的链接或联接点，已拒绝注册。',
      details: boundary.diagnostics[0]?.details ?? null
    };
  }

  return {
    ok: true,
    allowedRoots: [...readRoots, stagingRoot],
    writableRoots: [stagingRoot]
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
