import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { disposeBridgeDaemonPool } from '@soulforge/core';
import { disposeOperationLogUtility, registerIpcHandlers } from './ipc.js';
import { disposeRuntimeIpc, registerRuntimeIpcHandlers } from './runtimeIpc.js';

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
  registerRuntimeIpcHandlers(mainWindow.webContents, rendererDocumentUrl);

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
  void disposeRuntimeIpc()
    .catch((error) => {
      process.stderr.write(`[SoulForge runtime shutdown] ${String(error)}\n`);
    })
    .then(() => Promise.allSettled([
      disposeBridgeDaemonPool(),
      disposeOperationLogUtility()
    ]))
    .finally(() => app.quit());
});
