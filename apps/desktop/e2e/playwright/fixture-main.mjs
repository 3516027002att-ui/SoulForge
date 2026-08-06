/**
 * Playwright fixture main：加载生产 preload 与构建产物，用合成 fixture
 * （微小、合法构造、明确标记）注册与生产同名的 IPC 通道，
 * 驱动 renderer 状态机的端到端测试。不触碰真实游戏资产。
 *
 * 环境变量：
 * - SF_TEST_APPLY_FAIL=1：FMG 写入返回 ORIGINAL_CHANGED_DURING_STAGING 失败。
 * - SF_TEST_CANCEL_DIALOG=1：workspace.openDialog 返回 null（用户取消路径）。
 * - SF_TEST_BROWSER_PREVIEW=1：创建无 preload 窗口，模拟普通浏览器预览表面。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function registerFixtureIpc() {
  ipcMain.handle('workspace.openDialog', () => {
    track('workspace.openDialog');
    if (CANCEL_DIALOG) return null;
    return { selectionId: 'fixture-overlay', label: 'fixture-overlay' };
  });

  ipcMain.handle('workspace.scan', () => {
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

  ipcMain.handle('workspace.analyze', () => ({
    parsedFiles: fixtureFiles.length,
    inspectedFiles: fixtureFiles.length,
    referenceStats: { high: 0, medium: 0, low: 0, suppressedAmbiguousNumbers: 0 },
    diagnostics: [],
    events: [],
    tools: []
  }));

  ipcMain.handle('workspace.openBaseDialog', () => {
    track('workspace.openBaseDialog');
    if (CANCEL_DIALOG) return null;
    return { selectionId: 'fixture-base', label: 'fixture-base' };
  });

  ipcMain.handle('resource.search', () => []);
  ipcMain.handle('resource.preview', () => null);

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
  ipcMain.handle('resource.inspectContainerTree', (_event, uri) => ({
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
  ipcMain.handle('resource.listContainerChildrenPage', (_event, _uri, page, pageSize) => ({
    ok: true,
    totalCount: containerChildren.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(containerChildren.length / pageSize)),
    children: containerChildren.slice(page * pageSize, page * pageSize + pageSize),
    diagnostics: []
  }));
  ipcMain.handle('resource.listContainerChildren', () => ({
    ok: true,
    children: containerChildren.map((child) => ({ ...child })),
    diagnostics: []
  }));
  ipcMain.handle('operation.list', () => []);
  ipcMain.handle('operation.rollback', (_event, opId) => ({
    ok: false,
    opId,
    restoredFiles: [],
    diagnostics: [{ severity: 'warning', code: 'FIXTURE_NO_ROLLBACK', message: 'fixture 不提供回滚。' }]
  }));
  ipcMain.handle('ai.tools', () => []);
  ipcMain.handle('ai.sidebarDraft', () => ({
    summary: 'fixture draft',
    steps: [],
    evidence: [],
    diagnostics: []
  }));
  ipcMain.handle('modelService.list', () => []);
  ipcMain.handle('modelService.encryptionAvailable', () => false);
  ipcMain.handle('runtime.detectMe3', () => ({ detected: false }));

  ipcMain.handle('resource.readFmgDocument', () => ({
    ok: true,
    data: {
      sourceHash: fixture.fmg.sourceHash,
      entries: fixture.fmg.entries.map((entry) => ({ ...entry })),
      entryCount: fixture.fmg.entries.length,
      authority: 'fixture'
    }
  }));

  ipcMain.handle('resource.readFmgPage', (_event, _uri, page, pageSize) => {
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

  ipcMain.handle('resource.applyFmgMutation', (_event, _uri, expectedHash, mutation) => {
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
      ...(withPreload ? { preload: path.join(outRoot, 'preload', 'index.mjs') } : {}),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await window.loadFile(path.join(outRoot, 'renderer', 'index.html'));
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
