/**
 * Runner for the real me3 → Sekiro session smoke (W-ME3-INSTALL-04).
 *
 * Without SOULFORGE_SEKIRO_GAME_ROOT this is a structured skip (exit 0) and no
 * desktop build is triggered — safe for public CI, which never has real game
 * assets. With the env set it builds the desktop main bundle (including the
 * session smoke entry) in an isolated, run-owned output directory.
 *
 * The session smoke only executes a real launch when
 * SOULFORGE_ME3_SEKIRO_SESSION_RUN=1 is also set; otherwise it performs the
 * same preflight and skips. This keeps `npm run test:me3-sekiro-session`
 * side-effect-free by default on any machine.
 */
import { runDesktopSmoke } from './desktop-test-build.mjs';
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

process.exit(await runDesktopSmoke('sekiro', 'me3SekiroSessionSmoke.js'));
