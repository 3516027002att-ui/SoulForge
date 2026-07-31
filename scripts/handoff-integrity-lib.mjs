import { createHash } from 'node:crypto';

const ALLOWED_SLICE_LIFECYCLES = new Set([
  'ready',
  'active',
  'completed',
  'blocked',
  'superseded'
]);

const ALLOWED_AUTHORITIES = new Set([
  'unsupported',
  'candidate',
  'fixture-confirmed',
  'partial',
  'native-verified',
  'unverified'
]);

const ALLOWED_GATE_STATES = new Set(['open', 'blocked', 'passed']);
const ALLOWED_APPLICABILITY = new Set(['pending-scope', 'in-scope', 'scope-excluded']);
const ALLOWED_BLOCKER_REASONS = new Set([
  'private-corpus',
  'credential',
  'hardware',
  'user-ruling',
  'toolchain',
  'license',
  'upstream',
  'prerequisite-authority'
]);
const ALLOWED_EVIDENCE_TYPES = new Set([
  'sealed-current-run',
  'unsealed-record',
  'historical-record'
]);
const NON_EXCLUDABLE_GATES = new Set(['REL-SCOPE', 'REL-A', 'REL-H', 'REL-COMPLIANCE']);
const REQUIRED_GATE_IDS = Object.freeze([
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
const LEGACY_GATE_STATES = new Set(['covered-open', 'uncovered']);
const USER_ACTION_WITHOUT_BLOCKER_PATTERN = /(?:需(?:要)?|等待|留给|交由)用户.{0,48}(?:裁定|授权|提供|介入|处理|输入)|用户(?:需(?:要)?|必须|应当).{0,48}(?:裁定|授权|提供|介入|处理|输入)/u;
const AUTHORITY_RANK = new Map([
  ['unsupported', 0],
  ['unverified', 0],
  ['candidate', 1],
  ['fixture-confirmed', 1],
  ['partial', 2],
  ['native-verified', 3]
]);
const SLICE_HEADERS = [
  '切片id',
  'lifecycle',
  'authority',
  'blockerrefs',
  '目标能力',
  '可独立验收切片',
  '硬前置',
  '主要入口',
  'requiredvalidation',
  'authority上限'
];
const ACTIVE_CLAIM_HEADERS = [
  'sliceid',
  'claimid',
  'owner',
  'claimedat',
  'heartbeatat',
  'recoverytrigger'
];
const BLOCKER_HEADERS = [
  'blockerid',
  'reason',
  '影响gate/切片',
  '责任方',
  '所需输入',
  '解锁验证',
  '复查触发器',
  'evidence'
];

function makeFinding(code, where, message) {
  return { severity: 'error', code, where, message };
}

function extractSection(markdown, sectionNumber) {
  const heading = new RegExp(`^(#{1,6})\\s+${sectionNumber.replaceAll('.', '\\.')}\\b.*$`, 'm');
  const match = heading.exec(markdown);
  if (!match) return null;

  const bodyStart = match.index + match[0].length;
  const tail = markdown.slice(bodyStart);
  const nextHeading = new RegExp(`^#{1,${match[1].length}}\\s+.+$`, 'm').exec(tail);
  const divider = /^---\s*$/m.exec(tail);
  const candidates = [nextHeading?.index, divider?.index].filter((value) => value !== undefined);
  const bodyEnd = candidates.length === 0 ? markdown.length : bodyStart + Math.min(...candidates);
  return markdown.slice(bodyStart, bodyEnd);
}

export function extractHandoffSectionSubject(markdown, sectionNumber) {
  return extractSection(markdown, sectionNumber);
}

export function extractHandoffMarkedSubject(markdown, beginMarker, endMarker) {
  const begin = markdown.indexOf(beginMarker);
  const end = begin === -1 ? -1 : markdown.indexOf(endMarker, begin + beginMarker.length);
  if (begin === -1 || end === -1
    || begin !== markdown.lastIndexOf(beginMarker)
    || end !== markdown.lastIndexOf(endMarker)) {
    return null;
  }
  return markdown.slice(begin, end + endMarker.length);
}

function splitTableLine(line) {
  const trimmed = line.trim();
  const withoutEdges = trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined);
  return withoutEdges.split('|').map((cell) => cell.trim());
}

function parseFirstTable(section) {
  if (section === null) return null;
  const lines = section.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimStart().startsWith('|'));
  if (start === -1) return null;

  const tableLines = [];
  for (let index = start; index < lines.length; index += 1) {
    if (!lines[index].trimStart().startsWith('|')) break;
    tableLines.push(lines[index]);
  }
  if (tableLines.length === 0) return null;

  const parsed = tableLines.map(splitTableLine);
  const header = parsed[0];
  const rows = parsed.slice(1).filter(
    (cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
  return { header, rows };
}

function plain(cell) {
  return (cell ?? '')
    .replaceAll('`', '')
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .trim();
}

function headerToken(cell) {
  return plain(cell).replace(/\s+/g, '').toLowerCase();
}

function hasMeaningfulValue(cell) {
  const value = plain(cell);
  return value !== '' && value !== '—' && value !== '-';
}

function asksForUserActionWithoutBlocker(value) {
  return USER_ACTION_WITHOUT_BLOCKER_PATTERN.test(plain(value));
}

function extractIds(cell, prefix) {
  const pattern = new RegExp(`(?:^|[^A-Z0-9-])(${prefix}-[A-Z0-9-]+)(?=$|[^A-Z0-9-])`, 'g');
  return [...new Set([...(cell ?? '').matchAll(pattern)].map((match) => match[1]))];
}

function firstId(cell, prefix) {
  return extractIds(cell, prefix)[0] ?? null;
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

export function computeHandoffFingerprintSha256(fields) {
  const canonical = [
    `HEAD=${fields.head.toLowerCase()}`,
    `trackedDiffSha256=${fields.trackedDiffSha256.toLowerCase()}`,
    `untrackedManifestSha256=${fields.untrackedManifestSha256.toLowerCase()}`,
    `handoffSha256BeforeEvidenceAppend=${fields.handoffSha256BeforeEvidenceAppend.toLowerCase()}`
  ].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function extractUniqueHexField(baseline, field, lengths) {
  const alternatives = lengths.map((length) => `[0-9a-fA-F]{${length}}`).join('|');
  const matcher = new RegExp(
    `(?:^|[;,，；\\s])${field}=(${alternatives})(?=$|[;,，；\\s])`,
    'g'
  );
  const matches = [...baseline.matchAll(matcher)];
  return matches.length === 1 ? matches[0][1].toLowerCase() : null;
}

function parseSealBaseline(baseline) {
  const fields = {
    head: extractUniqueHexField(baseline, 'HEAD', [40, 64]),
    trackedDiffSha256: extractUniqueHexField(baseline, 'trackedDiffSha256', [64]),
    untrackedManifestSha256: extractUniqueHexField(baseline, 'untrackedManifestSha256', [64]),
    handoffSha256BeforeEvidenceAppend: extractUniqueHexField(
      baseline,
      'handoffSha256BeforeEvidenceAppend',
      [64]
    ),
    fingerprintSha256: extractUniqueHexField(baseline, 'fingerprintSha256', [64])
  };
  const formatValid = Object.values(fields).every(Boolean);
  if (!formatValid) return { valid: false, formatValid: false, fingerprintValid: false, fields };
  const expectedFingerprint = computeHandoffFingerprintSha256(fields);
  const fingerprintValid = fields.fingerprintSha256 === expectedFingerprint;
  return {
    valid: fingerprintValid,
    formatValid: true,
    fingerprintValid,
    expectedFingerprint,
    fields
  };
}

function parseEvidence(markdown, where, findings) {
  const table = parseFirstTable(extractSection(markdown, '17.1'));
  const evidence = new Map();
  if (!table) {
    findings.push(makeFinding('EVIDENCE_INDEX_MISSING', where, '未找到 §17.1 Evidence 索引表。'));
    return evidence;
  }

  if (table.header.length < 2) {
    findings.push(makeFinding('EVIDENCE_TABLE_SCHEMA_INVALID', where, '§17.1 Evidence 表至少需要 ID 与类型两列。'));
  }

  const definitions = [];
  for (const cells of table.rows) {
    const id = firstId(cells[0], 'EV');
    if (!id) continue;
    definitions.push(id);
    const type = plain(cells[1]);
    const claim = plain(cells[2]);
    const baseline = plain(cells[3]);
    const seal = type === 'sealed-current-run' ? parseSealBaseline(baseline) : null;
    const sealValid = type === 'sealed-current-run' && seal?.valid === true;
    if (!evidence.has(id)) evidence.set(id, { id, type, claim, baseline, seal, sealValid });

    if (!ALLOWED_EVIDENCE_TYPES.has(type)) {
      findings.push(makeFinding(
        'EVIDENCE_TYPE_INVALID',
        `${where} §17.1 ${id}`,
        `Evidence 类型非法：${type || '(空)'}`
      ));
    }
    if (type === 'sealed-current-run' && seal?.formatValid !== true) {
      findings.push(makeFinding(
        'EVIDENCE_SEAL_INVALID',
        `${where} §17.1 ${id}`,
        'sealed-current-run 的基线必须包含有效 HEAD（40/64 hex）及四个 64 hex SHA-256 指纹字段。'
      ));
    } else if (type === 'sealed-current-run' && seal.fingerprintValid !== true) {
      findings.push(makeFinding(
        'EVIDENCE_FINGERPRINT_MISMATCH',
        `${where} §17.1 ${id}`,
        `fingerprintSha256 与四字段 canonical payload 不一致；期望 ${seal.expectedFingerprint}。`
      ));
    }
  }

  for (const [id, count] of countBy(definitions)) {
    if (count > 1) {
      findings.push(makeFinding(
        'EVIDENCE_ID_DUPLICATE',
        `${where} §17.1`,
        `Evidence ID 重复定义 ${count} 次：${id}`
      ));
    }
  }
  if (definitions.length === 0) {
    findings.push(makeFinding('EVIDENCE_INDEX_EMPTY', `${where} §17.1`, 'Evidence 索引没有定义任何 EV-*。'));
  }

  const allReferences = extractIds(markdown, 'EV');
  for (const id of allReferences) {
    if (!evidence.has(id)) {
      findings.push(makeFinding(
        'EVIDENCE_ID_UNDEFINED',
        where,
        `引用了未在 §17.1 定义的 Evidence：${id}`
      ));
    }
  }
  return evidence;
}

function parseBlockers(markdown, where, findings, evidence) {
  const table = parseFirstTable(extractSection(markdown, '18.4'));
  const blockers = new Map();
  if (!table) {
    findings.push(makeFinding('BLOCKER_INDEX_MISSING', where, '未找到 §18.4 blocker 表。'));
    return blockers;
  }

  if (
    table.header.length !== BLOCKER_HEADERS.length ||
    BLOCKER_HEADERS.some((token, index) => headerToken(table.header[index]) !== token)
  ) {
    findings.push(makeFinding(
      'BLOCKER_TABLE_SCHEMA_INVALID',
      `${where} §18.4`,
      '§18.4 blocker 表必须完整使用 blockerId、reason、影响对象、责任方、输入、解锁验证、复查触发器和 Evidence 八列。'
    ));
  }

  const definitions = [];
  for (const cells of table.rows) {
    const id = firstId(cells[0], 'BLK');
    if (!id) continue;
    definitions.push(id);
    const reason = plain(cells[1]);
    const impactSliceIds = extractIds(cells[2], 'W');
    const impactGateIds = extractIds(cells[2], 'REL');
    const evidenceIds = extractIds(cells[7], 'EV');
    if (!blockers.has(id)) {
      blockers.set(id, {
        id,
        reason,
        impactSliceIds,
        impactGateIds,
        evidenceIds
      });
    }
    if (cells.length !== BLOCKER_HEADERS.length) {
      findings.push(makeFinding(
        'BLOCKER_ROW_SCHEMA_INVALID',
        `${where} §18.4 ${id}`,
        `blocker 行必须正好包含 ${BLOCKER_HEADERS.length} 列，实际为 ${cells.length} 列。`
      ));
    }
    if (!ALLOWED_BLOCKER_REASONS.has(reason)) {
      findings.push(makeFinding(
        'BLOCKER_REASON_INVALID',
        `${where} §18.4 ${id}`,
        `blocker reason 非法：${reason || '(空)'}`
      ));
    }

    if (impactSliceIds.length === 0 && impactGateIds.length === 0) {
      findings.push(makeFinding(
        'BLOCKER_IMPACT_REQUIRED',
        `${where} §18.4 ${id}`,
        'blocker 必须在影响 Gate/切片列引用至少一个已定义的 REL-* 或 W-*。'
      ));
    }
    const requiredCells = [
      [3, '责任方'],
      [4, '所需输入'],
      [5, '解锁验证'],
      [6, '复查触发器']
    ];
    for (const [index, label] of requiredCells) {
      if (!hasMeaningfulValue(cells[index])) {
        findings.push(makeFinding(
          'BLOCKER_FIELD_REQUIRED',
          `${where} §18.4 ${id}`,
          `blocker 的${label}不能为空或使用占位符。`
        ));
      }
    }

    for (const evidenceId of evidenceIds) {
      if (!evidence.has(evidenceId)) {
        findings.push(makeFinding(
          'BLOCKER_EVIDENCE_UNDEFINED',
          `${where} §18.4 ${id}`,
          `blocker 引用了未定义 Evidence：${evidenceId}`
        ));
      }
    }
  }

  for (const [id, count] of countBy(definitions)) {
    if (count > 1) {
      findings.push(makeFinding(
        'BLOCKER_ID_DUPLICATE',
        `${where} §18.4`,
        `Blocker ID 重复定义 ${count} 次：${id}`
      ));
    }
  }

  const allReferences = extractIds(markdown, 'BLK');
  for (const id of allReferences) {
    if (!blockers.has(id)) {
      findings.push(makeFinding(
        'BLOCKER_REF_UNDEFINED',
        where,
        `引用了未在 §18.4 定义的 blocker：${id}`
      ));
    }
  }
  return blockers;
}

function parseSlices(markdown, where, findings, blockers) {
  const table = parseFirstTable(extractSection(markdown, '13.1'));
  const slices = new Map();
  if (!table) {
    findings.push(makeFinding('SLICE_TABLE_MISSING', where, '未找到 §13.1 当前执行面板。'));
    return slices;
  }

  if (
    table.header.length !== SLICE_HEADERS.length ||
    SLICE_HEADERS.some((token, index) => headerToken(table.header[index]) !== token)
  ) {
    findings.push(makeFinding(
      'SLICE_TABLE_SCHEMA_INVALID',
      `${where} §13.1`,
      '§13.1 执行面板必须完整使用 10 列目标 schema，并分离 lifecycle、authority、blockerRefs 与 authority 上限。'
    ));
  }

  const definitions = [];
  for (const cells of table.rows) {
    const id = firstId(cells[0], 'W');
    if (!id) continue;
    definitions.push(id);
    const lifecycle = plain(cells[1]);
    const authority = plain(cells[2]);
    const blockerIds = extractIds(cells[3], 'BLK');
    const capMatch = /\bcap=(unsupported|candidate|fixture-confirmed|partial|native-verified|unverified)\b/.exec(
      plain(cells[9])
    );
    const authorityCap = capMatch?.[1] ?? null;
    if (!slices.has(id)) {
      slices.set(id, { id, lifecycle, authority, blockerIds, authorityCap });
    }

    if (cells.length !== SLICE_HEADERS.length) {
      findings.push(makeFinding(
        'SLICE_ROW_SCHEMA_INVALID',
        `${where} §13.1 ${id}`,
        `切片行必须正好包含 ${SLICE_HEADERS.length} 列，实际为 ${cells.length} 列。`
      ));
    }
    for (const [index, label] of [
      [4, '目标能力'],
      [5, '可独立验收切片'],
      [6, '硬前置'],
      [7, '主要入口'],
      [8, 'required validation'],
      [9, 'authority 上限']
    ]) {
      if (!hasMeaningfulValue(cells[index])) {
        findings.push(makeFinding(
          'SLICE_FIELD_REQUIRED',
          `${where} §13.1 ${id}`,
          `切片的${label}不能为空或使用占位符。`
        ));
      }
    }

    if (!ALLOWED_SLICE_LIFECYCLES.has(lifecycle)) {
      findings.push(makeFinding(
        'SLICE_LIFECYCLE_INVALID',
        `${where} §13.1 ${id}`,
        `切片 lifecycle 非法：${lifecycle || '(空)'}`
      ));
    }
    if (!ALLOWED_AUTHORITIES.has(authority)) {
      findings.push(makeFinding(
        'SLICE_AUTHORITY_INVALID',
        `${where} §13.1 ${id}`,
        `切片 authority 非法：${authority || '(空)'}`
      ));
    }
    if (authorityCap === null) {
      findings.push(makeFinding(
        'SLICE_AUTHORITY_CAP_INVALID',
        `${where} §13.1 ${id}`,
        'authority 上限必须包含一个 cap=<authority> 机器标记。'
      ));
    } else if (
      ALLOWED_AUTHORITIES.has(authority) &&
      AUTHORITY_RANK.get(authority) > AUTHORITY_RANK.get(authorityCap)
    ) {
      findings.push(makeFinding(
        'SLICE_AUTHORITY_EXCEEDS_CAP',
        `${where} §13.1 ${id}`,
        `当前 authority=${authority} 超过 authority 上限 cap=${authorityCap}。`
      ));
    }
    if (lifecycle === 'blocked' && blockerIds.length === 0) {
      findings.push(makeFinding(
        'SLICE_BLOCKER_REQUIRED',
        `${where} §13.1 ${id}`,
        'blocked 切片必须在 blockerRefs 引用至少一个 BLK-*。'
      ));
    }
    if (lifecycle !== 'blocked' && blockerIds.length > 0) {
      findings.push(makeFinding(
        'SLICE_BLOCKER_STATE_MISMATCH',
        `${where} §13.1 ${id}`,
        `${lifecycle || '(空)'} 切片不能保留活动 blockerRefs；有 blocker 时 lifecycle 必须为 blocked。`
      ));
    }
    if ((lifecycle === 'ready' || lifecycle === 'active')
      && blockerIds.length === 0
      && asksForUserActionWithoutBlocker(cells.slice(4, 9).join(' '))) {
      findings.push(makeFinding(
        'USER_ACTION_WITHOUT_ACTIVE_BLOCKER',
        `${where} §13.1 ${id}`,
        'ready/active 切片没有活动 blockerRefs，不得把工程工作描述为需要用户裁定、授权、提供或介入。'
      ));
    }
    for (const blockerId of blockerIds) {
      if (!blockers.has(blockerId)) {
        findings.push(makeFinding(
          'SLICE_BLOCKER_UNDEFINED',
          `${where} §13.1 ${id}`,
          `切片引用了未定义 blocker：${blockerId}`
        ));
      } else if (!blockers.get(blockerId).impactSliceIds.includes(id)) {
        findings.push(makeFinding(
          'SLICE_BLOCKER_IMPACT_MISSING',
          `${where} §13.1 ${id}`,
          `blocker ${blockerId} 的影响 Gate/切片列未声明该切片。`
        ));
      }
    }
  }

  for (const [id, count] of countBy(definitions)) {
    if (count > 1) {
      findings.push(makeFinding(
        'SLICE_ID_DUPLICATE',
        `${where} §13.1`,
        `切片 ID 重复定义 ${count} 次：${id}`
      ));
    }
  }
  return slices;
}

function parseAndValidateUnfrozenValidations(markdown, where, findings, slices) {
  const section = extractSection(markdown, '13.4');
  if (section === null) {
    findings.push(makeFinding(
      'VALIDATION_SECTION_MISSING',
      where,
      '未找到 §13.4 required validation 冻结约定。'
    ));
    return;
  }

  const marker = '当前显式为 `validation-unfrozen`（需后续冻结）：';
  const markerIndex = section.indexOf(marker);
  if (markerIndex === -1) {
    findings.push(makeFinding(
      'VALIDATION_UNFROZEN_LIST_MISSING',
      `${where} §13.4`,
      '§13.4 必须显式列出 validation-unfrozen 切片。'
    ));
    return;
  }

  const lines = section.slice(markerIndex + marker.length).split(/\r?\n/);
  let listStarted = false;
  for (const line of lines) {
    const match = /^-\s+`(W-[A-Z0-9-]+)`\s*[：:]/.exec(line.trim());
    if (match) {
      listStarted = true;
      const sliceId = match[1];
      const slice = slices.get(sliceId);
      if (!slice) {
        findings.push(makeFinding(
          'VALIDATION_UNFROZEN_SLICE_UNKNOWN',
          `${where} §13.4 ${sliceId}`,
          `validation-unfrozen 引用了 §13.1 未定义的切片：${sliceId}`
        ));
      } else if (slice.lifecycle === 'completed' || slice.lifecycle === 'superseded') {
        findings.push(makeFinding(
          'VALIDATION_UNFROZEN_TERMINAL_SLICE',
          `${where} §13.4 ${sliceId}`,
          `${slice.lifecycle} 切片不能继续保留在 validation-unfrozen 列表中。`
        ));
      }
      continue;
    }
    if (listStarted && line.trim() !== '') break;
  }
}

function parseAndValidateActiveClaims(markdown, where, findings, slices) {
  const table = parseFirstTable(extractSection(markdown, '13.1.1'));
  if (!table) {
    findings.push(makeFinding(
      'ACTIVE_CLAIM_TABLE_MISSING',
      where,
      '未找到 §13.1.1 active claim 注册表。'
    ));
    return;
  }
  if (
    table.header.length !== ACTIVE_CLAIM_HEADERS.length ||
    ACTIVE_CLAIM_HEADERS.some((token, index) => headerToken(table.header[index]) !== token)
  ) {
    findings.push(makeFinding(
      'ACTIVE_CLAIM_TABLE_SCHEMA_INVALID',
      `${where} §13.1.1`,
      'active claim 表必须完整包含 sliceId、claimId、owner、claimedAt、heartbeatAt、recoveryTrigger。'
    ));
  }

  const claims = [];
  for (const cells of table.rows) {
    const sliceId = firstId(cells[0], 'W');
    if (!sliceId) continue;
    const claimId = plain(cells[1]);
    claims.push({ sliceId, claimId });
    if (cells.length !== ACTIVE_CLAIM_HEADERS.length) {
      findings.push(makeFinding(
        'ACTIVE_CLAIM_ROW_SCHEMA_INVALID',
        `${where} §13.1.1 ${sliceId}`,
        `active claim 行必须正好包含 ${ACTIVE_CLAIM_HEADERS.length} 列。`
      ));
    }
    for (const [index, label] of [[1, 'claimId'], [2, 'owner'], [3, 'claimedAt'], [4, 'heartbeatAt'], [5, 'recoveryTrigger']]) {
      if (!hasMeaningfulValue(cells[index])) {
        findings.push(makeFinding(
          'ACTIVE_CLAIM_FIELD_REQUIRED',
          `${where} §13.1.1 ${sliceId}`,
          `active claim 的 ${label} 不能为空或使用占位符。`
        ));
      }
    }
    const slice = slices.get(sliceId);
    if (!slice) {
      findings.push(makeFinding(
        'ACTIVE_CLAIM_SLICE_UNDEFINED',
        `${where} §13.1.1 ${sliceId}`,
        'active claim 引用了执行面板中不存在的切片。'
      ));
    } else if (slice.lifecycle !== 'active') {
      findings.push(makeFinding(
        'ACTIVE_CLAIM_SLICE_NOT_ACTIVE',
        `${where} §13.1.1 ${sliceId}`,
        `claim 只能属于 lifecycle=active 的切片，当前为 ${slice.lifecycle}。`
      ));
    }
    const claimedAt = Date.parse(plain(cells[3]));
    const heartbeatAt = Date.parse(plain(cells[4]));
    if (!Number.isFinite(claimedAt) || !Number.isFinite(heartbeatAt) || heartbeatAt < claimedAt) {
      findings.push(makeFinding(
        'ACTIVE_CLAIM_TIME_INVALID',
        `${where} §13.1.1 ${sliceId}`,
        'claimedAt/heartbeatAt 必须是合法 ISO 时间，且 heartbeatAt 不早于 claimedAt。'
      ));
    }
  }

  for (const slice of slices.values()) {
    const count = claims.filter((claim) => claim.sliceId === slice.id).length;
    if (slice.lifecycle === 'active' && count !== 1) {
      findings.push(makeFinding(
        'ACTIVE_SLICE_CLAIM_REQUIRED',
        `${where} §13.1 ${slice.id}`,
        `active 切片必须在 §13.1.1 恰好登记一个 claim，当前为 ${count} 个。`
      ));
    }
  }
  for (const [claimId, count] of countBy(claims.map((claim) => claim.claimId).filter(Boolean))) {
    if (count > 1) {
      findings.push(makeFinding(
        'ACTIVE_CLAIM_ID_DUPLICATE',
        `${where} §13.1.1`,
        `claimId 重复 ${count} 次：${claimId}`
      ));
    }
  }
}

function parseReleaseGateIds(markdown, where, findings) {
  const table = parseFirstTable(extractSection(markdown, '18.1'));
  if (!table) {
    findings.push(makeFinding('GATE_LIST_MISSING', where, '未找到 §18.1 发布 Gate 表。'));
    return [];
  }
  const ids = table.rows.map((cells) => firstId(cells[0], 'REL')).filter(Boolean);
  if (ids.length === 0) {
    findings.push(makeFinding('GATE_LIST_EMPTY', `${where} §18.1`, '§18.1 未定义任何 REL-* Gate。'));
  }
  for (const [id, count] of countBy(ids)) {
    if (count > 1) {
      findings.push(makeFinding(
        'GATE_LIST_DUPLICATE',
        `${where} §18.1`,
        `§18.1 Gate 重复定义 ${count} 次：${id}`
      ));
    }
  }
  const actual = new Set(ids);
  for (const requiredId of REQUIRED_GATE_IDS) {
    if (!actual.has(requiredId)) {
      findings.push(makeFinding(
        'GATE_REQUIRED_MISSING',
        `${where} §18.1`,
        `V0.5 固定 Gate 集合缺少：${requiredId}`
      ));
    }
  }
  for (const id of actual) {
    if (!REQUIRED_GATE_IDS.includes(id)) {
      findings.push(makeFinding(
        'GATE_REQUIRED_EXTRA',
        `${where} §18.1`,
        `§18.1 包含不在 V0.5 固定 Gate 集合中的 ID：${id}`
      ));
    }
  }
  return ids;
}

function evidenceIsSealed(evidence, id) {
  const record = evidence.get(id);
  return record?.type === 'sealed-current-run' && record.sealValid;
}

function evidenceHasClaim(evidence, id, marker) {
  const record = evidence.get(id);
  return evidenceIsSealed(evidence, id) && record.claim.includes(marker);
}

/**
 * Gate 主题域注册表。
 *
 * passed Gate 的 freshness 只取决于“与该 Gate 声明相关的主题域自 Evidence
 * 锚点提交以来是否变更”，与全工作树字节、未提交改动或未跟踪文件无关。
 * Gate 有效性是提交图的性质，不是工作树的性质：运行时自动改写的文件、
 * 无关路线的代码改动、交接书其他章节的沉淀都不应使已通过的 Gate 失效；
 * 偷改主题域（如范围冻结块或范围校验脚本）则必须立即失败关闭。
 *
 * 尚未定义主题域的 Gate 尝试 passed 会失败关闭（GATE_SUBJECT_SET_UNDEFINED），
 * 强制未来通过者显式枚举主题域。scope-excluded 的裁定主题就是范围裁定本身，
 * 因此复用 REL-SCOPE 的主题域。
 */
const RELEASE_SCOPE_PROPOSAL_SUBJECT = Object.freeze({
  id: 'release-scope-proposal',
  beginMarker: '<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->',
  endMarker: '<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->'
});
const SCOPE_SUBJECT_SET = Object.freeze({
  files: Object.freeze([
    'scripts/generate-handoff-fingerprint.mjs',
    'scripts/handoff-integrity-lib.mjs',
    'scripts/verify-handoff-integrity-fixtures.mjs',
    'scripts/verify-handoff-integrity.mjs',
    'scripts/verify-release-scope.mjs',
    'scripts/verify-release-scope-fixtures.mjs'
  ]),
  handoffSections: Object.freeze([]),
  handoffBlocks: Object.freeze([RELEASE_SCOPE_PROPOSAL_SUBJECT])
});
const GATE_SUBJECT_SETS = new Map([
  ['REL-SCOPE', SCOPE_SUBJECT_SET]
]);

export function handoffSectionSubjectRef(sectionId) {
  return `handoff-section:${sectionId}`;
}

export function handoffBlockSubjectRef(blockId) {
  return `handoff-block:${blockId}`;
}

function subjectRefsFor(subjectSet) {
  return [
    ...subjectSet.files,
    ...subjectSet.handoffSections.map(handoffSectionSubjectRef),
    ...(subjectSet.handoffBlocks ?? []).map((block) => handoffBlockSubjectRef(block.id))
  ];
}

export function gateSubjectRegistry() {
  const gates = [...GATE_SUBJECT_SETS].map(([gateId, set]) => ({
    gateId,
    files: [...set.files],
    handoffSections: [...set.handoffSections],
    handoffBlocks: [...(set.handoffBlocks ?? [])]
  }));
  const allHandoffBlocks = new Map();
  for (const gate of gates) {
    for (const block of gate.handoffBlocks) allHandoffBlocks.set(block.id, block);
  }
  return Object.freeze({
    gates,
    scopeExclusion: {
      files: [...SCOPE_SUBJECT_SET.files],
      handoffSections: [...SCOPE_SUBJECT_SET.handoffSections],
      handoffBlocks: [...SCOPE_SUBJECT_SET.handoffBlocks]
    },
    allFiles: [...new Set(gates.flatMap((entry) => entry.files))],
    allHandoffSections: [...new Set(gates.flatMap((entry) => entry.handoffSections))],
    allHandoffBlocks: [...allHandoffBlocks.values()]
  });
}

/**
 * 扫描 §17.1，返回全部格式合法 sealed Evidence 的锚点提交（写入时 HEAD）。
 * 供 freshness 上下文生成器按锚点计算祖先关系与主题域差异。
 */
export function collectSealAnchors(markdown) {
  const scanFindings = [];
  const evidence = parseEvidence(markdown, 'seal-anchor-scan', scanFindings);
  const anchors = new Set();
  for (const record of evidence.values()) {
    if (record.type === 'sealed-current-run' && record.seal?.formatValid === true) {
      anchors.add(record.seal.fields.head);
    }
  }
  return [...anchors];
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
function evaluateEvidenceFreshness(evidence, id, subjectRefs, freshnessContext) {
  if (freshnessContext === undefined) return 'static-mode';
  if (!evidenceIsSealed(evidence, id)) return 'not-sealed';
  const anchor = evidence.get(id).seal.fields.head;
  const anchorState = freshnessContext.anchors?.[anchor];
  if (!anchorState || anchorState.subjectScanAvailable === false) return 'unverifiable';
  if (anchorState.isAncestor !== true) return 'stale';
  const changed = new Set(anchorState.changedSubjects ?? []);
  return subjectRefs.some((ref) => changed.has(ref)) ? 'stale' : 'fresh';
}

function checkEvidenceFreshness(
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

function parseAndValidateGateMatrix(
  markdown,
  where,
  findings,
  releaseGateIds,
  slices,
  blockers,
  evidence,
  freshnessContext
) {
  const table = parseFirstTable(extractSection(markdown, '18.3'));
  if (!table) {
    findings.push(makeFinding('GATE_MATRIX_MISSING', where, '未找到 §18.3 Gate 覆盖矩阵。'));
    return new Map();
  }

  const requiredHeaders = new Map([
    [3, 'gatestate'],
    [4, 'applicability'],
    [5, 'evidence/blockerrefs']
  ]);
  if (
    table.header.length < 7 ||
    [...requiredHeaders].some(([index, token]) => headerToken(table.header[index]) !== token)
  ) {
    findings.push(makeFinding(
      'GATE_MATRIX_SCHEMA_INVALID',
      `${where} §18.3`,
      '§18.3 Gate 矩阵必须使用 7 列目标 schema，并分离 gateState、applicability 与 Evidence/blockerRefs。'
    ));
  }

  const rows = table.rows
    .map((cells) => ({ cells, id: firstId(cells[0], 'REL') }))
    .filter((row) => row.id !== null);
  const releaseGateSet = new Set(releaseGateIds);
  const rowCounts = countBy(rows.map((row) => row.id));

  for (const gateId of new Set(releaseGateIds)) {
    const count = rowCounts.get(gateId) ?? 0;
    if (count === 0) {
      findings.push(makeFinding(
        'GATE_MISSING_IN_MATRIX',
        `${where} §18.3`,
        `§18.1 Gate 未在 §18.3 出现：${gateId}`
      ));
    } else if (count > 1) {
      findings.push(makeFinding(
        'GATE_MATRIX_DUPLICATE',
        `${where} §18.3`,
        `Gate 在 §18.3 重复 ${count} 行：${gateId}`
      ));
    }
  }
  for (const gateId of rowCounts.keys()) {
    if (!releaseGateSet.has(gateId)) {
      findings.push(makeFinding(
        'GATE_MATRIX_EXTRA',
        `${where} §18.3`,
        `§18.3 包含 §18.1 未定义的额外 Gate：${gateId}`
      ));
    }
  }

  const firstRows = new Map();
  for (const row of rows) if (!firstRows.has(row.id)) firstRows.set(row.id, row);
  const scopeRow = firstRows.get('REL-SCOPE');
  const scopeEvidenceIds = scopeRow ? extractIds(scopeRow.cells[5], 'EV') : [];
  const scopePassedAndSealed = scopeRow
    ? plain(scopeRow.cells[3]) === 'passed' &&
      scopeEvidenceIds.some((id) => evidenceHasClaim(evidence, id, 'scope-ruling:user-approved'))
    : false;
  const parsedGates = new Map();

  for (const { id: gateId, cells } of rows) {
    const gateState = plain(cells[3]);
    const applicability = plain(cells[4]);
    const sliceIds = extractIds(cells[2], 'W');
    const blockerIds = extractIds(cells[5], 'BLK');
    const evidenceIds = extractIds(cells[5], 'EV');
    const successor = plain(cells[6]);
    const location = `${where} §18.3 ${gateId}`;
    if (!parsedGates.has(gateId)) {
      parsedGates.set(gateId, { id: gateId, gateState, applicability, sliceIds, blockerIds, evidenceIds });
    }

    if (LEGACY_GATE_STATES.has(gateState) || gateState.startsWith('blocked:')) {
      findings.push(makeFinding(
        'GATE_STATE_LEGACY_TOKEN',
        location,
        `Gate 使用了已废弃状态 token：${gateState}`
      ));
    } else if (!ALLOWED_GATE_STATES.has(gateState)) {
      findings.push(makeFinding(
        'GATE_STATE_INVALID',
        location,
        `gateState 非法：${gateState || '(空)'}`
      ));
    }

    if (!ALLOWED_APPLICABILITY.has(applicability)) {
      findings.push(makeFinding(
        'GATE_APPLICABILITY_INVALID',
        location,
        `applicability 非法：${applicability || '(空)'}`
      ));
    }
    if (gateState !== 'blocked'
      && blockerIds.length === 0
      && asksForUserActionWithoutBlocker(successor)) {
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
        'REL-SCOPE 已通过后，功能 Gate 必须明确为 in-scope 或 scope-excluded，不能继续 pending-scope。'
      ));
    }

    for (const sliceId of sliceIds) {
      if (!slices.has(sliceId)) {
        findings.push(makeFinding(
          'GATE_SLICE_UNKNOWN',
          location,
          `Gate 引用了 §13.1 不存在的切片：${sliceId}`
        ));
      }
    }

    if (gateState === 'open') {
      if (applicability === 'scope-excluded') {
        findings.push(makeFinding(
          'GATE_OPEN_SCOPE_EXCLUDED',
          location,
          'open Gate 不能标记为 scope-excluded。'
        ));
      }
      const knownSlices = sliceIds.map((id) => slices.get(id)).filter(Boolean);
      const terminalSlices = knownSlices.filter(
        (slice) => slice.lifecycle === 'completed' || slice.lifecycle === 'superseded'
      );
      for (const slice of terminalSlices) {
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
          'blocked Gate 必须在 Evidence/blockerRefs 引用至少一个 BLK-*。'
        ));
      }
      for (const blockerId of blockerIds) {
        if (!blockers.has(blockerId)) {
          findings.push(makeFinding(
            'GATE_BLOCKER_UNDEFINED',
            location,
            `blocked Gate 引用了未定义 blocker：${blockerId}`
          ));
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
          findings.push(makeFinding(
            'GATE_EVIDENCE_UNDEFINED',
            location,
            `passed Gate 引用了未定义 Evidence：${evidenceId}`
          ));
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
        const subjectSet = GATE_SUBJECT_SETS.get(gateId);
        if (!subjectSet) {
          findings.push(makeFinding(
            'GATE_SUBJECT_SET_UNDEFINED',
            location,
            `passed Gate ${gateId} 尚未登记 freshness 主题域，失败关闭。`
          ));
        } else {
          const freshnessEvidenceIds = gateId === 'REL-SCOPE'
            ? evidenceIds.filter((id) => evidenceHasClaim(evidence, id, 'scope-ruling:user-approved'))
            : evidenceIds;
          const freshnessFinding = checkEvidenceFreshness(
            location,
            freshnessEvidenceIds,
            evidence,
            subjectRefsFor(subjectSet),
            freshnessContext,
            'GATE_EVIDENCE_STALE',
            'passed Gate 的 sealed Evidence 锚点之后，相关主题域发生变化。若冻结范围语义未变，由工程侧重跑验证并重封存；只有实际范围变化才需要新的用户裁定。'
          );
          if (freshnessFinding) findings.push(freshnessFinding);
        }
      }
    }

    if (applicability === 'pending-scope' && gateState === 'passed') {
      findings.push(makeFinding(
        'GATE_PENDING_SCOPE_PASSED',
        location,
        'pending-scope Gate 不能进入 passed。'
      ));
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
        const freshnessFinding = checkEvidenceFreshness(
          location,
          approvedExclusionIds,
          evidence,
          subjectRefsFor(SCOPE_SUBJECT_SET),
          freshnessContext,
          'GATE_SCOPE_EXCLUSION_EVIDENCE_STALE',
          '范围排除 Evidence 锚点之后，冻结范围主题域发生变化；工程侧必须核对语义并重跑验证，实际范围变化仍需新的用户裁定。'
        );
        if (freshnessFinding) findings.push(freshnessFinding);
      }
    }
  }
  return parsedGates;
}

function validateBlockerImpactClosure(where, findings, blockers, slices, gates) {
  for (const blocker of blockers.values()) {
    for (const sliceId of blocker.impactSliceIds) {
      const slice = slices.get(sliceId);
      if (!slice) {
        findings.push(makeFinding(
          'BLOCKER_IMPACT_SLICE_UNDEFINED',
          `${where} §18.4 ${blocker.id}`,
          `影响对象引用了 §13.1 不存在的切片：${sliceId}`
        ));
      } else if (slice.lifecycle === 'blocked' && !slice.blockerIds.includes(blocker.id)) {
        findings.push(makeFinding(
          'BLOCKER_IMPACT_SLICE_REF_MISSING',
          `${where} §18.4 ${blocker.id}`,
          `blocked 切片 ${sliceId} 未反向引用该 blocker。`
        ));
      }
    }
    for (const gateId of blocker.impactGateIds) {
      const gate = gates.get(gateId);
      if (!gate) {
        findings.push(makeFinding(
          'BLOCKER_IMPACT_GATE_UNDEFINED',
          `${where} §18.4 ${blocker.id}`,
          `影响对象引用了 §18.3 不存在的 Gate：${gateId}`
        ));
      } else if (gate.gateState === 'blocked' && !gate.blockerIds.includes(blocker.id)) {
        findings.push(makeFinding(
          'BLOCKER_IMPACT_GATE_REF_MISSING',
          `${where} §18.4 ${blocker.id}`,
          `blocked Gate ${gateId} 未反向引用该 blocker。`
        ));
      }
    }
  }
}

/**
 * 对 handoff Markdown 做无副作用治理校验。
 *
 * @param {string} markdown 完整的 V0.5 handoff Markdown。
 * @param {{ source?: string }} options 输出 findings 使用的来源标识。
 * @returns {{ ok: boolean, findings: Array<{severity: string, code: string, where: string, message: string}> }}
 */
export function validateHandoffGovernance(markdown, options = {}) {
  const where = options.source ?? 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';
  const findings = [];
  if (typeof markdown !== 'string') {
    findings.push(makeFinding('HANDOFF_INPUT_INVALID', where, 'handoff 内容必须是字符串。'));
    return { ok: false, findings };
  }

  const evidence = parseEvidence(markdown, where, findings);
  const blockers = parseBlockers(markdown, where, findings, evidence);
  const slices = parseSlices(markdown, where, findings, blockers);
  parseAndValidateActiveClaims(markdown, where, findings, slices);
  parseAndValidateUnfrozenValidations(markdown, where, findings, slices);
  const releaseGateIds = parseReleaseGateIds(markdown, where, findings);
  const gates = parseAndValidateGateMatrix(
    markdown,
    where,
    findings,
    releaseGateIds,
    slices,
    blockers,
    evidence,
    options.freshnessContext
  );
  validateBlockerImpactClosure(where, findings, blockers, slices, gates);
  return { ok: findings.length === 0, findings };
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
