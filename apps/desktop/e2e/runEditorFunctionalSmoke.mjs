/**
 * Electron functional smoke orchestrator (W-REL-F-SCALE-02).
 *
 * Gates whether the Electron functional smoke harness can run in this
 * environment, then spawns Electron with the harness main. In CI / headless /
 * unbuilt / not-explicitly-enabled environments it exits 0 with a structured
 * skip record — it never claims a pass that did not run.
 *
 * Real corpus is consumed only when the native fixture env is injected
 * (`node scripts/with-local-has-game-env.mjs npm run <script>`); without it the
 * harness reports a structured skip.
 *
 * Suggested registration (coordinator-owned package.json):
 *   "test:editor-functional-smoke": "node apps/desktop/e2e/runEditorFunctionalSmoke.mjs"
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const preloadPath = resolve(repoRoot, 'apps/desktop/out/preload/index.mjs');
const rendererPath = resolve(repoRoot, 'apps/desktop/out/renderer/index.html');
const harnessMainPath = resolve(here, 'editorFunctionalSmokeMain.mjs');

const explicit = process.env.SOULFORGE_FUNCTIONAL_SMOKE === '1';
const built = existsSync(preloadPath) && existsSync(rendererPath);
const headlessLinux = process.platform !== 'win32' && !process.env.DISPLAY;

function structuredSkip(reason) {
  console.log(JSON.stringify({
    ok: null,
    harnessStatus: 'skipped',
    electronFunctionalSmoke: {
      run: false,
      pass: null,
      reason
    },
    skipSemantics: '结构跳过：未声称通过，也不计为失败；CI/无显示/未显式启用/构建缺失时默认走此路径。'
  }, null, 2));
  process.exit(0);
}

if (!explicit) {
  structuredSkip('SOULFORGE_FUNCTIONAL_SMOKE 未显式置 1（默认跳过，避免在无显示/CI 环境启动 Electron）');
}
if (!built) {
  structuredSkip('desktop 构建产物缺失（apps/desktop/out/preload/index.mjs 或 out/renderer/index.html），请先构建桌面包');
}
if (headlessLinux) {
  structuredSkip('无显示环境（Linux DISPLAY 未设置），Electron 无法打开窗口');
}

const require = createRequire(import.meta.url);
/** The electron package default export in a Node context is the binary path. */
const electronPath = require('electron');

const child = spawn(electronPath, [harnessMainPath], {
  stdio: 'inherit',
  env: { ...process.env, SOULFORGE_FUNCTIONAL_SMOKE: '1' },
  windowsHide: true
});
child.on('error', (error) => {
  console.error(JSON.stringify({
    ok: false,
    code: 'ELECTRON_SPAWN_FAILED',
    message: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
});
child.on('exit', (code) => {
  process.exit(typeof code === 'number' ? code : 1);
});
