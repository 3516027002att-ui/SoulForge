import { buildSync } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'apps/desktop/src/renderer/src/scene');
const out = join(root, 'node_modules/.cache/scene-contracts');
mkdirSync(out, { recursive: true });
for (const name of readdirSync(directory).filter((name) => name.endsWith('.test.ts')).sort()) {
  const outfile = join(out, `${name}.mjs`);
  buildSync({ entryPoints: [join(directory, name)], outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external' });
  const result = spawnSync(process.execPath, ['--test', outfile], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
