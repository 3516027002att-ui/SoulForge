import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgentProductionBuild } from './ensure-agent-production-build.mjs';

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

await ensureAgentProductionBuild({ databaseSmoke: true });

const electronPath = (await import('electron')).default;
if (typeof electronPath !== 'string') throw new Error('Unable to resolve Electron executable.');
const smoke = spawnSync(electronPath, [
  join(root, 'apps', 'desktop', 'out', 'main', 'databaseUtilitySmoke.js')
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: process.env
});
if (smoke.error) throw smoke.error;
process.exit(smoke.status ?? 1);
