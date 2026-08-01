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
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  collectSealAnchors,
  extractHandoffMarkedSubject,
  extractHandoffSectionSubject,
  gateSubjectRegistry,
  handoffBlockSubjectRef,
  handoffSectionSubjectRef,
  parseSealBaseline
} from './handoff-integrity-lib.mjs';
import { checkEvidenceFreshness } from './governance/governanceRules.mjs';
import { validateGovernanceData } from './governance/validateGovernanceData.mjs';

const root = process.cwd();
const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';

function runGit(args) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
}

const normalize = (value) => value?.replaceAll('\r\n', '\n') ?? null;

/**
 * 构建 freshness 上下文。主题域由 gateSubjectRegistry 登记，其中既有仓库文件
 * 也有 handoff 的章节/标记块——后者仍需读 markdown，因为封存证据锚定的就是
 * 那些块的内容。这不是「门禁还在解析 markdown 判状态」：状态来自 JSON，
 * markdown 只作为被哈希的主题内容。
 */
function buildFreshnessContext(markdown) {
  const registry = gateSubjectRegistry();
  const anchors = {};
  const currentSections = new Map(registry.allHandoffSections.map((sectionId) => [
    sectionId,
    normalize(extractHandoffSectionSubject(markdown, sectionId))
  ]));
  const currentBlocks = new Map(registry.allHandoffBlocks.map((block) => [
    block.id,
    normalize(extractHandoffMarkedSubject(markdown, block.beginMarker, block.endMarker))
  ]));

  for (const anchor of collectSealAnchors(markdown)) {
    const ancestor = runGit(['merge-base', '--is-ancestor', anchor, 'HEAD']);
    if (ancestor.status === 1) {
      anchors[anchor] = { isAncestor: false, subjectScanAvailable: true, changedSubjects: [] };
      continue;
    }
    if (ancestor.status !== 0) {
      anchors[anchor] = { isAncestor: false, subjectScanAvailable: false, changedSubjects: [] };
      continue;
    }

    const changedSubjects = new Set();
    let subjectScanAvailable = true;
    if (registry.allFiles.length > 0) {
      const diff = runGit([
        'diff', '--name-only', '--no-ext-diff', '--no-textconv', '--no-renames',
        anchor, '--', ...registry.allFiles
      ]);
      if (diff.status !== 0) {
        subjectScanAvailable = false;
      } else {
        for (const path of diff.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)) {
          changedSubjects.add(path.replaceAll('\\', '/'));
        }
      }
    }

    if (registry.allHandoffSections.length > 0 || registry.allHandoffBlocks.length > 0) {
      const historical = runGit(['show', `${anchor}:${HANDOFF}`]);
      if (historical.status !== 0) {
        subjectScanAvailable = false;
      } else {
        for (const sectionId of registry.allHandoffSections) {
          const before = normalize(extractHandoffSectionSubject(historical.stdout, sectionId));
          const after = currentSections.get(sectionId);
          if (before === null || after === null) subjectScanAvailable = false;
          else if (before !== after) changedSubjects.add(handoffSectionSubjectRef(sectionId));
        }
        for (const block of registry.allHandoffBlocks) {
          const before = normalize(
            extractHandoffMarkedSubject(historical.stdout, block.beginMarker, block.endMarker)
          );
          const after = currentBlocks.get(block.id);
          if (before === null || after === null) subjectScanAvailable = false;
          else if (before !== after) changedSubjects.add(handoffBlockSubjectRef(block.id));
        }
      }
    }

    anchors[anchor] = {
      isAncestor: true,
      subjectScanAvailable,
      changedSubjects: [...changedSubjects].sort()
    };
  }
  return { anchors };
}

const handoffPath = join(root, HANDOFF);
const findings = [];
let freshnessContext;
if (existsSync(handoffPath)) {
  freshnessContext = buildFreshnessContext(readFileSync(handoffPath, 'utf8'));
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
  checkFreshness: (where, evidenceIds, evidence, subjectRefs, staleCode, staleMessage) =>
    checkEvidenceFreshness(
      where,
      evidenceIds,
      evidence,
      subjectRefs,
      freshnessContext,
      staleCode,
      staleMessage
    ),
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
