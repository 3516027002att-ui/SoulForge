#!/usr/bin/env node
/**
 * 把 docs/governance/*.json 投影成交接书里的治理表格。
 *
 * 为什么必须生成而不是手写：
 *
 * 治理数据外化到 JSON 之后，交接书里的 §13.1 切片表、§13.1.1 claim 表、
 * §17.1 证据表、§18.3 Gate 表、§18.4 blocker 表全都变成了同一份数据的第二份
 * 副本。实测腐化已经发生：§13.1 的 39 行里有 12 行 goal 与 slices.json 语义
 * 分叉（markdown 侧 W-EMEVD-FULL-01 是 2269 字，JSON 侧是 111 字），而两套
 * 门禁全绿——等价性门禁只比对 finding code 多重集，不比对字段内容。
 *
 * 更直接的代价是每次封存证据都要手抄：gov seal 写完 JSONL 后，§17.1 还得
 * 人工加一行 2000 字表格行、§18.3 还得人工改 Evidence 引用列，漏一处
 * test:handoff-integrity 就红。这一步挡住了自主推进。
 *
 * 所以这里反过来：JSON 是唯一权威，markdown 表格由本脚本生成。人写的散文、
 * 规则说明、决策依据都在 BEGIN/END 标记之外，不受影响。
 *
 * 用法：
 *   node scripts/generate-handoff-projection.mjs          # 写回交接书
 *   node scripts/generate-handoff-projection.mjs --check   # 只校验，不写（门禁用）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TIER_ORDER, TIER_BY_SCRIPT, EXCLUDED } from './verify/tiers.mjs';

export const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';

/**
 * 需要用反引号渲染的 token。治理 JSON 刻意不存反引号——它是 markdown 排版符号，
 * 不是数据（handoff-integrity-lib 的 plain() 第一步就把它剥掉，所有门禁判定都在
 * 剥掉之后进行，所以它对语义零影响）。但交接书原有排版用它区分标识符与叙述文本，
 * 去掉会让 3000 字的表格单元格更难读。所以在渲染层按模式重加。
 *
 * 顺序敏感：npm 脚本名可能含点号与冒号，必须先匹配长形式。
 */
const CODE_TOKEN_PATTERNS = [
  /\bnpm run [a-z0-9:_-]+/g,                                    // npm run test:foo
  /\bnpm test\b/g,
  /\bnode(?: --[a-z-]+)* [a-z0-9/._-]+\.(?:mjs|js|ts|cjs)\b/g,   // node scripts/x.mjs
  /\bgit [a-z-]+(?: --[a-z-]+)*/g,                               // git diff --check
  // 仓库内路径。结尾必须是标识符字符或扩展名，不能吞掉紧跟的中文注记
  // （真实数据里有 `bridge/…/TaeNativeDocument.cs（延期）`，括号必须留在引号外）。
  /(?<![`\w/.-])(?:docs|scripts|packages|apps|src|bridge)\/[A-Za-z0-9/._-]*[A-Za-z0-9_]/g,
  /(?<![`\w/.-])licenses\//g,                                    // 顶层目录，以斜杠结尾
  /\b(?:W|EV|REL|BLK|SCOPE)-[A-Z0-9-]+/g,                        // 治理 ID
  // cap= 前缀留在反引号外，与交接书原有排版一致（`cap=partial` 与 cap=`partial`
  // 对门禁等价——正则跑在 plain() 剥掉反引号之后——但保留原排版让 diff 只反映真实变化）。
  /(?<=\bcap=)(?:unsupported|candidate|fixture-confirmed|partial|native-verified|unverified)\b/g,
  /\b(?:scope-ruling|scope-deferral|revalidates)[:=][A-Za-z0-9:.-]+/g,
  /\bvalidation-unfrozen\b/g,
  /\b(?:test|typecheck|build|lint):[a-z0-9:_-]+/g,               // 裸脚本名 test:foo
  /\b[a-z][A-Za-z0-9]*\.(?:mjs|ts|tsx|json|jsonl|md|dll|exe)\b/g, // 文件名
  /\b[0-9a-f]{7,40}\b/g,                                         // git 短/全 hash
  // 驼峰标识符（函数、导出、类型名）。要求至少一个内部大写且长度 >= 6，
  // 避免把 PARAM、DSL 这类全大写缩写或 native 这类普通词误当标识符。
  /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*){1,}\b(?=[\s、（(,;；。]|$)/g,
  // 复合状态标记只在带连字符或明确取值语境时装饰。裸的 ready / active / open /
  // partial 在真实叙述里就是普通英文词——claim 表的 recoveryTrigger 写着
  // 「原子回退 ready」，把它渲染成代码是错的装饰而不是排版还原。
  /\b(?:fixture-confirmed|native-verified|in-scope|scope-excluded|pending-scope|deferred-v0\.6|validation-unfrozen)\b/g,
  /(?<=\b(?:lifecycle|authority|gateState|applicability|状态|记为|保持|标记为)[=为是 ])(?:unsupported|candidate|partial|unverified|blocked|deferred|ready|active|completed|superseded|open|passed)\b/g
];

/**
 * 在文本里给 token 加反引号。已在反引号内的 token 不重复包裹——按位置区间
 * 去重，而不是逐个 replace（逐个 replace 会让 `test:foo` 里的 `foo` 被二次匹配）。
 */
function decorate(text) {
  const spans = [];
  for (const pattern of CODE_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      // 与已收录区间重叠就跳过：先匹配的模式更长、更具体，优先保留。
      if (spans.some((span) => start < span.end && end > span.start)) continue;
      spans.push({ start, end });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + '`' + text.slice(span.start, span.end) + '`';
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * markdown 表格单元格：竖线会截断列，换行会截断行。
 * 默认加反引号装饰；`raw: true` 用于本身已是 markdown 的内容。
 */
function cell(value, { raw = false } = {}) {
  if (value === null || value === undefined) return '—';
  let text = String(value).replaceAll('|', '\\|').replaceAll('\r\n', ' ').replaceAll('\n', ' ');
  if (text.length === 0) return '—';
  // 数据里出现奇数个反引号时，markdown 会把这一格之后的文本全部吞成代码，
  // 一直吃到下一个反引号——可能跨越好几列。治理 JSON 本不该存反引号
  // （它是排版符号），但数据由人和 CLI 共同写入，不能假定它一定干净。
  // 补一个配平，而不是让一处脏数据毁掉整张表的可读性。
  if ((text.match(/`/g) ?? []).length % 2 !== 0) text += '`';
  return raw ? text : decorate(text);
}

/** ID 列表渲染成反引号 + 顿号；空列表是 `—` 而不是空字符串（空单元格会让表格歧义）。 */
function idList(values) {
  if (!Array.isArray(values) || values.length === 0) return '—';
  return values.map((value) => `\`${value}\``).join('、');
}

/**
 * 入口列表。entryPoints 不全是路径——真实数据里混着「对应 Bridge writer」
 * 「本文 §4~§12 与 §18.1~§18.2.1」这类叙述性入口。整条包反引号会把散文渲染成
 * 代码，所以逐条走 decorate()：路径与文件名被识别加引号，叙述保持原样。
 */
function entryPointList(values) {
  if (!Array.isArray(values) || values.length === 0) return '—';
  return values.map((value) => decorate(String(value))).join('、');
}

function table(header, rows) {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n');
}

/** 读取治理数据。抽成函数而不是模块顶层常量，fixture 才能对任意工作树取投影。 */
export function loadProjectionSources(root) {
  const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
  return {
    slicesData: readJson('docs/governance/slices.json'),
    gatesData: readJson('docs/governance/gates.json'),
    blockersData: readJson('docs/governance/blockers.json'),
    scopeData: readJson('docs/governance/scope.json'),
    validationData: readJson('docs/governance/validation.json'),
    evidenceRecords: readFileSync(join(root, 'docs/governance/evidence.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  };
}

/**
 * 各投影区块。key 对应 markdown 里的 BEGIN/END 标记名。
 *
 * 列集必须与 handoff-integrity-lib 的 SLICE_HEADERS / ACTIVE_CLAIM_HEADERS /
 * BLOCKER_HEADERS 逐 token 一致——那个解析器是迁移期回归网，列数或列序变了
 * 它会报 *_TABLE_SCHEMA_INVALID。列名不是自由文本，改名等于改门禁。
 */
export const BLOCKS = ({ slicesData, gatesData, blockersData, evidenceRecords, scopeData, validationData }) => ({
  // 十列 schema 与 SLICE_HEADERS 对齐。注意列名与 JSON 字段并非同名：
  // 「目标能力」列装的是 capabilityIds（能力 ID 列表），「可独立验收切片」列
  // 才是 goal 文本。实测确认：capabilityIds/requiredValidation/authorityCapNote
  // 三列 39/39 行与 JSON 完全一致，hardPrerequisites 与 entryPoints 各 1 行差异，
  // goal 有 12 行语义分叉——分叉全部来自手抄，JSON 侧是权威。
  'slice-panel': () => table(
    ['切片ID', 'lifecycle', 'authority', 'blockerRefs', '目标能力', '可独立验收切片', '硬前置', '主要入口', 'required validation', 'authority上限'],
    slicesData.slices.map((slice) => [
      `\`${slice.sliceId}\``,
      `\`${slice.lifecycle}\``,
      `\`${slice.authority}\``,
      idList(slice.blockerRefs),
      // 多能力用 ` / ` 分隔而非顿号，与交接书原排版一致。JSON 侧曾把
      // "C-MSB / I-RENDER" 整串当成一个 capabilityId 存着（抽取期失真），
      // 本轮已拆成真数组；分隔符属于渲染层，不该回到数据里。
      slice.capabilityIds.length === 0 ? '—' : slice.capabilityIds.map((id) => `\`${id}\``).join(' / '),
      // goal 是待做陈述，evidence 是已完成留痕。两者在同一列里用分隔符拼接，
      // 因为 SLICE_HEADERS 是十列定值，加列会打断解析器。goal 必须在前：
      // SLICE_FIELD_REQUIRED 只检查非空，读者却按从左到右取「现在要做什么」。
      cell(typeof slice.evidence === 'string' && slice.evidence.length > 0
        ? `${slice.goal}｜已完成证据：${slice.evidence}`
        : slice.goal),
      cell(slice.hardPrerequisites),
      entryPointList(slice.entryPoints),
      cell(slice.requiredValidation),
      cell(slice.authorityCapNote)
    ])
  ),

  // 列名必须是 sliceId/claimId/owner/claimedAt/heartbeatAt/recoveryTrigger
  // 原文，ACTIVE_CLAIM_HEADERS 按 token 精确匹配，中文化会报表 schema 无效。
  'active-claims': () => (slicesData.activeClaims.length === 0
    ? '当前没有 active claim。gov claim 获取、gov complete 释放；表格由 generate-handoff-projection 从 slices.json 投影。'
    : table(
      ['sliceId', 'claimId', 'owner', 'claimedAt', 'heartbeatAt', 'recoveryTrigger'],
      slicesData.activeClaims.map((claim) => [
        `\`${claim.sliceId}\``,
        `\`${claim.claimId}\``,
        cell(claim.owner),
        cell(claim.claimedAt),
        cell(claim.heartbeatAt),
        cell(claim.recoveryTrigger)
      ])
    )),

  // Evidence 在交接书中只保留可检索索引：ID 是交叉引用锚，subject 是人读时定位
  // 证据用途所需的最小描述。类型、封存指纹、命令、结果、非声明项与目标版本继续
  // 由 evidence.jsonl 权威保存并由 JSON 治理门禁判定；Gate 反向引用在 gate-matrix。
  // 把审计正文复制到人读交接书只会让每次 seal 持续放大同一份数据。
  'evidence-index': () => table(
    ['Evidence ID', '能力/声明'],
    evidenceRecords.map((record) => [
      `\`${record.evidenceId}\``,
      cell(record.subject)
    ])
  ),

  'gate-matrix': () => table(
    ['Gate ID', 'capability', '当前切片', 'gateState', 'applicability', 'Evidence/blockerRefs', '后继要求'],
    gatesData.gates.map((gate) => [
      `\`${gate.gateId}\``,
      cell(gate.capability),
      idList(gate.sliceRefs),
      `\`${gate.gateState}\``,
      `\`${gate.applicability}\``,
      idList([...gate.evidenceRefs, ...gate.blockerRefs]),
      cell(gate.successorRequirement)
    ])
  ),

  // 八列，实测 9 行全列零分叉。影响列用 impactRaw 原文而不是重组
  // impactGateRefs+impactSliceRefs：原文带「历史：…；当前无活动引用」这类限定语，
  // 而 §18.4 正文规定当前阻塞状态只由活动 blockerRefs 判定——限定语丢了就会把
  // 历史审计行误读成当前阻塞。impactGateRefs/impactSliceRefs 是从原文抽出的
  // 机器可判定投影，供门禁做双向引用校验，不是渲染源。
  'blocker-index': () => table(
    ['blockerId', 'reason', '影响 Gate/切片', '责任方', '所需输入', '解锁验证', '复查触发器', 'Evidence'],
    blockersData.blockers.map((blocker) => [
      `\`${blocker.blockerId}\``,
      `\`${blocker.reason}\``,
      cell(blocker.impactRaw),
      cell(blocker.owner),
      cell(blocker.requiredInput),
      cell(blocker.unlockValidation),
      cell(blocker.recheckTrigger),
      idList(blocker.evidenceRefs)
    ])
  ),

  /**
   * §18.2.1 各 Gate 的开放裁定与收敛条件。
   *
   * 存在理由是覆盖而不是呈现：openRulings 是 gates.json 里唯一既不进 §18.2.1
   * 摘要表、也不被范围门禁按内容校验的 gateCoverage 字段（门禁只判非空字符串
   * 数组）。§18.2.1 退成摘要后，改写这 11 条收敛条件不再扰动 REL-SCOPE 指纹；
   * 把它们投影进块，指纹就重新覆盖到（块内容变 → 主题域变 → 证据 stale）。
   *
   * 为什么不改成登记 gates.json 文件：seal 自己要往 gates.json 追加 evidenceRefs，
   * 登记该文件会让 postcheck 必然判 REL-SCOPE stale 并回滚——实测锁死整条 seal。
   * 详见 handoff-integrity-lib.mjs 里 SCOPE_SUBJECT_SET 的那段说明。
   *
   * 只取 gateId + openRulings：gateState 已在摘要表的 Gate 列，
   * blockerRefs/scopeItemIds 由范围门禁运行期双向锁死。多投影一个字段就多一处
   * 需要同步的副本，而副本不增加判定力。
   */
  'gate-rulings': () => {
    const gates = Array.isArray(gatesData?.gates) ? gatesData.gates : [];
    if (gates.length === 0) {
      // 与 scope-proposal 同一处理：空表格会撞 has-rows 断言，而那条断言是对的。
      return '当前 gates.json 未登记 Gate。权威是 docs/governance/gates.json，'
        + '本表由 generate-handoff-projection 投影。';
    }
    return table(
      ['Gate ID', '开放裁定 / 收敛条件'],
      gates.map((gate) => [
        `\`${gate.gateId}\``,
        // 多条裁定用分号连接而不是换行：表格单元不能含裸换行（cell 会压平），
        // 而逐条分行需要把一个 Gate 拆成多行，破坏「一 Gate 一行」与行数断言。
        cell(Array.isArray(gate.openRulings) ? gate.openRulings.join('；') : gate.openRulings)
      ])
    );
  },

  /**
   * §18.2.1 范围条目摘要。
   *
   * 这里曾是交接书里最大的一处重复：1467 行内嵌 JSON，占全文 4121 行的 36%，
   * 逐字复制 scope.json（1295 行）再加 gates.json 的四字段投影。它长期与权威
   * 分叉——27 条 scopeItem 全部缺 targetRelease、deferredTrack、resumeRequires，
   * deferredToRelease 缺 15 处——因为 verify-release-scope.mjs 只解析那个内嵌块，
   * 从不读 scope.json：门禁看不到权威数据，自然判不出分叉。
   *
   * 上一轮把它改成 scope.json 的投影，消除了分叉但没消除体积：机器数据仍然
   * 整份躺在人读文档里，而权威在旁边的 JSON 文件里。本轮退成摘要表——
   * 一条 scopeItem 一行，operations 只给条数。
   *
   * 为什么摘要不给 operations 全文：那是范围门禁逐条判定的对象
   * （requireFrozenOperation / forbidFrozenOperation 等），交接书复述一遍
   * 不增加任何判定力，只会重新长出一份需要同步的副本。人读摘要要回答的是
   * 「这一条在不在本版、归哪个 Gate、authority 到哪」，不是「第 7 个 operation
   * 叫什么」——后者去 scope.json 查，路径就在块外的引言里。
   *
   * 空 scopeItems 渲染成说明文字而不是空表格：与 active-claims 同一处理，
   * 空表格会撞 has-rows 断言，而那条断言本身是对的。
   */
  'scope-proposal': () => {
    const items = Array.isArray(scopeData?.scopeItems) ? scopeData.scopeItems : [];
    if (items.length === 0) {
      return '当前 scope.json 未登记范围条目。权威是 docs/governance/scope.json，'
        + '本表由 generate-handoff-projection 投影。';
    }
    // Gate 当前状态取自 gates.json，与 §18.3 同源。摘要里带上它，是因为
    // 「这条范围归哪个 Gate」和「那个 Gate 现在什么状态」在人读时是同一个问题；
    // 两处同源投影不构成副本——分叉由 --check 逐字判定挡住。
    const gateStates = new Map((gatesData?.gates ?? []).map((gate) => [gate.gateId, gate.gateState]));
    return table(
      ['scopeItemId', 'capability', 'Gate（当前状态）', 'proposedSupport', 'targetRelease', 'authorityAtRuling', 'operations', 'unsupported', '范围'],
      items.map((item) => [
        `\`${item.scopeItemId}\``,
        item.capabilityId === undefined || item.capabilityId === null ? '—' : `\`${item.capabilityId}\``,
        !Array.isArray(item.gateIds) || item.gateIds.length === 0
          ? '—'
          : item.gateIds.map((gateId) => `\`${gateId}\`（\`${gateStates.get(gateId) ?? 'unknown'}\`）`).join('、'),
        item.proposedSupport === undefined || item.proposedSupport === null ? '—' : `\`${item.proposedSupport}\``,
        // deferred 条目的承接版本必须显式呈现：延期不等于放弃，而
        // targetRelease 单独一列读起来像「本版就要做」。
        item.proposedSupport === 'deferred' && typeof item.deferredToRelease === 'string'
          ? `\`${item.targetRelease ?? '—'}\` → 延期 \`${item.deferredToRelease}\``
          : (item.targetRelease === undefined || item.targetRelease === null ? '—' : `\`${item.targetRelease}\``),
        item.authorityAtRuling === undefined || item.authorityAtRuling === null ? '—' : `\`${item.authorityAtRuling}\``,
        String(Array.isArray(item.operations) ? item.operations.length : 0),
        String(Array.isArray(item.unsupportedOperations) ? item.unsupportedOperations.length : 0),
        cell(item.scope)
      ])
    );
  },

  /**
   * §13.4 冻结验证表。
   *
   * 这个块此前是 21 个手写 `~~~text` 四元组围栏，190 行，逐字复制
   * validation.json 的 frozen 数组。与 §13.1 和 §18.2.1 的病因完全一致：
   * 权威已经外化成 JSON，但人读文档里还躺着第二份副本，而 frozen 数组
   * **没有任何一致性门禁**（unfrozen 有——validateGovernanceData 拿它反查
   * slices.json；frozen 只有 schema 校验），所以分叉不会被发现。
   *
   * 实测分叉（2026-08-15，本块落地前）：W-ME3-ADAPTER-01、
   * W-ME3-MAIN-DETECT-02、W-ME3-PROFILE-03 三条的 exitSemantics 已经分叉——
   * JSON 侧写 sekiroProcessLifecycleObserved=false，交接书侧还是旧字段名
   * realSekiroExecuted=false。字段改名只落了一半，两套门禁全绿。
   *
   * 为什么表里只留 script 与 exitSemantics：
   *
   * 四个字段合计 12,479 字符，其中 assertion 占 40.6%（均 241 字符）、
   * fixture 占 22.6%。人读 §13.4 要回答的是「这条切片冻结了哪几条命令、
   * 它明确**不**证明什么」——后者是 authority 边界，是全仓最不能丢的一类
   * 信息（硬约束：skipped/candidate/fixture 通过不得写成 native authority）。
   * assertion 的样本数与断言枚举是机器细节，与 §18.2.1 的 operations 同一
   * 性质：给指针，不给全文。fixture 一并出表，因为 exitSemantics 里已经写明
   * 真实/合成分支与缺环境时的跳过语义。
   *
   * 不做截断：authority 文本截断可能把「skipped 不得解释为通过」切掉半句，
   * 那比不写更危险。exitSemantics 整段进单元格——markdown 表格一行一条，
   * 长单元格不增加行数。
   */
  'validation-freeze': () => {
    const frozen = Array.isArray(validationData?.frozen) ? validationData.frozen : [];
    if (frozen.length === 0) {
      return '当前 validation.json 未登记冻结验证。权威是 docs/governance/validation.json，'
        + '本表由 generate-handoff-projection 投影。';
    }
    return table(
      ['切片', 'targetRelease', '冻结命令', '边界（exitSemantics）'],
      frozen.map((entry) => [
        `\`${entry.sliceId}\``,
        entry.targetRelease === undefined || entry.targetRelease === null ? '—' : `\`${entry.targetRelease}\``,
        cell(entry.script),
        cell(entry.exitSemantics)
      ])
    );
  },

  /**
   * §15 命令清单。
   *
   * 原先是手写的分组裸命令列表：实测列出 38 条，而 package.json 有 144 条——
   * 106 条从未出现在交接书里。它是一份注定落后的部分复制，而落后不会被任何
   * 门禁发现（§15 不参与指纹，也没有等价性比对）。
   *
   * 权威是 scripts/verify/tiers.mjs：每条 script 要么有层级，要么写明排除理由，
   * 漏登记由 verify:audit 失败关闭。所以这里按层级投影，不再手写分组。
   * 每条命令的「证明什么/不证明什么」仍是工程判断，留在 §15.1 手写矩阵里。
   */
  'command-index': () => {
    const byTier = new Map(TIER_ORDER.map((tier) => [tier, []]));
    for (const [script, tier] of Object.entries(TIER_BY_SCRIPT)) {
      byTier.get(tier)?.push(script);
    }
    const lines = [
      `全部 ${Object.keys(TIER_BY_SCRIPT).length} 条已登记验证命令按层级列出。层级顺序即执行顺序（先快后慢，早失败早停）。`,
      '',
      '一次跑完某一层：`node scripts/verify.mjs --tier <层级>`；跑全部：`npm run verify:all`。',
      ''
    ];
    for (const tier of TIER_ORDER) {
      const scripts = byTier.get(tier) ?? [];
      if (scripts.length === 0) continue;
      lines.push(`**${tier}**（${scripts.length} 条）`, '');
      lines.push('~~~powershell');
      for (const script of [...scripts].sort()) {
        lines.push(script.includes(' ') ? script : `npm run ${script}`);
      }
      lines.push('~~~', '');
    }
    const excluded = Object.entries(EXCLUDED);
    lines.push(`另有 ${excluded.length} 条 script 显式排除在验证调度之外（写入命令、外部工具或入口自身）：`, '');
    lines.push(...excluded.map(([script, reason]) => `- \`${script}\`：${reason}`));
    return lines.join('\n');
  }
});

export const beginMarker = (name) => `<!-- SOULFORGE_PROJECTION_BEGIN:${name} -->`;
export const endMarker = (name) => `<!-- SOULFORGE_PROJECTION_END:${name} -->`;

/**
 * 替换单个区块。找不到标记是硬错误而不是跳过：
 * 静默跳过会让「投影已更新」这个结论变成谎言，而表格仍是旧副本。
 */
function replaceBlock(markdown, name, body) {
  const begin = beginMarker(name);
  const end = endMarker(name);
  const beginIndex = markdown.indexOf(begin);
  const endIndex = markdown.indexOf(end);
  if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) {
    return {
      ok: false,
      code: 'PROJECTION_MARKER_MISSING',
      message: `交接书缺少投影标记对 ${name}；无法确定生成区边界。`
    };
  }
  if (markdown.indexOf(begin, beginIndex + 1) >= 0 || markdown.indexOf(end, endIndex + 1) >= 0) {
    return {
      ok: false,
      code: 'PROJECTION_MARKER_DUPLICATE',
      message: `投影标记 ${name} 出现多次；生成区必须唯一。`
    };
  }
  return {
    ok: true,
    markdown: `${markdown.slice(0, beginIndex + begin.length)}\n\n${body}\n\n${markdown.slice(endIndex)}`
  };
}

/** 统计 CRLF 与裸 LF，用于判定文件的主导行尾。 */
function countCrlf(text) {
  return (text.match(/\r\n/g) ?? []).length;
}

function countBareLf(text) {
  return (text.match(/(?<!\r)\n/g) ?? []).length;
}

/**
 * 纯函数：给定工作树根，算出投影后的交接书内容。不写文件。
 * 返回 findings 而不是抛异常——标记缺失是治理数据问题，要能进门禁报告。
 */
export function projectHandoff(root) {
  const sources = loadProjectionSources(root);
  const blocks = BLOCKS(sources);
  const rawOriginal = readFileSync(join(root, HANDOFF), 'utf8');

  // 行尾必须归一化后再比对，且写回时沿用原文件的主导行尾。
  //
  // 实测的 agent 阻塞：本仓库 core.autocrlf=true，checkout 会把交接书整篇转成
  // CRLF，而各区块是用 '\n'.join 生成的。于是 next !== original 恒成立，--check
  // 每次 checkout 后必红，诊断说「运行重新生成」；但重新生成后 git diff 输出 0 行
  // （autocrlf 在索引侧又归一化回去了）。agent 看到的是「门禁红 + diff 空」，
  // 照诊断重跑生成也不解决，只能反复空转。
  //
  // 归一化只用于判定与生成；写回时按原文件的主导行尾还原，避免投影命令把
  // 整篇文件的行尾改掉，制造一个 3860 行的伪 diff 淹没真实改动。
  const dominantEol = countCrlf(rawOriginal) > countBareLf(rawOriginal) ? '\r\n' : '\n';
  const original = rawOriginal.replaceAll('\r\n', '\n');
  let next = original;
  const findings = [];

  for (const [name, build] of Object.entries(blocks)) {
    const outcome = replaceBlock(next, name, build());
    if (outcome.ok === false) {
      findings.push({ severity: 'error', code: outcome.code, where: `${HANDOFF} ${name}`, message: outcome.message });
      continue;
    }
    next = outcome.markdown;
  }

  return {
    original,
    projected: dominantEol === '\r\n' ? next.replaceAll('\n', '\r\n') : next,
    drifted: next !== original,
    findings,
    blocks: Object.keys(blocks),
    counts: {
      slices: sources.slicesData.slices.length,
      activeClaims: sources.slicesData.activeClaims.length,
      evidence: sources.evidenceRecords.length,
      gates: sources.gatesData.gates.length,
      blockers: sources.blockersData.blockers.length
    }
  };
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].replaceAll('\\', '/').endsWith('generate-handoff-projection.mjs');

if (invokedDirectly) {
  const root = process.cwd();
  const checkOnly = process.argv.includes('--check');
  const outcome = projectHandoff(root);

  if (outcome.findings.length > 0) {
    console.log(JSON.stringify({
      ok: false,
      mode: checkOnly ? 'check' : 'write',
      message: '投影失败；交接书标记不完整。',
      findings: outcome.findings
    }, null, 2));
    process.exitCode = 1;
  } else if (checkOnly) {
    console.log(JSON.stringify({
      ok: !outcome.drifted,
      mode: 'check',
      message: outcome.drifted
        ? '交接书投影区与治理 JSON 不一致；运行 node scripts/generate-handoff-projection.mjs 重新生成。'
        : '交接书投影区与治理 JSON 一致。',
      blocks: outcome.blocks,
      counts: outcome.counts,
      note: '本检查只覆盖 BEGIN/END 标记内的生成区；标记外的散文由工程复核负责。'
    }, null, 2));
    process.exitCode = outcome.drifted ? 1 : 0;
  } else {
    if (outcome.drifted) writeFileSync(join(root, HANDOFF), outcome.projected, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      mode: 'write',
      changed: outcome.drifted,
      blocks: outcome.blocks,
      counts: outcome.counts,
      message: outcome.drifted ? '已按治理 JSON 重新生成交接书投影区。' : '投影区已与治理 JSON 一致，未改动文件。'
    }, null, 2));
  }
}
