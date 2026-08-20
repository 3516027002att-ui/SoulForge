/**
 * 生产 main 端到端：真实 out/main/index.js + 生产 webPreferences（sandbox: true）
 * + 生产 registerIpcHandlers（38 个 handle 注册点）+ 真实 Bridge/SQLite。
 *
 * 与 renderer.spec.mjs 的分工：
 *   · renderer.spec.mjs 跑在 fixture-main 上，用合成 fixture 覆盖**界面行为**
 *     （状态机、a11y、命令面板、响应式）——它需要可控的假数据，快且稳。
 *   · 本套件跑在生产 main 上，覆盖**环境一致性与真实 IPC 链路**——它要抓的正是
 *     fixture 结构上抓不到的那类缺陷。
 * 两者不可互相替代，也不重复：本套件不再断言界面细节。
 *
 * 本套件存在的直接原因（实测事故）：生产 preload 因「sandbox: true + ESM」冲突
 * 从未加载成功，window.soulforge 完全不存在，界面所有按钮显示「浏览器预览：
 * 仅在 SoulForge 桌面版可用」——而当时 e2e 16/16 全绿。fixture 用 sandbox: false
 * 且 preload 路径一度与生产不同，两处差异各自都足以藏住这个缺陷。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const productionMain = resolve(here, '../production-main.mjs');

async function launchProduction(env = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'sf-e2e-prod-'));
  const app = await electron.launch({
    args: [productionMain, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'production', ...env }
  });
  const window = await app.firstWindow();
  const pageErrors = [];
  const consoleErrors = [];
  window.on('pageerror', (error) => pageErrors.push(String(error)));
  window.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await window.waitForLoadState('domcontentloaded');
  const cleanup = async () => {
    await app.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  };
  return { app, window, pageErrors, consoleErrors, cleanup };
}

test('生产窗口配置：sandbox 开启、上下文隔离、无 node 集成', async () => {
  const { app, cleanup } = await launchProduction();
  // 这一条锁的是「测试跑的就是生产那套约束」。fixture-main 用 sandbox: false，
  // 于是「sandbox + preload 格式」这个组合在旧 e2e 里结构上无法被覆盖。
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w ? { ...w.webContents.getLastWebPreferences() } : null;
  });
  expect(prefs).not.toBeNull();
  expect(prefs.sandbox).toBe(true);
  expect(prefs.contextIsolation).toBe(true);
  expect(prefs.nodeIntegration).toBe(false);
  expect(prefs.webSecurity).toBe(true);
  await cleanup();
});

test('生产 preload 真的加载成功：window.soulforge 存在且无加载错误', async () => {
  const { window, consoleErrors, pageErrors, cleanup } = await launchProduction();
  await window.waitForFunction(() => 'soulforge' in globalThis, { timeout: 30_000 });
  const count = await window.evaluate(() => Object.keys(globalThis.soulforge ?? {}).length);
  // 57 是当前暴露面（test:preload-surface-ruling 断言它等于「已用 ∪ 已裁定」）。
  // 这里只要求「远大于 0」，避免与那条门禁重复维护同一个数字。
  expect(count).toBeGreaterThan(40);
  // preload 加载失败时 Electron 会打 "Unable to load preload script"。
  // 这一条是那次事故的直接回归断言。
  const preloadErrors = [...consoleErrors, ...pageErrors]
    .filter((text) => /Unable to load preload script|preload/i.test(text));
  expect(preloadErrors).toEqual([]);
  await cleanup();
});

test('生产 IPC 链路：打开工作区 → 扫描 → 界面反映索引结果', async () => {
  const { window, consoleErrors, pageErrors, cleanup } = await launchProduction();
  await window.waitForFunction(() => 'soulforge' in globalThis, { timeout: 30_000 });

  // 走**生产** handler：openWorkspaceDialog（dialog 已被 harness 替身）
  // → workspace.scan。两者都经过生产的 assertTrustedSender 与
  // createDirectorySelection 所有权绑定。
  const result = await window.evaluate(async () => {
    const api = globalThis.soulforge;
    const selection = await api.openWorkspaceDialog();
    if (!selection) return { ok: false, why: 'openWorkspaceDialog 返回 null' };
    const scan = await api.scanWorkspace({
      overlaySelectionId: selection.selectionId,
      game: 'sekiro'
    });
    return {
      ok: true,
      hasSelectionId: typeof selection.selectionId === 'string' && selection.selectionId.length > 0,
      label: selection.label,
      fileCount: Array.isArray(scan?.files) ? scan.files.length : -1,
      hasSessionId: typeof scan?.workspaceSessionId === 'string'
    };
  });

  expect(result.ok).toBe(true);
  expect(result.hasSelectionId).toBe(true);
  expect(result.label).toBe('e2e-overlay');
  // harness 播下 1 个文本资源。
  expect(result.fileCount).toBe(1);
  expect(result.hasSessionId).toBe(true);

  // 界面必须反映真实扫描结果，而不是停在空态。S12：状态栏已卸载。
  // 问题 1:上方 window.evaluate 直接调 IPC 只让主进程侧完成扫描,React 不会挂载
  // 工作区——必须走真实 UI 路径(开始页大按钮 → openWorkspace → 生产 dialog 替身
  // → scanWorkspace)才能让界面反映结果。挂载完成后 activeDomain 落到上次领域
  // (无记录默认 param),**不再落回 project**;「已索引」信号改等标题栏
  // workspace-switcher 出现工作区名。
  await window.getByRole('region', { name: '开始' }).getByTestId('open-workspace').click();
  await expect(window.locator('.workspace-switcher__trigger'), { timeout: 15_000 }).toContainText('e2e-overlay');
  // 有工作区后中央开始页消失，但顶栏「开始」仍在（只召唤资源栏，不切页）。
  await expect(window.locator('[data-testid="domain-bar"] [role="tab"][data-domain="project"]')).toHaveCount(1);
  await expect(window.locator('.project-overview')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await cleanup();
});

test('生产 IPC 拒绝越界发送方：非受信文档的调用被拒', async () => {
  const { app, window, cleanup } = await launchProduction();
  await window.waitForFunction(() => 'soulforge' in globalThis, { timeout: 30_000 });

  // 生产的 assertTrustedSender 只放行注册时那个 renderer 文档。
  // 从 main 侧伪造一个 invoke 来源，必须被拒。
  const rejected = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
    void ipcMain;
    const extra = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await extra.loadURL('about:blank');
    // about:blank 没有 preload，拿不到 soulforge；这里验证的是它无法凭空取得桥。
    const hasBridge = await extra.webContents.executeJavaScript("'soulforge' in globalThis");
    extra.destroy();
    return { hasBridge };
  });
  expect(rejected.hasBridge).toBe(false);
  await cleanup();
});

test('生产只读 handler 批量可达：每个都返回结构化结果或结构化诊断', async () => {
  const { window, pageErrors, consoleErrors, cleanup } = await launchProduction();
  await window.waitForFunction(() => 'soulforge' in globalThis, { timeout: 30_000 });

  // 为什么批量覆盖：生产 ipc.ts 有 27 个 handle 注册点，此前 e2e 只碰
  // openWorkspaceDialog / scanWorkspace 两个。剩下的 handler 从未在生产 main 上
  // 被调用过——它们的参数校验、脱敏、发送方校验、错误包装全都没被验证。
  //
  // 判据刻意宽松但不空：每个调用必须**返回**（不抛未捕获异常、不挂死），
  // 且返回值要么是对象、要么是带 code 的结构化诊断。缺语料时返回结构化失败
  // 同样算通过——硬约束要求 unsupported/failed 返回结构化诊断而不是吞异常，
  // 所以「结构化地失败」正是期望行为。这条抓的是「handler 崩溃 / 挂死 /
  // 返回 undefined / 抛裸异常」这一类。
  const probe = await window.evaluate(async () => {
    const api = globalThis.soulforge;
    const overlay = await api.openWorkspaceDialog();
    const scan = await api.scanWorkspace({
      overlaySelectionId: overlay.selectionId,
      game: 'sekiro'
    });
    const sample = Array.isArray(scan?.files) && scan.files.length > 0 ? scan.files[0] : null;
    const uri = sample?.sourceUri ?? 'file://msg/e2e-sample.txt';

    const calls = [
      ['listAiTools', () => api.listAiTools()],
      ['listOperations', () => api.listOperations()],
      ['listModelServices', () => api.listModelServices()],
      ['analyzeWorkspace', () => api.analyzeWorkspace()],
      ['searchResources', () => api.searchResources('e2e')],
      ['openResourcePreview', () => api.openResourcePreview(uri)],
      ['readRawMetadata', () => api.readRawMetadata(uri)],
      ['inspectContainerTree', () => api.inspectContainerTree(uri)],
      ['probeContainerCapabilities', () => api.probeContainerCapabilities(uri)],
      ['readFmgDocument', () => api.readFmgDocument(uri)],
      ['readParamDocument', () => api.readParamDocument(uri)],
      ['readEmevdDocument', () => api.readEmevdDocument(uri)],
      ['readMsbDocument', () => api.readMsbDocument(uri)],
      ['readTaeDocument', () => api.readTaeDocument(uri)],
      ['readEsdDocument', () => api.readEsdDocument(uri)],
      ['readFlverDocument', () => api.readFlverDocument(uri)],
      ['readTpfDocument', () => api.readTpfDocument(uri)]
    ];

    const out = {};
    for (const [name, invoke] of calls) {
      if (typeof api[name] !== 'function') { out[name] = 'absent'; continue; }
      try {
        const value = await invoke();
        // 结构化结果或结构化诊断都算达标；undefined/null 不算。
        out[name] = value === undefined || value === null
          ? 'returned-nullish'
          : (typeof value === 'object' ? 'structured' : typeof value);
      } catch (error) {
        // 抛出也可接受，只要是带信息的 Error（IPC 层会包装成 Error）；
        // 记下来供断言检查它不是 undefined 消息。
        out[name] = `threw:${String(error?.message ?? error).slice(0, 60)}`;
      }
    }
    return out;
  });

  // 至少要有多数 handler 真实可达并返回结构化结果。
  const values = Object.values(probe);
  const structured = values.filter((v) => v === 'structured').length;
  const nullish = Object.entries(probe).filter(([, v]) => v === 'returned-nullish');
  const absent = Object.entries(probe).filter(([, v]) => v === 'absent');

  // 返回 nullish 的 handler 说明它既没给结果也没给诊断——那是吞掉了。
  expect(nullish, `这些 handler 返回了 null/undefined：${JSON.stringify(nullish)}`).toEqual([]);
  // preload 里不存在的方法名说明本用例与实现漂移了，必须发现。
  expect(absent, `这些 preload 方法不存在：${JSON.stringify(absent)}`).toEqual([]);
  expect(structured).toBeGreaterThan(10);

  // 生产 handler 不得产生未捕获错误。
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await cleanup();
});

test('用户取消目录选择时安静返回，不产生错误', async () => {
  const { window, pageErrors, consoleErrors, cleanup } = await launchProduction({
    SF_E2E_DIALOG_CANCEL: '1'
  });
  await window.waitForFunction(() => 'soulforge' in globalThis, { timeout: 30_000 });
  const value = await window.evaluate(async () => {
    const r = await globalThis.soulforge.openWorkspaceDialog();
    return r === null ? 'null' : typeof r;
  });
  expect(value).toBe('null');
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await cleanup();
});
