import { app, BrowserWindow, Menu } from 'electron';
import { existsSync } from 'node:fs';
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

// 忽略 stdout/stderr 管道断开（EPIPE）错误，避免终端断开或无控制台挂载时崩溃弹窗
process.stdout?.on('error', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') return;
});
process.stderr?.on('error', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') return;
});
process.on('uncaughtException', (err: Error & { code?: string }) => {
  if (err?.code === 'EPIPE' || (typeof err?.message === 'string' && err.message.includes('EPIPE'))) {
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[SoulForge main process uncaught exception]', err);
});

const here = dirname(fileURLToPath(import.meta.url));
let bridgeShutdownStarted = false;

/**
 * 与 renderer light 主题 `--canvas` / `--ink-0` 的 sRGB 近似。
 * Windows / macOS 的 titleBarOverlay 只接受 hex，不能读 CSS 变量。
 * 背景用 `#FBFBF9`（= --canvas 流光溢彩白），按钮 symbolColor 用中性深墨，
 * 与 renderer 首帧连续，避免暗色闪帧或窗口按钮区明暗割裂（§11.1）。
 */
const TITLEBAR_OVERLAY = {
  color: '#FBFBF9',
  symbolColor: '#383C42',
  height: 40
} as const;

/** 开发态使用 electron.exe 时也读取 SoulForge 图标；缺少资源时回退为 Electron 默认行为。 */
function resolveWindowIconPath(): string | undefined {
  if (process.platform === 'darwin') return undefined;
  const iconPath = join(here, '../../build/icon.ico');
  return existsSync(iconPath) ? iconPath : undefined;
}

function createWindow(): void {
  // Electron 默认挂一套 File / Edit / View / Window 菜单。Windows 上会占掉
  // 一整条系统菜单栏，叠在应用自绘 titlebar 上面。macOS 保留系统菜单，
  // 否则 Cmd+Q / 拷贝粘贴角色会一起丢掉。
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
  }

  const rendererFilePath = join(here, '../renderer/index.html');
  const developmentRendererUrl = resolveDevelopmentRendererUrl();
  const rendererDocumentUrl = developmentRendererUrl ?? pathToFileURL(rendererFilePath).href;
  // 图标可能不存在（返回 undefined）：exactOptionalPropertyTypes 下不能把
  // undefined 塞进可选属性，缺资源时整体省略，回退 Electron 默认行为。
  const windowIcon = resolveWindowIconPath();
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'SoulForge',
    ...(windowIcon ? { icon: windowIcon } : {}),
    backgroundColor: TITLEBAR_OVERLAY.color,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'linux' ? {} : { titleBarOverlay: TITLEBAR_OVERLAY }),
    webPreferences: {
      // 与 electron.vite.config.ts 的 preload 输出约定成对：产物是 CommonJS 的
      // index.cjs。两个约束共同决定了这个扩展名：
      //  · sandbox: true 的 preload 不支持 ESM（加载 .mjs 报 "Cannot use import
      //    statement outside a module"），所以必须是 CJS；
      //  · 本包 package.json 声明 "type": "module"，所以 .js 会被当 ESM 解析，
      //    CJS 内容报 "require is not defined in ES module scope"。.cjs 显式脱离。
      //
      // 三处必须同时对（这里、vite 配置的 entryFileNames、e2e fixture），否则
      // preload 静默加载失败——界面照常渲染（首屏是静态骨架），但
      // window.soulforge 不注入，所有 IPC 功能不可用，按钮全部显示
      // 「浏览器预览：仅在 SoulForge 桌面版可用」。
      preload: join(here, '../preload/index.cjs'),
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

  // 去掉默认 View 菜单后，开发态仍保留打开检查器的快捷键。
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const toggleInspector = input.key === 'F12'
        || (input.key.toLowerCase() === 'i' && input.control && input.shift);
      if (!toggleInspector) return;
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    });
  }

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

if (process.platform === 'win32') {
  app.setAppUserModelId('com.soulforge.app');
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
