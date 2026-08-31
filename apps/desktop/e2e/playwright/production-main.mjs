/**
 * Playwright 生产 main harness：直接运行**真实的** out/main/index.js，
 * 只把最外层不可控依赖换成受控替身。
 *
 * 为什么必须有它（这是本文件存在的全部理由）：
 *
 * 旧的 fixture-main.mjs 自建 19 个 channel、用 sandbox: false、并且一度指向与
 * 生产不同的 preload 产物。后果是**实测发生过的**：生产 preload 因
 * 「sandbox: true + ESM」冲突从未加载成功，window.soulforge 完全不存在，
 * 界面上所有按钮显示「浏览器预览：仅在 SoulForge 桌面版可用」——而 e2e 16/16
 * 全绿。测试环境与生产环境的每一处差异，都是一个能藏住整类缺陷的地方，
 * 而这一处藏住的是「整个应用不可用」。
 *
 * 本 harness 的做法：**不重建任何东西**。它在 import 生产 main 之前先装好
 * dialog 替身，然后让生产 main 自己走完 app.whenReady → createWindow →
 * registerIpcHandlers 的全部真实流程。因此：
 *   · webPreferences 是生产那一份（含 sandbox: true），不可能与生产漂移；
 *   · preload 路径是生产那一份，preload 那类缺陷会被立刻抓到；
 *   · 38 个 handle 注册点全部是生产实现。
 *
 * 与生产的唯一差异（每条都写明理由）：
 *
 *  1. dialog.showOpenDialog 被替身。真实对话框是模态原生窗口，e2e 无法关闭它，
 *     会挂到超时。替身返回受控临时目录，于是 workspace.openDialog /
 *     openBaseDialog 两个 channel 的**生产实现**（createDirectorySelection 的
 *     发送方校验、selectionId 生成、所有权绑定）全部照常执行。
 *  2. userData 由 --user-data-dir 指向临时目录（Playwright 启动参数给）。
 *     这是 Electron 标准隔离，不改任何生产代码路径；SQLite、凭据 vault、
 *     operation log 都落在临时目录。
 *
 * 明确不做的事：不 stub 任何 IPC handler、不 stub Bridge、不 stub 数据库、
 * 不新建 BrowserWindow、不放宽 webPreferences。这些都是「测试与生产不一致」
 * 的来源，正是本文件要消除的东西。
 */
import { app, dialog } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outRoot = resolve(here, '../../out');

/** SF_E2E_DIALOG_CANCEL=1 时模拟用户在目录选择器里取消。 */
const CANCEL_DIALOG = process.env.SF_E2E_DIALOG_CANCEL === '1';

// 允许一次真实资源探针把生产 main 接到用户指定的 overlay/base；默认仍使用
// 隔离的合成目录，避免普通 e2e 读写用户工作区。
const externalOverlayRoot = process.env.SF_E2E_OVERLAY_ROOT?.trim();
const externalBaseRoot = process.env.SF_E2E_BASE_ROOT?.trim();
const overlayRoot = externalOverlayRoot || join(app.getPath('userData'), 'e2e-overlay');
const baseRoot = externalBaseRoot || join(app.getPath('userData'), 'e2e-base');

/** 测试工作区：目录结构镜像真实 mod 布局，内容是最小合法样本。 */
function seedWorkspace() {
  if (externalOverlayRoot || externalBaseRoot) return;
  for (const dir of ['msg', 'param', 'event', 'script']) {
    mkdirSync(join(overlayRoot, dir), { recursive: true });
  }
  mkdirSync(baseRoot, { recursive: true });
  // 纯文本资源：足以驱动文本预览/编辑链路，不需要 native parser 或真实语料。
  writeFileSync(join(overlayRoot, 'msg', 'e2e-sample.txt'), 'SoulForge e2e sample\n', 'utf8');
}

/**
 * 只替换 dialog.showOpenDialog。用属性覆盖而不是改生产代码——生产 handler 一行不动。
 * 必须在 import 生产 main 之前装好，否则窗口可能已经创建、首个对话框已经弹出。
 */
function stubDialog() {
  dialog.showOpenDialog = async (options) => {
    if (CANCEL_DIALOG) return { canceled: true, filePaths: [] };
    // 按标题区分 overlay / base，对应生产的两个 channel 语义。
    const title = typeof options?.title === 'string' ? options.title : '';
    const target = /原版/.test(title) ? baseRoot : overlayRoot;
    return { canceled: false, filePaths: [target] };
  };
}

seedWorkspace();
stubDialog();

// 让生产 main 自己跑完整流程。它的顶层就绑了 app.whenReady → createWindow →
// registerIpcHandlers，所以这里不需要（也不应该）自己建窗口。
await import(pathToFileURL(join(outRoot, 'main', 'index.js')).href);
