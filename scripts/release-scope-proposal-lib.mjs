/**
 * 范围提案的装配层：把治理 JSON 组装成范围门禁验证的那个形状。
 *
 * 为什么要单独一个模块：
 *
 * 「提案」不是一份独立数据，而是 docs/governance/scope.json（策略字段 + scopeItems）
 * 与 docs/governance/gates.json（Gate 覆盖）的一个固定形状投影。它此前只以
 * 交接书 §18.2.1 的内嵌 JSON 形态存在——1467 行，占全文 36%，而 scope.json
 * 已经是权威。范围门禁只解析那个 markdown 块，所以两边分叉时门禁看不见
 * （实测 27/27 条 scopeItem 缺 targetRelease/deferredTrack/resumeRequires）。
 *
 * 内嵌块退成人读摘要之后，装配逻辑必须落在代码里而不是 markdown 里。放在
 * 独立模块而不是塞进 verify-release-scope.mjs，是为了让键序与「哪些字段进提案」
 * 这两件事有一个可被其他门禁引用的单一声明：verify-handoff-projection-fixtures
 * 用 PROPOSAL_KEY_ORDER 锁键集，范围门禁用 findUnprojectedScopeFields 挡住
 * 「scope.json 新增字段但没人校验」。写在门禁内部的话，这两处只能各自抄一份键名表。
 *
 * markdown 渲染不在这里：generate-handoff-projection.mjs 的摘要表直接读
 * scopeData，不经过提案形状——摘要是给人看的投影，不是提案的第二份副本。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GOVERNANCE_DIR = 'docs/governance';
export const SCOPE_AUTHORITY = `${GOVERNANCE_DIR}/scope.json`;
export const GATES_AUTHORITY = `${GOVERNANCE_DIR}/gates.json`;

/**
 * 提案键顺序。锁死而不是靠 Object.keys 的插入序：
 * 范围门禁按键集判定策略完整性，投影 --check 逐字比对，两者都会被字段重排
 * 淹没。顺序沿用外置前内嵌块的排列，让这次改造的 diff 只反映「JSON 变摘要」。
 */
export const PROPOSAL_KEY_ORDER = Object.freeze([
  'schemaVersion',
  'proposalId',
  'release',
  'game',
  'gameBuildRange',
  'ruling',
  'proposalStatus',
  'unlistedPolicy',
  'corpusPolicy',
  'scopeDeferralPolicy',
  'authoritySnapshotPolicy',
  'paramMetadataSourcePolicy',
  'providerCredentialPolicy',
  'runtimeToolPolicy',
  'renderingAcceptancePolicy',
  'quantitativeAcceptancePolicy',
  'gateCoverage',
  'scopeItems'
]);

/**
 * scope.json 里不进提案的键。note 是给人读的来源说明，不是范围语义；
 * 显式列出而不是「凡不在 PROPOSAL_KEY_ORDER 里就丢掉」，这样 scope.json
 * 新增策略字段时会被 UNPROJECTED_SCOPE_FIELD 抓到，而不是静默漏投。
 */
export const NON_PROPOSAL_SCOPE_KEYS = Object.freeze(['note']);

/**
 * 从治理数据构造提案。
 *
 * 缺失字段落成显式 null，不能让 JSON.stringify 把键丢掉：范围门禁按键集
 * 判定，省略键会让它报「策略值不符合冻结要求」，而真实原因是 scope.json
 * 少了这个字段——诊断指向错误的地方。
 */
export function buildReleaseScopeProposal({ scopeData, gatesData }) {
  const scope = scopeData ?? {};
  const gates = Array.isArray(gatesData?.gates) ? gatesData.gates : [];
  const field = (key) => (scope[key] === undefined ? null : scope[key]);
  const proposal = {};
  for (const key of PROPOSAL_KEY_ORDER) {
    if (key === 'gateCoverage') {
      // gates.json 的四字段投影。currentState 是历史字段名，与 gateState 等价；
      // 保留原名以免同时改动门禁解析与数据形状——一次改造只动一个变量。
      proposal.gateCoverage = gates.map((gate) => ({
        gateId: gate.gateId,
        scopeItemIds: gate.scopeItemIds,
        currentState: gate.gateState,
        blockerRefs: gate.blockerRefs,
        openRulings: gate.openRulings
      }));
      continue;
    }
    proposal[key] = field(key);
  }
  return proposal;
}

/**
 * scope.json 里出现了既不在提案键序、也未登记为非提案键的字段。
 *
 * 返回值而不是抛异常：调用方（门禁）要把它变成结构化诊断，
 * 而 stack trace 不是诊断。
 */
export function findUnprojectedScopeFields(scopeData) {
  const known = new Set([...PROPOSAL_KEY_ORDER, ...NON_PROPOSAL_SCOPE_KEYS]);
  return Object.keys(scopeData ?? {}).filter((key) => !known.has(key));
}

/** 读治理 JSON。governanceRoot 可覆盖，供负向 fixture 注入扰动后的权威。 */
export function loadGovernanceSources(root = process.cwd(), governanceRoot = null) {
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  if (governanceRoot === null) {
    return {
      scopeData: readJson(join(root, SCOPE_AUTHORITY)),
      gatesData: readJson(join(root, GATES_AUTHORITY))
    };
  }
  return {
    scopeData: readJson(join(governanceRoot, 'scope.json')),
    gatesData: readJson(join(governanceRoot, 'gates.json'))
  };
}

/** 便捷入口：读权威并构造提案。 */
export function loadReleaseScopeProposal(root = process.cwd(), governanceRoot = null) {
  return buildReleaseScopeProposal(loadGovernanceSources(root, governanceRoot));
}
