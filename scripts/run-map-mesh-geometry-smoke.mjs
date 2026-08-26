#!/usr/bin/env node
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, 'apps', 'desktop', 'src', 'main', 'runMapMeshGeometrySmoke.ts');
const outDir = join(root, 'node_modules', '.cache', 'soulforge-map-mesh-smoke');
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, 'smoke.mjs');

buildSync({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false
});

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', encoding: 'utf8' });
if (result.status !== 0) process.exit(result.status ?? 1);
