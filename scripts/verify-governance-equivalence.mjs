#!/usr/bin/env node
/**
 * 证明「JSON 治理门禁」与「markdown 治理门禁」在真实数据上产出等价结论。
 *
 * 为什么需要这个脚本：
 * 换数据源时最大的风险不是报错，而是**静默丢规则**——某条防止「用延期掩盖
 * 未完成」的检查在新实现里消失了，门禁却依然显示通过。这种技术债不会以
 * 失败的形式暴露，只会在某次错误裁定被放行时才显现。
 *
 * 所以迁移期两套门禁并行运行，本脚本逐 finding 比对：
 *   1. 规则覆盖：markdown 门禁能产出的每个 finding code，JSON 门禁也必须
 *      能产出（除了纯 markdown 形状检查——那些由 JSON Schema 承担，
 *      必须在 SCHEMA_SUPERSEDED 里显式登记并写明由哪个 schema 机制取代）；
 *   2. 真实结论：在当前真实数据上，两者的 finding code 多重集必须一致。
 *
 * 任一方向不成立就 EXIT=1。这样「迁移后门禁变松」不可能悄悄发生。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gateSubjectRegistry,
  handoffBlockSubjectRef,
  handoffSectionSubjectRef,
  parseSealBaseline,
  validateHandoffGovernance
} from './handoff-integrity-lib.mjs';
import { validateGovernanceData } from './governance/validateGovernanceData.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';

/**
 * markdown 门禁独有的 finding code，及其在 JSON 门禁下的取代机制。
 * 每一项都必须写明「由什么取代」——不允许只写「不适用」。
 */
const SCHEMA_SUPERSEDED = Object.freeze({
  EVIDENCE_INDEX_MISSING: 'evidence.jsonl 缺失 → GOVERNANCE_DATA_MISSING',
  EVIDENCE_TABLE_SCHEMA_INVALID: 'JSONL 每行由 evidence.schema.json 校验必填字段',
  BLOCKER_INDEX_MISSING: 'blockers.json 缺失 → GOVERNANCE_DATA_MISSING',
  BLOCKER_TABLE_SCHEMA_INVALID: 'blockers.schema.json required + additionalProperties:false',
  BLOCKER_ROW_SCHEMA_INVALID: 'blockers.schema.json 逐条目 required 字段',
  SLICE_TABLE_MISSING: 'slices.json 缺失 → GOVERNANCE_DATA_MISSING',
  SLICE_TABLE_SCHEMA_INVALID: 'slices.schema.json required + additionalProperties:false',
  SLICE_ROW_SCHEMA_INVALID: 'slices.schema.json 逐切片 required 字段',
  SLICE_FIELD_REQUIRED: 'slices.schema.json minLength / minItems 约束非空',
  ACTIVE_CLAIM_TABLE_MISSING: 'slices.json activeControl 数组由 schema 要求存在',
  ACTIVE_CLAIM_TABLE_SCHEMA_INVALID: 'slices.schema.json activeClaims 条目 required',
  ACTIVE_CLAIM_ROW_SCHEMA_INVALID: 'slices.schema.json activeClaims 条目 required',
  GATE_LIST_MISSING: 'gates.json 缺失 → GOVERNANCE_DATA_MISSING',
  GATE_MATRIX_MISSING: 'gates.json 缺失 → GOVERNANCE_DATA_MISSING',
  GATE_MATRIX_SCHEMA_INVALID: 'gates.schema.json required + additionalProperties:false',
  VALIDATION_SECTION_MISSING: 'validation.json 缺失 → GOVERNANCE_DATA_MISSING',
  VALIDATION_UNFROZEN_LIST_MISSING: 'validation.schema.json 要求 unfrozen 数组存在',
  HANDOFF_INPUT_INVALID: 'JSON 门禁的等价物是 GOVERNANCE_DATA_PARSE_FAIL'
});

/** 提取某个校验实现能产出的所有 finding code（静态扫源码）。 */
function codesInSource(relativePath) {
  const source = readFileSync(resolve(root, relativePath), 'utf8');
  return new Set([...source.matchAll(/makeFinding\(\s*'([A-Z0-9_]+)'/g)].map((match) => match[1]));
}

const findings = [];
const add = (code, where, message) => findings.push({ severity: 'error', code, where, message });

// ---- 方向 1：规则覆盖（静态） -------------------------------------------
const markdownCodes = codesInSource('scripts/handoff-integrity-lib.mjs');
const jsonCodes = new Set([
  ...codesInSource('scripts/governance/governanceRules.mjs'),
  ...codesInSource('scripts/governance/loadGovernance.mjs'),
  ...codesInSource('scripts/governance/freezeRules.mjs')
]);

for (const code of [...markdownCodes].sort()) {
  if (jsonCodes.has(code)) continue;
  if (code in SCHEMA_SUPERSEDED) continue;
  add(
    'RULE_LOST_IN_MIGRATION',
    'scripts/governance/governanceRules.mjs',
    `markdown 门禁能产出 ${code}，JSON 门禁不能，且未在 SCHEMA_SUPERSEDED 登记取代机制。`
      + '这正是「迁移后门禁变松」的形态，必须补齐规则或显式登记取代者。'
  );
}

for (const code of Object.keys(SCHEMA_SUPERSEDED).sort()) {
  if (!markdownCodes.has(code)) {
    add(
      'SUPERSEDED_ENTRY_STALE',
      'scripts/verify-governance-equivalence.mjs',
      `SCHEMA_SUPERSEDED 登记了 ${code}，但 markdown 门禁已不再产出它；清单已过期。`
    );
  }
  if (jsonCodes.has(code)) {
    add(
      'SUPERSEDED_ENTRY_CONTRADICTORY',
      'scripts/verify-governance-equivalence.mjs',
      `${code} 同时被登记为「已由 schema 取代」且仍由 JSON 门禁产出；口径矛盾。`
    );
  }
}

// ---- 方向 2：真实数据上的结论一致（动态） -------------------------------
const markdownResult = validateHandoffGovernance(
  readFileSync(resolve(root, HANDOFF), 'utf8'),
  { source: HANDOFF }
);
// 冻结基线比对依赖 git 且与 markdown 门禁无对应物，比对时关闭以保证同口径。
const registry = gateSubjectRegistry();
const subjectRefsByGate = new Map(registry.gates.map((gate) => [
  gate.gateId,
  [
    ...gate.files,
    ...gate.handoffSections.map(handoffSectionSubjectRef),
    ...gate.handoffBlocks.map((block) => handoffBlockSubjectRef(block.id))
  ]
]));
const jsonResult = validateGovernanceData(root, {
  parseSealBaseline,
  subjectRefsOf: (gateId) => subjectRefsByGate.get(gateId) ?? null,
  freezeBaselineRef: null
});

let dynamicComparable = true;
if (jsonResult.projection === null) {
  dynamicComparable = false;
  add(
    'JSON_GATE_UNRUNNABLE',
    'scripts/governance/validateGovernanceData.mjs',
    'JSON 门禁未能产出投影，无法做动态比对。'
      + `findings=${JSON.stringify(jsonResult.findings.map((f) => f.code))}`
  );
}

const countCodes = (list) => {
  const counts = new Map();
  for (const finding of list) {
    if (finding.severity !== 'error') continue;
    counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  }
  return counts;
};

if (dynamicComparable) {
  const markdownCounts = countCodes(markdownResult.findings);
  const jsonCounts = countCodes(jsonResult.findings);
  for (const code of new Set([...markdownCounts.keys(), ...jsonCounts.keys()])) {
    const inMarkdown = markdownCounts.get(code) ?? 0;
    const inJson = jsonCounts.get(code) ?? 0;
    if (inMarkdown !== inJson) {
      add(
        'CONCLUSION_DIVERGED',
        'docs/governance',
        `真实数据上两套门禁结论不一致：${code} markdown=${inMarkdown} json=${inJson}。`
      );
    }
  }
}

const errors = findings.filter((finding) => finding.severity === 'error');
const result = {
  ok: errors.length === 0,
  message: errors.length === 0
    ? '治理门禁迁移等价性成立（规则覆盖 + 真实数据结论一致）'
    : '治理门禁迁移等价性失败',
  checked: [
    'markdown 门禁的每个 finding code 都由 JSON 门禁产出，或在 SCHEMA_SUPERSEDED 显式登记取代机制',
    'SCHEMA_SUPERSEDED 清单不含过期项，也不含与 JSON 门禁自相矛盾的项',
    '在当前真实治理数据上，两套门禁的 error finding code 多重集一致'
  ],
  counts: {
    markdownCodes: markdownCodes.size,
    jsonCodes: jsonCodes.size,
    schemaSuperseded: Object.keys(SCHEMA_SUPERSEDED).length,
    markdownFindings: markdownResult.findings.length,
    jsonFindings: jsonResult.findings.length
  },
  findings,
  note: '本脚本只证明两套门禁结论等价；治理数据本身是否真实由工程复核负责。'
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
