/** Current-task status must agree across run results, lifecycle events and rollout. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { ToolRegistry } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import { parseRolloutLines } from '../model-services/rolloutRecorder.js';
import type {
  AgentEvent, AgentPermissionMode, ChatMessage, ModelServiceAdapter, RolloutItem, ToolCall
} from '../model-services/types.js';

const hostNoticeMarker = '【系统执行核验｜host=';

function agentDeltaText(events: readonly AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'agent-message-delta' }> => (
      event.type === 'agent-message-delta'
    ))
    .map((event) => event.text)
    .join('');
}

function countTextMarker(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function assistantContents(messages: readonly ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content);
}

interface StatusCase {
  name: string;
  text: string;
  partial: boolean;
  query?: string;
  mode?: AgentPermissionMode;
}

const cases: StatusCase[] = [
  { name: 'historical no-write report', text: '已完成定位与原生确认，本次未做任何写入。', partial: true },
  { name: 'historical staging failure', text: '## 执行结果：未能写入（环境阻断，非方案错误）', partial: true },
  { name: 'explicit incomplete task', text: '本次任务未完成，仍缺少原生写入证据。', partial: true },
  { name: 'blocked handoff is terminal', text: '当前任务被阻塞，无法继续执行。下一步需要补齐语料。', partial: true },
  { name: 'partial status', text: '**状态：partial**，血条修改已完成，掉落尚未完成。', partial: true },
  { name: 'bare blocked status', text: 'BLOCKED：未取得当前原生证据。', partial: true },
  { name: 'English current status', text: 'This task is incomplete.', partial: true },
  { name: 'partial read-only task', query: '只读分析这份事件', mode: 'plan', text: '本次任务未完成，缺少所需文件。', partial: true },
  { name: 'successful modification', text: '本次修改完成，写入已提交并回读验证。', partial: false },
  { name: 'read-only analysis in normal mode', query: '只读分析事件，不要修改', text: '分析完成，本次未做任何写入。', partial: false },
  { name: 'diagnosis only', query: '仅排查写回失败原因，无需修复', text: '原因已确认，本次未写入。', partial: false },
  { name: 'analysis mentioning modification', query: '分析上次修改为什么失败', text: '原因已确认，本次未写入。', partial: false },
  { name: 'analysis and implementation', query: '请分析并修复写回问题', text: '本次未写入。', partial: true },
  { name: 'plan does not require writes', mode: 'plan', text: '规划完成，本次未做任何写入。', partial: false },
  { name: 'no declared mutation objective', query: '检查现有数值', text: '检查完成，本次未做任何写入。', partial: false },
  { name: 'error-code explanation', query: '解释错误码', text: '错误码 partial 表示任务部分完成。', partial: false },
  { name: 'explanation in edit task', text: '错误码说明：本次任务未完成是旧提示，本次修复已经验证通过。', partial: false },
  { name: 'historical failure', text: '历史报告记录：本次未做任何写入。\n本次修改已完成并回读验证。', partial: false },
  { name: 'quoted old status', text: '旧报告写着“本次任务未完成”。\n本次修复已通过。', partial: false },
  { name: 'inline quoted old failure', text: "返回里曾有'本次未写入'提示，本次已修复。", partial: false },
  { name: 'inline code sample', text: '返回文案样例是 `本次未写入`，本次已修复。', partial: false },
  { name: 'blockquote', text: '> 当前任务：blocked\n\n以上为旧报告，本次已完成。', partial: false },
  { name: 'code sample', text: '```text\n当前任务未完成\n```\n代码示例已整理完成。', partial: false },
  { name: 'conditional failure', text: '如果本次未写入，就应标记 partial；本次已经写入并验证。', partial: false },
  { name: 'status term explanation', text: 'partial 的含义是部分完成。本次修复通过。', partial: false },
  { name: 'label explanation', text: '状态：partial 表示部分完成，本次已经修复。', partial: false },
  { name: 'subtask status is not overall status', text: '历史迁移任务未完成不影响本次请求。本次修改已完成。', partial: false }
];

export async function runAgentTaskStatusSmoke(): Promise<void> {
  for (const streaming of [false, true]) {
    for (const scenario of cases) {
      const events: AgentEvent[] = [];
      const rollout: RolloutItem[] = [];
      let calls = 0;
      const adapter: ModelServiceAdapter = {
        protocol: 'openai-compatible',
        async complete() {
          calls += 1;
          return { message: { role: 'assistant', content: scenario.text }, finishReason: 'stop', diagnostics: [] };
        },
        async *stream() {
          calls += 1;
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
      assert.equal(result.finishReason, scenario.partial ? 'partial' : 'stop', label);
      const providerEnd = events.find((event) => event.type === 'step-complete');
      assert.ok(providerEnd?.type === 'step-complete', label);
      assert.equal(providerEnd.finishReason, 'stop', `${label}: retain provider outcome`);
      const sessionEnd = events.find((event) => event.type === 'turn-complete');
      assert.ok(sessionEnd?.type === 'turn-complete', label);
      assert.equal(sessionEnd.finishReason, result.finishReason, label);
      const durableEnd = rollout.find((item) => item.type === 'turn-complete');
      assert.ok(durableEnd?.type === 'turn-complete', label);
      assert.equal(durableEnd.finishReason, result.finishReason, label);
      assert.equal(durableEnd.taskStatus, scenario.partial ? 'partial' : 'completed', label);
      assert.equal(result.diagnostics.some((item) => item.code === 'AGENT_REPORTED_TASK_PARTIAL'), scenario.partial, label);
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
          return {
            message: { role: 'assistant', content: '', toolCalls: [calls[providerCalls - 1]!] },
            finishReason: 'tool_use',
            diagnostics: []
          };
        }
        return {
          message: { role: 'assistant', content: '本次修改完成并回读验证。' },
          finishReason: 'stop',
          diagnostics: []
        };
      },
      async *stream() {
        providerCalls += 1;
        if (providerCalls <= calls.length) {
          yield { type: 'tool-call', toolCall: calls[providerCalls - 1]! };
          yield { type: 'message-stop', finishReason: 'tool_use' };
          return;
        }
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
        { name: 'write_fixture', description: 'fixture write', parametersJsonSchema: {}, permissionLevel: 'read' },
        { name: 'read_fixture', description: 'fixture read', parametersJsonSchema: {}, permissionLevel: 'read' }
      ],
      executeTool: async (call) => call.name === 'write_fixture'
        ? {
            ok: true,
            content: JSON.stringify({
              ok: true,
              state: 'committed',
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
      streaming,
      onEvent: (event) => { events.push(event); },
      rollout: {
        enqueue(item) { rollout.push(item); },
        async flush() {}
      }
    });
    assert.equal(providerCalls, 3, `sticky refresh, streaming=${streaming}: provider calls`);
    assert.equal(result.finishReason, 'partial', `sticky refresh, streaming=${streaming}`);
    assert.ok(result.diagnostics.some((item) => item.code === 'AGENT_KNOWLEDGE_REFRESH_DEGRADED_STICKY'));
    assert.equal(
      countTextMarker(agentDeltaText(events), `${hostNoticeMarker}partial】`),
      1,
      `sticky refresh, streaming=${streaming}: UI host notice`
    );
    const stickyUiText = agentDeltaText(events);
    assert.equal(
      countTextMarker(stickyUiText, '本次修改完成并回读验证。'),
      1,
      `sticky refresh, streaming=${streaming}: UI model text`
    );
    assert.ok(
      stickyUiText.indexOf('本次修改完成并回读验证。') < stickyUiText.indexOf(`${hostNoticeMarker}partial】`),
      `sticky refresh, streaming=${streaming}: host notice follows model text`
    );
    const resultAssistants = assistantContents(result.messages);
    assert.equal(
      resultAssistants.filter((text) => text.includes(`${hostNoticeMarker}partial】`)).length,
      1,
      `sticky refresh, streaming=${streaming}: result host notice`
    );
    assert.equal(
      resultAssistants.filter((text) => text === '本次修改完成并回读验证。').length,
      1,
      `sticky refresh, streaming=${streaming}: model text preserved`
    );
    assert.match(
      resultAssistants.find((text) => text.includes(`${hostNoticeMarker}partial】`)) ?? '',
      /知识刷新状态为 failed/,
      `sticky refresh, streaming=${streaming}: refresh detail`
    );
    const reloaded = parseRolloutLines(rollout.map((item) => JSON.stringify(item)));
    assert.equal(
      reloaded.messages.filter((message) => message.content.includes(`${hostNoticeMarker}partial】`)).length,
      1,
      `sticky refresh, streaming=${streaming}: rollout reload host notice`
    );
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
      const adapter: ModelServiceAdapter = {
        protocol: 'openai-compatible',
        async complete() {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              message: { role: 'assistant', content: '', toolCalls: [calls[0]!] },
              finishReason: 'tool_use' as const,
              diagnostics: [],
              ...(terminalCase === 'length' ? { usage: { outputTokens: 1 } } : {})
            };
          }
          if (providerCalls === 2) {
            return {
              message: { role: 'assistant', content: '', toolCalls: [calls[1]!] },
              finishReason: 'tool_use' as const,
              diagnostics: []
            };
          }
          return {
            message: { role: 'assistant', content: '' },
            finishReason: 'error' as const,
            diagnostics: [{ severity: 'error' as const, code: 'MODEL_SERVICE_HTTP_ERROR', message: 'fixture terminal error' }]
          };
        },
        async *stream() {
          providerCalls += 1;
          if (providerCalls === 1) {
            if (terminalCase === 'length') yield { type: 'usage', outputTokens: 1 };
            yield { type: 'tool-call', toolCall: calls[0]! };
            yield { type: 'message-stop', finishReason: 'tool_use' };
            return;
          }
          if (providerCalls === 2) {
            yield { type: 'tool-call', toolCall: calls[1]! };
            yield { type: 'message-stop', finishReason: 'tool_use' };
            return;
          }
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
          { name: 'write_fixture', description: 'fixture write', parametersJsonSchema: {}, permissionLevel: 'read' },
          { name: 'read_fixture', description: 'fixture read', parametersJsonSchema: {}, permissionLevel: 'read' }
        ],
        executeTool: async (call) => {
          if (call.name === 'write_fixture') {
            return {
              ok: true,
              content: JSON.stringify({
                ok: true,
                state: 'committed',
                data: { record: { lifecycle: { transaction: 'committed', knowledgeRefresh: 'failed' } } }
              })
            };
          }
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
        ...(terminalCase === 'length' ? { maxTotalOutputTokens: 1 } : {}),
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
          : 1;
      assert.equal(providerCalls, expectedProviderCalls, `${label}: provider calls`);
      assert.equal(result.finishReason, terminalCase, `${label}: actual finishReason`);
      assert.equal(
        countTextMarker(agentDeltaText(events), `${hostNoticeMarker}${terminalCase}】`),
        1,
        `${label}: UI host notice`
      );
      const resultAssistants = assistantContents(result.messages);
      assert.equal(
        resultAssistants.filter((text) => text.includes(`${hostNoticeMarker}${terminalCase}】`)).length,
        1,
        `${label}: result host notice`
      );
      assert.match(
        resultAssistants.find((text) => text.includes(`${hostNoticeMarker}${terminalCase}】`)) ?? '',
        /后续读取成功不改变本次刷新失败/,
        `${label}: refresh detail`
      );
      const reloaded = parseRolloutLines(rollout.map((item) => JSON.stringify(item)));
      assert.equal(
        reloaded.messages.filter((message) => message.content.includes(`${hostNoticeMarker}${terminalCase}】`)).length,
        1,
        `${label}: rollout reload host notice`
      );
      assert.equal(reloaded.terminal?.finishReason, terminalCase, `${label}: rollout finishReason`);
      assert.equal(reloaded.terminal?.taskStatus, expectedTaskStatus, `${label}: rollout taskStatus`);
      const sessionEnd = events.find((event) => event.type === 'turn-complete');
      assert.ok(sessionEnd?.type === 'turn-complete', label);
      assert.equal(sessionEnd.finishReason, terminalCase, `${label}: session finishReason`);
    }
  }

  // A previous turn's assistant answer must not suppress the current turn's
  // no-model-text terminal summary.  This also proves the synthetic summary
  // reaches the live UI exactly once, not only durable rollout storage.
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
        return { message: { role: 'assistant', content: 'must not be called' }, finishReason: 'stop', diagnostics: [] };
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
    assert.equal(
      countTextMarker(agentDeltaText(events), '【系统收口摘要-cancelled】'),
      1,
      `${label}: UI summary`
    );
    assert.equal(
      result.messages.filter((message) => message.content.includes('【系统收口摘要-cancelled】')).length,
      1,
      `${label}: result summary`
    );
    const reloaded = parseRolloutLines(rollout.map((item) => JSON.stringify(item)));
    assert.equal(
      reloaded.messages.filter((message) => message.content.includes('【系统收口摘要-cancelled】')).length,
      1,
      `${label}: rollout reload summary`
    );
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
        name: 'write_oversized_fixture', description: 'fixture committed write', permission: 'read',
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
        name: 'read_oversized_fixture', description: 'fixture ordinary read', permission: 'read',
        run: () => ({
          ok: true,
          state: 'completed' as const,
          data: { sourceUri: 'workspace://mods/NpcParam.parambnd.dcx' }
        })
      });
      const bridge = createAgentToolBridge({
        registry,
        context: { workspaceIndex: new WorkspaceIndex('bridge-loop-sticky-fixture'), mode: 'plan' }
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
            return {
              message: { role: 'assistant', content: '', toolCalls: [calls[providerCalls - 1]!] },
              finishReason: 'tool_use', diagnostics: []
            };
          }
          return { message: { role: 'assistant', content: '本次修改完成并回读验证。' }, finishReason: 'stop', diagnostics: [] };
        },
        async *stream() {
          providerCalls += 1;
          if (providerCalls <= calls.length) {
            yield { type: 'tool-call', toolCall: calls[providerCalls - 1]! };
            yield { type: 'message-stop', finishReason: 'tool_use' };
            return;
          }
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
        result.diagnostics.some((item) => item.code === 'AGENT_KNOWLEDGE_REFRESH_DEGRADED_STICKY'),
        refreshCase.partial,
        label
      );
      const sessionEnd = events.find((event) => event.type === 'turn-complete');
      assert.ok(sessionEnd?.type === 'turn-complete', label);
      assert.equal(sessionEnd.finishReason, result.finishReason, label);
      const expectedHostNoticeCount = refreshCase.partial ? 1 : 0;
      assert.equal(
        countTextMarker(agentDeltaText(events), hostNoticeMarker),
        expectedHostNoticeCount,
        `${label}: UI host notice count`
      );
      assert.equal(
        assistantContents(result.messages).filter((text) => text.includes(hostNoticeMarker)).length,
        expectedHostNoticeCount,
        `${label}: result host notice count`
      );
      const reloaded = parseRolloutLines(rollout.map((item) => JSON.stringify(item)));
      assert.equal(
        reloaded.messages.filter((message) => message.content.includes(hostNoticeMarker)).length,
        expectedHostNoticeCount,
        `${label}: rollout reload host notice count`
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentTaskStatusSmoke().then(() => {
    console.log('Agent task status smoke passed.');
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
