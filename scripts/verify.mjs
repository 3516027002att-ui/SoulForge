#!/usr/bin/env node
/**
 * 统一验证入口：按层级、suite 或结构化切片计划执行。
 * 同批次复用相同操作，保留 passed/skipped/partial/failed/not-attempted。
 * --list 展示计划；--audit 校验登记；--require-executed 拒绝跳过。
 * 参数和使用示例见根 README 的“按改动选择验证”。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { classifyScript, loadWorkspaces } from './verify/scriptGraph.mjs';
import { EXCLUDED, TIER_BY_SCRIPT, TIER_ORDER } from './verify/tiers.mjs';
import { OUTCOME, runPlannedSuite } from './verify/runner.mjs';
import { planScript, summarizePlan } from './verify/commandPlan.mjs';
import { normalizeRequiredValidation, validateRequiredValidation } from './governance/requiredValidation.mjs';

const DEFAULT_TIERS = ['governance', 'unit'];
const DEFAULT_TIMEOUT_MS = 900_000;

function parseArgs(argv) {
  const options = {
    tiers: DEFAULT_TIERS,
    filter: null,
    slice: null,
    suites: [],
    exclude: [],
    requireExecuted: false,
    requireTiers: [],
    requireSuites: [],
    audit: false,
    list: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    jsonOut: null,
    bail: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[index + 1];
    if (['--tier', '--slice', '--suite', '--filter', '--exclude', '--require-tier', '--require-suite', '--timeout-ms', '--json-out'].includes(arg)
      && (!next() || next().startsWith('--'))) return { error: `${arg} 缺少值。` };
    switch (arg) {
      case '--tier': {
        const value = next();
        index += 1;
        options.tiers = value === 'all' ? [...TIER_ORDER] : value.split(',').map((part) => part.trim());
        break;
      }
      case '--filter':
        options.filter = next();
        index += 1;
        break;
      case '--slice':
        options.slice = next();
        index += 1;
        break;
      case '--suite':
        options.suites.push(...next().split(',').map((part) => part.trim()));
        index += 1;
        break;
      case '--exclude':
        options.exclude.push(...next().split(',').map((part) => part.trim()).filter(Boolean));
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number.parseInt(next(), 10);
        index += 1;
        break;
      case '--json-out':
        options.jsonOut = next();
        index += 1;
        break;
      case '--require-executed':
        options.requireExecuted = true;
        break;
      case '--require-tier':
        options.requireTiers.push(...next().split(','));
        index += 1;
        break;
      case '--require-suite':
        options.requireSuites.push(...next().split(','));
        index += 1;
        break;
      case '--no-bail':
        options.bail = false;
        break;
      case '--audit':
        options.audit = true;
        break;
      case '--list':
        options.list = true;
        break;
      default:
        return { error: `未知参数：${arg}` };
    }
  }
  const unknownTiers = [...options.tiers, ...options.requireTiers].filter((tier) => !TIER_ORDER.includes(tier));
  if (unknownTiers.length > 0) {
    return { error: `未知层级：${unknownTiers.join(', ')}（可选 ${TIER_ORDER.join('/')}/all）` };
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return { error: '--timeout-ms 必须是正整数毫秒。' };
  }
  if (options.slice && (argv.includes('--tier') || options.suites.length || options.filter || options.exclude.length || options.audit)) {
    return { error: '--slice 按有序 requiredValidation 选取，不能与 --tier/--filter/--exclude/--audit 混用。' };
  }
  if (options.suites.length && (argv.includes('--tier') || options.filter || options.exclude.length || options.audit)) {
    return { error: '--suite 按给定顺序选取，不能与 --tier/--filter/--exclude/--audit 混用。' };
  }
  return { options };
}

/** 从一条 script 命令里抽出它执行的入口文件（dist/testing/xxx.js 之类）。 */
function extractEntryFiles(command) {
  if (typeof command !== 'string') return [];
  return [...command.matchAll(/node\s+((?:\.\/)?[A-Za-z0-9./_-]+\.(?:js|mjs|cjs))/g)]
    .map((match) => match[1].replace(/^\.\//, ''));
}

/**
 * workspace 侧 test* script 是否真的会被执行到。
 *
 * 判据不是「有没有同名根 script」，而是**它的入口文件有没有别的可达 script 也在跑**。
 * 理由：本仓库 packages/core 有一批 test:v05-* 是便利别名，它们指向的 smoke 文件
 * 早已串在 core 自己的 `test` 链里（根 `test` 用 --workspaces 聚合，因此可达）。
 * 按名字判会把这些别名全报成孤岛——那是噪声，会让门禁被无视。按入口文件判才能
 * 只留下真正没人跑的：实测唯一一条是 test:real-mod-readonly-preview（runRealModOpenSmoke.js
 * 既不在 core 的 test 链里，也没有任何根转发）。
 */
function isReachableFromRoot(workspaces, workspaceName, workspace, scriptName) {
  // 根 `test` 用 `--workspaces --if-present` 聚合：workspace 自己的 `test` 一定可达。
  if (scriptName === 'test') return true;

  const rootCommands = Object.values(workspaces.rootScripts);
  const forwarded = rootCommands.some((command) => {
    if (typeof command !== 'string') return false;
    if (!command.includes(scriptName)) return false;
    return command.includes(`-w ${workspaceName}`) || command.includes(`run ${scriptName}`);
  });
  if (forwarded) return true;

  // 入口文件是否已被本 workspace 内某条可达 script 覆盖。
  const ownEntries = extractEntryFiles(workspace.scripts?.[scriptName]);
  if (ownEntries.length === 0) return false;
  const coveredEntries = new Set();
  for (const [otherName, otherCommand] of Object.entries(workspace.scripts ?? {})) {
    if (otherName === scriptName) continue;
    const reachable = otherName === 'test'
      || rootCommands.some((command) => typeof command === 'string'
        && command.includes(otherName)
        && (command.includes(`-w ${workspaceName}`) || command.includes(`run ${otherName}`)));
    if (!reachable) continue;
    for (const entry of extractEntryFiles(otherCommand)) coveredEntries.add(entry);
  }
  return ownEntries.every((entry) => coveredEntries.has(entry));
}

/** 登记审计：确保没有「存在但没人跑」的验证。 */
function auditRegistration(workspaces) {
  const findings = [];
  const all = Object.keys(workspaces.rootScripts);
  for (const name of all) {
    if (TIER_BY_SCRIPT[name] || EXCLUDED[name]) continue;
    findings.push({
      severity: 'error',
      code: 'SUITE_UNREGISTERED',
      where: `package.json scripts.${name}`,
      message: '新 script 未登记层级也未写明排除理由；未登记的验证等于没人跑。'
        + ' 请在 scripts/verify/tiers.mjs 的 TIER_BY_SCRIPT 或 EXCLUDED 中登记。'
    });
  }

  // workspace 侧的 test* script 也要纳入登记要求。
  //
  // 此前 audit 只枚举 rootScripts，于是 workspace 自己声明的验证入口对它完全不可见。
  // 实测两个后果：apps/desktop 的 test:renderer-playwright 是唯一的真实 Electron
  // e2e（13 用例），却不在任何 tier —— 只有 CI 直调，本机跑 `verify --tier all`
  // 永远不会执行它；packages/core 的 test:real-mod-readonly-preview 既不在根 package.json、也不在
  // core 的 test 聚合链里，任何层级都跑不到，而 orphan-smoke-gate 因为「有 core
  // script」就判它 reachable。两道门禁各自留了对方该补的盲区。
  for (const [workspaceName, workspace] of workspaces.byName) {
    for (const scriptName of Object.keys(workspace.scripts ?? {})) {
      if (!scriptName.startsWith('test')) continue;
      const qualified = `${workspaceName}:${scriptName}`;
      if (TIER_BY_SCRIPT[scriptName] || EXCLUDED[scriptName]) continue;
      if (TIER_BY_SCRIPT[qualified] || EXCLUDED[qualified]) continue;
      if (isReachableFromRoot(workspaces, workspaceName, workspace, scriptName)) continue;
      findings.push({
        severity: 'error',
        code: 'WORKSPACE_SUITE_UNREGISTERED',
        where: `${workspace.dir}/package.json scripts.${scriptName}`,
        message: `workspace 验证入口 ${qualified} 既未登记层级、也没有任何根 script 能到达；`
          + '它在 verify 的任何层级里都不会被执行。请登记到 tiers.mjs（键用 '
          + `"${qualified}"），或写明排除理由，或加一条根转发。`
      });
    }
  }
  const known = new Set(all);
  for (const name of Object.keys(TIER_BY_SCRIPT)) {
    if (known.has(name)) continue;
    findings.push({
      severity: 'error',
      code: 'SUITE_REGISTERED_BUT_MISSING',
      where: `scripts/verify/tiers.mjs TIER_BY_SCRIPT.${name}`,
      message: '登记了不存在的 script；层级表与 package.json 已漂移。'
    });
  }
  for (const name of Object.keys(EXCLUDED)) {
    if (known.has(name)) continue;
    findings.push({
      severity: 'error',
      code: 'EXCLUSION_STALE',
      where: `scripts/verify/tiers.mjs EXCLUDED.${name}`,
      message: '排除了不存在的 script；排除表已过期。'
    });
  }
  return findings;
}

const { options, error } = parseArgs(process.argv.slice(2));
if (error) {
  console.error(JSON.stringify({ ok: false, code: 'VERIFY_ARGUMENT_INVALID', message: error }, null, 2));
  process.exit(2);
}

const repoRoot = process.cwd();
const workspaces = loadWorkspaces(repoRoot);
const auditFindings = auditRegistration(workspaces);
for (const name of [...options.suites, ...options.exclude, ...options.requireSuites]) {
  if (!TIER_BY_SCRIPT[name]) {
    console.error(JSON.stringify({ ok: false, code: 'VERIFY_ARGUMENT_INVALID', message: `未登记套件：${name}` }));
    process.exit(2);
  }
}

if (options.audit) {
  const ok = auditFindings.length === 0;
  console.log(JSON.stringify({
    ok,
    mode: 'audit',
    message: ok
      ? '全部 npm script 均已登记层级或写明排除理由'
      : '存在未登记或已漂移的 script；失败关闭',
    totalScripts: Object.keys(workspaces.rootScripts).length,
    registered: Object.keys(TIER_BY_SCRIPT).length,
    excluded: Object.keys(EXCLUDED).length,
    findings: auditFindings
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

// 审计失败不允许继续执行：层级表漂移时「跑了哪些」本身不可信。
if (auditFindings.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    code: 'VERIFY_REGISTRY_DRIFTED',
    message: '层级登记表与 package.json 不一致，拒绝执行。运行 node scripts/verify.mjs --audit 查看详情。',
    findings: auditFindings
  }, null, 2));
  process.exit(1);
}

const plan = [];
function addSuite(name, tier, invocation = {}) {
  try {
    const classification = classifyScript(repoRoot, workspaces, name);
    plan.push({ scriptName: name, tier, requirements: classification.requirements,
      steps: planScript(repoRoot, workspaces, name, invocation) });
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: 'VERIFY_PLAN_INVALID', scriptName: name, message: error.message }));
    process.exit(1);
  }
}
let sliceValidation = null;
if (options.slice) {
  const slice = JSON.parse(readFileSync(resolve(repoRoot, 'docs/governance/slices.json'), 'utf8'))
    .slices.find((item) => item.sliceId === options.slice);
  const findings = slice ? validateRequiredValidation(slice.requiredValidation, { rootPackage: { scripts: workspaces.rootScripts } }) : [];
  sliceValidation = slice ? normalizeRequiredValidation(slice.requiredValidation) : null;
  if (!sliceValidation || findings.length || sliceValidation.kind !== 'structured') {
    console.error(JSON.stringify({ ok: false, code: 'VERIFY_SLICE_PLAN_UNAVAILABLE', sliceId: options.slice,
      message: '切片不存在或尚未提供有效的结构化 requiredValidation；旧自由文本不会被当作 shell 执行。', findings }));
    process.exit(1);
  }
  for (const step of sliceValidation.steps) {
    if (['verify', 'verify:all', 'verify:list', 'gov', 'gov:seal', 'handoff:project'].includes(step.suiteId)) {
      console.error(JSON.stringify({ ok: false, code: 'VERIFY_SLICE_PLAN_UNSAFE', suiteId: step.suiteId }));
      process.exit(1);
    }
    addSuite(step.suiteId, TIER_BY_SCRIPT[step.suiteId] ?? 'slice-prerequisite', step);
  }
}
for (const name of options.suites) {
  addSuite(name, TIER_BY_SCRIPT[name]);
}
for (const tier of options.slice || options.suites.length ? [] : TIER_ORDER) {
  if (!options.tiers.includes(tier)) continue;
  const names = Object.keys(TIER_BY_SCRIPT)
    .filter((name) => TIER_BY_SCRIPT[name] === tier)
    .filter((name) => (options.filter ? name.includes(options.filter) : true))
    .filter((name) => !options.exclude.includes(name))
    .sort();
  for (const name of names) {
    addSuite(name, tier);
  }
}
const selectedTiers = [...new Set(plan.map((entry) => entry.tier))];

if (options.list) {
  console.log(JSON.stringify({
    ok: true,
    mode: 'list',
    tiers: selectedTiers,
    filter: options.filter,
    excluded: options.exclude,
    suiteCount: plan.length,
    ...(options.slice ? { sliceId: options.slice, manualChecks: sliceValidation.manualChecks, notes: sliceValidation.notes } : {}),
    scheduling: summarizePlan(plan),
    suites: plan
  }, null, 2));
  process.exit(0);
}

if (plan.length === 0) {
  console.error(JSON.stringify({
    ok: false,
    code: 'VERIFY_EMPTY_PLAN',
    message: '筛选后没有任何套件；空计划视为失败，避免「什么都没跑」被当成通过。',
    tiers: options.tiers,
    filter: options.filter
  }, null, 2));
  process.exit(1);
}

const results = [];
const operationCache = new Map();
let bailed = false;
for (const entry of plan) {
  if (bailed) {
    const { steps, ...unattempted } = entry;
    results.push({ ...unattempted, outcome: OUTCOME.NOT_ATTEMPTED, durationMs: 0, skippedLegs: [] });
    // 终端逐条输出是人最先看到的地方：这里必须显式说「没跑」，否则被 bail 掩掉的
    // 条目在屏幕上完全不出现，读者会以为本层只有前几条。
    console.error(`SKIPPED-BY-BAIL [${entry.tier}] ${entry.scriptName} (未执行)`);
    continue;
  }
  const result = await runPlannedSuite({
    repoRoot,
    entry,
    timeoutMs: options.timeoutMs,
    cache: operationCache
  });
  const treatedAsFailure = result.outcome === OUTCOME.FAILED
    || ((options.requireExecuted || options.requireTiers.includes(entry.tier) || options.requireSuites.includes(entry.scriptName))
      && (result.outcome === OUTCOME.SKIPPED || result.outcome === OUTCOME.PARTIAL));

  results.push({
    scriptName: entry.scriptName,
    tier: entry.tier,
    requirements: entry.requirements,
    outcome: result.outcome,
    treatedAsFailure,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    skippedLegs: result.skippedLegs,
    steps: result.steps,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.spawnError ? { spawnError: result.spawnError } : {}),
    ...(treatedAsFailure
      ? { tailStdout: result.stdout.split(/\r?\n/).slice(-25).join('\n'),
        tailStderr: result.stderr.split(/\r?\n/).slice(-25).join('\n') }
      : {})
  });

  const label = `[${entry.tier}] ${entry.scriptName}`;
  const seconds = (result.durationMs / 1000).toFixed(1);
  console.error(`${treatedAsFailure ? 'FAIL' : result.outcome.toUpperCase().padEnd(7)} ${label} (${seconds}s)`);

  if (treatedAsFailure && options.bail) bailed = true;
}

const counts = {};
for (const outcome of Object.values(OUTCOME)) {
  counts[outcome] = results.filter((result) => result.outcome === outcome).length;
}
const failures = results.filter((result) => result.treatedAsFailure);
const ok = failures.length === 0;

// bail 中断后未执行的条目。它们既不是通过也不是跳过，而是**根本没跑**。
//
// 为什么要单列并写进 message：默认 bail 下，一条红会让同层其余套件全部变成
// not-attempted，而汇总里 `not-attempted: 15` 与 `passed: 2` 并列呈现，读起来
// 像「15 条不适用」。实测事故：治理层 18 条只跑了 3 条就中断，输出里 15 条
// not-attempted，而真实状态是 3 条失败；不加 --no-bail 根本看不到全貌。
// 这类「没跑被读成通过」是本仓库反复出现的一类问题，判据必须自己说清楚。
const notAttempted = results.filter((r) => r.outcome === OUTCOME.NOT_ATTEMPTED);
const bailNote = notAttempted.length > 0
  ? `；另有 ${notAttempted.length} 条因 bail 中断而**未执行**（不是通过、也不是跳过），`
    + '加 --no-bail 可看到本层全貌'
  : '';

const summary = {
  ok,
  mode: 'run',
  ...(options.slice ? { sliceId: options.slice, manualChecks: sliceValidation.manualChecks,
    sliceValidationStatus: sliceValidation.manualChecks.length ? 'manual-pending' : 'automated-results-only',
    notes: sliceValidation.notes } : {}),
  message: (ok
    ? `${counts.passed} 条套件由本次执行结果覆盖并通过（相同操作的复用见 steps）`
      + (counts.skipped > 0 || counts.partial > 0
        ? `；${counts.skipped} 条整体跳过、${counts.partial} 条部分跳过（缺本机资源，不构成 native 完成声明）`
        : '')
    : `${failures.length} 条套件失败`) + bailNote,
  tiers: selectedTiers,
  filter: options.filter,
  excluded: options.exclude,
  scheduling: {
    ...summarizePlan(plan),
    executedOperations: results.flatMap((r) => r.steps ?? []).filter((s) => s.execution === 'executed').length,
    reusedOperations: results.flatMap((r) => r.steps ?? []).filter((s) => s.execution === 'reused').length
  },
  requireExecuted: options.requireExecuted,
  requireTiers: options.requireTiers,
  requireSuites: options.requireSuites,
  counts,
  // 明确回答「这次到底验证了什么」：只有 passed 是真正执行且通过的。
  executedAndPassed: results.filter((r) => r.outcome === OUTCOME.PASSED).map((r) => r.scriptName),
  skippedEntirely: results.filter((r) => r.outcome === OUTCOME.SKIPPED).map((r) => r.scriptName),
  partiallySkipped: results
    .filter((r) => r.outcome === OUTCOME.PARTIAL)
    .map((r) => ({ scriptName: r.scriptName, skippedLegs: r.skippedLegs })),
  failed: failures.map((r) => r.scriptName),
  // 与 executedAndPassed / skippedEntirely 并列：把「没跑」也变成一个显式清单，
  // 而不是只体现为 counts 里一个容易被误读的数字。
  notAttemptedDueToBail: notAttempted.map((r) => r.scriptName),
  results
};

if (options.jsonOut) {
  // 失败路径也必须能落盘摘要：CI 用 --json-out output/... 时 output/ 往往尚未创建。
  // 写出前建父目录，避免「真实 suite 失败」被 ENOENT 二次掩盖。
  const jsonPath = resolve(repoRoot, options.jsonOut);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(summary, null, 2));
process.exit(ok ? 0 : 1);
