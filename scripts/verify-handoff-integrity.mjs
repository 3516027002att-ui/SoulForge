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
  for (const [relativePath, content] of [[HANDOFF, handoff], [PLAYBOOK, playbook]]) {
    if (content === null) continue;
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

const sensitivePatterns = [
  [/oo2core_[a-z0-9_]*\.dll/i, 'Oodle DLL 文件名'],
  [/C:\\Users\\[^\s` )"']+/i, '用户主目录绝对路径'],
  [/\bsk-[A-Za-z0-9]{16,}/, 'OpenAI 风格 API key'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥内容']
];

for (const [relativePath, content] of [[HANDOFF, handoff], [PLAYBOOK, playbook]]) {
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

const checkedRules = [
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
  '交接书和执行手册引用的 npm run script 必须存在于 package.json',
  '交接书和执行手册不得包含 Oodle DLL 文件名、用户主目录路径、高置信 token 或私钥内容'
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
