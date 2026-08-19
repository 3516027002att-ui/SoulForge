/**
 * 问题 5-E：大表（5275 行 / 221 字段）打开速度与滚动帧间隔门禁。
 *
 * 为什么测帧间隔而不是「某个组件必须 memo」：用户报的「快速下拉卡顿」在
 * 默认 fixture（最大 25 行 / 4 字段）里根本复现不出来。行为级判据（帧间隔、
 * 露白、总滚动量）只对真实工作量敏感 —— 换了实现只要结果不变就继续绿，
 * 不会像「必须有 useMemo」那样在正确重构后误红。
 *
 * 为什么必须 show() 窗口：隐藏窗口下 Chromium 节流 BeginFrame，rAF 停摆或
 * 降到 1fps，帧间隔测出来全是假的（要么恒巨大要么零样本）。
 *
 * 为什么不能用 mouse.wheel：wheel 是异步手势事件，浏览器会做滚动动画与事件
 * 合并，帧内位移量不可控，测出来的是「事件分发节奏」而不是「虚拟化跟不跟得
 * 上」。这里直接改 scrollTop（虚拟化只认这个），每帧位移固定。
 *
 * 为什么 240px/帧 和 2200px/帧 都要单独测：240px/帧（≈11 行/帧）是用户平缓
 * 下拉；2200px/帧（≈100 行/帧，整窗换新）是快速甩滚。前者慢帧是虚拟化渲染
 * 成本，后者是整窗重建成本，两者都可能卡。
 *
 * 为什么还要测露白（worstGap）与总滚动量（jank.scrolled / fling.scrolled /
 * blank.sampled）：帧间隔只说明「帧来的慢」，不说明「画面有没有空」。跳帧
 * 期间可视区可能整片空白（虚拟行没跟上 scrollTop），那是用户最直观的「卡」。
 * 滚动量下限与采样数下限是防零样本假绿 —— 滚动没动、只采到几个空帧也能
 * 算出漂亮的 p95，那种绿不算数。
 *
 * 两条测试都只在 spec 自己的 env 里开 SF_TEST_LARGE_PARAM /
 * SF_TEST_PARAM_READ_DELAY_MS（fixture 默认关闭，见 fixture-main.mjs），
 * 不许写进 playwright.config.mjs 或 launchApp 默认值 —— 那会让默认套件左栏
 * 变成 138 项，现有 PARAM e2e 无故变慢或变脆。
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

// 大表行高由渲染器虚拟化 estimateSize 决定（22px/行），总滚动行程
// ≈ 5275 × 22 ≈ 116k px。2200px/帧 的甩滚在 ~53 帧内到达底部。
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 820;

async function launchApp(env = {}) {
  // userData 隔离（与 production-main.spec.mjs 同一范式）：默认 userData 与
  // 生产 dev 运行、其他 worktree 的 e2e 共用，shell 状态（上次工作域/选中资源，
  // App.tsx 6-C 经 localStorage 恢复）跨运行残留 —— 残留一旦命中 fixture-session，
  // 打开工作区后会被直接恢复进别的领域，开始页 h1 断言就挂。临时目录让每次
  // 运行都从全新 shell 状态开始。
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-e2e-param-perf-'));
  const app = await electron.launch({
    args: [fixtureMain, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ...env }
  });
  const window = await app.firstWindow();
  window.on('dialog', (dialog) => {
    dialog.accept().catch(() => undefined);
  });
  await window.waitForLoadState('domcontentloaded');
  // 隐藏窗口节流 rAF：帧间隔与露白测量必须真实渲染，先显示。
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.show();
  });
  // 视口固定 1280×820：默认 633×379 下 Rows 只放得下约 10 行，测出来
  // 系统性偏乐观（overscan 恒盖住视口，露白永远 0）。
  await window.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
  const cleanup = async () => {
    await app.close().catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, cleanup };
}

async function closeAgentPanel(window) {
  const close = window.getByRole('button', { name: '关闭 Agent 面板' });
  if (await close.isVisible().catch(() => false)) {
    await close.click();
  }
}

async function openFixtureWorkspace(window) {
  // 放大视口后侧栏与开始页有两个同名 open-workspace 按钮，裸 getByTestId
  // 会 strict mode violation：先收窄到开始页 region 再点。
  await window.getByRole('region', { name: '开始' }).getByTestId('open-workspace').click();
  await expect(window.locator('.project-overview h1')).toHaveText('fixture-workspace');
  await expect(window.locator('.welcome__stats')).toContainText('已解析');
}

async function openParamContainer(window) {
  // 「files」域在当前 IA 里是 hidden（domainNavigation.ts 的 visibility 裁定），
  // 域栏上没有它的 tab；资源树在开始侧栏直接可见，与 renderer.spec.mjs 的
  // selectFileItem 同一走法：收 Agent 面板后直接点文件项。
  await closeAgentPanel(window);
  await window.locator('.file-item', { hasText: 'param/gameparam/gameparam.parambnd.dcx' }).click();
  await expect(window.getByRole('region', { name: 'Params' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Rows' })).toBeVisible();
  await expect(window.getByRole('region', { name: 'Fields' })).toBeVisible();
}

/** 点左栏大表，等中栏首批行可见，返回中栏 hint 文本。 */
async function openLargeParam(window) {
  await window.getByRole('region', { name: 'Params' })
    .locator('.wb-row', { hasText: 'BehaviorParam' })
    .click();
  await expect(window.locator('.wb-virtual-row').first()).toBeVisible();
  return window.getByRole('region', { name: 'Rows' }).locator('.workbench__column-hint').innerText();
}

/**
 * 在滚动容器上跑一轮固定步进滚动，逐帧采样：
 *  - frames：相邻 rAF 的时间间隔（ms）
 *  - blank：每帧可视区内「已渲染行覆盖不到」的高度（px，未覆盖即露白）
 *  - scrolled：结束时 scrollTop 总位移
 * 测量发生在 step 之前：rAF 回调先于绘制，若上一帧的跳变还没渲染完，此刻
 * DOM 停在旧位置 —— 正好把「跟不上的那一帧」量成露白。
 */
async function measureScroll(window, stepPx, durationMs) {
  return window.evaluate(async ({ stepPx, durationMs }) => {
    const el = document.querySelector('.wb-virtual-scroll');
    if (!el) throw new Error('PARAM_PERF_NO_SCROLL_CONTAINER: 找不到 .wb-virtual-scroll');
    const frames = [];
    const blank = [];
    let last = null;
    const startedScrollTop = el.scrollTop;
    const containerRect = el.getBoundingClientRect();
    return await new Promise((resolve) => {
      let rafId = 0;
      const tick = () => {
        const now = performance.now();
        if (last !== null) frames.push(now - last);
        last = now;
        // 露白：可视区内行覆盖的下沿（不早于容器顶）到容器下沿的未覆盖高度。
        let maxBottom = containerRect.top;
        for (const row of el.querySelectorAll('.wb-virtual-row')) {
          const rect = row.getBoundingClientRect();
          if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
            if (rect.bottom > maxBottom) maxBottom = rect.bottom;
          }
        }
        blank.push(Math.max(0, containerRect.bottom - maxBottom));
        el.scrollTop += stepPx;
        rafId = requestAnimationFrame(tick);
      };
      tick();
      setTimeout(() => {
        cancelAnimationFrame(rafId);
        resolve({
          frames,
          blank,
          scrolled: el.scrollTop - startedScrollTop,
          samples: blank.length
        });
      }, durationMs);
    });
  }, { stepPx, durationMs });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(({ }, testInfo) => {
  test.skip(!hasBuild, 'renderer 未构建：先运行 npm run build -w @soulforge/desktop');
  void testInfo;
});

test('大表（5275 行 / 221 字段）：打开即出行，且选中行后快速下拉不卡顿', async () => {
  // SF_TEST_LARGE_PARAM 只能由本条自己打开（默认 fixture 3 张表，本测试没有对象）。
  test.setTimeout(180_000);
  const { window, cleanup } = await launchApp({ SF_TEST_LARGE_PARAM: '1' });
  await openFixtureWorkspace(window);
  await openParamContainer(window);
  const hint = await openLargeParam(window);
  expect(hint).toContain('5275 行');

  // 虚拟化还在：5275 行只挂 ~几十个 DOM 节点（< 200），不是全量渲染。
  const domRowCount = await window.locator('.wb-virtual-row').count();
  expect(domRowCount).toBeLessThan(200);

  // 选中首行 → 右栏按大表自己的 221 字段定义渲染（fixture 开关开着才有
  // fieldDefs；回落默认 4 个就测不出字段栏成本）。
  await window.locator('.wb-virtual-row').first().click();
  await expect(window.getByRole('region', { name: 'Fields' }).locator('.wb-prop')).toHaveCount(221);

  // 平缓下拉：240px/帧（≈11 行/帧），跑 ~1s。
  const jank = await measureScroll(window, 240, 1000);
  // 甩滚：2200px/帧（整窗换新 ≈100 行/帧），跑 ~1.2s（约 72 帧样本）。
  const fling = await measureScroll(window, 2200, 1200);

  for (const [label, run] of [['jank', jank], ['fling', fling]]) {
    const sorted = [...run.frames].sort((a, b) => a - b);
    const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
    const p95 = percentile(sorted, 95);
    expect(max, `${label} 最大帧间隔 < 120ms（实测 ${max.toFixed(1)}ms / ${run.samples} 帧）`)
      .toBeLessThan(120);
    expect(p95, `${label} p95 帧间隔 < 45ms（实测 ${p95.toFixed(1)}ms）`).toBeLessThan(45);
    const worstGap = run.blank.length > 0 ? Math.max(...run.blank) : 0;
    expect(worstGap, `${label} 露白 worstGap < 24px（实测 ${worstGap.toFixed(1)}px）`).toBeLessThan(24);
  }
  // 防零样本假绿：滚动必须真的滚了、露白采样必须真的采了。
  expect(jank.scrolled, `平缓下拉总位移 > 5000px（实测 ${jank.scrolled}px）`).toBeGreaterThan(5000);
  expect(fling.scrolled, `甩滚总位移 > 90000px（实测 ${fling.scrolled}px）`).toBeGreaterThan(90000);
  expect(jank.samples + fling.samples, '露白采样数 > 40（防零样本）').toBeGreaterThan(40);

  await cleanup();
});

test('打开大表的等待期间：中栏给出加载反馈，而不是纯空白', async () => {
  test.setTimeout(120_000);
  // 2500ms 延迟只由本条自己的 env 打开：默认 fixture 73ms 就答完，
  // 「行出来之前」那一帧抢不到。
  const { window, cleanup } = await launchApp({
    SF_TEST_LARGE_PARAM: '1',
    SF_TEST_PARAM_READ_DELAY_MS: '2500'
  });
  await openFixtureWorkspace(window);
  await openParamContainer(window);

  const rowsRegion = window.getByRole('region', { name: 'Rows' });
  await window.getByRole('region', { name: 'Params' })
    .locator('.wb-row', { hasText: 'BehaviorParam' })
    .click();

  // 行出来之前：加载反馈可见（role=status + 「读取行数据…」），一行业没有，
  // 且不得出现误导性的空态「没有匹配的行」。
  const status = rowsRegion.getByRole('status');
  await expect(status).toBeVisible();
  await expect(status).toHaveText('读取行数据…');
  await expect(window.locator('.wb-virtual-row')).toHaveCount(0);
  await expect(window.getByText('没有匹配的行。')).toHaveCount(0);

  // 行出来之后：指示器消失，hint 显示真实行数。
  await expect(window.locator('.wb-virtual-row').first()).toBeVisible();
  await expect(status).toBeHidden();
  await expect(rowsRegion.locator('.workbench__column-hint')).toContainText('5275 行');

  await cleanup();
});
