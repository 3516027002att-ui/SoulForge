import type { SoulForgeApi } from '../../../preload/index.js';

/**
 * Renderer 运行表面：Electron 桌面由 preload 注入 window.soulforge；
 * 普通浏览器预览没有 preload，不能安全访问本机文件系统。
 * 所有 Electron-only 能力必须经此边界获取 bridge，禁止组件散落
 * `typeof window.soulforge` 判断或非空断言。
 */
export type RendererRuntime =
  | { kind: 'electron'; bridge: SoulForgeApi }
  | { kind: 'browser-preview'; bridge: null };

let cachedRuntime: RendererRuntime | null = null;

/**
 * Electron 判定必须同时确认：bridge 对象存在 + 运行所需入口方法存在。
 * 不依赖 user-agent 或 URL。
 */
export function getRendererRuntime(): RendererRuntime {
  if (cachedRuntime) return cachedRuntime;
  const candidate = window.soulforge;
  if (
    candidate
    && typeof candidate === 'object'
    && typeof candidate.openWorkspaceDialog === 'function'
    && typeof candidate.scanWorkspace === 'function'
  ) {
    cachedRuntime = { kind: 'electron', bridge: candidate };
  } else {
    cachedRuntime = { kind: 'browser-preview', bridge: null };
  }
  return cachedRuntime;
}

/** 已收窄的 bridge；browser-preview 表面恒为 null。 */
export function getRendererBridge(): SoulForgeApi | null {
  return getRendererRuntime().bridge;
}

/**
 * 单操作能力收窄：bridge 与方法均可用时返回该方法，否则返回 null。
 * 调用方必须为 null 返回结构化诊断，不得吞异常。
 */
export function getBridgeMethod<K extends keyof SoulForgeApi>(method: K): SoulForgeApi[K] | null {
  const bridge = getRendererBridge();
  if (!bridge) return null;
  const fn = bridge[method];
  return typeof fn === 'function' ? fn : null;
}

/** 能力不可用时的统一诊断文案（浏览器预览 vs preload 部分缺失）。 */
export function describeBridgeAbsence(operation: string): string {
  return getRendererRuntime().kind === 'browser-preview'
    ? `浏览器预览：「${operation}」仅在 SoulForge 桌面版可用`
    : `无法执行「${operation}」：桌面桥接能力缺失`;
}
