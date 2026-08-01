/**
 * 治理语义规则——唯一一份。
 *
 * 本模块只消费**记录**（named fields），不认识 markdown 表格也不认识 JSON 文件。
 * 两个数据源各自把自己解析成同一种记录后喂进来：
 *   - docs/governance/*.json  → scripts/governance/projectGovernance.mjs
 *   - handoff markdown（迁移期回归网）→ scripts/handoff-integrity-lib.mjs
 *
 * 这样换数据源不需要重写规则。规则如果有两份，防止「用延期掩盖未完成」
 * 这类检查就会在某一份里悄悄消失，而门禁仍然显示通过。
 *
 * 记录形状（两个数据源都必须满足）：
 *   evidence: { id, type, claim, baseline, seal, sealValid }
 *   blocker:  { id, reason, impactSliceIds, impactGateIds, evidenceIds,
 *               owner, requiredInput, unlockValidation, recheckTrigger }
 *   slice:    { id, lifecycle, authority, blockerIds, authorityCap,
 *               declaresUnfrozenValidation, freeText }
 *   claim:    { sliceId, claimId, owner, claimedAt, heartbeatAt, recoveryTrigger }
 *   gate:     { id, gateState, applicability, sliceIds, blockerIds,
 *               evidenceIds, successor }
 */

export const ALLOWED_SLICE_LIFECYCLES = new Set([
  'ready',
  'active',
  'completed',
  'blocked',
  'superseded',
  // `deferred` = 已裁定移出本里程碑、在后续里程碑交付。
  // 对当前里程碑是终态（不可认领、不得留在 validation-unfrozen），
  // 但与 `completed` 严格区分：不表示达到验收边界。
  'deferred'
]);

/** 对当前里程碑而言不可继续认领的切片 lifecycle。 */
export const TERMINAL_SLICE_LIFECYCLES = new Set(['completed', 'superseded', 'deferred']);

export const ALLOWED_AUTHORITIES = new Set([
  'unsupported',
  'candidate',
  'fixture-confirmed',
  'partial',
  'native-verified',
  'unverified'
]);

export const ALLOWED_GATE_STATES = new Set(['open', 'blocked', 'passed', 'deferred']);
export const ALLOWED_APPLICABILITY = new Set([
  'pending-scope',
  'in-scope',
  'scope-excluded',
  'deferred-v0.6'
]);
/**
 * `deferred` 与 `scope-excluded` 必须严格区分：
 * - `scope-excluded` = 已裁定永久不属于本产品范围，强制 gateState=passed；
 * - `deferred` = 已裁定移出本里程碑、仍将在后续里程碑交付，禁止写成 passed。
 * 两者都需要 sealed + 用户批准 Evidence，都不得用于基础 Gate。
 * `deferred` 不计入本里程碑完成，也不阻止本里程碑完成。
 */
export const DEFERRED_APPLICABILITY = 'deferred-v0.6';
export const DEFERRED_TARGET_RELEASE = 'V0.6';
export const ALLOWED_BLOCKER_REASONS = new Set([
  'private-corpus',
  'credential',
  'hardware',
  'user-ruling',
  'toolchain',
  'license',
  'upstream',
  'prerequisite-authority'
]);
export const ALLOWED_EVIDENCE_TYPES = new Set([
  'sealed-current-run',
  'unsealed-record',
  'historical-record'
]);
export const NON_EXCLUDABLE_GATES = new Set(['REL-SCOPE', 'REL-A', 'REL-H', 'REL-COMPLIANCE']);
export const REQUIRED_GATE_IDS = Object.freeze([
  'REL-SCOPE',
  'REL-A',
  'REL-B',
  'REL-C',
  'REL-D',
  'REL-E',
  'REL-F',
  'REL-G',
  'REL-H',
  'REL-I',
  'REL-COMPLIANCE'
]);
export const LEGACY_GATE_STATES = new Set(['covered-open', 'uncovered']);
export const USER_ACTION_WITHOUT_BLOCKER_PATTERN = /(?:需(?:要)?|等待|留给|交由)用户.{0,48}(?:裁定|授权|提供|介入|处理|输入)|用户(?:需(?:要)?|必须|应当).{0,48}(?:裁定|授权|提供|介入|处理|输入)/u;
export const AUTHORITY_RANK = new Map([
  ['unsupported', 0],
  ['unverified', 0],
  ['candidate', 1],
  ['fixture-confirmed', 1],
  ['partial', 2],
  ['native-verified', 3]
]);

export function makeFinding(code, where, message) {
  return { severity: 'error', code, where, message };
}

export function hasMeaningfulValue(value) {
  const text = (value ?? '').toString().trim();
  return text !== '' && text !== '—' && text !== '-';
}

export function asksForUserActionWithoutBlocker(value) {
  return USER_ACTION_WITHOUT_BLOCKER_PATTERN.test((value ?? '').toString());
}

export function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

export function evidenceIsSealed(evidence, id) {
  const record = evidence.get(id);
  return record?.type === 'sealed-current-run' && record.sealValid;
}

export function evidenceHasClaim(evidence, id, marker) {
  const record = evidence.get(id);
  return evidenceIsSealed(evidence, id) && record.claim.includes(marker);
}

/**
 * 评估单条 Evidence 对一组主题域引用的新鲜度。
 *
 * @returns {'fresh'|'stale'|'unverifiable'|'not-sealed'|'static-mode'}
 * - static-mode：未提供 freshnessContext（纯静态子集模式，跳过运行期判定）；
 * - fresh：锚点是当前 HEAD 祖先且主题域自锚点以来未变更；
 * - stale：锚点不是祖先（历史被改写）或主题域已变更；
 * - unverifiable：上下文缺少该锚点的祖先/差异信息，失败关闭。
 */
export function evaluateEvidenceFreshness(evidence, id, subjectRefs, freshnessContext) {
  if (freshnessContext === undefined) return 'static-mode';
  if (!evidenceIsSealed(evidence, id)) return 'not-sealed';
  const anchor = evidence.get(id).seal.fields.head;
  const anchorState = freshnessContext.anchors?.[anchor];
  if (!anchorState || anchorState.subjectScanAvailable === false) return 'unverifiable';
  if (anchorState.isAncestor !== true) return 'stale';
  const changed = new Set(anchorState.changedSubjects ?? []);
  return subjectRefs.some((ref) => changed.has(ref)) ? 'stale' : 'fresh';
}

/**
 * freshness 判定。两个数据源共用同一份实现，避免「某个数据源下 stale
 * Evidence 被放行」这种只在一侧出现的松动。
 */
export function checkEvidenceFreshness(
  where,
  evidenceIds,
  evidence,
  subjectRefs,
  freshnessContext,
  staleCode,
  staleMessage
) {
  if (freshnessContext === undefined) return null;
  if (evidenceIds.length === 0) return null;
  let sawUnverifiable = false;
  for (const id of evidenceIds) {
    const status = evaluateEvidenceFreshness(evidence, id, subjectRefs, freshnessContext);
    if (status === 'fresh' || status === 'static-mode') return null;
    if (status === 'unverifiable') sawUnverifiable = true;
  }
  if (sawUnverifiable) {
    return makeFinding(
      'GATE_FRESHNESS_UNVERIFIABLE',
      where,
      'passed Gate 的 sealed Evidence 锚点祖先关系或主题域差异无法验证，失败关闭。'
    );
  }
  return makeFinding(staleCode, where, staleMessage);
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * @param {Map<string, object>} evidence 已解析的 Evidence 记录。
 * @param {string[]} definitionOrder 定义顺序（用于重复检测，含重复项）。
 * @param {string[]} referencedIds 全文出现的所有 EV-* 引用。
 */
export function validateEvidence(evidence, definitionOrder, referencedIds, where, findings) {
  for (const record of evidence.values()) {
    const location = `${where} ${record.id}`;
    if (!ALLOWED_EVIDENCE_TYPES.has(record.type)) {
      findings.push(makeFinding(
        'EVIDENCE_TYPE_INVALID',
        location,
        `Evidence 类型非法：${record.type || '(空)'}`
      ));
    }
    if (record.type === 'sealed-current-run' && record.seal?.formatValid !== true) {
      findings.push(makeFinding(
        'EVIDENCE_SEAL_INVALID',
        location,
        'sealed-current-run 的基线必须包含有效 HEAD（40/64 hex）及四个 64 hex SHA-256 指纹字段。'
      ));
    } else if (record.type === 'sealed-current-run' && record.seal.fingerprintValid !== true) {
      findings.push(makeFinding(
        'EVIDENCE_FINGERPRINT_MISMATCH',
        location,
        `fingerprintSha256 与四字段 canonical payload 不一致；期望 ${record.seal.expectedFingerprint}。`
      ));
    }
  }

  for (const [id, count] of countBy(definitionOrder)) {
    if (count > 1) {
      findings.push(makeFinding('EVIDENCE_ID_DUPLICATE', where, `Evidence ID 重复定义 ${count} 次：${id}`));
    }
  }
  if (definitionOrder.length === 0) {
    findings.push(makeFinding('EVIDENCE_INDEX_EMPTY', where, 'Evidence 索引没有定义任何 EV-*。'));
  }
  for (const id of referencedIds) {
    if (!evidence.has(id)) {
      findings.push(makeFinding('EVIDENCE_ID_UNDEFINED', where, `引用了未定义的 Evidence：${id}`));
    }
  }
}

// ---------------------------------------------------------------------------
// Blocker
// ---------------------------------------------------------------------------

export function validateBlockers(blockers, definitionOrder, referencedIds, evidence, where, findings) {
  for (const blocker of blockers.values()) {
    const location = `${where} ${blocker.id}`;
    if (!ALLOWED_BLOCKER_REASONS.has(blocker.reason)) {
      findings.push(makeFinding(
        'BLOCKER_REASON_INVALID',
        location,
        `blocker reason 非法：${blocker.reason || '(空)'}`
      ));
    }
    if (blocker.impactSliceIds.length === 0 && blocker.impactGateIds.length === 0) {
      findings.push(makeFinding(
        'BLOCKER_IMPACT_REQUIRED',
        location,
        'blocker 必须在影响 Gate/切片列引用至少一个已定义的 REL-* 或 W-*。'
      ));
    }
    for (const [field, label] of [
      ['owner', '责任方'],
      ['requiredInput', '所需输入'],
      ['unlockValidation', '解锁验证'],
      ['recheckTrigger', '复查触发器']
    ]) {
      if (!hasMeaningfulValue(blocker[field])) {
        findings.push(makeFinding(
          'BLOCKER_FIELD_REQUIRED',
          location,
          `blocker 的${label}不能为空或使用占位符。`
        ));
      }
    }
    for (const evidenceId of blocker.evidenceIds) {
      if (!evidence.has(evidenceId)) {
        findings.push(makeFinding(
          'BLOCKER_EVIDENCE_UNDEFINED',
          location,
          `blocker 引用了未定义 Evidence：${evidenceId}`
        ));
      }
    }
  }

  for (const [id, count] of countBy(definitionOrder)) {
    if (count > 1) {
      findings.push(makeFinding('BLOCKER_ID_DUPLICATE', where, `Blocker ID 重复定义 ${count} 次：${id}`));
    }
  }
  for (const id of referencedIds) {
    if (!blockers.has(id)) {
      findings.push(makeFinding('BLOCKER_REF_UNDEFINED', where, `引用了未定义的 blocker：${id}`));
    }
  }
}

// ---------------------------------------------------------------------------
// 切片
// ---------------------------------------------------------------------------

/**
 * @param {string[]} definitionOrder 定义顺序（含重复项，用于重复检测）。
 * @param {(slice: object) => string} freeTextOf 取该切片的自由文本（目标能力、
 *   硬前置、入口、requiredValidation、cap 说明的拼接），供「不得声称需要用户
 *   介入」检查。两个数据源各自提供，规则不关心它从哪些列/字段拼来。
 */
export function validateSlices(slices, definitionOrder, blockers, where, findings, freeTextOf) {
  for (const slice of slices.values()) {
    const location = `${where} ${slice.id}`;
    if (!ALLOWED_SLICE_LIFECYCLES.has(slice.lifecycle)) {
      findings.push(makeFinding(
        'SLICE_LIFECYCLE_INVALID',
        location,
        `切片 lifecycle 非法：${slice.lifecycle || '(空)'}`
      ));
    }
    if (!ALLOWED_AUTHORITIES.has(slice.authority)) {
      findings.push(makeFinding(
        'SLICE_AUTHORITY_INVALID',
        location,
        `切片 authority 非法：${slice.authority || '(空)'}`
      ));
    }
    if (slice.authorityCap === null || slice.authorityCap === undefined) {
      findings.push(makeFinding(
        'SLICE_AUTHORITY_CAP_INVALID',
        location,
        'authority 上限必须包含一个 cap=<authority> 机器标记。'
      ));
    } else if (
      ALLOWED_AUTHORITIES.has(slice.authority) &&
      AUTHORITY_RANK.get(slice.authority) > AUTHORITY_RANK.get(slice.authorityCap)
    ) {
      findings.push(makeFinding(
        'SLICE_AUTHORITY_EXCEEDS_CAP',
        location,
        `当前 authority=${slice.authority} 超过 authority 上限 cap=${slice.authorityCap}。`
      ));
    }
    if (slice.lifecycle === 'blocked' && slice.blockerIds.length === 0) {
      findings.push(makeFinding(
        'SLICE_BLOCKER_REQUIRED',
        location,
        'blocked 切片必须在 blockerRefs 引用至少一个 BLK-*。'
      ));
    }
    if (slice.lifecycle !== 'blocked' && slice.blockerIds.length > 0) {
      findings.push(makeFinding(
        'SLICE_BLOCKER_STATE_MISMATCH',
        location,
        `${slice.lifecycle || '(空)'} 切片不能保留活动 blockerRefs；有 blocker 时 lifecycle 必须为 blocked。`
      ));
    }
    if ((slice.lifecycle === 'ready' || slice.lifecycle === 'active')
      && slice.blockerIds.length === 0
      && asksForUserActionWithoutBlocker(freeTextOf(slice))) {
      findings.push(makeFinding(
        'USER_ACTION_WITHOUT_ACTIVE_BLOCKER',
        location,
        'ready/active 切片没有活动 blockerRefs，不得把工程工作描述为需要用户裁定、授权、提供或介入。'
      ));
    }
    for (const blockerId of slice.blockerIds) {
      if (!blockers.has(blockerId)) {
        findings.push(makeFinding(
          'SLICE_BLOCKER_UNDEFINED',
          location,
          `切片引用了未定义 blocker：${blockerId}`
        ));
      } else if (!blockers.get(blockerId).impactSliceIds.includes(slice.id)) {
        findings.push(makeFinding(
          'SLICE_BLOCKER_IMPACT_MISSING',
          location,
          `blocker ${blockerId} 的影响 Gate/切片列未声明该切片。`
        ));
      }
    }
  }

  for (const [id, count] of countBy(definitionOrder)) {
    if (count > 1) {
      findings.push(makeFinding('SLICE_ID_DUPLICATE', where, `切片 ID 重复定义 ${count} 次：${id}`));
    }
  }
}

// ---------------------------------------------------------------------------
// active claim
// ---------------------------------------------------------------------------

export function validateActiveClaims(claims, slices, where, findings) {
  for (const claim of claims) {
    const location = `${where} ${claim.sliceId}`;
    for (const [field, label] of [
      ['claimId', 'claimId'],
      ['owner', 'owner'],
      ['claimedAt', 'claimedAt'],
      ['heartbeatAt', 'heartbeatAt'],
      ['recoveryTrigger', 'recoveryTrigger']
    ]) {
      if (!hasMeaningfulValue(claim[field])) {
        findings.push(makeFinding(
          'ACTIVE_CLAIM_FIELD_REQUIRED',
          location,
          `active claim 的 ${label} 不能为空或使用占位符。`
        ));
      }
    }
    const slice = slices.get(claim.sliceId);
    if (!slice) {
      findings.push(makeFinding(
        'ACTIVE_CLAIM_SLICE_UNDEFINED',
        location,
        'active claim 引用了执行面板中不存在的切片。'
      ));
    } else if (slice.lifecycle !== 'active') {
      findings.push(makeFinding(
        'ACTIVE_CLAIM_SLICE_NOT_ACTIVE',
        location,
        `claim 只能属于 lifecycle=active 的切片，当前为 ${slice.lifecycle}。`
      ));
    }
    const claimedAt = Date.parse(claim.claimedAt ?? '');
    const heartbeatAt = Date.parse(claim.heartbeatAt ?? '');
    if (!Number.isFinite(claimedAt) || !Number.isFinite(heartbeatAt) || heartbeatAt < claimedAt) {
      findings.push(makeFinding(
        'ACTIVE_CLAIM_TIME_INVALID',
        location,
        'claimedAt/heartbeatAt 必须是合法 ISO 时间，且 heartbeatAt 不早于 claimedAt。'
      ));
    }
  }

  for (const slice of slices.values()) {
    const count = claims.filter((claim) => claim.sliceId === slice.id).length;
    if (slice.lifecycle === 'active' && count !== 1) {
      findings.push(makeFinding(
        'ACTIVE_SLICE_CLAIM_REQUIRED',
        `${where} ${slice.id}`,
        `active 切片必须恰好登记一个 claim，当前为 ${count} 个。`
      ));
    }
  }
  for (const [claimId, count] of countBy(claims.map((claim) => claim.claimId).filter(Boolean))) {
    if (count > 1) {
      findings.push(makeFinding('ACTIVE_CLAIM_ID_DUPLICATE', where, `claimId 重复 ${count} 次：${claimId}`));
    }
  }
}

// ---------------------------------------------------------------------------
// 未冻结验证清单
// ---------------------------------------------------------------------------

export function validateUnfrozenValidations(listedSliceIds, slices, where, findings) {
  const listed = new Set();
  for (const sliceId of listedSliceIds) {
    listed.add(sliceId);
    const slice = slices.get(sliceId);
    if (!slice) {
      findings.push(makeFinding(
        'VALIDATION_UNFROZEN_SLICE_UNKNOWN',
        `${where} ${sliceId}`,
        `validation-unfrozen 引用了未定义的切片：${sliceId}`
      ));
    } else if (TERMINAL_SLICE_LIFECYCLES.has(slice.lifecycle)) {
      findings.push(makeFinding(
        'VALIDATION_UNFROZEN_TERMINAL_SLICE',
        `${where} ${sliceId}`,
        `${slice.lifecycle} 切片不能继续保留在 validation-unfrozen 列表中。`
      ));
    }
  }

  // 反向收敛：清单声称是未冻结验证的完整集合，因此任何自我声明
  // declaresUnfrozenValidation 的非终态切片都必须在此列出。缺少该检查时，
  // 未冻结验证可以只写在切片自身而绕过清单，逐步把"待冻结"当成已冻结。
  for (const slice of slices.values()) {
    if (!slice.declaresUnfrozenValidation) continue;
    if (TERMINAL_SLICE_LIFECYCLES.has(slice.lifecycle)) continue;
    if (listed.has(slice.id)) continue;
    findings.push(makeFinding(
      'VALIDATION_UNFROZEN_SLICE_UNLISTED',
      `${where} ${slice.id}`,
      `切片声明了 validation-unfrozen，但未出现在未冻结验证清单中：${slice.id}`
    ));
  }
}

// ---------------------------------------------------------------------------
// Gate 清单
// ---------------------------------------------------------------------------

export function validateReleaseGateIds(gateIds, where, findings) {
  if (gateIds.length === 0) {
    findings.push(makeFinding('GATE_LIST_EMPTY', where, '未定义任何 REL-* Gate。'));
  }
  for (const [id, count] of countBy(gateIds)) {
    if (count > 1) {
      findings.push(makeFinding('GATE_LIST_DUPLICATE', where, `Gate 重复定义 ${count} 次：${id}`));
    }
  }
  const actual = new Set(gateIds);
  for (const requiredId of REQUIRED_GATE_IDS) {
    if (!actual.has(requiredId)) {
      findings.push(makeFinding('GATE_REQUIRED_MISSING', where, `固定 Gate 集合缺少：${requiredId}`));
    }
  }
  for (const id of actual) {
    if (!REQUIRED_GATE_IDS.includes(id)) {
      findings.push(makeFinding(
        'GATE_REQUIRED_EXTRA',
        where,
        `包含不在固定 Gate 集合中的 ID：${id}`
      ));
    }
  }
}

// ---------------------------------------------------------------------------
// Gate 矩阵
// ---------------------------------------------------------------------------

/**
 * @param {object[]} gateRows Gate 记录数组（含重复项，用于重复检测）。
 * @param {string[]} releaseGateIds 必需 Gate 清单。
 * @param {(gateId: string) => string[]|null} subjectRefsOf 该 Gate 的 freshness
 *   主题域引用；返回 null 表示尚未登记主题域（失败关闭）。
 * @param {(location, evidenceIds, evidence, subjectRefs, staleCode, staleMessage) => object|null} checkFreshness
 *   evidence 由本函数传入，调用方不必重建，避免两份 Evidence 视图不一致。
 * @returns {Map<string, object>} 首次出现的 Gate 记录。
 */
export function validateGateMatrix(
  gateRows,
  releaseGateIds,
  slices,
  blockers,
  evidence,
  where,
  findings,
  subjectRefsOf,
  checkFreshness
) {
  const releaseGateSet = new Set(releaseGateIds);
  const rowCounts = countBy(gateRows.map((row) => row.id));

  for (const gateId of new Set(releaseGateIds)) {
    const count = rowCounts.get(gateId) ?? 0;
    if (count === 0) {
      findings.push(makeFinding('GATE_MISSING_IN_MATRIX', where, `必需 Gate 未在矩阵中出现：${gateId}`));
    } else if (count > 1) {
      findings.push(makeFinding('GATE_MATRIX_DUPLICATE', where, `Gate 在矩阵中重复 ${count} 次：${gateId}`));
    }
  }
  for (const gateId of rowCounts.keys()) {
    if (!releaseGateSet.has(gateId)) {
      findings.push(makeFinding('GATE_MATRIX_EXTRA', where, `矩阵包含未在必需清单定义的额外 Gate：${gateId}`));
    }
  }

  const firstRows = new Map();
  for (const row of gateRows) if (!firstRows.has(row.id)) firstRows.set(row.id, row);
  const scopeRow = firstRows.get('REL-SCOPE');
  const scopePassedAndSealed = scopeRow
    ? scopeRow.gateState === 'passed' &&
      scopeRow.evidenceIds.some((id) => evidenceHasClaim(evidence, id, 'scope-ruling:user-approved'))
    : false;

  for (const row of gateRows) {
    const gateId = row.id;
    const { gateState, applicability, sliceIds, blockerIds, evidenceIds, successor } = row;
    const location = `${where} ${gateId}`;

    if (LEGACY_GATE_STATES.has(gateState) || gateState.startsWith('blocked:')) {
      findings.push(makeFinding('GATE_STATE_LEGACY_TOKEN', location, `Gate 使用了已废弃状态 token：${gateState}`));
    } else if (!ALLOWED_GATE_STATES.has(gateState)) {
      findings.push(makeFinding('GATE_STATE_INVALID', location, `gateState 非法：${gateState || '(空)'}`));
    }
    if (!ALLOWED_APPLICABILITY.has(applicability)) {
      findings.push(makeFinding(
        'GATE_APPLICABILITY_INVALID',
        location,
        `applicability 非法：${applicability || '(空)'}`
      ));
    }
    if (gateState !== 'blocked' && blockerIds.length === 0 && asksForUserActionWithoutBlocker(successor)) {
      findings.push(makeFinding(
        'USER_ACTION_WITHOUT_ACTIVE_BLOCKER',
        location,
        '非 blocked Gate 没有活动 blockerRefs，不得把后继工程工作或 Evidence 维护描述为需要用户介入。'
      ));
    }
    if (NON_EXCLUDABLE_GATES.has(gateId) && applicability !== 'in-scope') {
      findings.push(makeFinding(
        'GATE_BASE_APPLICABILITY_INVALID',
        location,
        `${gateId} 是基础 Gate，applicability 必须始终为 in-scope。`
      ));
    }
    if (gateId !== 'REL-SCOPE' && scopePassedAndSealed && applicability === 'pending-scope') {
      findings.push(makeFinding(
        'GATE_SCOPE_RESOLVED_PENDING',
        location,
        'REL-SCOPE 已通过后，功能 Gate 必须明确为 in-scope、scope-excluded 或 deferred-v0.6，不能继续 pending-scope。'
      ));
    }
    for (const sliceId of sliceIds) {
      if (!slices.has(sliceId)) {
        findings.push(makeFinding('GATE_SLICE_UNKNOWN', location, `Gate 引用了不存在的切片：${sliceId}`));
      }
    }

    if (gateState === 'open') {
      if (applicability === 'scope-excluded') {
        findings.push(makeFinding('GATE_OPEN_SCOPE_EXCLUDED', location, 'open Gate 不能标记为 scope-excluded。'));
      }
      if (applicability === DEFERRED_APPLICABILITY) {
        findings.push(makeFinding(
          'GATE_OPEN_DEFERRED',
          location,
          `open Gate 不能标记为 ${DEFERRED_APPLICABILITY}；延期 Gate 必须使用 gateState=deferred。`
        ));
      }
      const knownSlices = sliceIds.map((id) => slices.get(id)).filter(Boolean);
      for (const slice of knownSlices.filter((item) => TERMINAL_SLICE_LIFECYCLES.has(item.lifecycle))) {
        findings.push(makeFinding(
          'GATE_OPEN_TERMINAL_SLICE',
          location,
          `open Gate 引用了终态切片 ${slice.id}（${slice.lifecycle}）。`
        ));
      }
      if (!knownSlices.some((slice) => slice.lifecycle === 'ready' || slice.lifecycle === 'active')) {
        findings.push(makeFinding(
          'GATE_OPEN_NO_LIVE_SLICE',
          location,
          'open Gate 至少需要一个 lifecycle=ready/active 的当前切片。'
        ));
      }
    }

    if (gateState === 'blocked') {
      const knownSlices = sliceIds.map((id) => slices.get(id)).filter(Boolean);
      if (knownSlices.length === 0 || !knownSlices.some((slice) => slice.lifecycle === 'blocked')) {
        findings.push(makeFinding(
          'GATE_BLOCKED_NO_BLOCKED_SLICE',
          location,
          'blocked Gate 至少需要引用一个 lifecycle=blocked 的当前切片。'
        ));
      }
      for (const slice of knownSlices.filter((item) => item.lifecycle !== 'blocked')) {
        findings.push(makeFinding(
          'GATE_BLOCKED_NONBLOCKED_SLICE',
          location,
          `blocked Gate 不能隐藏仍为 ${slice.lifecycle} 的当前切片：${slice.id}`
        ));
      }
      if (blockerIds.length === 0) {
        findings.push(makeFinding(
          'GATE_BLOCKER_REQUIRED',
          location,
          'blocked Gate 必须引用至少一个 BLK-*。'
        ));
      }
      for (const blockerId of blockerIds) {
        if (!blockers.has(blockerId)) {
          findings.push(makeFinding('GATE_BLOCKER_UNDEFINED', location, `blocked Gate 引用了未定义 blocker：${blockerId}`));
        } else if (!blockers.get(blockerId).impactGateIds.includes(gateId)) {
          findings.push(makeFinding(
            'GATE_BLOCKER_IMPACT_MISSING',
            location,
            `blocker ${blockerId} 的影响 Gate/切片列未声明该 Gate。`
          ));
        }
      }
    }

    if (gateState === 'passed') {
      if (evidenceIds.length === 0) {
        findings.push(makeFinding(
          'GATE_PASSED_EVIDENCE_REQUIRED',
          location,
          'passed Gate 必须引用至少一个 sealed-current-run Evidence。'
        ));
      }
      for (const evidenceId of evidenceIds) {
        if (!evidence.has(evidenceId)) {
          findings.push(makeFinding('GATE_EVIDENCE_UNDEFINED', location, `passed Gate 引用了未定义 Evidence：${evidenceId}`));
        } else if (!evidenceIsSealed(evidence, evidenceId)) {
          findings.push(makeFinding(
            'GATE_EVIDENCE_UNSEALED',
            location,
            `passed Gate 的 Evidence 未形成有效 sealed-current-run 指纹：${evidenceId}`
          ));
        }
      }
      if (gateId === 'REL-SCOPE' &&
        !evidenceIds.some((id) => evidenceHasClaim(evidence, id, 'scope-ruling:user-approved'))) {
        findings.push(makeFinding(
          'GATE_SCOPE_RULING_EVIDENCE_REQUIRED',
          location,
          'REL-SCOPE passed 必须引用声明 scope-ruling:user-approved 的 sealed Evidence。'
        ));
      }
      if (applicability !== 'scope-excluded') {
        const subjectRefs = subjectRefsOf(gateId);
        if (subjectRefs === null) {
          findings.push(makeFinding(
            'GATE_SUBJECT_SET_UNDEFINED',
            location,
            `passed Gate ${gateId} 尚未登记 freshness 主题域，失败关闭。`
          ));
        } else {
          const freshnessEvidenceIds = gateId === 'REL-SCOPE'
            ? evidenceIds.filter((id) => evidenceHasClaim(evidence, id, 'scope-ruling:user-approved'))
            : evidenceIds;
          const finding = checkFreshness(
            location,
            freshnessEvidenceIds,
            evidence,
            subjectRefs,
            'GATE_EVIDENCE_STALE',
            'passed Gate 的 sealed Evidence 锚点之后，相关主题域发生变化。若冻结范围语义未变，由工程侧重跑验证并重封存；只有实际范围变化才需要新的用户裁定。'
          );
          if (finding) findings.push(finding);
        }
      }
    }

    if (applicability === 'pending-scope' && gateState === 'passed') {
      findings.push(makeFinding('GATE_PENDING_SCOPE_PASSED', location, 'pending-scope Gate 不能进入 passed。'));
    }

    // gateState=deferred 与 applicability=deferred-v0.6 必须双向成对，
    // 防止用「延期」掩盖未完成，或用 passed 冒充延期。
    if (gateState === 'deferred' && applicability !== DEFERRED_APPLICABILITY) {
      findings.push(makeFinding(
        'GATE_DEFERRED_APPLICABILITY_INVALID',
        location,
        `gateState=deferred 必须搭配 applicability=${DEFERRED_APPLICABILITY}。`
      ));
    }

    if (applicability === DEFERRED_APPLICABILITY) {
      if (NON_EXCLUDABLE_GATES.has(gateId)) {
        findings.push(makeFinding(
          'GATE_BASE_DEFERRAL_FORBIDDEN',
          location,
          `${gateId} 是不可排除的基础 Gate，不得延期。`
        ));
      }
      if (gateState !== 'deferred') {
        findings.push(makeFinding(
          'GATE_DEFERRED_STATE_INVALID',
          location,
          `${DEFERRED_APPLICABILITY} Gate 必须使用 gateState=deferred，不得写成 passed、open 或 blocked。`
        ));
      }
      if (evidenceIds.length === 0) {
        findings.push(makeFinding(
          'GATE_DEFERRED_EVIDENCE_REQUIRED',
          location,
          `${DEFERRED_APPLICABILITY} Gate 必须引用 sealed-current-run 范围裁定 Evidence。`
        ));
      }
      for (const evidenceId of evidenceIds) {
        if (!evidence.has(evidenceId)) {
          findings.push(makeFinding('GATE_EVIDENCE_UNDEFINED', location, `deferred Gate 引用了未定义 Evidence：${evidenceId}`));
        } else if (!evidenceIsSealed(evidence, evidenceId)) {
          findings.push(makeFinding(
            'GATE_EVIDENCE_UNSEALED',
            location,
            `deferred Gate 的 Evidence 未形成有效 sealed-current-run 指纹：${evidenceId}`
          ));
        }
      }
      if (!scopePassedAndSealed) {
        findings.push(makeFinding(
          'GATE_SCOPE_PREREQUISITE_NOT_PASSED',
          location,
          '延期功能 Gate 前，REL-SCOPE 必须先 passed 并引用有效 sealed-current-run Evidence。'
        ));
      }
      // 延期 Gate 不得掩盖仍在推进或已声称完成的切片：
      // 前者会让本里程碑出现无 Gate 覆盖的活动工作，
      // 后者会把延期范围内的工作误记为本里程碑完成。
      const deferredGateSlices = sliceIds.map((id) => slices.get(id)).filter(Boolean);
      for (const slice of deferredGateSlices.filter((item) => item.lifecycle !== 'deferred')) {
        findings.push(makeFinding(
          'GATE_DEFERRED_NONDEFERRED_SLICE',
          location,
          `deferred Gate 不能保留仍为 ${slice.lifecycle} 的切片：${slice.id}；`
            + '该切片必须一并写成 lifecycle=deferred。'
        ));
      }
      const deferralMarker = `scope-deferral:${gateId}:${DEFERRED_TARGET_RELEASE}:user-approved`;
      const approvedDeferralIds = evidenceIds.filter((id) => evidenceHasClaim(evidence, id, deferralMarker));
      if (approvedDeferralIds.length === 0) {
        findings.push(makeFinding(
          'GATE_DEFERRAL_APPROVAL_REQUIRED',
          location,
          `${DEFERRED_APPLICABILITY} Gate 必须引用声明 ${deferralMarker} 的 sealed Evidence。`
        ));
      } else {
        const finding = checkFreshness(
          location,
          approvedDeferralIds,
          evidence,
          subjectRefsOf('REL-SCOPE') ?? [],
          'GATE_DEFERRAL_EVIDENCE_STALE',
          '范围延期 Evidence 锚点之后，冻结范围主题域发生变化；工程侧必须核对语义并重跑验证，实际范围变化仍需新的用户裁定。'
        );
        if (finding) findings.push(finding);
      }
    }

    if (applicability === 'scope-excluded') {
      if (NON_EXCLUDABLE_GATES.has(gateId)) {
        findings.push(makeFinding(
          'GATE_BASE_SCOPE_EXCLUSION_FORBIDDEN',
          location,
          `${gateId} 是不可排除的基础 Gate。`
        ));
      }
      if (gateState !== 'passed') {
        findings.push(makeFinding(
          'GATE_SCOPE_EXCLUDED_STATE_INVALID',
          location,
          'scope-excluded Gate 必须使用 gateState=passed。'
        ));
      }
      if (evidenceIds.length === 0) {
        findings.push(makeFinding(
          'GATE_SCOPE_EXCLUDED_EVIDENCE_REQUIRED',
          location,
          'scope-excluded Gate 必须引用 sealed-current-run 范围裁定 Evidence。'
        ));
      }
      if (gateId !== 'REL-SCOPE' && !scopePassedAndSealed) {
        findings.push(makeFinding(
          'GATE_SCOPE_PREREQUISITE_NOT_PASSED',
          location,
          '排除功能 Gate 前，REL-SCOPE 必须先 passed 并引用有效 sealed-current-run Evidence。'
        ));
      }
      const exclusionMarker = `scope-exclusion:${gateId}:user-approved`;
      const approvedExclusionIds = evidenceIds.filter((id) => evidenceHasClaim(evidence, id, exclusionMarker));
      if (approvedExclusionIds.length === 0) {
        findings.push(makeFinding(
          'GATE_SCOPE_EXCLUSION_APPROVAL_REQUIRED',
          location,
          `scope-excluded Gate 必须引用声明 ${exclusionMarker} 的 sealed Evidence。`
        ));
      } else {
        const finding = checkFreshness(
          location,
          approvedExclusionIds,
          evidence,
          subjectRefsOf('REL-SCOPE') ?? [],
          'GATE_SCOPE_EXCLUSION_EVIDENCE_STALE',
          '范围排除 Evidence 锚点之后，冻结范围主题域发生变化；工程侧必须核对语义并重跑验证，实际范围变化仍需新的用户裁定。'
        );
        if (finding) findings.push(finding);
      }
    }
  }

  return firstRows;
}

// ---------------------------------------------------------------------------
// blocker 影响闭合
// ---------------------------------------------------------------------------

export function validateBlockerImpactClosure(blockers, slices, gates, where, findings) {
  for (const blocker of blockers.values()) {
    const location = `${where} ${blocker.id}`;
    for (const sliceId of blocker.impactSliceIds) {
      const slice = slices.get(sliceId);
      if (!slice) {
        findings.push(makeFinding(
          'BLOCKER_IMPACT_SLICE_UNDEFINED',
          location,
          `影响对象引用了不存在的切片：${sliceId}`
        ));
      } else if (slice.lifecycle === 'blocked' && !slice.blockerIds.includes(blocker.id)) {
        findings.push(makeFinding(
          'BLOCKER_IMPACT_SLICE_REF_MISSING',
          location,
          `blocked 切片 ${sliceId} 未反向引用该 blocker。`
        ));
      }
    }
    for (const gateId of blocker.impactGateIds) {
      const gate = gates.get(gateId);
      if (!gate) {
        findings.push(makeFinding(
          'BLOCKER_IMPACT_GATE_UNDEFINED',
          location,
          `影响对象引用了不存在的 Gate：${gateId}`
        ));
      } else if (gate.gateState === 'blocked' && !gate.blockerIds.includes(blocker.id)) {
        findings.push(makeFinding(
          'BLOCKER_IMPACT_GATE_REF_MISSING',
          location,
          `blocked Gate ${gateId} 未反向引用该 blocker。`
        ));
      }
    }
  }
}

export const governanceEnums = Object.freeze({
  sliceLifecycles: Object.freeze([...ALLOWED_SLICE_LIFECYCLES]),
  authorities: Object.freeze([...ALLOWED_AUTHORITIES]),
  gateStates: Object.freeze([...ALLOWED_GATE_STATES]),
  applicability: Object.freeze([...ALLOWED_APPLICABILITY]),
  blockerReasons: Object.freeze([...ALLOWED_BLOCKER_REASONS]),
  evidenceTypes: Object.freeze([...ALLOWED_EVIDENCE_TYPES]),
  requiredGateIds: REQUIRED_GATE_IDS
});
