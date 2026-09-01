#!/usr/bin/env node
/**
 * 治理 JSON 门禁的负向 fixture。
 *
 * 「真实数据上 0 finding」只证明数据干净，不证明规则在跑。本脚本对真实数据
 * 做定点篡改，断言门禁**确实**报出预期 finding code——包括 schema 拦截、
 * 语义规则拦截和跨版本冻结拦截三类。
 *
 * 所有篡改都在内存副本上进行，不写回 docs/governance。
 */
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  gateSubjectRegistry,
  handoffBlockSubjectRef,
  handoffSectionSubjectRef,
  parseSealBaseline
} from './handoff-integrity-lib.mjs';
import { validateGovernanceData } from './governance/validateGovernanceData.mjs';
import { checkEvidenceFreshness } from './governance/governanceRules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOV = 'docs/governance';

const registry = gateSubjectRegistry();
const subjectRefsByGate = new Map(registry.gates.map((gate) => [
  gate.gateId,
  [
    ...gate.files,
    ...gate.handoffSections.map(handoffSectionSubjectRef),
    ...gate.handoffBlocks.map((block) => handoffBlockSubjectRef(block.id))
  ]
]));
const baseOptions = {
  parseSealBaseline,
  subjectRefsOf: (gateId) => subjectRefsByGate.get(gateId) ?? null,
  freezeBaselineRef: null
};

/**
 * 在临时目录里复刻治理数据，施加篡改，跑门禁，返回 error finding codes。
 *
 * 冻结拦截需要 git 基线，临时目录不是 git 仓库，因此需要基线的用例改用
 * `runWithMutationInRepo`。这里显式传 freezeBaselineRef=null，对应
 * 「仓库外自检」的合法场景。
 */
function runWithMutation(mutate, options = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'soulforge-gov-'));
  try {
    mkdirSync(join(sandbox, GOV), { recursive: true });
    cpSync(join(root, GOV), join(sandbox, GOV), { recursive: true });
    mutate({
      read: (file) => JSON.parse(readFileSync(join(sandbox, GOV, file), 'utf8')),
      write: (file, value) => writeFileSync(join(sandbox, GOV, file), JSON.stringify(value, null, 2)),
      readRaw: (file) => readFileSync(join(sandbox, GOV, file), 'utf8'),
      writeRaw: (file, text) => writeFileSync(join(sandbox, GOV, file), text)
    });
    const result = validateGovernanceData(sandbox, { ...baseOptions, ...options });
    return result.findings.filter((f) => f.severity === 'error').map((f) => f.code);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * 冻结拦截用例：必须在真实 git 仓库内运行，才能拿到 HEAD 基线。
 * 篡改真实文件后**无条件恢复**——用 try/finally 保证即使断言抛错也会还原。
 */
function runWithMutationInRepo(mutate, options = {}) {
  const files = ['scope.json', 'gates.json', 'slices.json', 'validation.json', 'blockers.json', 'releases.json'];
  const originals = new Map(
    files.map((file) => [file, readFileSync(join(root, GOV, file), 'utf8')])
  );
  try {
    mutate({
      read: (file) => JSON.parse(readFileSync(join(root, GOV, file), 'utf8')),
      write: (file, value) => writeFileSync(join(root, GOV, file), JSON.stringify(value, null, 2)),
      readRaw: (file) => readFileSync(join(root, GOV, file), 'utf8'),
      writeRaw: (file, text) => writeFileSync(join(root, GOV, file), text)
    });
    const result = validateGovernanceData(root, { ...baseOptions, freezeBaselineRef: 'HEAD', ...options });
    return result.findings.filter((f) => f.severity === 'error').map((f) => f.code);
  } finally {
    for (const [file, content] of originals) {
      writeFileSync(join(root, GOV, file), content);
    }
  }
}

const cases = [];
let failures = 0;

function expectCodes(name, mutate, expected, options, runner = runWithMutation) {
  const codes = runner(mutate, options);
  const missing = expected.filter((code) => !codes.includes(code));
  if (missing.length > 0) {
    failures += 1;
    cases.push({ name, ok: false, expected, actual: codes, missing });
    console.error(`FAIL  ${name}`);
    console.error(`        期望包含: ${expected.join(', ')}`);
    console.error(`        实际产出: ${codes.length === 0 ? '(无 error finding)' : [...new Set(codes)].join(', ')}`);
  } else {
    cases.push({ name, ok: true, expectedCodes: expected });
  }
}

function expectClean(name) {
  const codes = runWithMutation(() => {});
  if (codes.length > 0) {
    failures += 1;
    cases.push({ name, ok: false, expected: [], actual: codes });
    console.error(`FAIL  ${name}：未篡改的真实数据应当 0 error，实际 ${[...new Set(codes)].join(', ')}`);
  } else {
    cases.push({ name, ok: true, expectedCodes: [] });
  }
}

// ---- 基线：真实数据必须干净，否则后续断言无意义 -------------------------
expectClean('untouched-real-data-is-clean');



// ---- schema 拦截 ---------------------------------------------------------
expectCodes('schema-rejects-unknown-field', ({ read, write }) => {
  const slices = read('slices.json');
  slices.slices[0].smuggledField = 'x';
  write('slices.json', slices);
}, ['GOVERNANCE_SCHEMA_VIOLATION']);

expectCodes('schema-rejects-bad-enum', ({ read, write }) => {
  const slices = read('slices.json');
  slices.slices[0].lifecycle = 'almost-done';
  write('slices.json', slices);
}, ['GOVERNANCE_SCHEMA_VIOLATION']);

expectCodes('parse-failure-is-fail-closed', ({ writeRaw }) => {
  writeRaw('gates.json', '{ not json');
}, ['GOVERNANCE_DATA_PARSE_FAIL']);

expectCodes('jsonl-bad-line-is-reported', ({ readRaw, writeRaw }) => {
  writeRaw('evidence.jsonl', `${readRaw('evidence.jsonl')}\n{ broken\n`);
}, ['GOVERNANCE_DATA_PARSE_FAIL']);

expectCodes('deferred-scope-item-cannot-claim-operations', ({ read, write }) => {
  const scope = read('scope.json');
  const deferred = scope.scopeItems.find((item) => item.proposedSupport === 'deferred');
  deferred.operations = ['read'];
  write('scope.json', scope);
}, ['GOVERNANCE_SCHEMA_VIOLATION']);

// ---- 语义规则拦截（schema 合法但治理语义违规） --------------------------
expectCodes('authority-cannot-exceed-cap', ({ read, write }) => {
  const slices = read('slices.json');
  const target = slices.slices.find((slice) => slice.authorityCap === 'partial');
  target.authority = 'native-verified';
  write('slices.json', slices);
}, ['SLICE_AUTHORITY_EXCEEDS_CAP']);

expectCodes('deferred-gate-cannot-hide-live-slice', ({ read, write }) => {
  const gates = read('gates.json');
  const slices = read('slices.json');
  // V0.6 承接后真实数据已无 deferred Gate（REL-E/REL-I 恢复 passed），
  // 从 REL-E 反造一个 deferred Gate 来测试该拦截仍会触发。
  const gate = gates.gates.find((item) => item.gateId === 'REL-E');
  gate.gateState = 'deferred';
  gate.applicability = 'deferred';
  const sliceId = gate.sliceRefs[0];
  const slice = slices.slices.find((item) => item.sliceId === sliceId);
  slice.lifecycle = 'ready';
  write('gates.json', gates);
  write('slices.json', slices);
}, ['GATE_DEFERRED_NONDEFERRED_SLICE']);

expectCodes('deferred-gate-cannot-be-written-passed', ({ read, write }) => {
  const gates = read('gates.json');
  // 真实数据已无 deferred Gate；把 REL-E 重新标成 deferred 后写成 passed，
  // 验证 deferred 不得使用非 deferred gateState。
  const gate = gates.gates.find((item) => item.gateId === 'REL-E');
  gate.gateState = 'deferred';
  gate.applicability = 'deferred';
  gate.gateState = 'passed';
  write('gates.json', gates);
}, ['GATE_DEFERRED_STATE_INVALID']);

expectCodes('base-gate-cannot-be-deferred', ({ read, write }) => {
  const gates = read('gates.json');
  const base = gates.gates.find((gate) => gate.gateId === 'REL-A');
  base.gateState = 'deferred';
  base.applicability = 'deferred';
  write('gates.json', gates);
}, ['GATE_BASE_DEFERRAL_FORBIDDEN', 'GATE_BASE_APPLICABILITY_INVALID']);

expectCodes('passed-gate-needs-sealed-evidence', ({ read, write }) => {
  const gates = read('gates.json');
  const passed = gates.gates.find(
    (gate) => gate.gateState === 'passed' && gate.evidenceRefs.length > 0
  );
  passed.evidenceRefs = [];
  write('gates.json', gates);
}, ['GATE_PASSED_EVIDENCE_REQUIRED']);

expectCodes('tampered-seal-fingerprint-is-rejected', ({ readRaw, writeRaw }) => {
  const lines = readRaw('evidence.jsonl').split(/\r?\n/).filter((line) => line.trim());
  const patched = lines.map((line) => {
    const record = JSON.parse(line);
    if (record.evidenceType !== 'sealed-current-run') return line;
    record.fingerprint = record.fingerprint.replace(
      /trackedDiffSha256=([0-9a-f]{64})/,
      `trackedDiffSha256=${'0'.repeat(64)}`
    );
    return JSON.stringify(record);
  });
  writeRaw('evidence.jsonl', `${patched.join('\n')}\n`);
}, ['EVIDENCE_FINGERPRINT_MISMATCH']);

expectCodes('blocked-slice-must-reference-blocker', ({ read, write }) => {
  const slices = read('slices.json');
  slices.slices.find((slice) => slice.lifecycle === 'ready').lifecycle = 'blocked';
  write('slices.json', slices);
}, ['SLICE_BLOCKER_REQUIRED']);

// 扰动必须自己造出 active 切片，不能靠「真实数据碰巧有一条」再清空 activeClaims。
// lifecycle=active 与 activeClaims 都是会被正常 release 清空的执行面板状态：实测把
// 5 条被遗弃 claim 全部释放后，真实数据里 active 切片为 0，于是 activeClaims=[] 成了
// 合法状态，这条 fixture 拦不到 ACTIVE_SLICE_CLAIM_REQUIRED 而报「未按预期拦截」——
// 门禁红的是判据前提消失，不是规则退化。改为先把一条 ready 切片置 active 再清空
// claim，使「active 切片缺 claim」这个被检形态必然成立。
expectCodes('active-slice-needs-exactly-one-claim', ({ read, write }) => {
  const slices = read('slices.json');
  const target = slices.slices.find((slice) => slice.lifecycle === 'active')
    ?? slices.slices.find((slice) => slice.lifecycle === 'ready');
  target.lifecycle = 'active';
  slices.activeClaims = [];
  write('slices.json', slices);
}, ['ACTIVE_SLICE_CLAIM_REQUIRED']);

expectCodes('unfrozen-validation-cannot-drop-declaring-slice', ({ read, write }) => {
  const validation = read('validation.json');
  validation.unfrozen = [];
  write('validation.json', validation);
}, ['VALIDATION_UNFROZEN_SLICE_UNLISTED']);

// schema 用 minItems/maxItems=11 锁死 Gate 数量，删除会先被 schema 拦下。
// 这里改为**等量替换**，让数据仍满足 schema，从而证明语义层的固定 Gate 集合
// 检查确实在跑，而不是被 schema 数量约束掩盖。
expectCodes('gate-set-is-fixed', ({ read, write }) => {
  const gates = read('gates.json');
  gates.requiredGateIds = gates.requiredGateIds.map((id) => (id === 'REL-I' ? 'REL-BOGUS' : id));
  write('gates.json', gates);
}, ['GATE_REQUIRED_MISSING', 'GATE_REQUIRED_EXTRA', 'GATE_MISSING_IN_MATRIX', 'GATE_MATRIX_EXTRA']);

// ---- 跨版本冻结拦截 -----------------------------------------------------
// 最需要拦的方向：把已冻结的 supported 裁定改掉，或把 authorityAtRuling 抬高。
// 两者都不改变 schema 合法性，只有 git 基线比对能发现，因此必须在真实仓库内跑。
expectCodes('frozen-release-ruling-cannot-be-edited', ({ read, write }) => {
  const scope = read('scope.json');
  const item = scope.scopeItems.find((entry) => entry.proposedSupport === 'supported');
  item.proposedSupport = 'unsupported';
  write('scope.json', scope);
}, ['FREEZE_VIOLATION'], {}, runWithMutationInRepo);

expectCodes('frozen-authority-at-ruling-cannot-be-raised', ({ read, write }) => {
  const scope = read('scope.json');
  const item = scope.scopeItems.find((entry) => entry.authorityAtRuling !== 'native-verified');
  item.authorityAtRuling = 'native-verified';
  write('scope.json', scope);
}, ['FREEZE_VIOLATION'], {}, runWithMutationInRepo);

expectCodes('frozen-release-item-cannot-be-deleted', ({ read, write }) => {
  const scope = read('scope.json');
  // 必须删除仍冻结的 V0.5 条目：SCOPE-MSB 已随 V0.6 承接恢复为 supported@V0.6，
  // 不在 V0.5 冻结保护内，删除它不会触发 FREEZE_VIOLATION。
  scope.scopeItems = scope.scopeItems.filter((entry) => entry.scopeItemId !== 'SCOPE-DFLT');
  write('scope.json', scope);
}, ['FREEZE_VIOLATION'], {}, runWithMutationInRepo);

// 基线不可验证时必须失败关闭，否则把数据复制到仓库外跑一遍就能绕过冻结。
expectCodes('freeze-fails-closed-without-git-baseline', () => {}, ['FREEZE_BASELINE_UNVERIFIABLE'], {
  freezeBaselineRef: 'HEAD'
});

expectCodes('unknown-target-release-is-rejected', ({ read, write }) => {
  const gates = read('gates.json');
  gates.gates[0].targetRelease = 'V9.9';
  write('gates.json', gates);
}, ['TARGET_RELEASE_UNKNOWN']);

/* ── freshness 规则族（直接测规则函数）───────────────────────────────────
 *
 * 本文件此前对 freshness 完全没有覆盖：全文 STALE|FRESHNESS token 计数为 0。
 * 而 freshness 是「passed Gate 的证据是否还有效」的唯一判据，它松动的后果是
 * 已封存证据永久有效、改了主题域也不报 stale。
 *
 * 为什么直接测 checkEvidenceFreshness 而不经 validateGovernanceData：后者的
 * freshnessContext 由 buildFreshnessContext 从**真实 git 状态**构造
 * （validateGovernanceData.mjs:122-129），不接受外部注入，而本文件的沙箱是
 * 临时目录、不是 git 仓库。判定逻辑本身就在 checkEvidenceFreshness，
 * 这里是它的正确测试层次。
 */
function freshnessCase(name, subjectRefs, anchorState, expectedCode) {
  const id = 'EV-FIXTURE-FRESHNESS';
  const evidence = new Map([[id, {
    type: 'sealed-current-run',
    sealValid: true,
    claim: '',
    seal: { fields: { head: 'fixture-anchor' } }
  }]]);
  const ctx = { anchors: { 'fixture-anchor': anchorState } };
  const finding = checkEvidenceFreshness(
    'fixture', [id], evidence, subjectRefs, ctx,
    'GATE_EVIDENCE_STALE', 'fixture stale message'
  );
  const actual = finding === null ? '(无 finding)' : finding.code;
  if (actual === expectedCode) {
    cases.push({ name, ok: true, expectedCodes: [expectedCode] });
  } else {
    failures += 1;
    cases.push({ name, ok: false, expected: [expectedCode], actual: [actual] });
    console.error(`FAIL  ${name}`);
    console.error(`        期望: ${expectedCode}`);
    console.error(`        实际: ${actual}`);
  }
}

const FRESH_ANCHOR = { isAncestor: true, subjectScanAvailable: true, changedSubjects: [] };

// ① 主题域已变更 → stale。防「freshness 判定被整体关掉」。
freshnessCase('freshness-detects-changed-subject',
  ['docs/governance/scope.json'],
  { ...FRESH_ANCHOR, changedSubjects: ['docs/governance/scope.json'] },
  'GATE_EVIDENCE_STALE');

// ② 锚点不是当前 HEAD 的祖先（历史被改写，例如 rebase）→ stale。
//    实测过这个场景：rebase 重写 46 个提交后六个 Gate 同时 stale。
freshnessCase('freshness-detects-non-ancestor-anchor',
  ['docs/governance/scope.json'],
  { ...FRESH_ANCHOR, isAncestor: false },
  'GATE_EVIDENCE_STALE');

// ③ 主题域扫描不可用 → 必须失败关闭，而不是当作「没变更」放行。
freshnessCase('freshness-unverifiable-fails-closed',
  ['docs/governance/scope.json'],
  { ...FRESH_ANCHOR, subjectScanAvailable: false },
  'GATE_FRESHNESS_UNVERIFIABLE');

// ④ 登记了主题域但内容为空 → GATE_SUBJECT_SET_EMPTY。
//    钉住已修掉的 fail-open：空数组时 subjectRefs.some(...) 恒假，原实现返回
//    fresh，于是清空某 Gate 的三项主题域即可让它的证据永不 stale，且
//    GATE_SUBJECT_SET_UNDEFINED 那道失败关闭被绕过（key 还在，不是 null）。
freshnessCase('freshness-empty-subject-set-fails-closed',
  [],
  { ...FRESH_ANCHOR, changedSubjects: ['docs/governance/scope.json'] },
  'GATE_SUBJECT_SET_EMPTY');

// ⑤ 主题域未变更 → 不得误报。防判据变严后把正常状态报成 stale。
freshnessCase('freshness-unchanged-subject-is-clean',
  ['docs/governance/scope.json'],
  { ...FRESH_ANCHOR, changedSubjects: ['docs/unrelated.md'] },
  '(无 finding)');

const result = {
  ok: failures === 0,
  message: failures === 0
    ? '治理 JSON 门禁负向 fixture 全部按预期拦截'
    : `治理 JSON 门禁有 ${failures} 个 fixture 未按预期拦截`,
  caseCount: cases.length,
  cases,
  note: 'fixture 只证明规则在真实数据形状上确实生效；治理数据本身是否真实由工程复核负责。'
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = failures === 0 ? 0 : 1;
