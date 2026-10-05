import { test, expect, electron, testWorkspace } from '../owned-test.mjs';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingFile, missingConfiguration, missingPrivateGameRoot, verificationSkipReason } from '../../../../../scripts/verification-inputs.mjs';

// Only one read-only corpus is required. Expected totals must be supplied
// from an independent raw-byte/external oracle, never from this reader.
const source = process.env.SF_REAL_TAE_SOURCE?.trim();
const expectedCount = Number(process.env.SF_REAL_TAE_EXPECTED_ANIMATION_COUNT);
const here = dirname(fileURLToPath(import.meta.url));
const inputReason = verificationSkipReason([
  missingFile(source,{kind:'private-game-input',sourceEnv:'SF_REAL_TAE_SOURCE',logicalResource:'native TAE container'}),
  ...(!source ? [missingPrivateGameRoot()] : []),
  missingConfiguration(Number.isSafeInteger(expectedCount)&&expectedCount>0 ? String(expectedCount) : '',
    {kind:'independent-oracle',sourceEnv:'SF_REAL_TAE_EXPECTED_ANIMATION_COUNT',logicalResource:'independently verified animation total'})
]);
test.skip(Boolean(inputReason), inputReason);

test('real native TAE total renders on a bounded initial page and read failures stay visible', async () => {
  test.setTimeout(180_000);
  const root = testWorkspace().root;
  const game = join(root, 'game'); const overlay = join(game, 'mods'); const home = join(root, 'home');
  await mkdir(join(overlay, 'chr'), { recursive: true }); await mkdir(home);
  const bytes = await readFile(source); const hash = createHash('sha256').update(bytes).digest('hex');
  const target = join(overlay, 'chr/c0000.anibnd.dcx'); await copyFile(source, target);
  let app;
  try {
    app = await electron.launch({ chromiumSandbox: true, args: [resolve(here, '../production-main.mjs'),
      ...(process.env.SF_E2E_HEADLESS === '1' ? ['--ozone-platform=headless'] : []), `--user-data-dir=${join(root, 'user-data')}`],
      env: { ...process.env, HOME: home, NODE_ENV: 'production', SF_E2E_OVERLAY_ROOT: overlay, SF_E2E_BASE_ROOT: game,
        SF_E2E_WORKSPACE_STORAGE_ROOT: join(root, 'storage') } });
    await testWorkspace().registerApp(app);
    expect(app.process().spawnargs).not.toContain('--no-sandbox');
    const page = await app.firstWindow();
    const nativeWindow = await app.browserWindow(page);
    expect(await nativeWindow.evaluate(window => window.webContents.getLastWebPreferences().sandbox)).toBe(true);
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.waitForFunction(() => !!globalThis.soulforge);
    await page.getByRole('region', { name: '开始' }).getByTestId('open-workspace').click();
    await expect(page.locator('.workspace-switcher__trigger')).toContainText('mods', { timeout: 120_000 });
    const open = async () => {
      await page.keyboard.press('Control+k'); await page.locator('.cmdk__input-wrap input').fill('chr/c0000.anibnd.dcx');
      await expect(page.locator('.cmdk-item').filter({ hasText: 'chr/c0000.anibnd.dcx' })).toHaveCount(1);
      await page.keyboard.press('Enter'); await expect(page.getByLabel('动作工作台')).toBeVisible();
    };
    await open(); await expect(page.getByText(`${expectedCount} 个动画`, { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('tae-native-total.png') });
    await writeFile(target, Buffer.from('bad native bytes'));
    await open(); await expect(page.getByRole('alert').filter({ hasText: '动作读取失败' })).toBeVisible();
    await expect(page.getByText('0 个动画', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('tae-native-failure.png') });
    expect(errors).toEqual([]);
    expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(hash, 'input corpus remains byte-identical');
  } finally { await app?.close().catch(() => undefined);  }
});
