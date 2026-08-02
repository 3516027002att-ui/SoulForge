#!/usr/bin/env node
/**
 * SoulForge 统一验证入口。
 *
 * 解决的问题：仓库有 117 条 npm script。agent 面对「该跑哪些」「跑完到底
 * 验证了什么」两个问题时只能靠命名猜测，而 19 个 smoke 在缺少本机资源时
 * 输出 ok:true + exit 0 的结构化跳过——退出码无法区分「通过」和「什么都
 * 没跑」。于是绿色不代表被验证过，agent 会把未验证的东西当成已验证推进。
 *
 * 本入口提供：
 * - 分层执行（governance/unit/synthetic/native/release），先快后慢；
 * - 四态结果（passed/skipped/partial/failed）+ 机器可读 JSON 摘要；
 * - 默认经 with-local-has-game-env wrapper，本机有资源就真跑，无需记命令；
 * - --require-executed：把 skipped/partial 当失败，用于「必须真跑过」的场合；
 * - --audit：核对每条 script 都已登记层级或写明排除理由，失败关闭。
 *
 * 用法：
 *   node scripts/verify.mjs                     默认跑 governance+unit
 *   node scripts/verify.mjs --tier all          全部层级
 *   node scripts/verify.mjs --tier native       只跑真实资源层
 *   node scripts/verify.mjs --filter emevd      只跑名字含 emevd 的
 *   node scripts/verify.mjs --require-executed  跳过即失败
 *   node scripts/verify.mjs --audit             只做登记审计
 *   node scripts/verify.mjs --list              只列出计划，不执行
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyScript, loadWorkspaces } from './verify/scriptGraph.mjs';
import { EXCLUDED, TIER_BY_SCRIPT, TIER_ORDER } from './verify/tiers.mjs';
import { OUTCOME, runSuite } from './verify/runner.mjs';

const DEFAULT_TIERS = ['governance', 'unit'];
const DEFAULT_TIMEOUT_MS = 900_000;

function parseArgs(argv) {
  const options = {
    tiers: DEFAULT_TIERS,
    filter: null,
    requireExecuted: false,
    audit: false,
    list: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    jsonOut: null,
    bail: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[index + 1];
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
  const unknownTiers = options.tiers.filter((tier) => !TIER_ORDER.includes(tier));
  if (unknownTiers.length > 0) {
    return { error: `未知层级：${unknownTiers.join(', ')}（可选 ${TIER_ORDER.join('/')}/all）` };
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return { error: '--timeout-ms 必须是正整数毫秒。' };
  }
  return { options };
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
for (const tier of TIER_ORDER) {
  if (!options.tiers.includes(tier)) continue;
  const names = Object.keys(TIER_BY_SCRIPT)
    .filter((name) => TIER_BY_SCRIPT[name] === tier)
    .filter((name) => (options.filter ? name.includes(options.filter) : true))
    .sort();
  for (const name of names) {
    const classification = classifyScript(repoRoot, workspaces, name);
    plan.push({ scriptName: name, tier, requirements: classification.requirements });
  }
}

if (options.list) {
  console.log(JSON.stringify({
    ok: true,
    mode: 'list',
    tiers: options.tiers,
    filter: options.filter,
    suiteCount: plan.length,
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
let bailed = false;
for (const entry of plan) {
  if (bailed) {
    results.push({ ...entry, outcome: OUTCOME.NOT_ATTEMPTED, durationMs: 0, skippedLegs: [] });
    continue;
  }
  const result = await runSuite({
    repoRoot,
    scriptName: entry.scriptName,
    timeoutMs: options.timeoutMs
  });
  const treatedAsFailure = result.outcome === OUTCOME.FAILED
    || (options.requireExecuted
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

const summary = {
  ok,
  mode: 'run',
  message: ok
    ? `${counts.passed} 条套件真实执行并通过`
      + (counts.skipped > 0 || counts.partial > 0
        ? `；${counts.skipped} 条整体跳过、${counts.partial} 条部分跳过（缺本机资源，不构成 native 完成声明）`
        : '')
    : `${failures.length} 条套件失败`,
  tiers: options.tiers,
  filter: options.filter,
  requireExecuted: options.requireExecuted,
  counts,
  // 明确回答「这次到底验证了什么」：只有 passed 是真正执行且通过的。
  executedAndPassed: results.filter((r) => r.outcome === OUTCOME.PASSED).map((r) => r.scriptName),
  skippedEntirely: results.filter((r) => r.outcome === OUTCOME.SKIPPED).map((r) => r.scriptName),
  partiallySkipped: results
    .filter((r) => r.outcome === OUTCOME.PARTIAL)
    .map((r) => ({ scriptName: r.scriptName, skippedLegs: r.skippedLegs })),
  failed: failures.map((r) => r.scriptName),
  results
};

if (options.jsonOut) {
  writeFileSync(resolve(repoRoot, options.jsonOut), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(summary, null, 2));
process.exit(ok ? 0 : 1);
