#!/usr/bin/env node
/**
 * agent 权限判据统一门禁。
 *
 * 守的问题:plan 模式的语义必须只有**一个**权威来源。
 *
 * ── 统一前的实际状态(2026-08-08 实测)──
 *
 * `agentLoop.isToolAllowedInMode` 在 plan 模式下用一份按名字硬编码的白名单,
 * 与 `ai/toolPermissions.maxPermissionForMode` 各自表达一套 plan 语义。
 * 对 17 个生产工具逐个比对,分歧 2 个:`propose_text_patch`(propose)与
 * `validate_patch`(validate)—— 白名单拦,等级阶梯放行。
 *
 * 代价不在这 2 个工具本身,而在**新增工具时无人知道该改哪边**:
 *   - 一个 read 等级的新工具忘记加进白名单 → plan 模式被拒,而等级明明够,
 *     症状是「agent 说这个工具没权限」但查阶梯查不出原因;
 *   - 一个等级被误标为 read 的写类工具 → 只要名字在册就能进 plan 模式。
 * 两个可以各自漂移的真相,比一层额外防护危险。
 *
 * ── 统一后的形态 ──
 *
 * plan 允许集由 `maxPermissionForMode` 唯一决定;白名单降级为
 * `PLAN_MODE_EXTRA_DENY` —— 一份显式收紧清单,只能更严、每条带实测理由。
 *
 * 判据(运行期观测真实注册表经真实 bridge 投影的结果):
 *   ① 对每个生产工具,loop 层判定不得比等级判据更宽 —— 更宽意味着 loop 放行了
 *      阶梯拒绝的东西,那是提权;
 *   ② 收紧清单里的每一条都必须真的被等级判据放行(否则它是死条目:等级已经
 *      拦住了,这条 deny 永远不会生效,而它的存在会让人以为有额外保护);
 *   ③ 收紧清单每条必须带非空理由 —— 一条没有理由的 deny 无法被后人判断
 *      该不该保留;
 *   ④ 不在收紧清单里的生产工具,loop 判定必须与等级判据**逐个一致**;
 *   ⑤ plan 上限必须仍是 `validate`:该值被两处已封存 smoke 钉住
 *      (runV05FoundationSmoke 与 runAiToolPermissionSmoke 的 MODE_CEILINGS),
 *      改它属于改已封存契约,不能靠本次统一顺带发生;
 *   ⑥ 拒绝信息必须能区分「等级不够」与「被显式收紧」——两者的后续动作不同:
 *      前者要提模式,后者要看理由;
 *   ⑦ 生产工具必须全部带 permissionLevel。缺失会落到「非生产工具」名字判定,
 *      那是兼容路径,不是给生产工具用的。
 *
 * 不做的事:不评判 `maxPermissionForMode` 的取值是否恰当(那是已封存契约),
 * 不验证 registry 运行期是否真的执行阶梯(那由 test:ai-tool-permission 负责)。
 *
 * ── 负向证明(2026-08-08 实测十条)──
 *   U1  loop 放行等级判据拒绝的工具       → LOOP_WIDER_THAN_LADDER + DIVERGED
 *   U2  收紧清单清空                      → EXTRA_DENY_EMPTY
 *   U3  收紧清单条目理由被抹掉            → EXTRA_DENY_REASON_MISSING
 *   U4  收紧清单出现死条目                → EXTRA_DENY_REDUNDANT
 *   U5  收紧清单指向不存在的工具          → EXTRA_DENY_TOOL_UNKNOWN
 *   U6  plan 上限被顺带改动               → PLAN_CEILING_CHANGED
 *   U7  收紧拒绝信息不带理由              → EXTRA_DENY_REASON_NOT_SURFACED
 *   U8  等级拒绝信息不带等级与上限        → LADDER_DENY_LACKS_LEVEL
 *   U9  bridge 不透出 permissionLevel     → NO_TOOLS_WITH_LEVEL
 *   U10 收紧清单不再导出                  → EXTRA_DENY_NOT_EXPORTED
 *
 * U7 与 U8 第一版都报绿,各暴露一处判据弱点,已据此加强:
 *   - U7:原先用 `reason.slice(0, 12)` 做前缀匹配,而理由是多段字符串拼接,
 *     换掉第一段后剩余片段仍在信息里,前缀匹配通过。改为要求**整条**理由出现。
 *   - U8:原先直接 `message.includes(level)`,而 `rollback_operation` 的拒绝
 *     信息里 `rollback` 必然出现 —— 它在工具名里,判据恒真。改为先把工具名
 *     从信息里剔除再找等级串(与 rename 锚点包含原串同一类假绿)。
 * U3 报绿则是用例设计问题(只换掉理由的第一段,总长仍超阈值),不是门禁缺陷。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LABEL = 'agent-permission-unified';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'packages', 'core', 'dist');

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

const REQUIRED = [
  ['agentLoop', join(DIST, 'model-services', 'agentLoop.js')],
  ['toolPermissions', join(DIST, 'ai', 'toolPermissions.js')],
  ['toolRegistry', join(DIST, 'ai', 'toolRegistry.js')],
  ['agentToolBridge', join(DIST, 'ai', 'agentToolBridge.js')]
];
for (const [name, path] of REQUIRED) {
  if (!existsSync(path)) {
    report({
      ok: false, gate: LABEL, status: 'failed', code: 'DIST_MISSING',
      message: `缺少编译产物 ${name}:${path}。先跑 npm run build -w @soulforge/core。`
    }, 1);
  }
}

const { isToolAllowedInMode, PLAN_MODE_EXTRA_DENY } =
  await import(pathToFileURL(REQUIRED[0][1]).href);
const { isAiToolPermissionAllowed, maxPermissionForMode } =
  await import(pathToFileURL(REQUIRED[1][1]).href);
const { createDefaultToolRegistry } = await import(pathToFileURL(REQUIRED[2][1]).href);
const { createAgentToolBridge } = await import(pathToFileURL(REQUIRED[3][1]).href);

if (!(PLAN_MODE_EXTRA_DENY instanceof Map)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'EXTRA_DENY_NOT_EXPORTED',
    message: 'agentLoop 未导出 PLAN_MODE_EXTRA_DENY(Map)。'
      + '收紧清单不可读时判据②③无从校验,缺判据必须失败关闭。'
  }, 1);
}

/**
 * 等级拒绝信息是否真的解释了「等级不够」。
 *
 * 必须先把工具名从信息里剔除再找等级串。实测踩过:`rollback_operation` 的
 * 拒绝信息里 `rollback` 一定出现 —— 它在工具名里 —— 于是
 * `message.includes(level)` 恒真,判据形同虚设(与 rename 锚点包含原串
 * 同一类假绿)。剔除工具名后,信息里必须仍有等级或上限才算解释清楚。
 */
function ladderDenyExplains(message, toolName, level, ceiling) {
  const withoutToolName = message.split(toolName).join('«tool»');
  return withoutToolName.includes(level) || withoutToolName.includes(ceiling);
}

const bridge = createAgentToolBridge({
  registry: createDefaultToolRegistry(),
  context: { workspaceIndex: {}, mode: 'fullPermission' }
});
const names = new Set(bridge.tools.map((tool) => tool.name));
const levels = new Map(bridge.tools.map((tool) => [tool.name, tool.permissionLevel]));
const findings = [];

if (bridge.tools.length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_PRODUCTION_TOOLS',
    message: '生产注册表零工具;全部判据零样本恒真,必须失败关闭。'
  }, 1);
}

// 判据⑤:plan 上限未被顺带改动。
const planCeiling = maxPermissionForMode('plan');
if (planCeiling !== 'validate') {
  findings.push({
    code: 'PLAN_CEILING_CHANGED',
    actual: planCeiling,
    message: `maxPermissionForMode('plan') 现在返回 ${planCeiling},期望 validate。`
      + ' 该值被 runV05FoundationSmoke 与 runAiToolPermissionSmoke 的 MODE_CEILINGS'
      + '两处已封存断言钉住,属于 architecture scaffold 的 policy gate 契约;'
      + '改它不能作为权限统一的副作用发生。'
  });
}

// 判据③:收紧清单每条带非空理由。
for (const [toolName, reason] of PLAN_MODE_EXTRA_DENY) {
  if (typeof reason !== 'string' || reason.trim().length < 20) {
    findings.push({
      code: 'EXTRA_DENY_REASON_MISSING',
      tool: toolName,
      reason: reason ?? null,
      message: `收紧清单条目 ${toolName} 没有足够具体的理由。`
        + ' 一条没有理由的 deny 无法被后人判断该不该保留,会长期留在清单里。'
    });
  }
}

// 判据②:收紧清单不得含死条目。
for (const [toolName] of PLAN_MODE_EXTRA_DENY) {
  const level = levels.get(toolName);
  if (level === undefined) {
    findings.push({
      code: 'EXTRA_DENY_TOOL_UNKNOWN',
      tool: toolName,
      message: `收紧清单里的 ${toolName} 不在生产注册表里(或未带 permissionLevel)。`
        + ' 指向不存在的工具等于死条目。'
    });
    continue;
  }
  if (!isAiToolPermissionAllowed(level, 'plan')) {
    findings.push({
      code: 'EXTRA_DENY_REDUNDANT',
      tool: toolName,
      level,
      message: `收紧清单里的 ${toolName}(${level})本就被等级判据拒绝,`
        + ' 这条 deny 永远不会生效。死条目会让人以为存在额外保护。'
    });
  }
}

// 判据①④⑥⑦:逐个生产工具比对。
let comparedTools = 0;
for (const tool of bridge.tools) {
  const level = tool.permissionLevel;
  // 判据⑦
  if (typeof level !== 'string' || level === '') {
    findings.push({
      code: 'PRODUCTION_TOOL_MISSING_LEVEL',
      tool: tool.name,
      message: `生产工具 ${tool.name} 没有 permissionLevel,会落到「非生产工具」`
        + '名字判定 —— 那是给测试构造工具的兼容路径,不是给生产工具用的。'
    });
    continue;
  }
  comparedTools += 1;
  const loopVerdict = isToolAllowedInMode(tool.name, 'plan', names, levels);
  const ladderOk = isAiToolPermissionAllowed(level, 'plan');
  const inExtraDeny = PLAN_MODE_EXTRA_DENY.has(tool.name);

  // 判据①:不得比等级判据更宽。
  if (loopVerdict.ok && !ladderOk) {
    findings.push({
      code: 'LOOP_WIDER_THAN_LADDER',
      tool: tool.name,
      level,
      message: `loop 层在 plan 模式放行了 ${tool.name}(${level}),而等级判据拒绝它。`
        + ' loop 比阶梯更宽等于提权 —— 收紧清单只能让 plan 更严。'
    });
  }

  // 判据④:不在收紧清单里的必须与等级判据一致。
  if (!inExtraDeny && loopVerdict.ok !== ladderOk) {
    findings.push({
      code: 'LOOP_LADDER_DIVERGED',
      tool: tool.name,
      level,
      loopAllowed: loopVerdict.ok,
      ladderAllowed: ladderOk,
      message: `${tool.name}(${level})不在收紧清单里,但 loop 判定`
        + `(${loopVerdict.ok})与等级判据(${ladderOk})不一致。`
        + ' 那正是统一要消除的「两套语义」。'
    });
  }

  // 判据⑥:拒绝理由可区分。
  if (!loopVerdict.ok) {
    const message = loopVerdict.message ?? '';
    if (inExtraDeny) {
      const reason = PLAN_MODE_EXTRA_DENY.get(tool.name) ?? '';
      // 收紧清单的拒绝必须把**完整**理由带出来,否则用户只知道「不行」。
      //
      // 判据故意要求整条理由都在拒绝信息里,而不是匹配开头若干字符:
      // 实测用 slice(0,12) 做前缀匹配时,把理由的第一个拼接片段换掉仍能通过
      // ——因为剩余片段恰好还在信息里。前缀匹配对「理由被部分抹掉」是盲的。
      if (reason !== '' && !message.includes(reason)) {
        findings.push({
          code: 'EXTRA_DENY_REASON_NOT_SURFACED',
          tool: tool.name,
          rejection: message,
          message: `${tool.name} 因显式收紧被拒,但拒绝信息里没有带上理由。`
            + ' 模型与用户需要知道「为什么不行」而不只是「不行」。'
        });
      }
    } else if (!ladderDenyExplains(message, tool.name, level, planCeiling)) {
      findings.push({
        code: 'LADDER_DENY_LACKS_LEVEL',
        tool: tool.name,
        rejection: message,
        message: `${tool.name} 因等级不够被拒,但拒绝信息里既没有它的等级`
          + `(${level})也没有上限(${planCeiling})。两类拒绝的后续动作不同:`
          + '等级不够要提模式,显式收紧要看理由 —— 信息里必须能区分。'
      });
    }
  }
}

if (comparedTools === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_TOOLS_WITH_LEVEL',
    message: '没有任何生产工具带 permissionLevel;判据①④⑥零样本恒真。'
  }, 1);
}
if (PLAN_MODE_EXTRA_DENY.size === 0) {
  // 空清单本身不是缺陷(统一后可能确实无需额外收紧),但要显式记录,
  // 避免「清单被清空」与「本来就没有」在报告里长得一样。
  findings.push({
    code: 'EXTRA_DENY_EMPTY',
    message: '收紧清单为空。实测 validate_patch 会经 '
      + 'stageAndValidateProposalThroughTransaction 创建暂存目录并跑校验器,'
      + '那是写暂存区而 plan 模式承诺只读 —— 清单为空意味着它现在能在 plan '
      + '模式下执行。若这是有意的裁定,请在清单注释里写明依据。'
  });
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AGENT_PERMISSION_NOT_UNIFIED',
    message: 'plan 模式的权限语义存在第二个来源,或收紧清单不合规。',
    planCeiling,
    comparedTools,
    extraDeny: [...PLAN_MODE_EXTRA_DENY.keys()],
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: `plan 模式权限语义单一来源:${comparedTools} 个生产工具的 loop 判定`
    + '与等级判据一致(收紧清单内的除外),收紧清单只更严且每条带理由。',
  planCeiling,
  comparedTools,
  extraDeny: [...PLAN_MODE_EXTRA_DENY.entries()].map(([tool, reason]) => ({
    tool,
    reasonHead: reason.slice(0, 60)
  })),
  nonClaim: '本门禁只证明「plan 语义只有一个权威来源,额外收紧只能更严」。'
    + '它不评判 maxPermissionForMode 的取值是否恰当(那是已封存契约),'
    + '不验证 registry 运行期是否真的执行阶梯(由 test:ai-tool-permission 负责),'
    + '也不覆盖 normal / fullPermission 模式 —— 那两个模式此前不存在第二套判据。'
}, 0);
