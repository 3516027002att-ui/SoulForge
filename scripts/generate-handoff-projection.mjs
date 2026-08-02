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
export const BLOCKS = ({ slicesData, gatesData, blockersData, evidenceRecords, scopeData }) => ({
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

  // 七列。实测 47 行 × 6 个内容列与 evidence.jsonl 零分叉——它一直是纯投影，
  // 只是靠手抄维持。gov seal 追加一条后本区块自动带出，不必再手工加表格行。
  'evidence-index': () => table(
    ['Evidence ID', '类型', '能力/声明', '基线', '命令或记录', '样本/范围', '本轮结论与边界'],
    evidenceRecords.map((record) => [
      `\`${record.evidenceId}\``,
      `\`${record.evidenceType}\``,
      cell(record.subject),
      cell(record.fingerprint),
      cell(record.commands),
      cell(record.result),
      cell(record.nonClaims)
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
   * §18.2.1 范围提案 JSON 块。
   *
   * 这是交接书里最大的一处重复：1242 行内嵌 JSON，占全文 3563 行的 35%，
   * 而它与 scope.json 已经实测全面分叉——27 条 scopeItem 全部缺 targetRelease、
   * deferredTrack、resumeRequires，deferredToRelease 缺 15 处。分叉能长期存在
   * 是因为 verify-release-scope.mjs 只解析这个内嵌块，从不读 scope.json：
   * 门禁看不到权威数据，自然判不出分叉。
   *
   * gateCoverage 同样是复制。实测 11 条相对 gates.json 的
   * scopeItemIds/gateState/blockerRefs/openRulings 四字段零分叉——它本就是
   * gates.json 的投影，只是字段改了个名（gateState → currentState）。
   *
   * 投影之后 verify-release-scope.mjs 无需改动就读到权威数据：它解析的
   * markdown 块此刻由 JSON 生成。
   */
  'scope-proposal': () => {
    // key 顺序必须与原内嵌块一致，否则 diff 会淹没在字段重排里，
    // 而 --check 的判据是逐字相等。
    // 缺失字段必须落成显式 null 而不是被 JSON.stringify 丢掉键。
    // 省略键会让范围门禁报出指向错误原因的诊断——它按键集判定，看到的是
    // 「策略值不符合冻结要求」，而真实原因是 scope.json 少了这个字段。
    const field = (key) => (scopeData[key] === undefined ? null : scopeData[key]);
    const proposal = {
      schemaVersion: field('schemaVersion'),
      proposalId: field('proposalId'),
      release: field('release'),
      game: field('game'),
      gameBuildRange: field('gameBuildRange'),
      ruling: field('ruling'),
      proposalStatus: field('proposalStatus'),
      unlistedPolicy: field('unlistedPolicy'),
      corpusPolicy: field('corpusPolicy'),
      scopeDeferralPolicy: field('scopeDeferralPolicy'),
      authoritySnapshotPolicy: field('authoritySnapshotPolicy'),
      paramMetadataSourcePolicy: field('paramMetadataSourcePolicy'),
      providerCredentialPolicy: field('providerCredentialPolicy'),
      runtimeToolPolicy: field('runtimeToolPolicy'),
      renderingAcceptancePolicy: field('renderingAcceptancePolicy'),
      quantitativeAcceptancePolicy: field('quantitativeAcceptancePolicy'),
      // gates.json 的四字段投影。currentState 是历史字段名，保留以免动门禁解析。
      gateCoverage: gatesData.gates.map((gate) => ({
        gateId: gate.gateId,
        scopeItemIds: gate.scopeItemIds,
        currentState: gate.gateState,
        blockerRefs: gate.blockerRefs,
        openRulings: gate.openRulings
      })),
      scopeItems: scopeData.scopeItems
    };
    return ['```json', JSON.stringify(proposal, null, 2), '```'].join('\n');
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

/**
 * 纯函数：给定工作树根，算出投影后的交接书内容。不写文件。
 * 返回 findings 而不是抛异常——标记缺失是治理数据问题，要能进门禁报告。
 */
export function projectHandoff(root) {
  const sources = loadProjectionSources(root);
  const blocks = BLOCKS(sources);
  const original = readFileSync(join(root, HANDOFF), 'utf8');
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
    projected: next,
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
