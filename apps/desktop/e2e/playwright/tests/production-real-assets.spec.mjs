import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const productionMain = resolve(here, '../production-main.mjs');
const repoRoot = resolve(here, '../../../../..');
const gameRoot = process.env.SF_REAL_GAME_ROOT?.trim()
  || 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';
const overlayRoot = process.env.SF_REAL_OVERLAY_ROOT?.trim() || join(gameRoot, 'mods');
const hasCorpus = [
  join(overlayRoot, 'chr', 'c0000.anibnd.dcx'),
  join(overlayRoot, 'chr', 'c1130.anibnd.dcx'),
  join(overlayRoot, 'map', 'mapstudio', 'm10_00_00_00.msb.dcx'),
  join(overlayRoot, 'obj', 'o000100.objbnd.dcx'),
  join(gameRoot, 'chr', 'c1130.chrbnd.dcx')
].every(existsSync);
const hasC5400Corpus = [
  join(gameRoot, 'chr', 'c5400.chrbnd.dcx'),
  join(gameRoot, 'chr', 'c5409.texbnd.dcx')
].every(existsSync);

test.skip(!hasCorpus, '本机没有配置真实只狼语料，跳过只读生产资源 E2E。');

test.describe('真实只狼资源：ACTION / MAP / 纹理渲染链', () => {
  test.setTimeout(240_000);

  async function launchProduction() {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sf-e2e-real-assets-'));
    const app = await electron.launch({
      args: [productionMain, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SF_E2E_OVERLAY_ROOT: overlayRoot,
        SF_E2E_BASE_ROOT: gameRoot
      }
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
      // Playwright disposes the ElectronApplication process handle during
      // app.close(); capture it before closing so cleanup stays compatible
      // with both the current and older Electron adapters.
      let child;
      try {
        child = app.process();
      } catch {
        child = undefined;
      }
      await app.close().catch(() => undefined);
      // Electron/Bridge 子进程在 app.close() 返回后可能还持有 Chromium
      // user-data 文件句柄。先等待宿主进程退出，再对明确的临时目录做
      // 有界重试；清理失败只能留下本次临时目录，不能把真实资源断言判成失败。
      if (child && child.exitCode === null) {
        const deadline = Date.now() + 5_000;
        while (child.exitCode === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      let cleanupError;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          rmSync(userDataDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
          cleanupError = undefined;
          break;
        } catch (error) {
          cleanupError = error;
          if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code) || attempt === 19) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (cleanupError) {
        console.warn(`真实资源 E2E 临时目录清理延迟：${userDataDir} (${cleanupError.code ?? 'unknown'})`);
      }
    };
    return { app, window, pageErrors, consoleErrors, cleanup };
  }

  async function closeAgent(window) {
    const close = window.getByRole('button', { name: '关闭 Agent 面板' });
    if (await close.isVisible().catch(() => false)) await close.click();
  }

  async function openWorkspace(window) {
    await window.waitForFunction(() => 'soulforge' in globalThis, { timeout: 30_000 });
    const switcher = window.locator('.workspace-switcher__trigger');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await switcher.textContent().catch(() => ''))?.includes('mods')) break;
      await window.getByRole('region', { name: '开始' }).getByTestId('open-workspace').click();
      await window.waitForTimeout(750);
    }
    await expect(switcher).toContainText('mods', { timeout: 120_000 });
    await closeAgent(window);
  }

  async function openResource(window, query) {
    await closeAgent(window);
    await window.keyboard.press('Control+k');
    const input = window.locator('.cmdk__input-wrap input');
    await input.fill(query);
    await expect(window.locator('.cmdk-item').filter({ hasText: query })).toHaveCount(1, { timeout: 30_000 });
    await window.keyboard.press('Enter');
  }

  async function expandActionGroup(window, groupLabel) {
    const header = window.locator('.tae-animation-group__header').filter({ hasText: groupLabel }).first();
    await expect(header).toHaveCount(1, { timeout: 120_000 });
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
  }

  test('真实 ACTION 与 MAP 读取含完整网格/贴图，并能进入可视化工作台', async () => {
    const { app, window, pageErrors, consoleErrors, cleanup } = await launchProduction();
    try {
      await openWorkspace(window);

      const probe = await window.evaluate(async () => {
        const api = globalThis.soulforge;
        const c0000Files = await api.searchResources('c0000.anibnd.dcx');
        const actionFiles = await api.searchResources('c1130.anibnd.dcx');
        const mapFiles = await api.searchResources('m10_00_00_00.msb.dcx');
        const c0000File = c0000Files.find((file) => /(^|\/)chr\/c0000\.anibnd\.dcx$/i.test(file.relativePath));
        const actionFile = actionFiles.find((file) => /(^|\/)chr\/c1130\.anibnd\.dcx$/i.test(file.relativePath));
        const mapFile = mapFiles.find((file) => /(^|\/)map\/mapstudio\/m10_00_00_00\.msb\.dcx$/i.test(file.relativePath));
        if (!c0000File || !actionFile || !mapFile) {
          return {
            ok: false,
            reason: '真实资源未进入生产索引',
            c0000Paths: c0000Files.map((file) => file.relativePath),
            actionPaths: actionFiles.map((file) => file.relativePath),
            mapPaths: mapFiles.map((file) => file.relativePath)
          };
        }

        // 地图里的敌人/NPC 使用 c* chrbnd，不走 mapbnd 的静态 FLVER 分支；
        // 同一条生产 IPC 必须同时证明角色几何和角色贴图已经接通。
        const [actionC0000, action, map, mapCharacter] = await Promise.all([
          api.readTaeChrbndPreview(c0000File.sourceUri),
          api.readTaeChrbndPreview(actionFile.sourceUri),
          api.readMapStaticGeometry(mapFile.sourceUri, 'o000100'),
          api.readMapStaticGeometry(mapFile.sourceUri, 'c1050')
        ]);
        const actionModels = Array.isArray(action?.data?.models) ? action.data.models : [];
        const actionMeshes = actionModels.flatMap((model) => Array.isArray(model?.meshes) ? model.meshes : []);
        const actionTextures = actionModels.flatMap((model) => Array.isArray(model?.texturePreviews) ? model.texturePreviews : []);
        const c0000Models = Array.isArray(actionC0000?.data?.models) ? actionC0000.data.models : [];
        const c0000Textures = c0000Models.flatMap((model) => Array.isArray(model?.texturePreviews) ? model.texturePreviews : []);
        const c0000Meshes = c0000Models
          .flatMap((model) => Array.isArray(model?.meshes) ? model.meshes : []);
        const c0000NativeProjectionMeshes = c0000Meshes
          .filter((mesh) => mesh?.renderMode === 'projected-decal');
        const c0000CompatibilityProjectionMeshes = c0000Meshes
          .filter((mesh) => mesh?.renderMode === 'compatibility-projected');
        const mapChunks = Array.isArray(map?.data?.chunks) ? map.data.chunks : [];
        const characterChunks = Array.isArray(mapCharacter?.data?.chunks) ? mapCharacter.data.chunks : [];
        return {
          ok: Boolean(action?.ok && map?.ok && mapCharacter?.ok),
          c0000: {
            ok: Boolean(actionC0000?.ok),
            texturePreviews: c0000Textures.length,
            textureNames: c0000Textures
              .map((texture) => texture?.textureName)
              .filter((name) => typeof name === 'string' && name.length > 0),
            nativeProjectedMeshes: c0000NativeProjectionMeshes.length,
            compatibilityProjectionMeshes: c0000CompatibilityProjectionMeshes.length,
            projectionTextureNames: c0000CompatibilityProjectionMeshes
              .map((mesh) => mesh?.projectionTextureName)
              .filter((name) => typeof name === 'string' && name.length > 0),
            projectionTextureTokens: c0000CompatibilityProjectionMeshes
              .filter((mesh) => typeof mesh?.projectionTexturePreviewToken === 'string' && mesh.projectionTexturePreviewToken.length > 0)
              .length,
            projectionIndexBytes: c0000CompatibilityProjectionMeshes
              .map((mesh) => typeof mesh?.indicesBase64 === 'string' ? mesh.indicesBase64.length : 0),
            assemblyParts: Array.isArray(actionC0000?.data?.assemblyParts)
              ? actionC0000.data.assemblyParts
              : [],
            diagnostics: (actionC0000?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
          },
          action: {
            ok: Boolean(action?.ok),
            meshCount: action?.data?.meshCount ?? 0,
            boneCount: action?.data?.boneCount ?? 0,
            modelCount: actionModels.length,
            meshPayloads: actionMeshes.length,
            texturePreviews: actionTextures.length,
            textureTokens: actionTextures.filter((texture) => typeof texture?.texturePreviewToken === 'string' && texture.texturePreviewToken.length > 0).length,
            diagnostics: (action?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
          },
          map: {
            ok: Boolean(map?.ok),
            chunks: mapChunks.length,
            texturedChunks: mapChunks.filter((chunk) => typeof chunk?.texturePreviewToken === 'string' && chunk.texturePreviewToken.length > 0).length,
            texturePreviewToken: typeof map?.data?.texturePreviewToken === 'string' ? map.data.texturePreviewToken.length : 0,
            diagnostics: (map?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
          },
          mapCharacter: {
            ok: Boolean(mapCharacter?.ok),
            chunks: characterChunks.length,
            texturedChunks: characterChunks.filter((chunk) => typeof chunk?.texturePreviewToken === 'string' && chunk.texturePreviewToken.length > 0).length,
            texturePreviewToken: typeof mapCharacter?.data?.texturePreviewToken === 'string' ? mapCharacter.data.texturePreviewToken.length : 0,
            diagnostics: (mapCharacter?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
          }
        };
      });

      expect(probe.ok, JSON.stringify(probe)).toBe(true);
      expect(probe.c0000.ok, JSON.stringify(probe.c0000)).toBe(true);
      // Native projected-decal remains read-only in the generic Three
      // renderer. ACTION c0000 must therefore preserve the native receiver
      // classification while refusing the old generic FC head projection.
      expect(probe.c0000.nativeProjectedMeshes, JSON.stringify(probe.c0000)).toBeGreaterThan(0);
      expect(probe.c0000.projectionTextureNames, JSON.stringify(probe.c0000))
        .not.toContain('FC_M_0000_head_a');
      expect(probe.c0000.assemblyParts, JSON.stringify(probe.c0000)).toContain('parts/fc_m_0200.partsbnd.dcx');
      expect(probe.action.meshCount).toBeGreaterThan(0);
      expect(probe.action.meshPayloads).toBeGreaterThan(0);
      expect(probe.action.texturePreviews, JSON.stringify(probe.action)).toBeGreaterThan(0);
      expect(probe.action.textureTokens, JSON.stringify(probe.action)).toBeGreaterThan(0);
      expect(probe.map.chunks).toBeGreaterThan(0);
      expect(
        Math.max(probe.map.texturedChunks, probe.map.texturePreviewToken > 0 ? 1 : 0),
        JSON.stringify(probe.map)
      ).toBeGreaterThan(0);
      expect(probe.mapCharacter.chunks, JSON.stringify(probe.mapCharacter)).toBeGreaterThan(0);
      expect(
        Math.max(probe.mapCharacter.texturedChunks, probe.mapCharacter.texturePreviewToken > 0 ? 1 : 0),
        JSON.stringify(probe.mapCharacter)
      ).toBeGreaterThan(0);

      await openResource(window, 'chr/c1130.anibnd.dcx');
      await expect(window.getByLabel('动作工作台')).toBeVisible();
      await expect(window.getByTestId('tae-preview-viewport')).toBeVisible({ timeout: 120_000 });
      await expect(window.locator('.tae-preview__viewport canvas')).toHaveCount(1);

      await openResource(window, 'map/mapstudio/m10_00_00_00.msb.dcx');
      await expect(window.getByLabel('MSB 地图工作台')).toBeVisible();
      await expect(window.getByRole('region', { name: 'Viewport' })).toBeVisible();
      await expect(window.locator('.msb-viewport canvas')).toHaveCount(1, { timeout: 120_000 });
      await window.waitForFunction(() => {
        const text = document.querySelector('.msb-viewport')?.textContent ?? '';
        return /模型(?:已处理)?\s*[1-9]/.test(text) && /Part\s*[1-9]/.test(text);
      }, { timeout: 120_000 });

      mkdirSync(resolve(repoRoot, 'output/playwright'), { recursive: true });
      await window.screenshot({ path: resolve(repoRoot, 'output/playwright/real-action-map.png'), fullPage: false });
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('真实 PARAM 与 FMG 读取进入对应产品工作台', async () => {
    const { window, pageErrors, consoleErrors, cleanup } = await launchProduction();
    try {
      await openWorkspace(window);

      const probe = await window.evaluate(async () => {
        const api = globalThis.soulforge;
        const fmgFiles = await api.searchResources('msg/engus/item.msgbnd.dcx');
        const paramFiles = await api.searchResources('param/gameparam/gameparam.parambnd.dcx');
        const fmgFile = fmgFiles.find((file) => /(^|\/)msg\/engus\/item\.msgbnd\.dcx$/i.test(file.relativePath));
        const paramFile = paramFiles.find((file) => /(^|\/)param\/gameparam\/gameparam\.parambnd\.dcx$/i.test(file.relativePath));
        if (!fmgFile || !paramFile) {
          return {
            ok: false,
            reason: '真实 PARAM/FM G 资源未进入生产索引',
            fmgPaths: fmgFiles.map((file) => file.relativePath),
            paramPaths: paramFiles.map((file) => file.relativePath)
          };
        }

        const fmg = await api.readFmgDocument(fmgFile.sourceUri);
        const params = await api.listContainerParams(paramFile.sourceUri);
        const firstParam = params?.ok && Array.isArray(params.params) ? params.params[0] : null;
        const rows = firstParam
          ? await api.readContainerParamRowIndex(paramFile.sourceUri, firstParam.entryIndex)
          : null;
        return {
          ok: Boolean(fmg?.ok && fmg?.data?.sourceHash && params?.ok && firstParam && rows?.ok),
          fmg: {
            ok: Boolean(fmg?.ok),
            sourceHash: typeof fmg?.data?.sourceHash === 'string' ? fmg.data.sourceHash.length : 0,
            entryCount: fmg?.data?.entryCount ?? fmg?.data?.entries?.length ?? 0,
            diagnostics: (fmg?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
          },
          param: {
            ok: Boolean(params?.ok),
            count: Array.isArray(params?.params) ? params.params.length : 0,
            firstName: firstParam?.name ?? null,
            firstEntryIndex: firstParam?.entryIndex ?? null,
            rowsOk: Boolean(rows?.ok),
            rowCount: rows?.rowCount ?? rows?.rows?.length ?? 0,
            sessionToken: typeof rows?.sessionToken === 'string' ? rows.sessionToken.length : 0,
            diagnostics: [
              ...(params?.diagnostics ?? []),
              ...(rows?.diagnostics ?? [])
            ].map((diagnostic) => diagnostic.code)
          }
        };
      });

      expect(probe.ok, JSON.stringify(probe)).toBe(true);
      expect(probe.fmg.entryCount, JSON.stringify(probe.fmg)).toBeGreaterThan(0);
      expect(probe.param.count, JSON.stringify(probe.param)).toBeGreaterThan(0);
      expect(probe.param.rowCount, JSON.stringify(probe.param)).toBeGreaterThan(0);
      expect(probe.param.sessionToken, JSON.stringify(probe.param)).toBeGreaterThan(0);

      await openResource(window, 'msg/engus/item.msgbnd.dcx');
      const fmgPanel = window.getByRole('region', { name: 'FMG 本地化工作台' });
      await expect(fmgPanel).toBeVisible({ timeout: 120_000 });
      await expect(fmgPanel.getByRole('region', { name: 'Text Categories' })).toBeVisible();
      await expect(fmgPanel.getByRole('region', { name: 'Text Entries' })).toContainText(/\S/, { timeout: 120_000 });

      await openResource(window, 'param/gameparam/gameparam.parambnd.dcx');
      const paramPanel = window.getByLabel('PARAM 工作台');
      await expect(paramPanel).toBeVisible({ timeout: 120_000 });
      const paramsColumn = paramPanel.getByRole('region', { name: 'Params' });
      const rowsColumn = paramPanel.getByRole('region', { name: 'Rows' });
      await expect(paramsColumn.locator('.wb-row').first()).toBeVisible({ timeout: 120_000 });
      await paramsColumn.locator('.wb-row').first().click();
      await expect(rowsColumn.locator('.wb-row').first()).toBeVisible({ timeout: 120_000 });
      await rowsColumn.locator('.wb-row').first().click();
      await expect(paramPanel.getByRole('region', { name: 'Fields' })).toBeVisible();

      mkdirSync(resolve(repoRoot, 'output/playwright'), { recursive: true });
      await window.screenshot({ path: resolve(repoRoot, 'output/playwright/real-param-fmg-workbenches.png'), fullPage: false });
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('真实 c5400 按 FLVER MTD 身份绑定 c5409 纹理，而不是公共材质回退', async () => {
    test.skip(!hasC5400Corpus, '本机没有 c5400.chrbnd 与 c5409.texbnd，跳过 c5400 原生纹理身份回归。');
    const { window, cleanup } = await launchProduction();
    try {
      await openWorkspace(window);
      const probe = await window.evaluate(async () => {
        const api = globalThis.soulforge;
        const files = await api.searchResources('c5400.anibnd.dcx');
        const file = files.find((candidate) => /(^|\/)chr\/c5400\.anibnd\.dcx$/i.test(candidate.relativePath));
        if (!file) return { ok: false, reason: 'c5400 动作未进入生产索引', paths: files.map((candidate) => candidate.relativePath) };
        const result = await api.readTaeChrbndPreview(file.sourceUri);
        const models = Array.isArray(result?.data?.models) ? result.data.models : [];
        const textures = models.flatMap((model) => Array.isArray(model?.texturePreviews) ? model.texturePreviews : []);
        const meshes = models.flatMap((model) => Array.isArray(model?.meshes) ? model.meshes : []);
        const texturedMaterialIndices = new Set(textures
          .map((texture) => texture?.materialIndex)
          .filter((index) => Number.isInteger(index)));
        return {
          ok: Boolean(result?.ok),
          modelCount: models.length,
          meshCount: meshes.length,
          texturedMeshCount: meshes.filter((mesh) => texturedMaterialIndices.has(mesh?.materialIndex)).length,
          textureCount: textures.length,
          textureNames: textures.map((texture) => texture?.textureName).filter((name) => typeof name === 'string' && name.length > 0),
          diagnostics: (result?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
        };
      });

      expect(probe.ok, JSON.stringify(probe)).toBe(true);
      expect(probe.modelCount, JSON.stringify(probe)).toBeGreaterThan(0);
      expect(probe.meshCount, JSON.stringify(probe)).toBeGreaterThan(0);
      expect(probe.texturedMeshCount, JSON.stringify(probe)).toBeGreaterThan(0);
      expect(probe.textureNames, JSON.stringify(probe)).toContain('c5409_body_a');
      expect(probe.textureNames, JSON.stringify(probe)).toContain('c5409_head_a');
      expect(probe.textureNames, JSON.stringify(probe)).toContain('c5409_kimono_a');

      await openResource(window, 'chr/c5400.anibnd.dcx');
      await expect(window.getByLabel('动作工作台')).toBeVisible();
      await expect(window.getByTestId('tae-preview-viewport')).toBeVisible({ timeout: 120_000 });
      // FLVER bundle 的 PNG data URI 与 Three 场景挂载是异步的；只断言宿主
      // 出现会在首帧仍为空时过早截图，必须等 canvas 完成至少一帧绘制。
      await window.waitForTimeout(3_000);
      mkdirSync(resolve(repoRoot, 'output/playwright'), { recursive: true });
      await window.screenshot({
        path: resolve(repoRoot, 'output/playwright/c5400-mtd-texture-preview.png'),
        fullPage: false
      });
    } finally {
      await cleanup();
    }
  });

  test('真实 C0000 动画第 0 帧保持绑定姿态并可播放', async () => {
    const { app, window, pageErrors, consoleErrors, cleanup } = await launchProduction();
    try {
      await openWorkspace(window);
      await openResource(window, 'chr/c0000.anibnd.dcx');
      await expect(window.getByLabel('动作工作台')).toBeVisible();
      await expect(window.getByTestId('tae-preview-viewport')).toBeVisible({ timeout: 120_000 });

      // a200 contains native animations whose hkxName is absent. The UI
      // fallback must retain the physical child prefix instead of relabeling
      // them as a000, which made the loaded partition look incomplete.
      const bankSelector = window.getByTestId('tae-bank-selector');
      const animations = window.getByRole('region', { name: 'Animations' });
      const bankLabels = await bankSelector.locator('option').allTextContents();
      expect(bankLabels).toEqual(expect.arrayContaining([
        'a00 (939)',
        'a50 (223)',
        'a100 (4)',
        'a200 (66)'
      ]));
      await bankSelector.selectOption({ label: 'a200 (66)' });
      await expandActionGroup(window, 'a200');
      await expect(animations.locator('.wb-row').filter({ hasText: 'a200_501010' })).toHaveCount(1);
      await expect(animations.locator('.wb-row').filter({ hasText: 'a000_501010' })).toHaveCount(0);
      await bankSelector.selectOption('all');
      await expandActionGroup(window, 'a00');
      const actionView = window.locator('.tae-preview-body');
      await expect(actionView.getByTestId('flver-toggle-skeleton')).toHaveCount(0);
      await expect(actionView).not.toContainText('FLVER 3D 预览');
      await expect(actionView).not.toContainText('兼容预览');
      await expect(actionView).not.toContainText('authority=');

      // The four-column action workbench must keep the viewport inside the
      // main work area when the Agent dock consumes the right side.
      await window.getByRole('button', { name: 'AI Agent 面板', exact: true }).click();
      const narrowLayout = await window.evaluate(() => {
        const workbench = document.querySelector('.tae-workbench');
        const viewport = document.querySelector('.tae-preview__viewport');
        if (!workbench || !viewport) return null;
        const workbenchRect = workbench.getBoundingClientRect();
        const viewportRect = viewport.getBoundingClientRect();
        return {
          workbenchLeft: workbenchRect.left,
          workbenchRight: workbenchRect.right,
          viewportLeft: viewportRect.left,
          viewportRight: viewportRect.right,
          viewportWidth: viewportRect.width,
          viewportHeight: viewportRect.height
        };
      });
      expect(narrowLayout, 'ACTION 紧凑布局未找到工作台或预览').not.toBeNull();
      expect(narrowLayout.viewportWidth).toBeGreaterThan(0);
      expect(narrowLayout.viewportHeight).toBeGreaterThan(0);
      expect(narrowLayout.viewportLeft).toBeGreaterThanOrEqual(narrowLayout.workbenchLeft - 1);
      expect(narrowLayout.viewportRight).toBeLessThanOrEqual(narrowLayout.workbenchRight + 1);
      await closeAgent(window);

      // The UI row carries the physical TAE child identity. Exercise the
      // production preload -> main -> Bridge path directly for a non-a00
      // child whose animId namespace is otherwise easy to confuse with a00.
      const selectorProbe = await window.evaluate(async () => {
        const api = globalThis.soulforge;
        const files = await api.searchResources('c0000.anibnd.dcx');
        const file = files.find((candidate) => /(^|\/)chr\/c0000\.anibnd\.dcx$/i.test(candidate.relativePath));
        if (!file) return { ok: false, reason: 'c0000 动作未进入生产索引' };
        const clip = await api.readTaeAnimationClip(
          file.sourceUri,
          2011,
          undefined,
          undefined,
          undefined,
          3,
          5000050,
          'a50.tae',
          'a50'
        );
        return {
          ok: Boolean(clip?.ok),
          motionAnimId: clip?.data?.motionAnimId,
          taeEntryIndex: clip?.data?.taeEntryIndex,
          taeEntryId: clip?.data?.taeEntryId,
          taeEntryName: clip?.data?.taeEntryName,
          taeGroup: clip?.data?.taeGroup,
          hkxBoneCount: clip?.data?.hkxBoneCount,
          diagnostics: (clip?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
        };
      });
      expect(selectorProbe.ok, JSON.stringify(selectorProbe)).toBe(true);
      expect(selectorProbe.motionAnimId, JSON.stringify(selectorProbe)).toBe(50002010);
      expect(selectorProbe.taeEntryIndex, JSON.stringify(selectorProbe)).toBe(3);
      expect(selectorProbe.taeEntryId, JSON.stringify(selectorProbe)).toBe(5000050);
      expect(selectorProbe.taeEntryName, JSON.stringify(selectorProbe)).toBe('a50.tae');
      expect(selectorProbe.taeGroup, JSON.stringify(selectorProbe)).toBe('a50');
      expect(selectorProbe.hkxBoneCount, JSON.stringify(selectorProbe)).toBe(146);

      const animation = animations.locator('.wb-row').filter({ hasText: 'a000_201802' });
      await expect(animation).toHaveCount(1, { timeout: 120_000 });
      await animation.click();

      await expect(window.getByTestId('tae-clip-loading')).toBeHidden({ timeout: 120_000 });
      await expect(window.getByRole('button', { name: '播放' })).toBeEnabled({ timeout: 120_000 });
      await expect(window.getByText(/帧 0 \/ /)).toBeVisible();

      mkdirSync(resolve(repoRoot, 'output/playwright'), { recursive: true });
      await window.screenshot({
        path: resolve(repoRoot, 'output/playwright/c0000-animation-bind-pose.png'),
        fullPage: false
      });

      await window.getByRole('button', { name: '下一帧' }).click();
      await expect(window.getByText(/帧 1 \/ /)).toBeVisible();
      await window.screenshot({
        path: resolve(repoRoot, 'output/playwright/c0000-animation-frame1.png'),
        fullPage: false
      });

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test('多个真实动作与非 C0000 角色都能读取、换帧并保持可视化', async () => {
    const { app, window, pageErrors, consoleErrors, cleanup } = await launchProduction();
    const outputDir = resolve(repoRoot, 'output/playwright');
    mkdirSync(outputDir, { recursive: true });

    async function selectAndCapture(animationName, filePrefix) {
      const animations = window.getByRole('region', { name: 'Animations' });
      const groupPrefix = /^(a\d{3})_/i.exec(animationName)?.[1];
      await expandActionGroup(window, groupPrefix ? groupPrefix.replace(/^a0/, 'a') : animationName.split('_')[0]);
      const row = animations.locator('.wb-row').filter({ hasText: animationName }).first();
      await expect(row).toHaveCount(1, { timeout: 120_000 });
      await row.click();
      await expect(window.getByTestId('tae-clip-loading')).toBeHidden({ timeout: 120_000 });
      await expect(window.getByRole('button', { name: '播放' })).toBeEnabled({ timeout: 120_000 });
      await expect(window.getByText(/帧 0 \/ /)).toBeVisible({ timeout: 30_000 });
      const canvas = window.locator('.tae-preview__viewport canvas');
      await expect(canvas).toHaveCount(1);
      await window.addStyleTag({
        content: '.flver-viewer > div:not(:first-child) { display: none !important; }'
      });
      // TextureLoader decodes Bridge PNG data URIs asynchronously; allow the
      // first render pass to consume the decoded images before taking the
      // visual evidence screenshot.
      await window.waitForTimeout(750);
      await canvas.screenshot({ path: resolve(outputDir, `${filePrefix}-frame0.png`) });

      await window.getByRole('button', { name: '下一帧' }).click();
      await expect(window.getByText(/帧 1 \/ /)).toBeVisible({ timeout: 30_000 });
      await canvas.screenshot({ path: resolve(outputDir, `${filePrefix}-frame1.png`) });
    }

    try {
      await openWorkspace(window);
      await openResource(window, 'chr/c0000.anibnd.dcx');
      await expect(window.getByRole('region', { name: 'Animations' })).toBeVisible();
      for (const [animationName, prefix] of [
        ['a000_201802', 'c0000-a000-201802'],
        ['a000_201803', 'c0000-a000-201803'],
        ['a000_201804', 'c0000-a000-201804']
      ]) {
        await selectAndCapture(animationName, prefix);
      }

      await openResource(window, 'chr/c1130.anibnd.dcx');
      await expect(window.getByRole('region', { name: 'Animations' })).toBeVisible();
      for (const [animationName, prefix] of [
        ['a000_003000', 'c1130-a000-003000'],
        ['a000_003001', 'c1130-a000-003001'],
        ['a000_003002', 'c1130-a000-003002']
      ]) {
        await selectAndCapture(animationName, prefix);
      }

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
