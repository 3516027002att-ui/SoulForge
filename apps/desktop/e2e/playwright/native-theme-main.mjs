// Observe the real registered receiver in main only. Renderer capabilities and
// production security preferences remain those of production-main.mjs.
import { ipcMain, BrowserWindow } from 'electron';
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (channel === 'window.setThemeMode') global.__nativeThemeReceiver = listener;
  register(channel, listener);
};
global.__nativeThemeOverlays = [];
const setOverlay = BrowserWindow.prototype.setTitleBarOverlay;
if (typeof setOverlay === 'function') {
  BrowserWindow.prototype.setTitleBarOverlay = function (options) {
    global.__nativeThemeOverlays.push({ windowId: this.id, options });
    return setOverlay.call(this, options);
  };
}
await import('./production-main.mjs');
