/**
 * OpenAI Responses adapter smoke against a local fake /v1/responses server.
 */
import http from 'node:http';
import { OpenAiResponsesAdapter } from '../model-services/openaiResponsesAdapter.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import type { ModelServiceConfig, ToolDefinition } from '../model-services/types.js';

const API_KEY = 'sk-fake-responses-001';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startResponsesFake(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  stats: () => {
    maxRejected: number;
    observedEfforts: string[];
    nestedFunctionCallRejected: number;
    topLevelFunctionCallSeen: number;
  };
}> {
  return new Promise((resolve, reject) => {
    let maxRejected = 0;
    let nestedFunctionCallRejected = 0;
    let topLevelFunctionCallSeen = 0;
    const observedEfforts: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.endsWith('/v1/responses')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: { stream?: boolean; input?: unknown[]; reasoning?: { effort?: string } } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
        } catch {
          res.writeHead(400);
          res.end('bad json');
          return;
        }
        const effort = body.reasoning?.effort;
        if (effort !== undefined) observedEfforts.push(effort);
        if (effort === 'max') {
          maxRejected += 1;
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              param: 'reasoning.effort',
              type: 'invalid_request_error',
              message: 'unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`'
            }
          }));
          return;
        }
        const inputItems = Array.isArray(body.input) ? body.input : [];
        const hasNestedFunctionCall = inputItems.some((item) => {
          if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) {
            return false;
          }
          return item.content.some((part) => isRecord(part) && part.type === 'function_call');
        });
        if (hasNestedFunctionCall) {
          nestedFunctionCallRejected += 1;
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              param: 'input[2].content',
              type: 'invalid_request_error',
              message: 'function_call must be a top-level input item, not a message content part'
            }
          }));
          return;
        }
        if (inputItems.some((item) => isRecord(item) && item.type === 'function_call')) {
          topLevelFunctionCallSeen += 1;
        }
        const hasEmptyFunctionCallName = inputItems.some((item) =>
          isRecord(item)
          && item.type === 'function_call'
          && (typeof item.name !== 'string' || item.name.trim().length === 0)
        );
        if (hasEmptyFunctionCallName) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              param: 'name',
              type: 'invalid_request_error',
              message: 'function_call name must be non-empty'
            }
          }));
          return;
        }
        const hasToolResult = inputItems.some(
          (item) => isRecord(item) && item.type === 'function_call_output'
        );
        if (body.stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          });
          if (!hasToolResult) {
            res.write(`data: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'Responses stream '
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              type: 'response.function_call_arguments.delta',
              item_id: 'fc_1',
              name: 'search_workspace',
              delta: '{"query":"boss"}'
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'search_workspace',
                arguments: '{"query":"boss"}'
              }
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              type: 'response.completed',
              response: { usage: { input_tokens: 10, output_tokens: 5 } }
            })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'done via responses'
            })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`);
          }
          res.end();
          return;
        }
        // non-stream
        if (!hasToolResult) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'planning' }]
              },
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'search_workspace',
                arguments: '{"query":"gate"}'
              }
            ],
            usage: { input_tokens: 12, output_tokens: 8 }
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'completed',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Responses final answer' }]
          }],
          usage: { input_tokens: 20, output_tokens: 4 }
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        stats: () => ({
          maxRejected,
          observedEfforts: [...observedEfforts],
          nestedFunctionCallRejected,
          topLevelFunctionCallSeen
        })
      });
    });
  });
}

async function main(): Promise<void> {
  const tools: ToolDefinition[] = [{
    name: 'search_workspace',
    description: 'Search workspace',
    parametersJsonSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }];
  const server = await startResponsesFake();
  try {
    const adapter = new OpenAiResponsesAdapter({
      baseUrl: server.baseUrl,
      apiKey: API_KEY,
      model: 'fake-responses'
    });
    const config: ModelServiceConfig = {
      id: 'cfg-responses',
      displayName: '本地 OpenAI Responses 假服务',
      protocol: 'openai-compatible',
      baseUrl: server.baseUrl,
      model: 'fake-responses',
      hasCredential: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const direct = await adapter.complete({
      messages: [{ role: 'user', content: 'complete' }],
      thinkingLevel: 'max'
    });
    if (direct.finishReason === 'error') {
      throw new Error(`complete reasoning fallback failed: ${JSON.stringify(direct.diagnostics)}`);
    }

    const streamText: string[] = [];
    let streamTool = false;
    for await (const event of adapter.stream({
      messages: [{ role: 'user', content: 'stream' }],
      tools,
      thinkingLevel: 'max'
    })) {
      if (event.type === 'text-delta') streamText.push(event.text);
      if (event.type === 'tool-call') streamTool = true;
      if (event.type === 'message-stop') break;
    }

    const run = await runAgentToolLoop(adapter, {
      config,
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'Find gates' }],
      tools,
      permissionMode: 'normal',
      executeTool: async (call) => ({
        ok: true,
        content: JSON.stringify({ hits: 1, tool: call.name })
      }),
      maxSteps: 4,
      streaming: true
    });

    if (!streamText.join('').includes('Responses') && !streamTool) {
      throw new Error('stream did not produce text or tool');
    }
    if (run.finishReason === 'error') {
      throw new Error(`agent loop failed: ${JSON.stringify(run.diagnostics)}`);
    }
    if (JSON.stringify(run.audit).includes(API_KEY)) {
      throw new Error('API key leaked into audit');
    }
    if (!run.messages.some((m) => m.role === 'assistant')) {
      throw new Error('no assistant message');
    }
    const stats = server.stats();
    if (stats.maxRejected !== 2 || !stats.observedEfforts.includes('xhigh')) {
      throw new Error(`reasoning fallback was not exercised: ${JSON.stringify(stats)}`);
    }
    if (stats.nestedFunctionCallRejected !== 0 || stats.topLevelFunctionCallSeen < 1) {
      throw new Error(`Responses tool-call input shape was not normalized: ${JSON.stringify(stats)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'OpenAI Responses adapter 流式 + tool loop 验证通过',
      transport: adapter.transport,
      streamTool,
      streamText: streamText.join(''),
      reasoningFallback: stats.observedEfforts,
      steps: run.steps,
      finishReason: run.finishReason
    }, null, 2));
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
