import type { SoulForgeApi } from '../../preload/index';

declare global {
  interface Window {
    /** Electron preload 注入的桥接；普通浏览器预览中不存在，必须经 runtime 边界收窄。 */
    soulforge?: SoulForgeApi;
  }
}

export {};
