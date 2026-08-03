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
 */

import type { ToolCall, ToolDefinition as AgentToolDefinition } from '../model-services/types.js';
import type { ToolContext, ToolRegistry } from './toolRegistry.js';

export interface AgentToolBridgeOptions {
  registry: ToolRegistry;
  context: ToolContext;
}

export interface AgentToolBridge {
  tools: AgentToolDefinition[];
  executeTool: (call: ToolCall) => Promise<{ ok: boolean; content: string; code?: string }>;
}

const PARALLEL_SAFE_LEVELS = new Set(['read', 'analyze']);

export function createAgentToolBridge(options: AgentToolBridgeOptions): AgentToolBridge {
  const { registry, context } = options;
  const tools: AgentToolDefinition[] = registry.list().map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    parametersJsonSchema: { type: 'object' },
    supportsParallel: PARALLEL_SAFE_LEVELS.has(descriptor.permissionLevel ?? 'read')
  }));

  const executeTool = async (
    call: ToolCall
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
    const result = await registry.run(call.name, input, context);
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
