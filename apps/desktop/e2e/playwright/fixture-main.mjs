/**
 * Playwright fixture main：加载生产 preload 与构建产物，用合成 fixture
 * （微小、合法构造、明确标记）注册与生产同名的 IPC 通道，
 * 驱动 renderer 状态机的端到端测试。不触碰真实游戏资产。
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(here, '../../out');
const APPLY_FAIL = process.env.SF_TEST_APPLY_FAIL === '1';

/** Synthetic fixture corpus — tiny, constructed, explicitly labeled (AGENTS.md §15). */
const fixture = {
  workspaceUri: 'fixture://workspace/sekiro-test',
  file: {
    sourceUri: 'fixture://msg/test.msgbnd.dcx',
    game: 'sekiro',
    resourceKind: 'msg',
    parseStatus: 'parsed',
    diagnostics: [],
    relativePath: 'msg/test.msgbnd.dcx',
    extension: '.msgbnd.dcx',
    formatLabel: 'FMG',
    size: 2048
  },
  fmg: {
    sourceHash: 'fixture-hash-0001',
    entries: [
      { id: 100, text: '伤药葫芦' },
      { id: 101, text: '返回骨片' }
    ]
  }
};

function registerFixtureIpc() {
  ipcMain.handle('workspace.openDialog', () => ({
    selectionId: 'fixture-overlay',
    label: 'fixture-overlay'
  }));

  ipcMain.handle('workspace.scan', () => ({
    workspaceSessionId: 'fixture-session',
    workspaceLabel: 'fixture-workspace',
    files: [fixture.file],
    countsByKind: {
      event: 0, map: 0, param: 0, msg: 1, menu: 0, script: 0,
      action: 0, ai: 0, sfx: 0, chr: 0, obj: 0, other: 0, unknown: 0
    },
    diagnostics: [],
    session: {
      workspaceSessionId: 'fixture-session',
      workspaceLabel: 'fixture-workspace',
      game: 'sekiro',
      openedAt: new Date().toISOString(),
      baseMounted: false
    }
  }));

  ipcMain.handle('workspace.analyze', () => ({
    parsedFiles: 1,
    inspectedFiles: 1,
    referenceStats: { high: 0, medium: 0, low: 0, suppressedAmbiguousNumbers: 0 },
    diagnostics: [],
    events: [],
    tools: []
  }));

  ipcMain.handle('resource.search', () => []);
  ipcMain.handle('resource.preview', () => null);
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

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(outRoot, 'preload', 'index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await window.loadFile(path.join(outRoot, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  registerFixtureIpc();
  await createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
