import type { SoulForgeApi } from '../../preload/index';

declare global {
  interface Window {
    soulforge: SoulForgeApi;
  }
}

export {};
