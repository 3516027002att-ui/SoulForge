import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronVersion = JSON.parse(
  await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version;
const nativeRoot = join(root, 'apps', 'desktop', '.native');
const buildRoot = join(nativeRoot, 'electron-rebuild');
const isolatedModules = join(buildRoot, 'node_modules');
const sourceModule = join(root, 'node_modules', 'better-sqlite3');
const isolatedModule = join(isolatedModules, 'better-sqlite3');
const isolatedBinding = join(isolatedModule, 'build', 'Release', 'better_sqlite3.node');
const targetBinding = join(nativeRoot, 'better_sqlite3.node');
const metadataPath = join(nativeRoot, 'better_sqlite3.json');

assertInside(nativeRoot, buildRoot);
await rm(buildRoot, { recursive: true, force: true });
await mkdir(isolatedModules, { recursive: true });
await writeFile(join(buildRoot, 'package.json'), `${JSON.stringify({
  name: 'soulforge-electron-native-build',
  private: true,
  dependencies: {
    'better-sqlite3': JSON.parse(
      await readFile(join(sourceModule, 'package.json'), 'utf8')
    ).version
  }
}, null, 2)}\n`, 'utf8');
// Keep electron-rebuild's dependency walk inside the isolated copy instead of
// discovering the repository-level node_modules through the workspace lockfile.
await writeFile(join(buildRoot, 'package-lock.json'), '{}\n', 'utf8');
await cp(sourceModule, isolatedModule, { recursive: true });

const command = process.execPath;
const args = [
  join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
  '--force',
  '--version', electronVersion,
  '--module-dir', buildRoot,
  '--which-module', 'better-sqlite3',
  '--sequential'
];
const rebuilt = spawnSync(command, args, {
  cwd: buildRoot,
  stdio: 'inherit',
  env: process.env
});
if (rebuilt.error) throw rebuilt.error;
if (rebuilt.status !== 0) {
  throw new Error(`Electron better-sqlite3 rebuild exited with ${rebuilt.status}.`);
}

const electronBinding = await readFile(isolatedBinding);
await mkdir(nativeRoot, { recursive: true });
await writeFile(targetBinding, electronBinding);
await writeFile(metadataPath, `${JSON.stringify({
  electronVersion,
  platform: process.platform,
  arch: process.arch,
  generatedAt: new Date().toISOString()
}, null, 2)}\n`, 'utf8');

process.stdout.write(`${JSON.stringify({
  ok: true,
  electronVersion,
  targetBinding,
  isolatedBuild: true
}, null, 2)}\n`);

function assertInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  if (!childRelative || childRelative.startsWith('..') || isAbsolute(childRelative)) {
    throw new Error(`Refusing to clean native build path outside ${parent}.`);
  }
}
