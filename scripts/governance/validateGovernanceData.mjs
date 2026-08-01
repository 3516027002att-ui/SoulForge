/**
 * 基于 docs/governance/*.json 的治理校验入口。
 *
 * 与旧 markdown 门禁的关系：规则是同一份（governanceRules.mjs），
 * 只是数据来自 JSON。等价性由 scripts/verify-governance-equivalence.mjs
 * 在真实数据上逐 finding 证明。
 */
import { loadGovernanceData } from './loadGovernance.mjs';
import { projectGovernance } from './projectGovernance.mjs';
import {
  checkEvidenceFreshness,
  validateActiveClaims,
  validateBlockerImpactClosure,
  validateBlockers,
  validateEvidence,
  validateGateMatrix,
  validateReleaseGateIds,
  validateSlices,
  validateUnfrozenValidations
} from './governanceRules.mjs';
import { validateCrossVersionFreeze } from './freezeRules.mjs';
import { buildFreshnessContext, collectSealAnchorsFromRecords } from './freshnessContext.mjs';

/**
 * 收集治理数据内部所有 EV- 与 BLK- 引用，用于「引用了未定义 ID」检查。
 * markdown 版本扫全文；JSON 版本扫全部引用字段，语义等价且更精确。
 */
function collectReferences(data, prefix) {
  const found = new Set();
  const pattern = new RegExp(`^${prefix}-[A-Z0-9-]+$`);
  const walk = (node) => {
    if (typeof node === 'string') {
      if (pattern.test(node)) found.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(data.gates);
  walk(data.slices);
  walk(data.blockers);
  walk(data.scope);
  walk(data.validation);
  return [...found];
}

/**
 * 切片自由文本：供「ready/active 切片不得声称需要用户介入」检查。
 * 对应 markdown 版本的第 4-8 列（目标能力、可独立验收、硬前置、入口、
 * requiredValidation）。字段集必须与 markdown 版本覆盖同样的语义内容，
 * 否则同一份数据在两个数据源下会得到不同结论。
 */
function sliceFreeText(slicesData) {
  const byId = new Map(slicesData.slices.map((slice) => [slice.sliceId, slice]));
  return (slice) => {
    const source = byId.get(slice.id);
    if (!source) return '';
    return [
      source.goal,
      source.hardPrerequisites,
      (source.entryPoints ?? []).join(' '),
      source.requiredValidation,
      source.authorityCapNote
    ].filter(Boolean).join(' ');
  };
}

/**
 * @param {string} root 仓库根绝对路径。
 * @param {object} options
 * @param {Function} options.parseSealBaseline 封存指纹校验（唯一实现，必须注入）。
 * @param {(gateId: string) => string[]|null} options.subjectRefsOf freshness 主题域。
 * @param {string|null} [options.handoffMarkdown] 主题内容源。给出则启用 freshness
 *   判定，锚点直接取自本次加载的 JSON 证据记录——不能由调用方另传锚点，否则
 *   「锚点集合」与「被判定的证据集合」可能来自不同数据源，新封存证据会永远
 *   落在上下文之外并被判成 unverifiable。缺省为纯静态子集模式（跳过 freshness）。
 * @param {string|null} [options.freezeBaselineRef] 冻结基线 ref。
 * @returns {{ ok: boolean, findings: Array<object>, projection: object|null }}
 */
export function validateGovernanceData(root, options = {}) {
  const { data, findings } = loadGovernanceData(root);
  if (data === null) {
    return { ok: false, findings, projection: null };
  }

  const parseSealBaseline = options.parseSealBaseline;
  if (typeof parseSealBaseline !== 'function') {
    findings.push({
      severity: 'error',
      code: 'GOVERNANCE_SEAL_PARSER_MISSING',
      where: 'scripts/governance/validateGovernanceData.mjs',
      message: '必须注入 parseSealBaseline，禁止复制第二份封存指纹校验实现。'
    });
    return { ok: false, findings, projection: null };
  }

  const projection = projectGovernance(data, parseSealBaseline);
  // 主题域注册表是治理数据的一部分，不能缺省成「没有登记」——那会让每个
  // passed Gate 都误报 GATE_SUBJECT_SET_UNDEFINED。调用方必须显式提供。
  if (typeof options.subjectRefsOf !== 'function') {
    findings.push({
      severity: 'error',
      code: 'GOVERNANCE_SUBJECT_REGISTRY_MISSING',
      where: 'scripts/governance/validateGovernanceData.mjs',
      message: '必须注入 subjectRefsOf（Gate freshness 主题域注册表）；缺省为空会让 passed Gate 误报未登记主题域。'
    });
    return { ok: false, findings, projection: null };
  }
  const subjectRefsOf = options.subjectRefsOf;
  // freshness 上下文可缺省（纯静态子集模式）；此时判定函数返回 null，
  // 与 markdown 门禁在 freshnessContext===undefined 下的行为一致。
  const handoffMarkdown = options.handoffMarkdown ?? null;
  const freshnessContext = handoffMarkdown === null
    ? undefined
    : buildFreshnessContext({
      root,
      handoffMarkdown,
      anchors: collectSealAnchorsFromRecords(projection.evidence)
    });
  const checkFreshness = (where, evidenceIds, evidence, subjectRefs, staleCode, staleMessage) =>
    checkEvidenceFreshness(
      where, evidenceIds, evidence, subjectRefs, freshnessContext, staleCode, staleMessage
    );

  const evidenceWhere = 'docs/governance/evidence.jsonl';
  validateEvidence(
    projection.evidence,
    data.evidence.map((record) => record.evidenceId),
    collectReferences(data, 'EV'),
    evidenceWhere,
    findings
  );

  validateBlockers(
    projection.blockers,
    data.blockers.blockers.map((blocker) => blocker.blockerId),
    collectReferences(data, 'BLK'),
    projection.evidence,
    'docs/governance/blockers.json',
    findings
  );

  validateSlices(
    projection.slices,
    data.slices.slices.map((slice) => slice.sliceId),
    projection.blockers,
    'docs/governance/slices.json',
    findings,
    sliceFreeText(data.slices)
  );

  validateActiveClaims(
    projection.activeClaims,
    projection.slices,
    'docs/governance/slices.json activeClaims',
    findings
  );

  validateUnfrozenValidations(
    projection.unfrozenValidations.map((entry) => entry.sliceId),
    projection.slices,
    'docs/governance/validation.json',
    findings
  );

  validateReleaseGateIds(projection.releaseGateIds, 'docs/governance/gates.json', findings);

  const gateRows = data.gates.gates.map((gate) => projection.gates.get(gate.gateId));
  validateGateMatrix(
    gateRows,
    projection.releaseGateIds,
    projection.slices,
    projection.blockers,
    projection.evidence,
    'docs/governance/gates.json',
    findings,
    subjectRefsOf,
    checkFreshness
  );

  validateBlockerImpactClosure(
    projection.blockers,
    projection.slices,
    projection.gates,
    'docs/governance/blockers.json',
    findings
  );

  validateCrossVersionFreeze(data, findings, {
    root,
    baselineRef: options.freezeBaselineRef
  });

  const errors = findings.filter((finding) => finding.severity === 'error');
  return { ok: errors.length === 0, findings, projection };
}
