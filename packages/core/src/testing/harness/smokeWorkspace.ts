/**
 * Smoke 临时工作区 harness。
 *
 * 存在理由是实测出来的，不是风格偏好：92 个 smoke 里 57 个用 mkdtemp 建临时
 * 工作区，其中 22 个从不清理。本机系统临时目录因此累积了 25724 个残留
 * `soulforge-*` 目录（3.8 GB）。每个 smoke 各写一遍 setup/teardown 的代价，
 * 就是有 22 处忘了写 teardown——而忘记清理不会让任何断言失败，所以不会被发现。
 *
 * 这里只做一件事：把「建临时目录 → 用 → 保证删掉」变成一次调用。
 *
 * 刻意不做的事：
 *  - 不封装断言。断言语义因 smoke 而异，统一抽象只会催生「参数化到看不懂」。
 *  - 不封装输出格式。ok/skipped/partial/candidate 的判定是各 smoke 的诚实边界，
 *    抽象掉就会诱发「统一报 ok」这种最坏结果。
 *  - 不吞异常。withSmokeWorkspace 原样重抛，只保证清理发生。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 临时工作区句柄。root 之外不承诺任何结构，由各 smoke 自行组织。 */
export interface SmokeWorkspace {
  /** 本次运行独占的临时目录绝对路径。 */
  root: string;
  /** 释放。幂等：重复调用、目录已删都不报错。 */
  dispose(): Promise<void>;
}

/**
 * 建一个独占临时工作区。
 *
 * `label` 只用于目录名前缀，便于在残留物里回溯来源；必须是文件名安全的短标识。
 */
export async function createSmokeWorkspace(label: string): Promise<SmokeWorkspace> {
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '-');
  if (safeLabel.length === 0) {
    throw new Error('SMOKE_WORKSPACE_LABEL_EMPTY: label 至少需要一个文件名安全字符。');
  }
  const root = await mkdtemp(join(tmpdir(), `soulforge-${safeLabel}-`));
  return {
    root,
    dispose: () => rm(root, { recursive: true, force: true })
  };
}

/**
 * 在独占临时工作区里跑一段逻辑，无论成功、抛错还是被拒绝都保证清理。
 *
 * 返回 body 的返回值，异常原样重抛——清理不得改变失败语义，否则会把真实失败
 * 变成「清理时的次生错误」，定位成本远高于泄漏。
 */
export async function withSmokeWorkspace<T>(
  label: string,
  body: (workspace: SmokeWorkspace) => Promise<T>
): Promise<T> {
  const workspace = await createSmokeWorkspace(label);
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}
