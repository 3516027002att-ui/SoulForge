import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';
const BEGIN_MARKER = '<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->';
const END_MARKER = '<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_END -->';

const EXPECTED_GATES = [
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
];

const REQUIRED_SCOPE_ITEMS = new Map([
  ['SCOPE-SEKIRO-BUILD', { capabilityId: 'H-RUNTIME', gateId: 'REL-SCOPE' }],
  ['SCOPE-A-WORKSPACE', { capabilityId: 'A-WORKSPACE', gateId: 'REL-A' }],
  ['SCOPE-A-RECOVERY', { capabilityId: 'A-RECOVERY', gateId: 'REL-A' }],
  ['SCOPE-DFLT', { capabilityId: 'B-DFLT', gateId: 'REL-B' }],
  ['SCOPE-KRAK', { capabilityId: 'B-KRAK', gateId: 'REL-B' }],
  ['SCOPE-BND4', { capabilityId: 'B-BND4', gateId: 'REL-B' }],
  ['SCOPE-FMG', { capabilityId: 'C-FMG', gateId: 'REL-C' }],
  ['SCOPE-PARAM', { capabilityId: 'C-PARAM', gateId: 'REL-C' }],
  ['SCOPE-EMEVD', { capabilityId: 'C-EMEVD', gateId: 'REL-C' }],
  ['SCOPE-MSB', { capabilityId: 'C-MSB', gateId: 'REL-C' }],
  ['SCOPE-BEHAVIOR-ANIMATION', { capabilityId: 'D-BEHAVIOR', gateId: 'REL-D' }],
  ['SCOPE-BEHAVIOR-TAE', { capabilityId: 'D-BEHAVIOR', gateId: 'REL-D' }],
  ['SCOPE-BEHAVIOR-ESD', { capabilityId: 'D-BEHAVIOR', gateId: 'REL-D' }],
  ['SCOPE-BEHAVIOR-SCRIPT', { capabilityId: 'D-BEHAVIOR', gateId: 'REL-D' }],
  ['SCOPE-ASSETS', { capabilityId: 'E-ASSET', gateId: 'REL-E' }],
  ['SCOPE-ASSET-FLVER', { capabilityId: 'E-ASSET', gateId: 'REL-E' }],
  ['SCOPE-ASSET-TPF', { capabilityId: 'E-ASSET', gateId: 'REL-E' }],
  ['SCOPE-ASSET-MTD', { capabilityId: 'E-ASSET', gateId: 'REL-E' }],
  ['SCOPE-ASSET-COLLISION', { capabilityId: 'E-ASSET', gateId: 'REL-E' }],
  ['SCOPE-ASSET-NAVIGATION', { capabilityId: 'E-ASSET', gateId: 'REL-E' }],
  ['SCOPE-ASSET-OPEN-CONVERSION', { capabilityId: 'E-ASSET', gateId: 'REL-E' }],
  ['SCOPE-EDITORS', { capabilityId: 'F-EDITORS', gateId: 'REL-F' }],
  ['SCOPE-AI', { capabilityId: 'G-AGENT', gateId: 'REL-G' }],
  ['SCOPE-RUNTIME', { capabilityId: 'H-RUNTIME', gateId: 'REL-H' }],
  ['SCOPE-RELEASE', { capabilityId: 'H-RUNTIME', gateId: 'REL-H' }],
  ['SCOPE-RENDERING', { capabilityId: 'I-RENDER', gateId: 'REL-I' }],
  ['SCOPE-COMPLIANCE', { capabilityId: 'H-RUNTIME', gateId: 'REL-COMPLIANCE' }]
]);

const ALLOWED_PROPOSAL_STATUS = new Set(['awaiting-user-ruling', 'user-approved']);
const ALLOWED_ITEM_DECISION = new Set(['awaiting-user-ruling', 'user-approved']);
const ALLOWED_RULING_STATUS = new Set(['pending-user-ruling', 'user-approved']);
const ALLOWED_SUPPORT = new Set(['supported', 'unsupported']);
const ALLOWED_GATE_STATE = new Set(['open', 'blocked', 'passed']);
const ALLOWED_BUILD_MATCH_POLICY = new Set(['file-product-version-major-minor']);
const ALLOWED_AUTHORITY = new Set([
  'unsupported',
  'candidate',
  'fixture-confirmed',
  'partial',
  'native-verified',
  'unverified'
]);
const ALLOWED_SUBJECT_KIND = new Set([
  'game-build',
  'workspace',
  'recovery',
  'container',
  'resource',
  'behavior-animation',
  'asset',
  'editor',
  'ai',
  'runtime',
  'release',
  'rendering',
  'compliance'
]);
const ALLOWED_REGISTRY_KIND = new Set([
  'private-fixture',
  'historical-private-corpus',
  'release-corpus'
]);

const cliArgs = process.argv.slice(2);
const proposalMode = cliArgs.includes('--proposal');
const inputArgs = cliArgs.filter((arg) => arg.startsWith('--input='));
const unknownArgs = cliArgs.filter((arg) => arg !== '--proposal' && !arg.startsWith('--input='));
const handoffInput = inputArgs.length === 1 ? inputArgs[0].slice('--input='.length) : HANDOFF;
const handoffWhere = inputArgs.length === 0 ? HANDOFF : 'scope-fixture-input';
const findings = [];
const add = (code, where, message) => findings.push({ severity: 'error', code, where, message });

function countOccurrences(text, token) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function sliceBetween(text, startToken, endToken) {
  const start = text.indexOf(startToken);
  if (start === -1) return null;
  const contentStart = start + startToken.length;
  const end = text.indexOf(endToken, contentStart);
  if (end === -1) return null;
  return text.slice(contentStart, end);
}

function parseFirstColumnIds(section, prefixPattern) {
  if (section === null) return new Set();
  const ids = new Set();
  const row = new RegExp(`^\\|\\s*\`(${prefixPattern}[A-Z0-9-]*)\`\\s*\\|`, 'gm');
  let match;
  while ((match = row.exec(section)) !== null) ids.add(match[1]);
  return ids;
}

function parseGateStates(section) {
  const states = new Map();
  if (section === null) return states;
  const row = /^\|\s*`(REL-[A-Z0-9-]+)`\s*\|[^|\n]*\|[^|\n]*\|\s*`(open|blocked|passed)`\s*\|/gm;
  let match;
  while ((match = row.exec(section)) !== null) states.set(match[1], match[2]);
  return states;
}

function isStringArray(value, { nonEmpty = false } = {}) {
  return Array.isArray(value)
    && (!nonEmpty || value.length > 0)
    && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function hasAbsolutePath(value) {
  return /[A-Za-z]:[\\/]/.test(value)
    || /\\\\[^\\\s]+[\\/]/.test(value)
    || /\bfile:\/\//i.test(value)
    || /\/(?:Users|home)\//i.test(value);
}

function checkPrivateRegistryFields(value, where = 'proposal') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkPrivateRegistryFields(item, `${where}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(localPath|absolutePath|sha256)$/i.test(key)) {
      add('PRIVATE_REGISTRY_DETAIL_FORBIDDEN', `${where}.${key}`, '提案不得内嵌私有路径或样本哈希。');
    }
    checkPrivateRegistryFields(child, `${where}.${key}`);
  }
}

if (unknownArgs.length > 0) {
  add('UNKNOWN_ARGUMENT', 'argv', `未知参数：${unknownArgs.join(', ')}`);
}
if (inputArgs.length > 1 || handoffInput.length === 0) {
  add('INPUT_ARGUMENT_INVALID', 'argv', '--input 只能提供一次且路径不能为空。');
}

let handoff = '';
try {
  handoff = readFileSync(resolve(process.cwd(), handoffInput), 'utf8').replace(/\r\n/g, '\n');
} catch (error) {
  add('HANDOFF_READ_FAILED', handoffWhere, error instanceof Error ? error.message : String(error));
}

const beginCount = countOccurrences(handoff, BEGIN_MARKER);
const endCount = countOccurrences(handoff, END_MARKER);
if (beginCount !== 1 || endCount !== 1) {
  add(
    'PROPOSAL_BLOCK_NOT_UNIQUE',
    handoffWhere,
    `scope proposal marker 必须各出现一次，实际 begin=${beginCount}, end=${endCount}。`
  );
}

let proposal = null;
let rawJson = '';
if (beginCount === 1 && endCount === 1) {
  const block = sliceBetween(handoff, BEGIN_MARKER, END_MARKER);
  if (block === null) {
    add('PROPOSAL_BLOCK_ORDER_INVALID', handoffWhere, 'scope proposal marker 顺序非法。');
  } else {
    const fenced = block.match(/^\s*```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (!fenced) {
      add('PROPOSAL_JSON_FENCE_INVALID', handoffWhere, 'scope proposal block 必须只包含一个 json fenced block。');
    } else {
      rawJson = fenced[1];
      try {
        proposal = JSON.parse(rawJson);
      } catch (error) {
        add('PROPOSAL_JSON_INVALID', handoffWhere, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

const capabilitySection = sliceBetween(handoff, '### 3.1 路线依赖与解锁关系', '### 3.2 Authority 解锁规则');
const gateSection = sliceBetween(handoff, '### 18.1 可判定的发布门槛', '### 18.2 发布前必须裁定但当前尚未裁定的量化项');
const evidenceSection = sliceBetween(handoff, '### 17.1 当前证据索引', '---\n\n## 18. V0.5 完成定义');
const gateMatrixSection = sliceBetween(handoff, '### 18.3 Gate 覆盖矩阵与后继切片', '### 18.4 结构化 blocker 注册表');
const blockerSection = sliceBetween(handoff, '### 18.4 结构化 blocker 注册表', '---\n\n## 19. 保留文档');
const capabilityIds = parseFirstColumnIds(capabilitySection, '[A-I]-');
const gateIds = parseFirstColumnIds(gateSection, 'REL-');
const evidenceIds = parseFirstColumnIds(evidenceSection, 'EV-');
const gateMatrixStates = parseGateStates(gateMatrixSection);
const blockerIds = parseFirstColumnIds(blockerSection, 'BLK-');

if (capabilityIds.size === 0) add('CAPABILITY_INDEX_EMPTY', '§3.1', '未解析到 capability ID。');
if (gateIds.size === 0) add('GATE_INDEX_EMPTY', '§18.1', '未解析到 Gate ID。');
if (evidenceIds.size === 0) add('EVIDENCE_INDEX_EMPTY', '§17.1', '未解析到 Evidence ID。');
if (gateMatrixStates.size === 0) add('GATE_MATRIX_EMPTY', '§18.3', '未解析到 Gate current state。');
if (blockerIds.size === 0) add('BLOCKER_INDEX_EMPTY', '§18.4', '未解析到 blocker ID。');

const expectedGateSet = new Set(EXPECTED_GATES);
for (const gateId of EXPECTED_GATES) {
  if (!gateIds.has(gateId)) add('REQUIRED_GATE_MISSING', '§18.1', `缺少 Gate：${gateId}`);
}
for (const gateId of gateIds) {
  if (!expectedGateSet.has(gateId)) add('UNEXPECTED_GATE', '§18.1', `未纳入 validator 的 Gate：${gateId}`);
}

if (proposal !== null) {
  if (proposal.schemaVersion !== '1.3.0') {
    add('SCHEMA_VERSION_INVALID', 'proposal.schemaVersion', 'schemaVersion 必须为 1.3.0。');
  }
  if (!/^V0\.5-SCOPE-[0-9]{8}$/.test(proposal.proposalId ?? '')) {
    add('PROPOSAL_ID_INVALID', 'proposal.proposalId', 'proposalId 必须匹配 V0.5-SCOPE-YYYYMMDD。');
  }
  if (proposal.release !== 'V0.5') {
    add('RELEASE_INVALID', 'proposal.release', 'release 必须为 V0.5。');
  }
  if (proposal.game !== 'Sekiro') {
    add('GAME_INVALID', 'proposal.game', 'game 必须精确为 Sekiro。');
  }
  if (!ALLOWED_PROPOSAL_STATUS.has(proposal.proposalStatus)) {
    add('PROPOSAL_STATUS_INVALID', 'proposal.proposalStatus', 'proposalStatus 枚举非法。');
  }
  const buildRange = proposal.gameBuildRange;
  if (buildRange === null || typeof buildRange !== 'object' || Array.isArray(buildRange)) {
    add('GAME_BUILD_RANGE_INVALID', 'proposal.gameBuildRange', 'gameBuildRange 必须为对象。');
  } else {
    if (!ALLOWED_RULING_STATUS.has(buildRange.status)) {
      add('GAME_BUILD_STATUS_INVALID', 'proposal.gameBuildRange.status', 'game build status 枚举非法。');
    }
    if (!ALLOWED_BUILD_MATCH_POLICY.has(buildRange.matchPolicy)) {
      add('GAME_BUILD_MATCH_POLICY_INVALID', 'proposal.gameBuildRange.matchPolicy', '只允许按 file/product version 的 major.minor 版本族匹配。');
    }
    if (!Array.isArray(buildRange.versionFamilies)) {
      add('GAME_VERSION_FAMILIES_INVALID', 'proposal.gameBuildRange.versionFamilies', 'versionFamilies 必须为数组。');
    }
    if (!Array.isArray(buildRange.exactBuilds)) {
      add('GAME_EXACT_BUILDS_INVALID', 'proposal.gameBuildRange.exactBuilds', 'exactBuilds 必须为数组。');
    }
    if (buildRange.unknownBuildPolicy !== 'fail-closed') {
      add('GAME_UNKNOWN_BUILD_POLICY_INVALID', 'proposal.gameBuildRange.unknownBuildPolicy', '版本族外 build 必须失败关闭。');
    }
    if (buildRange.status === 'pending-user-ruling') {
      if (buildRange.versionFamilies?.length !== 0 || buildRange.exactBuilds?.length !== 0) {
        add('PENDING_GAME_BUILDS_MUST_BE_EMPTY', 'proposal.gameBuildRange', '待裁定时不得预填版本族或精确 build。');
      }
    } else if (buildRange.status === 'user-approved') {
      if (!isStringArray(buildRange.versionFamilies, { nonEmpty: true })
        || buildRange.versionFamilies.some((family) => !/^\d+\.\d+$/.test(family))) {
        add('APPROVED_GAME_VERSION_FAMILY_INVALID', 'proposal.gameBuildRange.versionFamilies', '批准后必须列出 major.minor 形式的明确版本族。');
      }
      if (!isStringArray(buildRange.exactBuilds)) {
        add('APPROVED_GAME_EXACT_BUILDS_INVALID', 'proposal.gameBuildRange.exactBuilds', 'exactBuilds 必须为字符串数组。');
      }
    }
  }
  const ruling = proposal.ruling;
  if (ruling === null || typeof ruling !== 'object' || Array.isArray(ruling)) {
    add('RULING_METADATA_INVALID', 'proposal.ruling', 'ruling 必须为对象。');
  } else {
    if (!ALLOWED_RULING_STATUS.has(ruling.status)) {
      add('RULING_STATUS_INVALID', 'proposal.ruling.status', 'ruling status 枚举非法。');
    }
    if (ruling.status === 'pending-user-ruling') {
      for (const field of ['approvedBy', 'approvedAt', 'decisionRef']) {
        if (ruling[field] !== null) add('PENDING_RULING_METADATA_MUST_BE_NULL', `proposal.ruling.${field}`, '待裁定时不得预填用户批准元数据。');
      }
    } else if (ruling.status === 'user-approved') {
      if (typeof ruling.approvedBy !== 'string' || ruling.approvedBy.trim().length === 0) {
        add('RULING_APPROVER_MISSING', 'proposal.ruling.approvedBy', '严格冻结需要非空 approvedBy。');
      }
      if (typeof ruling.approvedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(ruling.approvedAt)
        || Number.isNaN(Date.parse(ruling.approvedAt))) {
        add('RULING_TIME_INVALID', 'proposal.ruling.approvedAt', '严格冻结需要合法 UTC ISO-8601 approvedAt。');
      }
      if (typeof ruling.decisionRef !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(ruling.decisionRef)) {
        add('RULING_DECISION_REF_INVALID', 'proposal.ruling.decisionRef', '严格冻结需要非空脱敏 decisionRef。');
      }
    }
  }
  if (proposal.proposalStatus === 'awaiting-user-ruling'
    && (buildRange?.status !== 'pending-user-ruling' || ruling?.status !== 'pending-user-ruling')) {
    add('PENDING_STATUS_MISMATCH', 'proposal', '待裁定 proposal 必须同时保留 pending build/ruling metadata。');
  }
  if (proposal.proposalStatus === 'user-approved'
    && (buildRange?.status !== 'user-approved' || ruling?.status !== 'user-approved')) {
    add('APPROVED_STATUS_MISMATCH', 'proposal', 'user-approved proposal 必须同时具有已批准 build 与 ruling metadata。');
  }
  if (proposal.unlistedPolicy !== 'unsupported') {
    add('UNLISTED_POLICY_INVALID', 'proposal.unlistedPolicy', '未列出能力必须按 unsupported 处理。');
  }
  if (proposal.corpusPolicy?.privateFixtureRegistryIsReleaseCorpus !== false) {
    add(
      'PRIVATE_FIXTURE_RELEASE_AUTHORITY_INVALID',
      'proposal.corpusPolicy.privateFixtureRegistryIsReleaseCorpus',
      '私有 fixture registry 必须明确不是 release corpus。'
    );
  }
  if (proposal.corpusPolicy?.supportedWithoutReleaseCorpus !== 'requires-open-ruling') {
    add(
      'MISSING_RELEASE_CORPUS_POLICY_INVALID',
      'proposal.corpusPolicy.supportedWithoutReleaseCorpus',
      '缺少 release corpus 的 supported 项必须保留 open ruling。'
    );
  }
  if (!Array.isArray(proposal.scopeItems)) {
    add('SCOPE_ITEMS_INVALID', 'proposal.scopeItems', 'scopeItems 必须为数组。');
  } else {
    const seenScopeIds = new Set();
    const coveredGates = new Set();
    const itemById = new Map();

    proposal.scopeItems.forEach((item, index) => {
      const where = `proposal.scopeItems[${index}]`;
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        add('SCOPE_ITEM_INVALID', where, 'scope item 必须为对象。');
        return;
      }
      const scopeItemId = item.scopeItemId;
      if (!/^SCOPE-[A-Z0-9-]+$/.test(scopeItemId ?? '')) {
        add('SCOPE_ITEM_ID_INVALID', `${where}.scopeItemId`, 'scopeItemId 格式非法。');
      } else if (seenScopeIds.has(scopeItemId)) {
        add('SCOPE_ITEM_ID_DUPLICATE', `${where}.scopeItemId`, `scopeItemId 重复：${scopeItemId}`);
      } else {
        seenScopeIds.add(scopeItemId);
        itemById.set(scopeItemId, item);
      }

      if (!capabilityIds.has(item.capabilityId)) {
        add('CAPABILITY_ID_UNKNOWN', `${where}.capabilityId`, `§3.1 未定义：${item.capabilityId ?? '(missing)'}`);
      }
      if (!ALLOWED_SUBJECT_KIND.has(item.subjectKind)) {
        add('SUBJECT_KIND_INVALID', `${where}.subjectKind`, 'subjectKind 枚举非法。');
      }
      if (typeof item.scope !== 'string' || item.scope.trim().length === 0) {
        add('SCOPE_DESCRIPTION_MISSING', `${where}.scope`, 'scope 描述不能为空。');
      }
      if (!ALLOWED_ITEM_DECISION.has(item.decisionStatus)) {
        add('ITEM_DECISION_INVALID', `${where}.decisionStatus`, 'decisionStatus 枚举非法。');
      }
      if (!ALLOWED_SUPPORT.has(item.proposedSupport)) {
        add('PROPOSED_SUPPORT_INVALID', `${where}.proposedSupport`, 'proposedSupport 枚举非法。');
      }
      if (!ALLOWED_AUTHORITY.has(item.currentAuthority)) {
        add('CURRENT_AUTHORITY_INVALID', `${where}.currentAuthority`, 'currentAuthority 枚举非法。');
      }
      if (!isStringArray(item.gateIds, { nonEmpty: true })) {
        add('ITEM_GATE_IDS_INVALID', `${where}.gateIds`, 'gateIds 必须为非空字符串数组。');
      } else {
        const localGates = new Set();
        for (const gateId of item.gateIds) {
          if (localGates.has(gateId)) add('ITEM_GATE_ID_DUPLICATE', `${where}.gateIds`, `重复 Gate：${gateId}`);
          localGates.add(gateId);
          if (!gateIds.has(gateId)) add('ITEM_GATE_ID_UNKNOWN', `${where}.gateIds`, `§18.1 未定义：${gateId}`);
          coveredGates.add(gateId);
        }
      }
      if (!isStringArray(item.operations, { nonEmpty: item.proposedSupport === 'supported' })) {
        add('OPERATIONS_INVALID', `${where}.operations`, 'supported 项必须列出至少一个 operation。');
      }
      if (!isStringArray(item.unsupportedOperations, { nonEmpty: true })) {
        add('UNSUPPORTED_OPERATIONS_INVALID', `${where}.unsupportedOperations`, '必须明确列出非范围 operation。');
      }
      if (!isStringArray(item.evidenceRefs)) {
        add('EVIDENCE_REFS_INVALID', `${where}.evidenceRefs`, 'evidenceRefs 必须为字符串数组。');
      } else {
        const seenEvidence = new Set();
        for (const evidenceRef of item.evidenceRefs) {
          if (seenEvidence.has(evidenceRef)) add('EVIDENCE_REF_DUPLICATE', `${where}.evidenceRefs`, `重复 Evidence：${evidenceRef}`);
          seenEvidence.add(evidenceRef);
          if (!evidenceIds.has(evidenceRef)) {
            add('EVIDENCE_REF_UNKNOWN', `${where}.evidenceRefs`, `§17.1 未定义：${evidenceRef}`);
          }
        }
        if (!['unverified', 'unsupported'].includes(item.currentAuthority) && item.evidenceRefs.length === 0) {
          add('EVIDENCE_REF_REQUIRED', `${where}.evidenceRefs`, '非 unverified authority 必须引用 Evidence。');
        }
      }
      if (!Array.isArray(item.registryRefs)) {
        add('REGISTRY_REFS_INVALID', `${where}.registryRefs`, 'registryRefs 必须为数组。');
      } else {
        let hasReleaseCorpus = false;
        const seenRegistryRefs = new Set();
        item.registryRefs.forEach((registry, registryIndex) => {
          const registryWhere = `${where}.registryRefs[${registryIndex}]`;
          if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
            add('REGISTRY_REF_INVALID', registryWhere, 'registry ref 必须为对象。');
            return;
          }
          if (!/^(?:fixture|historical-corpus|release-corpus):[A-Za-z0-9._=:-]+$/.test(registry.registryRef ?? '')) {
            add('REGISTRY_REF_ID_INVALID', `${registryWhere}.registryRef`, 'registryRef 必须是脱敏逻辑引用。');
          } else if (seenRegistryRefs.has(registry.registryRef)) {
            add('REGISTRY_REF_DUPLICATE', `${registryWhere}.registryRef`, `重复 registryRef：${registry.registryRef}`);
          } else {
            seenRegistryRefs.add(registry.registryRef);
          }
          if (!ALLOWED_REGISTRY_KIND.has(registry.kind)) {
            add('REGISTRY_KIND_INVALID', `${registryWhere}.kind`, 'registry kind 枚举非法。');
          }
          if (typeof registry.releaseCorpus !== 'boolean') {
            add('REGISTRY_RELEASE_FLAG_INVALID', `${registryWhere}.releaseCorpus`, 'releaseCorpus 必须为 boolean。');
          }
          if (registry.releaseCorpus === true) {
            hasReleaseCorpus = true;
            if (registry.kind !== 'release-corpus') {
              add('REGISTRY_RELEASE_KIND_MISMATCH', registryWhere, 'release corpus 必须使用 release-corpus kind。');
            }
          } else if (registry.kind === 'release-corpus') {
            add('REGISTRY_RELEASE_KIND_MISMATCH', registryWhere, 'release-corpus kind 不得标为 false。');
          }
          if (registry.kind === 'historical-private-corpus') {
            const ref = String(registry.registryRef ?? '').slice('historical-corpus:'.length);
            if (!evidenceIds.has(ref)) {
              add('HISTORICAL_REGISTRY_EVIDENCE_UNKNOWN', `${registryWhere}.registryRef`, `历史 corpus 引用未绑定 Evidence：${ref}`);
            }
          }
        });
        if (item.proposedSupport === 'supported'
          && !hasReleaseCorpus
          && item.decisionStatus === 'awaiting-user-ruling') {
          if (!isStringArray(item.openRulings, { nonEmpty: true })) {
            add('SUPPORTED_WITHOUT_RELEASE_CORPUS_RULING_MISSING', `${where}.openRulings`, '缺少 release corpus 的 supported 项必须保留 open ruling。');
          }
          if (!ALLOWED_AUTHORITY.has(item.currentAuthority)) {
            add('SUPPORTED_WITHOUT_RELEASE_CORPUS_AUTHORITY_MISSING', `${where}.currentAuthority`, '必须保留 current authority。');
          }
        }
      }
      if (!isStringArray(item.openRulings)) {
        add('OPEN_RULINGS_INVALID', `${where}.openRulings`, 'openRulings 必须为字符串数组。');
      }
      if (item.decisionStatus === 'awaiting-user-ruling' && !isStringArray(item.openRulings, { nonEmpty: true })) {
        add('AWAITING_ITEM_RULING_MISSING', `${where}.openRulings`, '待用户裁定项必须列出 open ruling。');
      }
      if (!isStringArray(item.nonClaims, { nonEmpty: true })) {
        add('NON_CLAIMS_INVALID', `${where}.nonClaims`, '每个 scope item 必须有非声明。');
      }
    });

    for (const [scopeItemId, requirement] of REQUIRED_SCOPE_ITEMS) {
      const item = itemById.get(scopeItemId);
      if (!item) {
        add('REQUIRED_SCOPE_ITEM_MISSING', 'proposal.scopeItems', `缺少必需 scope item：${scopeItemId}`);
        continue;
      }
      if (item.capabilityId !== requirement.capabilityId) {
        add('REQUIRED_SCOPE_ITEM_CAPABILITY_MISMATCH', scopeItemId, `必须使用 capabilityId=${requirement.capabilityId}。`);
      }
      if (!Array.isArray(item.gateIds) || !item.gateIds.includes(requirement.gateId)) {
        add('REQUIRED_SCOPE_ITEM_GATE_MISMATCH', scopeItemId, `必须覆盖 Gate=${requirement.gateId}。`);
      }
    }
    for (const gateId of EXPECTED_GATES) {
      if (!coveredGates.has(gateId)) add('PROPOSAL_GATE_NOT_COVERED', 'proposal.scopeItems', `提案未覆盖 Gate：${gateId}`);
    }

    if (proposal.proposalStatus === 'user-approved') {
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.status', 'user-approved');
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.sourceProject', 'vawser/Smithbox');
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.sourceRelease', '2.2.4');
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.sourceCommit', '1b46d2c9f82d1c3635ff7c12c526e05a8ba4208f');
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.sourceArtifactSha256', '14a7fd735a9577249fa93655f63d1e9ac025a3b00d7c5bed8badc8a3a7fd489d');
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.sourcePath', 'Smithbox.Release/Output/Assets/PARAM/SDT');
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.acquisition', 'user-local-pinned-release-import');
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.redistribution', 'forbidden');
      requireFrozenValue(proposal, 'paramMetadataSourcePolicy.mismatchPolicy', 'fail-closed');
      requireFrozenValue(proposal, 'providerCredentialPolicy.status', 'user-approved');
      requireFrozenValue(proposal, 'providerCredentialPolicy.defaultConfiguration', 'empty');
      requireFrozenValue(proposal, 'providerCredentialPolicy.realProviderCredentialsRequiredForV05Acceptance', false);
      requireFrozenValue(proposal, 'providerCredentialPolicy.unconfiguredBehavior', 'diagnose-without-network-call');
      requireFrozenValue(proposal, 'runtimeToolPolicy.status', 'user-approved');
      requireFrozenValue(proposal, 'runtimeToolPolicy.adapter', 'me3');
      requireFrozenValue(proposal, 'runtimeToolPolicy.sourceProject', 'garyttierney/me3');
      requireFrozenValue(proposal, 'runtimeToolPolicy.sourceRelease', 'v0.12.1');
      requireFrozenValue(proposal, 'runtimeToolPolicy.sourceArtifactSha256', 'b1c11659b0cfde73062b2fa134a8ac499f3e713fe82d9014401289677ace7323');
      requireFrozenValue(proposal, 'runtimeToolPolicy.provisioningResponsibility', 'project-engineering');
      requireFrozenValue(proposal, 'runtimeToolPolicy.compatibilityPolicy', 'capability-probe-fail-closed');
      requireFrozenValue(proposal, 'renderingAcceptancePolicy.status', 'user-approved');
      requireFrozenValue(proposal, 'renderingAcceptancePolicy.functionalOwnerMachineSmokeRequired', true);
      requireFrozenValue(proposal, 'renderingAcceptancePolicy.representativeHardwareTiersRequired', false);
      requireFrozenValue(proposal, 'renderingAcceptancePolicy.performanceBudgetsRequired', false);
      requireFrozenOperation(itemById, 'SCOPE-EDITORS', 'project-structured-ui');
      requireFrozenOperation(itemById, 'SCOPE-EDITORS', 'project-canonical-dsl');
      requireFrozenOperation(itemById, 'SCOPE-EDITORS', 'show-readonly-hex-evidence');
      requireFrozenUnsupported(itemById, 'SCOPE-EDITORS', 'raw-hex-edit');
      requireFrozenOperation(itemById, 'SCOPE-KRAK', 'recompress');
      requireFrozenOperation(itemById, 'SCOPE-KRAK', 'write');
      requireFrozenOperation(itemById, 'SCOPE-PARAM', 'import-user-local-pinned-smithbox-metadata');
      requireFrozenOperation(itemById, 'SCOPE-PARAM', 'verify-source-release-and-content-digest');
      requireFrozenOperation(itemById, 'SCOPE-PARAM', 'record-source-license-and-provenance');
      requireFrozenUnsupported(itemById, 'SCOPE-PARAM', 'redistribute-imported-smithbox-param-metadata');
      requireFrozenUnsupported(itemById, 'SCOPE-PARAM', 'accept-unpinned-or-mismatched-metadata-source');
      requireFrozenOperation(itemById, 'SCOPE-AI', 'offline-protocol-conformance');
      requireFrozenOperation(itemById, 'SCOPE-AI', 'diagnose-empty-provider-configuration-without-network-call');
      requireFrozenUnsupported(itemById, 'SCOPE-AI', 'bundle-provider-credentials');
      requireFrozenUnsupported(itemById, 'SCOPE-AI', 'require-live-provider-account-for-v05-acceptance');
      requireFrozenOperation(itemById, 'SCOPE-RENDERING', 'functional-backend-smoke-on-owner-machine');
      requireFrozenUnsupported(itemById, 'SCOPE-RENDERING', 'representative-hardware-tier-acceptance');
      requireFrozenUnsupported(itemById, 'SCOPE-RENDERING', 'performance-budget-as-v05-gate');
      forbidFrozenOperation(itemById, 'SCOPE-RENDERING', 'benchmark-both-backends');
      requireFrozenOperation(itemById, 'SCOPE-RELEASE', 'package-nsis-x64');
      requireFrozenOperation(itemById, 'SCOPE-RELEASE', 'verify-installer-artifact-hash');
      forbidFrozenOperation(itemById, 'SCOPE-RELEASE', 'package-signed-nsis-x64');
      forbidFrozenOperation(itemById, 'SCOPE-RELEASE', 'sign');
      forbidFrozenUnsupported(itemById, 'SCOPE-RELEASE', 'unsigned-local-artifact-as-release');
      requireFrozenUnsupported(itemById, 'SCOPE-RELEASE', 'portable-release');
      requireFrozenUnsupported(itemById, 'SCOPE-RELEASE', 'automatic-update');
      requireFrozenOperation(itemById, 'SCOPE-COMPLIANCE', 'verify-owner-controlled-target');
      requireFrozenOperation(itemById, 'SCOPE-COMPLIANCE', 'verify-installer-artifact-hash');
      forbidFrozenOperation(itemById, 'SCOPE-COMPLIANCE', 'verify-signed-installer-provenance');
      requireFrozenUnsupported(itemById, 'SCOPE-COMPLIANCE', 'external-distribution');
      requireFrozenUnsupported(itemById, 'SCOPE-ASSET-OPEN-CONVERSION', 'open-format-to-native-import');
    }

    if (!Array.isArray(proposal.gateCoverage)) {
      add('GATE_COVERAGE_INVALID', 'proposal.gateCoverage', 'gateCoverage 必须为数组。');
    } else {
      const seenCoverageGates = new Set();
      const coverageByGate = new Map();
      proposal.gateCoverage.forEach((coverage, index) => {
        const where = `proposal.gateCoverage[${index}]`;
        if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) {
          add('GATE_COVERAGE_ENTRY_INVALID', where, 'gate coverage 必须为对象。');
          return;
        }
        if (!gateIds.has(coverage.gateId)) {
          add('GATE_COVERAGE_ID_UNKNOWN', `${where}.gateId`, `§18.1 未定义：${coverage.gateId ?? '(missing)'}`);
        } else if (seenCoverageGates.has(coverage.gateId)) {
          add('GATE_COVERAGE_ID_DUPLICATE', `${where}.gateId`, `gateCoverage 重复：${coverage.gateId}`);
        } else {
          seenCoverageGates.add(coverage.gateId);
          coverageByGate.set(coverage.gateId, coverage);
        }
        if (!ALLOWED_GATE_STATE.has(coverage.currentState)) {
          add('GATE_COVERAGE_STATE_INVALID', `${where}.currentState`, '提案 currentState 只允许 open、blocked 或 passed。');
        } else if (gateMatrixStates.get(coverage.gateId) !== coverage.currentState) {
          add('GATE_COVERAGE_STATE_DRIFT', `${where}.currentState`, `必须与 §18.3 当前状态一致：${gateMatrixStates.get(coverage.gateId) ?? '(missing)'}`);
        }
        if (!isStringArray(coverage.scopeItemIds, { nonEmpty: true })) {
          add('GATE_COVERAGE_SCOPE_ITEMS_INVALID', `${where}.scopeItemIds`, 'scopeItemIds 必须为非空字符串数组。');
        } else {
          const seenRefs = new Set();
          for (const scopeItemId of coverage.scopeItemIds) {
            if (seenRefs.has(scopeItemId)) add('GATE_COVERAGE_SCOPE_ITEM_DUPLICATE', `${where}.scopeItemIds`, `重复 scope item：${scopeItemId}`);
            seenRefs.add(scopeItemId);
            const item = itemById.get(scopeItemId);
            if (!item) {
              add('GATE_COVERAGE_SCOPE_ITEM_UNKNOWN', `${where}.scopeItemIds`, `未定义 scope item：${scopeItemId}`);
            } else if (coverage.gateId !== 'REL-SCOPE'
              && (!Array.isArray(item.gateIds) || !item.gateIds.includes(coverage.gateId))) {
              add('GATE_COVERAGE_SCOPE_ITEM_GATE_MISMATCH', `${where}.scopeItemIds`, `${scopeItemId} 未声明 Gate ${coverage.gateId}。`);
            }
          }
        }
        if (!isStringArray(coverage.blockerRefs)) {
          add('GATE_COVERAGE_BLOCKERS_INVALID', `${where}.blockerRefs`, 'blockerRefs 必须为字符串数组。');
        } else {
          const seenBlockers = new Set();
          for (const blockerRef of coverage.blockerRefs) {
            if (seenBlockers.has(blockerRef)) add('GATE_COVERAGE_BLOCKER_DUPLICATE', `${where}.blockerRefs`, `重复 blocker：${blockerRef}`);
            seenBlockers.add(blockerRef);
            if (!blockerIds.has(blockerRef)) add('GATE_COVERAGE_BLOCKER_UNKNOWN', `${where}.blockerRefs`, `§18.4 未定义：${blockerRef}`);
          }
          if (coverage.currentState === 'blocked' && coverage.blockerRefs.length === 0) {
            add('BLOCKED_GATE_WITHOUT_BLOCKER', `${where}.blockerRefs`, 'blocked Gate 必须引用 blocker。');
          }
          if (coverage.currentState === 'open' && coverage.blockerRefs.length !== 0) {
            add('OPEN_GATE_WITH_BLOCKER', `${where}.blockerRefs`, 'open Gate 不得携带 blockerRefs。');
          }
          if (coverage.currentState === 'passed' && coverage.blockerRefs.length !== 0) {
            add('PASSED_GATE_WITH_BLOCKER', `${where}.blockerRefs`, 'passed Gate 不得携带 blockerRefs。');
          }
        }
        if (!isStringArray(coverage.openRulings, { nonEmpty: true })) {
          add('GATE_COVERAGE_RULINGS_INVALID', `${where}.openRulings`, '当前提案的每个 Gate 必须列出开放裁定或收敛条件。');
        }
      });

      for (const gateId of EXPECTED_GATES) {
        if (!seenCoverageGates.has(gateId)) add('GATE_COVERAGE_MISSING', 'proposal.gateCoverage', `缺少显式 Gate coverage：${gateId}`);
      }
      for (const gateId of seenCoverageGates) {
        if (!expectedGateSet.has(gateId)) add('GATE_COVERAGE_UNEXPECTED', 'proposal.gateCoverage', `出现额外 Gate coverage：${gateId}`);
      }
      const scopeGateRefs = new Set(coverageByGate.get('REL-SCOPE')?.scopeItemIds ?? []);
      for (const scopeItemId of itemById.keys()) {
        if (!scopeGateRefs.has(scopeItemId)) {
          add('REL_SCOPE_ITEM_NOT_REFERENCED', 'proposal.gateCoverage.REL-SCOPE', `REL-SCOPE 必须显式引用全部 scope item：${scopeItemId}`);
        }
      }
      for (const item of itemById.values()) {
        for (const gateId of item.gateIds ?? []) {
          const refs = coverageByGate.get(gateId)?.scopeItemIds ?? [];
          if (!refs.includes(item.scopeItemId)) {
            add('SCOPE_ITEM_NOT_IN_GATE_COVERAGE', item.scopeItemId, `${gateId} gateCoverage 未引用该 scope item。`);
          }
        }
      }
    }
  }

  if (hasAbsolutePath(rawJson)) {
    add('ABSOLUTE_PATH_FORBIDDEN', 'proposal', 'scope proposal 不得包含绝对路径或 file URI。');
  }
  checkPrivateRegistryFields(proposal);
}

const structuralErrors = findings.length;
const scopeItems = Array.isArray(proposal?.scopeItems) ? proposal.scopeItems : [];
const frozen = structuralErrors === 0
  && proposal?.proposalStatus === 'user-approved'
  && proposal?.gameBuildRange?.status === 'user-approved'
  && proposal?.gameBuildRange?.matchPolicy === 'file-product-version-major-minor'
  && isStringArray(proposal?.gameBuildRange?.versionFamilies, { nonEmpty: true })
  && isStringArray(proposal?.gameBuildRange?.exactBuilds)
  && proposal?.gameBuildRange?.unknownBuildPolicy === 'fail-closed'
  && proposal?.ruling?.status === 'user-approved'
  && typeof proposal?.ruling?.approvedBy === 'string'
  && proposal.ruling.approvedBy.trim().length > 0
  && typeof proposal?.ruling?.approvedAt === 'string'
  && typeof proposal?.ruling?.decisionRef === 'string'
  && scopeItems.every((item) => item.decisionStatus === 'user-approved')
  && scopeItems.every((item) => Array.isArray(item.openRulings) && item.openRulings.length === 0);

if (proposalMode) {
  const result = structuralErrors === 0
    ? {
        ok: null,
        status: 'proposal-valid',
        frozen,
        proposalId: proposal.proposalId,
        scopeItemCount: scopeItems.length,
        gateCount: EXPECTED_GATES.length,
        findings: [],
        note: frozen
          ? '用户批准范围结构有效；--proposal 本身不替代 sealed Evidence，也不构成功能或 V0.5 完成声明。'
          : '提案结构有效；这不是用户范围裁定，也不构成 V0.5 发布声明。'
      }
    : {
        ok: false,
        status: 'proposal-invalid',
        frozen: false,
        findings
      };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = structuralErrors === 0 ? 0 : 1;
} else if (structuralErrors > 0) {
  console.log(JSON.stringify({ ok: false, status: 'proposal-invalid', frozen: false, findings }, null, 2));
  process.exitCode = 1;
} else if (!frozen) {
  console.log(JSON.stringify({
    ok: false,
    status: 'awaiting-user-ruling',
    frozen: false,
    proposalId: proposal.proposalId,
    findings: [{
      severity: 'error',
      code: 'RELEASE_SCOPE_NOT_FROZEN',
      where: 'proposal.proposalStatus',
      message: '默认严格模式要求用户完成范围裁定；当前仅有结构合法提案。'
    }]
  }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    status: 'scope-approved',
    frozen: true,
    proposalId: proposal.proposalId,
    findings: []
  }, null, 2));
  process.exitCode = 0;
}

function requireFrozenOperation(itemById, scopeItemId, operation) {
  const item = itemById.get(scopeItemId);
  if (!item?.operations?.includes(operation)) {
    add('FROZEN_OPERATION_MISSING', scopeItemId, `冻结范围必须包含 operation=${operation}。`);
  }
}

function requireFrozenUnsupported(itemById, scopeItemId, operation) {
  const item = itemById.get(scopeItemId);
  if (!item?.unsupportedOperations?.includes(operation)) {
    add('FROZEN_UNSUPPORTED_BOUNDARY_MISSING', scopeItemId, `冻结范围必须明确 unsupported=${operation}。`);
  }
}

function forbidFrozenOperation(itemById, scopeItemId, operation) {
  const item = itemById.get(scopeItemId);
  if (item?.operations?.includes(operation)) {
    add('FROZEN_OPERATION_FORBIDDEN', scopeItemId, `冻结范围不得包含 operation=${operation}。`);
  }
}

function forbidFrozenUnsupported(itemById, scopeItemId, operation) {
  const item = itemById.get(scopeItemId);
  if (item?.unsupportedOperations?.includes(operation)) {
    add('FROZEN_UNSUPPORTED_BOUNDARY_FORBIDDEN', scopeItemId, `冻结范围不得包含 unsupported=${operation}。`);
  }
}

function requireFrozenValue(root, path, expected) {
  const actual = path.split('.').reduce((value, key) => value?.[key], root);
  if (actual !== expected) {
    add('FROZEN_POLICY_VALUE_INVALID', `proposal.${path}`, `冻结范围要求 ${path}=${JSON.stringify(expected)}。`);
  }
}
