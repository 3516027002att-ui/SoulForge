import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { disposeBridgeDaemonPool } from '@soulforge/core';
import { disposeOperationLogUtility, registerIpcHandlers } from './ipc.js';

/**
 * 脱敏函数从 main 入口再导出一次，供安全门禁在生产构建产物上真实调用。
 *
 * 这不是为测试开的后门：它只是把一个**纯函数**变成可观测的。安全门禁此前只能
 * 断言 rendererDto 源码里含 'containsWindowsDrivePath' 这类字符串——那只证明
 * 「代码里提到过」，不证明它对真实载荷有效，改个内部实现就静默失去覆盖。
 * 导出后门禁可以直接喂真实敏感载荷、断言输出里既无敏感键也无敏感值。
 *
 * 安全性上无新增暴露面：main 侧模块导出不经 contextBridge，renderer 永远拿不到。
 */
export { sanitizeRendererValue } from './rendererDto.js';

const here = dirname(fileURLToPath(import.meta.url));
let bridgeShutdownStarted = false;

function createWindow(): void {
  const rendererFilePath = join(here, '../renderer/index.html');
  const developmentRendererUrl = resolveDevelopmentRendererUrl();
  const rendererDocumentUrl = developmentRendererUrl ?? pathToFileURL(rendererFilePath).href;
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'SoulForge',
    webPreferences: {
      preload: join(here, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  registerIpcHandlers(mainWindow.webContents, rendererDocumentUrl);

  if (developmentRendererUrl) {
    void mainWindow.loadURL(developmentRendererUrl);
  } else {
    void mainWindow.loadFile(rendererFilePath);
  }
}

function resolveDevelopmentRendererUrl(): string | null {
  const configured = process.env.ELECTRON_RENDERER_URL;
  if (!configured || app.isPackaged) return null;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('ELECTRON_RENDERER_URL_INVALID');
  }
  const isLoopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || !isLoopback
    || url.username !== ''
    || url.password !== '') {
    throw new Error('ELECTRON_RENDERER_URL_UNTRUSTED');
  }
  return url.href;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (bridgeShutdownStarted) return;
  event.preventDefault();
  bridgeShutdownStarted = true;
  void Promise.allSettled([
    disposeBridgeDaemonPool(),
    disposeOperationLogUtility()
  ]).finally(() => app.quit());
});
