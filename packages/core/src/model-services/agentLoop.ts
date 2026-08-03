/**
 * Dual-provider agent tool loop with permission isolation and audit redaction.
 * Full permission cannot bypass Patch Engine — tools still go through executeTool policy.
 */

import type { ModelServiceAdapter } from './types.js';
import type {
  AgentRunRequest,
  AgentRunResult,
  ChatMessage,
  ContextEvidenceSource,
  ToolCall
} from './types.js';

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._\-]+/gi,
  // Header inline secrets may appear quoted or bare; the value token class keeps
  // the match anchored to the header keyword so prose cannot false-positive.
  /x-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]+["']?/gi,
  /api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]+["']?/gi
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function assertNoSecretLeak(payload: unknown, apiKey: string): void {
  const serialized = JSON.stringify(payload);
  if (apiKey && serialized.includes(apiKey)) {
    throw new Error('MODEL_SERVICE_SECRET_LEAK: audit or DTO payload contains raw API key.');
  }
  // Any remaining secret-shaped text (sk- token, Bearer token, x-api-key: /
  // api_key: inline value) is rejected via the same redaction patterns.
  if (redactSecrets(serialized) !== serialized) {
    throw new Error('MODEL_SERVICE_SECRET_LEAK: payload appears to contain an API key pattern.');
  }
}

/**
 * Plan mode: only allow tools that are explicitly read/analysis.
 * Full mode still cannot invent elevated tools outside the registry passed in.
 */
export function isToolAllowedInMode(
  toolName: string,
  mode: AgentRunRequest['permissionMode'],
  registeredTools: Set<string>
): { ok: true } | { ok: false; code: string; message: string } {
  if (!registeredTools.has(toolName)) {
    return {
      ok: false,
      code: 'AGENT_TOOL_NOT_REGISTERED',
      message: `工具 ${toolName} 未在注册表中。`
    };
  }
  if (mode === 'plan') {
    const planAllow = new Set([
      'read_resource',
      'search_workspace',
      'build_patch_graph',
      'assess_edit_risk',
      'list_diagnostics',
      // Scaffold typed registry read tools — plan mode stays strictly read-only.
      'workspace.stats',
      'resource.graph.query',
      'workspace.readFile'
    ]);
    if (!planAllow.has(toolName)) {
      return {
        ok: false,
        code: 'AGENT_TOOL_DENIED_PLAN_MODE',
        message: `计划模式不允许执行工具 ${toolName}。`
      };
    }
  }
  return { ok: true };
}

export async function runAgentToolLoop(
  adapter: ModelServiceAdapter,
  request: AgentRunRequest
): Promise<AgentRunResult> {
  const maxSteps = request.maxSteps ?? 8;
  const messages: ChatMessage[] = [...request.messages];
  const diagnostics: AgentRunResult['diagnostics'] = [];
  const toolAudit: AgentRunResult['audit']['toolCalls'] = [];
  const registered = new Set(request.tools.map((tool) => tool.name));
  const broker = request.contextBroker;
  const brokerOptions = request.contextBrokerOptions;
  const contextAssemblies: NonNullable<AgentRunResult['audit']['contextAssemblies']> = [];
  const evidenceQueue: ContextEvidenceSource[] = [];
  let steps = 0;
  let finishReason = 'stop';
  let totalOutputTokens = 0;

  while (steps < maxSteps) {
    if (request.signal?.aborted) {
      finishReason = 'cancelled';
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_CANCELLED',
        message: 'Agent 循环已取消。'
      });
      break;
    }
    steps += 1;

    // Context Broker: assemble accumulated workspace evidence into a bounded,
    // redacted fragment injected before the model call. No evidence is
    // surfaced structurally as insufficient_evidence instead of failing silently.
    if (broker) {
      const assembled = await broker.assemble(evidenceQueue, brokerOptions);
      if (assembled.ok) {
        messages.push({ role: 'system', content: assembled.context });
        diagnostics.push({
          severity: 'info',
          code: 'CONTEXT_BROKER_ASSEMBLED',
          message: `已装配 ${assembled.sections.length} 段工作区证据（${assembled.totalBytes} bytes）。`
        });
        contextAssemblies.push({
          ok: true,
          sections: assembled.sections.length,
          totalBytes: assembled.totalBytes
        });
      } else {
        diagnostics.push(...assembled.diagnostics);
        contextAssemblies.push({
          ok: false,
          sections: 0,
          totalBytes: 0,
          ...(assembled.code ? { code: assembled.code } : {})
        });
        if (assembled.code === 'insufficient_evidence') {
          messages.push({
            role: 'system',
            content: JSON.stringify({
              ok: false,
              code: 'insufficient_evidence',
              message: assembled.message
            })
          });
        }
      }
    }

    const completion = await adapter.complete({
      messages,
      tools: request.tools,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {})
    });
    // An active cancellation landing mid-request surfaces as 'cancelled' rather
    // than being collapsed into the adapter's timeout/error finish reason.
    if (request.signal?.aborted) {
      finishReason = 'cancelled';
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_CANCELLED',
        message: 'Agent 循环在模型调用期间取消。'
      });
      break;
    }
    diagnostics.push(...completion.diagnostics);
    if (completion.usage?.outputTokens) {
      totalOutputTokens += completion.usage.outputTokens;
    }
    if (request.maxTotalOutputTokens != null && totalOutputTokens > request.maxTotalOutputTokens) {
      finishReason = 'length';
      diagnostics.push({
        severity: 'warning',
        code: 'MODEL_SERVICE_OUTPUT_BUDGET_EXCEEDED',
        message: `累计输出 token ${totalOutputTokens} 超过预算 ${request.maxTotalOutputTokens}。`
      });
      break;
    }
    if (completion.finishReason === 'error') {
      finishReason = 'error';
      break;
    }
    messages.push(completion.message);
    const toolCalls = completion.message.toolCalls ?? [];
    if (toolCalls.length === 0 || completion.finishReason === 'stop') {
      finishReason = completion.finishReason;
      break;
    }
    for (const call of toolCalls) {
      const allowed = isToolAllowedInMode(call.name, request.permissionMode, registered);
      if (!allowed.ok) {
        toolAudit.push({ name: call.name, ok: false, code: allowed.code });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify({
            ok: false,
            code: allowed.code,
            message: allowed.message
          })
        });
        continue;
      }
      // Evidence gate: empty arguments with no prior context → insufficient_evidence.
      if (!call.argumentsJson || call.argumentsJson.trim() === '' || call.argumentsJson === '{}') {
        toolAudit.push({ name: call.name, ok: false, code: 'insufficient_evidence' });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify({
            ok: false,
            code: 'insufficient_evidence',
            message: '证据不足，拒绝执行工具。'
          })
        });
        continue;
      }
      const result = await request.executeTool(call);
      toolAudit.push({
        name: call.name,
        ok: result.ok,
        ...(result.code ? { code: result.code } : {})
      });
      const redactedContent = redactSecrets(result.content);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: redactedContent
      });
      // Feed executed tool results into the broker evidence queue for the next
      // model call. Only redacted text and the tool name metadata are retained.
      if (broker) {
        evidenceQueue.push({
          kind: 'toolResult',
          uri: call.name,
          text: redactedContent
        });
      }
      if (request.signal?.aborted) {
        finishReason = 'cancelled';
        diagnostics.push({
          severity: 'warning',
          code: 'AGENT_CANCELLED',
          message: 'Agent 循环在工具执行后取消。'
        });
        break;
      }
    }
    if (finishReason === 'cancelled') {
      break;
    }
    finishReason = 'tool_use';
  }

  const audit: AgentRunResult['audit'] = {
    configId: request.config.id,
    protocol: request.config.protocol,
    permissionMode: request.permissionMode,
    toolCalls: toolAudit,
    redacted: true,
    ...(contextAssemblies.length ? { contextAssemblies } : {})
  };
  assertNoSecretLeak({ messages, audit, diagnostics }, request.apiKey);

  return {
    messages: messages.map((message) => ({
      ...message,
      content: redactSecrets(message.content),
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call: ToolCall) => ({
              ...call,
              argumentsJson: redactSecrets(call.argumentsJson)
            }))
          }
        : {})
    })),
    steps,
    finishReason,
    diagnostics,
    audit
  };
}
