import type { IpcMainInvokeEvent } from 'electron';

/**
 * domain registrar 唯一可用的 handler 注册能力：已经带安全语义的受信包装
 * （组合根在 ipc.ts 内实现：注册前断言 trusted sender、返回前
 * sanitizeRendererValue）。domain 永远不持有 Electron 原始 ipcMain authority。
 */
export type TrustedIpcHandle = <Args extends unknown[], Result>(
  channel: string,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: Args
  ) => Result | Promise<Result>
) => void;
