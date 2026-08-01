#!/usr/bin/env node
/**
 * 治理门禁（JSON 数据权威）。
 *
 * 与 verify-handoff-integrity.mjs 的分工：
 * - 本脚本以 docs/governance/*.json 为权威，做 schema + 治理语义 + 跨版本冻结校验；
 * - verify-handoff-integrity.mjs 在迁移期继续校验 handoff markdown，充当回归网，
 *   并负责 README/执行手册链接、npm script 存在性和敏感内容扫描；
 * - verify-governance-equivalence.mjs 证明两者结论等价，防止迁移后门禁变松。
 *
 * freshness 判定需要 git 上下文（Evidence 锚点祖先关系 + 主题域差异），
 * 与 markdown 门禁共用同一份上下文构建逻辑和同一份判定实现。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  gateSubjectRegistry,
  handoffBlockSubjectRef,
  handoffSectionSubjectRef,
  parseSealBaseline
} from './handoff-integrity-lib.mjs';
import { validateGovernanceData } from './governance/validateGovernanceData.mjs';

const root = process.cwd();
const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';

/**
 * 主题内容源。主题域由 gateSubjectRegistry 登记，其中既有仓库文件也有 handoff
 * 的章节/标记块——后者需读 markdown，因为封存证据锚定的就是那些块的内容。
 * 这不是「门禁还在解析 markdown 判状态」：状态与锚点都来自 JSON，markdown 只
 * 作为被哈希的主题内容。
 */
const handoffPath = join(root, HANDOFF);
const findings = [];
let handoffMarkdown = null;
if (existsSync(handoffPath)) {
  handoffMarkdown = readFileSync(handoffPath, 'utf8');
} else {
  findings.push({
    severity: 'error',
    code: 'FRESHNESS_SUBJECT_SOURCE_MISSING',
    where: HANDOFF,
    message: '主题域包含 handoff 标记块，交接书缺失导致无法计算 Evidence freshness；失败关闭。'
  });
}

const registry = gateSubjectRegistry();
const subjectRefsByGate = new Map(registry.gates.map((gate) => [
  gate.gateId,
  [
    ...gate.files,
    ...gate.handoffSections.map(handoffSectionSubjectRef),
    ...gate.handoffBlocks.map((block) => handoffBlockSubjectRef(block.id))
  ]
]));

const result = validateGovernanceData(root, {
  parseSealBaseline,
  subjectRefsOf: (gateId) => subjectRefsByGate.get(gateId) ?? null,
  handoffMarkdown,
  freezeBaselineRef: 'HEAD'
});

findings.push(...result.findings);
const errors = findings.filter((finding) => finding.severity === 'error');

console.log(JSON.stringify({
  ok: errors.length === 0,
  message: errors.length === 0 ? '治理门禁通过（JSON 数据权威）' : '治理门禁失败',
  authority: 'docs/governance/*.json',
  checkedRules: [
    '全部治理 JSON 满足对应 draft-07 schema（additionalProperties:false，枚举与 ID 模式严格）',
    'evidence.jsonl 逐行满足 schema；单行坏数据逐条报出而不静默丢弃',
    '切片 lifecycle / authority / cap / blockerRefs 闭合，authority 不得超过 cap',
    'active claim 与 lifecycle=active 切片一一对应，claimId 唯一，心跳时间合法',
    '未冻结验证清单与切片自声明双向收敛',
    '固定 11 Gate 集合，gateState / applicability 成对约束，deferred 不得掩盖非 deferred 切片',
    'passed / deferred / scope-excluded Gate 必须引用有效 sealed Evidence 及对应用户批准标记',
    'Evidence 封存指纹可重算；passed Gate freshness 按登记主题域判定',
    'blocker 八字段完整，与 Gate/切片双向闭合',
    '每条治理记录的 targetRelease 已在 releases.json 登记',
    'frozen=true 版本的裁定字段与 git 基线一致；基线不可验证时失败关闭'
  ],
  engineeringReviewStillRequired: [
    'Evidence 的命令、样本、结论与用户批准是否真实，而不只是结构合法',
    '切片 capability、production 调用链与 authority 上限是否与当前实现语义一致'
  ],
  reviewOwner: 'engineering-agent',
  userActionRequired: false,
  findings,
  note: '通过只表示列出的确定性检查成立；剩余语义复核由工程方负责，不构成用户介入项。'
}, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
