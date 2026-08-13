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

test('顶部工作域栏：逻辑 IA、固定顺序、无物理计数（SHELL-09）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 左侧不再有 .mode-tabs；顶部工作域栏存在且为 tablist。
  await expect(window.locator('.mode-tabs')).toHaveCount(0);
  const tabs = window.locator('[data-testid="domain-bar"] [role="tab"]');
  await expect(tabs).toHaveCount(15);
  await expect(tabs).toHaveText([
    /项目/, /PARAM/, /GPARAM/, /文本/, /事件/, /地图/, /脚本/, /行为/,
    /动画/, /模型/, /纹理/, /材质/, /VFX/, /容器/, /文件/
  ]);

  // §18.13 Done：顶部无「PARAM 36」之类的物理计数（§3.3 领域栏不显示无单位文件数）。
  await expect(window.locator('.domain-tab__count')).toHaveCount(0);
  for (const tab of await tabs.all()) {
    const text = await tab.innerText();
    expect(text).not.toMatch(/\d/, `领域 tab 不应出现数字：${text}`);
  }

  // 页面不把物理目录名当成顶层工作域。
  const bodyText = await window.locator('body').innerText();
  expect(bodyText).not.toContain('SFX 特效');
  expect(bodyText).not.toContain('角色资源');

  // 文件工作域独占物理浏览，但不把 resourceKind 变成顶层按钮。
  await window.locator('[data-domain="files"]').click();
  const files = window.locator('.file-item');
  await expect(files.filter({ hasText: 'sfx/f0000.sfxbnd.dcx' })).toHaveCount(1);
  await expect(window.locator('.status-bar')).toContainText('文件');

  // §18.13 Steps：语义领域不渲染全局 resource browser——事件领域显示占位而非文件列表。
  await window.locator('[data-domain="event"]').click();
  await expect(window.locator('.file-item')).toHaveCount(0);
  await expect(window.locator('[data-testid="domain-browse-placeholder"]')).toBeVisible();
  await expect(window.locator('[data-testid="domain-browse-placeholder"]')).toContainText('事件');

  // §18.13 Done：PARAM 入口直接打开逻辑库（占位工作域），不显示物理文件列表。
  await window.locator('[data-domain="param"]').click();
  await expect(window.locator('.file-item')).toHaveCount(0);
  await expect(window.locator('[data-testid="domain-editor-placeholder"]')).toBeVisible();
  await expect(window.locator('[data-testid="domain-editor-placeholder"]')).toContainText('PARAM');
  expect(await window.locator('.domain-tab__count').count()).toBe(0);

  await window.screenshot({ path: 'test-results/04-resource-bar.png' });
  await app.close();
});

test('文件工作域可定位 ai 资源，且不与 Agent 面板冲突', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  await window.locator('[data-domain="files"]').click();
  const files = window.locator('.file-item');
  await expect(files.filter({ hasText: 'ai/m10.aibnd.dcx' })).toHaveCount(1);

  // Agent 面板仍是独立右侧面板，中央没有占用 AI 页面。
  await expect(window.locator('.agent__composer textarea')).toBeVisible();
  await expect(window.locator('.agent__header')).toContainText('Agent');
  await expect(window.locator('.status-bar')).toContainText('文件');
  await app.close();
});

test('BND 外形文件自动进入容器工作台；命令面板可强制以 BND4 打开', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // SHELL-09：物理浏览只在 Files 领域；容器领域不再有文件列表。
  await window.locator('[data-domain="files"]').click();
  await window.locator('.file-item', { hasText: 'chr/sample.chrbnd.dcx' }).click();
  await expect(window.getByRole('region', { name: 'BND4 容器工作台' })).toBeVisible();

  // 非容器文件 + 命令面板「以 BND4 容器打开当前选择」。
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

  // SHELL-09：文本领域不渲染物理浏览器；msg 文件从 Files 领域选择。
  await window.locator('[data-domain="files"]').click();
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

test('命令面板：焦点被困在模态内，关闭后归还打开前的焦点', async () => {
  // 覆盖两个实测缺陷：命令面板是 role="dialog" aria-modal="true" 但此前不拦
  // Tab——焦点能 Tab 出模态落到背后的主界面上（对键盘/屏幕阅读器用户是「对话框
  // 开着，但我在操作被它遮住的东西」，且无任何提示）；关闭时也不恢复打开前的
  // 焦点，焦点掉回文档开头，用户丢失上下文。
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 先把焦点放在一个可识别的主界面元素上，作为「归还目标」。
  //
  // 全程用 document.activeElement 判定而不是 toBeFocused()：Electron 的
  // fixture 窗口在无头/未激活状态下 Playwright 会把焦点判为 "inactive"，那反映
  // 的是窗口激活状态，不是页面内的焦点位置——而本用例要验证的恰恰是后者。
  // 归还目标用一个稳定可聚焦的元素：搜索框。
  //
  // 不用资源栏 tab：它走 roving tabindex，未选中时是 tabindex="-1"，而选中状态
  // 会被同一 describe 内前序用例改动（serial 模式共享 app 生命周期之外的 UI 约定），
  // 于是「点它 → 断言它被聚焦」在套件内跑与单独跑结果不同。搜索框永远 tabindex=0，
  // 不受选中态影响，是更稳的锚点。
  const searchInput = window.locator('.cmdk-trigger');
  const activeIsTrigger = () => window.evaluate(
    () => document.activeElement?.classList.contains('cmdk-trigger') ?? false
  );
  await searchInput.focus();
  await expect.poll(activeIsTrigger, { timeout: 5000 }).toBe(true);

  await window.keyboard.press('Control+k');
  await expect(window.locator('.cmdk-overlay')).toHaveClass(/is-open/);
  // openCmdk 用 setTimeout(30) 把焦点移进输入框；不等它落定就按 Tab，事件会打在
  // 模态外的元素上，测到的是「焦点还没进来」而不是「trap 失效」。
  // 用 poll 读 document.activeElement 而不是 toBeFocused()：后者会先等元素稳定，
  // 那一步本身可能与这个 30ms 的异步聚焦竞争。
  await expect.poll(
    () => window.evaluate(() => document.activeElement?.tagName ?? null),
    { timeout: 5000 }
  ).toBe('INPUT');

  // 焦点是否仍在模态内，直接在页面里判定。
  //
  // 不用 locator.evaluate 读 document.activeElement：Playwright 会在 evaluate 前
  // 等待元素稳定，那一步本身可能改变焦点，于是读到的是「检查动作之后」的状态。
  // 在 page.evaluate 里一次性取当前焦点最贴近真实按键序列。
  const focusInsideModal = () => window.evaluate(() => {
    const dialog = document.querySelector('.cmdk');
    return dialog !== null && dialog.contains(document.activeElement);
  });

  // 连续 Tab 远超模态内可聚焦元素数量；焦点必须始终留在模态内。
  for (let step = 0; step < 25; step += 1) {
    await window.keyboard.press('Tab');
    expect(await focusInsideModal(), `第 ${step + 1} 次 Tab 后焦点逃出了模态`).toBe(true);
  }

  // 反向同样受困（只处理正向是最常见的半成品 focus trap）。
  for (let step = 0; step < 10; step += 1) {
    await window.keyboard.press('Shift+Tab');
    expect(await focusInsideModal(), `第 ${step + 1} 次 Shift+Tab 后焦点逃出了模态`).toBe(true);
  }

  // 关闭后焦点归还到打开前的元素，而不是掉回 body。
  await window.keyboard.press('Escape');
  await expect(window.locator('.cmdk-overlay')).not.toHaveClass(/is-open/);
  await expect.poll(activeIsTrigger, { timeout: 5000 }).toBe(true);

  await app.close();
});

test('纯键盘可完成 FMG 编辑：行选择不再阻断编辑态', async () => {
  // 这条覆盖一个实测缺陷：FMG 与 PARAM 面板的行选择此前是
  // `<div role="row" onClick={...}>`，键盘完全不可达。而编辑控件只在选中行后才
  // 出现，因此键盘用户**根本进不去编辑态**——不是「体验差」，是功能不可用。
  //
  // 断言方式是走完整个流程而不是检查属性：tabIndex=0 存在但 onKeyDown 不响应
  // Space，用户视角仍然是不可用。
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  await window.locator('[data-domain="files"]').click();
  await window.locator('.file-item', { hasText: 'msg/test.msgbnd.dcx' }).click();

  const row = window.getByRole('row', { name: /伤药葫芦/ });
  await expect(row).toBeVisible();

  // 行必须能被聚焦（roving tabindex 让选中行/首行进 Tab 序列）。
  await row.focus();
  await expect(row).toBeFocused();
  // 未选中时 aria-selected 必须是 false —— 屏幕阅读器据此播报选中态。
  await expect(row).toHaveAttribute('aria-selected', 'false');

  // Space 触发选择（只认 Enter 会让习惯 Space 的用户以为行不可选）。
  await window.keyboard.press(' ');
  await expect(row).toHaveAttribute('aria-selected', 'true');

  // 选中后编辑控件出现，且可用键盘填入内容。
  const editor = window.locator('label', { hasText: '编辑 ID 100' }).locator('textarea');
  await expect(editor).toBeVisible();
  await editor.focus();
  await expect(editor).toBeFocused();
  // 用 fill 而不是 Control+a + type：这里要证明的是「选中行后编辑控件可达且可
  // 编辑」，输入法层面的全选行为不属于本断言，混进来只会让用例对无关差异敏感。
  await editor.fill('键盘编辑·改');

  // 变更进入审查队列——即键盘路径与鼠标路径落到同一条写入链。
  const queue = window.locator('.change-queue');
  await expect(queue.locator('.cq-row')).toHaveCount(1);
  await expect(queue.locator('.cq-summary')).toContainText('键盘编辑·改');

  // Enter 同样能触发行选择（换一行验证，避免只测到 Space 一条分支）。
  const otherRow = window.getByRole('row', { name: /返回骨片/ });
  await otherRow.focus();
  await window.keyboard.press('Enter');
  await expect(otherRow).toHaveAttribute('aria-selected', 'true');
  await expect(window.locator('label', { hasText: '编辑 ID 101' }).locator('textarea')).toBeVisible();

  // 切换选中行会让上一行的编辑内容留在审查队列里（未提交的候选不因换行而丢失）。
  // 这一条顺带确认换行没有静默丢弃变更——那会是比键盘不可达更糟的行为。
  await expect(queue.locator('.cq-summary')).toContainText('键盘编辑·改');

  // 关闭前清掉未提交候选：App 对 draft/staged 装了 beforeunload 守卫（防误关丢
  // 变更），它会让 Electron 的窗口关闭挂起，表现是 app.close() 超时而不是断言
  // 失败——排查时极易误判成用例本身的问题。这里显式走「拒绝」而不是绕过守卫，
  // 因为守卫本身是正确行为。draft 状态的按钮是「拒绝」，rejected 后不再计入
  // 未提交集合。
  await queue.locator('.cq-row').first().getByRole('button', { name: '拒绝' }).click();
  await expect(queue.locator('.cq-row').first()).toHaveAttribute('data-status', 'rejected');

  await app.close();
});

test('写入失败：保留诊断，状态为 failed，可重新批准', async () => {
  const { app, window } = await launchApp({ SF_TEST_APPLY_FAIL: '1' });
  await openFixtureWorkspace(window);

  await window.locator('[data-domain="files"]').click();
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

test('设置归属：通用设置无模型控件，Agent 历史抽屉承载模型设置', async () => {
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

  // 设置不出现在 Agent header；从历史抽屉进入模型设置。
  await expect(window.locator('details.agent-settings')).toHaveCount(0);
  await window.getByRole('button', { name: '打开 Agent 历史' }).click();
  const history = window.locator('.agent-drawer');
  await expect(history).toContainText('Agent 历史');
  await history.getByRole('button', { name: '模型设置' }).click();
  await expect(window.locator('.agent-drawer')).toContainText('模型服务设置');

  // 模型/思考强度/权限模式仍保留在专用设置抽屉。
  await expect(window.locator('#agent-provider')).toBeVisible();
  await expect(window.locator('#agent-thinking')).toBeVisible();
  await expect(window.locator('#agent-permission')).toBeDisabled();
  await expect(window.locator('.agent-controls__lock')).toContainText('主进程锁定');
  // mock 不显示为真实本地模型。
  await expect(window.locator('#agent-provider')).toContainText('离线计划（不调用模型）');
  await expect(window.locator('.agent-controls__hint')).toContainText('不运行任何本地或远程模型');
  // 作用范围必须写在控件旁：此前这个下拉与 AgentTaskPanel 的模型服务下拉同名
  // 「模型服务」并排出现，而两者指向不同后端——在这里选 Anthropic 不影响任务。
  await expect(window.locator('[data-testid="agent-draft-scope"]')).toContainText('仅用于生成计划草稿');

  // 关闭再打开后设置不丢失。
  await window.locator('#agent-thinking').selectOption('deep');
  await window.locator('#agent-provider').selectOption('openai');
  await window.getByRole('button', { name: '关闭抽屉' }).click();
  await window.getByRole('button', { name: '打开 Agent 历史' }).click();
  await window.locator('.agent-drawer').getByRole('button', { name: '模型设置' }).click();
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

test('IPC 发送方校验：主文档之外的调用被拒绝', async () => {
  // 这条覆盖生产 ipc.ts 的 handle 包装器里那道 assertTrustedSender —— 56 个
  // channel 的必经之路，也是「渲染进程被导航到外部页面后不得继续调 IPC」这条
  // 边界的唯一执行点。此前 fixture main 完全没有这层校验，于是 e2e 跑的是一个
  // 没有安全层的 main：改坏 assertTrustedSender 不会让任何用例变红。
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 正常路径：主文档发起的调用必须成功（先确认校验没有把合法调用一起挡掉，
  // 否则下面的「被拒绝」可能只是因为一切都被拒绝）。
  const allowed = await window.evaluate(async () => {
    try {
      await window.soulforge.listOperations();
      return 'ok';
    } catch (error) {
      return `rejected:${error instanceof Error ? error.message : String(error)}`;
    }
  });
  expect(allowed).toBe('ok');

  // 越界路径：从 main 侧直接向一个**未登记为受信任文档**的 webContents 发起
  // 同一 channel。用真实的第二个窗口而不是伪造 event：伪造的 event 只能测到
  // 我们自己写的桩，测不到 Electron 真实的 senderFrame 语义。
  const rejection = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
    const rogue = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    await rogue.loadURL('data:text/html,<html><body>rogue</body></html>');
    try {
      // 直接调用注册在 ipcMain 上的 handler，带上 rogue 窗口的 sender。
      // ipcMain 没有公开的「以任意 sender 触发」API，所以走 executeJavaScript
      // 让 rogue 页面自己发 —— 它没有 preload，因此用 nodeIntegration 拿 ipcRenderer。
      const result = await rogue.webContents.executeJavaScript(`
        (async () => {
          try {
            await require('electron').ipcRenderer.invoke('operation.list');
            return 'unexpectedly-allowed';
          } catch (error) {
            return 'rejected:' + String(error && error.message ? error.message : error);
          }
        })()
      `);
      return result;
    } finally {
      rogue.destroy();
    }
  });

  // 必须被拒绝，且诊断里点名 channel —— 「被拒绝」不等于「因为正确的原因被拒绝」。
  expect(rejection).toContain('rejected:');
  expect(rejection).toContain('operation.list');
  await app.close();
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

  const tabs = window.locator('[data-testid="domain-bar"] [role="tab"]');
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
    const bar = window.locator('.domain-bar__tabs');
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
    // 窄屏仍可点击文件工作域并保持可操作。12 = fixture 合成样本数
    // （PARAM-10B 加 gameparam.parambnd.dcx，GPARAM-11B 加 3 个 gparam.dcx）。
    await window.locator('[data-domain="files"]').click();
    await expect(window.locator('.file-item')).toHaveCount(12);
  }

  await window.setViewportSize({ width: 653, height: 694 });
  await window.screenshot({ path: 'test-results/08-narrow-653.png' });
  await app.close();
});

test('按钮四态：rest 无阴影，hover/active/focus-visible 才有层次反馈（含截图）', async () => {
  const { app, window } = await launchApp();
  await showWindow(app);
  await openFixtureWorkspace(window);

  const tab = window.locator('[data-domain="event"]');
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
  const focusedTab = window.locator('[data-testid="domain-bar"] [role="tab"]:focus-visible');
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

  const tab = window.locator('[data-domain="event"]');
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

/*
 * 大工作区：分页与截断说明。
 *
 * 默认 fixture 只有 9 个文件，低于分页页大小（200）与搜索上限（60），所以这两条
 * 行为在默认套件里根本不出现。SF_TEST_LARGE_WORKSPACE=1 让 fixture 返回 472 个
 * 合成条目，跨过两个阈值。
 *
 * 断言的是**用户能看到什么**：DOM 里真的只有一页节点、翻页真的换内容、说明里的
 * 数字与真实总数一致。只断言「pager 存在」不够——一个点了不换页的 pager 也满足。
 */
test('大工作区：文件列表分页，且标题栏与导航报出真实规模', async () => {
  const { app, window, pageErrors, consoleErrors } = await launchApp({
    SF_TEST_LARGE_WORKSPACE: '1'
  });
  await openFixtureWorkspace(window);
  await window.locator('[data-domain="files"]').click();

  // 一次只建一页 DOM：这是硬约束 17 的实质，不是「有个 pager 控件」。
  const items = window.locator('.file-item');
  await expect(items).toHaveCount(200);

  const pager = window.locator('[data-testid="file-list-pager"]');
  await expect(pager).toBeVisible();

  // 位置文案必须报出区间与真实总数（472 = 12 基础 + 460 合成）。
  const range = window.locator('[data-testid="file-list-page-range"]');
  await expect(range).toContainText('1–200');
  await expect(range).toContainText('472');
  await expect(range).toContainText('第 1/3 页');

  // 标题栏在超过一页时要说明「本页显示多少」，否则 200 与 472 长得一样。
  // SHELL-09 §3.3：数量带语义单位（文件 N 个）。
  await expect(window.locator('[data-panel-id="explorer"] .panel__hint')).toContainText('文件 472 个');
  await expect(window.locator('[data-panel-id="explorer"] .panel__hint')).toContainText('本页 200');

  // 翻页必须真的换内容：记下首项，翻页后应不同且区间前移。
  const firstBefore = await items.first().innerText();
  await window.getByRole('button', { name: '下一页' }).first().click();
  await expect(range).toContainText('201–400');
  await expect(range).toContainText('第 2/3 页');
  const firstAfter = await items.first().innerText();
  expect(firstAfter).not.toBe(firstBefore);

  // 末页只剩余数条，且「下一页」到底后禁用。
  await window.getByRole('button', { name: '下一页' }).first().click();
  await expect(range).toContainText('401–472');
  await expect(items).toHaveCount(72);
  await expect(window.getByRole('button', { name: '下一页' }).first()).toBeDisabled();

  // 回到第一页：上一页可用且内容复原。
  await window.getByRole('button', { name: '上一页' }).first().click();
  await window.getByRole('button', { name: '上一页' }).first().click();
  await expect(range).toContainText('1–200');
  await expect(window.getByRole('button', { name: '上一页' }).first()).toBeDisabled();

  await window.screenshot({ path: 'test-results/11-file-list-pagination.png' });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await app.close();
});

test('大工作区：过滤后页码复位，且搜索结果显式说明被截断', async () => {
  const { app, window } = await launchApp({ SF_TEST_LARGE_WORKSPACE: '1' });
  await openFixtureWorkspace(window);
  await window.locator('[data-domain="files"]').click();

  const range = window.locator('[data-testid="file-list-page-range"]');
  await window.locator('[data-panel-id="explorer"] .search-box input').fill('m0');
  await window.getByRole('button', { name: '下一页' }).first().click();
  await window.getByRole('button', { name: '下一页' }).first().click();
  await expect(range).toContainText('第 3/3 页');

  /*
   * 改过滤词后必须回到第 1 页。
   *
   * 过滤词刻意选仍然跨页的 'msb'（460 命中 / 3 页）：若换成命中不足一页的词，
   * pager 会整体消失，断言就只能塞进 if 分支——而那个分支在「复位被移除」时
   * 照样通过。实测确认过：用 'm03'（100 命中）时本条负向扰动不报红。
   * 正向与负向不能共用 if/else。
   */
  await window.locator('[data-panel-id="explorer"] .search-box input').fill('msb');
  await expect(window.locator('[data-testid="file-list-pager"]')).toBeVisible();
  await expect(range).toContainText('第 1/3 页');
  await expect(range).toContainText('1–200');
  await expect(window.getByRole('button', { name: '上一页' }).first()).toBeDisabled();

  // 搜索面板：命中远超 60 条上限，必须出现带真实数字的截断说明。
  // 必须先切到搜索视图——搜索面板与资源浏览器共用侧栏槽位，未激活时输入框不可见。
  await window.locator('[data-panel-id="explorer"] .search-box input').fill('');
  // 用 .ab-item 限定活动栏按钮：面板内也有一个名为「搜索」的按钮，
  // getByRole('button', {name:'搜索'}) 会先命中那个，导致视图始终切不过去。
  await window.locator('.ab-item[aria-label="搜索"]').click();
  await window.locator('[data-panel-id="search"] .search-box input').fill('.msb');
  const note = window.locator('[data-testid="search-truncation"]');
  await expect(note).toBeVisible();
  await expect(note).toContainText('460');
  await expect(note).toContainText('60');
  // 未显示数必须报出来，否则用户要自己做减法。
  await expect(note).toContainText('400');

  await window.screenshot({ path: 'test-results/12-search-truncation.png' });
  await app.close();
});

test('AI 任务：运行发起后进度事件真的更新界面，取消真的发出 IPC', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  const panel = window.locator('[data-testid="agent-task-panel"]');
  const status = window.locator('[data-testid="agent-task-status"]');
  const cancel = window.locator('[data-testid="agent-task-cancel"]');
  const run = window.locator('[data-testid="agent-task-run"]');

  // 空闲态只显示 welcome；发送计划提示后才挂载任务面板。
  await expect(panel).toHaveCount(0);
  await window.locator('.agent__composer textarea').fill('把伤药葫芦的持有上限调到 12');
  await window.locator('.agent__composer').getByRole('button', { name: '发送' }).click();
  await expect(panel).toBeVisible();

  // 运行前置：fixture 提供一个已配置凭据的合成服务，故运行按钮可用。
  await expect(window.locator('#agent-task-service')).toHaveValue('fixture-service');
  await expect(run).toBeEnabled();
  await run.click();

  // 1) 发起真的走了 IPC。
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.run'] ?? 0).toBeGreaterThan(0);

  // 2) renderer 不得抬高授权：run 请求里不能带 mode（省略时主进程落到 plan）。
  const modeCalls = await ipcCalls(app);
  expect(modeCalls['ai.agent.run:mode=absent'] ?? 0).toBeGreaterThan(0);
  expect(modeCalls['ai.agent.run:mode=fullPermission'] ?? 0).toBe(0);
  expect(modeCalls['ai.agent.run:mode=normal'] ?? 0).toBe(0);

  // 3) 推送事件到达后界面真的更新：步号、工具调用与产出量都必须出现。
  //    fixture 按计时器推 turn-started(1) → tool-call → delta，且刻意不推终态。
  await expect(status).toContainText('第 1 步');
  await expect(status).toContainText('可随时取消');
  const toolCalls = window.locator('[data-testid="agent-task-tool-calls"]');
  await expect(toolCalls).toContainText('search_resources');
  await expect(toolCalls).toContainText('成功');
  await expect(status).toContainText('已产出 6 字符');

  // 4) 运行中取消必须可用——硬约束 16 的「可取消」在界面上成立。
  await expect(cancel).toBeEnabled();
  await cancel.click();

  // 5) 取消真的发出 IPC。这是本用例的核心断言：只改本地状态的「取消」会让
  //    任务继续跑到底，而界面显示已取消。
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.cancel'] ?? 0).toBeGreaterThan(0);

  // 6) 终态由主进程回报，界面据此收敛；取消后不再可取消。
  await expect(status).toContainText('已被取消');
  await expect(cancel).toBeDisabled();
  await expect(panel).toContainText('fixture-rollout.jsonl');

  await window.screenshot({ path: 'test-results/13-agent-task-run-cancel.png' });
  await app.close();
});

test('AI 任务：会话历史分页、载入与承接各自走对应 IPC', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  await window.getByRole('button', { name: '打开 Agent 历史' }).click();
  const history = window.locator('.agent-history');
  await history.getByRole('button', { name: '刷新' }).click();
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.sessions'] ?? 0).toBeGreaterThan(0);

  // 分页文案必须回答「这一页覆盖第几到第几、共多少」。fixture 给 23 条、每页 10，
  // 确实跨过阈值——先断言前提成立，再断言目标，避免断言掉进永假分支。
  const range = window.locator('[data-testid="agent-sessions-range"]');
  await expect(range).toContainText('共 23');
  await expect(range).toContainText('会话 1–10');
  await expect(history).toContainText('fixture-rollout-0000.jsonl');

  // 数据源上限必须明说：主进程只回最近 50 个会话文件。
  await expect(window.locator('[data-testid="agent-sessions-source-limit"]')).toContainText('最近 50 个会话文件');

  // 翻页真的换内容。
  await history.getByRole('button', { name: '下一页' }).click();
  await expect(range).toContainText('会话 11–20');
  await expect(history).toContainText('fixture-rollout-0010.jsonl');
  await expect(history).not.toContainText('fixture-rollout-0000.jsonl');

  // 载入：走 ai.agent.session.load，详情报出真实条数与「只取尾部若干条」。
  await history.getByRole('button', { name: '查看' }).first().click();
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.session.load'] ?? 0).toBeGreaterThan(0);
  const detail = window.locator('[data-testid="agent-session-detail"]');
  await expect(detail).toContainText('共 12 条消息');
  await expect(detail).toContainText('尾部 1 条');
  await expect(detail).toContainText('plan');

  // 承接：走 ai.agent.run 并带 resumeSessionPath。
  await history.getByRole('button', { name: '承接' }).first().click();
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.run:resume'] ?? 0).toBeGreaterThan(0);

  await app.close();
});

test('AI 任务：工具清单不污染 Agent 对话，且界面不提供抬高授权的入口', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  await expect.poll(async () => (await ipcCalls(app))['ai.tools'] ?? 0).toBeGreaterThan(0);
  // 普通对话不渲染工具库存；工具调用只在任务状态面板出现。
  await expect(window.locator('[data-testid="agent-tool-inventory"]')).toHaveCount(0);
  await expect(window.locator('.agent-welcome')).toBeVisible();
  await expect(window.locator('.composer-permission')).toContainText('主进程锁定');
  // 全页不得出现可抬高授权的 fullPermission 选项。
  expect(await window.locator('option[value="fullPermission"]').count()).toBe(0);

  await app.close();
});

test('PARAM 工作台四栏：选择链、父选区清理、虚拟行、字段类型控件与局部失败（PARAM-10B）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 从 Files 领域选 parambnd 容器，打开 Param Workbench。
  await window.locator('[data-domain="files"]').click();
  await window.locator('.file-item', { hasText: 'param/gameparam/gameparam.parambnd.dcx' }).click();

  // 四栏同时存在（§7.1 Params/Rows/Fields/Tools；§18.14 10B Negative DOM 无三栏标题）。
  // WorkbenchLayout 根是 div（.workbench），四栏是带 aria-label 的 section（region）。
  await expect(window.locator('.workbench')).toBeVisible();
  await expect(window.getByRole('region', { name: 'Params' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Rows' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Fields' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Tools' })).toBeVisible();

  // §7.1 比例在运行期成立（computed flex-grow，未被拖拽覆盖时）；拖拽后转像素是允许路径。
  const growRatios = await window.evaluate(() => {
    const slots = [...document.querySelectorAll('.workbench__column-slot')];
    return slots.map((slot) => getComputedStyle(slot).flexGrow);
  });
  expect(growRatios).toEqual(['0.2', '0.29', '0.35', '0.16']);

  // 独立滚动：每栏的滚动权在栏内，不泄给整页。普通栏 body 自身滚（auto）；
  // 虚拟栏（Rows）把滚动权交给内部 .wb-virtual-scroll（body hidden + 内部 auto）。
  // 两者都不得是 visible —— visible 意味着滚整页。
  const scrollHosts = await window.evaluate(() => {
    const bodies = [...document.querySelectorAll('.workbench__column-body')];
    return bodies.map((body) => getComputedStyle(body).overflowY);
  });
  expect(scrollHosts.every((value) => value === 'auto' || value === 'hidden')).toBe(true);

  // §7.8 标题形态；负向清单：无 .bak/.gparam/物理路径。
  // 页面可能有多个 .crumb（文件浏览器面包屑），用 hasText 过滤工作台的标题。
  // 负向断言只收在工作台内部：文件浏览器显示选中文件的路径是 files 领域的正常 UI。
  const paramCrumb = window.locator('.crumb', { hasText: 'Game Parameters' });
  await expect(paramCrumb).toContainText('1 library · 3 tables');
  const workbenchText = await window.locator('.workbench').innerText();
  expect(workbenchText).not.toContain('gameparam.parambnd.dcx');
  expect(workbenchText).not.toContain('.bak');
  expect(workbenchText).not.toContain('.gparam');

  // Tools 栏只给诚实空态，不渲染 disabled 假按钮（§7.6）。
  const toolsColumn = window.locator('.workbench__column[aria-label="Tools"]');
  await expect(toolsColumn).toContainText('暂无已接通的工具');
  expect(await toolsColumn.locator('button').count()).toBe(0);

  // 选择链：选 ActionGuideParam → 行出现（虚拟容器挂载，滚动权在虚拟容器自身）；选首行 → 字段出现。
  await window.locator('.wb-list .wb-row', { hasText: 'ActionGuideParam' }).click();
  await expect(window.locator('.wb-virtual-row', { hasText: '100' })).toBeVisible();
  const virtualScrollOverflow = await window.locator('.wb-virtual-scroll').first()
    .evaluate((element) => getComputedStyle(element).overflowY);
  expect(virtualScrollOverflow).toBe('auto');
  await window.locator('.wb-virtual-row', { hasText: '100' }).click();

  // 字段类型控件：enum 字段按类型渲染——原始值留在 input（只读），
  // 当前值标签（枚举标签「攻击」）显示在字段名旁，不是裸自由文本。
  const behaviorProp = window.locator('.wb-prop', { hasText: 'behavior' });
  await expect(behaviorProp).toContainText('攻击');
  await expect(behaviorProp.locator('input')).toBeVisible();
  await expect(behaviorProp.locator('input')).toHaveValue('1');

  // 父选区清理：切到 EquipParamWeapon 后字段栏清空回空态。
  await window.locator('.wb-list .wb-row', { hasText: 'EquipParamWeapon' }).click();
  await expect(window.locator('.wb-virtual-row', { hasText: '500' })).toBeVisible();
  await expect(window.locator('.wb-empty', { hasText: '先在中栏选择一行。' })).toBeVisible();

  // 局部失败：BrokenParam 保留在左栏并标记失败，右栏给出结构化原因。
  await window.locator('.wb-list .wb-row', { hasText: 'BrokenParam' }).click();
  await expect(window.locator('.wb-row__meta', { hasText: '读取失败' })).toBeVisible();
  await expect(window.locator('.diag-error', { hasText: '这个 param 读不出来' })).toBeVisible();

  // 同尺寸对照截图（§2.4 步骤 6：以相同窗口尺寸保存 SoulForge 对照截图）。
  await window.screenshot({ path: 'test-results/10-param-workbench.png' });
  await app.close();
});

test('GPARAM 工作台四栏：banks 选择链、父选区清理、值类型展开与局部失败（GPARAM-11B）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 从 Files 领域选 gparam 文件，打开 GPARAM Workbench。
  await window.locator('[data-domain="files"]').click();
  await window.locator('.file-item', { hasText: 'param/drawparam/m10_00.gparam.dcx' }).click();

  // Agent 面板默认展开为 overlay，会盖住右侧 Fields/Values 栏的点击目标。
  // PARAM-10B 用例点击目标在中栏不受影响；这里先收起再操作右栏。
  await window.getByRole('button', { name: '关闭 Agent 面板' }).click();

  // 四栏同时存在（§18.15 11B：Banks/Groups/Fields/Values/Tools）。
  await expect(window.locator('.workbench')).toBeVisible();
  await expect(window.getByRole('region', { name: 'Banks' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Groups' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Fields/Values' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Tools' })).toBeVisible();

  // §18.15 比例在运行期成立（computed flex-grow）。
  const growRatios = await window.evaluate(() => {
    const slots = [...document.querySelectorAll('.workbench__column-slot')];
    return slots.map((slot) => getComputedStyle(slot).flexGrow);
  });
  expect(growRatios).toEqual(['0.18', '0.24', '0.42', '0.16']);

  // 独立滚动：每栏的滚动权在栏内，不泄给整页。
  const scrollHosts = await window.evaluate(() => {
    const bodies = [...document.querySelectorAll('.workbench__column-body')];
    return bodies.map((body) => getComputedStyle(body).overflowY);
  });
  expect(scrollHosts.every((value) => value === 'auto' || value === 'hidden')).toBe(true);

  // §7.8 标题形态；负向清单：无物理路径 / .bak / PARAM 表。
  // 物理路径只允许出现在 title（metadata details），可见文本是显示名。
  const gparamCrumb = window.locator('.crumb', { hasText: 'Graphics Parameters' });
  await expect(gparamCrumb).toContainText('3 banks');
  const workbenchText = await window.locator('.workbench').innerText();
  expect(workbenchText).not.toContain('.gparam.dcx');
  expect(workbenchText).not.toContain('.bak');
  expect(workbenchText).not.toContain('Game Parameters'); // PARAM 工作台标题不串台

  // Tools 栏只给诚实空态：只读说明存在，无假写入按钮。
  const toolsColumn = window.locator('.workbench__column[aria-label="Tools"]');
  await expect(toolsColumn).toContainText('暂无已接通的工具');
  expect(await toolsColumn.locator('button').count()).toBe(0);

  // 打开时默认选中当前文件：Groups 栏出现 LightSet ParamEditor。
  await expect(window.locator('.wb-list .wb-row', { hasText: 'LightSet ParamEditor' })).toBeVisible();

  // 选择链：选 group → Fields/Values 出现 params；选 param → 值展开。
  await window.locator('.wb-list .wb-row', { hasText: 'LightSet ParamEditor' }).click();
  await expect(window.locator('.wb-list .wb-row', { hasText: 'Directional Light Angle0' })).toBeVisible();
  await window.locator('.wb-list .wb-row', { hasText: 'Directional Light Angle0' }).click();

  // 值类型展开：float3 每值 3 个 typed 输入框（11C）；valueId 与 unk f32 独立列。
  await expect(window.locator('.gparam-values__head')).toBeVisible();
  const firstValueRow = window.locator('.gparam-values__row').first();
  await expect(firstValueRow.locator('.gparam-values__input')).toHaveCount(3);
  await expect(firstValueRow.locator('.gparam-values__input').nth(0)).toHaveValue('1.25');
  await expect(firstValueRow.locator('.gparam-values__input').nth(1)).toHaveValue('0.5');
  await expect(firstValueRow.locator('.gparam-values__input').nth(2)).toHaveValue('0.75');
  await expect(firstValueRow).toContainText('11');

  // 父选区清理：切到第二个 group（Shadows）后 param 选择被清——不再显示
  // 上一个 group 的 Directional Light 值，而是当前 group 的 param 列表。
  await window.locator('.wb-list .wb-row', { hasText: 'Shadows ParamEditor' }).click();
  await expect(window.locator('.wb-list .wb-row', { hasText: 'Shadow Distance' })).toBeVisible();
  // 父选区清理后值编辑器整体消失：不再有前一个 group 的任何 typed 输入框。
  await expect(window.locator('.gparam-values__input')).toHaveCount(0);

  // 父选区清理（bank 级）：切到 m11 bank 后 group 与 param 选择全部清空。
  await window.locator('.wb-list .wb-row', { hasText: 'm11_00' }).click();
  await expect(window.locator('.wb-list .wb-row', { hasText: 'Camera ParamEditor' })).toBeVisible();
  await expect(window.locator('.wb-empty', { hasText: '先在中栏选择一个 group。' })).toBeVisible();

  // 局部失败：broken bank 保留在 Banks 栏并标记失败，Groups 栏给出结构化原因。
  await window.locator('.wb-list .wb-row', { hasText: 'broken' }).click();
  await expect(window.locator('.wb-row__meta', { hasText: '读取失败' })).toBeVisible();
  await expect(window.locator('.diag-error', { hasText: 'fixture 未登记或损坏的 GPARAM' })).toBeVisible();

  // 同尺寸对照截图（§2.4 步骤 6）。
  await window.screenshot({ path: 'test-results/11-gparam-workbench.png' });
  await app.close();
});

test('GPARAM typed 写回：值行编辑 → Tools 保存 → 重读新值，非法输入禁用提交（GPARAM-11C）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  await window.locator('[data-domain="files"]').click();
  await window.locator('.file-item', { hasText: 'param/drawparam/m10_00.gparam.dcx' }).click();
  await window.getByRole('button', { name: '关闭 Agent 面板' }).click();

  // 打开默认 bank（m10_00）：LightSet → Directional Light Angle0（float3 × 2 值）。
  await expect(window.locator('.workbench')).toBeVisible();
  await window.locator('.wb-list .wb-row', { hasText: 'LightSet ParamEditor' }).click();
  await window.locator('.wb-list .wb-row', { hasText: 'Directional Light Angle0' }).click();

  // 值行是 typed 输入框：2 值 × 3 分量 = 6 个 input，初始值为 fixture 值。
  const inputs = window.locator('.gparam-values__input');
  await expect(inputs).toHaveCount(6);
  await expect(inputs.nth(0)).toHaveValue('1.25');
  await expect(inputs.nth(1)).toHaveValue('0.5');

  // 未修改时 Tools 栏无保存按钮（诚实空态）。
  const toolsColumn = window.locator('.workbench__column[aria-label="Tools"]');
  await expect(toolsColumn).toContainText('暂无已接通的工具');
  expect(await toolsColumn.locator('button').count()).toBe(0);

  // 修改第一个分量 → Tools 栏出现保存入口，行标记为已编辑。
  await inputs.nth(0).fill('2.5');
  await expect(window.locator('.gparam-values__row--edited').first()).toBeVisible();
  await expect(window.getByRole('button', { name: '保存 1 处修改' })).toBeVisible();
  await expect(toolsColumn).toContainText('共 1 处修改');

  // 保存 → 提交并重读：输入框回到服务端值（fixture 内存态已更新为 2.5）。
  await window.getByRole('button', { name: '保存 1 处修改' }).click();
  await expect(toolsColumn).toContainText('已提交 1 处修改并重读验证。');
  await expect(window.locator('.gparam-values__input').nth(0)).toHaveValue('2.5');
  // 兄弟分量未被改动（只提交了 1 处）。
  await expect(window.locator('.gparam-values__input').nth(1)).toHaveValue('0.5');
  // 保存后 drafts 清空：按钮消失，回到诚实空态。
  expect(await toolsColumn.locator('button').count()).toBe(0);

  // 非法输入：非数字 → 保存按钮禁用并给出诊断，不提交。
  await window.locator('.gparam-values__input').nth(1).fill('abc');
  await expect(toolsColumn).toContainText('存在非数字输入，无法提交。');
  const saveButton = window.getByRole('button', { name: '保存 1 处修改' });
  await expect(saveButton).toBeVisible();
  expect(await saveButton.isDisabled()).toBe(true);

  // 改回合法数字 → 按钮恢复可提交。
  await window.locator('.gparam-values__input').nth(1).fill('0.5');
  await expect(toolsColumn).not.toContainText('存在非数字输入，无法提交。'); // 诊断消失
  expect(await saveButton.isDisabled()).toBe(false);

  await window.screenshot({ path: 'test-results/11-gparam-writer.png' });
  await app.close();
});
