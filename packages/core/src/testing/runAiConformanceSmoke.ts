/**
 * Smoke: AI dual-protocol error/cancel/timeout/limit conformance matrix.
 *
 * Covers:
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
 * All cases use local fake HTTP servers or injected fetch failures.
 * No real provider credentials or network access required.
 *
 * Authority cap: partial; offline conformance does not prove third-party
 * service availability or native mutation authority.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  OpenAiCompatibleAdapter
} from '../model-services/openaiCompatibleAdapter.js';
import {
  AnthropicCompatibleAdapter
} from '../model-services/anthropicCompatibleAdapter.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import type { ModelServiceConfig, ToolCall, ModelServiceAdapter } from '../model-services/types.js';

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

async function main(): Promise<void> {
  let passed = 0;
  const total = 10;

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
      if (result.diagnostics[0]!.code !== 'MODEL_SERVICE_TIMEOUT') {
        throw new Error(`expected TIMEOUT (abort), got ${result.diagnostics[0]!.code}`);
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

  console.log(JSON.stringify({
    ok: true,
    message: 'AI 双协议错误/取消/超时/限额 conformance 矩阵验证通过',
    passed,
    total,
    nonClaims: [
      '离线 conformance 不证明任何第三方真实服务可用。',
      '不提升 native mutation authority 或 Patch Engine authority。',
      '真实 provider 凭据不属于 V0.5 验收。'
    ]
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
