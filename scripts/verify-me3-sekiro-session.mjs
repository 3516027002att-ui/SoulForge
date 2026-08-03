/**
 * Runner for the real me3 → Sekiro session smoke (W-ME3-INSTALL-04).
 *
 * Without SOULFORGE_SEKIRO_GAME_ROOT this is a structured skip (exit 0) and no
 * desktop build is triggered — safe for public CI, which never has real game
 * assets. With the env set it builds the desktop main bundle (including the
 * session smoke entry) and runs out/main/me3SekiroSessionSmoke.js.
 *
 * The session smoke only executes a real launch when
 * SOULFORGE_ME3_SEKIRO_SESSION_RUN=1 is also set; otherwise it performs the
 * same preflight and skips. This keeps `npm run test:me3-sekiro-session`
 * side-effect-free by default on any machine.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();

if (!gameRoot) {
  console.log(JSON.stringify({
    ok: true,
    status: 'skipped',
    gate: 'me3-sekiro-session',
    message: 'SOULFORGE_SEKIRO_GAME_ROOT 未设置：真实 Sekiro 会话未执行（本机验证不用于公共 CI）。'
  }, null, 2));
  process.exit(0);
}

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
    SOULFORGE_BUILD_ME3_SEKIRO_SESSION_SMOKE: '1'
  }
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const smoke = spawnSync(process.execPath, [
  join(root, 'apps', 'desktop', 'out', 'main', 'me3SekiroSessionSmoke.js')
], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});
if (smoke.error) throw smoke.error;
process.exit(smoke.status ?? 1);
