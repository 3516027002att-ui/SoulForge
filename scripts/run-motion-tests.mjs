#!/usr/bin/env node
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const motionTestFile = join(root, 'apps', 'desktop', 'src', 'renderer', 'src', 'components', 'motion', 'motion.test.tsx');

if (!existsSync(motionTestFile)) {
  console.error(`Motion test file not found: ${motionTestFile}`);
  process.exit(1);
}

const outDir = join(root, 'node_modules', '.cache', 'soulforge-motion-tests');
mkdirSync(outDir, { recursive: true });

const outfile = join(outDir, 'motion.test.mjs');
buildSync({
  entryPoints: [motionTestFile],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'inline',
  external: ['node:*', 'react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'better-sqlite3', 'bindings'],
  jsx: 'automatic'
});

const result = spawnSync(process.execPath, ['--test', outfile], {
  cwd: root,
  stdio: 'inherit',
  encoding: 'utf8'
});

if (result.status !== 0) {
  console.error(JSON.stringify({
    ok: false,
    suite: 'motion-unit',
    message: 'Motion unit tests failed'
  }, null, 2));
  process.exit(result.status ?? 1);
}

console.log(JSON.stringify({
  ok: true,
  suite: 'motion-unit',
  message: 'All motion wrapper unit tests passed'
}, null, 2));
