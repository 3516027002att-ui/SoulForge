/** Finite engine outcomes and actual resource facts remain separate from task evaluation. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { ToolRegistry } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import { parseRolloutLines } from '../model-services/rolloutRecorder.js';
import type {
  AgentEvent, AgentPermissionMode, ChatMessage, ModelCompleteResult, ModelServiceAdapter, RolloutItem, ToolCall
} from '../model-services/types.js';

function agentDeltaText(events: readonly AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'agent-message-delta' }> => (
      event.type === 'agent-message-delta'
    ))
    .map((event) => event.text)
    .join('');
}

function assistantContents(messages: readonly ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content);
}

interface StatusCase {
  name: string;
  text: string;
  query?: string;
  mode?: AgentPermissionMode;
}

const cases: StatusCase[] = [
  { name: 'historical no-write report', text: '已完成定位与原生确认，本次未做任何写入。' },
  { name: 'historical staging failure', text: '## 执行结果：未能写入（环境阻断，非方案错误）' },
  { name: 'explicit incomplete task', text: '本次任务未完成，仍缺少原生写入证据。' },
  { name: 'blocked handoff is terminal', text: '当前任务被阻塞，无法继续执行。下一步需要补齐语料。' },
  { name: 'partial status', text: '**状态：partial**，血条修改已完成，掉落尚未完成。' },
  { name: 'bare blocked status', text: 'BLOCKED：未取得当前原生证据。' },
  { name: 'English current status', text: 'This task is incomplete.' },
  { name: 'partial read-only task', query: '只读分析这份事件', mode: 'plan', text: '本次任务未完成，缺少所需文件。' },
  { name: 'successful modification', text: '本次修改完成，写入已提交并回读验证。' },
  { name: 'read-only analysis in normal mode', query: '只读分析事件，不要修改', text: '分析完成，本次未做任何写入。' },
  { name: 'diagnosis only', query: '仅排查写回失败原因，无需修复', text: '原因已确认，本次未写入。' },
  { name: 'analysis mentioning modification', query: '分析上次修改为什么失败', text: '原因已确认，本次未写入。' },
  { name: 'analysis and implementation', query: '请分析并修复写回问题', text: '本次未写入。' },
  { name: 'plan does not require writes', mode: 'plan', text: '规划完成，本次未做任何写入。' },
  { name: 'no declared mutation objective', query: '检查现有数值', text: '检查完成，本次未做任何写入。' },
  { name: 'error-code explanation', query: '解释错误码', text: '错误码 partial 表示任务部分完成。' },
  { name: 'explanation in edit task', text: '错误码说明：本次任务未完成是旧提示，本次修复已经验证通过。' },
  { name: 'historical failure', text: '历史报告记录：本次未做任何写入。\n本次修改已完成并回读验证。' },
  { name: 'quoted old status', text: '旧报告写着“本次任务未完成”。\n本次修复已通过。' },
  { name: 'inline quoted old failure', text: "返回里曾有'本次未写入'提示，本次已修复。" },
  { name: 'inline code sample', text: '返回文案样例是 `本次未写入`，本次已修复。' },
  { name: 'blockquote', text: '> 当前任务：blocked\n\n以上为旧报告，本次已完成。' },
  { name: 'code sample', text: '```text\n当前任务未完成\n```\n代码示例已整理完成。' },
  { name: 'conditional failure', text: '如果本次未写入，就应标记 partial；本次已经写入并验证。' },
  { name: 'status term explanation', text: 'partial 的含义是部分完成。本次修复通过。' },
  { name: 'label explanation', text: '状态：partial 表示部分完成，本次已经修复。' },
  { name: 'subtask status is not overall status', text: '历史迁移任务未完成不影响本次请求。本次修改已完成。' }
];

function fixtureUsage(message: ChatMessage) {
  return { inputTokens: 10, outputTokens: Math.max(1, Buffer.byteLength(JSON.stringify(message), 'utf8')) };
}

function fixtureCompletion(result: ModelCompleteResult): ModelCompleteResult {
  return { ...result, usage: result.usage ?? fixtureUsage(result.message) };
}

export async function runAgentTaskStatusSmoke(): Promise<void> {
  const taskVerdicts: Array<{ scenario: string; engineFinish: string; task: 'unverified' | 'resource_partial'; basis: string }> = [];
  for (const streaming of [false, true]) {
    for (const scenario of cases) {
      const events: AgentEvent[] = [];
      const rollout: RolloutItem[] = [];
      let calls = 0;
      const adapter: ModelServiceAdapter = {
        protocol: 'openai-compatible',
        async complete() {
          calls += 1;
          return fixtureCompletion({ message: { role: 'assistant', content: scenario.text }, finishReason: 'stop', diagnostics: [] });
        },
        async *stream() {
          calls += 1;
          yield { type: 'usage', ...fixtureUsage({ role: 'assistant', content: scenario.text }) };
          yield { type: 'text-delta', text: scenario.text };
          yield { type: 'message-stop', finishReason: 'stop' };
        },
        async listModels() { return { ok: true, models: [] }; }
      };
      const result = await runAgentToolLoop(adapter, {
        config: {
          id: 'completion-fixture', displayName: 'completion fixture',
          protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9',
          model: 'fixture', hasCredential: false,
          createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
        },
        apiKey: 'fixture-status-credential',
        // Old assistant status in history must not affect the current report.
        messages: [
          { role: 'assistant', content: '本次任务未完成。' },
          { role: 'user', content: scenario.query ?? '把鬼刑部血条改为2并写回' }
        ],
        taskQuery: scenario.query ?? '把鬼刑部血条改为2并写回',
        permissionMode: scenario.mode ?? 'normal',
        tools: [],
        executeTool: async () => { throw new Error('Unexpected tool execution'); },
        maxSteps: 4,
        streaming,
        onEvent: (event) => { events.push(event); },
        rollout: {
          enqueue(item) { rollout.push(item); },
          async flush() {}
        }
      });
      const label = `${scenario.name}, streaming=${streaming}`;
      assert.equal(calls, 1, `${label}: terminal reports must not be resampled`);
      assert.equal(result.finishReason, 'stop', `${label}: model wording does not change engine termination`);
      const providerEnd = events.find((event) => event.type === 'step-complete');
      assert.ok(providerEnd?.type === 'step-complete', label);
      assert.equal(providerEnd.finishReason, 'stop', `${label}: retain provider outcome`);
      const sessionEnd = events.find((event) => event.type === 'turn-complete');
      assert.ok(sessionEnd?.type === 'turn-complete', label);
      assert.equal(sessionEnd.finishReason, result.finishReason, label);
      const durableEnd = rollout.find((item) => item.type === 'turn-complete');
      assert.ok(durableEnd?.type === 'turn-complete', label);
      assert.equal(durableEnd.finishReason, result.finishReason, label);
      assert.equal(durableEnd.taskStatus, 'completed', `${label}: compatibility control status`);
      assert.equal(result.audit.toolCalls.length, 0, `${label}: no independent domain proof`);
      assert.equal(result.messages.at(-1)?.content, scenario.text, `${label}: preserve provider text`);
      assert.equal(agentDeltaText(events), scenario.text, `${label}: actual provider text reaches the event boundary exactly once`);
      assert.ok(!result.diagnostics.some((item) => item.code === 'AGENT_REPORTED_TASK_PARTIAL'), label);
      taskVerdicts.push({ scenario: label, engineFinish: result.finishReason, task: 'unverified', basis: 'Only provider text was returned; no independent domain evidence was obtained.' });
    }
  }

  // A committed write may carry ok=true while its post-commit knowledge
  // refresh failed. A later ordinary read must not clear that degraded state
  // and let the final model sentence falsely become completed.
  for (const streaming of [false, true]) {
    const events: AgentEvent[] = [];
    const rollout: RolloutItem[] = [];
    const calls: ToolCall[] = [
      { id: 'write-call', name: 'write_fixture', argumentsJson: '{}' },
      { id: 'read-call', name: 'read_fixture', argumentsJson: '{}' }
    ];
    let providerCalls = 0;
    const adapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      async complete() {
        providerCalls += 1;
        if (providerCalls <= calls.length) {
          return fixtureCompletion({
            message: { role: 'assistant', content: '', toolCalls: [calls[providerCalls - 1]!] },
            finishReason: 'tool_use',
            diagnostics: []
          });
        }
        return fixtureCompletion({
          message: { role: 'assistant', content: '本次修改完成并回读验证。' },
          finishReason: 'stop',
          diagnostics: []
        });
      },
      async *stream() {
        providerCalls += 1;
        if (providerCalls <= calls.length) {
          yield { type: 'usage', ...fixtureUsage({ role: 'assistant', content: '', toolCalls: [calls[providerCalls - 1]!] }) };
          yield { type: 'tool-call', toolCall: calls[providerCalls - 1]! };
          yield { type: 'message-stop', finishReason: 'tool_use' };
          return;
        }
        yield { type: 'usage', ...fixtureUsage({ role: 'assistant', content: '本次修改完成并回读验证。' }) };
        yield { type: 'text-delta', text: '本次修改完成并回读验证。' };
        yield { type: 'message-stop', finishReason: 'stop' };
      },
      async listModels() { return { ok: true, models: [] }; }
    };
    const result = await runAgentToolLoop(adapter, {
      config: {
        id: 'sticky-refresh-fixture', displayName: 'sticky refresh fixture',
        protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9',
        model: 'fixture', hasCredential: false,
        createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
      },
      apiKey: 'fixture-sticky-credential',
      messages: [{ role: 'user', content: '修改并验证这个资源' }],
      taskQuery: '修改并验证这个资源',
      permissionMode: 'normal',
      tools: [
        { name: 'write_fixture', description: 'fixture write', parametersJsonSchema: {}, permissionLevel: 'commit' },
        { name: 'read_fixture', description: 'fixture read', parametersJsonSchema: {}, permissionLevel: 'read' }
      ],
      executeTool: async (call) => call.name === 'write_fixture'
        ? {
            ok: true,
            content: JSON.stringify({
              ok: true,
              state: 'committed',
              transaction: { state: 'committed', opId: 'sticky-refresh-op' },
              data: { record: { lifecycle: { transaction: 'committed', knowledgeRefresh: 'failed' } } }
            })
          }
        : {
            ok: true,
            content: JSON.stringify({
              ok: true,
              state: 'completed',
              data: { sourceUri: 'file:///fixture/resource.param' },
              evidence: { status: 'native-verified' }
            })
          },
      maxSteps: 5,
      requestApproval: async () => ({ decision: 'once' }),
      streaming,
      onEvent: (event) => { events.push(event); },
      rollout: {
        enqueue(item) { rollout.push(item); },
        async flush() {}
      }
    });
    assert.equal(providerCalls, 3, `sticky refresh, streaming=${streaming}: provider calls`);
    assert.equal(result.finishReason, 'partial', `sticky refresh, streaming=${streaming}`);
    assert.ok(result.diagnostics.some((item) => item.code === 'AGENT_KNOWLEDGE_REFRESH_DEGRADED'));
    assert.equal(result.audit.toolCalls.length, 2);
    assert.ok(result.audit.toolCalls.every((call) => call.ok));
    assert.equal(result.audit.approvals?.[0]?.decision, 'once');
    const committed = JSON.parse(result.messages.find((message) => message.role === 'tool' && message.name === 'write_fixture')!.content);
    assert.equal(committed.state, 'committed');
    assert.equal(committed.transaction.state, 'committed');
    assert.equal(committed.data.record.lifecycle.knowledgeRefresh, 'failed');
    assert.equal(agentDeltaText(events), '本次修改完成并回读验证。');
    assert.equal(assistantContents(result.messages).filter((text) => text === '本次修改完成并回读验证。').length, 1);
    const reloaded = parseRolloutLines(rollout.map((item) => JSON.stringify(item)));
    assert.equal(
      reloaded.messages.filter((message) => message.content === '本次修改完成并回读验证。').length,
      1,
      `sticky refresh, streaming=${streaming}: rollout reload model text`
    );
    assert.equal(reloaded.terminal?.finishReason, 'partial');
    assert.equal(reloaded.terminal?.taskStatus, 'partial');
    const durableEnd = rollout.find((item) => item.type === 'turn-complete');
    assert.ok(durableEnd?.type === 'turn-complete');
    assert.equal(durableEnd.taskStatus, 'partial');
    const sessionEnd = events.find((event) => event.type === 'turn-complete');
    assert.ok(sessionEnd?.type === 'turn-complete');
    assert.equal(sessionEnd.finishReason, 'partial');
    taskVerdicts.push({ scenario: `sticky refresh, streaming=${streaming}`, engineFinish: result.finishReason, task: 'resource_partial', basis: 'Write is committed, but its knowledge refresh failed and a later read cannot erase that fact.' });
  }

  // A sticky refresh failure must annotate every non-stop terminal without
  // rewriting the loop's actual finishReason.  These cases deliberately do
  // not ask the provider for a terminal resample.
  for (const terminalCase of ['cancelled', 'error', 'length'] as const) {
    for (const streaming of [false, true]) {
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const rollout: RolloutItem[] = [];
      const calls: ToolCall[] = [
        { id: `${terminalCase}-write-call`, name: 'write_fixture', argumentsJson: '{}' },
        { id: `${terminalCase}-read-call`, name: 'read_fixture', argumentsJson: '{}' }
      ];
      let providerCalls = 0;
      let executedWrites = 0;
      let executedReads = 0;
      const adapter: ModelServiceAdapter = {
        protocol: 'openai-compatible',
        async complete() {
          providerCalls += 1;
          if (providerCalls === 1) {
            return fixtureCompletion({
              message: { role: 'assistant', content: '', toolCalls: [calls[0]!] },
              finishReason: 'tool_use' as const,
              diagnostics: [],
              ...(terminalCase === 'length' ? { usage: { inputTokens: 10, outputTokens: 63 } } : {})
            });
          }
          if (providerCalls === 2) {
            return fixtureCompletion({
              message: { role: 'assistant', content: '', toolCalls: [calls[1]!] },
              finishReason: 'tool_use' as const,
              diagnostics: [],
              ...(terminalCase === 'length' ? { usage: { inputTokens: 10, outputTokens: 1 } } : {})
            });
          }
          return fixtureCompletion({
            message: { role: 'assistant', content: '' },
            finishReason: 'error' as const,
            diagnostics: [{ severity: 'error' as const, code: 'MODEL_SERVICE_HTTP_ERROR', message: 'fixture terminal error' }]
          });
        },
        async *stream() {
          providerCalls += 1;
          if (providerCalls === 1) {
            yield { type: 'usage', ...(terminalCase === 'length' ? { inputTokens: 10, outputTokens: 63 } : fixtureUsage({ role: 'assistant', content: '', toolCalls: [calls[0]!] })) };
            yield { type: 'tool-call', toolCall: calls[0]! };
            yield { type: 'message-stop', finishReason: 'tool_use' };
            return;
          }
          if (providerCalls === 2) {
            yield { type: 'usage', ...(terminalCase === 'length' ? { inputTokens: 10, outputTokens: 1 } : fixtureUsage({ role: 'assistant', content: '', toolCalls: [calls[1]!] })) };
            yield { type: 'tool-call', toolCall: calls[1]! };
            yield { type: 'message-stop', finishReason: 'tool_use' };
            return;
          }
          yield { type: 'usage', ...fixtureUsage({ role: 'assistant', content: '' }) };
          yield { type: 'error', code: 'MODEL_SERVICE_HTTP_ERROR', message: 'fixture terminal error' };
        },
        async listModels() { return { ok: true, models: [] }; }
      };
      const result = await runAgentToolLoop(adapter, {
        config: {
          id: `sticky-terminal-${terminalCase}`, displayName: 'sticky terminal fixture',
          protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9',
          model: 'fixture', hasCredential: false,
          createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
        },
        apiKey: `fixture-sticky-${terminalCase}-credential`,
        messages: [{ role: 'user', content: '修改并验证这个资源' }],
        taskQuery: '修改并验证这个资源',
        permissionMode: 'normal',
        tools: [
          { name: 'write_fixture', description: 'fixture write', parametersJsonSchema: {}, permissionLevel: 'commit' },
          { name: 'read_fixture', description: 'fixture read', parametersJsonSchema: {}, permissionLevel: 'read' }
        ],
        executeTool: async (call) => {
          if (call.name === 'write_fixture') {
            executedWrites += 1;
            return {
              ok: true,
              content: JSON.stringify({
                ok: true,
                state: 'committed',
                transaction: { state: 'committed', opId: 'sticky-terminal-op' },
                data: { record: { lifecycle: { transaction: 'committed', knowledgeRefresh: 'failed' } } }
              })
            };
          }
          executedReads += 1;
          if (terminalCase === 'cancelled') controller.abort();
          return {
            ok: true,
            content: JSON.stringify({
              ok: true,
              state: 'completed',
              data: { sourceUri: 'file:///fixture/resource.param' },
              evidence: { status: 'native-verified' }
            })
          };
        },
        maxSteps: 5,
        requestApproval: async () => ({ decision: 'once' }),
        ...(terminalCase === 'length' ? { maxTotalOutputTokens: 64 } : {}),
        ...(terminalCase === 'cancelled' ? { signal: controller.signal } : {}),
        streaming,
        onEvent: (event) => { events.push(event); },
        rollout: {
          enqueue(item) { rollout.push(item); },
          async flush() {}
        }
      });
      const label = `sticky ${terminalCase}, streaming=${streaming}`;
      const expectedTaskStatus = terminalCase === 'cancelled'
        ? 'cancelled'
        : terminalCase === 'error'
          ? 'error'
          : 'partial';
      const expectedProviderCalls = terminalCase === 'cancelled'
        ? 2
        : terminalCase === 'error'
          ? 3
          : 2;
      assert.equal(providerCalls, expectedProviderCalls, `${label}: provider calls`);
      const expectedFinish = terminalCase === 'length' ? 'partial' : terminalCase;
      assert.equal(result.finishReason, expectedFinish, `${label}: actual finishReason`);
      assert.equal(executedWrites, 1, `${label}: committed write remains observed`);
      assert.equal(executedReads, terminalCase === 'length' ? 0 : 1, `${label}: output exhaustion must not dispatch the next read`);
      assert.ok(result.diagnostics.some((item) => item.code === 'AGENT_KNOWLEDGE_REFRESH_DEGRADED'), `${label}: actual refresh diagnostic`);
      const committed = JSON.parse(result.messages.find((message) => message.role === 'tool' && message.name === 'write_fixture')!.content);
      assert.equal(committed.transaction.state, 'committed', `${label}: transaction truth`);
      assert.equal(committed.data.record.lifecycle.knowledgeRefresh, 'failed', `${label}: refresh truth`);
      const reloaded = parseRolloutLines(rollout.map((item) => JSON.stringify(item)));
      assert.equal(reloaded.terminal?.finishReason, expectedFinish, `${label}: rollout finishReason`);
      assert.equal(reloaded.terminal?.taskStatus, expectedTaskStatus, `${label}: rollout taskStatus`);
      const sessionEnd = events.find((event) => event.type === 'turn-complete');
      assert.ok(sessionEnd?.type === 'turn-complete', label);
      assert.equal(sessionEnd.finishReason, expectedFinish, `${label}: session finishReason`);
      taskVerdicts.push({ scenario: label, engineFinish: result.finishReason, task: 'resource_partial', basis: 'A committed write retains failed-refresh metadata across cancellation, error or output exhaustion.' });
    }
  }

  // A previous turn's assistant answer does not change a pre-aborted run.
  // Cancellation emits durable metadata without dispatching a provider/tool.
  for (const streaming of [false, true]) {
    const controller = new AbortController();
    controller.abort();
    const events: AgentEvent[] = [];
    const rollout: RolloutItem[] = [];
    let providerCalls = 0;
    const adapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      async complete() {
        providerCalls += 1;
        return fixtureCompletion({ message: { role: 'assistant', content: 'must not be called' }, finishReason: 'stop', diagnostics: [] });
      },
      async *stream() {
        providerCalls += 1;
        yield { type: 'text-delta', text: 'must not be called' };
        yield { type: 'message-stop', finishReason: 'stop' };
      },
      async listModels() { return { ok: true, models: [] }; }
    };
    const result = await runAgentToolLoop(adapter, {
      config: {
        id: 'stale-assistant-terminal-fixture', displayName: 'stale assistant terminal fixture',
        protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9',
        model: 'fixture', hasCredential: false,
        createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
      },
      apiKey: 'fixture-stale-assistant-credential',
      messages: [
        { role: 'assistant', content: '旧轮已完成。' },
        { role: 'user', content: '当前任务' }
      ],
      taskQuery: '当前任务',
      permissionMode: 'normal',
      tools: [],
      executeTool: async () => { throw new Error('Unexpected tool execution'); },
      signal: controller.signal,
      streaming,
      onEvent: (event) => { events.push(event); },
      rollout: {
        enqueue(item) { rollout.push(item); },
        async flush() {}
      }
    });
    const label = `stale assistant terminal, streaming=${streaming}`;
    assert.equal(providerCalls, 0, `${label}: provider calls`);
    assert.equal(result.finishReason, 'cancelled', label);
    assert.equal(result.steps, 0, `${label}: no model turn`);
    assert.equal(result.audit.toolCalls.length, 0, `${label}: no tool dispatch`);
    assert.equal(agentDeltaText(events), '', `${label}: no fabricated provider text`);
    assert.deepEqual(assistantContents(result.messages), ['旧轮已完成。'], `${label}: preserve existing history`);
    const reloaded = parseRolloutLines(rollout.map((item) => JSON.stringify(item)));
    assert.equal(reloaded.messages.length, 0, `${label}: no new assistant report was persisted`);
    assert.equal(reloaded.terminal?.finishReason, 'cancelled', `${label}: rollout finishReason`);
    assert.equal(reloaded.terminal?.taskStatus, 'cancelled', `${label}: rollout taskStatus`);
  }

  // Exercise the production registry -> bounded bridge -> loop path. The
  // write payload intentionally exceeds the identity budget; the bridge must
  // preserve the committed lifecycle so the loop's degraded-refresh sticky
  // status still survives the later ordinary read.
  for (const refreshCase of [
    {
      name: 'nested lifecycle object',
      data: {
        lifecycle: {
          transaction: 'committed',
          nativeVerification: { status: 'verified', sourceUri: 'workspace://mods/NpcParam.parambnd.dcx' },
          knowledgeRefresh: { status: 'failed' }
        }
      },
      partial: true
    },
    { name: 'top-level string', data: { knowledgeRefresh: 'failed' }, partial: true },
    { name: 'top-level object', data: { knowledgeRefresh: { status: 'failed' } }, partial: true },
    { name: 'healthy completed', data: { knowledgeRefresh: 'completed' }, partial: false },
    { name: 'healthy not requested', data: { knowledgeRefresh: 'not_requested' }, partial: false }
  ] as const) {
    for (const streaming of [false, true]) {
      const registry = new ToolRegistry();
      registry.register({
        name: 'write_oversized_fixture', description: 'fixture committed write', permission: 'commit', permissionLevel: 'commit',
        run: () => ({
          ok: true,
          state: 'committed' as const,
          data: {
            operationId: 'bridge-loop-committed-op',
            sourceUri: 'workspace://mods/NpcParam.parambnd.dcx',
            ...refreshCase.data,
            sourceVersions: Array.from({ length: 128 }, (_, index) => ({
              sourceUri: `workspace://mods/event/${String(index).padStart(8, '0')}/${'long-source-name/'.repeat(3)}.emevd.dcx`,
              sourceRevision: 123
            }))
          }
        })
      });
      registry.register({
        name: 'read_oversized_fixture', description: 'fixture ordinary read', permission: 'read', permissionLevel: 'read',
        run: () => ({
          ok: true,
          state: 'completed' as const,
          data: { sourceUri: 'workspace://mods/NpcParam.parambnd.dcx' }
        })
      });
      const bridge = createAgentToolBridge({
        registry,
        context: { workspaceIndex: new WorkspaceIndex('bridge-loop-sticky-fixture'), mode: 'normal' }
      });
      const events: AgentEvent[] = [];
      const rollout: RolloutItem[] = [];
      const calls: ToolCall[] = [
        { id: 'oversized-write-call', name: 'write_oversized_fixture', argumentsJson: '{}' },
        { id: 'ordinary-read-call', name: 'read_oversized_fixture', argumentsJson: '{}' }
      ];
      let providerCalls = 0;
      const adapter: ModelServiceAdapter = {
        protocol: 'openai-compatible',
        async complete() {
          providerCalls += 1;
          if (providerCalls <= calls.length) {
            return fixtureCompletion({
              message: { role: 'assistant', content: '', toolCalls: [calls[providerCalls - 1]!] },
              finishReason: 'tool_use', diagnostics: []
            });
          }
          return fixtureCompletion({ message: { role: 'assistant', content: '本次修改完成并回读验证。' }, finishReason: 'stop', diagnostics: [] });
        },
        async *stream() {
          providerCalls += 1;
          if (providerCalls <= calls.length) {
            yield { type: 'usage', ...fixtureUsage({ role: 'assistant', content: '', toolCalls: [calls[providerCalls - 1]!] }) };
            yield { type: 'tool-call', toolCall: calls[providerCalls - 1]! };
            yield { type: 'message-stop', finishReason: 'tool_use' };
            return;
          }
          yield { type: 'usage', ...fixtureUsage({ role: 'assistant', content: '本次修改完成并回读验证。' }) };
          yield { type: 'text-delta', text: '本次修改完成并回读验证。' };
          yield { type: 'message-stop', finishReason: 'stop' };
        },
        async listModels() { return { ok: true, models: [] }; }
      };
      const result = await runAgentToolLoop(adapter, {
        config: {
          id: 'bridge-loop-sticky-fixture', displayName: 'bridge loop sticky fixture',
          protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9',
          model: 'fixture', hasCredential: false,
          createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
        },
        apiKey: 'fixture-bridge-loop-credential',
        messages: [{ role: 'user', content: '修改并验证这个资源' }],
        taskQuery: '修改并验证这个资源',
        permissionMode: 'normal',
        tools: bridge.tools,
        executeTool: bridge.executeTool,
        maxSteps: 5,
        requestApproval: async () => ({ decision: 'once' }),
        streaming,
        onEvent: (event) => { events.push(event); },
        rollout: {
          enqueue(item) { rollout.push(item); },
          async flush() {}
        }
      });
      const label = `bridge-loop ${refreshCase.name}, streaming=${streaming}`;
      assert.equal(providerCalls, 3, `${label}: provider calls`);
      assert.equal(result.finishReason, refreshCase.partial ? 'partial' : 'stop', label);
      assert.equal(
        result.diagnostics.some((item) => item.code === 'AGENT_KNOWLEDGE_REFRESH_DEGRADED'),
        refreshCase.partial,
        label
      );
      const sessionEnd = events.find((event) => event.type === 'turn-complete');
      assert.ok(sessionEnd?.type === 'turn-complete', label);
      assert.equal(sessionEnd.finishReason, result.finishReason, label);
      assert.equal(result.audit.approvals?.[0]?.decision, 'once', `${label}: mutation approval`);
      const committedMessage = result.messages.find((message) => message.role === 'tool' && message.name === 'write_oversized_fixture');
      assert.ok(committedMessage, `${label}: committed result remains present`);
      const committed = JSON.parse(committedMessage.content);
      assert.equal(committed.state, 'committed', `${label}: bounded bridge retains transaction state`);
      assert.ok(committedMessage.content.includes('bridge-loop-committed-op'), `${label}: operation identity`);
      assert.equal(agentDeltaText(events), '本次修改完成并回读验证。', `${label}: actual model text reaches the event boundary exactly once`);
      const reloaded = parseRolloutLines(rollout.map((item) => JSON.stringify(item)));
      assert.equal(reloaded.messages.filter((message) => message.content === '本次修改完成并回读验证。').length, 1, `${label}: model text remains durable`);
      assert.equal(reloaded.terminal?.finishReason, result.finishReason, `${label}: durable finish`);
      assert.equal(reloaded.terminal?.taskStatus, refreshCase.partial ? 'partial' : 'completed', `${label}: compatibility resource status`);
      taskVerdicts.push({ scenario: label, engineFinish: result.finishReason, task: refreshCase.partial ? 'resource_partial' : 'unverified', basis: refreshCase.partial ? 'Committed operation retains its failed-refresh metadata after bounding and a later read.' : 'Healthy refresh metadata does not by itself establish independent native mutation proof.' });
    }
  }

  // A non-cooperative provider must not keep the host session pending after
  // ai.agent.cancel aborts the run. The underlying promise is intentionally
  // never resolved; the loop-owned cancellation race must still emit a
  // cancelled terminal result.
  {
    const controller = new AbortController();
    const never = new Promise<never>(() => {});
    const adapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      complete: async () => await never,
      async *stream() {},
      async listModels() { return { ok: true, models: [] }; }
    };
    const runPromise = runAgentToolLoop(adapter, {
      config: {
        id: 'non-cooperative-cancellation-fixture', displayName: 'cancellation fixture',
        protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9',
        model: 'fixture', hasCredential: false,
        createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
      },
      apiKey: 'fixture-cancellation-credential',
      messages: [{ role: 'user', content: 'cancel this run' }],
      taskQuery: 'cancel this run',
      permissionMode: 'normal',
      tools: [],
      executeTool: async () => ({ ok: true, content: '{}' }),
      signal: controller.signal
    });
    const timer = setTimeout(() => controller.abort(), 10);
    const result = await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cancellation race hung')), 1_000))
    ]);
    clearTimeout(timer);
    assert.equal(result.finishReason, 'cancelled');
    assert.equal(result.audit.toolCalls.length, 0);
  }
  console.log(JSON.stringify({ statusCases: cases.length * 2, taskVerdicts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentTaskStatusSmoke().then(() => {
    console.log('Agent task status smoke passed.');
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
