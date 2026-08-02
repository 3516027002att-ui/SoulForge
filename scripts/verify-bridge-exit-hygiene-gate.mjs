#!/usr/bin/env node
/**
 * Bridge 宿主退出卫生门禁（运行期观测）。
 *
 * 抓的是一类只有运行期能看见的缺陷：smoke 断言全部通过、退出码为 0 的路径上，
 * 进程却因为 daemon 子进程句柄仍活跃而永不退出。
 *
 * 实测事故：runNativeFlverSmoke 的成功路径漏调 disposeBridgeDaemonPool()
 * （skip 路径和 catch 路径都调了，唯独成功路径没有），于是进程挂死四小时，
 * CPU 全程 0.1s 无增长，并锁住 bin 下的 SoulForge.Bridge.exe，使之后每一次
 * bridge:build 与整个 native 层失败。
 *
 * 静态门禁抓不到这个：仓库里 37 个用 runBridge 的 smoke/probe 全都出现过
 * disposeBridgeDaemonPool 这个标识符，"有没有调用"和"是否覆盖所有终止路径"
 * 是两件事。唯一可靠判据是真的跑一次、看它是否在期限内自己退出。
 *
 * 根因已在 bridgeDaemonClient 侧修掉（构造时 unref 子进程与三条 stdio 管道，
 * 请求期间按 inFlight 计数临时 ref 回来）。本门禁防止该修复被回退，也防止
 * 将来新增的写法重新引入活跃句柄。
 *
 * 判定：每个受测 smoke 必须在 EXIT_BUDGET_MS 内自行退出。超时即失败关闭，并
 * 杀掉整棵进程树，避免门禁自己留下孤儿。
 *
 * 缺本机语料时受测 smoke 会返回结构化 skipped 并正常退出——那同样通过本门禁，
 * 因为本门禁只判"是否退出"，不判"是否验证了 native 能力"。
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * 受测集合：跨越 daemon 使用形态的代表样本，而不是全部 37 个。
 *
 * 逐个跑完 37 个要几分钟，会让这条门禁贵到没人愿意跑；而退出卫生是全局属性
 * ——它由 bridgeDaemonClient 的句柄管理决定，不由单个 smoke 决定。样本覆盖
 * 「单次请求」「多次请求」「有 skip 分支」三种形态即可暴露回归。
 */
const SUBJECTS = Object.freeze([
  // 事故当事者：两次 runBridge，成功路径原先漏 dispose。
  'runNativeFlverSmoke',
  // 单次请求 + 缺语料时结构化 skip。
  'runNativeInspectSmoke',
  // 多次请求 + 容器枚举。
  'runScriptContainerEvidenceSmoke'
]);

/** 正常退出应在秒级。给足余量，但远小于「永不退出」。 */
const EXIT_BUDGET_MS = 240_000;

function killTree(pid) {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // 尽力而为。
  }
}

/**
 * @param {string} smokeName
 * @returns {Promise<{ smokeName: string, exited: boolean, exitCode: number|null, durationMs: number, stderrTail: string }>}
 */
function runOne(smokeName) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    // 经 with-local-has-game-env.mjs 注入本机语料环境：有语料时走真实路径，
    // 没有时受测 smoke 自己返回 skipped。两种情况都必须自行退出。
    const child = spawn(
      process.execPath,
      [
        'scripts/with-local-has-game-env.mjs',
        process.execPath,
        `packages/core/dist/testing/${smokeName}.js`
      ],
      { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }, EXIT_BUDGET_MS);

    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({
        smokeName,
        exited: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stderrTail: `spawn 失败：${error.message}`
      });
    });

    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        smokeName,
        exited: !timedOut,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        stderrTail: stderr.trim().slice(-600)
      });
    });
  });
}

const results = [];
for (const smokeName of SUBJECTS) {
  results.push(await runOne(smokeName));
}

const hung = results.filter((entry) => !entry.exited);
// 退出码本身不是本门禁的判据（缺语料、缺 dotnet 都可能非 0），但 spawn 失败要报出来。
const spawnFailed = results.filter((entry) => entry.exitCode === null && entry.exited === false
  && entry.stderrTail.startsWith('spawn 失败'));

if (hung.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    code: 'BRIDGE_HOST_DID_NOT_EXIT',
    message: `${hung.length} 个 bridge smoke 在 ${EXIT_BUDGET_MS}ms 内没有自行退出。`
      + ' 断言可能全部通过，但宿主进程被 daemon 子进程句柄挂住，会锁住 bridge 输出 exe'
      + ' 并让后续 bridge:build 与整个 native 层失败。'
      + ' 请检查 bridgeDaemonClient 是否仍在构造时 unref 子进程与 stdio，'
      + ' 以及请求期间的 inFlight ref/unref 配平。',
    budgetMs: EXIT_BUDGET_MS,
    hung: hung.map((entry) => ({
      smoke: `packages/core/src/testing/${entry.smokeName}.ts`,
      durationMs: entry.durationMs,
      stderrTail: entry.stderrTail
    })),
    allResults: results
  }, null, 2));
  process.exit(1);
}

if (spawnFailed.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    code: 'BRIDGE_SMOKE_SPAWN_FAILED',
    message: '受测 smoke 无法启动，本门禁无法给出退出卫生结论。',
    spawnFailed
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  message: '全部受测 bridge smoke 均在预算内自行退出',
  budgetMs: EXIT_BUDGET_MS,
  subjects: results.map((entry) => ({
    smoke: entry.smokeName,
    durationMs: entry.durationMs,
    exitCode: entry.exitCode
  })),
  note: '本门禁只判「宿主是否自行退出」；退出码非 0 可能是缺语料或缺 dotnet，不在此范围'
}, null, 2));
