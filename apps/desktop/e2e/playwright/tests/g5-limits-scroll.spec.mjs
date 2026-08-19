/**
 * 问题 5（面板组线）：长列表取消条数上限后必须能滚到最后一条。
 *
 * 只覆盖本线站点：ESD 状态组表（旧上限 200）。用 SF_TEST_LARGE_ESD=1 让
 * fixture 把 m10.esd 扩为 260 个状态组（见 fixture-main.mjs），在真 Electron
 * 里断言：
 * 1. 全量渲染：最后一个状态组（状态组 259）直接出现在 DOM，
 *    旧 slice(0, 200) 会砍到 199，这条必红；
 * 2. 没有 `esd-truncation` 截断说明 testid；
 * 3. 栏身体（.workbench__column-body）scrollHeight 远大于 clientHeight，
 *    且可滚动到最后一条并可见。
 *
 * 为什么是 ESD：它是本线站点里唯一在纯 DOM 层全量 map、且视觉行稳定
 * （每条状态组成员一行「状态组 N」）的面板；FLVER/VFX 依赖 WebGL viewer，
 * TPF/GPARAM 打开路径更重。ESD 一个长列表滚到底足以证明「数据一次在手、
 * array.map 全量进 DOM、栏自身滚动」的共性判据。
 *
 * 用户数据目录：默认 %APPDATA%/@soulforge/desktop 会残留上次 e2e 的会话
 * （恢复进上次打开的工作台，open-workspace 按钮不可达），这里用临时 userDataDir
 * 隔离——与 production-main 互不干扰，也不污染共享数据目录。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureMain = path.resolve(here, '../fixture-main.mjs');
const outRenderer = path.resolve(here, '../../../out/renderer/index.html');
const hasBuild = fs.existsSync(outRenderer);

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  test.skip(!hasBuild, 'renderer 未构建：先运行 npm run build -w @soulforge/desktop');
});

async function launchApp() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-g5-limits-ud-'));
  const app = await electron.launch({
    args: [fixtureMain],
    env: { ...process.env, SF_TEST_LARGE_ESD: '1' },
    userDataDir
  });
  const window = await app.firstWindow();
  window.on('dialog', (dialog) => {
    dialog.accept().catch(() => undefined);
  });
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

async function closeAgentPanel(window) {
  const close = window.getByRole('button', { name: '关闭 Agent 面板' });
  if (await close.isVisible().catch(() => false)) {
    await close.click();
  }
}

async function openWorkspace(window) {
  await closeAgentPanel(window);
  await window.getByRole('region', { name: '开始' }).getByTestId('open-workspace').click();
  await expect(window.locator('.project-overview h1')).toHaveText('fixture-workspace');
  await expect(window.locator('.welcome__stats')).toContainText('已解析');
}

test('ESD 长列表：260 个状态组全量渲染，栏可滚到最后一条，无截断说明', async () => {
  const { app, window } = await launchApp();
  await openWorkspace(window);

  await closeAgentPanel(window);
  await window.locator('.file-item', { hasText: 'ai/m10.esd' }).click();
  await expect(window.getByLabel('Behavior 工作台')).toBeVisible();

  const left = window.getByRole('region', { name: 'Files / Machines / States' });
  const body = left.locator('.workbench__column-body');

  // 1) 无截断说明。
  await expect(left.locator('[data-testid="esd-truncation"]')).toHaveCount(0);

  // 2) 全量渲染：最后一条「状态组 259」在 DOM 里（旧 slice(0,200) 会砍到 199）。
  await expect(left.getByText('状态组 259')).toBeVisible();

  // 3) 栏可滚动：scrollHeight 远大于 clientHeight，且能滚到最后一条可见。
  const scrollHeight = await body.evaluate((el) => el.scrollHeight);
  const clientHeight = await body.evaluate((el) => el.clientHeight);
  expect(scrollHeight).toBeGreaterThan(clientHeight);
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(left.getByText('状态组 259')).toBeInViewport();

  await window.screenshot({ path: 'test-results/g5-limit-esd-scroll.png' });
  await app.close();
});
