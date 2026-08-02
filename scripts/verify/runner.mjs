/**
 * 套件执行与结果判定。
 *
 * 设计要点：把「跳过」提升为一等结果。
 *
 * 仓库里 19 个 smoke 在缺少本机资源时走结构化跳过路径，输出 ok:true 并
 * exit 0。跳过标记至少有 4 种互不兼容的形态（status:'skipped'、
 * skipped:true、嵌套字段值 'skipped'、自由文本 'skipping'）。这意味着
 * 退出码和 ok 字段都无法区分「验证通过」和「什么都没验证」——绿色不代表
 * 被验证过。agent 靠这个判断推进就会把未验证的东西当成已验证。
 *
 * 因此本模块从 stdout 显式识别跳过信号，把结果分成
 * passed / skipped / partial / failed 四态，并要求调用方对 skipped 与
 * partial 做出选择（--require-executed 时它们算失败）。
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

export const OUTCOME = Object.freeze({
  PASSED: 'passed',
  /** 退出码 0，但输出表明整条套件没有真正执行。 */
  SKIPPED: 'skipped',
  /** 退出码 0，套件执行了，但其中某些 leg 被跳过。 */
  PARTIAL: 'partial',
  FAILED: 'failed',
  /** 依赖不满足，按登记直接不执行（未尝试）。 */
  NOT_ATTEMPTED: 'not-attempted'
});

/**
 * 从 stdout 中提取跳过信号。
 *
 * 只认结构化 JSON 与显式 'skipped' 字段值，不做模糊文本匹配——
 * 模糊匹配会把 "0 skipped" 这类正常输出误判成跳过。
 *
 * @returns {{ wholeSkipped: boolean, skippedLegs: string[] }}
 */
export function detectSkipSignals(stdout) {
  const skippedLegs = [];
  let wholeSkipped = false;

  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;

    // 形态 1/2：整条套件跳过。
    if (parsed.status === 'skipped' || parsed.skipped === true) {
      wholeSkipped = true;
      continue;
    }
    // 形态 3：某个 leg 跳过（字段值恰为 'skipped'）。
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'skipped') skippedLegs.push(key);
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [innerKey, innerValue] of Object.entries(value)) {
          if (innerValue === 'skipped') skippedLegs.push(`${key}.${innerKey}`);
        }
      }
    }
  }

  return { wholeSkipped, skippedLegs: [...new Set(skippedLegs)] };
}

/**
 * 判定单条套件的结果。
 *
 * @param {number|null} exitCode
 * @param {string} stdout
 */
export function classifyOutcome(exitCode, stdout) {
  if (exitCode !== 0) return { outcome: OUTCOME.FAILED, skippedLegs: [] };
  const { wholeSkipped, skippedLegs } = detectSkipSignals(stdout);
  if (wholeSkipped) return { outcome: OUTCOME.SKIPPED, skippedLegs };
  if (skippedLegs.length > 0) return { outcome: OUTCOME.PARTIAL, skippedLegs };
  return { outcome: OUTCOME.PASSED, skippedLegs: [] };
}

/**
 * 执行一条 npm script。
 *
 * 始终经 scripts/with-local-has-game-env.mjs 包裹：该 wrapper 只在本机确实
 * 存在可读的 Sekiro 根与 fixture registry 时填充缺失的 SOULFORGE_* 变量，
 * 从不发明路径、从不覆盖已设值。这样「本机有资源就真跑、没有就诚实跳过」
 * 无需 agent 记住额外命令，也不会因为忘记加 wrapper 而把真实验证悄悄降级
 * 成跳过。
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.scriptName
 * @param {number} options.timeoutMs
 * @param {boolean} [options.injectEnv] 是否经 env wrapper（默认 true）。
 */
export function runSuite({ repoRoot, scriptName, timeoutMs, injectEnv = true }) {
  return new Promise((resolvePromise) => {
    const npmArgs = ['run', scriptName, '--silent'];
    // 始终用 process.execPath 执行 JS 入口，不依赖 shell 解析 `npm`：
    // Windows 下 npm 是 .cmd，spawn 不带 shell 时无法直接执行。
    const npmCli = process.env.npm_execpath?.trim()
      || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const args = injectEnv
      ? ['scripts/with-local-has-game-env.mjs', 'npm', ...npmArgs]
      : [npmCli, ...npmArgs];

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({
        scriptName,
        outcome: OUTCOME.FAILED,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        skippedLegs: [],
        spawnError: error instanceof Error ? error.message : String(error),
        stdout,
        stderr
      });
    });

    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const { outcome, skippedLegs } = timedOut
        ? { outcome: OUTCOME.FAILED, skippedLegs: [] }
        : classifyOutcome(exitCode, stdout);
      resolvePromise({
        scriptName,
        outcome,
        exitCode,
        durationMs: Date.now() - startedAt,
        skippedLegs,
        timedOut,
        stdout,
        stderr
      });
    });
  });
}
