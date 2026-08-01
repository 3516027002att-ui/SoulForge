/**
 * 把治理 JSON 投影成旧 markdown 解析器输出的等价形状。
 *
 * 为什么要这一层，而不是直接让规则读 JSON：
 * 语义规则有 93 个 finding code，其中约 70 个是与数据源无关的治理语义
 * （authority 不得超过 cap、blocked Gate 必须引用 blocked 切片、
 * deferred 必须成对、passed 必须有 sealed Evidence……）。这些规则一旦重写，
 * 就有静默丢规则的风险，而丢掉的正是防止「用延期掩盖未完成」的那类检查。
 *
 * 所以换数据源时保持规则函数签名不变，只替换喂给它的数据形状。
 * 投影结果与旧解析器的等价性由 scripts/verify-governance-equivalence.mjs
 * 在真实数据上逐字段证明，不靠人工比对。
 *
 * 本模块只做形状搬运，不做任何判定；任何"顺手校验一下"都属于规则，
 * 必须写在 governanceRules.mjs 里，否则规则会散落两处。
 */

/**
 * 切片投影。旧形状：
 *   { id, lifecycle, authority, blockerIds, authorityCap, declaresUnfrozenValidation }
 */
export function projectSlices(slicesData) {
  const slices = new Map();
  for (const slice of slicesData.slices) {
    if (slices.has(slice.sliceId)) continue;
    slices.set(slice.sliceId, {
      id: slice.sliceId,
      lifecycle: slice.lifecycle,
      authority: slice.authority,
      blockerIds: [...slice.blockerRefs],
      authorityCap: slice.authorityCap,
      declaresUnfrozenValidation: slice.declaresUnfrozenValidation,
      targetRelease: slice.targetRelease
    });
  }
  return slices;
}

/**
 * active claim 投影。旧形状是逐行 cells 数组，这里给出结构化等价物，
 * 规则函数据此判断，不再依赖列序。
 */
export function projectActiveClaims(slicesData) {
  return slicesData.activeClaims.map((claim) => ({
    sliceId: claim.sliceId,
    claimId: claim.claimId,
    owner: claim.owner,
    claimedAt: claim.claimedAt,
    heartbeatAt: claim.heartbeatAt,
    recoveryTrigger: claim.recoveryTrigger
  }));
}

/**
 * blocker 投影。旧形状：
 *   { id, reason, impactSliceIds, impactGateIds, evidenceIds }
 * 另外保留旧解析器不产出但规则需要的必填文本字段，用于必填性检查。
 */
export function projectBlockers(blockersData) {
  const blockers = new Map();
  for (const blocker of blockersData.blockers) {
    if (blockers.has(blocker.blockerId)) continue;
    blockers.set(blocker.blockerId, {
      id: blocker.blockerId,
      reason: blocker.reason,
      impactSliceIds: [...blocker.impactSliceRefs],
      impactGateIds: [...blocker.impactGateRefs],
      evidenceIds: [...blocker.evidenceRefs],
      owner: blocker.owner,
      requiredInput: blocker.requiredInput,
      unlockValidation: blocker.unlockValidation,
      recheckTrigger: blocker.recheckTrigger
    });
  }
  return blockers;
}

/**
 * Evidence 投影。旧形状：
 *   { id, type, claim, baseline, seal, sealValid }
 * `seal` 由 parseSealBaseline 计算，因此这里接受注入的解析函数，
 * 保证指纹校验逻辑与旧实现是同一份代码，而不是复制一份。
 */
export function projectEvidence(evidenceRecords, parseSealBaseline) {
  const evidence = new Map();
  for (const record of evidenceRecords) {
    if (evidence.has(record.evidenceId)) continue;
    const type = record.evidenceType;
    const baseline = record.fingerprint;
    const seal = type === 'sealed-current-run' ? parseSealBaseline(baseline) : null;
    evidence.set(record.evidenceId, {
      id: record.evidenceId,
      type,
      claim: record.subject,
      baseline,
      seal,
      sealValid: type === 'sealed-current-run' && seal?.valid === true,
      targetRelease: record.targetRelease
    });
  }
  return evidence;
}

/**
 * Gate 投影。旧形状：
 *   { id, gateState, applicability, sliceIds, blockerIds, evidenceIds }
 * 另外携带 successor 文本，供「非 blocked Gate 不得声称需要用户介入」检查。
 */
export function projectGates(gatesData) {
  const gates = new Map();
  for (const gate of gatesData.gates) {
    if (gates.has(gate.gateId)) continue;
    gates.set(gate.gateId, {
      id: gate.gateId,
      gateState: gate.gateState,
      applicability: gate.applicability,
      sliceIds: [...gate.sliceRefs],
      blockerIds: [...gate.blockerRefs],
      evidenceIds: [...gate.evidenceRefs],
      successor: gate.successorRequirement,
      targetRelease: gate.targetRelease
    });
  }
  return gates;
}

/** §18.1 必需 Gate 清单等价物。 */
export function projectReleaseGateIds(gatesData) {
  return [...gatesData.requiredGateIds];
}

/**
 * §13.4 未冻结验证清单等价物。
 * 旧解析器只产出 sliceId 集合；这里同样只暴露 id，reason 供报告使用。
 */
export function projectUnfrozenValidations(validationData) {
  return validationData.unfrozen.map((entry) => ({
    sliceId: entry.sliceId,
    reason: entry.reason,
    targetRelease: entry.targetRelease
  }));
}

/** §13.4 已冻结四元组等价物（位置敏感：一个切片可以有多条）。 */
export function projectFrozenValidations(validationData) {
  return validationData.frozen.map((entry) => ({ ...entry }));
}

/**
 * 一次性投影全部治理数据。
 *
 * @param {object} data loadGovernanceData 的 data
 * @param {(baseline: string) => object} parseSealBaseline 复用旧实现的封存解析
 */
export function projectGovernance(data, parseSealBaseline) {
  return {
    releases: data.releases,
    scope: data.scope,
    evidence: projectEvidence(data.evidence, parseSealBaseline),
    blockers: projectBlockers(data.blockers),
    slices: projectSlices(data.slices),
    activeClaims: projectActiveClaims(data.slices),
    gates: projectGates(data.gates),
    releaseGateIds: projectReleaseGateIds(data.gates),
    unfrozenValidations: projectUnfrozenValidations(data.validation),
    frozenValidations: projectFrozenValidations(data.validation),
    gatesData: data.gates,
    slicesData: data.slices,
    blockersData: data.blockers,
    validationData: data.validation
  };
}
