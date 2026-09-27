import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [
  '--experimental-strip-types',
  join(root, 'apps', 'desktop', 'src', 'main', 'ipc', 'agentBridgeContext.test.ts')
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: process.env
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
