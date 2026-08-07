/**
 * SoulForge V0.5 handoff 确定性静态门禁。
 *
 * handoff 是治理事实源；本脚本只读取仓库文件并汇总纯函数校验、链接、
 * npm script 与敏感内容扫描，不维护第二份人工状态清单。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  collectSealAnchors,
  parseSealBaseline,
  validateHandoffGovernance
} from './handoff-integrity-lib.mjs';
import { buildFreshnessContext } from './governance/freshnessContext.mjs';
import { loadGovernanceData } from './governance/loadGovernance.mjs';
import { projectEvidence } from './governance/projectGovernance.mjs';

const root = process.cwd();
const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';
const PLAYBOOK = 'docs/AGENT_EXECUTION_PLAYBOOK.md';
const README = 'README.md';
const PKG = 'package.json';

const findings = [];
const add = (severity, code, where, message) => findings.push({ severity, code, where, message });

// §17.1 已压成 ID + subject 索引。seal/freshness 的完整判据继续复用
// evidence.jsonl 权威记录，不从索引展示字段反推或复制第二套 Evidence 语义。
const loadedGovernance = loadGovernanceData(root);
const authoritativeEvidence = loadedGovernance.data === null
  ? null
  : projectEvidence(loadedGovernance.data.evidence, parseSealBaseline);
if (loadedGovernance.data === null) findings.push(...loadedGovernance.findings);

function readOrNull(relativePath) {
  const absolutePath = join(root, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
}

const handoff = readOrNull(HANDOFF);
const playbook = readOrNull(PLAYBOOK);

// 受管文档集合。三处扫描（npm script、node/gov 引用、敏感内容）必须用同一份清单：
// 各处各写一遍数组，加文档时漏改其中一处的后果是「以为扫了、其实没扫」——
// 而这正是本仓库反复踩到的那类假门禁。
const MANAGED_DOCS = [
  [HANDOFF, handoff],
  [PLAYBOOK, playbook]
];
const readme = readOrNull(README);
const packageJsonRaw = readOrNull(PKG);

if (handoff === null) add('error', 'HANDOFF_MISSING', HANDOFF, '交接书缺失，无法作为治理事实源。');
if (playbook === null) add('error', 'PLAYBOOK_MISSING', PLAYBOOK, '交接书引用的执行手册缺失。');

if (readme === null) add('error', 'README_MISSING', README, 'README 缺失，无法提供唯一实施规范入口。');
if (packageJsonRaw === null) add('error', 'PKG_MISSING', PKG, 'package.json 缺失，无法校验 npm script。');

if (readme !== null) {
  const handoffLink = /\]\((?:\.\/)?docs\/V0_5_IMPLEMENTATION_HANDOFF\.md(?:#[^)]+)?\)/;
  if (!handoffLink.test(readme)) {
    add('error', 'README_HANDOFF_LINK_MISSING', README, 'README 必须直接链接唯一实施规范 handoff。');
  }
  const localRuleFile = ['AGENTS', '.md'].join('');
  if (readme.toLowerCase().includes(localRuleFile.toLowerCase())) {
    add('error', 'README_LOCAL_RULE_DEPENDENCY', README, 'README 不得依赖仅存在于本机的代理规则文件。');
  }
}

function checkLinks(relativePath, content) {
  if (content === null) return;
  const baseDirectory = dirname(join(root, relativePath));
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    let target = match[1].trim();
    if (/^(https?:|mailto:|#|data:)/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
    if (!target) continue;
    const absoluteTarget = resolve(baseDirectory, target);
    if (!existsSync(absoluteTarget)) {
      add('error', 'DEAD_LINK', relativePath, `断链：[... ](${match[1]}) 指向不存在的文件。`);
    }
  }
}

checkLinks(README, readme);
checkLinks(HANDOFF, handoff);
checkLinks(PLAYBOOK, playbook);

if (handoff !== null) {
  // 上下文构建与 JSON 门禁共用同一实现；差异只在锚点来源：本门禁的证据表在
  // markdown §17.1，JSON 门禁的在 evidence.jsonl。
  const freshnessContext = buildFreshnessContext({
    root,
    handoffMarkdown: handoff,
    anchors: collectSealAnchors(handoff, authoritativeEvidence)
  });
  findings.push(...validateHandoffGovernance(handoff, {
    source: HANDOFF,
    freshnessContext,
    authoritativeEvidence
  }).findings);
}

let scriptNames = new Set();
if (packageJsonRaw !== null) {
  try {
    const packageJson = JSON.parse(packageJsonRaw);
    scriptNames = new Set(Object.keys(packageJson.scripts ?? {}));
  } catch (error) {
    add('error', 'PKG_PARSE_FAIL', PKG, `package.json 解析失败：${error.message}`);
  }
}

if (scriptNames.size > 0) {
  for (const [relativePath, content] of MANAGED_DOCS) {
    if (content === null) continue;
    // 刻意保持宽松：只要文本里出现 "npm run X"，X 就必须是真脚本。
    //
    // 踩过两次同一个歧义——`npm run` script 存在性（反引号闭合在 run 之后，
    // 被引用的是词组本身）在治理数据归一化剥掉反引号后变成 npm run script，
    // 撞出 NPM_SCRIPT_MISSING。试过用负向先行断言 /npm run(?!`) …/ 排除，
    // 实测无效：触发时反引号已经不在那个位置了，先行断言对归一化后的文本和
    // `npm run script` 整串包引号两种形式都不生效。
    //
    // 真正的结论是这不该在正则里修。文档写「npm run 脚本名存在性」而不是
    // 「`npm run` script 存在性」就没有歧义，而放宽正则会让真实的脚本名笔误
    // 溜过去——那是本检查唯一的价值。措辞是可控的，漏报不可控。
    const runPattern = /npm run ([a-z0-9:_-]+)/g;
    const seen = new Set();
    let match;
    while ((match = runPattern.exec(content)) !== null) {
      const scriptName = match[1];
      if (seen.has(scriptName)) continue;
      seen.add(scriptName);
      if (!scriptNames.has(scriptName)) {
        add(
          'error',
          'NPM_SCRIPT_MISSING',
          relativePath,
          `引用了 package.json 中不存在的 npm script：${scriptName}`
        );
      }
    }
  }
}

// `node scripts/X.mjs` 与 `gov.mjs <子命令>` 同样必须真实存在。
//
// 治理 CLI 现在是 agent 的首选入口：执行手册的 L0/L1/L6 与选点决策树都直接给出
// gov 子命令，交接书 §15 也列命令。这些引用此前不被任何门禁校验——脚本改名或
// 子命令重命名后文档会静默指向不存在的东西，而首次上手的 agent 撞到的第一条命令
// 就报 GOV_COMMAND_UNKNOWN，最坏情况下会以为整套治理流程不可用。
//
// 只校验存在性，不校验参数：参数由 gov help 承担，文档复述参数细节本身就是重复。
{
  // 判据是「CLI 真正会接受的命令」,不是「COMMANDS 对象的键」。
  // 这个区别是被本门禁自己的首次运行证伪出来的:`help` 走 dispatch 里的显式分支
  // (`command === 'help'`)而不在 COMMANDS 里,只读 COMMANDS 会把手册里正确的
  // `gov help` 报成不支持——门禁指向错误原因,比没有门禁更糟。
  const govCommands = new Set();
  const govSource = readOrNull('scripts/gov.mjs');
  if (govSource === null) {
    add('error', 'GOV_SOURCE_UNREADABLE', 'scripts/gov.mjs',
      '无法读取 gov CLI 源码；子命令清单不可提取，文档里的命令引用将不再被校验。');
  } else {
    const commandsBlock = govSource.match(/const COMMANDS = Object\.freeze\(\{([\s\S]*?)^\}\)/m);
    for (const name of commandsBlock?.[1].match(/^\s{2}(\w+):/gm) ?? []) {
      govCommands.add(name.trim().replace(':', ''));
    }
    const branchPattern = /command === '-{0,2}([a-z]+)'/g;
    let branchMatch;
    while ((branchMatch = branchPattern.exec(govSource)) !== null) {
      govCommands.add(branchMatch[1]);
    }
    // 提取失败必须失败关闭，而不是静默跳过后面的 GOV_SUBCOMMAND_MISSING 检查。
    //
    // 这里原本是在循环里 `if (govCommands.size === 0) continue;`。那条 continue 的
    // 后果不是漏报一条，而是**整块检查消失**：上面的正则依赖 gov.mjs 恰好写成
    // `const COMMANDS = Object.freeze({` 且两空格缩进，只要有人改名、改缩进或换
    // 写法，集合就为空，于是交接书里所有 gov 子命令引用从此不再校验——而门禁
    // 依旧全绿。同仓库两处同类提取（verify-v06-deferral-index.mjs、
    // verify-handoff-projection-fixtures.mjs）在取不到值时都判红，只有这一处是跳过。
    if (govCommands.size === 0) {
      add('error', 'GOV_COMMAND_LIST_UNEXTRACTABLE', 'scripts/gov.mjs',
        '无法从 gov.mjs 提取任何子命令（COMMANDS 表写法或缩进可能已变）；'
        + '提取失败必须失败关闭，否则文档里的 gov 命令引用将静默不再被校验。');
    }
  }

  for (const [relativePath, content] of MANAGED_DOCS) {
    if (content === null) continue;

    const nodeScriptPattern = /node (scripts\/[A-Za-z0-9./_-]+\.mjs)/g;
    const seenScripts = new Set();
    let scriptMatch;
    while ((scriptMatch = nodeScriptPattern.exec(content)) !== null) {
      const scriptPath = scriptMatch[1];
      if (seenScripts.has(scriptPath)) continue;
      seenScripts.add(scriptPath);
      if (readOrNull(scriptPath) === null) {
        add('error', 'NODE_SCRIPT_MISSING', relativePath,
          `引用了不存在的脚本：${scriptPath}`);
      }
    }

    // 集合为空时上面已登记 GOV_COMMAND_LIST_UNEXTRACTABLE 并失败关闭；这里跳过
    // 逐条比对只是避免拿空集合报出一堆无意义的「不支持」误报。
    if (govCommands.size === 0) continue;
    const govPattern = /gov(?:\.mjs)? ([a-z]+)/g;
    const seenCommands = new Set();
    let govMatch;
    while ((govMatch = govPattern.exec(content)) !== null) {
      const subcommand = govMatch[1];
      if (seenCommands.has(subcommand)) continue;
      seenCommands.add(subcommand);
      if (!govCommands.has(subcommand)) {
        add('error', 'GOV_SUBCOMMAND_MISSING', relativePath,
          `引用了 gov CLI 不支持的子命令：${subcommand}（支持：${[...govCommands].sort().join('、')}）`);
      }
    }
  }
}

const sensitivePatterns = [
  [/oo2core_[a-z0-9_]*\.dll/i, 'Oodle DLL 文件名'],
  [/C:\\Users\\[^\s` )"']+/i, '用户主目录绝对路径'],
  [/\bsk-[A-Za-z0-9]{16,}/, 'OpenAI 风格 API key'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥内容']
];

for (const [relativePath, content] of MANAGED_DOCS) {
  if (content === null) continue;
  const lines = content.split(/\r?\n/);
  for (const [pattern, label] of sensitivePatterns) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        add('error', 'SENSITIVE_CONTENT', `${relativePath}:${index + 1}`, `疑似${label}进入受管文档。`);
      }
    });
  }
}

// entryPoints 里形如路径的条目必须能真正打开。
//
// entryPoints 刻意允许叙述性条目（「Bridge EMEVD/MSB writer」「本文 §4~§12」），
// 那不是缺陷——投影时由 decorate() 区分渲染。真正的问题是**看起来像路径但打不开**：
// 实测 W-BEHAVIOR-MAP-01 的 entryPoints 里有
// `bridge/SoulForge.Bridge/TaeNativeDocument.cs（延期）`，文件确实存在，但字符串把
// 状态标注拼进了路径。agent 拿 gov next 的 entryPoints 直接去打开就会失败，而失败
// 原因（多了个后缀）跟「文件不存在」长得一模一样，只能靠人工比对才看得出来。
//
// 判据分两档：含 `/` 且带已知代码扩展名的，按路径严格校验；裸文件名（数据里有 4 条，
// 如 `webgpuDetect.ts`）只要求能在仓库中唯一定位——那种写法是可搜索的，不构成阻塞。
{
  const slicesRaw = readOrNull('docs/governance/slices.json');
  if (slicesRaw !== null) {
    let slices = null;
    try {
      slices = JSON.parse(slicesRaw).slices ?? [];
    } catch (error) {
      add('error', 'SLICES_UNPARSEABLE', 'docs/governance/slices.json',
        `无法解析切片数据：${error.message}`);
    }
    const codeExt = /\.(ts|tsx|mjs|js|cs|json|md|csproj)$/;
    for (const slice of slices ?? []) {
      for (const entry of slice.entryPoints ?? []) {
        const value = String(entry);
        if (existsSync(join(root, value))) continue;
        // 形态判定必须在剥离尾部标注之后做。第一版只对原串测扩展名，而
        // `...TaeNativeDocument.cs（延期）` 的扩展名不在串尾，正则的行尾锚点不匹配，
        // 于是这条被当成叙述性入口放过——门禁写了却抓不到它本来要抓的那两条。
        const stripped = value.replace(/[（(][^）)]*[）)]\s*$/, '').trim();
        // 只对「含目录分隔符 + 代码扩展名」的形态严格判定；裸文件名与叙述性入口跳过。
        if (!value.includes('/') || !(codeExt.test(value) || codeExt.test(stripped))) continue;
        // 给出可执行的修法：若去掉尾部标注后存在，就点名该标注。
        const hint = stripped !== value && existsSync(join(root, stripped))
          ? `路径本体 ${stripped} 存在，是尾部标注被拼进了 entryPoints。状态标注应放在 goal 或 authorityCapNote，entryPoints 只放可直接打开的路径。`
          : '该路径在仓库中不存在。若入口是叙述性的（如「Bridge EMEVD/MSB writer」），不要写成路径形态。';
        add('error', 'SLICE_ENTRYPOINT_UNOPENABLE',
          `docs/governance/slices.json ${slice.sliceId}`,
          `entryPoints 条目形如路径但打不开：${value}。${hint}`);
      }
    }
  }
}

// 交接书开头必须先把 agent 送进 CLI，而不是送进几十万字符的全文。
//
// 口径是「入口在交接书 §0，但 §0 的职责是转发到 CLI」：从交接书进是对的，顺着
// 往下通读不是。理由不是文风偏好——通读全文也读不出哪条切片可以 claim，那是
// slices.json 的 lifecycle 决定的，而本文的治理区块只是它的投影。
//
// 门禁化的理由是这段散文在 PROJECTION 标记之外，没有任何机械约束——把 §0 改回
// 「初次接手时全文阅读本文」不会让任何测试变红，而后果是每个新 agent 都多烧几十
// 万字符的上下文。同时禁止「本文仍是唯一事实源」这类表述：治理权威已外置到
// docs/governance/*.json，留着这句会让 agent 去手写投影区块。
//
// 这里刻意不写死体量数字。交接书每次 gov seal 都在长（实测每次约 +1.5 KB），
// 写死的字节数和倍率会烂在注释里冒充实测值；§0 给的是现测命令而不是常量。
if (handoff !== null) {
  const opening = handoff.split(/\r?\n/).slice(0, 60).join('\n');
  if (!/gov\.mjs next/.test(opening)) {
    add('error', 'HANDOFF_ENTRY_NOT_CLI', `${HANDOFF} §0`,
      '交接书开头 60 行内必须给出 `node scripts/gov.mjs next` 作为首选入口。'
      + '§0 是接手入口，但它的职责是把 agent 转发进 CLI；缺这条时 agent 会顺着 §1 '
      + '往下通读全文，而读完仍不知道哪条切片可 claim——那由 slices.json 的 lifecycle 决定。');
  }
  const staleAuthorityClaim = /本文(仍)?是唯一事实源/.exec(handoff);
  if (staleAuthorityClaim !== null) {
    const line = handoff.slice(0, staleAuthorityClaim.index).split(/\r?\n/).length;
    add('error', 'HANDOFF_STALE_AUTHORITY_CLAIM', `${HANDOFF}:${line}`,
      '治理权威已外置到 docs/governance/*.json，交接书的治理区块是其投影。'
      + '声明「本文是唯一事实源」会让 agent 去手写投影区块，而手写必被 projection 门禁判为分叉。'
      + '改为区分「人读的完整口径」与「可手写的权威」，参见 §13.3。');
  }
}

const checkedRules = [
  '切片 entryPoints 里形如路径的条目必须能真正打开（状态标注不得拼进路径）',
  '交接书开头必须以 gov CLI 为首选入口，且不得声明自身为唯一事实源',
  'README、交接书和执行手册的本地 Markdown 链接必须存在',
  'README 必须直链唯一 handoff，且不依赖本机代理规则文件',
  '§17.1 Evidence ID 唯一；sealed-current-run 指纹与 passed Gate freshness 由 evidence.jsonl 权威记录判定',
  '§13.1 切片完整 schema、lifecycle、authority、authority cap 与 blockerRefs 闭合',
  '§13.4 validation-unfrozen 只能引用 §13.1 中尚未终止的切片，且该清单必须完整覆盖 §13.1 行内标注 validation-unfrozen 的非终态切片',
  '§18.3 deferred Gate 的覆盖切片必须一并为 lifecycle=deferred',
  '§18.1、§18.3 固定 11 个 Gate，状态、适用性、切片、范围裁定 Evidence 与 blocker 引用满足收敛约束',
  '§18.3 deferred-v0.6 Gate 必须成对使用 gateState=deferred、禁用于基础 Gate，并引用声明 scope-deferral 用户批准的 sealed Evidence',
  '§18.4 blocker 八字段完整，影响对象与活动 blockerRefs 双向闭合',
  '无活动 blockerRefs 的 ready/active 切片和非 blocked Gate 不得要求用户介入',
  '受管文档（交接书、执行手册）引用的 npm run script 必须存在于 package.json',
  '受管文档引用的 node scripts/*.mjs 路径必须存在，gov 子命令必须被 CLI 接受',
  '受管文档不得包含 Oodle DLL 文件名、用户主目录路径、高置信 token 或私钥内容'
];

const engineeringReviewStillRequired = [
  'Evidence 的命令、样本、结论、Git 引用和用户范围批准是否真实，实施记录是否完整，而不只是结构合法',
  '路线 capability、当前前沿、production 调用链和 authority 上限是否与当前实现语义一致',
  '是否引入了交接书禁止的平行 milestone、task、status 或 next-actions 文档'
];

const errors = findings.filter((finding) => finding.severity === 'error');
const result = {
  ok: errors.length === 0,
  message: errors.length === 0
    ? 'handoff 一致性门禁通过（确定性静态子集）'
    : 'handoff 一致性门禁失败',
  checkedRules,
  findings,
  engineeringReviewStillRequired,
  reviewOwner: 'engineering-agent',
  userActionRequired: false,
  note: '通过只表示列出的确定性检查成立；剩余语义复核由工程方负责，不构成用户介入项。'
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
