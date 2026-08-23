/**
 * Production bridge: workspace-aware ToolRegistry -> agent loop contract.
 *
 * The agent loop (model-services) speaks {name, description,
 * parametersJsonSchema, supportsParallel} tool definitions plus a flat
 * executeTool callback. The production registry (ai/toolRegistry.ts) speaks
 * permission-gated typed ToolResults bound to a WorkspaceIndex. This module
 * adapts one to the other without duplicating policy: permission gating stays
 * in ToolRegistry.run, loop-level mode gating stays in agentLoop.
 *
 * Parallelism policy (Codex supports_parallel_tool_calls analogue): pure
 * read/analyze tools may run concurrently within one model turn; anything
 * that proposes, validates or rolls back stays exclusive. Results are
 * recorded in model emission order by the loop itself.
 *
 * Schema policy: each tool's model-facing parametersJsonSchema is *projected*
 * from the same ToolInputShape that ToolRegistry.run enforces at runtime
 * (toolInputShapeToJsonSchema). Before this, every tool advertised a bare
 * `{ type: 'object' }`, which told the model nothing about field names —
 * the model had to guess `q` vs `query`, `id` vs `textId`, and a wrong guess
 * came back as INVALID_INPUT with no way for the model to know the real name.
 * That was the root cause of unreliable tool calling, and it is exactly the
 * failure a projection cannot reintroduce: rename a field in the shape and
 * the advertised schema follows.
 */

import type { ToolCall, ToolDefinition as AgentToolDefinition } from '../model-services/types.js';
import { toolInputShapeToJsonSchema, type ToolContext, type ToolRegistry } from './toolRegistry.js';

export interface AgentToolBridgeOptions {
  registry: ToolRegistry;
  context: ToolContext;
}

export interface AgentToolBridge {
  tools: AgentToolDefinition[];
  /**
   * 执行一次工具调用。`contextOverride` 由宿主（main）在需要注入生产上下文的
   * 调用（如回滚：session / 生产 store / 备份目录 / 用户确认凭据）时提供，
   * 与桥闭包里的基础 context 浅合并；纯读工具调用不传即行为不变。
   */
  executeTool: (
    call: ToolCall,
    contextOverride?: Partial<ToolContext>
  ) => Promise<{ ok: boolean; content: string; code?: string }>;
}

const PARALLEL_SAFE_LEVELS = new Set(['read', 'analyze']);

export function createAgentToolBridge(options: AgentToolBridgeOptions): AgentToolBridge {
  const { registry, context } = options;
  const tools: AgentToolDefinition[] = registry.list().map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    parametersJsonSchema: toolInputShapeToJsonSchema(descriptor.inputSchema),
    // Carried through so the loop's approval gate can group by severity from
    // the registry's own declaration instead of guessing from the name.
    permissionLevel: descriptor.permissionLevel ?? 'read',
    supportsParallel: PARALLEL_SAFE_LEVELS.has(descriptor.permissionLevel ?? 'read')
  }));

  const executeTool = async (
    call: ToolCall,
    contextOverride?: Partial<ToolContext>
  ): Promise<{ ok: boolean; content: string; code?: string }> => {
    let input: unknown = {};
    try {
      input = call.argumentsJson.trim() === '' ? {} : JSON.parse(call.argumentsJson);
    } catch {
      return {
        ok: false,
        code: 'TOOL_INPUT_INVALID',
        content: JSON.stringify({
          ok: false,
          error: { code: 'TOOL_INPUT_INVALID', message: '工具参数不是有效 JSON。' }
        })
      };
    }
    const effectiveContext: ToolContext = { ...context, ...contextOverride };
    const result = await registry.run(call.name, input, effectiveContext);
    if (effectiveContext.mode && effectiveContext.mode !== context.mode) {
      context.mode = effectiveContext.mode;
    }
    if (result.ok) {
      return { ok: true, content: JSON.stringify(result.data ?? null) };
    }
    return {
      ok: false,
      code: result.error?.code ?? 'TOOL_FAILED',
      content: JSON.stringify(result.error ?? { code: 'TOOL_FAILED', message: '工具执行失败。' })
    };
  };

  return { tools, executeTool };
}
