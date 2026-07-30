import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32'
  ? (process.env.ComSpec || 'cmd.exe')
  : 'npm';
const npmArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run build -w @soulforge/desktop']
  : ['run', 'build', '-w', '@soulforge/desktop'];
const build = spawnSync(npmCommand, npmArgs, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    SOULFORGE_BUILD_ME3_GATEWAY_SMOKE: '1'
  }
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const smoke = spawnSync(process.execPath, [
  join(root, 'apps', 'desktop', 'out', 'main', 'me3RuntimeGatewaySmoke.js')
], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});
if (smoke.error) throw smoke.error;
process.exit(smoke.status ?? 1);
