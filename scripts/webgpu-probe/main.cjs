/**
 * 隐藏窗口里加载探测 bundle，取回结果后立刻退出。
 * 用同一份 Electron 43 二进制，所以 Chromium 版本与生产构建一致。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');

// 不碰用户正在用的 Electron 会话数据。
app.setPath('userData', path.join(os.tmpdir(), 'soulforge-webgpu-probe'));

const probeDir = __dirname;
const timeoutMs = 30000;

async function waitForResult(win) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await win.webContents.executeJavaScript(
      'globalThis.__probeResult ?? globalThis.__probeError ?? null',
      true
    );
    if (result !== null) return result;
    if (Date.now() > deadline) return { timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  await win.loadFile(path.join(probeDir, 'index.html'));
  const result = await waitForResult(win);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
