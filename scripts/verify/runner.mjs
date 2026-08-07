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
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { SILENT_ON_SUCCESS } from './tiers.mjs';

/**
 * 超时时杀掉整棵进程树，而不只是直接子进程。
 *
 * child.kill() 只终止我们 spawn 的那个 npm 壳。实测后果：runNativeFlverSmoke
 * 挂死时，被杀的是 npm，而它下面的 node 与两个 SoulForge.Bridge 孙进程继续存活
 * 四小时，锁住 bin 下的 SoulForge.Bridge.exe，使之后每一次 bridge:build 都失败。
 * 超时清理不彻底，等于把一次超时变成后续所有套件的连环失败。
 *
 * Windows 用 taskkill /T（按树），POSIX 用负 PID 杀进程组。两者都尽力而为：
 * 失败时退回直接 kill，不让清理本身抛错掩盖真正的超时结论。
 */
function killTree(child) {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // 树杀失败时至少终止直接子进程。
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出。
  }
}

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
 * 从一段输出里切出所有顶层 JSON 对象的源文本。
 *
 * 为什么不能按行 JSON.parse：套件的结构化结论有两种形态，单行
 * `JSON.stringify(x)` 与缩进的 `JSON.stringify(x, null, 2)`。按行处理只能
 * 认出前者——缩进形态的首行是裸 `{`（parse 失败），而 `"status": "skipped"`
 * 那行不以 `{` 开头会被直接跳过，于是整段输出一个跳过信号都采不到，落到
 * PASSED。实测后果：CI 里三条 native 门禁（private-native-gate、
 * section28-sekiro-gate、me3-sekiro-session）全部用缩进形态输出跳过，
 * 因此每次都把「什么都没跑」报成「真实执行并通过」——这是唯一一处门禁
 * 报告的绿色与事实相反，比覆盖不足危险得多。
 *
 * 所以改为按花括号深度扫描整段文本。必须跳过字符串字面量内的花括号与
 * 转义字符，否则正常输出里一句 `"提示：形如 {\"status\":\"skipped\"}"`
 * 会被当成结构化结论，把通过误判成跳过——那是反方向的同一类错误。
 */
function extractTopLevelJsonValues(text) {
  const values = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    // 数组与对象一起计深度，只取最外层。若只跟踪花括号，数组元素里的对象会
    // 被当成顶层结论——那会让「某个子项 skipped」冒充「整条套件 skipped」，
    // 把精确的 partial 误升为 skipped。
    if (char === '{' || char === '[') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        values.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return values;
}

/**
 * 从套件输出中提取跳过信号。
 *
 * 只认结构化 JSON 与显式 'skipped' 字段值，不做模糊文本匹配——
 * 模糊匹配会把 "0 skipped" 这类正常输出误判成跳过。
 *
 * 同时扫 stdout 与 stderr：仓库里有套件把结构化结论写到 stderr
 * （verify-private-native-gate.mjs 用 console.error 输出前置失败与跳过），
 * 只看 stdout 会让这些套件的跳过信号整体丢失。
 *
 * @param {string} stdout
 * @param {string} [stderr]
 * @returns {{ wholeSkipped: boolean, skippedLegs: string[] }}
 */
export function detectSkipSignals(stdout, stderr = '') {
  const skippedLegs = [];
  let wholeSkipped = false;

  for (const source of [stdout, stderr]) {
    if (typeof source !== 'string' || source.length === 0) continue;
    for (const candidate of extractTopLevelJsonValues(source)) {
      let parsed;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

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
  }

  return { wholeSkipped, skippedLegs: [...new Set(skippedLegs)] };
}

/**
 * 判定单条套件的结果。
 *
 * 空输出默认不判 PASSED：本仓库要求每条套件输出结构化结论，什么都不输出说明
 * 套件没真正跑到结论（壳层提前退出、被外部工具吞掉输出等）。把它算成通过
 * 等于让「没跑」冒充「跑过并通过」，与 --require-executed 的整个目的相反。
 *
 * 例外只认 SILENT_ON_SUCCESS 白名单（如 tsc 成功时本就静默）。用白名单而不是
 * 一律放行：一律放行会让所有套件的静默退化都变成绿色。
 *
 * @param {number|null} exitCode
 * @param {string} stdout
 * @param {string} [stderr]
 * @param {string} [scriptName] 用于查 SILENT_ON_SUCCESS 白名单
 */
export function classifyOutcome(exitCode, stdout, stderr = '', scriptName = '') {
  if (exitCode !== 0) return { outcome: OUTCOME.FAILED, skippedLegs: [] };
  const { wholeSkipped, skippedLegs } = detectSkipSignals(stdout, stderr);
  if (wholeSkipped) return { outcome: OUTCOME.SKIPPED, skippedLegs };
  if (skippedLegs.length > 0) return { outcome: OUTCOME.PARTIAL, skippedLegs };
  if ((stdout ?? '').trim().length === 0 && !SILENT_ON_SUCCESS[scriptName]) {
    return { outcome: OUTCOME.SKIPPED, skippedLegs: ['empty-stdout'] };
  }
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
      killTree(child);
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
        : classifyOutcome(exitCode, stdout, stderr, scriptName);
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
