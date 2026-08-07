/**
 * Playwright fixture main：加载生产 preload 与构建产物，用合成 fixture
 * （微小、合法构造、明确标记）注册与生产同名的 IPC 通道，
 * 驱动 renderer 状态机的端到端测试。不触碰真实游戏资产。
 *
 * ── 覆盖边界（如实声明，不要读成「e2e 覆盖了 main」）──────────────────────
 *
 * 真实的部分：真 Electron 进程、真生产 preload（out/preload/index.cjs，CJS）、真
 * 构建后的 renderer、真 contextBridge 语义，以及**与生产同形态的发送方校验**
 * （handleTrusted 包装器 + assertTrustedSender，见下）。
 *
 * 不真实的部分：main 侧业务逻辑整体是 fixture。本文件自己注册 19 个 channel，
 * 生产 ipc.ts 有 56 个，且 registerIpcHandlers 从未被加载。因此以下**没有**被
 * e2e 覆盖，不得据本套件声称它们可用：
 *   - PARAM / EMEVD / 脚本容器 / TPF / TAE / FLVER / ESD 面板的读写与分页
 *     （readParamPage、readEmevdDocument、listScriptContainerEntriesPage 等）
 *   - saveText 等文本写入链路的 main 侧实现
 *   - Bridge 子进程、SQLite、utilityProcess、凭据 vault 的真实行为
 * 这些由 core smoke、契约门禁与 native 层分别覆盖。要把 e2e 提升为真实 main
 * 覆盖，需让本文件加载生产 registerIpcHandlers 并只把最外层依赖（Bridge、
 * SQLite、文件系统根）替换为受控替身——那是独立工作项。
 *
 * 环境变量：
 * - SF_TEST_APPLY_FAIL=1：FMG 写入返回 ORIGINAL_CHANGED_DURING_STAGING 失败。
 * - SF_TEST_CANCEL_DIALOG=1：workspace.openDialog 返回 null（用户取消路径）。
 * - SF_TEST_BROWSER_PREVIEW=1：创建无 preload 窗口，模拟普通浏览器预览表面。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(here, '../../out');
const APPLY_FAIL = process.env.SF_TEST_APPLY_FAIL === '1';
const CANCEL_DIALOG = process.env.SF_TEST_CANCEL_DIALOG === '1';
const BROWSER_PREVIEW = process.env.SF_TEST_BROWSER_PREVIEW === '1';

/** Synthetic fixture corpus — tiny, constructed, explicitly labeled (AGENTS.md §15). */
function makeFile({ dir, name, kind, formatKind, formatLabel, extension, compoundExtension, size = 2048 }) {
  const relativePath = dir ? `${dir}/${name}` : name;
  return {
    sourceUri: `fixture://${relativePath}`,
    game: 'sekiro',
    resourceKind: kind,
    parseStatus: 'parsed',
    diagnostics: [],
    relativePath,
    extension,
    compoundExtension,
    formatKind,
    formatLabel,
    size,
    mtimeMs: 0
  };
}

const fixtureFiles = [
  makeFile({ dir: 'event', name: 'common.emevd', kind: 'event', formatKind: 'emevd', formatLabel: 'EMEVD', extension: '.emevd', compoundExtension: '.emevd' }),
  makeFile({ dir: 'msg', name: 'test.msgbnd.dcx', kind: 'msg', formatKind: 'fmg', formatLabel: 'FMG', extension: '.dcx', compoundExtension: '.msgbnd.dcx' }),
  makeFile({ dir: 'action', name: 'c0000.tae', kind: 'action', formatKind: 'unknown', formatLabel: 'TAE', extension: '.tae', compoundExtension: '.tae' }),
  makeFile({ dir: 'ai', name: 'm10.aibnd.dcx', kind: 'ai', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.aibnd.dcx' }),
  makeFile({ dir: 'sfx', name: 'f0000.sfxbnd.dcx', kind: 'sfx', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.sfxbnd.dcx' }),
  makeFile({ dir: 'chr', name: 'sample.chrbnd.dcx', kind: 'chr', formatKind: 'bnd', formatLabel: 'BND4', extension: '.dcx', compoundExtension: '.chrbnd.dcx' }),
  makeFile({ dir: 'other', name: 'notes.txt', kind: 'other', formatKind: 'text', formatLabel: 'TXT', extension: '.txt', compoundExtension: '.txt' }),
  // unknown 不合并进 other：独立保留并在顶部栏显示警告计数。
  makeFile({ dir: '', name: 'regulation.bin', kind: 'unknown', formatKind: 'unknown', formatLabel: 'BIN', extension: '.bin', compoundExtension: '.bin' })
];

const fixture = {
  workspaceUri: 'fixture://workspace/sekiro-test',
  fmg: {
    sourceHash: 'fixture-hash-0001',
    entries: [
      { id: 100, text: '伤药葫芦' },
      { id: 101, text: '返回骨片' }
    ]
  }
};

/** IPC 调用计数：测试经 app.evaluate(() => global.__fixtureIpcCalls) 读取。 */
global.__fixtureIpcCalls = Object.create(null);
function track(channel) {
  global.__fixtureIpcCalls[channel] = (global.__fixtureIpcCalls[channel] ?? 0) + 1;
}

/**
 * 受信任的 renderer 主文档地址：window.webContents.id -> 归一化后的 document URL。
 *
 * 与生产 main 的 trustedRendererDocuments 同语义。fixture 必须自己也走这道校验，
 * 否则 e2e 跑的是一个**没有安全层的** main —— 生产侧 assertTrustedSender
 * （ipc.ts 的 handle 包装器里，56 个 channel 的必经之路）在 e2e 中零覆盖，
 * 而它正是「渲染进程被导航到外部页面后不得继续调 IPC」这条边界的唯一执行点。
 */
const trustedRendererDocuments = new Map();

function normalizeRendererDocumentUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * 与生产 ipc.ts:assertTrustedSender 逐条件对齐。
 *
 * 刻意不留「关闭校验」的环境变量开关：那种开关会成为绕过安全断言的后门，而
 * 后门存在本身就让「e2e 覆盖了安全层」这句话失效。做负向证明时临时改这个函数
 * 并在验证后还原（本轮已实测：临时放行后用例报 unexpectedly-allowed 并失败）。
 */
function assertTrustedSender(event, channel) {
  const expectedDocument = trustedRendererDocuments.get(event.sender.id);
  const frame = event.senderFrame;
  const actualDocument = frame ? normalizeRendererDocumentUrl(frame.url) : null;
  if (!expectedDocument
    || !frame
    || frame !== event.sender.mainFrame
    || actualDocument !== expectedDocument) {
    throw new Error(`已拒绝不受信任的 IPC 调用：${channel}`);
  }
}

/**
 * 注册 channel 的统一入口，镜像生产 ipc.ts 的 handle 包装器：
 * 先校验发送方，再执行 handler。
 *
 * 用包装器而不是在每个 handler 里手写校验：生产侧就是这个形态（一处包装、
 * 56 个 channel 必经），fixture 若逐个手写会漏，而漏掉的那个 channel 在 e2e
 * 里就成了「绕过安全层也能通」的样本。
 */
function handleTrusted(channel, listener) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel);
    return listener(event, ...args);
  });
}

function registerFixtureIpc() {
  handleTrusted('workspace.openDialog', () => {
    track('workspace.openDialog');
    if (CANCEL_DIALOG) return null;
    return { selectionId: 'fixture-overlay', label: 'fixture-overlay' };
  });

  handleTrusted('workspace.scan', () => {
    track('workspace.scan');
    return {
      workspaceSessionId: 'fixture-session',
      workspaceLabel: 'fixture-workspace',
      files: fixtureFiles.map((file) => ({ ...file })),
      countsByKind: {
        event: 1, map: 0, param: 0, msg: 1, menu: 0, script: 0,
        action: 1, ai: 1, sfx: 1, chr: 1, obj: 0, other: 1, unknown: 1
      },
      diagnostics: [],
      session: {
        workspaceSessionId: 'fixture-session',
        workspaceLabel: 'fixture-workspace',
        game: 'sekiro',
        openedAt: new Date().toISOString(),
        baseMounted: false
      }
    };
  });

  handleTrusted('workspace.analyze', () => ({
    parsedFiles: fixtureFiles.length,
    inspectedFiles: fixtureFiles.length,
    referenceStats: { high: 0, medium: 0, low: 0, suppressedAmbiguousNumbers: 0 },
    diagnostics: [],
    events: [],
    tools: []
  }));

  handleTrusted('workspace.openBaseDialog', () => {
    track('workspace.openBaseDialog');
    if (CANCEL_DIALOG) return null;
    return { selectionId: 'fixture-base', label: 'fixture-base' };
  });

  handleTrusted('resource.search', () => []);
  handleTrusted('resource.preview', () => null);

  // 容器工作台合成通道：微小、合法构造、明确标记（AGENTS.md §15）。
  const containerChildren = [
    {
      childId: '0', name: 'item.fmg', offset: 0, size: 512,
      hash: 'fixture-child-0000', formatKind: 'fmg',
      sourceContainerUri: 'fixture://msg/test.msgbnd.dcx',
      childUri: 'fixture://msg/test.msgbnd.dcx#0',
      rawBytesAvailable: false, canReplace: false
    },
    {
      childId: '1', name: 'menu.fmg', offset: 512, size: 512,
      hash: 'fixture-child-0001', formatKind: 'fmg',
      sourceContainerUri: 'fixture://msg/test.msgbnd.dcx',
      childUri: 'fixture://msg/test.msgbnd.dcx#1',
      rawBytesAvailable: false, canReplace: false
    }
  ];
  handleTrusted('resource.inspectContainerTree', (_event, uri) => ({
    ok: true,
    rootUri: uri,
    root: {
      uri, format: 'bnd4', authority: 'fixture', magic: 'BND4',
      size: 2048, hash: 'fixture-container-0001', childCount: containerChildren.length,
      canListChildren: true, canReadChild: false, canReplaceChild: false,
      canRepackContainer: false, containerRoundTripSafe: false,
      decompressionStatus: 'not-applicable', compressionStatus: 'not-applicable'
    },
    diagnostics: []
  }));
  handleTrusted('resource.listContainerChildrenPage', (_event, _uri, page, pageSize) => ({
    ok: true,
    totalCount: containerChildren.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(containerChildren.length / pageSize)),
    children: containerChildren.slice(page * pageSize, page * pageSize + pageSize),
    diagnostics: []
  }));
  handleTrusted('resource.listContainerChildren', () => ({
    ok: true,
    children: containerChildren.map((child) => ({ ...child })),
    diagnostics: []
  }));
  handleTrusted('operation.list', () => []);
  handleTrusted('operation.rollback', (_event, opId) => ({
    ok: false,
    opId,
    restoredFiles: [],
    diagnostics: [{ severity: 'warning', code: 'FIXTURE_NO_ROLLBACK', message: 'fixture 不提供回滚。' }]
  }));
  handleTrusted('ai.tools', () => []);
  handleTrusted('ai.sidebarDraft', () => ({
    summary: 'fixture draft',
    steps: [],
    evidence: [],
    diagnostics: []
  }));
  handleTrusted('modelService.list', () => []);
  handleTrusted('modelService.encryptionAvailable', () => false);
  handleTrusted('runtime.detectMe3', () => ({ detected: false }));

  handleTrusted('resource.readFmgDocument', () => ({
    ok: true,
    data: {
      sourceHash: fixture.fmg.sourceHash,
      entries: fixture.fmg.entries.map((entry) => ({ ...entry })),
      entryCount: fixture.fmg.entries.length,
      authority: 'fixture'
    }
  }));

  handleTrusted('resource.readFmgPage', (_event, _uri, page, pageSize) => {
    const start = page * pageSize;
    return {
      ok: true,
      entries: fixture.fmg.entries.slice(start, start + pageSize),
      page,
      pageCount: Math.max(1, Math.ceil(fixture.fmg.entries.length / pageSize)),
      entryCount: fixture.fmg.entries.length,
      maxId: fixture.fmg.entries.reduce((max, entry) => Math.max(max, entry.id), 0),
      diagnostics: []
    };
  });

  handleTrusted('resource.applyFmgMutation', (_event, _uri, expectedHash, mutation) => {
    if (APPLY_FAIL) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          code: 'ORIGINAL_CHANGED_DURING_STAGING',
          message: '写入校验时发现目标已被外部修改；未写入任何内容。'
        }]
      };
    }
    if (expectedHash !== fixture.fmg.sourceHash) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          code: 'HASH_PRECONDITION_FAILED',
          message: 'hash 前置条件不匹配，拒绝写入。'
        }]
      };
    }
    if (mutation.kind === 'delete') {
      fixture.fmg.entries = fixture.fmg.entries.filter((entry) => entry.id !== mutation.id);
    } else if (mutation.kind === 'add') {
      fixture.fmg.entries.push({ id: mutation.id, text: mutation.text ?? '' });
    } else {
      const existing = fixture.fmg.entries.find((entry) => entry.id === mutation.id);
      if (existing) existing.text = mutation.text ?? '';
      else fixture.fmg.entries.push({ id: mutation.id, text: mutation.text ?? '' });
    }
    fixture.fmg.sourceHash = `fixture-hash-${String(Number(fixture.fmg.sourceHash.split('-').pop()) + 1).padStart(4, '0')}`;
    return { ok: true, diagnostics: [] };
  });
}

async function createWindow({ withPreload }) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      ...(withPreload ? { preload: path.join(outRoot, 'preload', 'index.cjs') } : {}),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const rendererFile = path.join(outRoot, 'renderer', 'index.html');
  // 先登记受信任文档再加载，顺序与生产一致：登记晚于首个 IPC 调用会让正常
  // 启动路径被自己的安全校验拒绝。
  trustedRendererDocuments.set(
    window.webContents.id,
    normalizeRendererDocumentUrl(pathToFileURL(rendererFile).href)
  );
  window.webContents.once('destroyed', () => {
    trustedRendererDocuments.delete(window.webContents.id);
  });
  await window.loadFile(rendererFile);
  return window;
}

app.whenReady().then(async () => {
  registerFixtureIpc();
  if (BROWSER_PREVIEW) {
    // browser-preview 表面：无 preload，window.soulforge 不存在。
    await createWindow({ withPreload: false });
  } else {
    await createWindow({ withPreload: true });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
