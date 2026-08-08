/**
 * Electron functional smoke harness main (W-REL-F-SCALE-02, validation-unfrozen).
 *
 * Runs inside a REAL Electron main process with the REAL production preload
 * (out/preload/index.cjs) context bridge and the REAL built renderer page, then
 * drives the five release-editor paginated channels (bnd4/fmg/param/emevd/script)
 * against the REAL native corpus through the SAME channel names and DTO shapes
 * the desktop main serves (`resource.readFmgPage`, `resource.readParamPage`,
 * `resource.listContainerChildrenPage`, `resource.listScriptContainerEntriesPage`,
 * `resource.readEmevdFullDocument`), backed by `@soulforge/core` production read
 * functions + the shared `normalizePageWindow`.
 *
 * The renderer harness page navigates each channel to its LAST page and asserts
 * the rendered entry count, then walks every page to assert count-level
 * no-overlap/no-omission coverage.
 *
 * Honest boundaries:
 *  - This substitutes the main-process ORCHESTRATION (a functional test driver)
 *    for apps/desktop/src/main/ipc.ts; the node-level smoke + contract smokes
 *    cover the production ipc.ts wiring statically and by mirroring.
 *  - Without the native fixture env the harness reports a structured skip.
 *  - It asserts the bounded-access DATA FLOW inside Electron, not App.tsx's
 *    workspace-opening UX (that remains the future full functional acceptance).
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyScriptEntry,
  createSekiroFixtureEmedf,
  disposeBridgeDaemonPool,
  listContainerChildren,
  normalizePageWindow,
  readFmgDocumentViaBridge,
  readFullEmevdDocumentViaBridge,
  renderEmevdPatchDslBounded,
  resolveNativeFixture,
  runBridge,
  sanitizeEntryName
} from '@soulforge/core';
import {
  CONTAINER_PAGE_SIZE,
  FMG_PAGE_SIZE,
  PARAM_PAGE_SIZE,
  SCRIPT_PAGE_SIZE
} from '@soulforge/shared';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const preloadPath = resolve(repoRoot, 'apps/desktop/out/preload/index.cjs');
const rendererPagePath = resolve(here, 'harness.html');

/*
 * 页大小从 @soulforge/shared 导入（唯一来源）。harness 自己写一份字面量时，
 * 生产改了页大小而 harness 没改，smoke 照样全绿——它验的是另一个口径。
 */

let stagingRoot = '';
let fixtureCache = new Map();

async function fixtureFor(role, fallback) {
  const cached = fixtureCache.get(role);
  if (cached) return cached;
  const path = await resolveNativeFixture(undefined, role, fallback);
  fixtureCache.set(role, path);
  return path;
}

async function extractChildToStaging(containerPath, entryIndex, label) {
  const snapshot = await runBridge({
    command: 'snapshot-bnd4-child',
    filePath: containerPath,
    allowedRoots: [dirname(containerPath), stagingRoot],
    timeoutMs: 120_000,
    commandOptions: { entryIndex }
  });
  if (!snapshot.data?.contentBase64) {
    throw new Error(`snapshot-bnd4-child ${label} 失败: ${snapshot.diagnostics.map((d) => d.code).join(',')}`);
  }
  const target = join(stagingRoot, `${label}.bin`);
  await writeFile(target, Buffer.from(snapshot.data.contentBase64, 'base64'));
  return { path: target, name: snapshot.data.name };
}

function registerFunctionalChannels() {
  ipcMain.handle('resource.readFmgPage', async (_event, sourceUri, requestedPage, requestedPageSize) => {
    const container = await fixtureFor('fmg-primary', '../../mods/msg/zhocn/item.msgbnd.dcx');
    const { path: fmgPath } = await extractChildToStaging(container, 1, 'weapon_names.fmg');
    const read = await readFmgDocumentViaBridge({ sourcePath: fmgPath, allowedRoots: [stagingRoot], timeoutMs: 120_000 });
    if (!read.ok || !read.data) throw new Error(`FMG read failed: ${read.diagnostics.map((d) => d.code).join(',')}`);
    const window = normalizePageWindow(read.data.entries.length, requestedPage, requestedPageSize || FMG_PAGE_SIZE);
    return {
      ok: true,
      sourceUri,
      sourceHash: read.data.sourceHash,
      entryCount: read.data.entries.length,
      maxId: read.data.entries.reduce((max, entry) => Math.max(max, entry.id), 0),
      page: window.page,
      pageSize: window.size,
      pageCount: window.pageCount,
      entries: read.data.entries.slice(window.offset, window.offset + window.size).map((entry) => ({ id: entry.id, text: entry.text })),
      diagnostics: []
    };
  });

  ipcMain.handle('resource.readParamPage', async (_event, sourceUri, requestedPage, requestedPageSize) => {
    const container = await fixtureFor('param-primary', '../../mods/param/gameparam/gameparam.parambnd.dcx');
    const { path: paramPath } = await extractChildToStaging(container, 1, 'ActionGuideParam.param');
    const result = await runBridge({
      command: 'read-param-document',
      filePath: paramPath,
      allowedRoots: [stagingRoot],
      timeoutMs: 120_000,
      commandOptions: {}
    });
    if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
      throw new Error(`PARAM read failed: ${result.diagnostics.map((d) => d.code).join(',')}`);
    }
    const rows = result.data.rows ?? [];
    const window = normalizePageWindow(rows.length, requestedPage, requestedPageSize || PARAM_PAGE_SIZE);
    return {
      ok: true,
      sourceUri,
      sourceHash: result.data.sourceHash,
      typeName: result.data.typeName ?? 'UNKNOWN_PARAM',
      rowDataSize: result.data.rowDataSize ?? 0,
      rowCount: rows.length,
      page: window.page,
      pageSize: window.size,
      pageCount: window.pageCount,
      rows: rows.slice(window.offset, window.offset + window.size).map((row) => ({
        id: row.id,
        ...(typeof row.dataBase64 === 'string'
          ? { dataBase64: row.dataBase64, dataHexPreview: Buffer.from(row.dataBase64, 'base64').subarray(0, 16).toString('hex') }
          : {}),
        ...(row.name ? { name: row.name } : {})
      })),
      rowsTruncated: false,
      diagnostics: []
    };
  });

  ipcMain.handle('resource.listContainerChildrenPage', async (_event, sourceUri, requestedPage, requestedPageSize) => {
    const container = await fixtureFor('bnd4-primary', '../../mods/msg/zhocn/menu.msgbnd.dcx');
    const ts = await listContainerChildren(container, { relativePath: 'menu.msgbnd.dcx' });
    let children = ts.children;
    if (children.length === 0) {
      const dcx = await runBridge({
        command: 'read-dcx-document',
        filePath: container,
        allowedRoots: [dirname(container), stagingRoot],
        timeoutMs: 120_000
      });
      const nested = dcx.data?.nested;
      const entries = nested?.entries ?? [];
      const seen = new Set();
      children = entries.map((entry, i) => {
        const name = sanitizeEntryName(entry.name ?? `entry_${entry.index ?? i}`, entry.index ?? i, seen);
        return {
          childId: String(entry.index ?? i),
          name,
          offset: entry.dataOffset ?? 0,
          size: entry.uncompressedSize ?? 0,
          hash: entry.contentHash ?? '',
          formatKind: name.split('.').pop()?.toLowerCase() ?? 'unknown',
          sourceContainerUri: sourceUri,
          childUri: `${sourceUri}#bnd/child/${encodeURIComponent(name)}`,
          rawBytesAvailable: true,
          canReplace: false,
          diagnostics: []
        };
      });
    }
    const window = normalizePageWindow(children.length, requestedPage, requestedPageSize || CONTAINER_PAGE_SIZE);
    return {
      ok: true,
      totalCount: children.length,
      page: window.page,
      pageSize: window.size,
      pageCount: window.pageCount,
      children: children.slice(window.offset, window.offset + window.size),
      diagnostics: []
    };
  });

  ipcMain.handle('resource.listScriptContainerEntriesPage', async (_event, sourceUri, requestedPage, requestedPageSize) => {
    const container = await fixtureFor('luabnd-primary', '../../mods/script/aicommon.luabnd.dcx');
    const dcx = await runBridge({
      command: 'read-dcx-document',
      filePath: container,
      allowedRoots: [dirname(container), stagingRoot],
      timeoutMs: 120_000
    });
    const nested = dcx.parseStatus === 'failed' ? undefined : dcx.data?.nested;
    const rawEntries = nested?.entries ?? [];
    const entries = rawEntries.map((entry, i) => {
      const rawName = entry.name ?? `entry_${entry.index ?? i}`;
      return {
        index: entry.index ?? i,
        name: sanitizeEntryName(rawName, entry.index ?? i, new Set()),
        size: entry.uncompressedSize ?? 0,
        extension: rawName.split('.').pop()?.toLowerCase() ?? '',
        classification: classifyScriptEntry(rawName)
      };
    });
    const summary = {
      'lua-bytecode': 0, 'luagnl': 0, 'luainfo': 0, 'esd-bytecode': 0, 'hkx-bytecode': 0, unknown: 0
    };
    for (const entry of entries) summary[entry.classification] += 1;
    const window = normalizePageWindow(entries.length, requestedPage, requestedPageSize || SCRIPT_PAGE_SIZE);
    return {
      ok: true,
      containerFormat: `${dcx.data?.format ?? 'DCX'}->${nested?.format ?? 'BND4'}`,
      entryCount: entries.length,
      page: window.page,
      pageSize: window.size,
      pageCount: window.pageCount,
      entries: entries.slice(window.offset, window.offset + window.size),
      classificationSummary: summary,
      entriesComplete: Array.isArray(nested?.entries),
      diagnostics: []
    };
  });

  ipcMain.handle('resource.readEmevdFullDocument', async (_event, sourceUri, documentInstanceId, loadFullDslTemplate) => {
    const source = await fixtureFor('emevd-primary', '../../mods/event/common.emevd.dcx');
    const full = await readFullEmevdDocumentViaBridge({
      filePath: source,
      allowedRoots: [dirname(source), stagingRoot],
      tempDir: stagingRoot,
      resourceUri: sourceUri,
      registry: createSekiroFixtureEmedf(),
      ...(documentInstanceId ? { documentInstanceId } : {}),
      pageSize: 1000,
      timeoutMs: 120_000
    });
    if (!full.ok || !full.document) throw new Error(`EMEVD read failed: ${JSON.stringify(full.diagnostics)}`);
    const bounded = renderEmevdPatchDslBounded(
      full.document,
      createSekiroFixtureEmedf(),
      loadFullDslTemplate === true ? undefined : 2000
    );
    return {
      ok: true,
      sourceUri,
      documentInstanceId,
      revision: full.document.revision,
      eventCount: full.document.events.length,
      instructionCount: full.instructionTotal,
      dslTemplate: bounded.text,
      dslTemplateTruncated: bounded.truncated,
      dslTemplateTotalLines: bounded.totalLines,
      sourceHash: full.sourceHash ?? null,
      diagnostics: []
    };
  });
}

function structuredReport(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const explicit = process.env.SOULFORGE_FUNCTIONAL_SMOKE === '1';
  const nativeAvailable = Boolean(
    process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
  );
  if (!explicit) {
    structuredReport({
      ok: null,
      harnessStatus: 'skipped',
      electronFunctionalSmoke: { run: false, pass: null, reason: 'SOULFORGE_FUNCTIONAL_SMOKE 未置 1' }
    });
    app.exit(0);
    return;
  }
  if (!nativeAvailable) {
    structuredReport({
      ok: null,
      harnessStatus: 'skipped',
      electronFunctionalSmoke: { run: false, pass: null, reason: '未注入本机 native fixture 环境（SOULFORGE_NATIVE_FIXTURE_REGISTRY/ROOT）' }
    });
    app.exit(0);
    return;
  }

  await app.whenReady();
  stagingRoot = await mkdtemp(join(tmpdir(), 'soulforge-functional-smoke-'));
  registerFunctionalChannels();

  const window = new BrowserWindow({
    width: 900,
    height: 700,
    show: process.env.SOULFORGE_FUNCTIONAL_SMOKE_SHOW === '1',
    webPreferences: {
      preload: preloadPath,
      // 生产 preload 现在产出 CommonJS（out/preload/index.cjs），正是因为
      // Electron 的 sandboxed preload 不支持 ESM —— 这条注释此前指出了该限制，
      // 但产物当时是 .mjs 且生产 main 找的是 .js，两边都错，于是生产启动时
      // preload 静默加载失败（window.soulforge 完全不注入）。已修。
      //
      // 本 harness 仍用 sandbox: false：它要在 preload 之外注入测试替身，
      // 保留真正要紧的边界（contextIsolation: true, nodeIntegration: false）。
      // 注意这与生产窗口的 sandbox: true 不同——正因如此，harness 无法覆盖
      // 「sandbox + preload 格式」这个组合，那个缺陷只能由真实启动巡检发现。
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) process.stderr.write(`[functional-smoke:renderer] ${message}\n`);
  });

  const resultPromise = new Promise((resolveResult) => {
    const deadline = Date.now() + 120_000;
    const poll = async () => {
      let value = null;
      try {
        value = await window.webContents.executeJavaScript('window.__sfSmokeResult ?? null', true);
      } catch {
        value = null;
      }
      if (value) {
        resolveResult(value);
        return;
      }
      if (Date.now() > deadline) {
        resolveResult({
          ok: false,
          status: 'timeout',
          message: 'renderer 页面未在 120s 内报告功能 smoke 结果',
          channels: null
        });
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });

  await window.loadFile(rendererPagePath);
  const result = await resultPromise;
  const pass = result?.status === 'pass';
  structuredReport({
    ok: pass ? null : false,
    harnessStatus: pass ? 'passed' : 'failed',
    realFunctionalAcceptanceRun: true,
    electronFunctionalSmoke: result,
    boundaries: [
      '本 harness 以真实生产 preload + 真实 renderer 页面 + 真实 corpus 驱动五通道有界访问；主进程编排为功能测试驱动而非 apps/desktop/src/main/ipc.ts（生产接线由 node smoke 与契约 smoke 覆盖）。',
      '面板 DOM 断言限五通道分页渲染（最后一页 + 计数覆盖）；App.tsx 工作区打开 UX 编排不在本骨架内。'
    ]
  });
  await disposeBridgeDaemonPool();
  app.exit(pass ? 0 : 1);
}

main().catch(async (error) => {
  console.error(JSON.stringify({
    ok: false,
    code: 'ELECTRON_FUNCTIONAL_SMOKE_MAIN_FAILED',
    message: error instanceof Error ? error.stack ?? error.message : String(error)
  }));
  await disposeBridgeDaemonPool();
  app.exit(1);
});
