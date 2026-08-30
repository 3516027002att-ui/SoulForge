import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SCOPE_AUTHORITY,
  buildReleaseScopeProposal,
  findUnprojectedScopeFields,
  loadGovernanceSources
} from './release-scope-proposal-lib.mjs';

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
// 编辑器 id 是能力域的稳定标识，不是某一版本的冻结清单。当前版本的
// user-approved 清单、顺序和写入模式都从 scope.json 的 SCOPE-EDITORS 投影读取；
// 这里只挡住把证据视图或任意未知值伪装成编辑器的情况。
const ALLOWED_EDITOR_IDS = new Set([
  'bnd4',
  'fmg',
  'param',
  'emevd',
  'script',
  'msb',
  'tae',
  'esd',
  'flver'
]);
const ALLOWED_EDITOR_MUTATION_MODES = new Set([
  'typed-mutation',
  'whole-inner-file-replacement'
]);

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
/**
 * `deferred` 与 `unsupported` 严格区分：
 * - `unsupported` = 已裁定不支持，unlistedPolicy 同级；
 * - `deferred` = 已裁定移出 V0.5，仍将在 `deferredToRelease` 里程碑交付。
 * `deferred` 条目必须声明 `deferredToRelease`，且不得声明 supported operations。
 */
const ALLOWED_SUPPORT = new Set(['supported', 'unsupported', 'deferred']);
const ALLOWED_GATE_STATE = new Set(['open', 'blocked', 'passed', 'deferred']);
const DEFERRED_TARGET_RELEASE = 'V0.6';
const ALLOWED_DEFERRED_RELEASE = new Set([DEFERRED_TARGET_RELEASE]);
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
// 提案权威目录。--input 只换 markdown，换不了提案——提案此刻来自治理 JSON，
// 负向 fixture 要扰动的是权威本身，所以必须能单独覆盖治理目录。
const governanceArgs = cliArgs.filter((arg) => arg.startsWith('--governance-root='));
const unknownArgs = cliArgs.filter((arg) => arg !== '--proposal'
  && !arg.startsWith('--input=')
  && !arg.startsWith('--governance-root='));
const handoffInput = inputArgs.length === 1 ? inputArgs[0].slice('--input='.length) : HANDOFF;
const handoffWhere = inputArgs.length === 0 ? HANDOFF : 'scope-fixture-input';
const governanceRoot = governanceArgs.length === 1
  ? governanceArgs[0].slice('--governance-root='.length)
  : null;
const proposalWhere = governanceRoot === null ? SCOPE_AUTHORITY : 'scope-fixture-governance-root';
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
  const row = /^\|\s*`(REL-[A-Z0-9-]+)`\s*\|[^|\n]*\|[^|\n]*\|\s*`(open|blocked|passed|deferred)`\s*\|/gm;
  let match;
  while ((match = row.exec(section)) !== null) states.set(match[1], match[2]);
  return states;
}

/**
 * §18.2.1 内的 Gate 收敛条件表必须存在、必须在外层 marker 之内、必须逐条对上 gates.json。
 *
 * 为什么需要这道运行期断言：openRulings 是 gates.json 唯一既不进摘要表、也不被本门禁
 * 按内容校验的 gateCoverage 字段（下方只判 isStringArray nonEmpty）。它同时是
 * REL-SCOPE 的 freshness 覆盖的一部分——该表落在
 * SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN/END 之内，所以改 openRulings 会让
 * `handoff-block:release-scope-proposal` 漂移，使 REL-SCOPE 证据变 stale。
 *
 * 「在外层 marker 之内」是这条覆盖链唯一的结构前提，而它极易被静默破坏：把
 * END_MARKER 上移一行，表就掉到指纹范围外，投影仍正常、handoff:project --check
 * 仍全绿、本门禁其余断言也全绿——覆盖消失且无人报错。所以这里传入的是
 * sliceBetween(handoff, BEGIN_MARKER, END_MARKER) 的结果而不是整份交接书：
 * 表在块外时下面第一条就红。
 *
 * 不比对逐字文本（那是 handoff:project --check 的职责，重复且更脆），只比对
 * gateId 集合与顺序：这足以挡住「表还在但退成占位」「漏一个 Gate」「表按旧顺序」，
 * 而这三种正是投影渲染函数被改坏时的实际形态。
 */
function checkGateRulingsTable(proposalBlock) {
  const begin = '<!-- SOULFORGE_PROJECTION_BEGIN:gate-rulings -->';
  const end = '<!-- SOULFORGE_PROJECTION_END:gate-rulings -->';
  const table = sliceBetween(proposalBlock, begin, end);
  if (table === null) {
    add(
      'GATE_RULINGS_BLOCK_MISSING',
      '§18.2.1',
      'Gate 收敛条件表不在 SOULFORGE_RELEASE_SCOPE_PROPOSAL 外层 marker 之内。'
        + '该表是 openRulings 的唯一指纹覆盖，落到外层 marker 之外会让 REL-SCOPE 对 '
        + 'openRulings 改动失去 stale 判定；投影与 --check 都不会发现。'
    );
    return;
  }
  if (gatesData === null) return;
  const authorityIds = (gatesData.gates ?? []).map((entry) => entry.gateId);
  const rowIds = [];
  const row = /^\|\s*`(REL-[A-Z0-9-]+)`\s*\|/gm;
  let match;
  while ((match = row.exec(table)) !== null) rowIds.push(match[1]);
  if (rowIds.length === 0) {
    add(
      'GATE_RULINGS_TABLE_EMPTY',
      '§18.2.1',
      'Gate 收敛条件表未解析到任何 Gate 行；运行 npm run handoff:project 重新生成。'
    );
    return;
  }
  if (rowIds.join(',') !== authorityIds.join(',')) {
    add(
      'GATE_RULINGS_TABLE_DIVERGED',
      '§18.2.1',
      `Gate 收敛条件表与 gates.json 不一致：表为 ${rowIds.join(',')}，权威为 ${authorityIds.join(',')}。`
    );
  }
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

/**
 * deferred 条目的 resumeRequires 必须写本条专属的承接前置，不能是策略复制。
 *
 * 实测踩过：12 条 deferredToRelease=V0.6 的 resumeRequires 曾是逐字相同的四行
 * 通用策略——而策略正文本就在 scopeDeferralPolicy 里且已冻结。那份复制不承载
 * 任何条目专属信息，接手 V0.6 的 agent 从中读不到「这一条到底还差什么」，
 * 而且没有任何门禁能看见它退化（当时 resumeRequires 未被任何脚本读取）。
 *
 * 判据是「与其他 deferred 条目逐字重合」而不是「长度」或「包含某些关键词」：
 * 前者能精确抓住复制这一种退化，后者会把正当的共同前置也判成错。
 * 第一条刻意允许重合——它就是对 scopeDeferralPolicy 的显式引用，让通用流程
 * 只有一份权威；从第二条起必须条目独有。
 */
function checkResumeRequires(item, where, textsByEntry) {
  const list = item.resumeRequires;
  if (!isStringArray(list, { nonEmpty: true })) {
    add(
      'RESUME_REQUIRES_INVALID',
      `${where}.resumeRequires`,
      'deferred 条目必须声明 resumeRequires（非空字符串数组）：延期不等于放弃，承接前置必须留痕。'
    );
    return;
  }
  if (list.length < 2) {
    add(
      'RESUME_REQUIRES_POLICY_ONLY',
      `${where}.resumeRequires`,
      'resumeRequires 只有通用策略引用，缺少本条专属承接前置；'
        + '通用流程在 scopeDeferralPolicy 里已有一份权威，这里要写的是「这一条还差什么」。'
    );
    return;
  }
  // 首条之后的每一条都必须条目独有。记录归属，末尾统一比对。
  for (const text of list.slice(1)) {
    const key = text.trim();
    if (!textsByEntry.has(key)) textsByEntry.set(key, []);
    textsByEntry.get(key).push({ id: item.scopeItemId, where });
  }
}

/** resumeRequires 跨条目重复的统一裁定。必须在遍历完全部条目后调用。 */
function reportResumeRequiresDuplicates(textsByEntry) {
  for (const [text, owners] of textsByEntry) {
    if (owners.length < 2) continue;
    add(
      'RESUME_REQUIRES_DUPLICATED',
      `${owners[0].where}.resumeRequires`,
      `承接前置在 ${owners.length} 个 deferred 条目间逐字重复：「${text.slice(0, 60)}」`
        + `（${owners.map((owner) => owner.id).join('、')}）。`
        + '共同流程只能通过首条策略引用表达；专属条目重复即说明它其实不专属。'
    );
  }
}

if (unknownArgs.length > 0) {
  add('UNKNOWN_ARGUMENT', 'argv', `未知参数：${unknownArgs.join(', ')}`);
}
if (inputArgs.length > 1 || handoffInput.length === 0) {
  add('INPUT_ARGUMENT_INVALID', 'argv', '--input 只能提供一次且路径不能为空。');
}
if (governanceArgs.length > 1 || (governanceRoot !== null && governanceRoot.length === 0)) {
  add('GOVERNANCE_ROOT_ARGUMENT_INVALID', 'argv', '--governance-root 只能提供一次且路径不能为空。');
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

/**
 * 提案来自治理 JSON，不再来自交接书。
 *
 * 此前本门禁只解析 §18.2.1 的内嵌 JSON——1467 行，逐字复制 scope.json。
 * 复制品与权威分叉时门禁看不见（实测 27/27 条 scopeItem 缺 targetRelease、
 * deferredTrack、resumeRequires，schemaVersion 停在 1.6.0 而权威是 2.0.0）。
 * 现在直接读 scope.json + gates.json，那份复制退成人读摘要表。
 */
let proposal = null;
let scopeData = null;
let gatesData = null;
try {
  const sources = loadGovernanceSources(process.cwd(), governanceRoot);
  scopeData = sources.scopeData;
  gatesData = sources.gatesData;
  proposal = buildReleaseScopeProposal(sources);
} catch (error) {
  add('GOVERNANCE_READ_FAILED', proposalWhere, error instanceof Error ? error.message : String(error));
}

/**
 * §18.2.1 摘要块仍必须存在且是 scope.json 的完整投影。
 *
 * 摘要不再承载提案语义，但它承载「人读文档与权威是否同步」：交接书是 agent
 * 的入口，摘要漏条目就等于范围条目在人读侧不存在。判据是首列 ID 集与
 * scope.json 逐条相等，而不是「块非空」——后者对删掉 20 行的摘要照样报绿。
 *
 * 与 handoff:project --check 的逐字比对重叠是有意的：那条命令在
 * governance 层，本门禁也在 governance 层，重叠成本接近零；而少了这条，
 * 「摘要与权威分叉」只有投影门禁一道防线，它一旦被 --check 跳过就没人管了。
 */
if (beginCount === 1 && endCount === 1) {
  const block = sliceBetween(handoff, BEGIN_MARKER, END_MARKER);
  if (block === null) {
    add('PROPOSAL_BLOCK_ORDER_INVALID', handoffWhere, 'scope proposal marker 顺序非法。');
  } else {
    const summaryIds = parseFirstColumnIds(block, 'SCOPE-');
    if (summaryIds.size === 0) {
      add(
        'SCOPE_SUMMARY_EMPTY',
        '§18.2.1',
        '§18.2.1 摘要表未解析到任何 scopeItemId；该块是 scope.json 的人读投影，'
          + '运行 npm run handoff:project 重新生成。'
      );
    } else if (scopeData !== null) {
      const authorityIds = new Set((scopeData.scopeItems ?? []).map((item) => item.scopeItemId));
      for (const scopeItemId of authorityIds) {
        if (!summaryIds.has(scopeItemId)) {
          add('SCOPE_SUMMARY_ITEM_MISSING', '§18.2.1', `摘要表缺少 scope.json 已登记条目：${scopeItemId}`);
        }
      }
      for (const scopeItemId of summaryIds) {
        if (!authorityIds.has(scopeItemId)) {
          add('SCOPE_SUMMARY_ITEM_UNKNOWN', '§18.2.1', `摘要表出现 scope.json 未登记条目：${scopeItemId}`);
        }
      }
    }
    checkGateRulingsTable(block);
  }
}

const capabilitySection = sliceBetween(handoff, '### 3.1 路线依赖与解锁关系', '### 3.2 Authority 解锁规则');
const gateSection = sliceBetween(handoff, '### 18.1 可判定的发布门槛', '### 18.2 V0.5 不设置的量化预算与门槛');
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
  /**
   * schemaVersion 只做结构校验，不与 scope.json 比对。
   *
   * 提案此刻就是从 scope.json 装配出来的，`proposal.schemaVersion ===
   * scopeAuthority.schemaVersion` 是拿一个值和它自己比——恒真，且负向 fixture
   * 无法构造出反例。那种断言比没有断言更糟：它占着一个 finding code，让人
   * 以为版本分叉有门禁看着。
   *
   * 真正需要挡的退化是「schemaVersion 缺失或不是 semver」。分叉不再可能存在，
   * 因为只有一份数据。
   */
  if (typeof proposal.schemaVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(proposal.schemaVersion)) {
    add(
      'SCHEMA_VERSION_INVALID',
      'proposal.schemaVersion',
      `schemaVersion 必须是 major.minor.patch 形式的字符串，实际 ${JSON.stringify(proposal.schemaVersion)}；`
        + `权威是 ${SCOPE_AUTHORITY}。`
    );
  }
  /**
   * scope.json 新增了既不进提案、也未登记为非提案字段的键。
   *
   * 提案按固定键序装配，多出来的键会被静默丢掉——那个字段于是不受任何
   * 冻结校验保护，而它看起来是「已经写进权威文件」的。失败关闭，让新增
   * 策略字段的人必须选一边：纳入提案校验，或显式登记为非提案字段。
   */
  for (const key of findUnprojectedScopeFields(scopeData)) {
    add(
      'UNPROJECTED_SCOPE_FIELD',
      `${SCOPE_AUTHORITY}.${key}`,
      `scope.json 的 ${key} 既未进入提案键序，也未登记为非提案字段：`
        + '它不受任何冻结校验保护。要么加入 PROPOSAL_KEY_ORDER 并补校验，'
        + '要么加入 NON_PROPOSAL_SCOPE_KEYS 说明它不承载范围语义。'
    );
  }
  // proposalId 里的版本号取自 proposal.release，不硬编码 V0.5：治理必须能
  // 跨到 V0.6，写死版本号意味着 V0.6 的范围提案永远过不了这道校验。
  const proposalIdPattern = new RegExp(`^${String(proposal.release ?? '').replace('.', '\\.')}-SCOPE-[0-9]{8}$`);
  if (!/^V\d+\.\d+$/.test(proposal.release ?? '') || !proposalIdPattern.test(proposal.proposalId ?? '')) {
    add(
      'PROPOSAL_ID_INVALID',
      'proposal.proposalId',
      `proposalId 必须匹配 <release>-SCOPE-YYYYMMDD 且与 release 字段同版本，`
        + `实际 release=${JSON.stringify(proposal.release)} proposalId=${JSON.stringify(proposal.proposalId)}。`
    );
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
    // deferred 条目的专属承接前置 → 声明它的条目。跨条目重复在遍历后统一裁定。
    const deferredResumeTexts = new Map();

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
      if (Object.hasOwn(item, 'currentAuthority')) {
        add(
          'LEGACY_CURRENT_AUTHORITY_FORBIDDEN',
          `${where}.currentAuthority`,
          '冻结范围只能记录 authorityAtRuling；实时 authority 必须由 §13.1 执行面板维护。'
        );
      }
      if (!ALLOWED_AUTHORITY.has(item.authorityAtRuling)) {
        add(
          'AUTHORITY_AT_RULING_INVALID',
          `${where}.authorityAtRuling`,
          'authorityAtRuling 枚举非法。'
        );
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
      // deferred 条目必须声明目标里程碑，且不得同时声明本版可用 operation。
      if (item.proposedSupport === 'deferred') {
        if (!ALLOWED_DEFERRED_RELEASE.has(item.deferredToRelease ?? '')) {
          add(
            'DEFERRED_RELEASE_INVALID',
            `${where}.deferredToRelease`,
            `deferred 条目必须声明 deferredToRelease，允许值：${[...ALLOWED_DEFERRED_RELEASE].join('、')}。`
          );
        }
        if (Array.isArray(item.operations) && item.operations.length > 0) {
          add(
            'DEFERRED_OPERATIONS_FORBIDDEN',
            `${where}.operations`,
            'deferred 条目不得声明本版可用 operation；本版能力应写入 unsupportedOperations 或改为 supported。'
          );
        }
        checkResumeRequires(item, where, deferredResumeTexts);
      } else if (item.deferredToRelease !== undefined && item.deferredToRelease !== null) {
        // null 与「字段不存在」在这里语义相同，都表示未延期。
        // scope.schema.json 把 deferredToRelease/deferredTrack/resumeRequires 列进
        // required，非延期条目按 null / 空数组显式登记——原判据只排除 undefined，
        // 会把 schema 要求的 null 误判成「非 deferred 条目声明了延期目标」。
        // 这个分歧此前看不见：本门禁只读交接书内嵌块，而那份复制根本没有这些字段。
        add(
          'DEFERRED_RELEASE_UNEXPECTED',
          `${where}.deferredToRelease`,
          '只有 proposedSupport=deferred 的条目才能声明 deferredToRelease（未延期请写 null）。'
        );
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
        if (!['unverified', 'unsupported'].includes(item.authorityAtRuling) && item.evidenceRefs.length === 0) {
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
          if (!ALLOWED_AUTHORITY.has(item.authorityAtRuling)) {
            add(
              'SUPPORTED_WITHOUT_RELEASE_CORPUS_AUTHORITY_MISSING',
              `${where}.authorityAtRuling`,
              '必须保留裁定时 authority 快照。'
            );
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
    reportResumeRequiresDuplicates(deferredResumeTexts);

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
      requireFrozenValue(proposal, 'quantitativeAcceptancePolicy.status', 'user-approved');
      requireFrozenValue(proposal, 'quantitativeAcceptancePolicy.editorCapacityOrLatencyThresholdsRequired', false);
      requireFrozenValue(proposal, 'quantitativeAcceptancePolicy.installerSizeOrTimeBudgetsRequired', false);
      requireFrozenValue(proposal, 'quantitativeAcceptancePolicy.boundedEditorAccessRequired', true);
      requireFrozenValue(proposal, 'quantitativeAcceptancePolicy.installerLifecycleIntegrityRequired', true);
      requireFrozenValue(proposal, 'scopeDeferralPolicy.status', 'user-approved');
      requireFrozenValue(proposal, 'scopeDeferralPolicy.deferredToRelease', 'V0.6');
      requireFrozenValue(proposal, 'scopeDeferralPolicy.deferredIsNotCompleted', true);
      requireFrozenValue(proposal, 'scopeDeferralPolicy.deferredIsNotPermanentlyExcluded', true);
      requireFrozenValue(proposal, 'scopeDeferralPolicy.deferredCodeMayRemainAsMarkedPreview', true);
      requireFrozenValue(proposal, 'scopeDeferralPolicy.deferredPreviewMustBeReadOnly', true);
      requireFrozenValue(proposal, 'authoritySnapshotPolicy.field', 'authorityAtRuling');
      requireFrozenValue(proposal, 'authoritySnapshotPolicy.asOfEvidenceRef', 'EV-REL-SCOPE-20260730');
      // 实时 authority 的权威位置是 slices.json，不是 §13.1。§13.1 已改为
      // slices.json 的投影，指向它等于指向渲染产物。冻结裁定要冻的是「实时
      // authority 只有一个来源」这件事，而不是当时那个来源恰好叫什么名字。
      //
      // 该字段不在 releases.json 的 frozenFields 里，只被本门禁硬编码；
      // scope.json 早已改成 slices.json 而门禁没跟上，分歧能长期存在是因为本门禁
      // 只解析交接书内嵌块，那份复制还停在 section-13.1。
      requireFrozenValue(proposal, 'authoritySnapshotPolicy.liveAuthoritySource', 'docs/governance/slices.json');
      requireFrozenValue(proposal, 'authoritySnapshotPolicy.nonClaimsAreRulingTimeSnapshot', true);
      requireFrozenOperation(itemById, 'SCOPE-EDITORS', 'project-structured-ui');
      requireFrozenOperation(itemById, 'SCOPE-EDITORS', 'project-canonical-dsl');
      requireFrozenOperation(itemById, 'SCOPE-EDITORS', 'show-readonly-hex-evidence');
      requireFrozenOperation(itemById, 'SCOPE-EDITORS', 'access-complete-document-through-bounded-mode');
      // 编辑器契约必须保留 native authority 的安全边界；raw-hex 是否属于
      // 当前范围由 scope.json 自己裁定，不再把旧版本的 raw-hex 禁令写死。
      requireFrozenUnsupported(itemById, 'SCOPE-EDITORS', 'editor-without-native-authority');
      requireFrozenUnsupported(itemById, 'SCOPE-EDITORS', 'quantitative-capacity-or-latency-threshold-as-v05-gate');
      requireFrozenEditorMatrix(itemById);
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
      requireFrozenUnsupported(itemById, 'SCOPE-RELEASE', 'installer-size-or-time-budget-as-v05-gate');
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
          add('GATE_COVERAGE_STATE_INVALID', `${where}.currentState`, '提案 currentState 只允许 open、blocked、passed 或 deferred。');
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
          if (coverage.currentState === 'deferred' && coverage.blockerRefs.length !== 0) {
            add(
              'DEFERRED_GATE_WITH_BLOCKER',
              `${where}.blockerRefs`,
              'deferred Gate 不得携带 blockerRefs；延期是范围裁定，不是阻塞。'
            );
          }
        }
        if (!isStringArray(coverage.openRulings, { nonEmpty: true })) {
          add('GATE_COVERAGE_RULINGS_INVALID', `${where}.openRulings`, '当前提案的每个 Gate 必须列出开放裁定或收敛条件。');
        }
        // Gate 延期状态必须与其覆盖的 scope item 支持状态一致，否则会出现
        // "整条范围已延期但 Gate 写成 passed"或"Gate 写成 deferred 却仍有
        // 本版 supported 能力"两种伪造完成的写法。
        if (Array.isArray(coverage.scopeItemIds) && coverage.scopeItemIds.length > 0) {
          const covered = coverage.scopeItemIds
            .map((scopeItemId) => itemById.get(scopeItemId))
            .filter(Boolean);
          if (covered.length === coverage.scopeItemIds.length) {
            const supportedItems = covered.filter((item) => item.proposedSupport === 'supported');
            const deferredItems = covered.filter((item) => item.proposedSupport === 'deferred');
            if (coverage.currentState === 'deferred' && supportedItems.length > 0) {
              add(
                'DEFERRED_GATE_WITH_SUPPORTED_SCOPE',
                `${where}.currentState`,
                'deferred Gate 覆盖的 scope item 不得仍为 supported：'
                  + `${supportedItems.map((item) => item.scopeItemId).join('、')}。`
              );
            }
            if (coverage.currentState !== 'deferred'
              && deferredItems.length === covered.length
              && coverage.gateId !== 'REL-SCOPE') {
              add(
                'FULLY_DEFERRED_GATE_STATE_INVALID',
                `${where}.currentState`,
                '全部 scope item 均已延期的 Gate 必须写成 currentState=deferred，'
                  + '不得写成 open、blocked 或 passed。'
              );
            }
          }
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

  // 扫装配后的提案序列化文本，而不是 markdown 块的原文。
  //
  // 实测踩过的坑正好在这条判据上：CLAUDE.md 记着「ABSOLUTE_PATH_FORBIDDEN 读的是
  // §18.2.1 投影块而不是 scope.json，改完 scope.json 不重投影门禁会一直红在一个
  // 已经修好的问题上」。现在读的就是权威本身，投影滞后不再影响这条判定。
  if (hasAbsolutePath(JSON.stringify(proposal))) {
    add('ABSOLUTE_PATH_FORBIDDEN', 'proposal', 'scope proposal 不得包含绝对路径或 file URI。');
  }
  checkPrivateRegistryFields(proposal);
}

const structuralErrors = findings.length;
const scopeItems = Array.isArray(proposal?.scopeItems) ? proposal.scopeItems : [];
const releasesRaw = (() => {
  try {
    return JSON.parse(readFileSync('docs/governance/releases.json', 'utf8'));
  } catch {
    return null;
  }
})();
const unfreezeScopeItemIds = new Set(
  Array.isArray(releasesRaw?.releases)
    ? (releasesRaw.releases.find((r) => r.release === proposal?.release)?.unfreezeRuling?.scopeItemIds ?? [])
    : []
);
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
  && scopeItems.every((item) => Array.isArray(item.openRulings) && (item.openRulings.length === 0 || unfreezeScopeItemIds.has(item.scopeItemId)));

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
  // deferred 条目必须 operations=[]（由 DEFERRED_OPERATIONS_FORBIDDEN 单独强制），
  // 该约束严格强于"必须包含某个 operation"，因此此处跳过而非放宽：
  // 一旦条目从 deferred 恢复为 supported，本检查自动重新生效。
  if (item?.proposedSupport === 'deferred') {
    return;
  }
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

function requireFrozenEditorMatrix(itemById) {
  const editors = itemById.get('SCOPE-EDITORS');
  if (editors?.decisionStatus !== 'user-approved'
    || editors?.proposedSupport !== 'supported'
    || editors?.deferredToRelease !== null
    || editors?.deferredTrack !== null
    || !Array.isArray(editors?.resumeRequires)
    || editors.resumeRequires.length !== 0) {
    add(
      'FROZEN_EDITOR_MATRIX_INVALID',
      'SCOPE-EDITORS',
      '当前 editor contract 必须保持 user-approved、supported，且不带 deferred 恢复字段。'
    );
  }
  const editorIds = editors?.editorIds;
  const editorIdsValid = Array.isArray(editorIds)
    && editorIds.length > 0
    && new Set(editorIds).size === editorIds.length
    && editorIds.every((editorId) => typeof editorId === 'string'
      && ALLOWED_EDITOR_IDS.has(editorId));
  if (!editorIdsValid) {
    add(
      'FROZEN_EDITOR_MATRIX_INVALID',
      'SCOPE-EDITORS.editorIds',
      'user-approved editor contract 必须列出非空、唯一且属于已知能力域的 editorIds。'
    );
  }
  if (editors?.hexEvidenceView?.included !== true
    || editors?.hexEvidenceView?.writable !== false) {
    add(
      'FROZEN_HEX_EVIDENCE_POLICY_INVALID',
      'SCOPE-EDITORS.hexEvidenceView',
      'Hex 必须作为 included=true、writable=false 的只读证据视图。'
    );
  }

  // 每个当前清单编辑器必须显式声明写入模式，避免把整文件替换与
  // typed mutation 混为一谈。键集从同一个 user-approved editor contract
  // 投影读取；这里不固定某个版本的编辑器成员或延期状态。
  const modes = editors?.editorMutationModes;
  const modeKeys = modes !== null && typeof modes === 'object' && !Array.isArray(modes)
    ? Object.keys(modes)
    : [];
  const modeKeysMatch = editorIdsValid
    && modeKeys.length === editorIds.length
    && modeKeys.every((editorId) => editorIds.includes(editorId));
  const modeValuesValid = modeKeys.every((editorId) =>
    ALLOWED_EDITOR_MUTATION_MODES.has(modes[editorId]));
  if (!modeKeysMatch || !modeValuesValid) {
    add(
      'FROZEN_EDITOR_MUTATION_MODE_INVALID',
      'SCOPE-EDITORS.editorMutationModes',
      'editorMutationModes 的键必须与当前 editorIds 一致，且每个值必须是受支持的写入模式。'
    );
  }

  // 如果治理数据仍显式登记 deferred preview，则只校验它自身的安全形状：
  // 目标版本来自当前投影，不得把某个固定版本或固定编辑器名单写进门禁。
  // 当前过渡期的 user-approved editor contract 可以完全不带此字段。
  const preview = editors?.deferredPreviewEditors;
  if (preview === undefined || preview === null) return;

  const previewIds = preview !== null
    && typeof preview === 'object'
    && !Array.isArray(preview)
    && Array.isArray(preview.editorIds)
    ? preview.editorIds
    : null;
  const previewIdsValid = Array.isArray(previewIds)
    && new Set(previewIds).size === previewIds.length
    && previewIds.every((editorId) => typeof editorId === 'string'
      && ALLOWED_EDITOR_IDS.has(editorId));
  if (!previewIdsValid) {
    add(
      'DEFERRED_PREVIEW_EDITOR_SET_INVALID',
      'SCOPE-EDITORS.deferredPreviewEditors.editorIds',
      'deferred preview editorIds 必须是已知、唯一的编辑器 id 数组。'
    );
  }
  if (typeof preview !== 'object'
    || preview === null
    || Array.isArray(preview)
    || !/^V\d+\.\d+$/.test(preview.deferredToRelease ?? '')
    || preview?.readOnly !== true
    || preview?.markedAsPreview !== true
    || preview?.countedAsReleaseEditor !== false) {
    add(
      'DEFERRED_PREVIEW_EDITOR_POLICY_INVALID',
      'SCOPE-EDITORS.deferredPreviewEditors',
      'deferred preview 必须声明合法目标版本、readOnly=true、'
        + 'markedAsPreview=true、countedAsReleaseEditor=false。'
    );
  }
  for (const editorId of previewIds ?? []) {
    if (editorIdsValid && editorIds.includes(editorId)) {
      add(
        'DEFERRED_PREVIEW_EDITOR_OVERLAP',
        `SCOPE-EDITORS.deferredPreviewEditors.editorIds[${editorId}]`,
        'deferred preview editor 不得同时出现在当前 user-approved editor 清单中。'
      );
    }
  }
}
