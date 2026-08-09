#!/usr/bin/env node
/**
 * Agent 审批层门禁(硬约束 11:完全权限不能绕过证据、Patch Engine、验证、
 * 备份、审计和回滚)。
 *
 * 守的问题:审批层是「用户对写类操作的检查点」。它一旦在某条路径上被绕过,
 * 症状是**什么都不会发生** —— 工具照常执行、任务照常成功、日志照常干净,
 * 只是没人问过用户。这类缺陷不会以失败的形式出现,只能靠门禁钉。
 *
 * 为什么不能只靠类型:`requestApproval` 是可选字段,漏传它编译通过、测试全绿,
 * 而写类工具会直接执行。审批层最危险的失效模式恰好是「没接线」,类型系统对
 * 「本该传却没传」无话可说。
 *
 * 判据(全部在运行期跑真实 runAgentToolLoop,用 fake adapter,不发网络请求):
 *   ① 默认需审批等级必须覆盖全部能触达写链/备份链的等级(stage/commit/
 *      rollback/write);漏掉任一个等于该等级的工具永远不被询问;
 *   ② 写类工具被询问,只读工具不被询问 —— 审批疲劳是真实失效模式:
 *      对几乎总该批准的操作反复弹窗,用户会开始盲点通过;
 *   ③ 审批请求必须携带 argumentsJson —— 只给工具名等于让用户批准
 *      「写某个文件」而不是「写这个文件」,那不是知情同意;
 *   ④ reject / never 必须真的阻止执行(观测 executeTool 是否被调用);
 *   ⑤ once / always 必须放行;
 *   ⑥ always / never 必须进入会话内记忆,同名工具第二次不再询问,
 *      且事件里标记 fromMemory;
 *   ⑦ 审批记忆不得跨 run 存活 —— 跨会话记住「总是允许回滚」会把一个
 *      工作区的决定带到另一个;
 *   ⑧ 审批通道抛异常必须按拒绝处理:联系不上审批者不是同意(fail-closed);
 *   ⑨ 每次审批(含来自记忆的)必须留审计痕迹 —— 「agent 没跑那个工具」
 *      与「用户拒绝了它」是两个不同的事实;
 *   ⑩ 审批门必须排在模式门之后:模式已禁止的调用不得作为可批准动作弹给用户,
 *      否则是在教用户「你的回答不影响结果」;
 *   ⑪ 不传 requestApproval 时行为与加入审批层之前一致(不得默默拦,也不得
 *      默默放行)—— 这一条保证审批层是**增量**检查点而非替换既有门;
 *   ⑫ 审批分级必须建立在生产 agentToolBridge 真实投影出的 permissionLevel 上,
 *      而不是门禁自造的工具定义 —— 判据①-⑪用自造 toolDef,看不见「bridge
 *      忘记透出 permissionLevel」这种失效。实测拆掉那一行后①-⑪全绿,而生产里
 *      每个工具都会落到默认 read 等级,审批门对写类工具完全失效。
 *
 * 不做的事:不验证 UI 呈现(那由 renderer 单测与 e2e 负责),不验证真实
 * provider 行为,不证明用户会认真读审批请求。
 *
 * ── 负向证明(2026-08-08 实测十三条,每条退化后 `tsc -b --force` 重建再跑)──
 *   A1  默认清单去掉 rollback            → NO_GATED_PRODUCTION_TOOLS(级联失败关闭)
 *   A2  把 read 列入需审批                → READ_LEVEL_GATED_BY_DEFAULT
 *   A3  reject 不阻止执行                 → DENIED_CALL_STILL_EXECUTED
 *   A4  审批请求不带 argumentsJson        → APPROVAL_REQUEST_MISSING_ARGUMENTS
 *   A5  通道异常改成 once                 → FELL_THROUGH_TO_EXECUTE + NOT_AUDITED_AS_REJECT
 *   A6  always/never 不进记忆             → APPROVAL_MEMORY_NOT_APPLIED
 *   A7  记忆命中不标 fromMemory           → MEMORY_HIT_NOT_MARKED
 *   A8  记忆提到模块级                    → APPROVAL_MEMORY_LEAKED_ACROSS_RUNS
 *   A9  审批不写审计                      → APPROVAL_AUDIT_MISSING + DENIAL_NOT_AUDITED
 *   A10 审批门排到模式门之前              → DENIED_BY_MODE_STILL_ASKED
 *   A11 空 levels 回退成默认清单          → EMPTY_LEVELS_NOT_HONORED
 *   A12 bridge 不透出 permissionLevel     → NO_GATED_PRODUCTION_TOOLS
 *   A13 无回调时仍进审批分支              → NO_CALLBACK_SILENTLY_BLOCKED
 *
 * A12 第一版报绿,正是它暴露了判据⑫要守的盲区:判据①-⑪用本门禁自造的
 * toolDef,永远不经过生产 bridge,拆掉 bridge 那一行不会被任何判据看见。
 * A13 与 A4 的锚点最初写成跨行字面量匹配不上(源码 CRLF),改单行后成立。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LABEL = 'agent-approval-gate';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'packages', 'core', 'dist', 'model-services');
const LOOP_JS = join(DIST, 'agentLoop.js');

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(LOOP_JS)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'DIST_MISSING',
    message: `缺少编译产物 ${LOOP_JS}。先跑 npm run build -w @soulforge/core。`
      + ' 本门禁必须观测运行期真实 loop 行为,不能退化成读源码字符串。'
  }, 1);
}

const { runAgentToolLoop, DEFAULT_APPROVAL_REQUIRED_LEVELS } =
  await import(pathToFileURL(LOOP_JS).href);

const findings = [];

// 审批等级的权威来源:生产 toolPermissions 的阶梯。写链等级在此列举一次,
// 与 ai/toolPermissions.ts 的 AI_TOOL_PERMISSION_ORDER 对应。
const WRITE_CAPABLE_LEVELS = Object.freeze(['stage', 'commit', 'rollback', 'write']);
const READ_ONLY_LEVELS = Object.freeze(['read', 'analyze']);

// 判据①
if (!Array.isArray(DEFAULT_APPROVAL_REQUIRED_LEVELS)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'DEFAULT_LEVELS_MISSING',
    message: 'agentLoop 未导出 DEFAULT_APPROVAL_REQUIRED_LEVELS;'
      + '判据①无从校验,缺判据必须失败关闭。'
  }, 1);
}
for (const level of WRITE_CAPABLE_LEVELS) {
  if (!DEFAULT_APPROVAL_REQUIRED_LEVELS.includes(level)) {
    findings.push({
      code: 'WRITE_LEVEL_NOT_GATED_BY_DEFAULT',
      level,
      defaults: [...DEFAULT_APPROVAL_REQUIRED_LEVELS],
      message: `等级 ${level} 能触达写链或备份链,但不在默认需审批清单里。`
        + ' 该等级的工具会在无人过问的情况下执行。'
    });
  }
}
for (const level of READ_ONLY_LEVELS) {
  if (DEFAULT_APPROVAL_REQUIRED_LEVELS.includes(level)) {
    findings.push({
      code: 'READ_LEVEL_GATED_BY_DEFAULT',
      level,
      message: `只读等级 ${level} 被列入默认需审批清单。对几乎总该批准的操作`
        + '反复弹窗会训练用户盲点通过,那会让真正危险的审批也被点掉。'
    });
  }
}

const CONFIG = Object.freeze({
  id: 'cfg-gate', displayName: 'gate', protocol: 'anthropic',
  baseUrl: 'https://example.invalid', model: 'm', hasCredential: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
});
// 形如密钥的占位串:loop 会做脱敏自检,这里同时验证审批路径不泄露它。
const FAKE_KEY = 'sk-approval-gate-placeholder-0000';

/** 单轮 fake adapter:第一次回工具调用,之后回 stop。 */
function makeAdapter(toolCalls, rounds = 1) {
  let n = 0;
  return {
    async complete() {
      n += 1;
      if (n <= rounds) {
        return {
          ok: true,
          message: { role: 'assistant', content: '', toolCalls },
          finishReason: 'tool_use',
          diagnostics: []
        };
      }
      return {
        ok: true,
        message: { role: 'assistant', content: 'done', toolCalls: [] },
        finishReason: 'stop',
        diagnostics: []
      };
    }
  };
}

function toolDef(name, permissionLevel, supportsParallel = false) {
  return {
    name,
    description: name,
    parametersJsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
    permissionLevel,
    ...(supportsParallel ? { supportsParallel: true } : {})
  };
}

/**
 * 跑一轮 loop,回报「谁被问了、谁真跑了、发了什么事件、审计写了什么」。
 * 这四样合起来才能判定审批层有没有生效 —— 只看其中一样都能被绕过。
 */
async function runOnce(options) {
  const asked = [];
  const executed = [];
  const events = [];
  const tools = options.tools ?? [
    toolDef('search_events', 'read', true),
    toolDef('rollback_operation', 'rollback')
  ];
  const calls = options.calls ?? [
    { id: 'c1', name: 'search_events', argumentsJson: '{"q":"x"}' },
    { id: 'c2', name: 'rollback_operation', argumentsJson: '{"opId":"op1"}' }
  ];
  const request = {
    config: CONFIG,
    apiKey: FAKE_KEY,
    messages: [{ role: 'user', content: 'go' }],
    tools,
    permissionMode: options.permissionMode ?? 'full',
    executeTool: async (call) => {
      executed.push(call.name);
      return { ok: true, content: '{}' };
    },
    onEvent: (event) => {
      if (typeof event.type === 'string' && event.type.startsWith('approval')) {
        events.push(event);
      }
    },
    ...(options.rounds ? {} : {}),
    ...(options.approvalRequiredLevels
      ? { approvalRequiredLevels: options.approvalRequiredLevels }
      : {})
  };
  if (options.approve !== undefined) {
    request.requestApproval = async (approvalRequest) => {
      asked.push(approvalRequest);
      return options.approve(approvalRequest, asked.length);
    };
  }
  const result = await runAgentToolLoop(
    makeAdapter(calls, options.rounds ?? 1),
    request
  );
  return { asked, executed, events, result };
}

// 判据⑫:审批分级必须建立在**生产 bridge 真实投影出的** permissionLevel 上。
//
// 上面各条用的是本门禁自造的 toolDef(),那能验证 loop 的逻辑,但看不见
// 「bridge 忘记透出 permissionLevel」这种失效 —— 实测拆掉 agentToolBridge 里的
// permissionLevel 后,判据①-⑪全部照绿,而生产里每个工具都会落到默认 'read',
// 审批门对写类工具完全失效。故必须拿真实注册表经真实 bridge 走一遍。
{
  const BRIDGE_JS = join(root, 'packages', 'core', 'dist', 'ai', 'agentToolBridge.js');
  const REGISTRY_JS = join(root, 'packages', 'core', 'dist', 'ai', 'toolRegistry.js');
  if (!existsSync(BRIDGE_JS) || !existsSync(REGISTRY_JS)) {
    report({
      ok: false, gate: LABEL, status: 'failed', code: 'BRIDGE_DIST_MISSING',
      message: '缺少 agentToolBridge / toolRegistry 编译产物;判据⑫无从观测,'
        + '缺判据必须失败关闭。'
    }, 1);
  }
  const { createAgentToolBridge } = await import(pathToFileURL(BRIDGE_JS).href);
  const { createDefaultToolRegistry } = await import(pathToFileURL(REGISTRY_JS).href);
  const registry = createDefaultToolRegistry();
  const bridge = createAgentToolBridge({
    registry,
    context: { workspaceIndex: {}, mode: 'fullPermission' }
  });

  const byLevel = new Map();
  for (const tool of bridge.tools) {
    const level = tool.permissionLevel;
    if (typeof level !== 'string' || level === '') {
      findings.push({
        code: 'BRIDGE_TOOL_MISSING_LEVEL',
        tool: tool.name,
        permissionLevel: level ?? null,
        message: `生产 bridge 投影的工具 ${tool.name} 没有 permissionLevel。`
          + ' 审批门会把它当作默认 read 等级,写类工具从此不再需要审批 ——'
          + '而这不会有任何报错。'
      });
      continue;
    }
    byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
  }

  // 生产注册表里必须真的存在需审批等级的工具,否则判据⑫零样本恒真。
  const gatedProductionTools = bridge.tools.filter(
    (tool) => DEFAULT_APPROVAL_REQUIRED_LEVELS.includes(tool.permissionLevel)
  );
  if (gatedProductionTools.length === 0) {
    report({
      ok: false, gate: LABEL, status: 'failed', code: 'NO_GATED_PRODUCTION_TOOLS',
      message: '生产注册表里没有任何需审批等级的工具;判据⑫零样本恒真。'
        + ` 当前等级分布:${JSON.stringify([...byLevel])}。`
        + ' 已知 rollback_operation 是 rollback 等级 —— 它消失或降级本身就是缺陷。'
    }, 1);
  }

  // 拿真实投影的工具定义跑一轮:被审批的必须正好是需审批等级的那些。
  const productionAsked = [];
  const productionExecuted = [];
  const gatedNames = new Set(gatedProductionTools.map((tool) => tool.name));
  const productionCalls = bridge.tools.slice(0, 6).map((tool, index) => ({
    id: `p${index}`,
    name: tool.name,
    argumentsJson: '{"probe":"gate"}'
  }));
  await runAgentToolLoop(makeAdapter(productionCalls, 1), {
    config: CONFIG,
    apiKey: FAKE_KEY,
    messages: [{ role: 'user', content: 'go' }],
    tools: bridge.tools,
    permissionMode: 'full',
    executeTool: async (call) => {
      productionExecuted.push(call.name);
      return { ok: true, content: '{}' };
    },
    requestApproval: async (approvalRequest) => {
      productionAsked.push(approvalRequest.toolName);
      return { decision: 'reject' };
    }
  });
  for (const name of productionAsked) {
    if (!gatedNames.has(name)) {
      findings.push({
        code: 'PRODUCTION_NON_GATED_TOOL_ASKED',
        tool: name,
        message: `生产工具 ${name} 的等级不在需审批清单里,却被弹了审批。`
      });
    }
  }
  for (const name of productionCalls.map((call) => call.name)) {
    if (gatedNames.has(name) && !productionAsked.includes(name)) {
      findings.push({
        code: 'PRODUCTION_GATED_TOOL_NOT_ASKED',
        tool: name,
        message: `生产工具 ${name} 属于需审批等级,但经真实 bridge 投影后没有被审批。`
          + ' 最可能的原因是 bridge 没把 permissionLevel 透给 loop。'
      });
    }
    if (gatedNames.has(name) && productionExecuted.includes(name)) {
      findings.push({
        code: 'PRODUCTION_GATED_TOOL_EXECUTED_AFTER_REJECT',
        tool: name,
        message: `生产工具 ${name} 已被拒绝却仍然执行。`
      });
    }
  }
}

// 判据②③⑤⑨:once 放行,只有写类被问,请求带参数,审计留痕。
{
  const { asked, executed, events, result } = await runOnce({ approve: () => ({ decision: 'once' }) });
  if (asked.length !== 1 || asked[0]?.toolName !== 'rollback_operation') {
    findings.push({
      code: 'APPROVAL_SCOPE_WRONG',
      asked: asked.map((entry) => entry.toolName),
      message: '只有写类工具应被询问。实际被询问的是:'
        + `${asked.map((entry) => entry.toolName).join(', ') || '(无)'}。`
        + ' 只读工具被问会造成审批疲劳;写类工具没被问等于门没生效。'
    });
  }
  if (asked[0] !== undefined) {
    if (typeof asked[0].argumentsJson !== 'string' || asked[0].argumentsJson.trim() === '') {
      findings.push({
        code: 'APPROVAL_REQUEST_MISSING_ARGUMENTS',
        request: asked[0],
        message: '审批请求没有携带 argumentsJson。只给工具名,用户批准的是'
          + '「写某个文件」而不是「写这个文件」,那不构成知情同意。'
      });
    }
    if (typeof asked[0].permissionLevel !== 'string' || asked[0].permissionLevel === '') {
      findings.push({
        code: 'APPROVAL_REQUEST_MISSING_LEVEL',
        request: asked[0],
        message: '审批请求没有携带 permissionLevel;UI 无法按危险程度分级呈现。'
      });
    }
  }
  if (!executed.includes('rollback_operation')) {
    findings.push({
      code: 'APPROVED_CALL_NOT_EXECUTED',
      executed,
      message: 'decision=once 已批准,但工具没有执行。审批通过必须真的放行。'
    });
  }
  const kinds = events.map((event) => event.type);
  if (!kinds.includes('approval-requested') || !kinds.includes('approval-resolved')) {
    findings.push({
      code: 'APPROVAL_EVENTS_MISSING',
      events: kinds,
      message: '审批过程必须发出 approval-requested 与 approval-resolved 事件,'
        + '否则界面无从呈现「正在等你批准」这个状态。'
    });
  }
  const approvals = result.audit?.approvals;
  if (!Array.isArray(approvals) || approvals.length !== 1 || approvals[0]?.decision !== 'once') {
    findings.push({
      code: 'APPROVAL_AUDIT_MISSING',
      approvals: approvals ?? null,
      message: '审批决定必须写入 audit.approvals。「agent 没跑那个工具」'
        + '与「用户拒绝了它」是两个不同的事实,审计里必须能区分。'
    });
  }
}

// 判据④:reject 与 never 必须阻止执行。
for (const decision of ['reject', 'never']) {
  const { executed, result } = await runOnce({ approve: () => ({ decision }) });
  if (executed.includes('rollback_operation')) {
    findings.push({
      code: 'DENIED_CALL_STILL_EXECUTED',
      decision,
      executed,
      message: `decision=${decision} 已拒绝,但工具仍然执行了。这是审批层最严重的`
        + '失效形态:用户以为自己拒绝了,操作照样发生。'
    });
  }
  if (!executed.includes('search_events')) {
    findings.push({
      code: 'DENIAL_BLOCKED_UNRELATED_CALL',
      decision,
      executed,
      message: `decision=${decision} 只应拒绝被审批的那一个调用,`
        + '同批次的只读调用不应被牵连。'
    });
  }
  if (result.audit?.approvals?.[0]?.decision !== decision) {
    findings.push({
      code: 'DENIAL_NOT_AUDITED',
      decision,
      approvals: result.audit?.approvals ?? null,
      message: `decision=${decision} 没有出现在 audit.approvals 里。`
    });
  }
}

// 判据⑥:always / never 进入会话记忆,第二轮不再询问且标记 fromMemory。
for (const [decision, shouldExecuteSecond] of [['always', true], ['never', false]]) {
  const { asked, executed, events } = await runOnce({
    approve: () => ({ decision }),
    rounds: 2,
    calls: [{ id: 'c9', name: 'rollback_operation', argumentsJson: '{"opId":"op1"}' }]
  });
  if (asked.length !== 1) {
    findings.push({
      code: 'APPROVAL_MEMORY_NOT_APPLIED',
      decision,
      askedTimes: asked.length,
      message: `decision=${decision} 应在本会话内记住,两轮同名调用只该询问一次,`
        + ` 实际询问了 ${asked.length} 次。`
    });
  }
  const resolved = events.filter((event) => event.type === 'approval-resolved');
  if (resolved.length >= 2 && resolved[1]?.fromMemory !== true) {
    findings.push({
      code: 'MEMORY_HIT_NOT_MARKED',
      decision,
      second: resolved[1] ?? null,
      message: '来自会话记忆的审批必须标记 fromMemory=true,'
        + '否则界面会把「按上次决定自动放行」显示成「用户刚刚批准」。'
    });
  }
  const executedCount = executed.filter((name) => name === 'rollback_operation').length;
  if (shouldExecuteSecond && executedCount !== 2) {
    findings.push({
      code: 'MEMORY_ALLOW_NOT_HONORED',
      decision, executedCount,
      message: `decision=always 后两轮都应执行,实际执行 ${executedCount} 次。`
    });
  }
  if (!shouldExecuteSecond && executedCount !== 0) {
    findings.push({
      code: 'MEMORY_DENY_NOT_HONORED',
      decision, executedCount,
      message: `decision=never 后两轮都不应执行,实际执行 ${executedCount} 次。`
    });
  }
}

// 判据⑦:审批记忆不得跨 run 存活。
{
  const first = await runOnce({
    approve: () => ({ decision: 'always' }),
    calls: [{ id: 'ca', name: 'rollback_operation', argumentsJson: '{"opId":"op1"}' }]
  });
  const second = await runOnce({
    approve: () => ({ decision: 'reject' }),
    calls: [{ id: 'cb', name: 'rollback_operation', argumentsJson: '{"opId":"op1"}' }]
  });
  if (first.asked.length !== 1 || second.asked.length !== 1) {
    findings.push({
      code: 'APPROVAL_MEMORY_LEAKED_ACROSS_RUNS',
      firstAsked: first.asked.length,
      secondAsked: second.asked.length,
      message: '第二个 run 必须重新询问。跨 run 记住「总是允许回滚」会把一个'
        + '工作区里做出的决定静默地带到另一个工作区。'
    });
  }
  if (second.executed.includes('rollback_operation')) {
    findings.push({
      code: 'STALE_MEMORY_ALLOWED_EXECUTION',
      message: '第二个 run 里用户已拒绝,但工具仍执行 —— 上一个 run 的 always 记忆泄漏了。'
    });
  }
}

// 判据⑧:审批通道异常必须按拒绝处理。
{
  const { executed, result } = await runOnce({
    approve: () => { throw new Error('approval channel unreachable'); }
  });
  if (executed.includes('rollback_operation')) {
    findings.push({
      code: 'APPROVAL_FAILURE_FELL_THROUGH_TO_EXECUTE',
      executed,
      message: '审批回调抛异常时工具仍然执行了。联系不上审批者不是同意 ——'
        + '这条路径必须 fail-closed,否则「审批服务挂了」会变成「全部自动批准」。'
    });
  }
  const decision = result.audit?.approvals?.[0]?.decision;
  if (decision !== 'reject') {
    findings.push({
      code: 'APPROVAL_FAILURE_NOT_AUDITED_AS_REJECT',
      decision: decision ?? null,
      message: `审批通道异常应记为 reject,实际记为 ${decision ?? '(无)'}。`
    });
  }
}

// 判据⑩:审批门排在模式门之后 —— plan 模式禁止的写类调用不得弹审批。
{
  const { asked, executed } = await runOnce({
    approve: () => ({ decision: 'once' }),
    permissionMode: 'plan'
  });
  if (asked.some((entry) => entry.toolName === 'rollback_operation')) {
    findings.push({
      code: 'DENIED_BY_MODE_STILL_ASKED',
      asked: asked.map((entry) => entry.toolName),
      message: 'plan 模式已禁止 rollback_operation,却仍把它作为可批准动作弹给用户。'
        + ' 询问一个无论如何都会被拒的操作,是在教用户「你的回答不影响结果」。'
    });
  }
  if (executed.includes('rollback_operation')) {
    findings.push({
      code: 'MODE_GATE_BYPASSED_BY_APPROVAL',
      message: 'plan 模式下写类工具被执行了 —— 审批通过不得越过模式门。'
        + ' 审批是叠加的检查点,不是替换既有门。'
    });
  }
}

// 判据⑪:不传 requestApproval 时行为不变。
{
  const { asked, executed, result } = await runOnce({});
  if (asked.length !== 0) {
    findings.push({
      code: 'APPROVAL_ASKED_WITHOUT_CALLBACK',
      message: '未提供 requestApproval 却发生了审批询问。'
    });
  }
  if (!executed.includes('rollback_operation') || !executed.includes('search_events')) {
    findings.push({
      code: 'NO_CALLBACK_SILENTLY_BLOCKED',
      executed,
      message: '未提供 requestApproval 时不得默默拦住工具 —— 那会让忘记接线的宿主'
        + '表现为「agent 什么都做不了」,且没有任何错误码说明原因。'
    });
  }
  if (result.audit?.approvals !== undefined) {
    findings.push({
      code: 'EMPTY_APPROVAL_AUDIT_PRESENT',
      message: '未发生审批时 audit.approvals 应缺席而不是空数组,'
        + '否则无法区分「没有审批层」与「审批层跑过但零条目」。'
    });
  }
}

// 判据①的补充:显式传空数组必须真的关闭审批门(不能退回默认值)。
{
  const { asked, executed } = await runOnce({
    approve: () => ({ decision: 'reject' }),
    approvalRequiredLevels: []
  });
  if (asked.length !== 0 || !executed.includes('rollback_operation')) {
    findings.push({
      code: 'EMPTY_LEVELS_NOT_HONORED',
      askedTimes: asked.length,
      executed,
      message: 'approvalRequiredLevels: [] 表示「不审批任何等级」,'
        + '不得回退成默认清单 —— `?? 默认值` 对空数组不生效,'
        + '但对 null/undefined 生效,这里区分的正是这个。'
    });
  }
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AGENT_APPROVAL_GATE_VIOLATION',
    message: 'Agent 审批层存在可绕过路径或行为不符。',
    defaultLevels: [...DEFAULT_APPROVAL_REQUIRED_LEVELS],
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: '审批层十二条判据通过:写类工具必经审批、拒绝真的阻止执行、'
    + '通道异常按拒绝处理、会话记忆不跨 run、审批不越过模式门、'
    + '且分级建立在生产 bridge 真实投影的 permissionLevel 上。',
  defaultLevels: [...DEFAULT_APPROVAL_REQUIRED_LEVELS],
  nonClaim: '本门禁只观测 agent loop 层的审批行为(fake adapter,不发网络请求)。'
    + '它不验证 renderer 的审批 UI 呈现(那由 renderer 单测与 e2e 负责),'
    + '不验证真实 provider 行为,也不证明用户会认真阅读审批请求。'
    + '审批层是叠加在 isToolAllowedInMode 与 registry 权限阶梯之上的用户检查点,'
    + '本门禁不重复验证那两层。'
}, 0);
