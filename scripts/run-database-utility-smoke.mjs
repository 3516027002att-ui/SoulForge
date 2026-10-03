import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDesktopSmoke } from './desktop-test-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gateTest = spawnSync(process.execPath, [
  '--experimental-strip-types',
  join(root, 'apps', 'desktop', 'src', 'main', 'workspaceDatabaseOpenGate.test.ts')
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: process.env
});
if (gateTest.error) throw gateTest.error;
if (gateTest.status !== 0) process.exit(gateTest.status ?? 1);

const electronPath = (await import('electron')).default;
if (typeof electronPath !== 'string') throw new Error('Unable to resolve Electron executable.');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--production-binding')) throw new Error('Unknown database smoke argument.');
process.exit(await runDesktopSmoke('database', 'databaseUtilitySmoke.js', electronPath, {
  reuseProductionBinding: args.includes('--production-binding')
}));
