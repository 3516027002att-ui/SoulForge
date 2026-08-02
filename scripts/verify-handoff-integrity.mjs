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
  validateHandoffGovernance
} from './handoff-integrity-lib.mjs';
import { buildFreshnessContext } from './governance/freshnessContext.mjs';

const root = process.cwd();
const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';
const PLAYBOOK = 'docs/AGENT_EXECUTION_PLAYBOOK.md';
// 一次性任务清单，按难度分两档。它们列出各门禁码与命令，本身就必须受同样的引用
// 真实性约束——否则「文档里形如可执行的东西必须真的可执行」这条规格自己可以违反自己。
//
// 这两个文件是**用完即弃**的：任务全部完成后连同 docs/plan/ 目录一起删除，
// 届时必须同步移除本文件对它们的全部引用与 README 链接（退场步骤见 HARD.md 的 T-H4）。
// 因此这里刻意**不**校验文件是否存在——焊上存在性检查会让「删掉它」变成治理层转红，
// 把用完即弃的东西变成硬依赖。实测过：单文件时期的 PLAN_MISSING 正是这个错误，
// 移走文件立刻报红。存在时才纳入扫描，不存在就跳过。
const PLAN_HARD = 'docs/plan/HARD.md';
const PLAN_MECH = 'docs/plan/MECH.md';
const README = 'README.md';
const PKG = 'package.json';

const findings = [];
const add = (severity, code, where, message) => findings.push({ severity, code, where, message });

function readOrNull(relativePath) {
  const absolutePath = join(root, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
}

const handoff = readOrNull(HANDOFF);
const playbook = readOrNull(PLAYBOOK);
const planHard = readOrNull(PLAN_HARD);
const planMech = readOrNull(PLAN_MECH);

// 受管文档集合。三处扫描（npm script、node/gov 引用、敏感内容）必须用同一份清单：
// 各处各写一遍数组，加文档时漏改其中一处的后果是「以为扫了、其实没扫」——
// 而这正是本仓库反复踩到的那类假门禁。
// 任务清单是可选成员：存在就扫，删掉后自动退出集合而不是报缺失。
const MANAGED_DOCS = [
  [HANDOFF, handoff],
  [PLAYBOOK, playbook],
  ...(planHard === null ? [] : [[PLAN_HARD, planHard]]),
  ...(planMech === null ? [] : [[PLAN_MECH, planMech]])
];
const readme = readOrNull(README);
const packageJsonRaw = readOrNull(PKG);

if (handoff === null) add('error', 'HANDOFF_MISSING', HANDOFF, '交接书缺失，无法作为治理事实源。');
if (playbook === null) add('error', 'PLAYBOOK_MISSING', PLAYBOOK, '交接书引用的执行手册缺失。');
// 任务清单里引用的任务 ID（T-H1 / T-M2 …）必须真实存在于两档清单之一。
//
// 判据形态是跟着被检对象改的：单文件时期条目是 `## N.`，交叉引用是「第 N 条」，
// 插入条目会顶掉后续编号；拆成两档后条目变成 `## T-H1 标题`，跨档互相引用
// （HARD.md 的 T-H4 被 MECH.md 引用、T-H1 的结论影响 T-H3），而任务做完就删除自己
// 那一条——**删除同样会让别处的引用悬空**，且悬空后 agent 照着找不到的 ID 去查，
// 长得跟「拼写错了」一模一样。
//
// 只校验 ID 存在性，不校验语义贴切——语义得人读，存在性是机械的。
{
  const planDocs = [
    ...(planHard === null ? [] : [[PLAN_HARD, planHard]]),
    ...(planMech === null ? [] : [[PLAN_MECH, planMech]])
  ];
  if (planDocs.length > 0) {
    // 定义方是 `## T-XN 标题` 形态的标题行；引用方是正文里任何裸 T-XN。
    const defined = new Set();
    for (const [, content] of planDocs) {
      for (const match of content.matchAll(/^## (T-[HM]\d+)\b/gm)) defined.add(match[1]);
    }
    if (defined.size === 0) {
      add('error', 'PLAN_TASK_IDS_UNPARSEABLE', planDocs.map(([path]) => path).join('、'),
        '未能从任务清单解析出任何 `## T-XN` 形态的任务标题，任务 ID 交叉引用无从校验。'
        + '判据失效等于没有门禁，故失败关闭而不是跳过。');
    } else {
      for (const [relativePath, content] of planDocs) {
        const seen = new Set();
        for (const match of content.matchAll(/\bT-[HM]\d+\b/g)) {
          const cited = match[0];
          if (seen.has(cited)) continue;
          seen.add(cited);
          if (defined.has(cited)) continue;
          const line = content.slice(0, match.index).split(/\r?\n/).length;
          add('error', 'PLAN_TASK_REF_DANGLING', `${relativePath}:${line}`,
            `引用了不存在的任务 ${cited}（现存：${[...defined].sort().join('、')}）。`
            + '任务做完会删除自己那一条，删除时必须同步修正别处对它的引用——'
            + '否则引用悬空，而悬空看起来跟拼写错误一模一样。');
        }
      }
    }
  }
}

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
    anchors: collectSealAnchors(handoff)
  });
  findings.push(...validateHandoffGovernance(handoff, {
    source: HANDOFF,
    freshnessContext
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
  if (govSource !== null) {
    const commandsBlock = govSource.match(/const COMMANDS = Object\.freeze\(\{([\s\S]*?)^\}\)/m);
    for (const name of commandsBlock?.[1].match(/^\s{2}(\w+):/gm) ?? []) {
      govCommands.add(name.trim().replace(':', ''));
    }
    const branchPattern = /command === '-{0,2}([a-z]+)'/g;
    let branchMatch;
    while ((branchMatch = branchPattern.exec(govSource)) !== null) {
      govCommands.add(branchMatch[1]);
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

// 交接书开头必须先把 agent 送进 CLI，而不是送进 431 KB 的全文。
//
// 这条不是文风偏好，是实测的上手成本：`gov next` + `gov help` 合计 8896 B 就
// 包含了选点、入口、前置和所需验证，而全文读完是 48.5 倍的代价，且读完仍然不
// 知道哪条切片可以 claim（那是 slices.json 的 lifecycle 决定的）。
//
// 门禁化的理由是这段散文在 PROJECTION 标记之外，没有任何机械约束——改回
// 「初次接手时全文阅读本文」不会让任何测试变红，而后果是每个新 agent 都多烧
// 40 万字符的上下文。同时禁止「本文仍是唯一事实源」这类表述：治理权威已外置
// 到 docs/governance/*.json，留着这句会让 agent 去手写投影区块。
if (handoff !== null) {
  const opening = handoff.split(/\r?\n/).slice(0, 60).join('\n');
  if (!/gov\.mjs next/.test(opening)) {
    add('error', 'HANDOFF_ENTRY_NOT_CLI', `${HANDOFF} §0`,
      '交接书开头 60 行内必须给出 `node scripts/gov.mjs next` 作为首选入口。'
      + '缺这条时 agent 会从通读全文开始（实测 431597 B vs CLI 8896 B，48.5 倍），'
      + '且读完仍不知道哪条切片可 claim——那由 slices.json 的 lifecycle 决定。');
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
  '§17.1 Evidence ID 唯一且 sealed-current-run 指纹可重算；passed Gate freshness 只跟踪显式主题域',
  '§13.1 切片完整 schema、lifecycle、authority、authority cap 与 blockerRefs 闭合',
  '§13.4 validation-unfrozen 只能引用 §13.1 中尚未终止的切片，且该清单必须完整覆盖 §13.1 行内标注 validation-unfrozen 的非终态切片',
  '§18.3 deferred Gate 的覆盖切片必须一并为 lifecycle=deferred',
  '§18.1、§18.3 固定 11 个 Gate，状态、适用性、切片、范围裁定 Evidence 与 blocker 引用满足收敛约束',
  '§18.3 deferred-v0.6 Gate 必须成对使用 gateState=deferred、禁用于基础 Gate，并引用声明 scope-deferral 用户批准的 sealed Evidence',
  '§18.4 blocker 八字段完整，影响对象与活动 blockerRefs 双向闭合',
  '无活动 blockerRefs 的 ready/active 切片和非 blocked Gate 不得要求用户介入',
  '受管文档（交接书、执行手册、约束规格）引用的 npm run script 必须存在于 package.json',
  '受管文档引用的 node scripts/*.mjs 路径必须存在，gov 子命令必须被 CLI 接受',
  '受管文档不得包含 Oodle DLL 文件名、用户主目录路径、高置信 token 或私钥内容',
  '任务清单里的 T-XN 引用必须指向真实存在的任务（做完删条目会让别处引用悬空）'
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
