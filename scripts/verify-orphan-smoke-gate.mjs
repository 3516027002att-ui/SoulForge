/**
 * 孤儿 smoke 门禁。
 *
 * 补上 `verify.mjs --audit` 结构性看不见的盲区：audit 检查「每条 npm script
 * 是否登记了层级」，因此它只能发现「有 script 但没层级」，看不见「有 smoke
 * 文件但没有任何 script 引用它」——那种文件既不在 audit 视野内，也永远不会被
 * 任何验证入口执行。
 *
 * 本轮实测到 5 个这样的文件，合计 3869 行，其中 runEditorBoundedAccessSmoke.ts
 * 是 W-REL-F-SCALE-02 的有界访问验证，还被 editorCapabilityContract.ts 的注释
 * 引用为「两侧共用同一套规则」的依据。写了、被引用了、但从未运行过。
 *
 * 扫描范围同时含 `scripts/verify-*.mjs`：那一类是 --audit 结构上的盲区——
 * audit 只检查「已存在的 npm script 是否登记层级」，看不见「有门禁脚本但没入口」。
 *
 * 判定规则：`packages/core/src/testing/run*Smoke.ts` 必须能在任一 workspace 的
 * package.json scripts 里找到对应的编译产物路径（dist/testing/<name>.js）。
 * 只允许通过显式白名单排除，且必须写明理由——理由缺失即失败。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const TESTING_DIR = join(repoRoot, 'packages', 'core', 'src', 'testing');
const PACKAGE_FILES = Object.freeze([
  'package.json',
  'packages/core/package.json',
  'packages/shared/package.json',
  'apps/desktop/package.json'
]);

/**
 * 显式排除：文件名 -> 理由。空理由或未列入即视为孤儿。
 * 这里刻意不做「按前缀批量豁免」：批量豁免会让新增孤儿自动隐身。
 */
const EXCLUDED = Object.freeze({
  // 下面这些是由对应 SF 任务入口 import 并实际执行的共享模块；为它们
  // 再造一层 npm script 只会把同一断言重复跑一遍。这里逐项列名，避免
  // 新增模块被「前缀批量豁免」隐藏。
  'runAuditBlenderJobSmoke.ts': '由 runAuditSf26Smoke.ts import 并执行 Blender 进程控制断言。',
  'runAuditKnowledgeInvalidationSmoke.ts': '由 runAuditSf23Smoke.ts import 并执行知识 claim 失效闭包断言。',
  'runAuditKnowledgeStoreSmoke.ts': '由 runAuditSf23Smoke.ts import 并执行 KnowledgeStore/CAS 断言。',
  'runAuditMapSelectionSmoke.ts': '由 runAuditSf05Smoke.ts import 并按 unit/native 分支执行 Map 断言。',
  'runAuditMsbSafetyGateSmoke.ts': '由 runAuditSf01Smoke.ts import 并执行 MSB 安全门禁 native 断言。',
  'runAuditParamFinalStateSmoke.ts': '由 runAuditSf06Smoke.ts import 并按 unit/native 分支执行 PARAM 断言。',
  'runAuditRagScopeSmoke.ts': '由 runAuditSf18Smoke.ts import 并执行 RAG scope 断言。',
  'runAuditSceneRoundTripSmoke.ts': '由 runAuditSf25Smoke.ts 与 runAuditSf26Smoke.ts import 并执行场景往返断言。'
});

/** scripts/ 下的门禁脚本目录。 */
const SCRIPTS_DIR = join(repoRoot, 'scripts');

/**
 * scripts/verify-*.mjs 的显式排除：文件名 -> 理由。
 *
 * 为什么把判据扩到这里：本门禁原先只扫
 * packages/core/src/testing/run*Smoke.ts，于是 scripts/ 下「写了门禁脚本但没有
 * npm 入口」这一整类孤岛在它视野之外——而 --audit 同样看不见（audit 只检查
 * 「已存在的 npm script 是否登记层级」）。两道门禁各自都有理由不管它，
 * 结果就是没人管。
 *
 * 实测抓到 1 个：verify-corpus-manifest.mjs。它本轮刚修过一个真实缺陷
 * （语料根扫成整个游戏根，extraFiles 7849），而它从来不被任何入口调度
 * ——修好也不会有人跑到。
 *
 * A1 只有在 A0 trust root 已验证且用户显式 --resume 时才能运行；Mission1
 * corpus V2 也必须绑定本机真实语料。两者都不应被常规 verify tier 自动调度，
 * 否则会把 blocked/无语料状态误读成普通回归失败；这里保留逐项理由而不是
 * 批量豁免，让手工入口仍由审阅者显式选择。
 */
const EXCLUDED_SCRIPTS = Object.freeze({
  'verify-mission1-a1.mjs': '受 A0 trust root 与显式 --resume 约束的 Mission1 后续 runner，按需手工运行。',
  'verify-mission1-corpus-v2.mjs': '依赖本机 Mission1 语料与 manifest 的独立复核，按需手工运行。'
});

function collectScriptText() {
  const parts = [];
  for (const relative of PACKAGE_FILES) {
    const path = join(repoRoot, relative);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    parts.push(JSON.stringify(manifest.scripts ?? {}));
  }
  return parts.join('\n');
}

const scriptText = collectScriptText();
const findings = [];
const reachable = [];

for (const fileName of readdirSync(TESTING_DIR)) {
  if (!/^run.*Smoke\.ts$/.test(fileName)) continue;
  const compiled = `dist/testing/${fileName.replace(/\.ts$/, '.js')}`;
  if (scriptText.includes(compiled)) {
    reachable.push(fileName);
    continue;
  }
  const reason = EXCLUDED[fileName];
  if (typeof reason === 'string' && reason.trim().length > 0) {
    reachable.push(fileName);
    continue;
  }
  const lineCount = readFileSync(join(TESTING_DIR, fileName), 'utf8').split('\n').length;
  findings.push({
    file: `packages/core/src/testing/${fileName}`,
    lines: lineCount,
    code: 'SMOKE_UNREACHABLE',
    message: '该 smoke 没有任何 npm script 入口，永远不会被执行；请注册 script 并登记层级，或在本门禁的 EXCLUDED 中写明理由。'
  });
}

// scripts/verify-*.mjs 同样必须有 npm 入口。判据是文件名能否在任一 workspace 的
// scripts 值里出现——门禁脚本都是 `node scripts/verify-xxx.mjs` 这种直接调用形态。
const reachableScripts = [];
for (const fileName of readdirSync(SCRIPTS_DIR)) {
  if (!/^verify-.*\.mjs$/.test(fileName)) continue;
  if (scriptText.includes(fileName)) {
    reachableScripts.push(fileName);
    continue;
  }
  const reason = EXCLUDED_SCRIPTS[fileName];
  if (typeof reason === 'string' && reason.trim().length > 0) {
    reachableScripts.push(fileName);
    continue;
  }
  const lineCount = readFileSync(join(SCRIPTS_DIR, fileName), 'utf8').split('\n').length;
  findings.push({
    file: `scripts/${fileName}`,
    lines: lineCount,
    code: 'GATE_SCRIPT_UNREACHABLE',
    message: '该门禁脚本没有任何 npm script 入口，永远不会被调度执行；'
      + '请注册 script 并登记层级，或在本门禁的 EXCLUDED_SCRIPTS 中写明理由。'
      + ' 注意 --audit 看不见这一类：它只检查「已存在的 npm script 是否登记层级」。'
  });
}

// 排除表必须随接线收缩：已有入口却仍留在表里，会让它变成永久豁免清单。
for (const fileName of Object.keys(EXCLUDED_SCRIPTS)) {
  if (scriptText.includes(fileName)) {
    findings.push({
      file: `scripts/${fileName}`,
      code: 'GATE_SCRIPT_EXCLUSION_STALE',
      message: '该脚本已有 npm 入口，但仍登记在 EXCLUDED_SCRIPTS 里；请删除该条排除。'
    });
  }
}

if (findings.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    code: 'ORPHAN_SMOKE_DETECTED',
    message: '存在从未被执行的 smoke 文件。写了不跑等于没写，且会伪装成已有覆盖。',
    orphanCount: findings.length,
    orphanLines: findings.reduce((sum, item) => sum + item.lines, 0),
    findings
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  message: '全部 smoke 与门禁脚本均有 npm script 入口（无孤儿）',
  reachableSmokes: reachable.length,
  excludedSmokes: Object.keys(EXCLUDED).length,
  reachableGateScripts: reachableScripts.length,
  excludedGateScripts: Object.keys(EXCLUDED_SCRIPTS).length,
  note: '层级归属由 verify.mjs --audit 单独门禁；本门禁只保证「存在入口」这一前置条件'
}, null, 2));
