/**
 * Dual-provider agent tool loop with permission isolation and audit redaction.
 * Full permission cannot bypass Patch Engine — tools still go through executeTool policy.
 */

import type { ModelServiceAdapter } from './types.js';
import type {
  AgentRunRequest,
  AgentRunResult,
  ChatMessage,
  ToolCall
} from './types.js';

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /x-api-key["']?\s*[:=]\s*["'][^"']+["']/gi,
  /api[_-]?key["']?\s*[:=]\s*["'][^"']+["']/gi
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
  if (/sk-[a-zA-Z0-9_-]{20,}/.test(serialized)) {
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
      'list_diagnostics'
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
  let steps = 0;
  let finishReason = 'stop';

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
    const completion = await adapter.complete({
      messages,
      tools: request.tools,
      ...(request.signal ? { signal: request.signal } : {})
    });
    diagnostics.push(...completion.diagnostics);
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
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: redactSecrets(result.content)
      });
    }
    finishReason = 'tool_use';
  }

  const audit: AgentRunResult['audit'] = {
    configId: request.config.id,
    protocol: request.config.protocol,
    permissionMode: request.permissionMode,
    toolCalls: toolAudit,
    redacted: true
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
