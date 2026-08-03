/**
 * Smoke: AI dual-protocol error/cancel/timeout/limit conformance matrix
 * + W-AI-CONFORMANCE-03 real-workspace typed mutation write matrix.
 *
 * Base 10 cases:
 * - HTTP 429 rate limit with Retry-After
 * - HTTP 500 server error
 * - HTTP 401 auth error
 * - Network failure (fetch throws)
 * - Malformed JSON response body
 * - Request timeout (AbortSignal.timeout)
 * - Cancellation via AbortController
 * - Output token budget exceeded
 * - Multi-step tool loop error propagation
 *
 * Write matrix cases (11-20): agent loop drives the scaffold typed tool
 * registry against a real temp workspace via a scripted local contract server:
 * - success propose → stage → validate → commit → re-read
 * - normal mode commit requires confirmation before it proceeds
 * - plan mode is strictly read-only at the loop level
 * - validation failure blocks commit and refuses rollback structurally
 * - stale revision conflict is rejected as ORIGINAL_CHANGED_DURING_STAGING
 * - cancellation on the write path never commits
 * - output token budget stops the write path before commit
 * - timeout on the write path never executes tools
 * - full permission still passes the evidence gate and surfaces
 *   PATCH_ENGINE_REQUIRED refusals instead of bypassing executeTool
 * - policy gate unit matrix (deny / require_confirmation / receipt / full)
 *
 * Context Broker cases (21-28): evidence/context assembly layer + production
 * multi-step loop closure:
 * - four evidence kinds (readFile / resourceGraph / diagnostics / patchPlan)
 *   assemble into bounded, redacted context with excerpt truncation
 * - no evidence returns structured insufficient_evidence
 * - a single oversized section fails closed with CONTEXT_LIMIT_EXCEEDED
 * - cancellation / timeout interrupt pending async evidence reads
 * - production multi-step propose→stage→validate→commit→re-read loop with the
 *   broker injecting cross-step evidence before each model call
 * - cancellation leaves no residue and no commit audit trail
 * - full permission still cannot bypass Patch Engine; the refusal is assembled
 *   into evidence context and surfaced in the audit
 * - policy gate full matrix (every permission × plan/normal/full + receipt)
 *
 * W-AI-CONFORMANCE-03 additions (29-41):
 * - Anthropic error matrix closure: HTTP 500 / network / malformed JSON /
 *   timeout / active cancellation are verified with the Anthropic request
 *   shape (x-api-key header, /v1/messages), not just the OpenAI side
 * - MODEL_SERVICE_CANCELLED: active caller abort no longer collapses into
 *   MODEL_SERVICE_TIMEOUT (case 7 + cases 33)
 * - stream cancellation → 'cancelled' and stream timeout →
 *   MODEL_SERVICE_TIMEOUT error event for BOTH protocols
 * - Anthropic real SSE happy path: text deltas, tool args accumulated across
 *   input_json_delta chunks, usage, tool_use finish
 * - Anthropic stream HTTP 500 + SSE `error` event classification
 * - redaction matrix: sk- / Bearer / x-api-key / api_key forms are redacted and
 *   rejected by assertNoSecretLeak via the shared patterns
 *
 * Codex-derived kernel additions (42-53), design reference openai/codex
 * (Apache-2.0, see licenses/openai-codex.txt):
 * - retry policy: exponential backoff math, jitter bounds, Retry-After
 *   precedence, delay cap, attempt cap, retryable whitelist, decideRetry
 * - loop retry: two 500s then success (3 hits, 2 audit retries, retry
 *   events); non-retryable 401 fails fast with exactly 1 hit
 * - parallel tool calls: supportsParallel tools overlap at runtime while
 *   results are recorded in model emission order; exclusive tools stay serial
 * - streaming path: SSE text deltas surface as agent-message-delta events and
 *   assemble into the final message; SSE tool_calls drive one tool step;
 *   a failed first stream attempt is retried at the stream budget
 * - rollout: recorder flush → parse roundtrip with meta + messages, corrupt
 *   line tolerance, recorder-level secret redaction, marker-based rollback
 *   truncation without rewriting durable lines
 * - compaction: auto trigger replaces history (system + recent user messages
 *   + prefixed summary) with an audit entry and rollout checkpoint; a failing
 *   summary request fails closed and keeps the original history
 *
 * Production wiring additions (54-58):
 * - agentToolBridge maps the workspace ToolRegistry to the agent loop
 *   contract (parallel policy for read/analyze, typed error mapping,
 *   structured invalid-JSON refusal)
 * - ToolRegistry input shape validation matrix (required/optional/types,
 *   undeclared extras ignored, non-object refusal)
 * - FileRolloutStorage append-only roundtrip + sessions/YYYY/MM/DD layout
 * - runAgentSession end-to-end with rollout persistence, listing, loading
 *   and resume seeding the follow-up run
 * - session cancellation leaves a durable interrupted marker
 *
 * All cases use local fake HTTP servers or injected fetch failures.
 * No real provider credentials or network access required.
 *
 * Authority cap: partial; offline conformance does not prove third-party
 * service availability or native mutation authority.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypedToolResult } from '@soulforge/shared';
import {
  ScaffoldToolRegistry,
  createScaffoldToolRegistry,
  type ScaffoldToolContext
} from '../ai-tools/scaffoldToolRegistry.js';
import { evaluatePolicyGate, maxPermissionFromMode } from '../ai-tools/policyGate.js';
import { MemoryAuditLogStore } from '../audit-log/memoryAuditLog.js';
import {
  OpenAiCompatibleAdapter
} from '../model-services/openaiCompatibleAdapter.js';
import {
  AnthropicCompatibleAdapter
} from '../model-services/anthropicCompatibleAdapter.js';
import { isToolAllowedInMode, runAgentToolLoop, assertNoSecretLeak, redactSecrets } from '../model-services/agentLoop.js';
import { createContextBroker } from '../model-services/contextBroker.js';
import {
  computeBackoffDelayMs,
  decideRetry,
  isRetryableErrorCode,
  resolveRetryPolicy
} from '../model-services/retryPolicy.js';
import {
  InMemoryRolloutStorage,
  RolloutRecorder,
  parseRolloutLines
} from '../model-services/rolloutRecorder.js';
import {
  DEFAULT_SUMMARIZATION_PROMPT,
  DEFAULT_SUMMARY_PREFIX
} from '../model-services/contextCompactor.js';
import { ToolRegistry, validateToolInput } from '../ai/toolRegistry.js';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import {
  FileRolloutStorage,
  listRolloutSessions,
  loadRolloutSession,
  newRolloutFilePath
} from '../model-services/fileRolloutStorage.js';
import { runAgentSession } from '../model-services/agentSessionHost.js';
import type { ResumedRollout } from '../model-services/rolloutRecorder.js';
import type {
  AgentEvent,
  AgentPermissionMode,
  AgentRunResult,
  ContextEvidenceSource,
  ModelCompleteRequest,
  ModelServiceConfig,
  ToolCall,
  ModelServiceAdapter,
  ToolDefinition
} from '../model-services/types.js';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * SSE server that writes one initial chunk (headers + optional first event) and
 * then stalls with periodic pings. Used to exercise stream cancellation and
 * per-request timeouts deterministically. Tracks sockets so close() never hangs
 * on an abandoned response body.
 */
function startStallingSseServer(initialChunk: string): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (initialChunk) res.write(initialChunk);
    const timer = setInterval(() => {
      try {
        res.write('data: {}\n\n');
      } catch {
        clearInterval(timer);
      }
    }, 500);
    res.on('close', () => clearInterval(timer));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await close(server);
        }
      });
    });
  });
}

function makeConfig(port: number, protocol: 'openai-compatible' | 'anthropic-compatible'): ModelServiceConfig {
  return {
    id: `conformance-${protocol}`,
    displayName: `Conformance ${protocol}`,
    protocol,
    baseUrl: `http://127.0.0.1:${port}`,
    model: 'test-model',
    hasCredential: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Write matrix helpers: scripted contract server + scaffold tool executor.
// ---------------------------------------------------------------------------

interface ScriptedToolCall {
  name: string;
  argumentsJson: string;
  completionTokens?: number;
}

/**
 * Scripted OpenAI-compatible fake server. Each HTTP request pops the next
 * scripted tool call; when the script is exhausted it answers with stop.
 * Records the full request message bodies so tests can assert that the
 * Context Broker injected bounded evidence fragments across steps.
 * Local only — zero network egress.
 */
function startScriptedServer(script: ScriptedToolCall[]): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requestCount: () => number;
  history: Array<{ messages: unknown[] }>;
}> {
  let issued = 0;
  let requests = 0;
  const history: Array<{ messages: unknown[] }> = [];
  const server = createServer((req, res) => {
    requests += 1;
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as { messages?: unknown[] };
        history.push({ messages: parsed.messages ?? [] });
      } catch {
        history.push({ messages: [] });
      }
      if (issued < script.length) {
        const call = script[issued++]!;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: `call_matrix_${issued}`,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsJson }
              }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 10, completion_tokens: call.completionTokens ?? 7 }
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'matrix done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3 }
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        requestCount: () => requests,
        history
      });
    });
  });
}

interface ExecutedCall {
  name: string;
  ok: boolean;
  code?: string;
}

/**
 * Wire the agent loop's executeTool to the scaffold typed registry (policy
 * gate + Patch Engine transaction). Structured diagnostics become the
 * tool-result payload; refusal/error codes surface in the loop audit.
 */
function createMatrixExecutor(
  registry: ScaffoldToolRegistry,
  ctx: ScaffoldToolContext,
  onResult?: (name: string, result: TypedToolResult) => void | Promise<void>
): { executeTool: (call: ToolCall) => Promise<{ ok: boolean; content: string; code?: string }>; executed: ExecutedCall[] } {
  const executed: ExecutedCall[] = [];
  const executeTool = async (call: ToolCall): Promise<{ ok: boolean; content: string; code?: string }> => {
    let args: unknown = {};
    try {
      args = JSON.parse(call.argumentsJson);
    } catch {
      // leave empty args — the evidence gate applies upstream
    }
    const result = await registry.executeToolThroughPolicy(call.name, args, ctx);
    if (onResult) await onResult(call.name, result);
    const errorDiagnostic = result.diagnostics.find((item) => item.severity === 'error');
    const code = result.ok
      ? undefined
      : result.policyDecision.kind === 'deny'
        ? result.policyDecision.code
        : errorDiagnostic?.code ?? 'TOOL_FAILED';
    executed.push({ name: call.name, ok: result.ok, ...(code ? { code } : {}) });
    return {
      ok: result.ok,
      ...(code ? { code } : {}),
      content: JSON.stringify(result)
    };
  };
  return { executeTool, executed };
}

function listMatrixTools(registry: ScaffoldToolRegistry): ToolDefinition[] {
  return registry.listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: {}
  }));
}

function createMatrixContext(root: string, mode: ScaffoldToolContext['mode']): ScaffoldToolContext {
  return {
    workspaceId: 'ws-ai-matrix',
    workspaceRoot: root,
    mode,
    auditLog: new MemoryAuditLogStore()
  };
}

async function createMatrixWorkspace(): Promise<{ root: string; notePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-ai-matrix-'));
  await mkdir(join(root, 'msg'), { recursive: true });
  const notePath = join(root, 'msg', 'note.txt');
  await writeFile(notePath, 'original\n', 'utf8');
  return { root, notePath };
}

function proposeScript(notePath: string, newText: string): ScriptedToolCall {
  return {
    name: 'patch.proposeTextEdit',
    argumentsJson: JSON.stringify({
      targetUri: 'file:///matrix-ws/msg/note.txt',
      targetPath: notePath,
      newText,
      title: 'matrix propose'
    })
  };
}

function readScript(notePath: string): ScriptedToolCall {
  return { name: 'workspace.readFile', argumentsJson: JSON.stringify({ path: notePath }) };
}

const EMPTY_ARGS = '{}';
// Chain tools (stage/validate/commit/rollback) consume the shared transaction
// state; a non-empty context marker lets them pass the agent loop evidence
// gate (empty arguments = no prior context = insufficient_evidence).
const CHAIN_ARGS = JSON.stringify({ chainContext: 'matrix-write-chain' });

async function runScriptedMatrix(
  script: ScriptedToolCall[],
  options: {
    mode: AgentPermissionMode;
    tools: ToolDefinition[];
    executeTool: (call: ToolCall) => Promise<{ ok: boolean; content: string; code?: string }>;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxTotalOutputTokens?: number;
    contextBroker?: import('../model-services/types.js').ContextBroker;
    contextBrokerOptions?: import('../model-services/types.js').ContextBrokerOptions;
  }
): Promise<{ run: AgentRunResult; requestCount: number; history: Array<{ messages: unknown[] }> }> {
  const server = await startScriptedServer(script);
  try {
    const config: ModelServiceConfig = {
      id: `matrix-${options.mode}`,
      displayName: 'Matrix fake server',
      protocol: 'openai-compatible',
      baseUrl: server.baseUrl,
      model: 'test-model',
      hasCredential: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: server.baseUrl,
      apiKey: 'sk-test',
      model: 'test-model'
    });
    const run = await runAgentToolLoop(adapter, {
      config,
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'execute the scripted task' }],
      tools: options.tools,
      permissionMode: options.mode,
      executeTool: options.executeTool,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxTotalOutputTokens !== undefined
        ? { maxTotalOutputTokens: options.maxTotalOutputTokens }
        : {}),
      ...(options.contextBroker ? { contextBroker: options.contextBroker } : {}),
      ...(options.contextBrokerOptions ? { contextBrokerOptions: options.contextBrokerOptions } : {})
    });
    return { run, requestCount: server.requestCount(), history: server.history };
  } finally {
    await server.close();
  }
}

async function main(): Promise<void> {
  let passed = 0;
  const total = 58;

  // --- Case 1: HTTP 429 rate limit ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
      if (result.finishReason !== 'error') throw new Error('expected error finish');
      const diag = result.diagnostics[0]!;
      if (diag.code !== 'MODEL_SERVICE_RATE_LIMITED') throw new Error(`expected RATE_LIMITED, got ${diag.code}`);
      if (!diag.message.includes('Retry-After: 30')) throw new Error('missing Retry-After in message');
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 2: HTTP 500 server error ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal server error');
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
      if (result.finishReason !== 'error') throw new Error('expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_SERVER_ERROR') {
        throw new Error(`expected SERVER_ERROR, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 3: HTTP 401 auth error ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'bad-key',
        model: 'test'
      });
      const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
      if (result.finishReason !== 'error') throw new Error('expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_AUTH_ERROR') {
        throw new Error(`expected AUTH_ERROR, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 4: Network failure (fetch throws) ---
  {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'sk-test',
      model: 'test',
      fetchImpl: async () => { throw new TypeError('fetch failed'); }
    });
    const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
    if (result.finishReason !== 'error') throw new Error('expected error finish');
    if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_NETWORK_ERROR') {
      throw new Error(`expected NETWORK_ERROR, got ${result.diagnostics[0]!.code}`);
    }
    passed++;
  }

  // --- Case 5: Malformed JSON response ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not valid json {{{');
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
      if (result.finishReason !== 'error') throw new Error('expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_RESPONSE_PARSE_FAILED') {
        throw new Error(`expected PARSE_FAILED, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 6: Timeout ---
  {
    const server = createServer((_req, res) => {
      // Never respond — let the timeout fire.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }] }));
      }, 5000);
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const result = await adapter.complete({
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 100
      });
      if (result.finishReason !== 'error') throw new Error('expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_TIMEOUT') {
        throw new Error(`expected TIMEOUT, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 7: Cancellation via AbortController ---
  {
    const controller = new AbortController();
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }] }));
      }, 5000);
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      setTimeout(() => controller.abort(), 50);
      const result = await adapter.complete({
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      });
      if (result.finishReason !== 'error') throw new Error('expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_CANCELLED') {
        throw new Error(`expected CANCELLED (active abort), got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 8: Output token budget exceeded in agent loop ---
  {
    let callCount = 0;
    const server = createServer((_req, res) => {
      callCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (callCount === 1) {
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call1', function: { name: 'search_workspace', arguments: '{"query":"test"}' } }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 500 }
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 600 }
        }));
      }
    });
    const port = await listen(server);
    try {
      const config = makeConfig(port, 'openai-compatible');
      const adapter: ModelServiceAdapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test-model'
      });
      const result = await runAgentToolLoop(adapter, {
        config,
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'search' }],
        tools: [{ name: 'search_workspace', description: 'search', parametersJsonSchema: {} }],
        permissionMode: 'normal',
        executeTool: async (call: ToolCall) => ({ ok: true, content: `result for ${call.name}` }),
        maxTotalOutputTokens: 800
      });
      if (!result.diagnostics.some((d) => d.code === 'MODEL_SERVICE_OUTPUT_BUDGET_EXCEEDED')) {
        throw new Error('expected OUTPUT_BUDGET_EXCEEDED diagnostic');
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 9: Anthropic HTTP 429 ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      res.end(JSON.stringify({ error: { message: 'anthropic rate limit' } }));
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
      if (result.finishReason !== 'error') throw new Error('expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_RATE_LIMITED') {
        throw new Error(`expected RATE_LIMITED, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 10: Stream error classification ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('service unavailable');
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const events: string[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(event.type === 'error' ? event.code : event.type);
      }
      if (!events.includes('MODEL_SERVICE_SERVER_ERROR')) {
        throw new Error(`expected SERVER_ERROR in stream, got ${JSON.stringify(events)}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 11: fullPermission success chain propose→stage→validate→commit→re-read ---
  {
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx);
      const script: ScriptedToolCall[] = [
        readScript(notePath),
        proposeScript(notePath, 'ai-committed\n'),
        { name: 'patch.stage', argumentsJson: CHAIN_ARGS },
        { name: 'patch.validate', argumentsJson: CHAIN_ARGS },
        { name: 'patch.commit', argumentsJson: CHAIN_ARGS },
        readScript(notePath)
      ];
      const { run } = await runScriptedMatrix(script, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool
      });
      if ((await readFile(notePath, 'utf8')) !== 'ai-committed\n') {
        throw new Error('Case 11: commit did not write the file.');
      }
      if (executed.length !== 6 || executed.some((call) => !call.ok)) {
        throw new Error(`Case 11: expected 6 ok tool calls, got ${JSON.stringify(executed)}`);
      }
      if (run.finishReason !== 'stop') throw new Error(`Case 11: expected stop, got ${run.finishReason}`);
      if (run.audit.toolCalls.length !== 6) throw new Error('Case 11: audit toolCalls mismatch');
      // Re-read after commit must observe the committed content.
      const toolContents = run.messages.filter((m) => m.role === 'tool').map((m) => m.content);
      if (!toolContents[toolContents.length - 1]!.includes('ai-committed')) {
        throw new Error('Case 11: re-read did not return committed content.');
      }
      // Transaction audit chain must be complete.
      const kinds = ctx.auditLog!.list().map((entry) => entry.eventKind as string);
      for (const expected of [
        'policy_decision',
        'tool_call',
        'transaction_created',
        'patch_added',
        'staging_created',
        'patch_applied_to_staging',
        'validation',
        'commit'
      ]) {
        if (!kinds.includes(expected)) throw new Error(`Case 11: missing audit event ${expected}`);
      }
      assertNoSecretLeak({ messages: run.messages, audit: run.audit, log: ctx.auditLog!.list() }, 'sk-test');
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 12: normal mode commit requires confirmation, then commits ---
  {
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'normal');
      const executed: ExecutedCall[] = [];
      let commitFirstDenied = false;
      const executeTool = async (call: ToolCall): Promise<{ ok: boolean; content: string; code?: string }> => {
        let args: unknown = {};
        try {
          args = JSON.parse(call.argumentsJson);
        } catch {
          // leave empty
        }
        let result = await registry.executeToolThroughPolicy(call.name, args, ctx);
        // Simulate the user confirmation flow: the refused commit is retried
        // after the session escalates; both decisions stay in the audit log.
        if (call.name === 'patch.commit'
          && !result.ok
          && result.policyDecision.kind === 'deny'
          && ctx.mode === 'normal') {
          commitFirstDenied = true;
          ctx.mode = 'fullPermission';
          result = await registry.executeToolThroughPolicy(call.name, args, ctx);
        }
        const errorDiagnostic = result.diagnostics.find((item) => item.severity === 'error');
        const code = result.ok
          ? undefined
          : result.policyDecision.kind === 'deny'
            ? result.policyDecision.code
            : errorDiagnostic?.code ?? 'TOOL_FAILED';
        executed.push({ name: call.name, ok: result.ok, ...(code ? { code } : {}) });
        return { ok: result.ok, ...(code ? { code } : {}), content: JSON.stringify(result) };
      };
      const script: ScriptedToolCall[] = [
        proposeScript(notePath, 'confirmed-commit\n'),
        { name: 'patch.stage', argumentsJson: CHAIN_ARGS },
        { name: 'patch.validate', argumentsJson: CHAIN_ARGS },
        { name: 'patch.commit', argumentsJson: CHAIN_ARGS }
      ];
      const { run } = await runScriptedMatrix(script, {
        mode: 'normal',
        tools: listMatrixTools(registry),
        executeTool
      });
      if (!commitFirstDenied) throw new Error('Case 12: normal-mode commit must be refused first.');
      if ((await readFile(notePath, 'utf8')) !== 'confirmed-commit\n') {
        throw new Error('Case 12: confirmed commit did not write the file.');
      }
      const decisions = ctx.auditLog!.list()
        .filter((entry) => entry.eventKind === 'policy_decision')
        .map((entry) => entry.details)
        .filter((details): details is { toolName?: string; decision?: { code?: string } } =>
          typeof details === 'object' && details !== null && 'decision' in details);
      const commitDecisions = decisions
        .filter((details) => details.toolName === 'patch.commit')
        .map((details) => details.decision?.code);
      if (!commitDecisions.includes('POLICY_DENIED')) throw new Error('Case 12: missing POLICY_DENIED decision.');
      if (!commitDecisions.includes('POLICY_ALLOW_FULL_PERMISSION')) {
        throw new Error('Case 12: missing confirmation-granted decision.');
      }
      if (executed.length !== 4 || !executed[3]!.ok) {
        throw new Error(`Case 12: expected 4 ok tool calls, got ${JSON.stringify(executed)}`);
      }
      assertNoSecretLeak({ messages: run.messages, audit: run.audit, log: ctx.auditLog!.list() }, 'sk-test');
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 13: plan mode is strictly read-only at the loop level ---
  {
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'plan');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx);
      const script: ScriptedToolCall[] = [
        readScript(notePath),
        proposeScript(notePath, 'must-not-write\n'),
        { name: 'patch.commit', argumentsJson: EMPTY_ARGS }
      ];
      const { run } = await runScriptedMatrix(script, {
        mode: 'plan',
        tools: listMatrixTools(registry),
        executeTool
      });
      if ((await readFile(notePath, 'utf8')) !== 'original\n') {
        throw new Error('Case 13: plan mode must not modify files.');
      }
      if (executed.length !== 1 || executed[0]!.name !== 'workspace.readFile') {
        throw new Error(`Case 13: only read tools may execute in plan mode, got ${JSON.stringify(executed)}`);
      }
      if (run.audit.toolCalls.length !== 3) throw new Error('Case 13: audit should record 3 tool calls.');
      const denied = run.audit.toolCalls.filter((call) => call.code === 'AGENT_TOOL_DENIED_PLAN_MODE');
      if (denied.length !== 2) throw new Error('Case 13: propose and commit must be denied in plan mode.');
      const toolContents = run.messages.filter((m) => m.role === 'tool').map((m) => m.content);
      if (!toolContents.some((content) => content.includes('AGENT_TOOL_DENIED_PLAN_MODE'))) {
        throw new Error('Case 13: plan denial must be a structured tool result.');
      }
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 14: validation failure blocks commit and refuses rollback ---
  {
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx);
      const script: ScriptedToolCall[] = [
        // NUL bytes must fail the staged-output text validator.
        proposeScript(notePath, 'bad\u0000text\n'),
        { name: 'patch.stage', argumentsJson: CHAIN_ARGS },
        { name: 'patch.validate', argumentsJson: CHAIN_ARGS },
        { name: 'patch.commit', argumentsJson: CHAIN_ARGS },
        { name: 'patch.rollback', argumentsJson: CHAIN_ARGS }
      ];
      const { run } = await runScriptedMatrix(script, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool
      });
      if ((await readFile(notePath, 'utf8')) !== 'original\n') {
        throw new Error('Case 14: failed validation must not modify the file.');
      }
      const stage = executed[1]!;
      const validate = executed[2]!;
      const commit = executed[3]!;
      const rollback = executed[4]!;
      if (!stage.ok) throw new Error('Case 14: stage should succeed before validation.');
      if (validate.ok || validate.code !== 'VALIDATOR_FAILED') {
        throw new Error(`Case 14: expected VALIDATOR_FAILED, got ${JSON.stringify(validate)}`);
      }
      if (commit.ok || commit.code !== 'COMMIT_BLOCKED') {
        throw new Error(`Case 14: expected COMMIT_BLOCKED, got ${JSON.stringify(commit)}`);
      }
      if (rollback.ok || rollback.code !== 'ROLLBACK_FAILED') {
        throw new Error(`Case 14: expected structured ROLLBACK_FAILED, got ${JSON.stringify(rollback)}`);
      }
      if (!ctx.auditLog!.list().some((entry) => entry.eventKind === 'failure_recovery')) {
        throw new Error('Case 14: missing failure_recovery audit entry.');
      }
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 15: stale revision conflict is rejected, never overwritten ---
  {
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx, async (name, result) => {
        if (name === 'patch.stage' && result.ok) {
          // Concurrent user edit lands between stage and validate.
          await writeFile(notePath, 'concurrent-edit\n', 'utf8');
        }
      });
      const script: ScriptedToolCall[] = [
        proposeScript(notePath, 'stale-write\n'),
        { name: 'patch.stage', argumentsJson: CHAIN_ARGS },
        { name: 'patch.validate', argumentsJson: CHAIN_ARGS },
        { name: 'patch.commit', argumentsJson: CHAIN_ARGS }
      ];
      const { run } = await runScriptedMatrix(script, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool
      });
      if ((await readFile(notePath, 'utf8')) !== 'concurrent-edit\n') {
        throw new Error('Case 15: stale revision must not overwrite the concurrent edit.');
      }
      const validate = executed[2]!;
      const commit = executed[3]!;
      if (validate.ok || validate.code !== 'ORIGINAL_CHANGED_DURING_STAGING') {
        throw new Error(`Case 15: expected ORIGINAL_CHANGED_DURING_STAGING, got ${JSON.stringify(validate)}`);
      }
      if (commit.ok || commit.code !== 'COMMIT_BLOCKED') {
        throw new Error(`Case 15: expected COMMIT_BLOCKED, got ${JSON.stringify(commit)}`);
      }
      if (!run.audit.toolCalls.some((call) => call.code === 'ORIGINAL_CHANGED_DURING_STAGING')) {
        throw new Error('Case 15: stale conflict must appear in the loop audit.');
      }
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 16: cancellation on the write path never commits ---
  {
    const controller = new AbortController();
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx, async (name, result) => {
        if (name === 'patch.stage' && result.ok) controller.abort();
      });
      const script: ScriptedToolCall[] = [
        proposeScript(notePath, 'cancelled-write\n'),
        { name: 'patch.stage', argumentsJson: CHAIN_ARGS }
      ];
      const { run } = await runScriptedMatrix(script, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool,
        signal: controller.signal
      });
      if (run.finishReason !== 'cancelled') throw new Error(`Case 16: expected cancelled, got ${run.finishReason}`);
      if (!run.diagnostics.some((d) => d.code === 'AGENT_CANCELLED')) {
        throw new Error('Case 16: missing AGENT_CANCELLED diagnostic.');
      }
      if ((await readFile(notePath, 'utf8')) !== 'original\n') {
        throw new Error('Case 16: cancelled run must not commit.');
      }
      if (executed.length !== 2 || executed.some((call) => !call.ok)) {
        throw new Error(`Case 16: propose+stage should have executed, got ${JSON.stringify(executed)}`);
      }
      if (run.audit.toolCalls.some((call) => call.name === 'patch.commit')) {
        throw new Error('Case 16: commit must not appear in the audit.');
      }
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 17: output token budget stops the write path before commit ---
  {
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx);
      const script: ScriptedToolCall[] = [
        { ...proposeScript(notePath, 'budgeted-write\n'), completionTokens: 600 },
        { name: 'patch.stage', argumentsJson: EMPTY_ARGS, completionTokens: 600 }
      ];
      const { run } = await runScriptedMatrix(script, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool,
        maxTotalOutputTokens: 700
      });
      if (run.finishReason !== 'length') throw new Error(`Case 17: expected length, got ${run.finishReason}`);
      if (!run.diagnostics.some((d) => d.code === 'MODEL_SERVICE_OUTPUT_BUDGET_EXCEEDED')) {
        throw new Error('Case 17: missing OUTPUT_BUDGET_EXCEEDED diagnostic.');
      }
      if (executed.length !== 1 || executed[0]!.name !== 'patch.proposeTextEdit') {
        throw new Error(`Case 17: budget must stop before stage, got ${JSON.stringify(executed)}`);
      }
      if ((await readFile(notePath, 'utf8')) !== 'original\n') {
        throw new Error('Case 17: budget stop must not modify the file.');
      }
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 18: timeout on the write path never executes tools ---
  {
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }]
        }));
      }, 5000);
    });
    const port = await listen(server);
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx);
      const config = makeConfig(port, 'openai-compatible');
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test-model'
      });
      const run = await runAgentToolLoop(adapter, {
        config,
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'write' }],
        tools: listMatrixTools(registry),
        permissionMode: 'full',
        executeTool,
        timeoutMs: 100
      });
      if (run.finishReason !== 'error') throw new Error(`Case 18: expected error, got ${run.finishReason}`);
      if (!run.diagnostics.some((d) => d.code === 'MODEL_SERVICE_TIMEOUT')) {
        throw new Error('Case 18: missing TIMEOUT diagnostic.');
      }
      if (executed.length !== 0) throw new Error('Case 18: no tool may execute on timeout.');
      if ((await readFile(notePath, 'utf8')) !== 'original\n') {
        throw new Error('Case 18: timeout must not modify the file.');
      }
      passed++;
    } finally {
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 19: full permission still passes the evidence gate and surfaces
  // --- PATCH_ENGINE_REQUIRED refusals instead of bypassing executeTool.
  {
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx);
      const evidenceGateScript: ScriptedToolCall[] = [
        { name: 'patch.commit', argumentsJson: EMPTY_ARGS }
      ];
      const { run: gateRun } = await runScriptedMatrix(evidenceGateScript, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool
      });
      if (executed.length !== 0) throw new Error('Case 19: empty-args commit must not reach executeTool.');
      if (!gateRun.audit.toolCalls.some((call) => call.code === 'insufficient_evidence')) {
        throw new Error('Case 19: missing insufficient_evidence audit entry.');
      }

      const engineRefusalScript: ScriptedToolCall[] = [
        { name: 'patch.commit', argumentsJson: JSON.stringify({ patchId: 'demo' }) }
      ];
      const engineRefused = await runScriptedMatrix(engineRefusalScript, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool: async () => ({
          ok: false,
          code: 'PATCH_ENGINE_REQUIRED',
          content: JSON.stringify({
            ok: false,
            code: 'PATCH_ENGINE_REQUIRED',
            message: '完全权限也不能绕过 Patch Engine。'
          })
        })
      });
      if (!engineRefused.run.audit.toolCalls.some((call) => call.code === 'PATCH_ENGINE_REQUIRED')) {
        throw new Error('Case 19: PATCH_ENGINE_REQUIRED must appear in the loop audit.');
      }
      const toolContents = engineRefused.run.messages
        .filter((m) => m.role === 'tool')
        .map((m) => m.content)
        .join('\n');
      if (!toolContents.includes('PATCH_ENGINE_REQUIRED')) {
        throw new Error('Case 19: refusal content must be surfaced to the loop.');
      }
      if ((await readFile(notePath, 'utf8')) !== 'original\n') {
        throw new Error('Case 19: refused write must not modify the file.');
      }
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 20: policy gate unit matrix on the write permission ladder ---
  {
    const normalCommit = evaluatePolicyGate({
      mode: 'normal',
      maxPermission: 'validate',
      toolName: 'patch.commit',
      requiredPermission: 'commit'
    });
    if (normalCommit.kind !== 'deny' || normalCommit.code !== 'POLICY_DENIED') {
      throw new Error('Case 20: normal-mode commit must be rank-denied.');
    }
    const fullCommit = evaluatePolicyGate({
      mode: 'fullPermission',
      maxPermission: 'rollback',
      toolName: 'patch.commit',
      requiredPermission: 'commit'
    });
    if (fullCommit.kind !== 'allow' || fullCommit.code !== 'POLICY_ALLOW_FULL_PERMISSION') {
      throw new Error('Case 20: fullPermission commit must be allowed with audit tag.');
    }
    const commitNeedsReceipt = evaluatePolicyGate({
      mode: 'normal',
      maxPermission: 'commit',
      toolName: 'patch.commit',
      requiredPermission: 'commit'
    });
    if (commitNeedsReceipt.kind !== 'require_confirmation'
      || commitNeedsReceipt.code !== 'POLICY_CONFIRMATION_REQUIRED') {
      throw new Error('Case 20: commit-granting mode without receipt must require confirmation.');
    }
    const commitWithReceipt = evaluatePolicyGate({
      mode: 'normal',
      maxPermission: 'commit',
      toolName: 'patch.commit',
      requiredPermission: 'commit',
      confirmationReceiptIds: ['receipt-1']
    });
    if (commitWithReceipt.kind !== 'allow') throw new Error('Case 20: receipt must allow commit.');
    const rollbackNeedsConfirmation = evaluatePolicyGate({
      mode: 'normal',
      maxPermission: 'rollback',
      toolName: 'patch.rollback',
      requiredPermission: 'rollback'
    });
    if (rollbackNeedsConfirmation.kind !== 'require_confirmation') {
      throw new Error('Case 20: rollback without receipt must require confirmation.');
    }
    const fullRollback = evaluatePolicyGate({
      mode: 'fullPermission',
      maxPermission: 'rollback',
      toolName: 'patch.rollback',
      requiredPermission: 'rollback'
    });
    if (fullRollback.kind !== 'allow') throw new Error('Case 20: fullPermission rollback must be allowed.');
    // Loop level: plan read-only; normal keeps write tools registered and lets
    // the policy gate + Patch Engine below decide.
    const planCommit = isToolAllowedInMode('patch.commit', 'plan', new Set(['patch.commit', 'workspace.readFile']));
    if (planCommit.ok || planCommit.code !== 'AGENT_TOOL_DENIED_PLAN_MODE') {
      throw new Error('Case 20: agent loop must deny commit in plan mode.');
    }
    const planRead = isToolAllowedInMode('workspace.readFile', 'plan', new Set(['patch.commit', 'workspace.readFile']));
    if (!planRead.ok) throw new Error('Case 20: agent loop must allow read tools in plan mode.');
    const normalCommitLoop = isToolAllowedInMode('patch.commit', 'normal', new Set(['patch.commit']));
    if (!normalCommitLoop.ok) throw new Error('Case 20: normal mode keeps the write tool registered.');
    passed++;
  }

  // --- Case 21: Context Broker assembles four evidence kinds into bounded,
  // --- redacted context, truncating oversized excerpts ---
  {
    const broker = createContextBroker();
    const secret = 'sk-test-secret-abcdefghijklmno';
    const sources: ContextEvidenceSource[] = [
      {
        kind: 'readFile',
        uri: 'file:///ws/msg/note.txt',
        text: `original\nconfidential ${secret} token\n${'x'.repeat(300)}\n`,
        meta: { sha256: 'abc123', sizeBytes: 400 }
      },
      {
        kind: 'resourceGraph',
        uri: 'workspace://ws-ai-matrix',
        payload: {
          nodes: [{ uri: 'file:///ws/msg/note.txt', kind: 'file', diagnostics: [] }],
          edges: []
        }
      },
      {
        kind: 'diagnostics',
        uri: 'workspace://ws-ai-matrix',
        payload: {
          diagnostics: [{ severity: 'error', code: 'VALIDATOR_FAILED', message: 'NUL byte in staged output' }]
        }
      },
      {
        kind: 'patchPlan',
        uri: 'file:///ws/msg/note.txt',
        payload: { title: 'propose text edit', targetPath: 'msg/note.txt', expectedHash: 'abc123' }
      }
    ];
    const result = await broker.assemble(sources, { maxBytes: 4000, excerptLength: 120 });
    if (!result.ok) throw new Error(`Case 21: expected ok assembly, got ${JSON.stringify(result)}`);
    if (result.sections.length !== 4) throw new Error(`Case 21: expected 4 sections, got ${result.sections.length}`);
    for (const kind of ['readFile', 'resourceGraph', 'diagnostics', 'patchPlan']) {
      if (!result.sections.some((section) => section.kind === kind)) {
        throw new Error(`Case 21: missing section kind ${kind}`);
      }
      if (!result.context.includes(`evidence=${kind}`)) {
        throw new Error(`Case 21: context missing ${kind} marker`);
      }
    }
    if (result.context.includes(secret)) throw new Error('Case 21: secret leaked into assembled context.');
    if (result.totalBytes > 4000) throw new Error(`Case 21: context exceeded budget ${result.totalBytes}`);
    const readFileSection = result.sections.find((section) => section.kind === 'readFile')!;
    if (!readFileSection.redacted) throw new Error('Case 21: readFile section must be marked redacted.');
    if (!readFileSection.truncated) throw new Error('Case 21: long readFile excerpt must be truncated.');
    if (readFileSection.excerptLength !== 120) throw new Error('Case 21: excerpt length cap not applied.');
    if (!result.context.includes('VALIDATOR_FAILED')) throw new Error('Case 21: diagnostics must be preserved.');
    if (!result.context.includes('patchPlan')) throw new Error('Case 21: patch-plan context must be injected.');
    passed++;
  }

  // --- Case 22: no evidence -> structured insufficient_evidence ---
  {
    const broker = createContextBroker();
    const empty = await broker.assemble([]);
    if (empty.ok || empty.code !== 'insufficient_evidence') {
      throw new Error('Case 22: empty sources must be insufficient_evidence.');
    }
    const blank = await broker.assemble([{ kind: 'readFile', text: '' }]);
    if (blank.ok || blank.code !== 'insufficient_evidence') {
      throw new Error('Case 22: blank text must be insufficient_evidence.');
    }
    if (!blank.diagnostics[0]!.message) throw new Error('Case 22: insufficient_evidence needs a diagnostic message.');
    passed++;
  }

  // --- Case 23: single oversized section fails closed with CONTEXT_LIMIT_EXCEEDED ---
  {
    const broker = createContextBroker();
    const big = await broker.assemble(
      [{ kind: 'readFile', uri: 'file:///ws/huge.txt', text: 'y'.repeat(5000) }],
      { maxBytes: 1000 }
    );
    if (big.ok || big.code !== 'CONTEXT_LIMIT_EXCEEDED') {
      throw new Error('Case 23: oversized section must fail closed with CONTEXT_LIMIT_EXCEEDED.');
    }
    passed++;
  }

  // --- Case 24: cancellation / timeout interrupt pending evidence reads ---
  {
    const broker = createContextBroker();
    const controller = new AbortController();
    const pendingRead = new Promise<string>(() => {});
    const cancelledPromise = broker.assemble(
      [{ kind: 'readFile', uri: 'file:///ws/slow.txt', readText: () => pendingRead }],
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 10);
    const cancelled = await cancelledPromise;
    if (cancelled.ok || cancelled.code !== 'CONTEXT_CANCELLED') {
      throw new Error(`Case 24: expected CONTEXT_CANCELLED, got ${JSON.stringify(cancelled)}`);
    }
    const timedPromise = broker.assemble(
      [{ kind: 'readFile', uri: 'file:///ws/slow.txt', readText: () => new Promise<string>(() => {}) }],
      { timeoutMs: 50 }
    );
    const timed = await timedPromise;
    if (timed.ok || timed.code !== 'CONTEXT_TIMEOUT') {
      throw new Error(`Case 24: expected CONTEXT_TIMEOUT, got ${JSON.stringify(timed)}`);
    }
    passed++;
  }

  // --- Case 25: production multi-step loop with Context Broker — evidence is
  // --- assembled across steps and injected before each model call ---
  {
    const broker = createContextBroker();
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx);
      const script: ScriptedToolCall[] = [
        readScript(notePath),
        proposeScript(notePath, 'broker-committed\n'),
        { name: 'patch.stage', argumentsJson: CHAIN_ARGS },
        { name: 'patch.validate', argumentsJson: CHAIN_ARGS },
        { name: 'patch.commit', argumentsJson: CHAIN_ARGS },
        readScript(notePath)
      ];
      const { run, history } = await runScriptedMatrix(script, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool,
        contextBroker: broker,
        contextBrokerOptions: { maxBytes: 8000, excerptLength: 300 }
      });
      if ((await readFile(notePath, 'utf8')) !== 'broker-committed\n') {
        throw new Error('Case 25: broker-enabled commit did not write the file.');
      }
      if (executed.length !== 6 || executed.some((call) => !call.ok)) {
        throw new Error(`Case 25: expected 6 ok calls, got ${JSON.stringify(executed)}`);
      }
      const systemContexts = history
        .flatMap((entry) => entry.messages)
        .filter((message) => typeof message === 'object' && message !== null
          && (message as { role?: string }).role === 'system'
          && typeof (message as { content?: unknown }).content === 'string')
        .map((message) => (message as { content: string }).content);
      if (!systemContexts.some((content) => content.includes('[evidence-context'))) {
        throw new Error('Case 25: no evidence context was injected into model requests.');
      }
      // Cross-step state consistency: after the first tool executes, later
      // requests carry tool-result evidence assembled from the prior step.
      if (!systemContexts.some((content) => content.includes('evidence=toolResult'))) {
        throw new Error('Case 25: cross-step tool evidence missing from later context.');
      }
      if (!run.audit.contextAssemblies?.some((assembly) => assembly.ok && assembly.sections >= 1)) {
        throw new Error('Case 25: context assemblies missing from run audit.');
      }
      if (run.finishReason !== 'stop') throw new Error(`Case 25: expected stop, got ${run.finishReason}`);
      assertNoSecretLeak({ messages: run.messages, audit: run.audit }, 'sk-test');
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 26: cancellation with Context Broker leaves no residue ---
  {
    const controller = new AbortController();
    const broker = createContextBroker();
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx, async (name, result) => {
        if (name === 'patch.stage' && result.ok) controller.abort();
      });
      const script: ScriptedToolCall[] = [
        proposeScript(notePath, 'cancelled-broker-write\n'),
        { name: 'patch.stage', argumentsJson: CHAIN_ARGS }
      ];
      const { run } = await runScriptedMatrix(script, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool,
        signal: controller.signal,
        contextBroker: broker
      });
      if (run.finishReason !== 'cancelled') throw new Error(`Case 26: expected cancelled, got ${run.finishReason}`);
      if ((await readFile(notePath, 'utf8')) !== 'original\n') {
        throw new Error('Case 26: cancelled broker run must not modify the file.');
      }
      if (executed.length !== 2) throw new Error(`Case 26: expected propose+stage, got ${JSON.stringify(executed)}`);
      if (run.audit.toolCalls.some((call) => call.name === 'patch.commit')) {
        throw new Error('Case 26: commit must not appear in the audit.');
      }
      if (!run.audit.contextAssemblies?.some((assembly) => assembly.ok)) {
        throw new Error('Case 26: broker should have assembled pre-cancel evidence.');
      }
      assertNoSecretLeak({ messages: run.messages, audit: run.audit }, 'sk-test');
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 27: full permission still cannot bypass Patch Engine — the refusal
  // --- is assembled into evidence context and surfaced in the audit ---
  {
    const broker = createContextBroker();
    const registry = createScaffoldToolRegistry();
    const { root, notePath } = await createMatrixWorkspace();
    try {
      const ctx = createMatrixContext(root, 'fullPermission');
      const { executeTool, executed } = createMatrixExecutor(registry, ctx);
      const script: ScriptedToolCall[] = [
        proposeScript(notePath, 'gated-write\n'),
        { name: 'patch.stage', argumentsJson: CHAIN_ARGS },
        { name: 'patch.validate', argumentsJson: CHAIN_ARGS },
        { name: 'patch.commit', argumentsJson: CHAIN_ARGS }
      ];
      const engineGatedExecuteTool = async (call: ToolCall) => {
        if (call.name === 'patch.commit') {
          return {
            ok: false,
            code: 'PATCH_ENGINE_REQUIRED',
            content: JSON.stringify({
              ok: false,
              code: 'PATCH_ENGINE_REQUIRED',
              message: '完全权限也不能绕过 Patch Engine。'
            })
          };
        }
        return executeTool(call);
      };
      const { run, history } = await runScriptedMatrix(script, {
        mode: 'full',
        tools: listMatrixTools(registry),
        executeTool: engineGatedExecuteTool,
        contextBroker: broker
      });
      if ((await readFile(notePath, 'utf8')) !== 'original\n') {
        throw new Error('Case 27: PATCH_ENGINE_REQUIRED must not modify the file.');
      }
      if (!run.audit.toolCalls.some((call) => call.code === 'PATCH_ENGINE_REQUIRED')) {
        throw new Error('Case 27: refusal missing from loop audit.');
      }
      const systemContexts = history
        .flatMap((entry) => entry.messages)
        .filter((message) => typeof message === 'object' && message !== null
          && (message as { role?: string }).role === 'system'
          && typeof (message as { content?: unknown }).content === 'string')
        .map((message) => (message as { content: string }).content);
      if (!systemContexts.some((content) => content.includes('PATCH_ENGINE_REQUIRED'))) {
        throw new Error('Case 27: refusal must be assembled into later evidence context.');
      }
      if (!run.audit.contextAssemblies?.some((assembly) => assembly.ok)) {
        throw new Error('Case 27: broker assemblies missing from audit.');
      }
      passed++;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // --- Case 28: policy gate full matrix — every permission x every mode ---
  {
    const perms = ['read', 'analyze', 'propose', 'stage', 'validate', 'commit', 'rollback'] as const;
    const modes = ['plan', 'normal', 'fullPermission'] as const;
    const rank = new Map<string, number>([
      ['read', 0], ['analyze', 1], ['propose', 2], ['stage', 3],
      ['validate', 4], ['commit', 5], ['rollback', 6]
    ]);
    let checks = 0;
    for (const mode of modes) {
      const maxPerm = maxPermissionFromMode(mode);
      for (const perm of perms) {
        const decision = evaluatePolicyGate({
          mode,
          maxPermission: maxPerm,
          toolName: `t.${perm}`,
          requiredPermission: perm
        });
        if (rank.get(perm)! > rank.get(maxPerm)!) {
          if (decision.kind !== 'deny' || decision.code !== 'POLICY_DENIED') {
            throw new Error(`Case 28: ${mode}/${perm} must be rank-denied.`);
          }
        } else if (perm === 'commit' || perm === 'rollback') {
          if (mode === 'fullPermission') {
            if (decision.kind !== 'allow' || decision.code !== 'POLICY_ALLOW_FULL_PERMISSION') {
              throw new Error(`Case 28: ${mode}/${perm} must be full-permission allow.`);
            }
          } else if (decision.kind !== 'require_confirmation' || decision.code !== 'POLICY_CONFIRMATION_REQUIRED') {
            throw new Error(`Case 28: ${mode}/${perm} must require confirmation.`);
          }
        } else if (decision.kind !== 'allow') {
          throw new Error(`Case 28: ${mode}/${perm} must be allowed.`);
        }
        checks += 1;
      }
    }
    // A receipt upgrades a non-full-mode commit from require_confirmation to allow.
    const receiptCommit = evaluatePolicyGate({
      mode: 'normal',
      maxPermission: 'commit',
      toolName: 'patch.commit',
      requiredPermission: 'commit',
      confirmationReceiptIds: ['receipt-1']
    });
    if (receiptCommit.kind !== 'allow') throw new Error('Case 28: receipt must allow commit.');
    // Under-granted maxPermission is denied even in fullPermission mode.
    const underGranted = evaluatePolicyGate({
      mode: 'fullPermission',
      maxPermission: 'validate',
      toolName: 'patch.commit',
      requiredPermission: 'commit'
    });
    if (underGranted.kind !== 'deny') throw new Error('Case 28: under-granted full mode must deny commit.');
    // Loop-level mode gating complements the policy gate.
    const loopRegistered = new Set(['workspace.readFile', 'patch.commit']);
    for (const writeTool of ['patch.proposeTextEdit', 'patch.stage', 'patch.validate', 'patch.commit', 'patch.rollback']) {
      const deniedInPlan = isToolAllowedInMode(writeTool, 'plan', new Set([...loopRegistered, writeTool]));
      if (deniedInPlan.ok) throw new Error(`Case 28: ${writeTool} must be denied in plan mode.`);
    }
    const readInPlan = isToolAllowedInMode('workspace.readFile', 'plan', loopRegistered);
    if (!readInPlan.ok) throw new Error('Case 28: read tool must be allowed in plan mode.');
    checks += 3;
    if (checks !== 24) throw new Error(`Case 28: expected 24 matrix checks, got ${checks}`);
    passed++;
  }

  // --- Case 29: Anthropic HTTP 500 server error (independent request shape) ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal server error');
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
      if (result.finishReason !== 'error') throw new Error('Case 29: expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_SERVER_ERROR') {
        throw new Error(`Case 29: expected SERVER_ERROR, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 30: Anthropic network failure (fetch throws) ---
  {
    const adapter = new AnthropicCompatibleAdapter({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'sk-ant-test',
      model: 'test',
      fetchImpl: async () => { throw new TypeError('fetch failed'); }
    });
    const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
    if (result.finishReason !== 'error') throw new Error('Case 30: expected error finish');
    if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_NETWORK_ERROR') {
      throw new Error(`Case 30: expected NETWORK_ERROR, got ${result.diagnostics[0]!.code}`);
    }
    passed++;
  }

  // --- Case 31: Anthropic malformed JSON response ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not valid json {{{');
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const result = await adapter.complete({ messages: [{ role: 'user', content: 'hi' }] });
      if (result.finishReason !== 'error') throw new Error('Case 31: expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_RESPONSE_PARSE_FAILED') {
        throw new Error(`Case 31: expected PARSE_FAILED, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 32: Anthropic timeout (independent of caller abort) ---
  {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'late' }], stop_reason: 'end_turn' }));
      }, 5000);
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const result = await adapter.complete({
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 100
      });
      if (result.finishReason !== 'error') throw new Error('Case 32: expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_TIMEOUT') {
        throw new Error(`Case 32: expected TIMEOUT, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 33: Anthropic active cancellation → MODEL_SERVICE_CANCELLED ---
  {
    const controller = new AbortController();
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'late' }], stop_reason: 'end_turn' }));
      }, 5000);
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      setTimeout(() => controller.abort(), 50);
      const result = await adapter.complete({
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      });
      if (result.finishReason !== 'error') throw new Error('Case 33: expected error finish');
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_CANCELLED') {
        throw new Error(`Case 33: expected CANCELLED, got ${result.diagnostics[0]!.code}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 34: OpenAI stream cancellation → 'cancelled' ---
  {
    const controller = new AbortController();
    const openaiChunk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n`;
    const server = await startStallingSseServer(openaiChunk);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: server.baseUrl,
        apiKey: 'sk-test',
        model: 'test'
      });
      const events: string[] = [];
      const reasons: string[] = [];
      let armed = false;
      for await (const event of adapter.stream({
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      })) {
        if (event.type === 'text-delta') {
          events.push(event.text);
          if (!armed) {
            armed = true;
            setTimeout(() => controller.abort(), 10);
          }
        } else if (event.type === 'message-stop') {
          reasons.push(event.finishReason);
        } else if (event.type === 'error') {
          reasons.push(event.code);
        }
      }
      if (!events.includes('hello')) throw new Error(`Case 34: delta missing before cancel, got ${JSON.stringify(events)}`);
      if (!reasons.includes('cancelled')) {
        throw new Error(`Case 34: expected stream 'cancelled', got ${JSON.stringify(reasons)}`);
      }
      passed++;
    } finally {
      await server.close();
    }
  }

  // --- Case 35: OpenAI stream timeout → MODEL_SERVICE_TIMEOUT error event ---
  {
    const server = await startStallingSseServer('');
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: server.baseUrl,
        apiKey: 'sk-test',
        model: 'test'
      });
      const events: string[] = [];
      for await (const event of adapter.stream({
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 100
      })) {
        if (event.type === 'error') events.push(event.code);
        if (event.type === 'message-stop') events.push(event.finishReason);
      }
      if (!events.includes('MODEL_SERVICE_TIMEOUT')) {
        throw new Error(`Case 35: expected stream TIMEOUT, got ${JSON.stringify(events)}`);
      }
      passed++;
    } finally {
      await server.close();
    }
  }

  // --- Case 36: Anthropic stream cancellation → 'cancelled' (real SSE) ---
  {
    const controller = new AbortController();
    const anthropicChunk = `data: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'hello' }
    })}\n\n`;
    const server = await startStallingSseServer(anthropicChunk);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: server.baseUrl,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const events: string[] = [];
      const reasons: string[] = [];
      let armed = false;
      for await (const event of adapter.stream({
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal
      })) {
        if (event.type === 'text-delta') {
          events.push(event.text);
          if (!armed) {
            armed = true;
            setTimeout(() => controller.abort(), 10);
          }
        } else if (event.type === 'message-stop') {
          reasons.push(event.finishReason);
        } else if (event.type === 'error') {
          reasons.push(event.code);
        }
      }
      if (!events.includes('hello')) throw new Error(`Case 36: delta missing before cancel, got ${JSON.stringify(events)}`);
      if (!reasons.includes('cancelled')) {
        throw new Error(`Case 36: expected stream 'cancelled', got ${JSON.stringify(reasons)}`);
      }
      passed++;
    } finally {
      await server.close();
    }
  }

  // --- Case 37: Anthropic stream timeout → MODEL_SERVICE_TIMEOUT error event ---
  {
    const server = await startStallingSseServer('');
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: server.baseUrl,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const events: string[] = [];
      for await (const event of adapter.stream({
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 100
      })) {
        if (event.type === 'error') events.push(event.code);
        if (event.type === 'message-stop') events.push(event.finishReason);
      }
      if (!events.includes('MODEL_SERVICE_TIMEOUT')) {
        throw new Error(`Case 37: expected stream TIMEOUT, got ${JSON.stringify(events)}`);
      }
      passed++;
    } finally {
      await server.close();
    }
  }

  // --- Case 38: Anthropic real SSE happy path — text deltas, tool args
  // --- accumulated across input_json_delta chunks, usage, tool_use finish ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      chunk({ type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 11 } } });
      chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } });
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } });
      chunk({ type: 'content_block_stop', index: 0 });
      chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_sse', name: 'search_workspace', input: {} } });
      chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } });
      chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ember"}' } });
      chunk({ type: 'content_block_stop', index: 1 });
      chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
      chunk({ type: 'message_stop' });
      res.end();
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const texts: string[] = [];
      const toolCalls: Array<{ name: string; args: string }> = [];
      let finish: string | undefined;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (event.type === 'text-delta') texts.push(event.text);
        else if (event.type === 'tool-call') toolCalls.push({ name: event.toolCall.name, args: event.toolCall.argumentsJson });
        else if (event.type === 'message-stop') finish = event.finishReason;
        else if (event.type === 'usage') usage = event;
      }
      if (texts.join('') !== 'Hello world') {
        throw new Error(`Case 38: expected 'Hello world', got ${JSON.stringify(texts)}`);
      }
      if (toolCalls.length !== 1 || toolCalls[0]!.name !== 'search_workspace') {
        throw new Error(`Case 38: tool call not assembled, got ${JSON.stringify(toolCalls)}`);
      }
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(toolCalls[0]!.args);
      } catch {
        throw new Error(`Case 38: tool args are not valid JSON: ${toolCalls[0]!.args}`);
      }
      if ((parsedArgs as { query?: string }).query !== 'ember') {
        throw new Error(`Case 38: partial_json not accumulated, got ${toolCalls[0]!.args}`);
      }
      if (finish !== 'tool_use') throw new Error(`Case 38: expected tool_use finish, got ${finish}`);
      if (usage?.inputTokens !== 11 || usage?.outputTokens !== 9) {
        throw new Error(`Case 38: usage not captured, got ${JSON.stringify(usage)}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 39: Anthropic stream non-2xx HTTP → SERVER_ERROR error event ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal server error');
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const codes: string[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (event.type === 'error') codes.push(event.code);
      }
      if (!codes.includes('MODEL_SERVICE_SERVER_ERROR')) {
        throw new Error(`Case 39: expected stream SERVER_ERROR, got ${JSON.stringify(codes)}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 40: Anthropic SSE error event classification (rate_limit_error) ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'stream rate limited' }
      })}\n\n`);
      res.end();
    });
    const port = await listen(server);
    try {
      const adapter = new AnthropicCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-ant-test',
        model: 'test'
      });
      const codes: string[] = [];
      for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        if (event.type === 'error') codes.push(event.code);
      }
      if (!codes.includes('MODEL_SERVICE_RATE_LIMITED')) {
        throw new Error(`Case 40: expected RATE_LIMITED from SSE error, got ${JSON.stringify(codes)}`);
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 41: redaction matrix — sk-, Bearer, header inline secrets are all
  // --- redacted and rejected by assertNoSecretLeak via the shared patterns ---
  {
    const bearerToken = 'eyJhbGciOiJIUzI1NiJ9.some.signature';
    const headerInline = 'sk-ant-header-secret-abcdefghijk';
    const apiKeyForm = 'apikey_abcdefghijklmnopqrstuvwxyz';
    const liveSk = 'sk-live-secret-abcdefghijk';
    const raw = [
      `Bearer ${bearerToken}`,
      `x-api-key: ${headerInline}`,
      `api_key = "${apiKeyForm}"`,
      liveSk
    ].join('\n');
    const redacted = redactSecrets(raw);
    for (const secret of [bearerToken, headerInline, apiKeyForm, liveSk]) {
      if (redacted.includes(secret)) throw new Error(`Case 41: ${secret} survived redaction.`);
    }
    if (!redacted.includes('[REDACTED]')) throw new Error('Case 41: no redaction marker.');
    // assertNoSecretLeak must reject every form even when the exact key is not
    // passed as the apiKey argument (pattern branch, not includes branch).
    const forms = [raw, `Bearer ${bearerToken}`, `x-api-key: ${headerInline}`, liveSk];
    for (const form of forms) {
      let threw = false;
      try {
        assertNoSecretLeak({ leaked: form }, '');
      } catch (error) {
        threw = String((error as Error).message).includes('MODEL_SERVICE_SECRET_LEAK');
      }
      if (!threw) throw new Error(`Case 41: assertNoSecretLeak missed form ${form}`);
    }
    passed++;
  }

  // --- Case 42: retry policy backoff math, jitter bounds, Retry-After
  // --- precedence, delay cap and attempt caps ---
  {
    const policy = resolveRetryPolicy({});
    if (policy.maxAttempts !== 4 || policy.baseDelayMs !== 200 || policy.backoffFactor !== 2) {
      throw new Error('Case 42: default policy mismatch.');
    }
    const neutral = computeBackoffDelayMs(policy, 1, undefined, () => 0.5);
    if (neutral !== 200) throw new Error(`Case 42: attempt1 expected 200, got ${neutral}`);
    const attempt3Low = computeBackoffDelayMs(policy, 3, undefined, () => 0);
    const attempt3High = computeBackoffDelayMs(policy, 3, undefined, () => 1);
    if (attempt3Low !== 720 || attempt3High !== 880) {
      throw new Error(`Case 42: jitter bounds expected [720,880], got [${attempt3Low},${attempt3High}]`);
    }
    const retryAfterWins = computeBackoffDelayMs(policy, 1, 5000, () => 0.5);
    if (retryAfterWins !== 5000) throw new Error('Case 42: Retry-After must dominate the computed delay.');
    const capped = computeBackoffDelayMs(
      resolveRetryPolicy({ baseDelayMs: 20_000, maxDelayMs: 30_000 }),
      3,
      undefined,
      () => 1
    );
    if (capped !== 30_000) throw new Error(`Case 42: delay cap expected 30000, got ${capped}`);
    if (resolveRetryPolicy({ maxAttempts: 500 }).maxAttempts !== 100) {
      throw new Error('Case 42: attempt cap must be 100.');
    }
    if (resolveRetryPolicy({ maxAttempts: 0 }).maxAttempts !== 1) {
      throw new Error('Case 42: attempt floor must be 1.');
    }
    passed++;
  }

  // --- Case 43: retryable whitelist + decideRetry budget / Retry-After ---
  {
    for (const code of [
      'MODEL_SERVICE_TIMEOUT',
      'MODEL_SERVICE_NETWORK_ERROR',
      'MODEL_SERVICE_RATE_LIMITED',
      'MODEL_SERVICE_SERVER_ERROR'
    ]) {
      if (!isRetryableErrorCode(code)) throw new Error(`Case 43: ${code} should be retryable.`);
    }
    for (const code of [
      'MODEL_SERVICE_CANCELLED',
      'MODEL_SERVICE_AUTH_ERROR',
      'MODEL_SERVICE_HTTP_ERROR',
      'MODEL_SERVICE_REQUEST_FAILED',
      'MODEL_SERVICE_RESPONSE_PARSE_FAILED'
    ]) {
      if (isRetryableErrorCode(code)) throw new Error(`Case 43: ${code} must not be retryable.`);
    }
    const policy = resolveRetryPolicy({ maxAttempts: 2 });
    const exhausted = decideRetry(
      [{ severity: 'error', code: 'MODEL_SERVICE_SERVER_ERROR', message: '' }],
      2,
      policy,
      () => 0.5
    );
    if (exhausted.retry || exhausted.code !== 'MODEL_SERVICE_SERVER_ERROR') {
      throw new Error('Case 43: budget-exhausted decision wrong.');
    }
    const rateLimited = decideRetry(
      [{ severity: 'error', code: 'MODEL_SERVICE_RATE_LIMITED', message: '', retryAfterMs: 3000 }],
      1,
      resolveRetryPolicy({ baseDelayMs: 100 }),
      () => 0.5
    );
    if (!rateLimited.retry || rateLimited.delayMs < 3000) {
      throw new Error('Case 43: Retry-After not honored by decideRetry.');
    }
    const nonRetryable = decideRetry(
      [{ severity: 'error', code: 'MODEL_SERVICE_AUTH_ERROR', message: '' }],
      1,
      policy,
      () => 0.5
    );
    if (nonRetryable.retry) throw new Error('Case 43: auth error must not retry.');
    passed++;
  }

  // --- Case 44: loop retry — two 500s then success: 3 hits, 2 audit retries,
  // --- retry-scheduled events, recovered final message ---
  {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      if (hits <= 2) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }] }));
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const events: AgentEvent[] = [];
      const result = await runAgentToolLoop(adapter, {
        config: makeConfig(port, 'openai-compatible'),
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        permissionMode: 'normal',
        executeTool: async () => ({ ok: false, content: 'unused' }),
        retryPolicy: { baseDelayMs: 1, maxAttempts: 4 },
        onEvent: (event) => {
          events.push(event);
        }
      });
      if (result.finishReason !== 'stop') throw new Error(`Case 44: expected stop, got ${result.finishReason}`);
      if (hits !== 3) throw new Error(`Case 44: expected 3 hits, got ${hits}`);
      if (!result.audit.retries || result.audit.retries.length !== 2) {
        throw new Error('Case 44: retry audit must record two retries.');
      }
      if (result.audit.retries[0]?.code !== 'MODEL_SERVICE_SERVER_ERROR') {
        throw new Error('Case 44: retry audit code wrong.');
      }
      if (events.filter((event) => event.type === 'retry-scheduled').length !== 2) {
        throw new Error('Case 44: retry-scheduled events missing.');
      }
      if (result.messages[result.messages.length - 1]?.content !== 'recovered') {
        throw new Error('Case 44: final message wrong.');
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 45: non-retryable 401 fails fast with exactly one hit ---
  {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'bad-key',
        model: 'test'
      });
      const result = await runAgentToolLoop(adapter, {
        config: makeConfig(port, 'openai-compatible'),
        apiKey: 'bad-key',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        permissionMode: 'normal',
        executeTool: async () => ({ ok: false, content: 'unused' }),
        retryPolicy: { baseDelayMs: 1, maxAttempts: 4 }
      });
      if (result.finishReason !== 'error') throw new Error('Case 45: expected error finish.');
      if (hits !== 1) throw new Error(`Case 45: auth failure must not retry, got ${hits} hits.`);
      if (!result.diagnostics.some((entry) => entry.code === 'MODEL_SERVICE_AUTH_ERROR')) {
        throw new Error('Case 45: auth code missing.');
      }
      if (result.audit.retries) throw new Error('Case 45: retry audit must be absent.');
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 46: parallel tool calls — supportsParallel tools overlap at
  // --- runtime; results recorded in model emission order; exclusive serial ---
  {
    let turn = 0;
    const fakeAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      async complete() {
        turn += 1;
        if (turn === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call-a', name: 'read_a', argumentsJson: '{"path":"a"}' },
                { id: 'call-b', name: 'read_b', argumentsJson: '{"path":"b"}' }
              ]
            },
            finishReason: 'tool_use',
            diagnostics: []
          };
        }
        if (turn === 2) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-c', name: 'write_c', argumentsJson: '{"path":"c"}' }]
            },
            finishReason: 'tool_use',
            diagnostics: []
          };
        }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', diagnostics: [] };
      },
      async *stream() {
        throw new Error('unused');
      }
    };
    let active = 0;
    let maxActive = 0;
    let releaseB: (() => void) | undefined;
    const bStarted = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const executed: string[] = [];
    const events: AgentEvent[] = [];
    const tools: ToolDefinition[] = [
      { name: 'read_a', description: 'r', parametersJsonSchema: { type: 'object' }, supportsParallel: true },
      { name: 'read_b', description: 'r', parametersJsonSchema: { type: 'object' }, supportsParallel: true },
      { name: 'write_c', description: 'w', parametersJsonSchema: { type: 'object' } }
    ];
    const result = await runAgentToolLoop(fakeAdapter, {
      config: makeConfig(9, 'openai-compatible'),
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'go' }],
      tools,
      permissionMode: 'normal',
      executeTool: async (call) => {
        executed.push(call.name);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (call.name === 'read_a') {
            const winner = await Promise.race([
              bStarted.then(() => 'b'),
              new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1500))
            ]);
            if (winner === 'timeout') throw new Error('Case 46: read_a/read_b did not overlap.');
          }
          if (call.name === 'read_b') releaseB?.();
        } finally {
          active -= 1;
        }
        return { ok: true, content: `${call.name}-result` };
      },
      onEvent: (event) => {
        events.push(event);
      }
    });
    if (result.finishReason !== 'stop') throw new Error(`Case 46: expected stop, got ${result.finishReason}`);
    if (maxActive !== 2) throw new Error(`Case 46: expected concurrent execution, maxActive=${maxActive}`);
    if (executed.join(',') !== 'read_a,read_b,write_c') {
      throw new Error(`Case 46: execution order wrong: ${executed.join(',')}`);
    }
    const toolMessageIds = result.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId);
    if (toolMessageIds.join(',') !== 'call-a,call-b,call-c') {
      throw new Error(`Case 46: recording order wrong: ${toolMessageIds.join(',')}`);
    }
    const begins = events.flatMap((event) => (event.type === 'tool-call-begin' ? [event.callId] : []));
    const ends = events.flatMap((event) => (event.type === 'tool-call-end' ? [event.callId] : []));
    if (begins.join(',') !== 'call-a,call-b,call-c' || ends.join(',') !== 'call-a,call-b,call-c') {
      throw new Error(`Case 46: tool span events wrong: begins=${begins.join(',')} ends=${ends.join(',')}`);
    }
    passed++;
  }

  // --- Case 47: streaming happy path — SSE deltas surface as
  // --- agent-message-delta events and assemble into the final message ---
  {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hel' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const events: AgentEvent[] = [];
      const result = await runAgentToolLoop(adapter, {
        config: makeConfig(port, 'openai-compatible'),
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        permissionMode: 'normal',
        executeTool: async () => ({ ok: false, content: 'unused' }),
        streaming: true,
        onEvent: (event) => {
          events.push(event);
        }
      });
      if (result.finishReason !== 'stop') throw new Error(`Case 47: expected stop, got ${result.finishReason}`);
      if (result.messages[result.messages.length - 1]?.content !== 'hello') {
        throw new Error('Case 47: streamed text not assembled.');
      }
      if (result.audit.streaming !== true) throw new Error('Case 47: audit.streaming missing.');
      const deltas = events.flatMap((event) => (event.type === 'agent-message-delta' ? [event.text] : []));
      if (deltas.join('|') !== 'hel|lo') throw new Error(`Case 47: deltas wrong: ${JSON.stringify(deltas)}`);
      for (const required of ['turn-started', 'step-complete', 'turn-complete']) {
        if (!events.some((event) => event.type === required)) {
          throw new Error(`Case 47: missing lifecycle event ${required}`);
        }
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 48: streaming tool_use — tool args accumulated across SSE chunks
  // --- drive one executed tool step with begin/end span events ---
  {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (hits === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-s', function: { name: 'read_s', arguments: '{"pa' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const seenCalls: ToolCall[] = [];
      const events: AgentEvent[] = [];
      const tools: ToolDefinition[] = [
        { name: 'read_s', description: 'r', parametersJsonSchema: { type: 'object' } }
      ];
      const result = await runAgentToolLoop(adapter, {
        config: makeConfig(port, 'openai-compatible'),
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'go' }],
        tools,
        permissionMode: 'normal',
        executeTool: async (call) => {
          seenCalls.push(call);
          return { ok: true, content: 's-result' };
        },
        streaming: true,
        onEvent: (event) => {
          events.push(event);
        }
      });
      if (result.finishReason !== 'stop') throw new Error(`Case 48: expected stop, got ${result.finishReason}`);
      if (seenCalls.length !== 1 || seenCalls[0]?.argumentsJson !== '{"path":"a"}') {
        throw new Error(`Case 48: streamed tool args not accumulated: ${JSON.stringify(seenCalls)}`);
      }
      const begins = events.flatMap((event) => (event.type === 'tool-call-begin' ? [event.callId] : []));
      const ends = events.flatMap((event) => (event.type === 'tool-call-end' ? [event.callId] : []));
      if (begins.join(',') !== 'call-s' || ends.join(',') !== 'call-s') {
        throw new Error('Case 48: tool span events missing.');
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 49: stream-level retry — first request 500, second succeeds ---
  {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('stream gateway down');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const port = await listen(server);
    try {
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'sk-test',
        model: 'test'
      });
      const result = await runAgentToolLoop(adapter, {
        config: makeConfig(port, 'openai-compatible'),
        apiKey: 'sk-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        permissionMode: 'normal',
        executeTool: async () => ({ ok: false, content: 'unused' }),
        streaming: true,
        retryPolicy: { baseDelayMs: 1 }
      });
      if (result.finishReason !== 'stop') throw new Error(`Case 49: expected stop, got ${result.finishReason}`);
      if (hits !== 2) throw new Error(`Case 49: expected 2 hits, got ${hits}`);
      if (!result.audit.retries || result.audit.retries.length !== 1) {
        throw new Error('Case 49: stream retry audit missing.');
      }
      passed++;
    } finally {
      await close(server);
    }
  }

  // --- Case 50: rollout roundtrip — meta + messages persisted, secrets never
  // --- durable, corrupt lines tolerated on resume ---
  {
    let turn = 0;
    const secret = 'sk-abcdefghij1234';
    const fakeAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      async complete() {
        turn += 1;
        if (turn === 1) {
          return {
            message: {
              role: 'assistant',
              content: `leak ${secret} here`,
              toolCalls: [{ id: 'call-r', name: 'read_r', argumentsJson: '{"path":"a"}' }]
            },
            finishReason: 'tool_use',
            diagnostics: []
          };
        }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', diagnostics: [] };
      },
      async *stream() {
        throw new Error('unused');
      }
    };
    const storage = new InMemoryRolloutStorage();
    const recorder = new RolloutRecorder(storage, {
      sessionId: 'sess-1',
      startedAt: new Date().toISOString(),
      configId: 'cfg-1',
      protocol: 'openai-compatible',
      permissionMode: 'normal'
    });
    const tools: ToolDefinition[] = [
      { name: 'read_r', description: 'r', parametersJsonSchema: { type: 'object' } }
    ];
    const result = await runAgentToolLoop(fakeAdapter, {
      config: makeConfig(9, 'openai-compatible'),
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'go' }],
      tools,
      permissionMode: 'normal',
      executeTool: async () => ({ ok: true, content: 'r-result' }),
      rollout: recorder
    });
    if (result.finishReason !== 'stop') throw new Error(`Case 50: expected stop, got ${result.finishReason}`);
    const lines = await storage.readLines();
    if (lines.some((line) => line.includes(secret))) {
      throw new Error('Case 50: secret leaked into rollout storage.');
    }
    const resumed = parseRolloutLines(lines);
    if (resumed.meta?.sessionId !== 'sess-1' || resumed.parseErrors !== 0) {
      throw new Error('Case 50: resume meta/parse wrong.');
    }
    if (resumed.messages.length < 2) throw new Error('Case 50: rollout messages missing.');
    const corrupted = [...lines];
    corrupted.splice(2, 0, '{{{not-json');
    const tolerant = parseRolloutLines(corrupted);
    if (tolerant.parseErrors !== 1 || tolerant.meta?.sessionId !== 'sess-1') {
      throw new Error('Case 50: corrupt line tolerance failed.');
    }
    await recorder.close();
    passed++;
  }

  // --- Case 51: rollback marker truncates logically without rewriting lines ---
  {
    const lines = [
      JSON.stringify({ type: 'session-meta', meta: { sessionId: 'sess-2', startedAt: 't0', configId: 'cfg', protocol: 'openai-compatible', permissionMode: 'normal' } }),
      JSON.stringify({ type: 'message', step: 1, message: { role: 'user', content: 'u1' } }),
      JSON.stringify({ type: 'message', step: 1, message: { role: 'assistant', content: 'a1' } }),
      JSON.stringify({ type: 'message', step: 2, message: { role: 'user', content: 'u2' } }),
      JSON.stringify({ type: 'message', step: 2, message: { role: 'assistant', content: 'a2' } }),
      JSON.stringify({ type: 'rollback-marker', at: 't1', keepLastUserTurns: 1 })
    ];
    const resumed = parseRolloutLines(lines);
    const contents = resumed.messages.map((message) => message.content).join(',');
    if (contents !== 'u2,a2') throw new Error(`Case 51: rollback truncation wrong: ${contents}`);
    if (resumed.meta?.sessionId !== 'sess-2') throw new Error('Case 51: meta lost after rollback.');
    passed++;
  }

  // --- Case 52: auto-compaction — history replaced by system + recent user
  // --- messages + prefixed summary, with audit entry and rollout checkpoint ---
  {
    let callNo = 0;
    const requests: ModelCompleteRequest[] = [];
    const compactAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      async complete(request) {
        callNo += 1;
        // Snapshot: the loop keeps a live reference to its messages array.
        requests.push({ ...request, messages: [...request.messages] });
        const last = request.messages[request.messages.length - 1];
        if (callNo === 1 && last?.content === DEFAULT_SUMMARIZATION_PROMPT) {
          return {
            message: { role: 'assistant', content: '摘要：任务X 已完成。' },
            finishReason: 'stop',
            diagnostics: []
          };
        }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', diagnostics: [] };
      },
      async *stream() {
        throw new Error('unused');
      }
    };
    const storage = new InMemoryRolloutStorage();
    const recorder = new RolloutRecorder(storage, {
      sessionId: 'sess-3',
      startedAt: new Date().toISOString(),
      configId: 'cfg',
      protocol: 'openai-compatible',
      permissionMode: 'normal'
    });
    const events: AgentEvent[] = [];
    const result = await runAgentToolLoop(compactAdapter, {
      config: makeConfig(9, 'openai-compatible'),
      apiKey: 'sk-test',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'older question' },
        { role: 'assistant', content: 'older answer' },
        { role: 'user', content: 'newer question' }
      ],
      tools: [],
      permissionMode: 'normal',
      executeTool: async () => ({ ok: false, content: 'unused' }),
      compaction: { autoCompactTokenLimit: 1 },
      rollout: recorder,
      onEvent: (event) => {
        events.push(event);
      }
    });
    if (result.finishReason !== 'stop') throw new Error(`Case 52: expected stop, got ${result.finishReason}`);
    if (
      !result.audit.compactions ||
      result.audit.compactions.length !== 1 ||
      result.audit.compactions[0]?.reason !== 'auto' ||
      result.audit.compactions[0]?.summaryBytes === 0
    ) {
      throw new Error('Case 52: compaction audit missing.');
    }
    if (requests.length !== 2) throw new Error(`Case 52: expected 2 model calls, got ${requests.length}`);
    const summaryRequest = requests[0];
    if (summaryRequest?.messages[summaryRequest.messages.length - 1]?.content !== DEFAULT_SUMMARIZATION_PROMPT) {
      throw new Error('Case 52: summarization prompt not sent.');
    }
    const mainRequest = requests[1];
    const mainContents = (mainRequest?.messages ?? []).map((message) => message.content);
    if (!mainContents.includes('SYS')) throw new Error('Case 52: system context dropped.');
    if (mainContents.some((content) => content.includes('older answer'))) {
      throw new Error('Case 52: assistant history must be compacted away.');
    }
    const lastMain = mainRequest?.messages[(mainRequest?.messages.length ?? 0) - 1];
    if (!lastMain || !lastMain.content.startsWith(DEFAULT_SUMMARY_PREFIX)) {
      throw new Error('Case 52: prefixed summary message missing.');
    }
    if (!events.some((event) => event.type === 'context-compacted')) {
      throw new Error('Case 52: context-compacted event missing.');
    }
    if (!result.diagnostics.some((entry) => entry.code === 'CONTEXT_COMPACTION_APPLIED')) {
      throw new Error('Case 52: compaction diagnostic missing.');
    }
    const durable = await storage.readLines();
    if (!durable.some((line) => line.includes('"type":"compacted"'))) {
      throw new Error('Case 52: rollout compaction checkpoint missing.');
    }
    await recorder.close();
    passed++;
  }

  // --- Case 53: compaction fails closed — failing summary requests keep the
  // --- original history and surface COMPACTION_SUMMARY_FAILED ---
  {
    const failingAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      async complete(request) {
        const last = request.messages[request.messages.length - 1];
        if (last?.content === DEFAULT_SUMMARIZATION_PROMPT) {
          return {
            message: { role: 'assistant', content: '' },
            finishReason: 'error',
            diagnostics: [{ severity: 'error', code: 'MODEL_SERVICE_SERVER_ERROR', message: 'summary unavailable' }]
          };
        }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', diagnostics: [] };
      },
      async *stream() {
        throw new Error('unused');
      }
    };
    const result = await runAgentToolLoop(failingAdapter, {
      config: makeConfig(9, 'openai-compatible'),
      apiKey: 'sk-test',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'older question' },
        { role: 'assistant', content: 'older answer' }
      ],
      tools: [],
      permissionMode: 'normal',
      executeTool: async () => ({ ok: false, content: 'unused' }),
      compaction: { autoCompactTokenLimit: 1 }
    });
    if (result.finishReason !== 'stop') throw new Error(`Case 53: expected stop, got ${result.finishReason}`);
    if (result.audit.compactions) {
      throw new Error('Case 53: failed compaction must not be audited as applied.');
    }
    if (!result.diagnostics.some((entry) => entry.code === 'COMPACTION_SUMMARY_FAILED')) {
      throw new Error('Case 53: COMPACTION_SUMMARY_FAILED missing.');
    }
    if (!result.messages.some((message) => message.content.includes('older answer'))) {
      throw new Error('Case 53: original history must survive fail-closed.');
    }
    passed++;
  }

  // --- Case 54: agent tool bridge — production registry surfaces as agent
  // --- loop tools with parallel policy; typed results map to loop contract ---
  {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_thing',
      description: 'read',
      permission: 'read',
      permissionLevel: 'read',
      run: () => ({ ok: true, data: { value: 42 } })
    });
    registry.register({
      name: 'propose_thing',
      description: 'propose',
      permission: 'propose',
      permissionLevel: 'propose',
      run: () => ({ ok: false, error: { code: 'WRITE_GATE_CLOSED', message: 'writer unavailable' } })
    });
    const bridge = createAgentToolBridge({
      registry,
      context: { workspaceIndex: {} as never, mode: 'fullPermission' }
    });
    const byName = new Map(bridge.tools.map((tool) => [tool.name, tool]));
    if (byName.get('read_thing')?.supportsParallel !== true) {
      throw new Error('Case 54: read tool must be parallel-capable.');
    }
    if (byName.get('propose_thing')?.supportsParallel !== false) {
      throw new Error('Case 54: propose tool must stay exclusive.');
    }
    const okCall = await bridge.executeTool({ id: 'c1', name: 'read_thing', argumentsJson: '{"q":"x"}' });
    if (!okCall.ok || !okCall.content.includes('42')) throw new Error('Case 54: ok mapping wrong.');
    const failCall = await bridge.executeTool({ id: 'c2', name: 'propose_thing', argumentsJson: '{"t":"y"}' });
    if (failCall.ok || failCall.code !== 'WRITE_GATE_CLOSED') throw new Error('Case 54: error mapping wrong.');
    const badJson = await bridge.executeTool({ id: 'c3', name: 'read_thing', argumentsJson: '{oops' });
    if (badJson.ok || badJson.code !== 'TOOL_INPUT_INVALID') {
      throw new Error('Case 54: invalid JSON must surface as TOOL_INPUT_INVALID.');
    }
    passed++;
  }

  // --- Case 55: production registry input validation — declared shapes are
  // --- enforced before handlers; undeclared extras stay ignored ---
  {
    if (validateToolInput({ query: 'string' }, {}).ok) {
      throw new Error('Case 55: missing required field must fail.');
    }
    if (validateToolInput({ limit: 'number' }, { limit: 'many' }).ok) {
      throw new Error('Case 55: wrong type must fail.');
    }
    if (!validateToolInput({ category: 'string?' }, {}).ok) {
      throw new Error('Case 55: absent optional must pass.');
    }
    if (!validateToolInput({ query: 'string' }, { query: 'x', chainContext: 'marker' }).ok) {
      throw new Error('Case 55: undeclared extras must be ignored.');
    }
    if (validateToolInput({ query: 'string' }, 'plain').ok) {
      throw new Error('Case 55: non-object input must fail.');
    }
    const registry = new ToolRegistry();
    registry.register({
      name: 'guarded_tool',
      description: 'g',
      permission: 'read',
      permissionLevel: 'read',
      inputSchema: { query: 'string' },
      run: () => ({ ok: true, data: 'ran' })
    });
    const rejected = await registry.run('guarded_tool', {}, { workspaceIndex: {} as never, mode: 'normal' });
    if (rejected.ok || rejected.error?.code !== 'INVALID_INPUT') {
      throw new Error('Case 55: registry must reject invalid input with INVALID_INPUT.');
    }
    const accepted = await registry.run('guarded_tool', { query: 'x' }, { workspaceIndex: {} as never, mode: 'normal' });
    if (!accepted.ok) throw new Error('Case 55: valid input must run.');
    passed++;
  }

  // --- Case 56: file rollout storage — append-only roundtrip, flush, close,
  // --- Codex-style sessions/YYYY/MM/DD path layout ---
  {
    const base = await mkdtemp(join(tmpdir(), 'soulforge-rollout-fs-'));
    try {
      const fixedDate = new Date('2026-08-04T01:02:03.456Z');
      const filePath = newRolloutFilePath(base, 'sess-fs', fixedDate);
      if (!filePath.includes(join('sessions', '2026', '08', '04')) || !filePath.endsWith('sess-fs.jsonl')) {
        throw new Error(`Case 56: path layout wrong: ${filePath}`);
      }
      const storage = new FileRolloutStorage(filePath);
      await storage.appendLines(['{"a":1}', '{"b":2}']);
      await storage.appendLines(['{"c":3}']);
      await storage.flush();
      const lines = await storage.readLines();
      if (lines.join('|') !== '{"a":1}|{"b":2}|{"c":3}') {
        throw new Error(`Case 56: append/read roundtrip wrong: ${JSON.stringify(lines)}`);
      }
      await storage.close();
      let threw = false;
      try {
        await storage.appendLines(['x']);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error('Case 56: append after close must throw.');
      passed++;
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  // --- Case 57: agent session host end-to-end — rollout persisted with the
  // --- user prompt, list/load resume, history seeds the follow-up run ---
  {
    const base = await mkdtemp(join(tmpdir(), 'soulforge-agent-host-'));
    try {
      let turn = 0;
      const seenRequests: ModelCompleteRequest[] = [];
      const hostAdapter: ModelServiceAdapter = {
        protocol: 'openai-compatible',
        async complete(request) {
          turn += 1;
          seenRequests.push({ ...request, messages: [...request.messages] });
          if (turn === 1) {
            return {
              message: {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-h', name: 'read_h', argumentsJson: '{"p":"a"}' }]
              },
              finishReason: 'tool_use',
              diagnostics: []
            };
          }
          return { message: { role: 'assistant', content: 'host-done' }, finishReason: 'stop', diagnostics: [] };
        },
        async *stream() {
          throw new Error('unused');
        }
      };
      const events: AgentEvent[] = [];
      const config = makeConfig(9, 'openai-compatible');
      const first = await runAgentSession({
        sessionsDir: base,
        adapter: hostAdapter,
        config,
        apiKey: 'sk-test',
        prompt: 'first question',
        permissionMode: 'normal',
        tools: [{ name: 'read_h', description: 'r', parametersJsonSchema: { type: 'object' } }],
        executeTool: async () => ({ ok: true, content: 'h-result' }),
        onEvent: (event) => {
          events.push(event);
        }
      });
      if (first.run.finishReason !== 'stop') throw new Error(`Case 57: ${first.run.finishReason}`);
      if (!events.some((event) => event.type === 'turn-complete')) {
        throw new Error('Case 57: lifecycle events missing.');
      }
      const listed = await listRolloutSessions(base);
      if (listed.length !== 1 || listed[0]?.sessionId !== first.sessionId) {
        throw new Error('Case 57: session listing wrong.');
      }
      const loaded = await loadRolloutSession(first.rolloutPath);
      if (!loaded.ok) throw new Error('Case 57: load failed.');
      if (!loaded.messages.some((message) => message.content === 'first question')) {
        throw new Error('Case 57: user prompt must be recorded.');
      }
      const { ok: _loadedOk, path: _loadedPath, ...resumed } = loaded;
      const second = await runAgentSession({
        sessionsDir: base,
        adapter: hostAdapter,
        config,
        apiKey: 'sk-test',
        prompt: 'follow-up',
        permissionMode: 'normal',
        tools: [],
        executeTool: async () => ({ ok: false, content: 'unused' }),
        resumeFrom: resumed
      });
      if (second.run.finishReason !== 'stop') throw new Error(`Case 57: resume run ${second.run.finishReason}`);
      const resumeRequest = seenRequests[seenRequests.length - 1];
      const resumeContents = (resumeRequest?.messages ?? []).map((message) => message.content);
      if (
        !resumeContents.includes('first question')
        || !resumeContents.includes('host-done')
        || !resumeContents.includes('follow-up')
      ) {
        throw new Error('Case 57: resumed history must seed the next run.');
      }
      passed++;
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  // --- Case 58: session cancellation — pre-aborted signal yields 'cancelled'
  // --- and a durable interrupted marker in the rollout ---
  {
    const base = await mkdtemp(join(tmpdir(), 'soulforge-agent-cancel-'));
    try {
      const controller = new AbortController();
      controller.abort();
      const config = makeConfig(9, 'openai-compatible');
      const result = await runAgentSession({
        sessionsDir: base,
        adapter: {
          protocol: 'openai-compatible',
          async complete() {
            return { message: { role: 'assistant', content: 'never' }, finishReason: 'stop', diagnostics: [] };
          },
          async *stream() {
            throw new Error('unused');
          }
        },
        config,
        apiKey: 'sk-test',
        prompt: 'cancelled question',
        permissionMode: 'normal',
        tools: [],
        executeTool: async () => ({ ok: false, content: 'unused' }),
        signal: controller.signal
      });
      if (result.run.finishReason !== 'cancelled') throw new Error(`Case 58: ${result.run.finishReason}`);
      const loaded = await loadRolloutSession(result.rolloutPath);
      if (!loaded.ok || !loaded.interrupted) throw new Error('Case 58: interrupted marker missing.');
      passed++;
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'AI 双协议错误/取消/超时/限额矩阵 + 真实 SSE 流式（含流式取消/超时/错误分类）+ 脱敏矩阵 + Context Broker 证据装配 + 真实工作区多步 typed mutation 写矩阵 + Codex 派生内核（重试退避/并行工具/流式事件/rollout 持久化/上下文压缩）+ production 接线（工具桥/输入校验/文件 rollout/会话宿主）conformance 验证通过',
    passed,
    total,
    nonClaims: [
      '离线 conformance 不证明任何第三方真实服务可用。',
      'Anthropic 真实 SSE 只在本机确定性 contract server 上验证事件解析/取消/超时/错误分类；第三方流式事件形状差异不属于 V0.5 验收。',
      'MODEL_SERVICE_CANCELLED 区分主动取消与超时是 conformance 层的错误码语义；不影响真实 provider 行为。',
      '写矩阵只覆盖实际接线的安全写路径（scaffold text_edit + WorkspaceTransaction），不提升 native writer authority 或 Patch Engine authority。',
      'plan 只读在 agent loop 层强制；policy gate 层按既有 architecture scaffold 契约保留 stage/validate 上限。',
      'normal 模式的确认语义为：commit 被结构化拒绝，经用户确认升级后才经 Patch Engine 提交。',
      'Context Broker 是离线可测的 evidence 装配层；其真实 provider 侧接入（第三方模型上下文窗口、真实工作区索引来源）不属于 V0.5 验收。',
      'Codex 派生内核（重试退避、并行工具、流式事件、rollout、compaction）参考 openai/codex（Apache-2.0）设计重写；离线矩阵不证明与 Codex 行为逐位一致，也不提升 provider 或 native authority。',
      'production 接线（agentToolBridge、文件 rollout、session host、desktop IPC/preload 契约）由 typecheck/build + 本 smoke 的 fake adapter/registry 验证；未经真实 provider 端到端运行，renderer agent 任务面板归前端 Agent。',
      '真实 provider 凭据不属于 V0.5 验收。'
    ]
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
