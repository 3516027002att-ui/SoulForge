// @ts-check
/** Real production DOM/IPC/native writes on tiny owned constructed files.
 * No resource handler, metadata, preload or write port is replaced.
 * Empty draft is covered; zero-byte native Lua remains unsupported.
 * Theme token/DOM checks do not assert GPU or game-corpus rendering.
 */
import { test, expect, electron, testWorkspace } from '../owned-test.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareEditorComparisonWorkspace, SCRIPT_TEXT, OTHER_SCRIPT_TEXT, LONG_SCRIPT_TEXT } from '../editor-comparison-inputs.mjs';
import { createEditorSaveObservationTail } from '../editor-save-observation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const productionMain = path.resolve(here, '../editor-comparison-main.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Match existing native budgets; ordinary and invalid-draft UI waits stay 10s.
const NATIVE_SAVE_COMPLETION_TIMEOUT_MS = 120_000;
const PARAM_ROW_INDEX_COMPLETION_TIMEOUT_MS = 60_000;
const PARAM_PAGE_COMPLETION_TIMEOUT_MS = 120_000;

async function launchOwnedProduction() {
  for (const artifact of ['main/index.js', 'preload/index.cjs', 'renderer/index.html']) {
    expect(existsSync(path.resolve(here, '../../../out', artifact)), `Production build missing: ${artifact}`).toBe(true);
  }
  const inputs = await prepareEditorComparisonWorkspace(testWorkspace().root);
  const inputHashes = { script: hash(await readFile(path.join(inputs.overlay, inputs.scriptPath))),
    param: hash(await readFile(path.join(inputs.overlay, inputs.paramPath))) };
  const app = await electron.launch({
    chromiumSandbox: true,
    args: [productionMain,
      ...(process.platform === 'linux' && process.env.SF_E2E_HEADLESS === '1' ? ['--ozone-platform=headless'] : []),
      `--user-data-dir=${path.join(testWorkspace().root, 'profile')}`],
    env: { ...process.env, NODE_ENV: 'production', SF_E2E_OVERLAY_ROOT: inputs.overlay, SF_E2E_BASE_ROOT: inputs.base }
  });
  const observationTail = createEditorSaveObservationTail();
  app.process().stdout?.on('data', observationTail.consume);
  await testWorkspace().registerApp(app);
  expect(app.process().spawnargs).not.toContain('--no-sandbox');
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('PRODUCTION_WINDOW_MISSING');
    // Electron runtime introspection also used by the existing production specs;
    // getLastWebPreferences is present at runtime but absent from its declarations.
    const contents = /** @type {import('electron').WebContents & { getLastWebPreferences(): import('electron').WebPreferences }} */ (window.webContents);
    return contents.getLastWebPreferences();
  });
  expect(preferences.sandbox).toBe(true);
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
  expect(preferences.webSecurity).toBe(true);
  await page.waitForFunction(() => !!window.soulforge);
  const closeAgent = page.getByRole('button', { name: '关闭 Agent 面板' });
  if (await closeAgent.isVisible()) await closeAgent.click();
  await page.getByRole('region', { name: '开始' }).getByTestId('open-workspace').click();
  await expect(page.locator('.workspace-switcher__trigger')).toContainText('editor-comparison-overlay');
  const files = await page.evaluate(async paths => (await Promise.all(paths.map(query => window.soulforge.searchResources(query)))).flat(),
    [inputs.scriptPath, inputs.paramPath]);
  const script = files.find(file => file.relativePath === inputs.scriptPath);
  const param = files.find(file => file.relativePath === inputs.paramPath);
  expect(script, 'Constructed script must be in the real workspace index').toBeTruthy();
  expect(param, 'Constructed PARAM must be in the real workspace index').toBeTruthy();
  return { app, page, inputs, inputHashes, scriptUri: script.sourceUri, paramUri: param.sourceUri, pageErrors, observationTail };
}

async function reportOwnedFailure(app, page, inputs, inputHashes, phase, observationTail) {
  // Diagnostic observation has its own small deadline; it never retries a save
  // or changes the original assertion/error, IPC contract or native budgets.
  const bounded = async (operation, fallback) => {
    let timer;
    try { return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), 1000); })]); }
    catch { return fallback; }
    finally { clearTimeout(timer); }
  };
  const liveObservation = await bounded(app.evaluate(() => {
    const snapshot = Reflect.get(globalThis, '__editorSaveObservation');
    return typeof snapshot === 'function' ? snapshot() : { state: 'unavailable' };
  }), { state: 'unavailable' });
  const observation = liveObservation.state === 'unavailable' ? observationTail.snapshot() : liveObservation;
  const dom = await bounded(page.evaluate(() => ({
    // Closed status vocabulary only; an error toast/body can contain paths.
    script: document.querySelector('[data-testid="scp-status"]')?.textContent === '正在应用…' ? 'applying'
      : document.querySelector('[data-testid="scp-status"]')?.textContent === '已应用，可回滚。' ? 'applied' : 'other-or-absent',
    param: document.querySelector('.wb-toast--ok') ? 'ok' : document.querySelector('.wb-toast--error') ? 'error' : 'absent'
  })), { script: 'unavailable', param: 'unavailable' });
  const physical = {};
  for (const [kind, relative] of [['script', inputs.scriptPath], ['param', inputs.paramPath]]) {
    const current = await bounded(readFile(path.join(inputs.overlay, relative)).then(hash), null);
    physical[kind] = current === null ? { state: 'unavailable' } : { sha256: current, changed: current !== inputHashes[kind] };
  }
  console.log('[SF_EDITOR_SAVE_FAILURE]', JSON.stringify({ phase, dom, physical, observation }));
}

async function openResource(page, relativePath) {
  const closeAgent = page.getByRole('button', { name: '关闭 Agent 面板' });
  if (await closeAgent.isVisible()) await closeAgent.click();
  await page.keyboard.press('Control+k');
  await page.locator('.cmdk__input-wrap input').fill(relativePath);
  await expect(page.locator('.cmdk-item').filter({ hasText: relativePath })).toHaveCount(1);
  await page.keyboard.press('Enter');
}

async function replaceScript(page, source, text) {
  await source.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  // Real CodeMirror input path, including newlines and the empty draft.
  if (text === '') await page.keyboard.press('Backspace');
  else await page.keyboard.insertText(text);
}

async function readParamRow(page, sourceUri) {
  return page.evaluate(async uri => {
    const api = window.soulforge;
    const index = await api.readContainerParamRowIndex(uri, 0);
    if (!index.ok) return { ok: false, diagnostics: index.diagnostics };
    const current = await api.readContainerParamPage(uri, 0, 0, 20, undefined, false, index.sessionToken);
    return { ok: current.ok, containerHash: current.containerHash, childHash: current.childHash,
      rowDataSize: current.rowDataSize, fieldDefsOrigin: current.fieldDefsOrigin,
      rows: current.rows, diagnostics: current.diagnostics };
  }, sourceUri);
}

/** @param {import('playwright').ElectronApplication} app */
async function paramObservationCheckpoint(app) {
  return app.evaluate(() => {
    const snapshot = Reflect.get(globalThis, '__editorSaveObservation');
    if (typeof snapshot !== 'function') throw new Error('EDITOR_SAVE_OBSERVER_UNAVAILABLE');
    return snapshot().observedEvents;
  });
}

/** @param {import('playwright').ElectronApplication} app */
async function paramIpcCompletion(app, after, method) {
  return app.evaluate((_electron, { after, method }) => {
    const snapshot = Reflect.get(globalThis, '__editorSaveObservation');
    if (typeof snapshot !== 'function') throw new Error('EDITOR_SAVE_OBSERVER_UNAVAILABLE');
    const observation = snapshot();
    let started = false;
    for (const [index, event] of observation.events.entries()) {
      const sequence = observation.observedEvents - observation.events.length + index + 1;
      if (sequence <= after || event.stage !== 'ipc' || event.method !== method) continue;
      if (event.state === 'start') started = true;
      else if (started && event.state === 'finish' && event.ok === true) return sequence;
      else if (started && (event.state === 'finish' || event.state === 'throw')) return null;
    }
    return null;
  }, { after, method });
}

/** @param {import('playwright').ElectronApplication} app */
async function waitForParamReload(app, beforeSave) {
  // The current save must finish before its UI-owned index -> payload reads.
  // No native API is called here; a stale toast or draft value cannot pass.
  const waitRead = async (after, method, timeout) => {
    let finished = null;
    await expect.poll(async () => {
      finished = await paramIpcCompletion(app, after, method);
      return finished !== null;
    }, { timeout }).toBe(true);
    return finished;
  };
  const saved = await waitRead(beforeSave, 'resource.applyContainerParamFieldMutation', NATIVE_SAVE_COMPLETION_TIMEOUT_MS);
  expect(saved, 'The current PARAM blur must complete its original save IPC').toBeGreaterThan(beforeSave);
  const indexed = await waitRead(saved, 'resource.readContainerParamRowIndex', PARAM_ROW_INDEX_COMPLETION_TIMEOUT_MS);
  await waitRead(indexed, 'resource.readContainerParamPage', PARAM_PAGE_COMPLETION_TIMEOUT_MS);
}

for (const mode of ['opal', 'obsidian']) {
  test(`loaded Script comparison uses real production save/reload in ${mode}`, async () => {
    test.setTimeout(180_000);
    const { app, page, inputs, inputHashes, scriptUri, pageErrors, observationTail } = await launchOwnedProduction();
    let phase = 'script-edit';
    try {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByTestId('theme-settings').getByLabel('界面主题', { exact: true }).selectOption(mode);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.spectralMode)).toBe(mode);
      // Open through the existing command palette; settings owns only the sidebar.
      await openResource(page, inputs.scriptPath);
      await page.getByRole('row', { name: /baseline\.lua/ }).click();
      const source = page.getByRole('region', { name: '源码', exact: true });
      const comparison = source.locator('details.loaded-comparison');
      await expect(source.locator('.cm-content')).toContainText('return 1');
      await expect(comparison).toHaveJSProperty('open', false);
      await expect(comparison.locator('.loaded-comparison__body')).toHaveCount(0);

      // Typing while collapsed then opening must show the current actual draft.
      await replaceScript(page, source, 'return 3\n');
      await comparison.locator('summary').click();
      await expect(comparison.locator('.loaded-comparison__line.is-remove').filter({ hasText: 'return 1' })).toHaveCount(1);
      await expect(comparison.locator('.loaded-comparison__line.is-add').filter({ hasText: 'return 3' })).toHaveCount(1);
      await replaceScript(page, source, 'return 4\n');
      await expect(comparison.locator('.loaded-comparison__line.is-add').filter({ hasText: 'return 4' })).toHaveCount(1);
      await expect(comparison.locator('.loaded-comparison__line.is-add').filter({ hasText: 'return 3' })).toHaveCount(0);
      await replaceScript(page, source, '');
      await expect(comparison.locator('.loaded-comparison__line.is-remove').filter({ hasText: 'return 1' })).toHaveCount(1);
      await replaceScript(page, source, SCRIPT_TEXT);
      await expect(comparison).toContainText('没有草稿差异。');

      const savedScript = '-- owned UI edit\nreturn 7\n';
      const originalContainer = hash(await readFile(path.join(inputs.overlay, inputs.scriptPath)));
      await replaceScript(page, source, savedScript);
      const colors = await comparison.evaluate(element => {
        const styles = kind => {
          const line = element.querySelector(`.loaded-comparison__line.is-${kind}`);
          if (!line) throw new Error(`COMPARISON_${kind}_LINE_MISSING`);
          const style = getComputedStyle(line);
          return { background: style.backgroundColor, border: style.borderLeftColor };
        };
        return { removed: styles('remove'), added: styles('add') };
      });
      expect(colors.removed.border).not.toBe(colors.added.border);
      expect(colors.removed.background).not.toBe(colors.added.background);
      await page.screenshot({ path: test.info().outputPath(`script-comparison-${mode}.png`) });
      phase = 'script-save';
      await page.keyboard.press('Control+s');
      await expect(page.getByTestId('scp-status')).toHaveText('已应用，可回滚。', { timeout: NATIVE_SAVE_COMPLETION_TIMEOUT_MS });
      await expect(comparison).toHaveJSProperty('open', false);
      // Small source fits one viewport; assert the actual reloaded DOM text,
      // independently of the comparison's own no-difference projection.
      await expect.poll(async () => (await source.locator('.cm-content .cm-line').allTextContents()).join('\n')).toBe(savedScript);
      const nativeScript = await page.evaluate(uri => window.soulforge.readScriptSource(uri, 'baseline.lua', 0), scriptUri);
      expect(nativeScript.ok).toBe(true);
      expect(nativeScript.sourceText).toBe(savedScript);
      expect(hash(await readFile(path.join(inputs.overlay, inputs.scriptPath)))).not.toBe(originalContainer);
      await comparison.locator('summary').click();
      await expect(comparison).toContainText('没有草稿差异。');

      // Entry switch owns its baseline and resets expansion.
      await page.getByRole('row', { name: /other\.lua/ }).click();
      await expect(source.locator('.cm-content')).toContainText('return 2');
      await expect(comparison).toHaveJSProperty('open', false);
      const other = await page.evaluate(uri => window.soulforge.readScriptSource(uri, 'other.lua', 1), scriptUri);
      expect(other.sourceText).toBe(OTHER_SCRIPT_TEXT);
      await page.getByRole('row', { name: /long\.lua/ }).click();
      await expect(source.locator('.cm-content')).toContainText('loaded line 1');
      await comparison.locator('summary').click();
      await replaceScript(page, source, LONG_SCRIPT_TEXT.replaceAll('loaded line', 'draft line'));
      const scroll = comparison.locator('.loaded-comparison__source');
      await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight <= 260)).toBe(true);
      await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect.poll(() => scroll.evaluate(element => element.scrollTop > 0)).toBe(true);
      await replaceScript(page, source, LONG_SCRIPT_TEXT);
      await expect(comparison).toContainText('没有草稿差异。');
      expect(pageErrors).toEqual([]);
    } catch (error) {
      await reportOwnedFailure(app, page, inputs, inputHashes, phase, observationTail).catch(() => undefined);
      throw error;
    } finally { await app.close(); }
  });

  test(`loaded PARAM comparison uses real production save/reload in ${mode}`, async () => {
    test.setTimeout(180_000);
    const { app, page, inputs, inputHashes, paramUri, pageErrors, observationTail } = await launchOwnedProduction();
    let phase = 'param-edit';
    try {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByTestId('theme-settings').getByLabel('界面主题', { exact: true }).selectOption(mode);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.spectralMode)).toBe(mode);
      await openResource(page, inputs.paramPath);
      // Save toasts are siblings of the labelled layout inside this wrapper.
      const workbench = page.locator('.param-workbench');
      await expect(workbench).toHaveCount(1);
      await expect(workbench.getByLabel('PARAM 工作台', { exact: true })).toBeVisible();
      await workbench.getByRole('region', { name: '参数文件', exact: true }).getByRole('row', { name: /ActionGuideParam/ }).click();
      await workbench.getByRole('region', { name: '行', exact: true }).getByRole('row', { name: /^100\b/ }).click();
      const fields = workbench.getByRole('region', { name: '字段', exact: true });
      const fieldComparison = fields.locator('details.loaded-comparison');
      const priority = fields.getByLabel('Priority 值', { exact: true });
      await expect(priority).toBeEditable();
      await expect(priority).toHaveValue('1');
      const initial = await readParamRow(page, paramUri);
      expect(initial.ok).toBe(true);
      expect(initial.fieldDefsOrigin).toBe('first-party');
      expect(initial.rowDataSize).toBe(16);
      expect(initial.containerHash).toBe(hash(await readFile(path.join(inputs.overlay, inputs.paramPath))));
      const originalRow = Buffer.from(initial.rows.find(row => row.rowIndex === 0).dataBase64, 'base64');
      await expect(fieldComparison).toHaveJSProperty('open', false);
      await fieldComparison.locator('summary').click();
      await expect(fieldComparison).toContainText('没有草稿差异。');
      await priority.fill('5');
      await expect(fieldComparison.locator('.loaded-comparison__line.is-remove')).toHaveText('−1');
      await expect(fieldComparison.locator('.loaded-comparison__line.is-add')).toHaveText('+5');
      await priority.fill('6');
      await expect(fieldComparison.locator('.loaded-comparison__line.is-add')).toHaveText('+6');
      await priority.fill('1');
      await expect(fieldComparison).toContainText('没有草稿差异。');
      await priority.fill('7');
      await page.screenshot({ path: test.info().outputPath(`param-comparison-${mode}.png`) });
      phase = 'param-save';
      const saveCheckpoint = await paramObservationCheckpoint(app);
      await priority.press('Tab'); // Real blur -> native field write -> reload.
      await expect(workbench.locator('.wb-toast')).toHaveText('已保存', { timeout: NATIVE_SAVE_COMPLETION_TIMEOUT_MS });
      await expect(workbench.locator('.wb-toast')).toHaveClass(/\bwb-toast--ok\b/);
      await waitForParamReload(app, saveCheckpoint);
      await expect(fieldComparison).toHaveJSProperty('open', false);
      await expect(priority).toBeEditable();
      await expect(priority).toHaveValue('7');
      const after = await readParamRow(page, paramUri);
      expect(after.ok).toBe(true);
      expect(after.containerHash).not.toBe(initial.containerHash);
      expect(after.childHash).not.toBe(initial.childHash);
      expect(after.containerHash).toBe(hash(await readFile(path.join(inputs.overlay, inputs.paramPath))));
      const changedRow = Buffer.from(after.rows.find(row => row.rowIndex === 0).dataBase64, 'base64');
      const expectedRow = Buffer.from(originalRow); expectedRow.writeInt8(7, 4);
      expect(changedRow).toEqual(expectedRow); // Native reread preserves all siblings/padding.
      expect(after.rows.find(row => row.rowIndex === 1).dataBase64).toBe(initial.rows.find(row => row.rowIndex === 1).dataBase64);
      await fieldComparison.locator('summary').click();
      await expect(fieldComparison).toContainText('没有草稿差异。');

      // Invalid draft remains exact; the real encoder rejects it without a write.
      await priority.fill('not-a-number');
      phase = 'param-invalid';
      await expect(fieldComparison.locator('.loaded-comparison__line.is-remove')).toHaveText('−7');
      await expect(fieldComparison.locator('.loaded-comparison__line.is-add')).toHaveText('+not-a-number');
      await priority.press('Tab');
      await expect(workbench.locator('.wb-toast--error')).toBeVisible();
      await expect(priority).toHaveValue('not-a-number');
      await expect(fieldComparison).toHaveJSProperty('open', true);
      await expect(fieldComparison.locator('.loaded-comparison__line.is-add')).toHaveText('+not-a-number');
      expect(hash(await readFile(path.join(inputs.overlay, inputs.paramPath)))).toBe(after.containerHash);
      await priority.fill('7');
      phase = 'param-revert';
      await expect(fieldComparison).toContainText('没有草稿差异。');
      // Switch while unchanged: existing blur-save semantics remain in force.
      const revertCheckpoint = await paramObservationCheckpoint(app);
      await priority.press('Tab');
      await expect(workbench.locator('.wb-toast')).toHaveText('已保存', { timeout: NATIVE_SAVE_COMPLETION_TIMEOUT_MS });
      await expect(workbench.locator('.wb-toast')).toHaveClass(/\bwb-toast--ok\b/);
      await waitForParamReload(app, revertCheckpoint);
      await expect(priority).toBeEditable();
      await expect(priority).toHaveValue('7');
      await workbench.getByRole('region', { name: '行', exact: true }).getByRole('row', { name: /^101\b/ }).click();
      await expect(priority).toHaveValue('2');
      await expect(fieldComparison).toHaveJSProperty('open', false);
      expect(pageErrors).toEqual([]);
    } catch (error) {
      await reportOwnedFailure(app, page, inputs, inputHashes, phase, observationTail).catch(() => undefined);
      throw error;
    } finally { await app.close(); }
  });
}
