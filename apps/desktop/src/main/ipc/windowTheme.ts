import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { TrustedIpcHandle } from './registration.js';

export type NativeWindowThemeMode = 'opal' | 'obsidian';
export type NativeWindowThemeResult =
  | { ok: true }
  | { ok: false; code: 'WINDOW_THEME_MODE_INVALID' | 'WINDOW_THEME_WINDOW_UNAVAILABLE' | 'WINDOW_THEME_APPLY_FAILED' | 'WINDOW_THEME_OVERLAY_UNAVAILABLE' };

// Opal retains the existing native frame tokens. Obsidian is the sRGB
// conversion of existing --canvas (0.098/0.012/236) and --ink-0 (0.92/0.012/218).
const NATIVE_THEME_COLORS = {
  opal: { color: '#FBFBF9', symbolColor: '#383C42', height: 40 },
  obsidian: { color: '#010306', symbolColor: '#DCE7EA', height: 40 }
} as const;

type ThemeWindow = Pick<BrowserWindow, 'isDestroyed' | 'setBackgroundColor' | 'setTitleBarOverlay'>;
export function registerWindowThemeIpcHandlers(deps: {
  handle: TrustedIpcHandle;
  windowForSender: (event: IpcMainInvokeEvent) => ThemeWindow | null;
  platform: NodeJS.Platform;
}): void {
  deps.handle('window.setThemeMode', (event, mode: unknown): NativeWindowThemeResult => {
    if (mode !== 'opal' && mode !== 'obsidian') return { ok: false, code: 'WINDOW_THEME_MODE_INVALID' };
    const window = deps.windowForSender(event);
    if (!window || window.isDestroyed()) return { ok: false, code: 'WINDOW_THEME_WINDOW_UNAVAILABLE' };
    const colors = NATIVE_THEME_COLORS[mode];
    try {
      window.setBackgroundColor(colors.color);
      if (deps.platform === 'win32') {
        try { window.setTitleBarOverlay(colors); }
        catch { return { ok: false, code: 'WINDOW_THEME_OVERLAY_UNAVAILABLE' }; }
      }
      return { ok: true };
    } catch { return { ok: false, code: 'WINDOW_THEME_APPLY_FAILED' }; }
  });
}
