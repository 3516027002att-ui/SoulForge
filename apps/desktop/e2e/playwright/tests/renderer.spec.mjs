/**
 * Renderer 端到端：真实 Electron + 生产 preload + 构建产物 + 合成 fixture。
 * 覆盖（docs/frontend-renovation/browser-feedback-spec.md §11）：
 * - 顶部资源目录栏：目录导航、单行窄屏滚动、unknown 独立计数、无格式名文案；
 * - ai 资源目录与 Agent 面板 ID 不冲突；BND 上下文自动进入容器工作台；
 * - 变更状态机候选→批准→暂存→校验→写入、写入失败诊断；
 * - 设置页与 Agent 面板控件归属、折叠保持、权限锁定原因；
 * - Electron workspace.openDialog 调用与用户取消路径；
 * - 无 preload 的 browser-preview 表面：可见降级、无 pageerror/console error；
 * - 键盘导航（方向键/Home/End/Enter/Escape）与焦点可见性；
 * - 顶部资源栏与工具按钮四态（rest/hover/active/focus-visible）截图与阴影断言；
 * - 暗/亮主题代表性按钮 computed background/box-shadow/outline 防 token 串用。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureMain = path.resolve(here, '../fixture-main.mjs');
const outRenderer = path.resolve(here, '../../../out/renderer/index.html');
const hasBuild = fs.existsSync(outRenderer);

test.describe.configure({ mode: 'serial' });

test.beforeEach(({ }, testInfo) => {
  test.skip(!hasBuild, 'renderer 未构建：先运行 npm run build -w @soulforge/desktop');
  void testInfo;
});

async function launchApp(env = {}) {
  const app = await electron.launch({
    args: [fixtureMain],
    env: { ...process.env, ...env }
  });
  const window = await app.firstWindow();
  const pageErrors = [];
  const consoleErrors = [];
  window.on('pageerror', (error) => pageErrors.push(String(error)));
  window.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  // 关闭确认（beforeunload/confirm）属于产品行为：测试统一接受。
  window.on('dialog', (dialog) => {
    dialog.accept().catch(() => undefined);
  });
  await window.waitForLoadState('domcontentloaded');
  return { app, window, pageErrors, consoleErrors };
}

/** 显示窗口：隐藏窗口下 Chromium 节流 BeginFrame，过渡/动画冻结会影响四态断言。 */
async function showWindow(app) {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.show();
  });
}

async function ipcCalls(app) {
  return app.evaluate(() => global.__fixtureIpcCalls ?? {});
}

async function openFixtureWorkspace(window) {
  await window.getByRole('button', { name: '打开 Mod 工作区' }).click();
  await expect(window.locator('.status-bar')).toContainText('已索引');
}

test('空工作区：无演示数据，变更队列为空态', async () => {
  const { app, window } = await launchApp();
  await expect(window.locator('.change-queue')).toContainText('没有候选变更');
  const bodyText = await window.locator('body').innerText();
  expect(bodyText).not.toContain('DEMO_');
  expect(bodyText).not.toContain('demo-job');
  expect(bodyText).not.toContain('file://param/demo.param');
  await window.screenshot({ path: 'test-results/01-empty-workspace.png' });
  await app.close();
});

test('顶部资源栏：目录原名、固定顺序、无格式名文案，目录切换过滤资源', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 左侧不再有 .mode-tabs；顶部资源栏存在且为 tablist。
  await expect(window.locator('.mode-tabs')).toHaveCount(0);
  const tabs = window.locator('[data-testid="resource-bar"] [role="tab"]');
  await expect(tabs).toHaveCount(13);
  await expect(tabs).toHaveText([
    /all/, /event/, /map/, /param/, /msg/, /menu/, /script/,
    /action/, /ai/, /chr/, /obj/, /sfx/, /other/
  ]);

  // 页面不出现中文格式解释文案（目录栏只用目录原名）。
  const bodyText = await window.locator('body').innerText();
  expect(bodyText).not.toContain('SFX 特效');
  expect(bodyText).not.toContain('EMEVD 事件');
  expect(bodyText).not.toContain('角色资源');

  // unknown 不合并进 other：独立警告计数。
  await expect(window.locator('.resource-bar__unknown')).toContainText('unknown 1');

  // 点击 sfx：只显示 resourceKind='sfx' 的资源。
  await window.locator('[data-resource-mode="sfx"]').click();
  const files = window.locator('.file-item');
  await expect(files).toHaveCount(1);
  await expect(files.first()).toContainText('sfx/f0000.sfxbnd.dcx');
  await expect(window.locator('.status-bar')).toContainText('sfx');

  // 点击 event：只显示 event/ 资源。
  await window.locator('[data-resource-mode="event"]').click();
  await expect(window.locator('.file-item')).toHaveCount(1);
  await expect(window.locator('.file-item').first()).toContainText('event/common.emevd');

  await window.screenshot({ path: 'test-results/04-resource-bar.png' });
  await app.close();
});

test('ai 目录筛选真实 ai/ 资源，不与 Agent 面板冲突', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  await window.locator('[data-resource-mode="ai"]').click();
  const files = window.locator('.file-item');
  await expect(files).toHaveCount(1);
  await expect(files.first()).toContainText('ai/m10.aibnd.dcx');

  // Agent 面板仍是独立右侧面板（输入区与配置存在），中央没有占用 ai 的 Agent 页面。
  await expect(window.locator('.agent__composer textarea')).toBeVisible();
  await expect(window.locator('#agent-provider')).toBeVisible();
  await expect(window.locator('.status-bar')).toContainText('ai');
  await app.close();
});

test('BND 外形文件自动进入容器工作台；命令面板可强制以 BND4 打开', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 选择真实 BND 外形文件 → 自动进入容器工作台。
  await window.locator('[data-resource-mode="chr"]').click();
  await window.locator('.file-item', { hasText: 'chr/sample.chrbnd.dcx' }).click();
  await expect(window.getByRole('region', { name: 'BND4 容器工作台' })).toBeVisible();

  // 非容器文件 + 命令面板「以 BND4 容器打开当前选择」。
  await window.locator('[data-resource-mode="other"]').click();
  await window.locator('.file-item', { hasText: 'other/notes.txt' }).click();
  await expect(window.getByRole('region', { name: 'BND4 容器工作台' })).toHaveCount(0);
  await window.keyboard.press('Control+k');
  await window.locator('.cmdk__input-wrap input').fill('BND4');
  await window.keyboard.press('Enter');
  await expect(window.getByRole('region', { name: 'BND4 容器工作台' })).toBeVisible();

  await window.screenshot({ path: 'test-results/05-bnd-context.png' });
  await app.close();
});

test('变更状态机：候选 → 批准 → 暂存 → 校验 → 写入', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  await window.locator('[data-resource-mode="msg"]').click();
  await window.locator('.file-item', { hasText: 'msg/test.msgbnd.dcx' }).click();

  await window.getByRole('row', { name: /伤药葫芦/ }).click();
  const editor = window.locator('label', { hasText: '编辑 ID 100' }).locator('textarea');
  await expect(editor).toBeVisible();
  await editor.fill('伤药葫芦·改');

  const queue = window.locator('.change-queue');
  await expect(queue.locator('.cq-row')).toHaveCount(1);
  await expect(queue.locator('.cq-row').first()).toHaveAttribute('data-status', 'draft');
  await expect(queue.locator('.cq-summary')).toContainText('伤药葫芦·改');

  await queue.getByRole('button', { name: '批准入暂存' }).click();
  await expect(queue.locator('.cq-row').first()).toHaveAttribute('data-status', 'staged');

  await queue.getByTestId('cq-commit').click();
  await expect(queue.locator('.cq-row').first()).toHaveAttribute('data-status', 'written');
  await expect(window.locator('.status-bar')).toContainText('写入完成');

  // 写入后 FMG 面板重读：fixture 内存语料已含新文本。
  const fmgPanel = window.getByRole('region', { name: 'FMG 本地化工作台' });
  await expect(fmgPanel.locator('.binder-child-table')).toContainText('伤药葫芦·改');

  await window.screenshot({ path: 'test-results/02-written.png' });
  await app.close();
});

test('写入失败：保留诊断，状态为 failed，可重新批准', async () => {
  const { app, window } = await launchApp({ SF_TEST_APPLY_FAIL: '1' });
  await openFixtureWorkspace(window);

  await window.locator('[data-resource-mode="msg"]').click();
  await window.locator('.file-item', { hasText: 'msg/test.msgbnd.dcx' }).click();
  await window.getByRole('row', { name: /返回骨片/ }).click();
  const editor = window.locator('label', { hasText: '编辑 ID 101' }).locator('textarea');
  await editor.fill('返回骨片·改');

  const queue = window.locator('.change-queue');
  await expect(queue.locator('.cq-row')).toHaveCount(1);
  await queue.getByRole('button', { name: '批准入暂存' }).click();
  await queue.getByTestId('cq-commit').click();

  await expect(queue.locator('.cq-row').first()).toHaveAttribute('data-status', 'failed');
  await expect(queue.locator('.cq-diagnostics')).toContainText('ORIGINAL_CHANGED_DURING_STAGING');

  // 失败后可重新批准入暂存
  await queue.getByRole('button', { name: '批准入暂存' }).click();
  await expect(queue.locator('.cq-row').first()).toHaveAttribute('data-status', 'staged');

  await window.screenshot({ path: 'test-results/03-failed-recoverable.png' });

  // 移除暂存项，使关闭确认不再触发，验证 discard 动作
  await queue.getByRole('button', { name: '移除' }).click();
  await expect(queue.locator('.cq-row')).toHaveCount(0);
  await app.close();
});

test('设置归属：通用设置无模型控件，Agent 面板持有会话配置与锁定原因', async () => {
  const { app, window } = await launchApp();

  // 通用设置面板：只保留工作区与安全基础设施。
  await window.getByRole('button', { name: '设置', exact: true }).click();
  const settingsPanel = window.locator('[data-panel-id="settings"]');
  await expect(settingsPanel).toContainText('原版游戏目录');
  await expect(settingsPanel).toContainText('写入路径');
  const settingsText = await settingsPanel.innerText();
  expect(settingsText).not.toContain('思考强度');
  expect(settingsText).not.toContain('模型服务');
  expect(settingsText).not.toContain('运行 / 权限模式');

  // Agent 面板：模型、思考强度、权限模式与锁定原因。
  await expect(window.locator('#agent-provider')).toBeVisible();
  await expect(window.locator('#agent-thinking')).toBeVisible();
  await expect(window.locator('#agent-permission')).toBeDisabled();
  await expect(window.locator('.agent-controls__lock')).toContainText('主进程锁定');
  // mock 不显示为真实本地模型。
  await expect(window.locator('#agent-provider')).toContainText('离线计划（不调用模型）');
  await expect(window.locator('.agent-controls__hint')).toContainText('不运行任何本地或远程模型');

  // 折叠再打开后会话设置不丢失。
  await window.locator('#agent-thinking').selectOption('deep');
  await window.locator('#agent-provider').selectOption('openai');
  const details = window.locator('details.agent-settings');
  await details.locator('summary').click();
  await expect(window.locator('#agent-provider')).toBeHidden();
  await details.locator('summary').click();
  await expect(window.locator('#agent-provider')).toHaveValue('openai');
  await expect(window.locator('#agent-thinking')).toHaveValue('deep');

  await window.screenshot({ path: 'test-results/06-agent-settings.png' });
  await app.close();
});

test('Electron：workspace.openDialog 被调用；用户取消时安静返回', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);
  const calls = await ipcCalls(app);
  expect(calls['workspace.openDialog'] ?? 0).toBeGreaterThanOrEqual(1);
  expect(calls['workspace.scan'] ?? 0).toBeGreaterThanOrEqual(1);
  await app.close();

  // 取消路径：不显示错误，不打开工作区。
  const cancelled = await launchApp({ SF_TEST_CANCEL_DIALOG: '1' });
  await cancelled.window.getByRole('button', { name: '打开 Mod 工作区' }).click();
  await expect(cancelled.window.locator('.toast--warn')).toHaveCount(0);
  await expect(cancelled.window.locator('.titlebar')).toContainText('未打开工作区');
  const cancelledCalls = await ipcCalls(cancelled.app);
  expect(cancelledCalls['workspace.openDialog'] ?? 0).toBeGreaterThanOrEqual(1);
  expect(cancelledCalls['workspace.scan']).toBeUndefined();
  await cancelled.app.close();
});

test('browser-preview 表面：可见降级提示，无 pageerror / console error', async () => {
  const { app, window, pageErrors, consoleErrors } = await launchApp({ SF_TEST_BROWSER_PREVIEW: '1' });

  // 资源浏览器显示运行表面降级提示。
  await expect(window.locator('.runtime-notice')).toContainText('浏览器预览：文件系统功能仅在 SoulForge 桌面版可用');

  // 两个目录按钮保持可聚焦，标记 aria-disabled。
  const openWorkspaceButton = window.getByTestId('open-workspace');
  const chooseBaseButton = window.getByTestId('choose-base-directory');
  await expect(openWorkspaceButton).toHaveAttribute('aria-disabled', 'true');
  await expect(chooseBaseButton).toHaveAttribute('aria-disabled', 'true');

  // 点击或回车均有明确反馈（toast + 状态栏），不抛异常。
  // aria-disabled 按钮保持可触发：force 绕过 Playwright 的 enabled 等待。
  await openWorkspaceButton.click({ force: true });
  await expect(window.locator('.toast--warn')).toContainText('浏览器预览：「打开 Mod 工作区」仅在 SoulForge 桌面版可用');
  // 键盘路径：按钮可聚焦，Enter 触发同一降级反馈。
  await chooseBaseButton.evaluate((element) => element.focus());
  await expect(chooseBaseButton).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(window.locator('.status-bar')).toContainText('浏览器预览：「选择原版目录」仅在 SoulForge 桌面版可用');

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);

  await window.screenshot({ path: 'test-results/07-browser-preview.png' });
  await app.close();
});

test('键盘导航：方向键/Home/End/Enter 选择，Escape 关闭命令面板，焦点环可见', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  const tabs = window.locator('[data-testid="resource-bar"] [role="tab"]');
  await tabs.first().focus();
  await expect(tabs.first()).toBeFocused();

  // ArrowRight 移动焦点，Enter 选择。
  await window.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  // End/Home。
  await window.keyboard.press('End');
  await expect(tabs.last()).toBeFocused();
  await window.keyboard.press('Home');
  await expect(tabs.first()).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  // 键盘焦点出现独立焦点环（outline），与 hover 阴影可区分。
  const outline = await tabs.first().evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).toBe('solid');

  // Escape 关闭命令面板。
  await window.keyboard.press('Control+k');
  await expect(window.locator('.cmdk-overlay')).toHaveClass(/is-open/);
  await window.keyboard.press('Escape');
  await expect(window.locator('.cmdk-overlay')).not.toHaveClass(/is-open/);

  await app.close();
});

test('窄窗口单行导航：653 / 768 / 1024 / 1440 宽度可操作', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  for (const [width, height] of [[653, 694], [768, 810], [1024, 768], [1440, 900]]) {
    await window.setViewportSize({ width, height });
    const bar = window.locator('.resource-bar__tabs');
    const metrics = await bar.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }));
    // 单行：若换行为按钮墙，scrollHeight 会达到两行标签高（2×28px）以上。
    expect(metrics.scrollHeight).toBeLessThan(56);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 6);
    if (metrics.scrollWidth > metrics.clientWidth) {
      // 溢出时容器必须可水平滚动（不允许换行按钮墙）。
      await bar.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      const scrolled = await bar.evaluate((element) => element.scrollLeft);
      expect(scrolled).toBeGreaterThan(0);
    }
    // 窄屏仍可点击 sfx 并保持过滤。
    await window.locator('[data-resource-mode="sfx"]').click();
    await expect(window.locator('.file-item')).toHaveCount(1);
  }

  await window.setViewportSize({ width: 653, height: 694 });
  await window.screenshot({ path: 'test-results/08-narrow-653.png' });
  await app.close();
});

test('按钮四态：rest 无阴影，hover/active/focus-visible 才有层次反馈（含截图）', async () => {
  const { app, window } = await launchApp();
  await showWindow(app);
  await openFixtureWorkspace(window);

  const tab = window.locator('[data-resource-mode="event"]');
  const activityButton = window.getByRole('button', { name: '资源浏览器' });
  const shadowOf = (locator) => locator.evaluate((element) => getComputedStyle(element).boxShadow);

  // rest：与背景融合，无阴影。
  expect(await shadowOf(tab)).toBe('none');
  expect(await shadowOf(activityButton)).toBe('none');
  await window.screenshot({ path: 'test-results/09-buttons-rest.png' });

  // hover：出现低层阴影与轻微表面差（真实指针输入偶发竞态，轮询重试）。
  await expect.poll(async () => {
    await tab.hover();
    await window.waitForTimeout(250);
    return shadowOf(tab);
  }, { timeout: 8000 }).not.toBe('none');
  await window.screenshot({ path: 'test-results/09-buttons-hover.png' });

  // active（pressed）：阴影收窄存在，无跳动。
  const box = await tab.boundingBox();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  await expect.poll(async () => tab.evaluate((element) => ({
    active: element.matches(':active'),
    shadow: getComputedStyle(element).boxShadow
  })), { timeout: 8000 }).toMatchObject({ active: true });
  const pressed = await tab.evaluate((element) => ({
    active: element.matches(':active'),
    shadow: getComputedStyle(element).boxShadow
  }));
  expect(pressed.active).toBe(true);
  expect(pressed.shadow).not.toBe('none');
  await window.screenshot({ path: 'test-results/09-buttons-active.png' });
  await window.mouse.up();

  // focus-visible：键盘方向键到达的焦点出现独立焦点环（与键盘导航测试同配方）。
  await tab.focus();
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowLeft');
  const focusedTab = window.locator('[data-testid="resource-bar"] [role="tab"]:focus-visible');
  await expect(focusedTab).toHaveCount(1);
  const outlineStyle = await focusedTab.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outlineStyle).toBe('solid');
  await window.screenshot({ path: 'test-results/09-buttons-focus-visible.png' });

  await app.close();
});

test('主题 token：暗/亮主题代表性按钮 computed 值不串用', async () => {
  const { app, window } = await launchApp();
  await showWindow(app);
  await openFixtureWorkspace(window);

  const tab = window.locator('[data-resource-mode="event"]');
  const readStates = async () => {
    // 先移开指针，确保读到真正的静止态（不被上一轮 hover 污染）。
    await window.mouse.move(8, 8);
    await window.waitForTimeout(250);
    const rest = await tab.evaluate((element) => getComputedStyle(element).boxShadow);
    await expect.poll(async () => {
      await tab.hover();
      await window.waitForTimeout(250);
      return tab.evaluate((element) => getComputedStyle(element).boxShadow);
    }, { timeout: 8000 }).not.toBe('none');
    const hover = await tab.evaluate((element) => {
      const style = getComputedStyle(element);
      return { shadow: style.boxShadow, background: style.backgroundColor };
    });
    return { restShadow: rest, hoverShadow: hover.shadow, hoverBackground: hover.background };
  };

  // 暗色（默认由 App 固定为 dark）。
  await window.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const dark = await readStates();
  expect(dark.restShadow).toBe('none');
  expect(dark.hoverShadow).not.toBe('none');

  // 亮色：独立更浅阴影 token，不复用暗色值；hover 表面色也不同。
  await window.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const light = await readStates();
  expect(light.restShadow).toBe('none');
  expect(light.hoverShadow).not.toBe('none');
  expect(light.hoverShadow).not.toBe(dark.hoverShadow);
  expect(light.hoverBackground).not.toBe(dark.hoverBackground);

  await window.screenshot({ path: 'test-results/10-theme-light.png' });
  await app.close();
});
