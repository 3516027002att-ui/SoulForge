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
await window.waitForSelector('.change-queue');
await window.screenshot({ path: path.join(shotsDir, 'final-01-empty-workspace.png') });

await window.getByRole('button', { name: '打开 Mod 工作区' }).click();
await window.locator('.file-item', { hasText: 'msg/test.msgbnd.dcx' }).click();
await window.getByRole('button', { name: /FMG 文本/ }).click();
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
