#!/usr/bin/env node
/**
 * preload 暴露面裁定门禁。
 *
 * 守的问题：preload 暴露给渲染进程的每个方法，要么 renderer 真的在用，要么必须
 * **显式登记为「已裁定但尚未接线」并写明依据**。
 *
 * 实测背景：57 个暴露方法里有 15 个 renderer 零引用。它们不是待办 TODO —— 都已
 * 过 CI、已封存证据、main 侧 handler 齐全，但 UI 上没有入口。这污染两个判断：
 *
 *  1. 能力盘点失真。治理按 handler 注册与 IPC 证据判进度，而 runAiAgent /
 *     launchMe3 在界面上无入口，于是「已实现」与「用户可用」出现系统性偏差。
 *  2. 安全面积。preload 每多暴露一个未使用方法，就多一个不受 renderer 守卫保护
 *     的表面，且它的失败分支从未被人手触发过。
 *
 * 为什么做成门禁而不是写进文档：文档里的清单会和代码分叉，而分叉无人发现。这里
 * 把「暴露面 = 已用 ∪ 已裁定」变成机器可校验的等式：
 *   - 新增暴露但既没接线也没登记 → 红（防「顺手暴露一个」）
 *   - 登记项已经接线了 → 红（防登记表过期，逼它随接线进度收缩）
 *   - 登记项从 preload 撤下了 → 红（防登记表残留幽灵条目）
 *
 * 不需要构建产物：读源码即可（判据是「暴露面与 renderer 引用」的静态关系，
 * 不是运行期行为）。运行期表面由 desktop-ipc-contract 与
 * desktop-security-runtime 负责。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'preload-surface-ruling';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = join(root, 'apps', 'desktop', 'src', 'preload', 'index.ts');

/**
 * 已裁定但尚未接线的暴露方法。
 *
 * 每条必须写：为什么保留（而不是撤下）、依据哪条治理裁定、接线的前置条件是什么。
 * 没有依据的条目等于「先放着」，那正是本门禁要消除的状态。
 */
const RULED_FAMILY = Object.freeze({
  'me3-runtime': ['detectMe3', 'prepareMe3Profile', 'launchMe3', 'terminateMe3'],
  'ai-agent': ['runAiAgent', 'cancelAiAgent', 'listAiAgentSessions', 'loadAiAgentSession', 'onAiAgentEvent', 'listAiTools'],
  'container-diagnostics': ['roundTripContainer', 'validateContainer', 'probeContainerCapabilities'],
  'raw-bytes': ['readRawMetadata', 'readRawRange']
});

const RULED_NOT_YET_WIRED = Object.freeze({
  // ── me3 运行时（SCOPE-RUNTIME / capabilityId H-RUNTIME / REL-H，
  //    targetRelease=V0.5、decisionStatus=user-approved、gateState=open）──
  //
  // 裁定：保留。scope.json 明确把「检测、profile、启动、日志、终止与回滚后复启」
  // 列为 V0.5 supported 且用户已批准，REL-H 仍为 open 表示这条能力线尚未收口。
  // 撤下 preload 等于把已批准的 V0.5 能力从可达面移除，与范围裁定冲突。
  // 接线前置：REL-H 需要真实 Sekiro 启动与安装生命周期证据（本机以外不可复现），
  // 属 §9.6 BLOCK-3/BLOCK-4 范畴。
  detectMe3: 'SCOPE-RUNTIME V0.5 supported；REL-H open，等真实启动证据后接 UI',
  prepareMe3Profile: 'SCOPE-RUNTIME V0.5 supported；同上',
  launchMe3: 'SCOPE-RUNTIME V0.5 supported；同上',
  terminateMe3: 'SCOPE-RUNTIME V0.5 supported；同上（终止是启动的回滚路径，不可单独撤）',

  // ── AI agent 会话（SCOPE-AI / capabilityId G-AGENT / REL-G，
  //    targetRelease=V0.5、decisionStatus=user-approved、gateState=passed）──
  //
  // 裁定：保留并优先接线。REL-G 已 passed，说明双协议 AI 的证据链成立；缺的只是
  // renderer 侧的任务面板入口。AgentSessionControls 目前只有 provider/thinking/
  // permissionMode 三个 props，没有 run/cancel/session 入口。
  // 这是本清单里唯一「后端已 passed、只差 UI」的一族，因此是接线优先级最高的。
  runAiAgent: 'SCOPE-AI V0.5 supported；REL-G passed，仅缺 renderer 任务面板入口',
  cancelAiAgent: 'SCOPE-AI V0.5 supported；取消是长任务的必需路径（硬约束 16）',
  listAiAgentSessions: 'SCOPE-AI V0.5 supported；会话列表是 rollout 持久化的读侧',
  loadAiAgentSession: 'SCOPE-AI V0.5 supported；同上',
  onAiAgentEvent: 'SCOPE-AI V0.5 supported；进度事件推送通道，已由 ipc-contract 的订阅断言覆盖',
  listAiTools: 'SCOPE-AI V0.5 supported；工具清单是权限阶梯的展示侧',

  // ── 容器只读诊断 ──
  //
  // 裁定：保留。这三条是容器工作台的诊断能力（往返安全性、结构校验、能力探测），
  // Bnd4WorkbenchPanel 已展示 containerRoundTripSafe / canListChildren /
  // canReplaceChild 等字段，但那些来自 inspectContainerTree 的聚合结果；单独调用
  // 这三条可以给出逐项诊断。撤下会让「为什么这个容器不可写」失去可查询入口。
  roundTripContainer: '容器诊断：往返安全性逐项查询；inspectContainerTree 只给聚合结论',
  validateContainer: '容器诊断：结构校验；unsupported 时的结构化原因来源',
  probeContainerCapabilities: '容器诊断：能力探测；决定工作台开放哪些操作',

  // ── raw 字节读取 ──
  //
  // 裁定：保留，且 readRawRange 应尽快接线。HexEditorPanel 目前只接
  // initialBytesBase64（一次性全量），因此大文件的 hex 证据无法按偏移翻页——
  // 而硬约束 17 要求大规模访问必须分页。readRawRange 正是那个分页入口。
  readRawMetadata: 'raw 证据层：尺寸/哈希元数据，hex 分页的前置查询',
  readRawRange: 'raw 证据层：按偏移分页读取；HexEditorPanel 接线后可满足硬约束 17'
});

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(PRELOAD)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'PRELOAD_SOURCE_MISSING',
    message: `preload 源码缺失：${PRELOAD}`
  }, 1);
}

const preloadSource = readFileSync(PRELOAD, 'utf8');
/** contextBridge 暴露面：顶层两空格缩进的 `name:` 属性。 */
const exposed = [...preloadSource.matchAll(/^\s{2}(\w+):\s*(?:\(|<)/gm)].map((match) => match[1]);
if (exposed.length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'PRELOAD_SURFACE_UNEXTRACTABLE',
    message: '未能从 preload 源码提取任何暴露方法；提取失败必须失败关闭，'
      + '否则「暴露面为空」会让本门禁的所有判据变成必然通过。'
  }, 1);
}

let rendererSource;
try {
  const files = execSync('git ls-files apps/desktop/src/renderer', { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter((line) => line.length > 0);
  if (files.length === 0) throw new Error('renderer 文件列表为空');
  rendererSource = files.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
} catch (error) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'RENDERER_SOURCE_UNREADABLE',
    message: `无法读取 renderer 源码：${error instanceof Error ? error.message : String(error)}`
  }, 1);
}

/**
 * 注释与字符串字面量必须先剥掉，再判引用。
 *
 * 裸词匹配（`\bname\b` 直接打全文）会把三种非引用形态判成「已接线」：
 * `// TODO: wire launchMe3`、`'launchMe3 not wired'`、以及被注释掉的旧调用
 * `// await bridge.launchMe3(...)`。实测四种形态全部误判为已接线。
 *
 * 后果不是漏报而是**反向**的：一个方法只要在 renderer 的注释里被提到，就会被算作
 * 已接线，于是判据 2（PRELOAD_RULING_STALE）会逼人把它从登记表里删掉，而它其实
 * 从未接线——登记表因此丢掉真实待接线项，本门禁的核心等式失去意义。
 * 这与本仓库已记录的「grep 式 must-not 判据改名即报绿」同源：判据必须看代码结构，
 * 不能看文本出现。
 *
 * 剥离是保守的：只处理 //、/* *\/ 和三种引号，不做完整词法分析。剥过头会造成
 * 漏判引用（判成未接线 → 要求登记），那是安全方向；剥不足会造成误判已接线，
 * 所以宁可多剥。
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    // 行注释
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    // 块注释
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // 字符串与模板字面量。模板串里的 ${...} 是真代码，保留其内容。
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { i += 2; continue; }
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            if (depth > 0) i += 1;
          }
          out += ` ${source.slice(start, i)} `;
          i += 1;
          continue;
        }
        i += 1;
      }
      i += 1;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const rendererCode = stripCommentsAndStrings(rendererSource);
const referenced = new Set(
  exposed.filter((name) => new RegExp(`\\b${name}\\b`).test(rendererCode))
);
const orphaned = exposed.filter((name) => !referenced.has(name));

const findings = [];

// 1. 未接线且未登记 → 红。防「顺手暴露一个方法」。
for (const name of orphaned) {
  if (!(name in RULED_NOT_YET_WIRED)) {
    findings.push({
      code: 'PRELOAD_METHOD_UNRULED',
      method: name,
      message: `preload 暴露了 ${name}，但 renderer 零引用且未登记裁定依据。`
        + ' 每个暴露方法都是不受 renderer 守卫保护的表面，且其失败分支从未被人手'
        + '触发过。请接线，或从 preload 撤下，或在 RULED_NOT_YET_WIRED 登记并写明'
        + '治理依据与接线前置条件。'
    });
  }
}

// 2. 已登记但其实已接线 → 红。逼登记表随接线进度收缩，否则它会变成永久豁免清单。
for (const name of Object.keys(RULED_NOT_YET_WIRED)) {
  if (referenced.has(name)) {
    findings.push({
      code: 'PRELOAD_RULING_STALE',
      method: name,
      message: `${name} 已在 renderer 接线，但仍留在 RULED_NOT_YET_WIRED 里。`
        + ' 登记表必须随接线收缩——留着它等于给一个已完成项永久豁免。'
    });
  }
}

// 3. 已登记但已从 preload 撤下 → 红。防幽灵条目。
for (const name of Object.keys(RULED_NOT_YET_WIRED)) {
  if (!exposed.includes(name)) {
    findings.push({
      code: 'PRELOAD_RULING_GHOST',
      method: name,
      message: `${name} 已不在 preload 暴露面，但仍登记在 RULED_NOT_YET_WIRED 里。`
    });
  }
}

// 4. 每条裁定必须写理由。空理由等于没有裁定。
for (const [name, reason] of Object.entries(RULED_NOT_YET_WIRED)) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    findings.push({
      code: 'PRELOAD_RULING_REASON_MISSING',
      method: name,
      message: `${name} 的裁定没有写理由；没有依据的条目等于「先放着」。`
    });
  }
}

// 5. 族划分必须与登记表严格互为覆盖。
//
// 通过输出里的族计数原先是硬编码的 4/6/3/2，与登记表脱钩：登记表增删一条时计数
// 不会跟着变，于是门禁「通过」的同时报出一个错误的盘点数字。而这份计数正是
// 接手者用来判断「还剩多少能力没接线」的依据，说谎的代价不比判据失效小。
// 现在计数从 RULED_FAMILY 推导，并在此断言两者双向一致——漏登记一个族成员，
// 或给族里写一个已不在登记表的名字，都必须红。
{
  const familyMembers = Object.values(RULED_FAMILY).flat();
  const duplicates = familyMembers.filter((name, index) => familyMembers.indexOf(name) !== index);
  for (const name of new Set(duplicates)) {
    findings.push({
      code: 'PRELOAD_RULING_FAMILY_DUPLICATE',
      method: name,
      message: `${name} 同时属于多个族；族划分必须是登记表的一个划分（partition）。`
    });
  }
  const familySet = new Set(familyMembers);
  for (const name of Object.keys(RULED_NOT_YET_WIRED)) {
    if (!familySet.has(name)) {
      findings.push({
        code: 'PRELOAD_RULING_FAMILY_MISSING',
        method: name,
        message: `${name} 已登记裁定但未归入任何族；族计数会因此少算，盘点数字失真。`
      });
    }
  }
  for (const name of familySet) {
    if (!(name in RULED_NOT_YET_WIRED)) {
      findings.push({
        code: 'PRELOAD_RULING_FAMILY_ORPHAN',
        method: name,
        message: `${name} 出现在族划分里但不在登记表中；族计数会因此多算。`
      });
    }
  }
}

if (findings.length > 0) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'PRELOAD_SURFACE_RULING_VIOLATION',
    message: 'preload 暴露面与裁定登记表不一致：暴露面必须等于「renderer 已用」∪「已裁定待接线」。',
    exposedCount: exposed.length,
    referencedCount: referenced.size,
    orphanedCount: orphaned.length,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: 'preload 暴露面完全等于「renderer 已用」∪「已裁定待接线」。',
  exposedCount: exposed.length,
  referencedCount: referenced.size,
  ruledNotYetWired: orphaned.length,
  ruledFamilies: Object.fromEntries(
    Object.entries(RULED_FAMILY).map(([family, members]) => [family, members.length])
  ),
  nextWiring: [
    'runAiAgent 一族：REL-G 已 passed，仅缺 renderer 任务面板入口，接线优先级最高',
    'readRawRange：HexEditorPanel 接线后可满足硬约束 17 的大文件分页要求'
  ],
  nonClaim: '本门禁只校验「暴露面 = 已用 ∪ 已裁定」这条静态等式，不验证任何 IPC 的'
    + '运行期行为（那由 desktop-ipc-contract 与 desktop-security-runtime 负责），'
    + '也不声明已裁定待接线的能力对用户可用。'
}, 0);
