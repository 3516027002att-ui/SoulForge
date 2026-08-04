#!/usr/bin/env node
/**
 * Headless runner for the Three scene projection functional smoke
 * (apps/desktop/src/renderer/src/scene/runThreeSceneFunctionalSmoke.ts).
 *
 * Why esbuild: Node 24 does not resolve `.js` → `.ts` specifiers, and the smoke
 * (like the controller) imports three dynamically. esbuild bundles the smoke +
 * relative scene modules, keeps `three` / `three/webgpu` external (resolved from
 * the repo's node_modules at runtime), then spawns `node` on the bundle.
 *
 * No GPU, no DOM, no real game assets are touched.
 */
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(
  root,
  'apps',
  'desktop',
  'src',
  'renderer',
  'src',
  'scene',
  'runThreeSceneFunctionalSmoke.ts'
);
const outDir = join(root, 'node_modules', '.cache', 'soulforge-render-smoke');
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, 'smoke.mjs');

buildSync({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  external: ['three', 'three/webgpu']
});

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', encoding: 'utf8' });
if (result.status !== 0) process.exit(result.status ?? 1);
