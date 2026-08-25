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
 * plan 允许集由 `maxPermissionForMode` 唯一决定，不再存在按工具名的额外清单。
 *
 * 判据(运行期观测真实注册表经真实 bridge 投影的结果):
 *   ① loop 判定必须与共享 permission predicate 逐个一致;
 *   ② 拒绝信息必须包含 required level 或 plan ceiling;
 *   ③ 生产工具必须全部带 permissionLevel。缺失会落到「非生产工具」名字判定,
 *      那是兼容路径,不是给生产工具用的。
 *
 * 不验证 registry 运行期是否真的执行阶梯(那由 test:ai-tool-permission 负责)。
 *
 * ── 负向证明(2026-08-08 实测)──
 *   U1  loop 与共享 predicate 分歧         → LOOP_PERMISSION_DIVERGED
 *   U2  等级拒绝信息不带等级与上限         → LADDER_DENY_LACKS_LEVEL
 *   U3  plan 上限被顺带改动                → PLAN_CEILING_CHANGED
 *   U4  bridge 不透出 permissionLevel     → NO_TOOLS_WITH_LEVEL
 *
 * U2 第一版报绿则暴露一处判据弱点,已据此加强:
 *   - 原先直接 `message.includes(level)`,而 `rollback_operation` 的拒绝
 *     信息里 `rollback` 必然出现 —— 它在工具名里,判据恒真。改为先把工具名
 *     从信息里剔除再找等级串(与 rename 锚点包含原串同一类假绿)。
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

const { isToolAllowedInMode } =
  await import(pathToFileURL(REQUIRED[0][1]).href);
const { decideAiToolPermission, maxPermissionForMode } =
  await import(pathToFileURL(REQUIRED[1][1]).href);
const { createDefaultToolRegistry } = await import(pathToFileURL(REQUIRED[2][1]).href);
const { createAgentToolBridge } = await import(pathToFileURL(REQUIRED[3][1]).href);

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

// plan 的明确产品契约：read/analyze/propose，不能进入 stage/validate。
const planCeiling = maxPermissionForMode('plan');
if (planCeiling !== 'propose') {
  findings.push({
    code: 'PLAN_CEILING_CHANGED',
    actual: planCeiling,
    message: `maxPermissionForMode('plan') 现在返回 ${planCeiling},期望 propose。`
      + ' plan 允许 read/analyze/propose，stage/validate 及更高等级必须拒绝。'
  });
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
  const ladderDecision = decideAiToolPermission(level, 'plan');
  const ladderOk = ladderDecision.allowed;

  // loop 与共享 predicate 必须逐个一致；任何更宽或更窄都是漂移。
  if (loopVerdict.ok !== ladderOk) {
    findings.push({
      code: 'LOOP_PERMISSION_DIVERGED',
      tool: tool.name,
      level,
      loopAllowed: loopVerdict.ok,
      ladderAllowed: ladderOk,
      message: `${tool.name}(${level})的 loop 判定(${loopVerdict.ok})与共享 predicate`
        + `(${ladderOk})不一致。两层必须消费同一权限判据。`
    });
  }

  // 拒绝信息必须能解释共享 predicate 的 required/ceiling。
  if (!loopVerdict.ok && !ladderDenyExplains(loopVerdict.message ?? '', tool.name, level, planCeiling)) {
      findings.push({
        code: 'LADDER_DENY_LACKS_LEVEL',
        tool: tool.name,
        rejection: loopVerdict.message,
        message: `${tool.name} 因等级不够被拒,但拒绝信息里既没有它的等级`
          + `(${level})也没有上限(${planCeiling})。两类拒绝的后续动作不同:`
          + '等级不够要提模式,信息里必须能解释共享 predicate。'
      });
  }
}

if (comparedTools === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_TOOLS_WITH_LEVEL',
    message: '没有任何生产工具带 permissionLevel;判据①④⑥零样本恒真。'
  }, 1);
}
if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AGENT_PERMISSION_NOT_UNIFIED',
    message: 'plan 模式的权限语义存在第二个来源,或收紧清单不合规。',
    planCeiling,
    comparedTools,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: `plan 模式权限语义单一来源:${comparedTools} 个生产工具的 loop 判定`
    + '与共享 permission predicate 一致。',
  planCeiling,
  comparedTools,
  nonClaim: '本门禁只证明生产 bridge 投影出的工具在 plan 模式消费同一 permission predicate；'
    + 'registry 的执行期拦截与 normal/fullPermission 行为由 test:ai-tool-permission 覆盖。'
}, 0);
