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
  // T2：打开工作区入口从侧栏移到中央开始页；窄窗口（633px）下 Agent dock
  // 默认展开会压缩中央编辑区，先收 Agent 让开始页按钮可见可点。
  await closeAgentPanel(window);
  // S33 起开始态侧栏与中央开始页各有一个「打开 Mod 工作区」按钮（同名同
  // testid），裸 getByRole/getByTestId 会 strict mode violation：收窄到中央
  // 开始页 region（aria-label「开始」）再定位。
  await window.getByRole('region', { name: '开始' }).getByTestId('open-workspace').click();
  /*
   * 挂载完成的等待信号。
   *
   * 原判据是 `.status-bar` 含「已索引」。S12 把状态栏整块摘掉了（styles.css 还留着
   * 那条 `.status-bar` 规则，但 renderer 里没有任何元素带这个 class，「已索引」只
   * 出现在两个 JS 字符串里），于是这个等待**永远不会 resolve** —— 全部 40 个调用
   * 点都卡在这一行超时。产品结构不为测试回退（不恢复状态栏），改判据。
   *
   * 两段等待对应 mountWorkspace 的两个阶段，与原判据同语义：
   *
   * 1. 开始页标题出现工作区名 —— scanWorkspace 已 resolve。App.tsx 里
   *    setWorkspace / setAllFiles / setFiles 与标题所需的 workspace 在同一个批次
   *    提交，所以标题一变，下游 `.file-item` 点击所需的文件数据必然已在。
   * 2. `.welcome__stats` 出现「已解析」—— analyzeWorkspace 已 resolve
   *    （那段文案由 `analysis ? ...` 控制，analysis 为 null 时整段不出现）。
   *    原判据的「已索引」也是 analyze 之后才写进状态栏的，这一段把那层前提补回来，
   *    避免测试在 analyze 在飞时开始交互、被中途的 setState 重渲染打断。
   *
   * `.welcome__stats` 所在的 `.editor-welcome` 在工作区打开后是 `display:none`，
   * 但 toContainText 读 textContent、不做可见性检查，所以隐藏不影响判据。这里刻意
   * 不改成可见元素：shell 里没有第二个消费 analysis 的 DOM 节点，为测试新增一个就
   * 是「为测试改产品结构」。
   */
  await expect(window.locator('.project-overview h1')).toHaveText('fixture-workspace');
  await expect(window.locator('.welcome__stats')).toContainText('已解析');
}

/**
 * e2e 隐藏窗口视口固定为 633×379（Renderer CSS px，约为 1280×820 的 2× 缩放）。
 * Agent 面板是文档流右列，默认展开会挤窄编辑区，侧栏文件列表可能被压到视口外
 * （实测 GPARAM/BND/MSB 均因此失败）。真实用户路径是「先收起 Agent 再浏览文件」，
 * 测试统一复刻它。
 */
async function closeAgentPanel(window) {
  const close = window.getByRole('button', { name: '关闭 Agent 面板' });
  if (await close.isVisible().catch(() => false)) {
    await close.click();
  }
}

async function selectFileItem(window, text) {
  await closeAgentPanel(window);
  await window.locator('.file-item', { hasText: text }).click();
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

  // 工作区打开后欢迎层必须让出编辑区，否则开始页与工作台被半透明层盖住。
  await expect(window.locator('.editor-welcome')).toBeHidden();
  await expect(window.locator('.project-overview')).toBeVisible();

  // 左侧不再有 .mode-tabs；顶部工作域栏存在且为 tablist。
  await expect(window.locator('.mode-tabs')).toHaveCount(0);
  const tabs = window.locator('[data-testid="domain-bar"] [role="tab"]');
  // R1 裁定（2026-08-14）：GPARAM 从领域顶栏移除（并入左侧「参数」逻辑库），
  // T3 裁定（2026-08-15）：行为 + 动画合并为「动作」，animation 从顶栏隐藏
  // （与 GPARAM 同口径），固定顺序快照 13 项。
  await expect(tabs).toHaveCount(13);
  await expect(tabs).toHaveText([
    /开始/, /PARAM/, /文本/, /事件/, /地图/, /脚本/, /动作/,
    /模型/, /纹理/, /材质/, /VFX/, /容器/, /文件/
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

  // 问题 14：顶栏不再有「文件」域入口；物理资源从开始侧栏资源树（.file-item）
  // 定位，不把 resourceKind 变成顶层按钮。
  const files = window.locator('.file-item');
  await expect(files.filter({ hasText: 'sfx/f0000.sfxbnd.dcx' })).toHaveCount(1);
  await expect(window.locator('[data-testid="start-sidebar-file-list"]')).toBeVisible();
  // 语义领域不渲染 Files 物理列表（.file-item），改走逻辑库。
  await window.locator('[data-domain="event"]').click();
  await expect(window.locator('.file-item')).toHaveCount(0);
  await expect(window.locator('[data-testid="domain-library-list"]')).toBeVisible();
  await expect(window.locator('[data-testid="domain-library-list"]')).toContainText('common.emevd');

  // PARAM 入口直接打开 GameParam 逻辑库工作台，仍不显示物理文件列表。
  await window.locator('[data-domain="param"]').click();
  await expect(window.locator('.file-item')).toHaveCount(0);
  // EVENT-30B 起事件源码工作台常驻挂载，裸 .workbench 命中两个元素：收窄到 PARAM 工作台。
  await expect(window.getByLabel('PARAM 工作台')).toBeVisible();
  await expect(window.getByLabel('PARAM 工作台')).toContainText('Params');
  expect(await window.locator('.domain-tab__count').count()).toBe(0);

  // R1 修正（用户裁定）：参数域侧栏是两级——只有 PARAM 与 GPARAM 两个常驻项，
  // GPARAM 默认折叠、点开才出现各 bank 子选项（不得把 gparam 平铺挤掉 gameparam）。
  const groupHeaders = window.locator('.library-group__header');
  await expect(groupHeaders).toHaveCount(2);
  await expect(groupHeaders.nth(0)).toContainText('PARAM');
  await expect(groupHeaders.nth(1)).toContainText('GPARAM');
  // GPARAM 默认折叠：组内 bank 不可见；PARAM 组展开可见 gameparam 容器。
  await expect(groupHeaders.nth(1)).toHaveAttribute('aria-expanded', 'false');
  await expect(window.locator('.library-group__body').nth(0)).toContainText('gameparam');
  await expect(window.locator('.library-group__body').nth(1).locator('.library-item')).toHaveCount(0);
  // 点开 GPARAM → bank 子选项出现。
  await groupHeaders.nth(1).click();
  await expect(groupHeaders.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(window.locator('.library-group__body').nth(1).locator('.library-item').first()).toBeVisible();
  await expect(window.locator('.library-group__body').nth(1)).toContainText('m10_00');

  // T3 裁定：行为 + 动画合并为「动作」域。顶栏只有「动作」；侧栏列 anibnd|tae
  // 逻辑库（显示名去扩展 c5030 / c0000，物理路径只进 title），不再出现 4 个
  // behbnd 的 BND4 形态。
  await window.locator('[data-domain="behavior"]').click();
  await expect(window.locator('.file-item')).toHaveCount(0);
  const actionLibrary = window.locator('[data-testid="domain-library-list"]');
  await expect(actionLibrary).toBeVisible();
  await expect(actionLibrary).toContainText('c5030');
  await expect(actionLibrary).toContainText('c0000');
  // 显示名去扩展：.library-item__name 精确等于 c0000 / c5030（扩展只在 meta）。
  await expect(actionLibrary.locator('.library-item__name')).toHaveText(['c0000', 'c5030']);

  await window.screenshot({ path: 'test-results/04-resource-bar.png' });
  await app.close();
});

test('开始侧栏资源树可定位 ai 资源，且不与 Agent 面板冲突', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 问题 14：资源从开始侧栏资源树定位（顶栏不再有「文件」域入口）。
  const files = window.locator('.file-item');
  await expect(files.filter({ hasText: 'ai/m10.aibnd.dcx' })).toHaveCount(1);

  // Agent 面板仍是独立右侧面板，中央没有占用 AI 页面。
  await expect(window.locator('.agent__composer textarea')).toBeVisible();
  // §12.3：Agent dock header 左侧产品名是 SoulForge（不是 "Agent"）。
  await expect(window.locator('.agent__header')).toContainText('SoulForge');
  await expect(window.locator('[data-testid="start-sidebar-file-list"]')).toBeVisible();
  await app.close();
});

test('BND 外形文件自动进入容器工作台；命令面板可强制以 BND4 打开', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // SHELL-09：物理浏览只在 Files 领域；容器领域不再有文件列表。
  await selectFileItem(window, 'chr/sample.chrbnd.dcx');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region;
  // 工作台根用 getByLabel,列级 section 仍用 getByRole('region')。
  await expect(window.getByLabel('BND4 容器工作台')).toBeVisible();

  // 非容器文件 + 命令面板「以 BND4 容器打开当前选择」。
  await selectFileItem(window, 'other/notes.txt');
  await expect(window.getByLabel('BND4 容器工作台')).toHaveCount(0);
  await window.keyboard.press('Control+k');
  await window.locator('.cmdk__input-wrap input').fill('BND4');
  await window.keyboard.press('Enter');
  await expect(window.getByLabel('BND4 容器工作台')).toBeVisible();

  await window.screenshot({ path: 'test-results/05-bnd-context.png' });
  await app.close();
});

test('脚本容器进入三栏工作台：明文按 encoding 显示，字节码只读字节视图', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // SCRIPT-41：脚本容器资源从开始侧栏资源树选择，进入三栏脚本工作台。
  await selectFileItem(window, 'script/m25_00_00_00.luabnd.dcx');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region。
  await expect(window.getByLabel('脚本容器工作台')).toBeVisible();

  // 三栏（不用四栏模板：无 Tools/Symbols 空栏）。
  await expect(window.getByRole('region', { name: 'Container / Files' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Source / 只读反汇编' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Metadata' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // 明文条目：中栏显示解码文本 + encoding/BOM/newline 明示。
  await window.getByRole('row', { name: /goal_list\.lua/ }).click();
  const source = window.getByRole('region', { name: 'Source / 只读反汇编' });
  await expect(source).toContainText('明文');
  await expect(source).toContainText('UTF-8');
  await expect(source).toContainText('CRLF 3');
  await expect(source).toContainText('goal_list.lua');

  // 字节码条目：编译产物，只展示只读字节视图，绝不伪装成可编辑源码。
  await window.getByRole('row', { name: /battle\.lua/ }).click();
  await expect(source).toContainText('编译产物，非明文源码');
  await expect(source).toContainText('字节码绝不显示为可编辑源码');

  await window.screenshot({ path: 'test-results/06-script-workbench.png' });
  await app.close();
});

test('MSB 地图工作台三栏：对象列表↔viewport↔属性联动，deferred 无写入口', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // MAP-50B：MSB 地图资源从开始侧栏资源树选择，进入三栏地图工作台。
  await selectFileItem(window, 'map/m10.msb.dcx');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region。
  await expect(window.getByLabel('MSB 地图工作台')).toBeVisible();

  // 三栏（§2.5，不用四栏模板：无 Tools 空栏）。
  await expect(window.getByRole('region', { name: 'Map Object List' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Viewport' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Properties' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // 左栏对象列表由 fixture 合成 DTO 派生：Model/Event/Region/Part 分组都有实体。
  const objectList = window.getByRole('region', { name: 'Map Object List' });
  await expect(objectList.getByText('c0000')).toBeVisible();
  await expect(objectList.getByText('e0000')).toBeVisible();
  await expect(objectList.getByText('r0000')).toBeVisible();
  await expect(objectList.getByText('p0000')).toBeVisible();

  // tree→inspector 联动：选中 part，右栏显示数值属性，viewport 报「已选择 part」。
  await objectList.getByRole('row', { name: /p0000/ }).click();
  const properties = window.getByRole('region', { name: 'Properties' });
  await expect(properties.getByRole('row', { name: /Position X/ })).toBeVisible();
  await expect(window.getByTestId('msb-selected-summary')).toContainText('已选择 part：p0000');

  // tree→viewport 联动跟随：选中 region，summary 与右栏属性一起切换。
  await objectList.getByRole('row', { name: /r0001/ }).click();
  await expect(window.getByTestId('msb-selected-summary')).toContainText('已选择 region：r0001');
  await expect(properties).toContainText('Position Z');

  // 问题4-B：地图工作台整条 footer（Δ 微调 / transform 输入 / 实时模式 /
  // 三个提交按钮）已移除；Properties 栏保持只读属性表。
  await expect(window.getByRole('button', { name: /提交 part 位置|提交 region 位置|提交 part transform/ })).toHaveCount(0);
  await expect(window.getByText(/实时模式/)).toHaveCount(0);
  await expect(window.locator('.workbench__footer')).toHaveCount(0);

  // resize/keyboard：分隔条可聚焦，方向键调宽真实生效（量 DOM 宽度前后）。
  // P1 裁定后方向键/拖拽受「其余栏 minWidth 之和」上限约束——窄窗口里其余栏
  // 下限已经吃满容器，加宽会被 clamp 正确拦住。隐藏窗口不重排，先 show 并把
  // 窗口放大（fixture 是 2× devicePixelRatio，2880 物理 ≈ 1440 CSS）再验证加宽。
  await showWindow(app);
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.setSize(2880, 1200);
  });
  await window.waitForTimeout(200);
  const resizer = window.getByRole('separator', { name: '调整Map Object List栏宽' });
  const widthBefore = await objectList.evaluate((el) => el.getBoundingClientRect().width);
  await resizer.focus();
  await window.keyboard.press('ArrowRight');
  const widthAfter = await objectList.evaluate((el) => el.getBoundingClientRect().width);
  expect(widthAfter).toBeGreaterThan(widthBefore);

  await window.screenshot({ path: 'test-results/14-msb-workbench.png' });
  await app.close();
});

test('FLVER 模型工作台三栏：树栈↔viewport↔属性联动，材质槽绑定 mesh，deferred 无写入口', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // MODEL-51B：FLVER 模型资源从开始侧栏资源树选择，进入三栏模型工作台。
  await selectFileItem(window, 'chr/c1000.flver');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region。
  await expect(window.getByLabel('FLVER 模型工作台')).toBeVisible();

  // 三栏（§2.5，不用四栏模板：无 Tools 空栏）。
  await expect(window.getByRole('region', { name: '模型层级' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Viewport' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Properties' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // 左树栈由 fixture 合成 envelope 的 pages 投影派生：网格/材质/纹理槽/骨骼四组。
  const hierarchy = window.getByRole('region', { name: '模型层级' });
  await expect(hierarchy.getByText('mesh[0]')).toBeVisible();
  await expect(hierarchy.getByText('mat_a')).toBeVisible();
  await expect(hierarchy.getByText('a.dds')).toBeVisible();
  await expect(hierarchy.getByText('root')).toBeVisible();

  // tree→inspector 联动：选中 mesh，右栏显示数值属性，viewport summary 报已同步。
  await hierarchy.getByRole('row', { name: /mesh\[0\]/ }).click();
  const properties = window.getByRole('region', { name: 'Properties' });
  await expect(properties).toContainText('顶点数');
  await expect(window.getByTestId('flver-viewport-summary')).toContainText('已选择 mesh[0]');

  // 材质槽 → viewport 高亮同步：选中材质，viewport 切到第一个引用该材质的 mesh。
  await hierarchy.getByRole('row', { name: /mat_a/ }).click();
  await expect(window.getByTestId('flver-viewport-summary')).toContainText('材质槽 mat_a 绑定 mesh[0]');
  await expect(properties).toContainText('MTD 路径');

  // 纹理槽同样经 materialIndex 绑定到 mesh。
  await hierarchy.getByRole('row', { name: /a\.dds/ }).click();
  await expect(window.getByTestId('flver-viewport-summary')).toContainText('材质槽 a.dds 绑定 mesh[0]');

  // deferred（V0.6 只读预览）：无保存动作，只有延期提示。
  await expect(window.getByRole('button', { name: /提交|保存|写入/ })).toHaveCount(0);
  await expect(window.getByText(/FLVER 编辑已延期至 V0.6/)).toContainText('只读预览');

  // resize/keyboard：分隔条可聚焦，方向键调宽真实生效（量 DOM 宽度前后）。
  // P1 裁定后方向键/拖拽受「其余栏 minWidth 之和」上限约束——窄窗口里其余栏
  // 下限已经吃满容器，加宽会被 clamp 拦住。隐藏窗口不重排，先 show 并把窗口
  // 放大（2× dpr，2880 物理 ≈ 1440 CSS）。
  await showWindow(app);
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.setSize(2880, 1200);
  });
  await window.waitForTimeout(200);
  const resizer = window.getByRole('separator', { name: '调整模型层级栏宽' });
  const widthBefore = await hierarchy.evaluate((el) => el.getBoundingClientRect().width);
  await resizer.focus();
  await window.keyboard.press('ArrowRight');
  const widthAfter = await hierarchy.evaluate((el) => el.getBoundingClientRect().width);
  expect(widthAfter).toBeGreaterThan(widthBefore);

  await window.screenshot({ path: 'test-results/15-flver-workbench.png' });
  await app.close();
});

test('Material 工作台三栏：File list → Material list → Properties/Values，unknown 只读，无 Preview 第四栏', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // MATERIAL-53B：MTD 材质资源从开始侧栏资源树选择，进入三栏材质工作台。
  await selectFileItem(window, 'material/materials.mtd');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region。
  await expect(window.getByLabel('Material 工作台')).toBeVisible();

  // 三栏（§2.5，无 viewport：不要发明 Preview 第四栏，无 Tools 空栏）。
  await expect(window.getByRole('region', { name: 'File list' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Material list' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Properties / Values' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Preview' })).toHaveCount(0);
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // File list 栏列出材质文件，显示名去 .mtd。
  const fileList = window.getByRole('region', { name: 'File list' });
  await expect(fileList.getByText('materials')).toBeVisible();

  // Material list 栏：材质来自 fixture envelope 的 pages 投影（material/textureReferences）。
  const materialList = window.getByRole('region', { name: 'Material list' });
  await expect(materialList.getByText('m_test_material')).toBeVisible();
  await expect(materialList.getByText('tex/base.dds')).toBeVisible();

  // Properties / Values 栏：值类型与 unknown readonly（值可见但无任何编辑控件）。
  const props = window.getByRole('region', { name: 'Properties / Values' });
  await expect(props.getByText('DiffuseIntensity')).toBeVisible();
  // known 属性值渲染为可编辑 input（MATERIAL-53C 写回），不再匹配 getByText——
  // 值断言走 input value（见下），这里保留类型标签断言。
  await expect(props.getByText(' · float').first()).toBeVisible();
  // unknown 属性必须可见（不能丢弃）：unkAttr 行出现且只读标记明确。
  await expect(window.getByTestId('mtd-unknown-prop')).toContainText('unkAttr（未识别）');
  await expect(window.getByTestId('mtd-unknown-prop')).toContainText('0x2a');
  // MATERIAL-53C 写回：known 属性可编辑输入框（blur/Enter 提交），unknown 保留且只读。
  const diffuseInput = window.getByLabel('DiffuseIntensity 值');
  await expect(diffuseInput).toBeVisible();
  await expect(diffuseInput).toHaveValue('0.8');
  await diffuseInput.fill('0.9');
  await diffuseInput.blur();
  await expect(window.getByTestId('mtd-commit-success')).toContainText('已保存 DiffuseIntensity 并重读验证');
  // 重读后输入框反映新值（fixture stub 就地更新 + 面板 refreshKey 重读）。
  await expect(diffuseInput).toHaveValue('0.9');
  // unknown 属性无编辑控件：readonly span，没有 input。
  await expect(window.getByTestId('mtd-unknown-prop').locator('input')).toHaveCount(0);

  // partial 缺口必须可见，不伪装成完整解析。
  await expect(window.getByTestId('mtd-partial-gaps')).toContainText('未识别结构 1 项');

  // 纹理引用选择链：点击引用，右侧显示引用元数据。
  await materialList.getByRole('row', { name: /tex\/base\.dds/ }).click();
  await expect(props.getByText('路径')).toBeVisible();
  const pathRow = props.locator('.wb-prop', { hasText: '路径' });
  await expect(pathRow.getByText('tex/base.dds', { exact: true })).toBeVisible();

  // 独立滚动：三个栏各自是滚动宿主（WorkbenchLayout 每栏 overflow-y auto）。
  // EVENT-30B 起事件源码工作台常驻挂载，全局计数会多算它的栏：收窄到 Material 工作台。
  const columnBodies = window.getByLabel('Material 工作台').locator('.workbench__column-body');
  await expect(columnBodies).toHaveCount(3);

  await window.screenshot({ path: 'test-results/16-material-workbench.png' });
  await app.close();
});

test('Behavior 工作台三栏：机器 → 状态 → 条件/转移选择链，partial 缺口可见', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // BEHAVIOR-55B：ESD 状态机资源从开始侧栏资源树选择，进入三栏行为工作台。
  await selectFileItem(window, 'ai/m10.esd');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region。
  await expect(window.getByLabel('Behavior 工作台')).toBeVisible();

  // 三栏（§10.3，无 Tools 空栏）。
  await expect(window.getByRole('region', { name: 'Files / Machines / States' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Conditions / Commands' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Inspector' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // 机器列表由 fixture envelope 的 pages 投影派生（不按 action 目录分类）。
  const left = window.getByRole('region', { name: 'Files / Machines / States' });
  await expect(left.getByText('状态组 0')).toBeVisible();
  await expect(left.getByText('状态组 1')).toBeVisible();
  await expect(left.getByText('全部语义状态')).toBeVisible();

  // machine → state：选中机器，States 组显示该机器状态摘要，中栏按机器过滤条件。
  await left.getByRole('row', { name: /状态组 0/ }).click();
  await expect(left.getByText('状态组 0 的状态')).toBeVisible();
  const middle = window.getByRole('region', { name: 'Conditions / Commands' });
  await expect(middle.getByText(/已按状态组 0 过滤/)).toBeVisible();
  await expect(middle.getByRole('row', { name: /条件 @0x10/ })).toBeVisible();

  // 条件（转移载体）选中 → Inspector 显示转移明细。
  await middle.getByRole('row', { name: /条件 @0x10/ }).click();
  const inspector = window.getByRole('region', { name: 'Inspector' });
  await expect(inspector.getByText('条件偏移')).toBeVisible();
  await expect(inspector.getByText('目标状态偏移')).toBeVisible();
  await expect(inspector.getByText('0x28')).toBeVisible();

  // BEHAVIOR-55C transition upsert：条件选中时出现「重定向目标偏移」编辑入口并提交。
  await expect(window.getByTestId('esd-transition-edit')).toBeVisible();
  const targetInput = window.getByLabel('重定向目标偏移');
  await expect(targetInput).toHaveValue('0x28');
  await targetInput.fill('0x50');
  await window.getByRole('button', { name: '提交转移目标' }).click();
  await expect(window.getByTestId('esd-transition-submit-notice')).toContainText('已提交转移目标并重读验证');
  // 提交后 Inspector 的目标状态偏移随 fixture stub 就地更新重读为 0x50。
  await expect(inspector.getByText('0x50')).toBeVisible();

  // 命令选中 → Inspector 显示命令明细（transition 编辑入口随条件切换消失）。
  await middle.getByRole('row', { name: /命令 10/ }).click();
  await expect(inspector.getByText('命令 ID')).toBeVisible();
  await expect(inspector.getByText('槽位')).toBeVisible();
  await expect(inspector.getByText('entry')).toBeVisible();
  await expect(window.getByTestId('esd-transition-edit')).toHaveCount(0);

  await window.screenshot({ path: 'test-results/17-behavior-workbench.png' });
  await app.close();
});

test('动作工作台三栏（TAE）：动画 → 词条事件选择链，事件参数体未解码边界明确', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // T3（2026-08-15）：行为 + 动画合并为「动作」。TAE 资源从开始侧栏资源树选择，
  // 进入三栏动作工作台（Animations | Events / 词条 + 详情 | 预览（只读））。
  await selectFileItem(window, 'action/c0000.tae');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region。
  await expect(window.getByLabel('动作工作台')).toBeVisible();

  // 三栏（grok T3，无 Inspector 第三栏 / 无 Tools 空栏 / 无时间轴图）。
  await expect(window.getByRole('region', { name: 'Animations' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Events / 词条' })).toBeVisible();
  await expect(window.getByRole('region', { name: '预览（只读）' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Inspector' })).toHaveCount(0);
  await expect(window.getByRole('region', { name: 'Timeline / Events' })).toHaveCount(0);
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // 动画列表由 fixture envelope 的 pages 投影派生（不按 chr/action 目录分类），
  // hkxName 去扩展作主标签。
  const left = window.getByRole('region', { name: 'Animations' });
  await expect(left.getByRole('row', { name: /a0000/ })).toBeVisible();
  // S17：无 hkxName 的动画行名改用干净数字 id（禁止「动画 N」）——第二动画行
  // 显示为「1」（meta「1 事件」），不再是「动画 1」。
  await expect(left.getByRole('row', { name: /1 事件/ })).toBeVisible();

  // 未选中动画时中栏提示先选动画，不出事件行。
  const middle = window.getByRole('region', { name: 'Events / 词条' });
  await expect(window.getByTestId('tae-events-pick-animation')).toBeVisible();

  // 选中动画 0 → 中栏词条事件列表。
  await left.getByRole('row', { name: /a0000/ }).click();
  await expect(middle.getByText(/词条 · 动画 0/)).toBeVisible();
  await expect(middle.getByRole('row', { name: /1 未命名/ })).toBeVisible();
  // 问题4-C：词条行 meta 是帧区间（主单位帧）。
  await expect(middle.getByRole('row', { name: /帧 0–30/ })).toBeVisible();

  // 问题4-C：选中词条事件 → 详情收在 Events 栏下半（可关抽屉），只留一套起始/结束帧。
  await middle.getByRole('row', { name: /1 未命名/ }).click();
  const details = window.getByTestId('tae-details');
  await expect(details).toBeVisible();
  // 起始帧 / 结束帧各出现一次（主单位帧，旁边小字 ≈ 秒）。
  await expect(details.getByText('起始帧')).toHaveCount(1);
  await expect(details.getByText('结束帧')).toHaveCount(1);
  await expect(details.getByText('事件类型', { exact: true })).toBeVisible();
  await expect(details.getByText('事件下标')).toBeVisible();
  // 事件参数体未解码边界必须明示（不伪装成完整解析）。
  await expect(details.getByText('参数体', { exact: true })).toBeVisible();
  await expect(details.getByText(/未解码/)).toBeVisible();

  // 右栏是只读预览空态 + 诊断（不挂伴生 chrbnd 的 FLVER）。
  await expect(window.getByTestId('tae-preview-unavailable')).toBeVisible();
  await expect(window.getByTestId('tae-preview-unavailable')).toContainText('预览不可用');
  // 右栏始终只读：无输入、无按钮。
  const preview = window.getByRole('region', { name: '预览（只读）' });
  await expect(preview.locator('input, button')).toHaveCount(0);

  // 问题4-C：详情必须能关——点 × 关闭后详情不在，回到该动画。
  await window.getByRole('button', { name: '关闭词条详情' }).click();
  await expect(window.getByTestId('tae-details')).toHaveCount(0);

  // ANIMATION-56C event write：详情里的时间编辑入口——输入按帧编辑，提交 /30 换秒。
  await middle.getByRole('row', { name: /1 未命名/ }).click();
  await expect(window.getByTestId('tae-event-editor')).toBeVisible();
  const startInput = window.getByLabel('新起始帧');
  await expect(startInput).toHaveValue('0');
  await startInput.fill('15'); // 0.5 秒 × 30 = 帧 15
  await window.getByRole('button', { name: '更新事件时间' }).click();
  await expect(window.getByTestId('tae-write-notice')).toContainText('事件时间已更新并重读验证');

  await window.screenshot({ path: 'test-results/18-animation-workbench.png' });
  await app.close();
});

test('问题4-D：动作工作台动画长列表全量渲染，栏内可滚到最后一条', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 长列表 fixture：213 个动画（超旧 ANIMATION_RENDER_LIMIT=200，硬规则 10 不许砍、
  // 不许虚拟滚动）。
  await selectFileItem(window, 'action/c9999.tae');
  await expect(window.getByLabel('动作工作台')).toBeVisible();

  const left = window.getByRole('region', { name: 'Animations' });
  // 栏头 hint 报真实总数（213 animations），不是被砍掉的 200。
  await expect(left.getByText('213 animations')).toBeVisible();
  // 全量渲染：Animations 栏里 213 个动画行都进 DOM，不许 slice(0, 200)。
  await expect(left.getByRole('row')).toHaveCount(213);
  // 行主标签是完整 hkx 茎（a999_000000…），不是裁成首字母的 `a`。
  await expect(left.getByRole('row', { name: /a999_000000/ })).toBeVisible();
  // 栏内能滚到最后一条（213 条的最后），证明列表没有被砍掉末尾。
  // scrollIntoViewIfNeeded 在 overflow-y:auto 的列表容器里把末行滚进视口。
  const lastRow = left.getByRole('row', { name: /a999_000212/ });
  await lastRow.scrollIntoViewIfNeeded();
  await expect(lastRow).toBeVisible();

  await window.screenshot({ path: 'test-results/18d-tae-long-list.png' });
  await app.close();
});

test('anibnd 容器打开走动作工作台：不落 BND4 容器页，提取来源诊断可见', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // grok T3 完成标准：点 c5030 是动作/词条/预览，不是 hkx/BND4 表。
  // 从动作域侧栏选 anibnd 逻辑库（去扩展显示 c5030），单击打开。
  await window.locator('[data-domain="behavior"]').click();
  await window.locator('.library-item', { hasText: 'c5030' }).click();
  await expect(window.getByLabel('动作工作台')).toBeVisible();
  // 禁止落 BND4 通用容器页。
  await expect(window.getByLabel('BND4 容器工作台')).toHaveCount(0);

  // 三栏就位 + 动画列表（hkxName 去扩展：a000_003013）。
  const left = window.getByRole('region', { name: 'Animations' });
  await expect(left.getByRole('row', { name: /a000_003013/ })).toBeVisible();
  await expect(left.getByText(/anibnd/)).not.toBeVisible();

  // 提取来源诊断在右栏预览区可见（TAE_FROM_ANIBND_EXTRACTED）。
  await expect(window.getByTestId('tae-preview-diagnostics')).toBeVisible();

  // 选中动画 0 → 中栏词条事件列表可用（动作/词条/预览三栏联动）。
  await left.getByRole('row', { name: /a000_003013/ }).click();
  const middle = window.getByRole('region', { name: 'Events / 词条' });
  // S17：词条行名是「eventTypeId + 模板名」，fixture 无模板目录 → 「7 未命名」。
  await expect(middle.getByRole('row', { name: /7 未命名/ }).first()).toBeVisible();

  await window.screenshot({ path: 'test-results/18b-anibnd-action-workbench.png' });
  await app.close();
});

test('VFX 工作台三栏：Effect / Particle list → 真实预览空态 → Inspector，known/unknown node 明确', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // VFX-54B：FXR 特效资源从开始侧栏资源树选择，进入三栏 VFX 工作台。
  await selectFileItem(window, 'sfx/f0000.fxr');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region。
  await expect(window.getByLabel('VFX 工作台')).toBeVisible();

  // 三栏（§10.5，无 Tools 空栏）。
  await expect(window.getByRole('region', { name: 'Effect / Particle list' })).toBeVisible();
  await expect(window.getByRole('region', { name: '真实预览' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Inspector' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // Effect 节点树由 fixture envelope 的 effect 页投影派生（不按 sfx 目录分类）。
  const left = window.getByRole('region', { name: 'Effect / Particle list' });
  await expect(left.getByRole('row', { name: /type 2000/ })).toBeVisible();
  await expect(left.getByRole('row', { name: /type 2200/ })).toBeVisible();

  // known/unknown：未知类型节点（9999）明确标出，不给假数据。
  await expect(left.getByText('未知类型').first()).toBeVisible();
  await expect(left.getByRole('row', { name: /type 9999/ })).toBeVisible();

  // 真实预览是诚实空态（preview isolation + no fake graph）：预览区无 canvas。
  // （P6 裁定后全窗口有 AmbientField 流光 canvas，断言必须收窄到预览区内，
  //   不能再数 window 级 canvas。）
  const preview = window.getByRole('region', { name: '真实预览' });
  await expect(preview.getByTestId('vfx-preview-empty')).toContainText('没有可用的实时预览渲染器');
  await expect(preview.locator('canvas')).toHaveCount(0);

  // selection chain：选中已知节点 → Inspector 显示节点结构字段。
  await left.getByRole('row', { name: /type 2000/ }).click();
  const inspector = window.getByRole('region', { name: 'Inspector' });
  await expect(inspector.getByText('typeId')).toBeVisible();
  await expect(inspector.getByText('已知类型')).toBeVisible();
  await expect(inspector.getByText('childCount')).toBeVisible();

  // 选中未知节点 → Inspector 明确标 blocked，不给字段含义假数据。
  await left.getByRole('row', { name: /type 9999/ }).click();
  await expect(inspector.getByTestId('vfx-unknown-node-block')).toContainText('未识别');
  await expect(inspector.getByText('未知类型（未识别，不给字段含义假数据）')).toBeVisible();

  // preview isolation：选择节点后预览栏仍是诚实空态（不出现假预览）。
  await expect(preview.getByTestId('vfx-preview-empty')).toContainText('没有可用的实时预览渲染器');

  // Particles（host）：未知 host 也标出。
  await expect(left.getByRole('row', { name: /host 7777/ })).toBeVisible();

  // partial 缺口必须可见，不伪装成完整解析。
  await expect(window.getByTestId('vfx-partial-gaps')).toContainText('未解析区间 4 项');

  // VFX-54C field write：选中 known host（host 0）出现值编辑行 +「写回」按钮。
  // 文档是 partial（含 unknown-type gap），known-layout 门未满 → 编辑控件为禁用态，
  // 不做假写回（fail-closed，镜像 C# EnsureKnownLayout）。
  await left.getByRole('row', { name: /^host 0/ }).click();
  await expect(window.getByTestId('vfx-known-host')).toHaveAttribute('aria-selected', 'true');
  // Inspector 顶部 hint 也显示 selection.label（host 0），group-label 与 hint 文案相同，
  // getByText 会 strict 违规——精确匹配 group 标签。
  await expect(inspector.locator('.wb-list__group-label').filter({ hasText: /^host 0$/ })).toBeVisible();
  const vfxValueInput = window.locator('[data-testid^="vfx-value-input-"]').first();
  await expect(vfxValueInput).toBeVisible();
  await expect(vfxValueInput).toBeDisabled();
  await expect(window.locator('[data-testid^="vfx-value-submit-"]').first()).toBeDisabled();
  await expect(window.getByTestId('vfx-write-blocked')).toBeVisible();
  // unknown host（7777）选中：明确标 blocked，无任何编辑控件。
  await left.getByRole('row', { name: /host 7777/ }).click();
  await expect(window.getByTestId('vfx-unknown-host-block')).toBeVisible();
  await expect(window.locator('[data-testid^="vfx-value-input-"]')).toHaveCount(0);

  await window.screenshot({ path: 'test-results/19-vfx-workbench.png' });
  await app.close();
});

test('变更状态机：候选 → 批准 → 暂存 → 校验 → 写入', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // SHELL-09：文本领域不渲染物理浏览器；msg 文件从开始侧栏资源树选择。
  await selectFileItem(window, 'msg/test.msgbnd.dcx');

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
  // S12 移除状态栏：写入反馈的现行载体是 toast（App.commitStagedChanges → pushToast）。
  await expect(window.locator('.toast-root')).toContainText('写入完成');

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
  // §14.1-5 浮层证据：cmdk/modal 在流光溢彩白下的呈现（非行为改动，仅捕获）。
  await window.screenshot({ path: 'test-results/12-cmdk-modal-light.png' });
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

  await selectFileItem(window, 'msg/test.msgbnd.dcx');

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

  await selectFileItem(window, 'msg/test.msgbnd.dcx');
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

test('TEXT-20B：§9.1 文本工作台（左 Categories + 右上 Entries + 右下 Text）走完 language→container→table→entry→content 全链', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 从开始侧栏资源树打开 msgbnd：目录链自动定位到该容器第一个表（item.fmg）。
  await selectFileItem(window, 'msg/test.msgbnd.dcx');

  const fmgPanel = window.getByRole('region', { name: 'FMG 本地化工作台' });
  await expect(fmgPanel).toBeVisible();

  // §9.1 拓扑（S13）：左 Text Categories + 中 Text Entries + 右 Text 三栏竖排。
  const columns = fmgPanel.locator('.workbench__column');
  await expect(columns).toHaveCount(3);
  await expect(columns.nth(0).locator('.workbench__column-title')).toContainText('Text Categories');
  await expect(columns.nth(1).locator('.workbench__column-title')).toContainText('Text Entries');
  await expect(columns.nth(2).locator('.workbench__column-title')).toHaveText('Text');
  const entriesPane = fmgPanel.getByRole('region', { name: 'Text Entries' });
  await expect(entriesPane.locator('h3')).toContainText('Text Entries');

  // 11-B：目录按容器分组 —— item / menu 两组必须同时在场（组头可见、可点），
  // 每组下面有自己的表行；menu 不再被埋成「item 的续集」。
  await expect(fmgPanel.getByRole('button', { name: 'item 组' })).toBeVisible();
  await expect(fmgPanel.getByRole('button', { name: 'menu 组' })).toBeVisible();
  await expect(fmgPanel.getByRole('row', { name: /item\.fmg/ })).toBeVisible();
  await expect(fmgPanel.getByRole('row', { name: /menu\.fmg/ })).toBeVisible();

  // 自动定位命中 item.fmg：条目 100/101 立即可见，选中后可编辑。
  const row100 = fmgPanel.getByRole('row', { name: /伤药葫芦/ });
  await expect(row100).toBeVisible();
  await row100.click();
  await expect(window.locator('label', { hasText: '编辑 ID 100' }).locator('textarea')).toBeVisible();

  // 切换表 → 父级切换清理：item.fmg 的条目被清空；menu.fmg 真空表显示空态而非失败。
  await fmgPanel.getByRole('row', { name: /menu\.fmg/ }).click();
  const entriesColumn = fmgPanel.getByRole('region', { name: 'Text Entries' });
  await expect(entriesColumn).toContainText('当前页无条目');
  await expect(entriesColumn).not.toContainText('伤药葫芦');
  await expect(entriesColumn).not.toContainText('danger');

  // 切回 item.fmg：条目恢复（清理不破坏切回路径）。
  await fmgPanel.getByRole('row', { name: /item\.fmg/ }).click();
  await expect(fmgPanel.getByRole('row', { name: /伤药葫芦/ })).toBeVisible();

  // 无匹配搜索与真空表分离：搜索无命中显示「没有匹配的条目」。
  await entriesColumn.locator('input[aria-label="筛选 FMG"]').fill('zzz-无此文本');
  await expect(entriesColumn).toContainText('没有匹配的条目');
  await entriesColumn.locator('input[aria-label="筛选 FMG"]').fill('');

  // Negative DOM：文本目录树不出现 tpf/texbnd（S13 左栏已无 Tools 空态文案）。
  const workbenchText = await fmgPanel.innerText();
  expect(workbenchText).not.toContain('.tpf');
  expect(workbenchText).not.toContain('texbnd');

  await window.screenshot({ path: 'test-results/text-20b-s91-topology.png' });
  await app.close();
});

test('TEXT-20C：真空表新增直写落盘，写按 tableId 路由且 sibling 表不被改动（S29 直写）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 从开始侧栏资源树打开 msgbnd：TEXT-20C 起 live 门禁以 sourceHash 为准，真空表也 live。
  await selectFileItem(window, 'msg/test.msgbnd.dcx');
  const fmgPanel = window.getByRole('region', { name: 'FMG 本地化工作台' });
  await expect(fmgPanel).toBeVisible();

  // menu.fmg 是真空表：显示「当前页无条目」而非失败（真空表 ≠ 不可编辑）。
  await fmgPanel.getByRole('row', { name: /menu\.fmg/ }).click();
  const entriesTable = fmgPanel.locator('.binder-child-table');
  await expect(entriesTable).toContainText('当前页无条目');

  // 新增一条：面板生成 id=1 空条目并自动选中（进入编辑态）。
  await fmgPanel.getByRole('region', { name: 'Text Entries' }).getByRole('button', { name: '新增' }).click();
  const editor = window.locator('label', { hasText: '编辑 ID 1' }).locator('textarea');
  await expect(editor).toBeVisible();
  await editor.fill('菜单说明·新增');

  // S29：编辑直写，不先进审查队列。换表触发的 commitDraft 把 id=1 的 upsert 经
  // applyFmgMutation（带 tableId）落到 fixture 的 menu 表。
  await fmgPanel.getByRole('row', { name: /item\.fmg/ }).click();
  await expect(fmgPanel.getByRole('row', { name: /伤药葫芦/ })).toBeVisible();

  // 切回 menu.fmg 重读：新增条目自 fixture.menuEntries 可见（真空表写后不被伪装回 0 条）。
  await fmgPanel.getByRole('row', { name: /menu\.fmg/ }).click();
  await expect(entriesTable).toContainText('菜单说明·新增');

  // sibling：menu 写不触及 item.fmg，100/101 仍在。
  await fmgPanel.getByRole('row', { name: /item\.fmg/ }).click();
  await expect(fmgPanel.getByRole('row', { name: /伤药葫芦/ })).toBeVisible();

  await window.screenshot({ path: 'test-results/text-20c-empty-table-write.png' });
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
  const history = window.locator('.agent-secondary-drawer:not(.is-hidden)');
  await expect(history).toContainText('Agent 历史');
  await history.getByRole('button', { name: '模型设置' }).click();
  await expect(window.locator('.agent-secondary-drawer:not(.is-hidden)')).toContainText('模型服务设置');

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
  await window.locator('.agent-secondary-drawer:not(.is-hidden)').getByRole('button', { name: '模型设置' }).click();
  await expect(window.locator('#agent-provider')).toHaveValue('openai');
  await expect(window.locator('#agent-thinking')).toHaveValue('deep');

  await window.screenshot({ path: 'test-results/06-agent-settings.png' });
  await app.close();
});

test('模型服务高级选项：默认收起，展开可配置采样参数并保存；可拉取模型列表', async () => {
  const { app, window } = await launchApp();
  await window.getByRole('button', { name: '打开 Agent 历史' }).click();
  const history = window.locator('.agent-secondary-drawer:not(.is-hidden)');
  await history.getByRole('button', { name: '模型设置' }).click();
  const drawer = window.locator('.agent-secondary-drawer:not(.is-hidden)');
  const advanced = drawer.getByTestId('model-service-advanced');

  // 高级选项默认收起：details 无 open 属性，内部控件不可见。
  await expect(advanced).toBeVisible();
  expect(await advanced.evaluate((el) => el.open)).toBe(false);
  await expect(advanced.getByLabel('思考强度')).not.toBeVisible();

  // 点击「高级选项」展开。
  await advanced.locator('summary').click();
  expect(await advanced.evaluate((el) => el.open)).toBe(true);
  await expect(advanced.getByLabel('思考强度')).toBeVisible();

  // 配置采样参数：思考强度 deep、上下文/输出长度、temperature/topP/topK、embedding。
  await advanced.getByLabel('思考强度').selectOption('deep');
  await advanced.getByLabel('上下文长度（token）').fill('16000');
  await advanced.getByLabel('输出长度（token）').fill('2048');
  await advanced.getByLabel('temperature').fill('0.7');
  await advanced.getByLabel('topP').fill('0.9');
  await advanced.getByLabel('topK').fill('5');
  await advanced.getByLabel('Embedding 模型').fill('fixture-embed-model');

  // 保存：fixture upsert echo 输入，状态文案确认保存成功。填密钥让
  // fixture 返回 hasCredential=true（「生成向量索引」按钮依赖它）。
  await drawer.getByLabel('API 密钥（仅写入，不回显）').fill('fixture-api-key');
  await drawer.getByRole('button', { name: '保存模型服务' }).click();
  await expect(drawer).toContainText('已保存模型服务：本地兼容模型服务');

  // 获取模型列表：fixture 返回两个可用模型，datalist 填入可选项。
  await drawer.getByRole('button', { name: '获取模型列表' }).click();
  await expect(drawer).toContainText('找到 2 个可用模型');
  await expect(drawer.locator('datalist option')).toHaveCount(2);

  // 已保存服务带 embedding 模型：列表项显示 embedding 标记与「生成向量索引」按钮。
  await expect(drawer.locator('.list')).toContainText('embedding: fixture-embed-model');
  await drawer.getByRole('button', { name: '生成向量索引' }).click();
  await expect(drawer).toContainText('向量索引完成：6 个块（失败 0），模型 fixture-embed-model，维度 384。');

  await window.screenshot({ path: 'test-results/06b-model-service-advanced.png' });
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
  await closeAgentPanel(cancelled.window);
  // 与 openFixtureWorkspace 同因：侧栏与开始页各有一个同名按钮，收窄到开始页。
  await cancelled.window.getByRole('region', { name: '开始' }).getByTestId('open-workspace').click();
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
  // T2：开始页按钮在中央编辑区。隐藏窗口（show:false）下 Chromium 节流
  // BeginFrame，Agent 折叠的 margin-right 过渡恒停在 0 —— dock 仍占 440px 且
  // 重叠中央区，把开始页按钮压成 34px 竖条、中心落在视口外。先显示窗口让过渡
  // 真正跑完，再收 Agent（与其他用例一致的「先收起 Agent 再操作」路径）。
  await showWindow(app);
  await closeAgentPanel(window);

  // 资源浏览器显示运行表面降级提示。
  await expect(window.locator('.runtime-notice')).toContainText('浏览器预览：文件系统功能仅在 SoulForge 桌面版可用');

  // 两个目录按钮保持可聚焦，标记 aria-disabled。
  // 侧栏与开始页各有一个 open-workspace 按钮，收窄到开始页 region。
  const openWorkspaceButton = window.getByRole('region', { name: '开始' }).getByTestId('open-workspace');
  // 侧栏与开始页各有一个 choose-base-directory 按钮，同样收窄到开始页 region。
  const chooseBaseButton = window.getByRole('region', { name: '开始' }).getByTestId('choose-base-directory');
  await expect(openWorkspaceButton).toHaveAttribute('aria-disabled', 'true');
  await expect(chooseBaseButton).toHaveAttribute('aria-disabled', 'true');

  // 显示窗口后 Agent 折叠过渡开始跑，但点击若抢在过渡完成前会落在 dock 上
  // （中心仍被 .agent 覆盖），toast 永不出现。等按钮回到可点击几何再 force click。
  await expect.poll(async () => (await openWorkspaceButton.boundingBox())?.width ?? 0).toBeGreaterThan(100);

  // 点击或回车均有明确反馈（toast + 状态栏），不抛异常。
  // aria-disabled 按钮保持可触发：force 绕过 Playwright 的 enabled 等待。
  await openWorkspaceButton.click({ force: true });
  await expect(window.locator('.toast--warn')).toContainText('浏览器预览：「打开 Mod 工作区」仅在 SoulForge 桌面版可用');
  // 键盘路径：按钮可聚焦，Enter 触发同一降级反馈。
  await chooseBaseButton.evaluate((element) => element.focus());
  await expect(chooseBaseButton).toBeFocused();
  await window.keyboard.press('Enter');
  // S12 移除状态栏：降级反馈的现行载体是 toast（announceDesktopOnly → pushToast warn）。
  await expect(window.locator('.toast-root')).toContainText('浏览器预览：「选择原版目录」仅在 SoulForge 桌面版可用');

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
    // 窄屏仍可定位物理资源：开始侧栏资源树全量列出（≤ START_SIDEBAR_FILE_LIMIT）。
    // 22 = fixture 合成样本数
    // （PARAM-10B 加 gameparam.parambnd.dcx，GPARAM-11B 加 3 个 gparam.dcx，
    // EVENT-30B 加 event/menu.emevd，SCRIPT-41 加 script/m25_00_00_00.luabnd.dcx，
    // MAP-50B 加 map/m10.msb.dcx，MODEL-51B 加 chr/c1000.flver，TEXTURE-52B 加
    // menu/start.tpf.dcx 与 menu/broken.tpf.dcx 从 16 变 18，MATERIAL-53B 加
    // material/materials.mtd、BEHAVIOR-55B 加 ai/m10.esd 从 18 变 20，VFX-54B 加
    // sfx/f0000.fxr 从 20 变 21，T3 加 chr/c5030.anibnd.dcx 从 21 变 22）。
    await expect(window.locator('.file-item')).toHaveCount(22);
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
  // S33 移除活动栏四图标后「资源浏览器」按钮已不存在；只测现行 domain tab。
  const shadowOf = (locator) => locator.evaluate((element) => getComputedStyle(element).boxShadow);

  // rest：与背景融合，无阴影。
  expect(await shadowOf(tab)).toBe('none');
  await window.screenshot({ path: 'test-results/09-buttons-rest.png' });

  // hover：出现低层阴影与轻微表面差（真实指针输入偶发竞态，轮询重试）。
  await expect.poll(async () => {
    await tab.hover();
    await window.waitForTimeout(250);
    return shadowOf(tab);
  }, { timeout: 8000 }).not.toBe('none');
  // §13.2「focus-visible 与 hover 可区分」：hover 只走阴影通道，不冒用键盘焦点环。
  expect(await tab.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');
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
  // §13.2「focus-visible 与 hover 可区分」双向互斥：键盘焦点时把指针移开，不残留
  // hover 阴影（pointer 反馈不属于键盘导航），焦点环在键盘通道独立成立。CSS 若把
  // hover 阴影挂到 :focus-visible 上，这里会读到非 none 而红。
  await window.mouse.move(8, 8);
  await expect.poll(
    () => tab.evaluate((element) => getComputedStyle(element).boxShadow),
    { timeout: 5000 }
  ).toBe('none');
  const focusOnly = await tab.evaluate((element) => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, outline: style.outlineStyle };
  });
  expect(focusOnly.shadow).toBe('none');
  expect(focusOnly.outline).toBe('solid');
  await window.screenshot({ path: 'test-results/09-buttons-focus-visible.png' });

  await app.close();
});

test('主题 token：暗/亮主题代表性按钮 computed 值不串用', async () => {
  const { app, window } = await launchApp();
  await showWindow(app);
  await openFixtureWorkspace(window);

  const tab = window.locator('[data-domain="event"]');
  const readStates = async () => {
    // 先移开指针，确保读到真正的静止态（不被上一轮 hover 污染）。hover 离开后
    // box-shadow 走 transition（--dur-micro），负载下固定 250ms 等待偶发不够——
    // 全量串行跑时实测 rest 读到 hover 阴影的过渡中间帧。轮询等它真正落回 none
    // 再采，把「过渡未完成」从「rest 本就有阴影」里剥出来。
    await window.mouse.move(8, 8);
    await expect.poll(
      () => tab.evaluate((element) => getComputedStyle(element).boxShadow),
      { timeout: 5000 }
    ).toBe('none');
    const rest = await tab.evaluate((element) => {
      const style = getComputedStyle(element);
      return { shadow: style.boxShadow, color: style.color };
    });
    // hover 的 shadow/background/color 必须取「判定非 none」的同一帧：在 poll fn 内
    // 同步写入外部变量，poll 通过后读到的就是判定的那帧。此前 poll 判定后再次
    // evaluate，两个时刻之间 hover 状态可能回落，偶发读到 stale 的 none。
    let latest = { shadow: 'none', background: '', color: '' };
    await expect.poll(async () => {
      await tab.hover();
      await window.waitForTimeout(250);
      latest = await tab.evaluate((element) => {
        const style = getComputedStyle(element);
        return { shadow: style.boxShadow, background: style.backgroundColor, color: style.color };
      });
      return latest.shadow;
    }, { timeout: 8000 }).not.toBe('none');
    return {
      restShadow: rest.shadow,
      restColor: rest.color,
      hoverShadow: latest.shadow,
      hoverBackground: latest.background,
      hoverColor: latest.color
    };
  };

  // 显式强制暗色读一组 token：默认主题现在是流光溢彩白（light），
  // 本用例不依赖默认值，只验证 dark 路径的 token 仍可用、且与 light 不串用。
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
  // §13.2「light 与 dark 的 computed background/foreground 不串用」：
  // 前景色 token 也在两主题间切换（light 深墨 / dark 浅墨），不能「亮背景配
  // 暗色前景」把文字读不出来（此前只断言了背景通道，前景缺失）。
  expect(light.restColor).not.toBe(dark.restColor);
  expect(light.hoverColor).not.toBe(dark.hoverColor);

  await window.screenshot({ path: 'test-results/10-theme-light.png' });
  await app.close();
});

test('主题首帧：默认流光溢彩白，Electron 背景与窗口按钮区无暗色闪帧（§13.2）', async () => {
  const { app, window } = await launchApp();
  await showWindow(app);

  // 渲染器首帧即 light：index.html 静态 data-theme="light"，早于 App 的 useEffect。
  expect(await window.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

  // Electron 窗口背景与 light 画布同值（#FBFBF9），首帧不闪暗色。
  const platform = await app.evaluate(() => process.platform);
  const background = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor()
  );
  expect(background.toLowerCase()).toBe('#fbfbf9');
  // 暗色窗口按钮区只在 Windows 的 titleBarOverlay 上是真实风险；Electron 43 读不回
  // overlay 颜色（getTitleBarOverlay 不存在），改由渲染器侧的 Window Controls Overlay
  // API 确认 overlay 已激活（窗口按钮画在 overlay 区），颜色靠 fixture 镜像生产 +
  // 截图人工确认（main/index.ts TITLEBAR_OVERLAY #FBFBF9/#383C42）。
  if (platform === 'win32') {
    const wco = await window.evaluate(() => {
      const api = navigator.windowControlsOverlay;
      return api ? { visible: api.visible } : null;
    });
    expect(wco).not.toBeNull();
    expect(wco.visible).toBe(true);
  }

  await window.screenshot({ path: 'test-results/11-first-frame-light.png' });
  await app.close();
});

test('主题 ambient：流光层不拦截指针，reduced-motion 下不持续动画（§13.2）', async () => {
  const { app, window } = await launchApp();
  await showWindow(app);

  const ambient = await window.evaluate(() => {
    const canvas = document.getElementById('sf-ambient-field');
    const before = getComputedStyle(document.body, '::before');
    const after = getComputedStyle(document.body, '::after');
    const canvasStyle = canvas ? getComputedStyle(canvas) : null;
    return {
      mode: document.documentElement.dataset.ambient ?? 'css',
      canvasPointer: canvasStyle?.pointerEvents ?? null,
      canvasZ: canvasStyle?.zIndex ?? null,
      beforePointer: before.pointerEvents,
      afterPointer: after.pointerEvents,
      beforeZ: before.zIndex,
      name: before.animationName,
      duration: before.animationDuration,
      iteration: before.animationIterationCount
    };
  });
  if (ambient.mode === 'shader') {
    expect(ambient.canvasPointer).toBe('none');
    expect(Number(ambient.canvasZ)).toBe(0);
  } else {
    expect(ambient.beforePointer).toBe('none');
    expect(ambient.afterPointer).toBe('none');
    expect(ambient.beforeZ).toBe('0');
    expect(ambient.name).toBe('sf-ambient-a');
    expect(ambient.duration).toBe('58s');
    expect(ambient.iteration).toBe('infinite');
  }

  await window.emulateMedia({ reducedMotion: 'reduce' });
  // emulateMedia resolve ≠ 渲染器已应用 reduced-motion：shader 分支要在下一帧 rAF draw
  // 里才写 canvas.dataset.ambientMotion，css 分支要等样式 recalc。直接读会抢到旧值
  //（实测 shader 3/3 翻车，css 分支同样概率性失败），先等条件成立再断言。
  const reducedMode = await window.evaluate(() => document.documentElement.dataset.ambient ?? 'css');
  if (reducedMode === 'shader') {
    await expect.poll(() =>
      window.evaluate(() => document.getElementById('sf-ambient-field')?.dataset.ambientMotion ?? null)
    ).toBe('off');
  } else {
    await expect.poll(() =>
      window.evaluate(() => {
        const before = getComputedStyle(document.body, '::before');
        return {
          duration: parseFloat(before.animationDuration),
          iteration: before.animationIterationCount
        };
      })
    ).toMatchObject({ iteration: '1' });
    const before = await window.evaluate(() => getComputedStyle(document.body, '::before'));
    expect(before.animationIterationCount).toBe('1');
    expect(parseFloat(before.animationDuration)).toBeLessThan(0.1);
  }

  await window.screenshot({ path: 'test-results/12-ambient-reduced-motion.png' });
  await app.close();
});

test('主题表面：普通 pane/数据行/主工作台去卡片化，无圆角浮块（§13.2）', async () => {
  // 与「变更状态机」同配方（不开 showWindow）：computed style 采样不依赖 BeginFrame
  // 解冻，保持与既有 FMG 流程完全一致，避免隐藏/显示窗口带来的布局差异。
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 复用变更状态机配方：打开 FMG 工作台并造一个 draft 变更，让 .workbench、
  // .binder-child-row 与 .cq-row 同时在场；.viewer-content .panel 若存在则一并采样。
  await selectFileItem(window, 'msg/test.msgbnd.dcx');
  await window.getByRole('row', { name: /伤药葫芦/ }).click();
  const editor = window.locator('label', { hasText: '编辑 ID 100' }).locator('textarea');
  await expect(editor).toBeVisible();
  await editor.fill('伤药葫芦·改');
  await expect(window.locator('.change-queue .cq-row')).toHaveCount(1);

  const sampled = await window.evaluate(() => {
    const selectors = ['.workbench', '.viewer-content .panel', '.binder-child-row', '.cq-row'];
    const rows = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const s = getComputedStyle(el);
        rows.push({
          selector,
          radius: s.borderRadius,
          shadow: s.boxShadow,
          // 选中行的 inset 余火指示是 §8.3 双通道（软底+2px 接缝），不属于卡片
          // 阴影；去卡片化只约束「常驻圆角 + 浮块阴影」，选中指示不在其列。
          selected: el.classList.contains('selected') || el.getAttribute('aria-selected') === 'true'
        });
      }
    }
    return rows;
  });
  // 至少主工作台与数据行在场，否则采样无意义。
  expect(sampled.some((r) => r.selector === '.workbench')).toBe(true);
  expect(sampled.some((r) => r.selector === '.binder-child-row')).toBe(true);
  for (const row of sampled) {
    const flatRadius = parseFloat(row.radius) === 0;
    // 选中行的 inset 余火指示是 §8.3 双通道（软底+2px 接缝），不属于卡片阴影。
    // Chromium 把 inset box-shadow 序列化为「颜色+偏移... inset」（inset 在末尾）。
    const flatShadow = row.selected ? / inset$/i.test(row.shadow) : row.shadow === 'none';
    expect({ ...row, ok: flatRadius && flatShadow }, JSON.stringify(row))
      .toMatchObject({ ok: true });
  }

  await window.screenshot({ path: 'test-results/13-decarded-surfaces.png' });

  // App 对未提交变更挂了 beforeunload（App.tsx hasUncommittedChanges）：draft 状态
  // 直接 close 会触发确认对话框挂起。先走完 draft → written 清除未提交态再关闭，
  // 与「变更状态机」测试的关闭路径一致（它也是写完后才关）。
  const queue = window.locator('.change-queue');
  await queue.getByRole('button', { name: '批准入暂存' }).click();
  await queue.getByTestId('cq-commit').click();
  await expect(queue.locator('.cq-row').first()).toHaveAttribute('data-status', 'written');
  await app.close();
});

/*
 * 大工作区：分页与截断说明。
 *
 * 默认 fixture 只有 22 个文件，低于分页页大小（200）与搜索上限（60），所以这两条
 * 行为在默认套件里根本不出现。SF_TEST_LARGE_WORKSPACE=1 让 fixture 返回 482 个
 * 合成条目，跨过两个阈值。
 *
 * 断言的是**用户能看到什么**：DOM 里真的只有一页节点、翻页真的换内容、说明里的
 * 数字与真实总数一致。只断言「pager 存在」不够——一个点了不换页的 pager 也满足。
 *
 * 问题 14 后置：这两条测的是 Files 域的物理浏览分页（`[data-panel-id="explorer"]`
 * 的 search-box / pager / page-range），而该浏览的顶栏入口已被移除（「文件」不再
 * 出现在顶栏）。开始侧栏资源树与 Ctrl+K 都只会选文件、不落进 Files 物理浏览，
 * 所以两条用例在当前壳层里没有可到达的入口路径。按任务约束不得把「文件」加回
 * 顶栏来迁就测试，故改为 skip 并保留正文，待接入 Files 物理浏览的新入口后恢复。
 */
test.skip('大工作区：文件列表分页，且标题栏与导航报出真实规模', async () => {
  const { app, window, pageErrors, consoleErrors } = await launchApp({
    SF_TEST_LARGE_WORKSPACE: '1'
  });
  await openFixtureWorkspace(window);

  // 一次只建一页 DOM：这是硬约束 17 的实质，不是「有个 pager 控件」。
  const items = window.locator('.file-item');
  await expect(items).toHaveCount(200);

  const pager = window.locator('[data-testid="file-list-pager"]');
  await expect(pager).toBeVisible();

  // 位置文案必须报出区间与真实总数（482 = 22 基础 + 460 合成；EVENT-30B 加了
  // event/menu.emevd 基础样本从 12 变 13，SCRIPT-41 加 script/m25_00_00_00.luabnd.dcx
  // 从 13 变 14，MAP-50B 加 map/m10.msb.dcx 从 14 变 15，MODEL-51B 加 chr/c1000.flver
  // 从 15 变 16，TEXTURE-52B 加 menu/start.tpf.dcx 与 menu/broken.tpf.dcx 从 16 变 18，
  // MATERIAL-53B 加 material/materials.mtd、BEHAVIOR-55B 加 ai/m10.esd 从 18 变 20，
  // VFX-54B 加 sfx/f0000.fxr 从 20 变 21，T3 加 chr/c5030.anibnd.dcx 从 21 变 22）。
  const range = window.locator('[data-testid="file-list-page-range"]');
  await expect(range).toContainText('1–200');
  await expect(range).toContainText('482');
  await expect(range).toContainText('第 1/3 页');

  // 标题栏在超过一页时要说明「本页显示多少」，否则 200 与 479 长得一样。
  // SHELL-09 §3.3：数量带语义单位（文件 N 个）。
  await expect(window.locator('[data-panel-id="explorer"] .panel__hint')).toContainText('文件 482 个');
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
  await expect(range).toContainText('401–482');
  await expect(items).toHaveCount(82);
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

// 问题 14 后置：同样测 Files 物理浏览（search-box/pager/page-range），入口已随
// 「文件」顶栏移除而不可达，skip 保留正文（见上方「大工作区：分页与截断说明」）。
test.skip('大工作区：过滤后页码复位，且搜索结果显式说明被截断', async () => {
  const { app, window } = await launchApp({ SF_TEST_LARGE_WORKSPACE: '1' });
  await openFixtureWorkspace(window);

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
  // 460 合成 mXXXX.msb.dcx + MAP-50B 基础 map/m10.msb.dcx = 461 命中。
  await expect(note).toContainText('461');
  await expect(note).toContainText('60');
  // 未显示数必须报出来，否则用户要自己做减法。
  await expect(note).toContainText('401');

  await window.screenshot({ path: 'test-results/12-search-truncation.png' });
  await app.close();
});

test('AI 任务：运行发起后进度事件真的更新消息流，取消真的发出 IPC', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  const status = window.locator('[data-testid="agent-task-status"]');
  const stop = window.locator('[data-testid="composer-stop"]');

  // 空闲态只显示 welcome；T6「发送即运行」：发送后消息流挂载用户目标并直接跑任务。
  await expect(window.locator('.agent-welcome')).toBeVisible();
  await window.locator('.agent__composer textarea').fill('把伤药葫芦的持有上限调到 12');
  await window.locator('.agent__composer').getByRole('button', { name: '发送' }).click();
  await expect(window.locator('.agent-message--user')).toContainText('把伤药葫芦的持有上限调到 12');

  // 发送即运行：不再进二级抽屉点「模型设置 → 运行」，发送本身触发 ai.agent.run
  //（T6 行为，计划草稿卡已从发送路径移除）。

  // 1) 发起真的走了 IPC（发送路径直接触发，不经抽屉）。
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.run'] ?? 0).toBeGreaterThan(0);

  // 2) renderer 不得抬高授权：run 请求里不能带 mode（省略时主进程落到 plan）。
  const modeCalls = await ipcCalls(app);
  expect(modeCalls['ai.agent.run:mode=absent'] ?? 0).toBeGreaterThan(0);
  expect(modeCalls['ai.agent.run:mode=fullPermission'] ?? 0).toBe(0);
  expect(modeCalls['ai.agent.run:mode=normal'] ?? 0).toBe(0);

  // 3) 推送事件到达后消息流真的更新：步号、工具活动与产出量都必须出现。
  //    fixture 按计时器推 turn-started(1) → tool-call → delta，且刻意不推终态。
  await expect(status).toContainText('第 1 步');
  await expect(status).toContainText('可随时取消');
  const toolRow = window.locator('[data-testid="agent-tool-activity-fixture-call-1"]');
  await expect(toolRow).toContainText('search_resources');
  await expect(toolRow).toContainText('成功');
  await expect(status).toContainText('已产出 6 字符');

  // 4) 运行中停止必须可用——硬约束 16 的「可取消」在界面上成立（stop 只停当前生成）。
  await expect(stop).toBeVisible();
  await stop.click();

  // 5) 取消真的发出 IPC。这是本用例的核心断言：只改本地状态的「取消」会让
  //    任务继续跑到底，而界面显示已取消。
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.cancel'] ?? 0).toBeGreaterThan(0);

  // 6) 终态由主进程回报，界面据此收敛；取消后停止键消失。
  await expect(status).toContainText('已被取消');
  await expect(stop).toHaveCount(0);
  await expect(window.locator('[data-testid="agent-rollout-file"]')).toContainText('fixture-rollout.jsonl');

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

/**
 * AGENT-60D：消息流四态渲染并保存截图。
 *
 * fixture 按 prompt 标记推进不同状态（fixture-main.mjs 的 ai.agent.run）：
 *  默认      → 运行中（可取消）
 * 含「工具」  → 停在 tool-call-begin（running）
 * 含「审批」  → 停在 approval-requested，respond 后推进
 * 含「失败」  → session-error
 * T6「发送即运行」：填 prompt → 点发送即触发任务，不再进二级抽屉点
 * 「模型设置 → 运行」（函数名 runInDrawer 为历史沿用）。
 */
async function runInDrawer(window, promptText) {
  await window.locator('.agent__composer textarea').fill(promptText);
  await window.locator('.agent__composer').getByRole('button', { name: '发送' }).click();
  await expect(window.locator('.agent-message--user')).toContainText(promptText);
}

test('AGENT-60D：conversation 与 tool-running 两态渲染并保存截图', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // conversation：T6「发送即运行」，发送后消息流显示用户目标 + 任务运行状态
  //（不再有 `.agent-message--agent` 计划草稿卡）。
  await window.locator('.agent__composer textarea').fill('把伤药葫芦的持有上限调到 12');
  await window.locator('.agent__composer').getByRole('button', { name: '发送' }).click();
  await expect(window.locator('.agent-message--user')).toContainText('把伤药葫芦的持有上限调到 12');
  await expect(window.locator('[data-testid="agent-task-status"]')).toContainText('第 1 步');
  await expect(window.locator('[data-testid="agent-tool-activity-fixture-call-1"]')).toBeVisible();
  await window.screenshot({ path: 'test-results/60d-01-conversation.png' });

  // tool-running：新任务 → 运行「工具」标记 → 停在 running。
  await window.getByRole('button', { name: '新任务' }).click();
  await runInDrawer(window, '工具：搜索药葫芦资源');
  const toolRow = window.locator('[data-testid="agent-tool-activity-fixture-call-1"]');
  await expect(toolRow).toBeVisible();
  await expect(toolRow).toContainText('search_resources');
  await expect(toolRow).toContainText('进行中');
  // 默认折叠：details 不带 open 属性。
  expect(await toolRow.locator('details.agent-tool-activity__details').getAttribute('open')).toBeNull();
  await window.screenshot({ path: 'test-results/60d-02-tool-running.png' });

  await window.getByRole('button', { name: '新任务' }).click();
  await app.close();
});

test('AGENT-60D：approval 与 failure 两态渲染并保存截图', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // approval：Change Review 卡显示七要素；批准走真实 IPC。
  await runInDrawer(window, '审批：把药葫芦上限写到 8');
  const card = window.locator('[data-testid="agent-approval-card"]');
  await expect(card).toBeVisible();
  for (const row of ['operation', 'target', 'diff', 'impact', 'validation', 'backup', 'rollback']) {
    await expect(card.locator(`[data-testid="approval-row-${row}"]`)).toBeVisible();
  }
  await expect(card).toContainText('propose_text_patch');
  await expect(card).toContainText('批准并提交');
  await expect(card).toContainText('不可用'); // 缺的要素如实显示
  await window.screenshot({ path: 'test-results/60d-03-approval.png' });

  // 批准 → ai.agent.approval.respond；approval-resolved 后卡片出队。
  await card.locator('[data-testid="agent-approval-card-approve"]').click();
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.approval.respond'] ?? 0).toBeGreaterThan(0);
  await expect(window.locator('[data-testid="agent-approval-card"]')).toHaveCount(0);
  // 批准后任务继续推进：工具活动进入消息流。
  await expect(window.locator('[data-testid="agent-tool-activity-fixture-call-1"]')).toContainText('成功');

  // failure：新任务 → 运行「失败」标记 → 有界失败诊断，不替换整个 dock。
  await window.getByRole('button', { name: '新任务' }).click();
  await runInDrawer(window, '失败：模拟模型调用超时');
  const failure = window.locator('[data-testid="agent-failure"]');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('AGENT_SESSION_FAILED');
  // dock 其余部件仍在（巨型错误卡不得替换 sidebar）。
  await expect(window.locator('.agent__header')).toBeVisible();
  await expect(window.locator('.agent__composer')).toBeVisible();
  await window.screenshot({ path: 'test-results/60d-04-failure.png' });

  await app.close();
});

test('T6 冷启动：不打开工作区也能发送并收到模型回答', async () => {
  const { app, window } = await launchApp();
  // 刻意不调 openFixtureWorkspace：冷启动无工作区也直接发送跑任务，
  // 验证 ai.agent.run 与工作区解耦——绝不该报 WORKSPACE_NOT_ANALYZED。

  // Agent dock 默认开着，composer 可直接用。
  await expect(window.locator('.agent__composer textarea')).toBeVisible();
  await window.locator('.agent__composer textarea').fill('只狼 SpEffect 怎么改');
  await window.locator('.agent__composer').getByRole('button', { name: '发送' }).click();

  // 用户目标进对话流；发送即运行。
  await expect(window.locator('.agent-message--user')).toContainText('只狼 SpEffect 怎么改');
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.run'] ?? 0).toBeGreaterThan(0);
  await expect(window.locator('[data-testid="agent-task-status"]')).toContainText('第 1 步');
  await expect(window.locator('[data-testid="agent-tool-activity-fixture-call-1"]')).toBeVisible();
  await expect(window.locator('[data-testid="agent-task-status"]')).toContainText('已产出 6 字符');

  // 绝不该是「未打开工作区」错误。
  const bodyText = await window.locator('body').innerText();
  expect(bodyText).not.toContain('WORKSPACE_NOT_ANALYZED');

  await window.screenshot({ path: 'test-results/14-t6-cold-start-send.png' });
  await app.close();
});

test('T6 无模型：对话里说明，不卡输入', async () => {
  const { app, window } = await launchApp({ FIXTURE_EMPTY_MODEL_SERVICES: '1' });
  await expect(window.locator('.agent__composer textarea')).toBeVisible();
  await window.locator('.agent__composer textarea').fill('只狼 SpEffect 怎么改');
  await window.locator('.agent__composer').getByRole('button', { name: '发送' }).click();

  // 用户目标仍进对话流。
  await expect(window.locator('.agent-message--user')).toContainText('只狼 SpEffect 怎么改');
  // 对话区出现系统提示：未配置模型服务，未发起 AI 任务。
  const bodyText = await window.locator('body').innerText();
  expect(bodyText).toContain('尚未配置模型服务');
  // 未发起任务（modelService.list 为空，发送只落系统提示不调 ai.agent.run）。
  const calls = await ipcCalls(app);
  expect(calls['ai.agent.run'] ?? 0).toBe(0);
  // 输入框仍可用（没被禁，不卡输入）。
  await expect(window.locator('.agent__composer textarea')).toBeEnabled();
  // 也不是「未打开工作区」错误。
  expect(bodyText).not.toContain('WORKSPACE_NOT_ANALYZED');

  await window.screenshot({ path: 'test-results/15-t6-no-model.png' });
  await app.close();
});

test('PARAM 工作台三栏 + CSV 工具条：选择链、父选区清理、虚拟行、字段类型控件与局部失败（PARAM-10B）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 从开始侧栏资源树选 parambnd 容器，打开 Param Workbench。
  await selectFileItem(window, 'param/gameparam/gameparam.parambnd.dcx');

  // 三栏同时存在（T5-4 删第四栏 Tools：Params/Rows/Fields）。
  // WorkbenchLayout 根是 div（.workbench），各栏是带 aria-label 的 section（region）。
  // EVENT-30B 起事件源码工作台常驻挂载（hidden 不卸载），裸 .workbench 会命中
  // 两个元素：收窄到 PARAM 工作台（aria-label）。
  await expect(window.getByLabel('PARAM 工作台')).toBeVisible();
  await expect(window.getByRole('region', { name: 'Params' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Rows' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Fields' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // §7.1 比例在运行期成立（computed flex-grow，未被拖拽覆盖时）；拖拽后转像素是允许路径。
  // EVENT-30B 起事件源码工作台常驻挂载，全局选择会多算它的栏：收窄到 PARAM 工作台。
  const growRatios = await window.evaluate(() => {
    const workbenchEl = document.querySelector('.workbench[aria-label="PARAM 工作台"]');
    const slots = [...workbenchEl.querySelectorAll('.workbench__column-slot')];
    return slots.map((slot) => getComputedStyle(slot).flexGrow);
  });
  expect(growRatios).toEqual(['0.2', '0.29', '0.35']);

  // 独立滚动：每栏的滚动权在栏内，不泄给整页。普通栏 body 自身滚（auto）；
  // 虚拟栏（Rows）把滚动权交给内部 .wb-virtual-scroll（body hidden + 内部 auto）。
  // 两者都不得是 visible —— visible 意味着滚整页。
  const scrollHosts = await window.evaluate(() => {
    // EVENT-30B 起事件源码工作台常驻挂载，全局选择会多算它的栏：收窄到 PARAM 工作台。
    const workbenchEl = document.querySelector('.workbench[aria-label="PARAM 工作台"]');
    const bodies = [...workbenchEl.querySelectorAll('.workbench__column-body')];
    return bodies.map((body) => getComputedStyle(body).overflowY);
  });
  expect(scrollHosts.every((value) => value === 'auto' || value === 'hidden')).toBe(true);

  // T5-4 + 问题 4 工具条：新建行/复制当前行/删除当前行 + 导出行/导入行/导出备注/
  // 导入备注 七个真实按钮；未选表时全部禁用（没有可操作的表格目标）。不再有
  // 「Game Parameters · 1 library · N tables」crumb、类型名、行大小。
  const toolbarButtons = window.locator('.workbench__toolbar .toolbar-button, .pane-toolbar .toolbar-button');
  await expect(toolbarButtons).toHaveCount(7);
  await expect(toolbarButtons.nth(0)).toHaveText('新建行');
  await expect(toolbarButtons.nth(1)).toHaveText('复制当前行');
  await expect(toolbarButtons.nth(2)).toHaveText('删除当前行');
  await expect(toolbarButtons.nth(3)).toHaveText('导出行');
  await expect(toolbarButtons.nth(4)).toHaveText('导入行');
  await expect(toolbarButtons.nth(5)).toHaveText('导出备注');
  await expect(toolbarButtons.nth(6)).toHaveText('导入备注');
  // 未选表：全部禁用（真实功能的禁用态，不是 §7.6 的假按钮）。
  await expect(toolbarButtons.nth(0)).toBeDisabled();
  await expect(toolbarButtons.nth(2)).toBeDisabled();
  await expect(toolbarButtons.nth(3)).toBeDisabled();
  // EVENT-30B 起事件源码工作台常驻挂载，裸 .workbench 命中两个元素：收窄到 PARAM 工作台。
  const workbenchText = await window.getByLabel('PARAM 工作台').innerText();
  expect(workbenchText).not.toContain('Game Parameters');
  expect(workbenchText).not.toContain('行大小');
  expect(workbenchText).not.toContain('gameparam.parambnd.dcx');
  expect(workbenchText).not.toContain('.bak');
  expect(workbenchText).not.toContain('.gparam');

  // 选择链：选 ActionGuideParam → 行出现（虚拟容器挂载，滚动权在虚拟容器自身）；选首行 → 字段出现。
  await window.locator('.wb-list .wb-row', { hasText: 'ActionGuideParam' }).click();
  await expect(window.locator('.wb-virtual-row', { hasText: '100' })).toBeVisible();
  const virtualScrollOverflow = await window.locator('.wb-virtual-scroll').first()
    .evaluate((element) => getComputedStyle(element).overflowY);
  expect(virtualScrollOverflow).toBe('auto');
  await window.locator('.wb-virtual-row', { hasText: '100' }).click();

  // 选中表后工具条按钮解除禁用（新建行可用；导出行/导入行已可点击目标）。
  await expect(toolbarButtons.nth(0)).toBeEnabled();
  await expect(toolbarButtons.nth(3)).toBeEnabled();

  // 字段类型控件：enum 字段按类型渲染——原始值留在 input（只读），
  // 当前值标签（枚举标签「攻击」）显示在字段名旁，不是裸自由文本。
  const behaviorProp = window.locator('.wb-prop', { hasText: 'behavior' });
  await expect(behaviorProp).toContainText('攻击');
  await expect(behaviorProp.locator('input')).toBeVisible();
  await expect(behaviorProp.locator('input')).toHaveValue('1');

  // T5-5：Fields 中文名 + Description 悬停。字段名显示 Yapped overlay 覆盖出的
  // 中文名（「攻击力」），名称 span 的 title 优先取 description（中文 Description）。
  const atkProp = window.locator('.wb-prop', { hasText: '攻击力' });
  await expect(atkProp).toBeVisible();
  await expect(atkProp.locator('.wb-prop__name'))
    .toHaveAttribute('title', '基础攻击力（覆盖自 Yapped defs 的中文名）');
  // 无覆盖的英文名字段也带 description 悬停（同一个 title 通路）。
  await expect(behaviorProp.locator('.wb-prop__name'))
    .toHaveAttribute('title', '行为模式（引导/攻击/防御）');

  // T5-3/T5-6：行名可编辑。选中行出现名字输入框（aria-label「行 N 的名字」），
  // 改名后 Enter 提交 —— 走与字段写入同一条 Patch 链（fixture 合成内存态），
  // footer 显示提交结果，重读后行名更新为新值。
  const rowNameInput = window.getByLabel('行 100 的名字');
  await expect(rowNameInput).toBeVisible();
  await rowNameInput.fill('引导-改名');
  await rowNameInput.press('Enter');
  // S28：保存成功走工作台内 toast（role=status，class .wb-toast--ok），workbench footer 已移除。
  await expect(window.locator('.wb-toast--ok')).toContainText('已保存');
  await expect.poll(async () =>
    (await ipcCalls(app))['resource.applyContainerParamRowNameMutation'] ?? 0
  ).toBeGreaterThan(0);
  // 重读后新行名回到名称列（id 仍可定位同一行）。
  await expect(window.getByLabel('行 100 的名字')).toHaveValue('引导-改名');

  // T5-4/T5-6：CSV 工具条四个按钮真实触发 bridge（fixture 不真开对话框/不写盘，
  // 只回成功诊断）。S28 起反馈走 toast：诊断的首条 info/error message 上浮。
  const feedback = window.locator('.wb-toast--ok');
  await window.locator('.workbench__toolbar .toolbar-button', { hasText: '导出行' }).click();
  await expect(feedback).toContainText('fixture 导出 ActionGuideParam（4 行）行数据。');
  await expect.poll(async () => (await ipcCalls(app))['param.exportRowsCsv'] ?? 0).toBeGreaterThan(0);

  await window.locator('.workbench__toolbar .toolbar-button', { hasText: '导出备注' }).click();
  await expect(feedback).toContainText('fixture 导出 ActionGuideParam（4 行）行名。');
  await expect.poll(async () => (await ipcCalls(app))['param.exportNamesCsv'] ?? 0).toBeGreaterThan(0);

  await window.locator('.workbench__toolbar .toolbar-button', { hasText: '导入行' }).click();
  await expect(feedback).toContainText('fixture 导入 ActionGuideParam（4 行）行数据完成。');
  await expect.poll(async () => (await ipcCalls(app))['param.importRowsCsv'] ?? 0).toBeGreaterThan(0);

  await window.locator('.workbench__toolbar .toolbar-button', { hasText: '导入备注' }).click();
  await expect(feedback).toContainText('fixture 导入 ActionGuideParam（4 行）行名完成。');
  await expect.poll(async () => (await ipcCalls(app))['param.importNamesCsv'] ?? 0).toBeGreaterThan(0);

  // 问题 4：行级工具（新建行/复制当前行/删除当前行）真实触发 bridge。fixture 走
  // 合成内存态（就地增删 paramTables 行），重读即见 —— 与行名/CSV 的 fixture
  // 同一套约定（不真写盘）。字段栏行名输入框的 aria-label 暴露当前选中的行。
  await window.locator('.workbench__toolbar .toolbar-button', { hasText: '新建行' }).click();
  await expect.poll(async () =>
    (await ipcCalls(app))['resource.applyContainerParamRowMutations'] ?? 0
  ).toBeGreaterThan(0);
  // ActionGuideParam 行 id 为 100..103，新建行取最大 id + 1 = 104；成功后自动选中
  // 新行，字段栏出现该行的名字输入框（不依赖滚动位置）。
  await expect(window.getByLabel('行 104 的名字')).toBeVisible();

  // 复制当前行（选中的行 104 → 新 id 105），焦点落到新行。
  await window.locator('.workbench__toolbar .toolbar-button', { hasText: '复制当前行' }).click();
  await expect(window.getByLabel('行 105 的名字')).toBeVisible();

  // 删除当前行（行 105）：删除后选择清空，回到「先在中栏选择一行。」空态。
  await window.locator('.workbench__toolbar .toolbar-button', { hasText: '删除当前行' }).click();
  await expect(window.locator('.wb-empty', { hasText: '先在中栏选择一行。' })).toBeVisible();

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

test('GPARAM 工作台五区：bank→group→field→value 选择链、父选区清理、值类型展开与局部失败（GPARAM-11B）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 从开始侧栏资源树选 gparam 文件，打开 GPARAM Workbench。
  await selectFileItem(window, 'param/drawparam/m10_00.gparam.dcx');

  // Agent 面板是文档流右列，默认展开会挤窄右侧 Fields/Values 两栏的点击目标。
  // PARAM-10B 用例点击目标在中栏不受影响；这里先收起再操作右栏。
  await closeAgentPanel(window);

  // 五区同时存在（§18.15 11B：Files/Groups/Fields/Values/Toolbar；§8.1 禁止合并 Fields/Values）。
  // EVENT-30B 起事件源码工作台常驻挂载，裸 .workbench 命中两个元素：收窄到 GPARAM 工作台。
  await expect(window.getByLabel('GPARAM 工作台')).toBeVisible();
  await expect(window.getByRole('region', { name: 'Files' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Groups' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Fields' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Values' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Toolbar' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Fields/Values' })).toHaveCount(0);

  // §8.1 比例在运行期成立（computed flex-grow；§2.5 停靠折算 ≈ 0.27/0.13/0.17/0.24/0.19）。
  // EVENT-30B 起事件源码工作台常驻挂载，全局选择会多算它的栏：收窄到 GPARAM 工作台。
  const growRatios = await window.evaluate(() => {
    const workbenchEl = document.querySelector('.workbench[aria-label="GPARAM 工作台"]');
    const slots = [...workbenchEl.querySelectorAll('.workbench__column-slot')];
    return slots.map((slot) => getComputedStyle(slot).flexGrow);
  });
  expect(growRatios).toEqual(['0.27', '0.13', '0.17', '0.24', '0.19']);

  // 独立滚动：每栏的滚动权在栏内，不泄给整页（5 栏 5 个滚动宿主）。
  // EVENT-30B 起事件源码工作台常驻挂载，全局选择会多算它的栏：收窄到 GPARAM 工作台。
  const scrollHosts = await window.evaluate(() => {
    const workbenchEl = document.querySelector('.workbench[aria-label="GPARAM 工作台"]');
    const bodies = [...workbenchEl.querySelectorAll('.workbench__column-body')];
    return bodies.map((body) => getComputedStyle(body).overflowY);
  });
  expect(scrollHosts).toHaveLength(5);
  expect(scrollHosts.every((value) => value === 'auto' || value === 'hidden')).toBe(true);

  // §7.8 标题形态；负向清单：无物理路径 / .bak / PARAM 表 / 合并的 Fields/Values。
  // 11-C：workbench 可见文本里不再出现「Graphics Parameters」crumb。
  // 物理路径只允许出现在 title（metadata details），可见文本是显示名。
  // 11-C：workbench 可见文本里不再出现「Graphics Parameters」crumb。
  // EVENT-30B 起事件源码工作台常驻挂载，裸 .workbench 命中两个元素：收窄到 GPARAM 工作台。
  const workbenchText = await window.getByLabel('GPARAM 工作台').innerText();
  expect(workbenchText).not.toContain('Graphics Parameters');
  expect(workbenchText).not.toContain('.gparam.dcx');
  expect(workbenchText).not.toContain('.bak');
  expect(workbenchText).not.toContain('Game Parameters'); // PARAM 工作台标题不串台
  expect(workbenchText).not.toContain('Fields/Values'); // §8.1 禁止合并单栏

  // Toolbar 栏只给诚实空态：只读说明存在，无假写入按钮。
  const toolbarColumn = window.locator('.workbench__column[aria-label="Toolbar"]');
  await expect(toolbarColumn).toContainText('暂无已接通的工具');
  expect(await toolbarColumn.locator('button').count()).toBe(0);

  // 打开时默认选中当前文件：Groups 栏出现 LightSet ParamEditor。
  await expect(window.locator('.wb-list .wb-row', { hasText: 'LightSet ParamEditor' })).toBeVisible();

  // 选择链：选 group → Fields 栏出现 params；选 field → Values 栏加载该 field 的值。
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

  // 父选区清理：切到第二个 group（Shadows）后 field 选择被清——Values 栏不再显示
  // 上一个 group 的 Directional Light 值，Fields 栏列出当前 group 的 field。
  await window.locator('.wb-list .wb-row', { hasText: 'Shadows ParamEditor' }).click();
  await expect(window.locator('.wb-list .wb-row', { hasText: 'Shadow Distance' })).toBeVisible();
  // 父选区清理后值编辑器整体消失：不再有前一个 group 的任何 typed 输入框。
  await expect(window.locator('.gparam-values__input')).toHaveCount(0);

  // 父选区清理（bank 级）：切到 m11 bank 后 group 与 field 选择全部清空。
  await window.locator('.wb-list .wb-row', { hasText: 'm11_00' }).click();
  await expect(window.locator('.wb-list .wb-row', { hasText: 'Camera ParamEditor' })).toBeVisible();
  await expect(window.locator('.wb-empty', { hasText: '先在中栏选择一个 group。' })).toBeVisible();

  // 局部失败：broken bank 保留在 Files 栏并标记失败，Groups 栏给出结构化原因。
  await window.locator('.wb-list .wb-row', { hasText: 'broken' }).click();
  await expect(window.locator('.wb-row__meta', { hasText: '读取失败' })).toBeVisible();
  await expect(window.locator('.diag-error', { hasText: 'fixture 未登记或损坏的 GPARAM' })).toBeVisible();

  // 同尺寸对照截图（§2.4 步骤 6）。
  await window.screenshot({ path: 'test-results/11-gparam-workbench.png' });
  await app.close();
});

test('GPARAM typed 写回：值行编辑 → Toolbar 保存 → 重读新值，非法输入禁用提交（GPARAM-11C）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  await selectFileItem(window, 'param/drawparam/m10_00.gparam.dcx');
  await closeAgentPanel(window);

  // 打开默认 bank（m10_00）：LightSet → Directional Light Angle0（float3 × 2 值）。
  await expect(window.getByLabel('GPARAM 工作台')).toBeVisible();
  await window.locator('.wb-list .wb-row', { hasText: 'LightSet ParamEditor' }).click();
  await window.locator('.wb-list .wb-row', { hasText: 'Directional Light Angle0' }).click();

  // 值行是 typed 输入框：2 值 × 3 分量 = 6 个 input，初始值为 fixture 值。
  const inputs = window.locator('.gparam-values__input');
  await expect(inputs).toHaveCount(6);
  await expect(inputs.nth(0)).toHaveValue('1.25');
  await expect(inputs.nth(1)).toHaveValue('0.5');

  // 未修改时 Toolbar 栏无保存按钮（诚实空态）。
  const toolbarColumn = window.locator('.workbench__column[aria-label="Toolbar"]');
  await expect(toolbarColumn).toContainText('暂无已接通的工具');
  expect(await toolbarColumn.locator('button').count()).toBe(0);

  // 修改第一个分量 → Toolbar 栏出现保存入口，行标记为已编辑。
  await inputs.nth(0).fill('2.5');
  await expect(window.locator('.gparam-values__row--edited').first()).toBeVisible();
  await expect(window.getByRole('button', { name: '保存 1 处修改' })).toBeVisible();
  await expect(toolbarColumn).toContainText('共 1 处修改');

  // 保存 → 提交并重读：输入框回到服务端值（fixture 内存态已更新为 2.5）。
  await window.getByRole('button', { name: '保存 1 处修改' }).click();
  await expect(toolbarColumn).toContainText('已提交 1 处修改并重读验证。');
  await expect(window.locator('.gparam-values__input').nth(0)).toHaveValue('2.5');
  // 兄弟分量未被改动（只提交了 1 处）。
  await expect(window.locator('.gparam-values__input').nth(1)).toHaveValue('0.5');
  // 保存后 drafts 清空：按钮消失，回到诚实空态。
  expect(await toolbarColumn.locator('button').count()).toBe(0);

  // 非法输入：非数字 → 保存按钮禁用并给出诊断，不提交。
  await window.locator('.gparam-values__input').nth(1).fill('abc');
  await expect(toolbarColumn).toContainText('存在非数字输入，无法提交。');
  const saveButton = window.getByRole('button', { name: '保存 1 处修改' });
  await expect(saveButton).toBeVisible();
  expect(await saveButton.isDisabled()).toBe(true);

  // 改回合法数字 → 按钮恢复可提交。
  await window.locator('.gparam-values__input').nth(1).fill('0.5');
  await expect(toolbarColumn).not.toContainText('存在非数字输入，无法提交。'); // 诊断消失
  expect(await saveButton.isDisabled()).toBe(false);

  await window.screenshot({ path: 'test-results/11-gparam-writer.png' });
  await app.close();
});

test('TPF 工作台四栏：container→texture 选择链、预览与元数据、预览失败隔离、no fake replace（TEXTURE-52B）', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 从开始侧栏资源树选 tpf 文件，打开 Texture Workbench。
  await selectFileItem(window, 'menu/start.tpf.dcx');

  // Agent 面板是文档流右列，默认展开会挤窄右侧 Viewer/Properties 栏的点击目标。
  await closeAgentPanel(window);

  // 四栏同时存在（§2.5：Container list | Texture list | Viewer | Properties）。
  // 事件工作台常驻 DOM（hidden 切显隐），.workbench 会命中多个，必须限定到
  // Texture 工作台自身。
  const textureWorkbench = window.locator('.workbench[aria-label="Texture 工作台"]');
  await expect(textureWorkbench).toBeVisible();
  await expect(textureWorkbench.getByRole('region', { name: 'Containers' })).toBeVisible();
  await expect(textureWorkbench.getByRole('region', { name: 'Textures' })).toBeVisible();
  await expect(textureWorkbench.getByRole('region', { name: 'Viewer' })).toBeVisible();
  await expect(textureWorkbench.getByRole('region', { name: 'Properties' })).toBeVisible();

  // 11-C：工作台可见文本不含「Texture · N containers」crumb；负向清单：
  // 无物理路径（可见文本里）。领域栏上的「纹理」tab 不属于工作台，不受影响。
  const workbenchText = await textureWorkbench.innerText();
  expect(workbenchText).not.toContain('Texture · ');
  expect(workbenchText).not.toContain('.tpf.dcx');

  // Containers 栏列出全部 tpf 容器；打开时默认选中当前文件，Textures 栏出现纹理。
  await expect(textureWorkbench.locator('.wb-list .wb-row', { hasText: 'start' })).toBeVisible();
  await expect(textureWorkbench.locator('.wb-list .wb-row', { hasText: 'broken' })).toBeVisible();
  await expect(textureWorkbench.locator('.wb-list .wb-row', { hasText: 'm_00_title' })).toBeVisible();

  // 选择纹理 → Viewer 生成预览（受界 data URI），Properties 显示元数据。
  await window.locator('.wb-list .wb-row', { hasText: 'm_01_icon' }).click();
  await expect(window.locator('.tpf-viewer__image')).toBeVisible();
  const src = await window.locator('.tpf-viewer__image').getAttribute('src');
  expect(src).toMatch(/^data:image\/png;base64,/);
  // 预览尺寸（受界下采样：256×256 不缩，原始尺寸相等时不重复显示「原始」）。
  await expect(window.locator('.tpf-viewer')).toContainText('预览 256×256');
  // Properties 栏：条目表格式与真实 DDS 封装分开显示，尺寸/元数据齐备。
  const propertiesColumn = window.getByRole('region', { name: 'Properties' });
  await expect(propertiesColumn).toContainText('BC4');
  await expect(propertiesColumn).toContainText('ATI1');
  await expect(propertiesColumn).toContainText('256×256');
  await expect(propertiesColumn).toContainText('Mip Levels');
  // TEXTURE-52C replace 入口：替换控件已接线（源来自工作区 DDS 文件，无文件对话框）。
  // fixture 工作区没有 DDS 文件 → 源选择与提交按钮为禁用态，诚实不给假替换。
  await expect(propertiesColumn.locator('.tpf-replace')).toBeVisible();
  await expect(propertiesColumn.getByText('替换源（DDS）')).toBeVisible();
  await expect(window.locator('#tpf-replace-source')).toBeDisabled();
  const tpfReplaceButton = window.getByRole('button', { name: '替换选中纹理' });
  await expect(tpfReplaceButton).toBeVisible();
  expect(await tpfReplaceButton.isDisabled()).toBe(true);

  // 受界下采样上限：512×512 源 → 512×512 预览（512 是上限，不缩）。
  await window.locator('.wb-list .wb-row', { hasText: 'm_00_title' }).click();
  await expect(window.locator('.tpf-viewer')).toContainText('预览 512×512');

  // 预览失败隔离：选 m_02_hud（不可解码）→ 纹理列表保留、Viewer 独立给诊断。
  await window.locator('.wb-list .wb-row', { hasText: 'm_02_hud' }).click();
  await expect(window.locator('[data-testid="tpf-preview-failure"]')).toContainText('纹理不可解码');
  // 纹理列表没有被预览失败清空：m_00_title 仍在 Textures 栏。
  await expect(window.locator('.wb-list .wb-row', { hasText: 'm_00_title' })).toBeVisible();
  // 回到可预览纹理 → 预览恢复。
  await window.locator('.wb-list .wb-row', { hasText: 'm_00_title' }).click();
  await expect(window.locator('.tpf-viewer__image')).toBeVisible();

  // 局部失败：broken 容器保留在 Containers 栏并标记失败，Textures 栏给结构化原因。
  await window.locator('.wb-list .wb-row', { hasText: 'broken' }).click();
  await expect(window.locator('.wb-row__meta', { hasText: '读取失败' })).toBeVisible();
  await expect(window.locator('.diag-error', { hasText: 'fixture 未登记或损坏的 TPF' })).toBeVisible();

  // 无 3D viewport（§2.5）：整个工作台没有 canvas。
  expect(await window.locator('.workbench canvas').count()).toBe(0);

  // 同尺寸对照截图（§2.4 步骤 6）。
  await window.screenshot({ path: 'test-results/12-tpf-workbench.png' });
  await app.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENT-30B：DarkScript3 式事件源码工作台（真实 Electron + CodeMirror 6）。
// 对照 docs/frontend-renovation/browser-feedback-spec.md §11：文档标签 + 源码主区
// + 可选 Outline/Inspector + Problems 底部 dock；不做 260/320 固定三栏。
// ─────────────────────────────────────────────────────────────────────────────

async function openEventWorkbench(window, fileName) {
  await selectFileItem(window, fileName);
  const workbench = window.locator('[aria-label="Event 源码工作台"]');
  await expect(workbench.locator('[data-editor-engine="codemirror"] .cm-editor')).toBeVisible();
  return workbench;
}

test('EVENT-30B：事件源码工作台挂载，CodeMirror 主区 + 逻辑文档标签，无四钮', async () => {
  const { app, window, pageErrors, consoleErrors } = await launchApp();
  await openFixtureWorkspace(window);
  const workbench = await openEventWorkbench(window, 'event/common.emevd');

  // 文档标签 = 逻辑 EMEVD 文档（tabId=资源 URI），不是物理文件计数。
  // 显示名走 libraryDisplayName（event/common.emevd → common），路径不进 tab 文本。
  const tablist = workbench.locator('[role="tablist"]');
  await expect(tablist).toBeVisible();
  await expect(tablist.locator('[role="tab"]')).toHaveCount(1);
  await expect(tablist.locator('[role="tab"]').first()).toContainText('common');
  await expect(tablist.locator('[role="tab"]').first()).not.toContainText('event/');

  // CodeMirror 6 主区渲染 DSL 源码：资源行、事件块、指令行都在。
  const host = workbench.locator('[data-editor-engine="codemirror"]');
  await expect(host.locator('.cm-content')).toContainText('resource "fixture://event/common.emevd"');
  await expect(host.locator('.cm-content')).toContainText('event @e:ev50');
  await expect(host.locator('.cm-content')).toContainText('event @e:ev60');

  // T4：Outline / Inspector / Problems 一律不渲染；主区只剩源码。
  await expect(workbench.locator('[aria-label="事件大纲"]')).toHaveCount(0);
  await expect(workbench.locator('[aria-label="事件检查器"]')).toHaveCount(0);
  await expect(workbench.locator('[aria-label="事件问题"]')).toHaveCount(0);

  // T4：无四钮。
  await expect(workbench.getByRole('button', { name: '查找替换' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: 'Outline' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: 'Inspector' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: /^Problems/ })).toHaveCount(0);

  // Negative DOM（EVENT-30B 对照 §11）：四视图三栏 grid、textarea 兜底、
  // 第四栏 Problems、esw-dock 全部消失。
  expect(await workbench.locator('.event-source__grid').count()).toBe(0);
  expect(await workbench.locator('textarea').count()).toBe(0);
  expect(await workbench.locator('.event-source__problems').count()).toBe(0);
  expect(await workbench.locator('.esw-dock').count()).toBe(0);

  // CodeMirror 集成无运行时错误。
  expect(pageErrors, `pageerror: ${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console error: ${consoleErrors.join('\n')}`).toEqual([]);

  await window.screenshot({ path: 'test-results/12-event-workbench-mount.png' });
  await app.close();
});

test('EVENT-30B：无四钮，Ctrl+F 走 CodeMirror search keymap', async () => {
  const { app, window, pageErrors, consoleErrors } = await launchApp();
  await openFixtureWorkspace(window);
  const workbench = await openEventWorkbench(window, 'event/common.emevd');

  // 主区只剩源码：无查找替换/Outline/Inspector/Problems 四钮，无选中节点面板。
  await expect(workbench.getByRole('button', { name: '查找替换' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: 'Outline' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: 'Inspector' })).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: /^Problems/ })).toHaveCount(0);
  await expect(workbench.getByText('选中节点', { exact: false })).toHaveCount(0);

  // Ctrl+F 直接打开 CodeMirror search 面板（@codemirror/search keymap），非工具条钮。
  const content = workbench.locator('.esw-source__host .cm-content');
  await content.click();
  await window.keyboard.press('Control+F');
  const search = workbench.locator('.cm-search');
  await expect(search).toBeVisible();
  // CM search 用 onkeyup commit：fill() 只发 input 事件，需补一次 keyup 才触发查询更新。
  // 高亮匹配 .cm-searchMatch 渲染在编辑器内容区（.cm-content），不在 .cm-search 面板内。
  const findField = search.getByRole('textbox', { name: 'Find' });
  await findField.fill('event @e:ev60');
  await findField.dispatchEvent('keyup');
  await expect(workbench.locator('.cm-searchMatch')).toHaveCount(1);
  await window.keyboard.press('Escape');
  await expect(workbench.locator('.cm-search')).toHaveCount(0);

  // 无运行时错误。
  expect(pageErrors, `pageerror: ${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console error: ${consoleErrors.join('\n')}`).toEqual([]);

  await window.screenshot({ path: 'test-results/12-event-no-four-buttons-search.png' });
  await app.close();
});

test('EVENT-30B：diagnostic gutter 标注未知指令，编辑 dirty 后提交清空', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);
  const workbench = await openEventWorkbench(window, 'event/common.emevd');

  // Event 60 含一条 unknown 指令（fixture 故意缺 sample）→ gutter 有 warning 记号。
  const warnMarkers = workbench.locator('.cm-gutter.cm-event-diag .cm-event-diag__warn');
  await expect(warnMarkers).toHaveCount(1);
  const first = warnMarkers.first();
  expect(await first.getAttribute('title')).toContain('Event 60');

  // 编辑源码（真实键盘输入）→ per-tab dirty 标记出现。
  const content = workbench.locator('.esw-source__host .cm-content');
  await content.click();
  await window.keyboard.press('End');
  await window.keyboard.type('\n// fixture e2e dirty', { delay: 0 });
  const dirtyTab = workbench.locator('[role="tab"] .esw-tab__dirty');
  await expect(dirtyTab).toHaveCount(1);
  await expect(workbench.locator('[role="tab"]').first()).toContainText('common');

  // 提交：S14 起没有「编译并提交」按钮，应用走 Ctrl+S（或失焦）。fixture 接受
  // （合成写回），dirty 清空、源码替换为已提交文本。
  await window.keyboard.press('Control+S');
  await expect(dirtyTab).toHaveCount(0);
  await expect(workbench.locator('.esw-source__host .cm-content')).toContainText('// fixture e2e dirty');

  await window.screenshot({ path: 'test-results/12-event-dirty-submit.png' });
  await app.close();
});

test('EVENT-30B：多 tab 各自 dirty，切 tab 保留未提交编辑', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);
  const workbench = await openEventWorkbench(window, 'event/common.emevd');

  // common 编辑 → dirty。
  const content = workbench.locator('.esw-source__host .cm-content');
  await content.click();
  await window.keyboard.press('End');
  await window.keyboard.type('// 未保存的 common 编辑', { delay: 0 });
  await expect(workbench.locator('[role="tab"] .esw-tab__dirty')).toHaveCount(1);

  // 打开第二个事件文档 → 新 tab 出现并被激活（无 dirty）。事件工作台跨资源
  // 保留标签：切 Files 领域再选 menu.emevd 不应卸载工作台。
  await selectFileItem(window, 'event/menu.emevd');
  const tabs = workbench.locator('[role="tab"]');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toContainText('common');
  await expect(tabs.nth(1)).toContainText('menu');
  await expect(workbench.locator('.esw-source__host .cm-content')).toContainText('event @e:ev100');

  // 切回 common：dirty 仍在，未提交编辑还在（per-tab EditorState 隔离）。
  await tabs.first().click();
  await expect(tabs.first().locator('.esw-tab__dirty')).toHaveCount(1);
  await expect(workbench.locator('.esw-source__host .cm-content')).toContainText('// 未保存的 common 编辑');

  // menu tab 无 dirty；common 的 dirty 仍保留（各自 dirty，不因切换丢失）。
  await tabs.nth(1).click();
  await expect(tabs.nth(1).locator('.esw-tab__dirty')).toHaveCount(0);
  await expect(tabs.first().locator('.esw-tab__dirty')).toHaveCount(1);

  // 关闭 menu tab → 只剩 common。
  await workbench.getByRole('button', { name: '关闭 menu' }).click();
  await expect(workbench.locator('[role="tab"]')).toHaveCount(1);
  await expect(workbench.locator('[role="tab"]')).toContainText('common');

  await window.screenshot({ path: 'test-results/12-event-multitab.png' });
  await app.close();
});

test('EVENT-30B：打开一个事件文档只发一次 readEmevdFullDocument，且零次 readEmevdDocument', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 打开前基线：两条 channel 都没被碰过。没有这一步，「恰好一次」可能是
  // 「打开工作区时已经发过一次、打开文件时其实发了两次」的巧合。
  const before = await ipcCalls(app);
  expect(before['resource.readEmevdFullDocument'] ?? 0).toBe(0);
  expect(before['resource.readEmevdDocument'] ?? 0).toBe(0);

  await openEventWorkbench(window, 'event/common.emevd');

  /*
   * 一次读到底：打开事件文档以前是两次 IPC —— readEmevdDocument 拿有界 envelope
   * 投影，readEmevdFullDocument 拿权威源码。第一次读的产物只用在状态行三个标量和
   * gutter 的「未知指令条数」，而它的 instructionsSample 默认只覆盖前 256 条指令，
   * 于是真实 common.emevd（33266 条指令）里第 256 条之后的事件全被标成「整段未知」。
   * 那趟往返换回来的是一份系统性错误的判据，已整体删除；三个标量与 gutter 判据现在
   * 都从 readEmevdFullDocument 的 outline 出。
   *
   * 这条判据钉的是「删掉的那次读没有以任何形式回来」：读回归会让第二个断言变 1，
   * 而重复触发（effect 依赖漂移、StrictMode 双调用泄漏到生产构建）会让第一个变 ≥2。
   * 两者都不会让工作台看起来有问题，只会让打开一个真实事件文件多付一整趟 Bridge。
   */
  const after = await ipcCalls(app);
  expect(after['resource.readEmevdFullDocument'] ?? 0).toBe(1);
  expect(after['resource.readEmevdDocument'] ?? 0).toBe(0);

  await app.close();
});

/** 打开事件文档的 fixture 观测记录（到达时刻 / 落地顺序 / 取消次数 / 生效延迟）。 */
async function emevdOpenLog(app) {
  return app.evaluate(() => global.__fixtureEmevdOpenLog ?? null);
}

test('EVENT-30B：快速切换 common → menu，旧请求被取消且不覆盖 UI', async () => {
  /*
   * fixture 给每次 readEmevdFullDocument 加延迟并复制生产的在飞槽契约（见
   * fixture-main.mjs 的 activeEmevdOpen）。没有延迟时 fixture handler 同步返回，
   * 两次点击必然串行走完，「后到的请求取代先到的」这个形态压根不出现。
   *
   * 延迟取 8000ms 而不是「够用就好」的几百毫秒：实测两次 `.file-item` 点击之间
   * 隔了 1990ms —— 第一次点击后中央区挂载 CodeMirror，布局抖动让第二次点击的
   * actionability 检查一直等。700ms 的延迟在那之前就到期了，两个请求全程串行、
   * fixture 两次都返回 ok，而 UI 断言当时仍然全绿（终态确实是 menu），整条用例
   * 静默退化成「顺序打开两个文件」。8000ms 给了 4 倍余量，下面的前提断言再兜一道。
   *
   * 覆盖的是行为：被放弃的请求既不能落成 EMEVD_LIVE_READ_FAILED 警告条，也不能把已经
   * 切走的文档写回工作台或建成标签页。
   *
   * **不能**声称覆盖 `if (full?.cancelled) return` 这一道。实测三格扰动矩阵（每格都
   * 重建 bundle 后跑）：
   *   full.cancelled 关 / 局部 cancelled 开 → 绿
   *   full.cancelled 开 / 局部 cancelled 关 → 绿
   *   两道都关                              → 红（2 个标签，common 抢到激活态）
   * 换文件时 React 必然先跑上一轮 effect 的 cleanup，局部 cancelled 一定已置位，所以
   * 这个场景里两道判据互为冗余，本用例只能证明「至少一道生效」。要单独钉住 full.cancelled
   * 得让 effect 不重跑而 main 仍取消（本 UI 里换文件做不到这个形态）。
   *
   * 生产主进程侧的中止（beginEmevdOpen → 停掉剩余分页读 / outline / 写
   * emevdFullDocuments / 整段反汇编）也不在这条 e2e 的覆盖范围内。
   */
  const delayMs = 8_000;
  const { app, window, pageErrors, consoleErrors } = await launchApp({
    SF_TEST_EMEVD_OPEN_DELAY_MS: String(delayMs)
  });
  await openFixtureWorkspace(window);
  await closeAgentPanel(window);

  // 快速切换：点 common 后**不等**工作台挂载就点 menu。
  await window.locator('.file-item', { hasText: 'event/common.emevd' }).click();
  await window.locator('.file-item', { hasText: 'event/menu.emevd' }).click();

  /*
   * 竞态前提断言 —— 必须在 UI 断言之前，且不能与 UI 断言共用分支。
   *
   * 前两条钉「两次请求真的重叠」：两次到达都发生了，且间隔小于延迟。间隔一旦超过
   * 延迟，第一次请求已经正常返回，取消分支根本没被走到 —— 那时下面的 UI 断言仍会
   * 全绿，而它们证明的东西已经变成「顺序打开」。第三条钉「fixture 确实返回了一次
   * cancelled」：这是取消契约被触发的直接观测，缺了它，前两条只能证明时间窗重叠，
   * 不能证明主进程侧真的取代了旧请求。
   */
  await expect.poll(
    async () => (await emevdOpenLog(app))?.arrivals.length ?? 0,
    { timeout: 20_000 }
  ).toBe(2);
  const log = await emevdOpenLog(app);
  const gapMs = log.arrivals[1].atMs - log.arrivals[0].atMs;
  expect(
    gapMs,
    `两次打开请求间隔 ${gapMs}ms，已不小于 fixture 延迟 ${log.delayMs}ms：`
    + '第二次请求落在第一次之后，本用例不再覆盖取消分支（加大 delayMs 或查为何点击变慢）'
  ).toBeLessThan(log.delayMs);
  expect(log.arrivals[0].sourceUri).toBe('fixture://event/common.emevd');
  expect(log.arrivals[1].sourceUri).toBe('fixture://event/menu.emevd');
  await expect
    .poll(async () => (await emevdOpenLog(app))?.cancelled ?? 0, { timeout: 20_000 })
    .toBe(1);

  /*
   * 第四条前提：被放弃的 common 必须**迟于** menu 落地。
   *
   * 这条不是锦上添花 —— 少了它，整条用例只能证明「旧响应不得建标签页」。要证的另一半
   * 是「迟到的旧响应不得覆盖已经正确的 UI」，前提就是旧响应真的迟到；若 common 先落地，
   * 后到的 menu 会自然把 UI 盖成正确终态，即便 renderer 侧的 cancelled 判据被整条删掉
   * 也全绿。fixture 的递减延迟负责制造这个顺序，这里负责证明它成立。
   */
  const settled = (await emevdOpenLog(app)).settlements;
  expect(
    settled.map((s) => `${s.sourceUri}${s.cancelled ? '(cancelled)' : ''}`),
    '被放弃的 common 必须最后落地，否则本用例覆盖不到「迟到的旧响应不得覆盖 UI」'
  ).toEqual([
    'fixture://event/menu.emevd',
    'fixture://event/common.emevd(cancelled)'
  ]);

  const workbench = window.locator('[aria-label="Event 源码工作台"]');
  await expect(workbench.locator('[data-editor-engine="codemirror"] .cm-editor')).toBeVisible();
  const content = workbench.locator('.esw-source__host .cm-content');

  /*
   * 终态只剩最后选中的那份。上面的 settlements 断言已经确认 common（被取消的那份）
   * 最后落地，所以走到这里两份响应都已经进过 renderer：少了 cancelled 判据时，UI 会
   * 先显示 menu 再被 common 盖回去，下面这些断言看到的就是被盖回去之后的状态。
   *
   * 原先这里是 waitForTimeout(1500)，按等长延迟算的（以为两份只差 2s）。递减延迟下
   * common 迟到约 4s，固定 1500ms 会在覆盖发生**之前**跑完 UI 断言 —— 正是「断言在
   * 事故前通过」的假绿。现在等待条件是观测量，不是猜的墙钟。
   */
  // 失败时把 fixture 侧观测量一并抛出：只看 UI 断言分不清「旧响应盖了 UI」和
  // 「又发了一趟新请求」，这两种原因的修法完全不同。
  try {
    await expect(content).toContainText('resource "fixture://event/menu.emevd"');
  } catch (err) {
    const at = await emevdOpenLog(app);
    const tabTitles = await workbench.locator('[role="tab"]').allInnerTexts();
    const calls = await ipcCalls(app);
    throw new Error(
      `${err.message}\n\n=== 失败时观测量 ===\n`
      + `arrivals: ${JSON.stringify(at?.arrivals)}\n`
      + `settlements: ${JSON.stringify(at?.settlements)}\n`
      + `cancelled: ${at?.cancelled}\n`
      + `readEmevdFullDocument 调用次数: ${calls['resource.readEmevdFullDocument'] ?? 0}\n`
      + `标签: ${JSON.stringify(tabTitles)}`
    );
  }
  await expect(content).toContainText('event @e:ev100');
  await expect(content).not.toContainText('event @e:ev50');
  await expect(content).not.toContainText('event @e:ev60');

  // 取消不是解析失败：不得出现「读不出来」的警告条。
  await expect(workbench.getByText('这个事件脚本读不出来。')).toHaveCount(0);
  await expect(workbench.getByText('EMEVD_LIVE_READ_FAILED')).toHaveCount(0);

  // 标签只剩 menu：common 的响应被丢弃，从未成为标签。
  const tabs = workbench.locator('[role="tab"]');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toContainText('menu');

  expect(pageErrors, `pageerror: ${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console error: ${consoleErrors.join('\n')}`).toEqual([]);

  await window.screenshot({ path: 'test-results/12-event-fast-switch.png' });
  await app.close();
});

test('EVENT-30B：event→PARAM 切离事件域必须发出取消 IPC', async () => {
  const delayMs = 8_000;
  const { app, window, pageErrors, consoleErrors } = await launchApp({
    SF_TEST_EMEVD_OPEN_DELAY_MS: String(delayMs)
  });
  await openFixtureWorkspace(window);
  await closeAgentPanel(window);
  await window.locator('.file-item', { hasText: 'event/common.emevd' }).click();
  await expect.poll(
    async () => (await emevdOpenLog(app))?.arrivals.length ?? 0,
    { timeout: 10_000 }
  ).toBe(1);
  await window.locator('[data-domain="param"]').click();
  await expect.poll(
    async () => (await ipcCalls(app))['resource.cancelEmevdFullDocument'] ?? 0,
    { timeout: 10_000 }
  ).toBeGreaterThan(0);
  await expect.poll(
    async () => (await emevdOpenLog(app))?.cancelled ?? 0,
    { timeout: 20_000 }
  ).toBeGreaterThan(0);
  expect(pageErrors, `pageerror: ${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console error: ${consoleErrors.join('\n')}`).toEqual([]);
  await app.close();
});

test('S16 脚本 IDE：容器 Files|Source 两栏，明文/反编译可编辑，Ctrl+S 应用', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // S16：脚本容器资源从开始侧栏资源树选择，进入 Files | Source 两栏脚本 IDE。
  await selectFileItem(window, 'script/m25_00_00_00.luabnd.dcx');
  // WorkbenchLayout 根是 div(.workbench)带 aria-label,不是 section/region。
  await expect(window.getByLabel('脚本容器工作台')).toBeVisible();

  // 两栏（不用三栏/四栏模板：无 Container、Metadata、Tools/Symbols）。
  await expect(window.getByRole('region', { name: 'Files' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Source' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Container / Files' })).toHaveCount(0);
  await expect(window.getByRole('region', { name: 'Metadata' })).toHaveCount(0);
  await expect(window.getByRole('region', { name: 'Tools' })).toHaveCount(0);

  // 明文条目：可编辑源码 + 形态明示。
  await window.getByRole('row', { name: /goal_list\.lua/ }).click();
  const source = window.getByRole('region', { name: 'Source' });
  await expect(source).toContainText('goal_list.lua');
  await expect(source).toContainText('明文源码');
  await expect(source).toContainText('goal = { name = "合成目标"');

  // 编辑 → Ctrl+S 应用（S14 话术）+ 未保存标记。
  await window.locator('[data-editor-engine="codemirror"] .cm-content').click();
  await window.keyboard.press('Control+End');
  await window.keyboard.type('\n-- e2e 追加');
  await expect(window.locator('.scp-dirty')).toHaveText('未保存');
  await window.keyboard.press('Control+s');
  await expect(window.getByTestId('scp-status')).toHaveText('已应用，可回滚。');

  // 字节码条目：本机 DSLuaDecompiler 反编译文本（来源明示，不是 fake hex）。
  await window.getByRole('row', { name: /battle\.lua/ }).click();
  await expect(source).toContainText('反编译源码');
  await expect(source).toContainText('DSLuaDecompiler');
  await expect(source).toContainText('function BattleStart()');
  await expect(source).toContainText('SetHp(1000)');

  await window.screenshot({ path: 'test-results/06-script-workbench.png' });
  await app.close();
});


test('S16 脚本 IDE：独立 .hks 单 Source，打开即反编译，Ctrl+S 应用', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 独立脚本文件（.hks）：单 Source 栏，不落容器分页。
  await selectFileItem(window, 'script/c0000_common.hks');
  await expect(window.getByLabel('脚本编辑')).toBeVisible();
  await expect(window.getByRole('region', { name: 'Files' })).toHaveCount(0);

  const source = window.getByRole('region', { name: 'Source' });
  await expect(source).toContainText('c0000_common.hks');
  await expect(source).toContainText('反编译源码');
  await expect(source).toContainText('BEH_ADD_NONE = 0');
  await expect(source).toContainText('可编辑 · Ctrl+S 应用');

  // 编辑 → Ctrl+S 应用。
  await window.locator('[data-editor-engine="codemirror"] .cm-content').click();
  await window.keyboard.press('Control+End');
  await window.keyboard.type('\n-- standalone 追加');
  await window.keyboard.press('Control+s');
  await expect(window.getByTestId('scp-status')).toHaveText('已应用，可回滚。');

  await window.screenshot({ path: 'test-results/06-script-standalone.png' });
  await app.close();
});



test('S8：Agent dock 可缩到 96px（下限 96，上限 620，默认 440）', async () => {
  const { app, window } = await launchApp();
  // localStorage 可能持久化了上一轮的 dock 宽度（agentDock UI key）：清掉后重载，
  // 「默认 440」断言不受上一轮运行影响。
  //
  // 清两次：App 的持久化 effect 是异步 flush 的，第一次清理可能被它把旧宽度
  // 写回（实测竞态：清理 → persist effect 写回旧值 → reload 后恢复 effect 又
  // 读到旧值，440 断言稳定失败）。等 flush 完再清一次，reload 时才是干净的。
  const clearDockKeys = () => window.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('soulforge.ui.agentDock.v1.')) localStorage.removeItem(key);
    }
  });
  await clearDockKeys();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await clearDockKeys();
  await window.reload();
  // localStorage 可能持久化了上一轮的收起状态：先确保 dock 展开，resizer 才可交互。
  const agentToggle = window.getByRole('button', { name: 'AI Agent 面板' });
  if ((await agentToggle.getAttribute('aria-pressed')) === 'false') {
    await agentToggle.click();
  }
  // resizer 在（aria 值与 App/样式同一常量）。
  const resizer = window.locator('.agent-dock-resizer');
  await expect(resizer).toHaveAttribute('aria-valuemin', '96');
  await expect(resizer).toHaveAttribute('aria-valuemax', '620');
  await expect(resizer).toHaveAttribute('aria-valuenow', '440');
  await resizer.focus();
  await window.keyboard.press('End');
  await expect(resizer).toHaveAttribute('aria-valuenow', '620');
  // Home → 96：够放「引用 + 发送」，不是 0、不是一条缝。
  await window.keyboard.press('Home');
  await expect(resizer).toHaveAttribute('aria-valuenow', '96');
  await window.screenshot({ path: 'test-results/08-agent-min-96.png' });
  await app.close();
});


test('S9：Ask 菜单 portal 到 body 不被裁切，Esc/外侧点击/选中均关闭', async () => {
  const { app, window } = await launchApp();
  // localStorage 可能持久化了上一轮的收起状态：先确保 dock 展开。
  const agentToggle = window.getByRole('button', { name: 'AI Agent 面板' });
  if ((await agentToggle.getAttribute('aria-pressed')) === 'false') {
    await agentToggle.click();
  }
  const trigger = window.locator('.agent-mode-trigger');
  await expect(trigger).toContainText('Ask');
  await trigger.click();

  // 菜单是 body 直接子级（portal）：不再被 .agent/composer 的 overflow:hidden 裁掉。
  const menu = window.locator('body > .agent-mode-menu');
  await expect(menu).toHaveCount(1);
  await expect(menu).toContainText('Plan');
  await expect(menu).toContainText('Edit');
  // 完整落在视口内（矮窗口自动翻到 trigger 上方）。
  // 完整落在视口内（不依赖固定窗口高：矮窗口自动翻到 trigger 上方）。
  const fullyVisible = await window.evaluate(() => {
    const rect = document.querySelector('.agent-mode-menu').getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  });
  expect(fullyVisible).toBe(true);

  // Esc 关闭。
  await window.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // 再开，点外侧关闭。
  await trigger.click();
  await expect(menu).toHaveCount(1);
  await window.locator('.agent-composer__participant').click({ position: { x: 200, y: 2 } }).catch(() => undefined);
  await window.locator('[data-testid="agent-empty-state"], .agent-message, .ab-item').first().click({ position: { x: 5, y: 5 } });
  await expect(menu).toHaveCount(0);

  // 再开，选 Plan：菜单项真实可点（被裁掉的菜单点不到），模式切到 Plan。
  await trigger.click();
  await menu.getByRole('option', { name: /Plan/ }).click();
  await expect(trigger).toContainText('Plan');
  await expect(menu).toHaveCount(0);

  // 矮窗口：菜单向下放会越出窗口底，应翻到 trigger 上方且完整可见。
  await window.setViewportSize({ width: 633, height: 379 });
  // Electron 窗口 resize 异步落地：等真实 innerHeight 与 trigger 新布局到位再点开。
  await expect.poll(() => window.evaluate(() => window.innerHeight)).toBe(379);
  await expect.poll(() => window.evaluate(() =>
    document.querySelector('.agent-mode-trigger').getBoundingClientRect().top
  )).toBeLessThan(400);
  await trigger.click();
  await expect(menu).toHaveCount(1);
  // 等锚点/翻转 effect 落地（重开不再用旧坐标渲染）。
  await expect.poll(() => window.evaluate(() =>
    parseFloat(document.querySelector('.agent-mode-menu').style.top) || 0
  )).toBeLessThan(400);
  const flippedVisible = await window.evaluate(() => {
    const rect = document.querySelector('.agent-mode-menu').getBoundingClientRect();
    const trigger = document.querySelector('.agent-mode-trigger').getBoundingClientRect();
    return {
      visible: rect.top >= 0 && rect.bottom <= window.innerHeight,
      aboveTrigger: rect.bottom <= trigger.top + 1,
      menuTop: rect.top, menuBottom: rect.bottom, menuHeight: rect.height,
      triggerTop: trigger.top, triggerBottom: trigger.bottom,
      innerHeight: window.innerHeight
    };
  });

  expect(flippedVisible.visible).toBe(true);
  expect(flippedVisible.aboveTrigger).toBe(true);
  await window.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  await app.close();
});


test('S10：引用框选——@/# 合成「引用」，PARAM 行+字段框选生成引用 chip，发送后标签随会话可见', async () => {
  const { app, window } = await launchApp();
  await openFixtureWorkspace(window);

  // 打开 PARAM 工作台，选中 ActionGuideParam 第 100 行（行与字段都可引用）。
  await selectFileItem(window, 'param/gameparam/gameparam.parambnd.dcx');
  await window.locator('.wb-list .wb-row', { hasText: 'ActionGuideParam' }).click();
  await window.locator('.wb-virtual-row', { hasText: '100' }).click();
  const atkProp = window.locator('.wb-prop', { hasText: '攻击力' });
  await expect(atkProp).toBeVisible();

  // 1) Composer 工具栏（S10 拍死）：@/# 两钮已合成一个「引用」钮。
  const citeButton = window.getByRole('button', { name: '引用框选' });
  await expect(citeButton).toHaveAttribute('aria-pressed', 'false');
  await expect(window.getByRole('button', { name: '添加 Agent 参与者' })).toHaveCount(0);
  await expect(window.getByRole('button', { name: '添加当前文件上下文' })).toHaveCount(0);

  // 2) 点「引用」：中央编辑区盖暗幕（Agent 区不盖——发送按钮仍可见可点）。
  await citeButton.click();
  await expect(window.getByTestId('cite-scrim')).toBeVisible();
  await expect(citeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(window.getByRole('button', { name: '发送' })).toBeVisible();

  // 3) Esc 取消框选（拍死行为），再点「引用」重新进入。
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('cite-scrim')).toHaveCount(0);
  await expect(citeButton).toHaveAttribute('aria-pressed', 'false');

  // 4) 空框选（框住没有 data-cite 的标签条空白区）：提示「这块还不能引用」，
  //    不瞎编引用、不产生 chip。
  await citeButton.click();
  const tabbarBox = await window.locator('.tabbar').boundingBox();
  // 布局可能横向溢出窗口（editor-area 起点为负）：鼠标坐标必须钳制到可见区。
  const tabbarX = Math.max(0, tabbarBox.x);
  await window.mouse.move(tabbarX + 40, tabbarBox.y + 12);
  await window.mouse.down();
  await window.mouse.move(tabbarX + 160, tabbarBox.y + 20, { steps: 4 });
  await window.mouse.up();
  // 引用 chip 在资源引用块内（.ctx-chip 也匹配常驻的上下文 chip：#files / #文件）。
  const refChips = window.locator('[data-testid="agent-resource-references"] .ctx-chip');
  await expect(window.locator('.toast--warn').filter({ hasText: '这块还不能引用' })).toHaveCount(1);
  await expect(window.getByTestId('cite-scrim')).toHaveCount(0);
  await expect(refChips).toHaveCount(0);

  // 5) 框住行 100 与「攻击力」字段：松开结算 → 一条引用 chip（固定格式逻辑
  //    标签：param/<库短名>/<表名>/<行id>-<行名>【<字段中文>：<值>】，无磁盘路径）。
  await citeButton.click();
  const rowBox = await window.getByRole('row', { name: /100 引导-基础/ }).boundingBox();
  const fieldBox = await atkProp.boundingBox();
  // 布局可能横向溢出窗口：拖拽起终点都钳制到可见区。
  const dragX = Math.max(0, rowBox.x + 30);
  const dragEndX = Math.min(window.viewportSize?.width ?? 1280, fieldBox.x + fieldBox.width - 30);
  await window.mouse.move(dragX, rowBox.y + 5);
  await window.mouse.down();
  await window.mouse.move(dragEndX, fieldBox.y + fieldBox.height - 5, { steps: 6 });
  await window.mouse.up();
  // 拖框从行 100 盖到「攻击力」字段：命中的同表同行字段（name/behavior/攻击力）
  // 全部按框选顺序并入 label（S10：「字段按框中的字段列出」）。
  await expect(refChips).toContainText('param/gameparam/ActionGuideParam/100-引导-基础');
  await expect(refChips).toContainText('【攻击力：0】');
  await expect(refChips).toContainText('【behavior：1】');
  expect(await refChips.innerText()).not.toContain('\\');
  await expect.poll(async () => (await ipcCalls(app))['agent.citation.create'] ?? 0).toBeGreaterThan(0);

  // 6) 发送：引用 chip 随 runAiAgent 提交（fixture 记录 resources 数量；生产侧
  //    main 校验 token 后把引用拼进系统提示——模型能看到哪张表哪一行哪些字段）。
  await window.locator('.agent__composer textarea').fill('看看这条引用');
  await window.locator('.agent__composer').getByRole('button', { name: '发送' }).click();
  await expect.poll(async () => (await ipcCalls(app))['ai.agent.run:resources=1'] ?? 0)
    .toBeGreaterThan(0);

  // 7) chip 可叉掉（一次框选一条引用 chip，可多次框选累加、逐条移除）。
  await window.locator('[data-testid="agent-resource-references"] .ctx-chip__remove').first().click();
  await expect(refChips).toHaveCount(0);

  await window.screenshot({ path: 'test-results/s10-cite-select.png' });
  await app.close();
});


test('S14/S15：事件失败读取给 code + 人话 + 下一步，无假 resource 伪源码，无 Bridge 字样', async () => {
  const { app, window, pageErrors, consoleErrors } = await launchApp();
  await openFixtureWorkspace(window);

  // 打开 KRAK 失败样本（fixture 模拟「未挂原版」的 KRAK 可行动句）。
  await selectFileItem(window, 'event/krak.emevd.dcx');
  const workbench = window.locator('[aria-label="Event 源码工作台"]');
  await expect(workbench.locator('[data-editor-engine="codemirror"] .cm-editor')).toBeVisible();

  // S14：没有橙色眉题 / 黄条 / 只读标签 / 编译并提交按钮。
  await expect(workbench.locator('.event-source__header')).toHaveCount(0);
  await expect(workbench.locator('.event-source__notice')).toHaveCount(0);
  await expect(workbench.getByText('反汇编源码只读')).toHaveCount(0);
  await expect(workbench.getByRole('button', { name: '编译并提交' })).toHaveCount(0);

  // S15：正文是可行动句（KRAK → 去「开始」页挂原版），不出现假 resource 伪源码、
  // 不出现「详情见底部日志」、不出现 Bridge / 补丁引擎字样。
  const content = workbench.locator('.esw-source__host .cm-content');
  await expect(content).toContainText('KRAK 压缩');
  await expect(content).toContainText('sekiro.exe');
  await expect(content).toContainText('[EMEVD_DOCUMENT_READ_FAILED]');
  await expect(content).not.toContainText('resource "file://');
  await expect(content).not.toContainText('详情见底部日志');
  await expect(workbench).not.toContainText('Bridge');
  await expect(workbench).not.toContainText('补丁引擎');

  // 标签是短名（krak），不显示 event/… 路径。
  await expect(workbench.locator('[role="tab"]').first()).toContainText('krak');

  expect(pageErrors, `pageerror: ${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console error: ${consoleErrors.join('\n')}`).toEqual([]);

  await window.screenshot({ path: 'test-results/12-event-krak-failure.png' });
  await app.close();
});


test('S-FILE-ROLLBACK：审计面板文件级回滚 UI 走 rollbackFile 通道，回滚后条目置为已回滚', async () => {
  const { app, window, pageErrors, consoleErrors } = await launchApp({ SF_FIXTURE_OPERATIONS: '1' });
  await openFixtureWorkspace(window);
  // 打开审计与回滚面板：S33 起活动栏四图标删除，审计入口在开始侧栏「工具」折叠区。
  await window.getByTestId('start-sidebar-tools').locator('summary').click();
  await window.getByRole('button', { name: '审计与回滚' }).click();

  // 种子历史：两条 committed 记录。
  const entries = window.locator('.audit-entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText('fixture 写入：item.fmg 文本');
  await expect(entries.nth(0).locator('.op-status')).toHaveText('已提交');

  // 第一条：两个文件行 + 两个「回滚此文件」按钮（details 默认收起，先展开）。
  await entries.nth(0).locator('.audit-entry__files summary').click();
  const firstFiles = entries.nth(0).locator('.audit-entry__file');
  await expect(firstFiles).toHaveCount(2);
  await expect(firstFiles.nth(0)).toContainText('item.fmg');
  await expect(firstFiles.nth(0).getByRole('button', { name: '回滚此文件' })).toBeVisible();
  await expect(firstFiles.nth(1)).toContainText('menu.fmg');
  await expect(firstFiles.nth(1).getByRole('button', { name: '回滚此文件' })).toBeVisible();

  // 第二条：路径未脱敏映射 → 只显示提示，不提供回滚按钮。
  const secondFiles = entries.nth(1).locator('.audit-entry__file');
  await expect(secondFiles).toHaveCount(1);
  await expect(secondFiles.getByRole('button', { name: '回滚此文件' })).toHaveCount(0);
  await expect(secondFiles.locator('.audit-entry__file-hint')).toHaveText('路径未脱敏映射，不可单文件回滚');

  // 点击第一项第一文件的「回滚此文件」→ 成功反馈（toast）。
  await firstFiles.nth(0).getByRole('button', { name: '回滚此文件' }).click();
  await expect(window.locator('.toast--ok').filter({ hasText: '已回滚文件' })).toHaveCount(1);

  // 刷新后该条目变为「已回滚」，动作区（含文件级回滚列表）随 committed 条件消失。
  await window.getByRole('button', { name: '刷新' }).click();
  await expect(entries.nth(0).locator('.op-status')).toHaveText('已回滚');
  await expect(entries.nth(0).locator('.audit-entry__actions')).toHaveCount(0);
  // 未触碰的条目保持 committed，仍可单文件回滚。
  await expect(entries.nth(1).locator('.op-status')).toHaveText('已提交');

  expect(pageErrors, `pageerror: ${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `console error: ${consoleErrors.join('\n')}`).toEqual([]);

  await window.screenshot({ path: 'test-results/file-rollback-audit.png' });
  await app.close();
});
