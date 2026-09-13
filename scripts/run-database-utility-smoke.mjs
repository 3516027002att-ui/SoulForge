import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgentProductionBuild } from './ensure-agent-production-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
