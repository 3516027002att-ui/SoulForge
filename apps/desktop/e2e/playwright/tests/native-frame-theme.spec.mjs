import { test, expect, electron, testWorkspace } from '../owned-test.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../native-theme-main.mjs');
const built = existsSync(path.resolve(here, '../../../out/renderer/index.html'));
test.beforeEach(() => test.skip(!built, 'Production desktop build is required.'));
async function launch() {
  const app = await electron.launch({ args: [entry,
    ...(process.platform === 'linux' && process.env.SF_E2E_HEADLESS === '1' ? ['--ozone-platform=headless'] : []),
    `--user-data-dir=${path.join(testWorkspace().root, 'profile')}`] });
  await testWorkspace().registerApp(app);
  const page = await app.firstWindow();
  await page.locator('.app-root').waitFor({ state: 'attached' });
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  expect(preferences.sandbox).toBe(true);
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
  expect(preferences.webSecurity).toBe(true);
  return { app, page };
}
const background = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase());
test('native frame follows only the selected mode through switch, reset and renderer-owned restart', async () => {
  let current = await launch();
  await expect.poll(() => background(current.app)).toBe('#fbfbf9');
  await current.page.getByRole('button', { name: '设置', exact: true }).click();
  const settings = current.page.getByTestId('theme-settings');
  await settings.getByLabel('界面主题', { exact: true }).selectOption('obsidian');
  await expect.poll(() => background(current.app)).toBe('#010306');
  await settings.locator('summary').click();
  await settings.getByLabel('总体彩色强度', { exact: true }).press('Home');
  await expect(settings.locator('output').first()).toHaveText('0.00');
  await expect.poll(() => background(current.app)).toBe('#010306');
  await settings.getByRole('button', { name: '恢复预设', exact: true }).click();
  await expect(settings.locator('output').first()).toHaveText('1.00');
  await expect.poll(() => background(current.app)).toBe('#010306');
  await current.app.close();
  current = await launch();
  await expect.poll(() => current.page.evaluate(() => document.documentElement.dataset.spectralMode)).toBe('obsidian');
  await expect.poll(() => background(current.app)).toBe('#010306');
  await current.page.getByRole('button', { name: '设置', exact: true }).click();
  await current.page.getByTestId('theme-settings').getByLabel('界面主题', { exact: true }).selectOption('opal');
  await expect.poll(() => background(current.app)).toBe('#fbfbf9');
  const native = await current.app.evaluate(() => ({ platform: process.platform, overlays: global.__nativeThemeOverlays }));
  if (native.platform !== 'win32') expect(native.overlays).toEqual([]);
  else {
    expect(native.overlays.some(entry => entry.options.color === '#010306' && entry.options.symbolColor === '#DCE7EA' && entry.options.height === 40)).toBe(true);
    expect(native.overlays.some(entry => entry.options.color === '#FBFBF9' && entry.options.symbolColor === '#383C42' && entry.options.height === 40)).toBe(true);
  }
  await current.app.close();
});
test('native theme receiver rejects invalid mode, foreign sender and forged frame before touching a window', async () => {
  const { app, page } = await launch();
  expect(await page.evaluate(() => typeof window.soulforge.setWindowThemeMode)).toBe('function');
  const invalid = await page.evaluate(async () => {
    const values = [null, 'dark', '#ffffff', { mode: 'obsidian', color: '#ffffff' }];
    return Promise.all(values.map(value => window.soulforge.setWindowThemeMode(value)));
  });
  for (const result of invalid) expect(result).toEqual({ ok: false, code: 'WINDOW_THEME_MODE_INVALID' });
  const guards = await app.evaluate(async ({ BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const foreignBefore = foreign.getBackgroundColor();
    const receiver = global.__nativeThemeReceiver;
    const call = async event => {
      try { await receiver(event, 'obsidian'); return 'allowed'; }
      catch (error) { return String(error); }
    };
    try {
      const unknownSender = await call({ sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame });
      const forgedFrame = await call({ sender: owner.webContents, senderFrame: { url: owner.webContents.mainFrame.url } });
      const missingFrame = await call({ sender: owner.webContents, senderFrame: null });
      const rejectedBackground = owner.getBackgroundColor();
      const trusted = await receiver({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, 'obsidian');
      return { unknownSender, forgedFrame, missingFrame, rejectedBackground, trusted,
        trustedBackground: owner.getBackgroundColor(), foreignBefore, foreignBackground: foreign.getBackgroundColor() };
    } finally { foreign.destroy(); }
  });
  for (const result of [guards.unknownSender, guards.forgedFrame, guards.missingFrame]) expect(result).toContain('已拒绝不受信任的 IPC 调用');
  expect(guards.rejectedBackground.toLowerCase()).toBe('#fbfbf9');
  expect(guards.trusted).toEqual({ ok: true });
  expect(guards.trustedBackground.toLowerCase()).toBe('#010306');
  expect(guards.foreignBackground).toBe(guards.foreignBefore);
  await page.evaluate(() => window.soulforge.setWindowThemeMode('opal'));
  await expect.poll(() => background(app)).toBe('#fbfbf9');
  await app.close();
});
