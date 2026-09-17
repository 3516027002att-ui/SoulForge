#!/usr/bin/env node
/**
 * Keep Node-based tests independent from electron-builder's native rebuild.
 *
 * electron-builder may rebuild the repository-level better-sqlite3 module for
 * Electron's ABI. The desktop application uses apps/desktop/.native, so that
 * rebuild is correct for packaging but makes core tests fail under Node. This
 * helper is intentionally narrow and idempotent: it first loads the host
 * binding, and only rebuilds that package when Node reports an ABI mismatch.
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function loadHostBinding() {
  const Database = require('better-sqlite3');
  // better-sqlite3 resolves its native module lazily in the Database
  // constructor. Requiring the package alone therefore cannot detect an
  // Electron-vs-Node ABI mismatch after electron-builder has run.
  const database = new Database(':memory:');
  database.close();
}

try {
  loadHostBinding();
  console.log(JSON.stringify({
    ok: true,
    status: 'ready',
    binding: 'better-sqlite3',
    nodeModules: process.versions.modules
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/NODE_MODULE_VERSION|was compiled against a different Node\.js version/iu.test(message)) {
    console.error(JSON.stringify({
      ok: false,
      status: 'failed',
      code: 'HOST_NATIVE_BINDING_LOAD_FAILED',
      message: 'Node 测试 binding 无法加载，且不是可自动修复的 ABI 不匹配。'
    }));
    process.exit(2);
  }

  console.log(JSON.stringify({
    ok: true,
    status: 'rebuilding',
    binding: 'better-sqlite3',
    nodeModules: process.versions.modules
  }));
  const npmCli = process.env.npm_execpath?.trim()
    || resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const result = spawnSync(process.execPath, [npmCli, 'rebuild', 'better-sqlite3'], {
    cwd: root,
    env: { ...process.env, npm_config_build_from_source: 'true' },
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    console.error(JSON.stringify({
      ok: false,
      status: 'failed',
      code: 'HOST_NATIVE_BINDING_REBUILD_FAILED',
      message: 'Node 测试 binding ABI 重建失败。'
    }));
    process.exit(2);
  }

  try {
    loadHostBinding();
  } catch {
    console.error(JSON.stringify({
      ok: false,
      status: 'failed',
      code: 'HOST_NATIVE_BINDING_REBUILD_INVALID',
      message: 'Node 测试 binding 重建后仍无法加载。'
    }));
    process.exit(2);
  }
  console.log(JSON.stringify({
    ok: true,
    status: 'rebuilt',
    binding: 'better-sqlite3',
    nodeModules: process.versions.modules
  }));
}
