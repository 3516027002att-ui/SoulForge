/**
 * 生成入库最终截图：空工作区 + 状态机写入后。
 * 运行：node e2e/playwright/capture-shots.mjs（需先 build）。
 */
import { _electron as electron } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureMain = path.resolve(here, 'fixture-main.mjs');
const shotsDir = path.resolve(here, '../../../../docs/frontend-renovation/shots');

const app = await electron.launch({ args: [fixtureMain] });
const window = await app.firstWindow();
window.on('dialog', (dialog) => {
  dialog.accept().catch(() => undefined);
});
await window.waitForLoadState('domcontentloaded');
// IDE 布局下变更队列位于暂存侧栏面板内（初始为隐藏面板），等待挂载即可。
await window.waitForSelector('.change-queue', { state: 'attached' });
await window.screenshot({ path: path.join(shotsDir, 'final-01-empty-workspace.png') });

await window.getByRole('button', { name: '打开 Mod 工作区' }).click();
await window.locator('.status-bar').waitFor({ state: 'visible' });
// Files 域物理浏览：直接定位 msgbnd 文件进入 FMG 工作台。
await window.locator('.file-item', { hasText: 'msg/test.msgbnd.dcx' }).click();
await window.getByRole('row', { name: /伤药葫芦/ }).click();
await window.locator('label', { hasText: '编辑 ID 100' }).locator('textarea').fill('伤药葫芦·改');
const queue = window.locator('.change-queue');
await queue.getByRole('button', { name: '批准入暂存' }).click();
await queue.getByTestId('cq-commit').click();
await queue.locator('.cq-row').first().waitFor();
await window.waitForSelector('.cq-row[data-status="written"]', { timeout: 15000 });
await window.screenshot({ path: path.join(shotsDir, 'final-02-change-written.png') });

await app.close();
console.log('shots written to', shotsDir);
