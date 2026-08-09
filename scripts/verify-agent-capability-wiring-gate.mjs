#!/usr/bin/env node
/**
 * Agent 能力接线门禁。
 *
 * 守的问题:agentLoop 与 agentSessionHost 实现了一批能力(超时、上下文压缩、
 * Context Broker、步数上限、重试次数、流式),但一个能力「实现了」与「生产会用上」
 * 是两件事。IPC 请求里没有对应字段时,那些能力永远是 undefined —— 而这不会
 * 报错、不会有测试红,只表现为「长任务永远不超时」「上下文从不压缩」。
 *
 * 实测(2026-08-08)接线前的真实状态,六项并不齐一:
 *   maxSteps      —— loop 内有默认 8(agentLoop:194),已生效但不可调
 *   retryPolicy   —— resolveRetryPolicy() 有默认策略,已生效但不可调
 *   streaming     —— 唯一此前已有 IPC 入口的
 *   timeoutMs     —— 无默认值,生产从未设过超时
 *   compaction    —— 需要 autoCompactTokenLimit 才触发,生产从未提供
 *   contextBroker —— createContextBroker() 生产零调用,且 AgentSessionRunParams
 *                    里当时根本没有这个字段,宿主层就断了
 * 所以「未启用」对后三项是准确的,对前三项应说「不可调」。
 *
 * 判据(静态读源码 + 运行期观测 host 透传):
 *   ① IPC 请求类型必须声明这六项对应的字段;
 *   ② main 的 ai.agent.run 必须把每个字段真的传给 runAgentSession
 *      —— 声明了却不传是最容易发生的半接线;
 *   ③ agentSessionHost 必须把它们继续透给 runAgentToolLoop;
 *   ④ 运行期观测:给 host 传入这些参数时,loop 收到的 request 上必须出现
 *      对应字段且值一致(这一条抓「透传写错字段名」);
 *   ⑤ 数值字段必须做下界过滤 —— timeoutMs=0 或负数传下去会让每次调用立刻超时;
 *   ⑥ contextBroker 必须由 main 侧构造(createContextBroker),不能让 renderer
 *      传入对象:那等于让渲染进程注入一个能读工作区的东西。
 *
 * 不做的事:不验证这些能力本身的正确性(超时是否精确、压缩摘要是否合理),
 * 那由 ai-conformance 的对应用例负责。本门禁只回答「接线是否真的通」。
 *
 * ── 负向证明(2026-08-08 实测七条)──
 *   W1  IPC 请求不再声明 timeoutMs        → IPC_FIELD_NOT_DECLARED
 *   W2  main 不转发 compaction             → MAIN_DOES_NOT_FORWARD
 *   W3  main 传硬编码常量而非 request 值   → MAIN_FORWARDS_CONSTANT
 *   W4  数值字段去掉 > 0 下界过滤          → NUMERIC_FIELD_UNGUARDED
 *   W5  contextBroker 改从 renderer 传入   → NOT_MAIN_CONSTRUCTED + FROM_RENDERER
 *   W6  host 不再透传 timeoutMs            → HOST_DOES_NOT_FORWARD + 运行期未达
 *   W7  host 透传值改成常量 999            → TIMEOUT_NOT_REACHING_ADAPTER
 *
 * W7 是判据④存在的理由:字段名照旧、类型照旧、静态转发判据全绿,只有运行期
 * 观测能看出值到不了。这类「接线看起来对但值是错的」缺陷不会有任何编译或
 * 类型报错。
 *
 * 本门禁自身也是先红后绿的产物:第一版实测抓出 retryPolicy 的真实半接线 ——
 * 当时用 `const retryPolicy = ...` 在调用块外算,块内看不出值来自 request,
 * 判据②③按设计报了 MAIN_DOES_NOT_FORWARD。改成调用块内联读取后转绿。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LABEL = 'agent-capability-wiring';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IPC_TS = join(root, 'apps', 'desktop', 'src', 'main', 'ipc.ts');
const HOST_TS = join(root, 'packages', 'core', 'src', 'model-services', 'agentSessionHost.ts');
const HOST_JS = join(root, 'packages', 'core', 'dist', 'model-services', 'agentSessionHost.js');

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

for (const [name, path] of [['ipc.ts', IPC_TS], ['agentSessionHost.ts', HOST_TS], ['agentSessionHost.js', HOST_JS]]) {
  if (!existsSync(path)) {
    report({
      ok: false, gate: LABEL, status: 'failed', code: 'SOURCE_MISSING',
      message: `缺少 ${name}:${path}。`
    }, 1);
  }
}

const ipcSource = readFileSync(IPC_TS, 'utf8');
const hostSource = readFileSync(HOST_TS, 'utf8');
const findings = [];

/**
 * 六项能力。每项给出:IPC 请求字段名、host 参数名、loop 请求字段名。
 * 三者不同名的地方正是最容易接错的地方(autoCompactTokenLimit → compaction,
 * retryMaxAttempts → retryPolicy,useContextBroker → contextBroker)。
 */
const CAPABILITIES = Object.freeze([
  { id: 'timeoutMs', ipcField: 'timeoutMs', hostParam: 'timeoutMs', loopField: 'timeoutMs', numeric: true },
  { id: 'maxSteps', ipcField: 'maxSteps', hostParam: 'maxSteps', loopField: 'maxSteps', numeric: true },
  { id: 'streaming', ipcField: 'streaming', hostParam: 'streaming', loopField: 'streaming', numeric: false },
  { id: 'compaction', ipcField: 'autoCompactTokenLimit', hostParam: 'compaction', loopField: 'compaction', numeric: true },
  { id: 'retryPolicy', ipcField: 'retryMaxAttempts', hostParam: 'retryPolicy', loopField: 'retryPolicy', numeric: true },
  { id: 'contextBroker', ipcField: 'useContextBroker', hostParam: 'contextBroker', loopField: 'contextBroker', numeric: false }
]);

// 判据①:IPC 请求类型声明。
const runRequestMatch = /export interface AiAgentRunRequest \{([\s\S]*?)\n\}/.exec(ipcSource);
if (runRequestMatch === null) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'RUN_REQUEST_UNPARSEABLE',
    message: '未能从 ipc.ts 提取 AiAgentRunRequest;提取失败必须失败关闭,'
      + '否则判据①会退化成必然通过。'
  }, 1);
}
const runRequestBody = runRequestMatch[1];
for (const capability of CAPABILITIES) {
  if (!new RegExp(`\\b${capability.ipcField}\\??:`).test(runRequestBody)) {
    findings.push({
      code: 'IPC_FIELD_NOT_DECLARED',
      capability: capability.id,
      field: capability.ipcField,
      message: `AiAgentRunRequest 没有声明 ${capability.ipcField};`
        + ` 能力 ${capability.id} 在生产里永远拿不到值。`
    });
  }
}

// 判据②:main 必须真的把字段传下去。截取 runAgentSession 调用块。
const runCallMatch = /void runAgentSession\(\{([\s\S]*?)\n    \}\)/.exec(ipcSource);
if (runCallMatch === null) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'RUN_CALL_UNPARSEABLE',
    message: '未能从 ipc.ts 提取 runAgentSession 调用块;失败关闭。'
  }, 1);
}
const runCallBody = runCallMatch[1];
for (const capability of CAPABILITIES) {
  // host 参数名必须出现在调用块里;同时要求 IPC 字段名也出现(证明值来自请求,
  // 而不是硬编码常量)。
  if (!new RegExp(`\\b${capability.hostParam}\\s*:`).test(runCallBody)) {
    findings.push({
      code: 'MAIN_DOES_NOT_FORWARD',
      capability: capability.id,
      hostParam: capability.hostParam,
      message: `main 的 runAgentSession 调用里没有 ${capability.hostParam};`
        + ' 字段声明了但不传下去是最常见的半接线形态。'
    });
    continue;
  }
  if (!new RegExp(`request\\.${capability.ipcField}\\b`).test(runCallBody)) {
    findings.push({
      code: 'MAIN_FORWARDS_CONSTANT',
      capability: capability.id,
      message: `main 传了 ${capability.hostParam},但调用块里没有读 request.${capability.ipcField}`
        + ' —— 传的可能是硬编码常量,renderer 的设置不会生效。'
    });
  }
}

// 判据⑤:数值字段的下界过滤。
for (const capability of CAPABILITIES.filter((entry) => entry.numeric)) {
  const guarded = new RegExp(
    `request\\.${capability.ipcField}[^\\n]*(!=\\s*null|!==\\s*undefined)[^\\n]*>\\s*0`
  ).test(runCallBody)
    || new RegExp(`request\\.${capability.ipcField}\\s*!=\\s*null[\\s\\S]{0,120}?>\\s*0`).test(runCallBody);
  if (!guarded) {
    findings.push({
      code: 'NUMERIC_FIELD_UNGUARDED',
      capability: capability.id,
      field: capability.ipcField,
      message: `${capability.ipcField} 是数值字段但没有 > 0 的下界过滤。`
        + ' timeoutMs=0 会让每次模型调用立刻超时;maxSteps=0 会让任务一步都不跑。'
    });
  }
}

// 判据⑥:contextBroker 必须由 main 构造,不能来自 renderer。
if (!/contextBroker:\s*createContextBroker\(\)/.test(runCallBody)) {
  findings.push({
    code: 'CONTEXT_BROKER_NOT_MAIN_CONSTRUCTED',
    message: 'contextBroker 必须由 main 侧 createContextBroker() 构造。'
      + ' 让 renderer 传入 broker 对象等于让渲染进程注入一个能读工作区的东西。'
  });
}
if (new RegExp('request\\.contextBroker\\b').test(runCallBody)) {
  findings.push({
    code: 'CONTEXT_BROKER_FROM_RENDERER',
    message: 'main 直接使用了 request.contextBroker —— 渲染进程不得注入 broker 实例。'
  });
}

// 判据③:host 必须继续透传。
for (const capability of CAPABILITIES) {
  if (!new RegExp(`params\\.${capability.hostParam}\\b`).test(hostSource)) {
    findings.push({
      code: 'HOST_DOES_NOT_FORWARD',
      capability: capability.id,
      hostParam: capability.hostParam,
      message: `agentSessionHost 没有读 params.${capability.hostParam};`
        + ' 宿主层断链时 main 传了也到不了 loop。'
    });
  }
}

// 判据④:运行期观测 host → loop 的透传。用假 adapter,不发网络请求。
const observed = {};
{
  const { runAgentSession } = await import(pathToFileURL(HOST_JS).href);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const sessionsDir = await mkdtemp(join(tmpdir(), 'soulforge-wiring-gate-'));
  try {
    // 记录 loop 收到的 request:host 内部会调 runAgentToolLoop,而那是模块内
    // 直接引用,拦不住。改为观测 adapter 侧能看到的效果 + host 传给 loop 的
    // 参数——后者通过一个会在第一次 complete 时抛出的 adapter 来提取。
    const captured = {};
    const adapter = {
      async complete(request) {
        // timeoutMs 会被 loop 原样放进 ModelCompleteRequest。
        captured.timeoutMs = request.timeoutMs;
        return {
          ok: true,
          message: { role: 'assistant', content: 'done', toolCalls: [] },
          finishReason: 'stop',
          diagnostics: []
        };
      }
    };
    const result = await runAgentSession({
      sessionsDir,
      sessionId: 'wiring-probe',
      adapter,
      config: {
        id: 'cfg', displayName: 'd', protocol: 'anthropic',
        baseUrl: 'https://example.invalid', model: 'm', hasCredential: true,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
      },
      apiKey: 'sk-wiring-gate-placeholder-000',
      prompt: 'probe',
      permissionMode: 'plan',
      tools: [],
      executeTool: async () => ({ ok: true, content: '{}' }),
      timeoutMs: 12_345,
      maxSteps: 3,
      streaming: false
    });
    observed.timeoutMsReachedAdapter = captured.timeoutMs;
    observed.auditStreaming = result.run.audit.streaming ?? false;
    if (captured.timeoutMs !== 12_345) {
      findings.push({
        code: 'TIMEOUT_NOT_REACHING_ADAPTER',
        observed: captured.timeoutMs ?? null,
        message: `host 收到 timeoutMs=12345,但 adapter 侧观测到 ${captured.timeoutMs ?? '(无)'}。`
          + ' 透传链上有一环没接通 —— 这一条抓的正是「参数名写对了但值没传下去」。'
      });
    }
  } finally {
    await rm(sessionsDir, { recursive: true, force: true });
  }
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AGENT_CAPABILITY_WIRING_VIOLATION',
    message: 'agent 能力接线不完整:声明、转发或透传链上有缺口。',
    capabilities: CAPABILITIES.map((entry) => entry.id),
    observed,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: '六项能力(timeoutMs / maxSteps / streaming / compaction / retryPolicy / '
    + 'contextBroker)从 IPC 请求到 loop 的接线完整,数值字段有下界过滤,'
    + 'contextBroker 由 main 构造。',
  capabilities: CAPABILITIES.map((entry) => ({
    id: entry.id, ipcField: entry.ipcField, hostParam: entry.hostParam
  })),
  observed,
  nonClaim: '本门禁只回答「接线是否真的通」。它不验证这些能力自身的正确性'
    + '(超时是否精确、压缩摘要是否合理、broker 装配的证据是否恰当),'
    + '那由 ai-conformance 的对应用例负责。运行期观测只覆盖 timeoutMs 到达'
    + ' adapter 这一条链;其余五项由静态转发判据覆盖。'
}, 0);
