/**
 * §14.1 尺寸覆盖证据：在流光溢彩白下捕获空工作区的多尺寸呈现。
 * 既有 e2e 已覆盖 653/768/1024/1440 窄窗与固定 fixture 尺寸；本脚本补齐
 * 1024 / 1440 / 1920 / 200% zoom 四档的**截图**（§14.1「尺寸至少覆盖
 * 1024px、1440px、1920px 和 200% zoom」），不重复造 demo（与 capture-shots.mjs
 * 互补，最终入库两张仍由 capture-shots.mjs 生成）。
 * 运行：node e2e/playwright/theme-capture.mjs（需先 build）。
 */
import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureMain = path.resolve(here, 'fixture-main.mjs');
const outDir = path.resolve(here, '../../../../docs/frontend-renovation/shots');

const app = await electron.launch({ args: [fixtureMain] });
const window = await app.firstWindow();
window.on('dialog', (dialog) => {
  dialog.accept().catch(() => undefined);
});
await window.waitForLoadState('domcontentloaded');
await window.waitForSelector('.change-queue', { state: 'attached' });

// 尺寸档：1024 / 1440 / 1920（全窗口尺寸，主进程设置，渲染器随内容区重排）。
for (const [width, height, label] of [[1024, 768, '1024'], [1440, 900, '1440'], [1920, 1080, '1920']]) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(size[0], size[1]);
  }, [width, height]);
  await window.waitForTimeout(400);
  await window.screenshot({ path: path.join(outDir, `size-${label}-empty-workspace.png`) });
}

// 200% zoom：回到 1280×820，放大渲染内容两倍（模拟高 DPI / 无障碍缩放）。
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1280, 820);
  win.webContents.setZoomFactor(2);
});
await window.waitForTimeout(400);
await window.screenshot({ path: path.join(outDir, 'size-200pct-zoom-empty-workspace.png') });

await app.close();
console.log('theme size shots written to', outDir);
