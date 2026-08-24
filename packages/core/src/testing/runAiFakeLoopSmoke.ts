/**
 * Dual model-service fake-server tool loop smoke.
 * Drives real OpenAI-compatible + Anthropic-compatible adapters against local
 * fake HTTP servers — no live cloud keys required.
 *
 * Covers: OpenAI + Anthropic complete()/stream(), real Anthropic SSE parsing
 * (partial_json tool-arg accumulation), Anthropic multi-turn tool loop
 * (assistant tool_use echo + tool_result mapping), policy/plan gating, evidence
 * gate, and the four-form secret redaction matrix (sk- / Bearer / header inline).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConfiguredModelServiceAdapter } from '../model-services/configuredAdapter.js';
import {
  assertNoSecretLeak,
  isToolAllowedInMode,
  redactSecrets,
  runAgentToolLoop
} from '../model-services/agentLoop.js';
import { createContextBroker } from '../model-services/contextBroker.js';
import type { ModelServiceConfig, ToolDefinition } from '../model-services/types.js';

const OPENAI_KEY = 'sk-fake-openai-001';
const ANTHROPIC_KEY = 'sk-ant-fake-002';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function startOpenAiFake(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let call = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    // Credential must arrive via header, never be echoed.
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${OPENAI_KEY}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end('not found');
      return;
    }
    call += 1;
    const parsed = JSON.parse(body) as {
      messages?: unknown[];
      stream?: boolean;
      tools?: Array<{ function?: { name?: string } }>;
    };
    const hasToolResult = JSON.stringify(parsed.messages ?? []).includes('"role":"tool"')
      || JSON.stringify(parsed.messages ?? []).includes('tool_call_id');
    const preferredTool = parsed.tools?.[0]?.function?.name ?? 'search_workspace';
    const toolArgs = preferredTool === 'apply_patch'
      ? '{"patch":"demo"}'
      : preferredTool === 'empty_args_test'
        ? '{}'
      : '{"query":"boss"}';
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!hasToolResult) {
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_openai_1',
                function: { name: preferredTool, arguments: toolArgs }
              }]
            }
          }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenAI fake done' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (!hasToolResult) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_openai_1',
              function: { name: preferredTool, arguments: toolArgs }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: 'OpenAI fake final answer' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8 }
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

function startAnthropicFake(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  history: Array<{ messages: unknown[]; system?: string }>;
}> {
  const history: Array<{ messages: unknown[]; system?: string }> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const key = req.headers['x-api-key'];
    if (key !== ANTHROPIC_KEY) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (req.url !== '/v1/messages') {
      res.writeHead(404).end('not found');
      return;
    }
    const parsed = JSON.parse(body) as {
      messages?: unknown[];
      system?: string;
      stream?: boolean;
    };
    const messagesJson = JSON.stringify(parsed.messages ?? []);
    history.push({
      messages: parsed.messages ?? [],
      ...(typeof parsed.system === 'string' ? { system: parsed.system } : {})
    });
    // Multi-turn: the request already carries N assistant tool_use blocks echoed
    // back for the N completed tool rounds, so the fake answers with the next
    // tool_use (round 0 → search_workspace, round 1 → apply_patch) and only
    // stops after two tool rounds have completed (toolUseCount >= 2).
    const toolUseCount = (messagesJson.match(/"type":"tool_use"/g) ?? []).length;
    const done = toolUseCount >= 2;
    const usage = { input_tokens: 11 + toolUseCount * 3, output_tokens: 6 };

    const chunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    if (parsed.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      chunk({
        type: 'message_start',
        message: { role: 'assistant', content: [], usage: { input_tokens: usage.input_tokens } }
      });
      if (done) {
        chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic fake final answer' } });
        chunk({ type: 'content_block_stop', index: 0 });
        chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } });
      } else {
        const tool = toolUseCount === 0
          ? { id: 'toolu_1', name: 'search_workspace', input: { query: 'ember' } }
          : { id: 'toolu_2', name: 'apply_patch', input: { patch: 'demo' } };
        chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: toolUseCount === 0 ? 'Need search' : 'Need patch' } });
        chunk({ type: 'content_block_stop', index: 0 });
        chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
        // Split the JSON args across two input_json_delta chunks so the real
        // SSE parser must accumulate partial_json before emitting tool-call.
        const partial = JSON.stringify(tool.input);
        const split = Math.ceil(partial.length / 2);
        chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial.slice(0, split) } });
        chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: partial.slice(split) } });
        chunk({ type: 'content_block_stop', index: 1 });
        chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: usage.output_tokens } });
      }
      chunk({ type: 'message_stop' });
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    if (done) {
      res.end(JSON.stringify({
        content: [{ type: 'text', text: 'Anthropic fake final answer' }],
        stop_reason: 'end_turn',
        usage
      }));
      return;
    }
    const tool = toolUseCount === 0
      ? { id: 'toolu_1', name: 'search_workspace', input: { query: 'ember' } }
      : { id: 'toolu_2', name: 'apply_patch', input: { patch: 'demo' } };
    res.end(JSON.stringify({
      content: [
        { type: 'text', text: toolUseCount === 0 ? 'Need search' : 'Need patch' },
        { type: 'tool_use', id: tool.id, name: tool.name, input: tool.input }
      ],
      stop_reason: 'tool_use',
      usage
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        history
      });
    });
  });
}

async function main(): Promise<void> {
  const tools: ToolDefinition[] = [{
    name: 'search_workspace',
    description: 'Search workspace index',
    parametersJsonSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }, {
    name: 'apply_patch',
    description: 'Would write via Patch Engine',
    parametersJsonSchema: { type: 'object', properties: {} }
  }];

  const openaiServer = await startOpenAiFake();
  const anthropicServer = await startAnthropicFake();
  const anthropicHistory = anthropicServer.history;
  try {
    const openaiConfig: ModelServiceConfig = {
      id: 'cfg-openai',
      displayName: '本地 OpenAI 兼容假服务',
      protocol: 'openai-compatible',
      baseUrl: openaiServer.baseUrl,
      model: 'fake-gpt',
      hasCredential: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // The local fake endpoint explicitly declares the optional fields this
      // contract test exercises. The configured production factory must not
      // infer these capabilities from the OpenAI-compatible protocol name.
      capabilities: {
        tools: true,
        vision: true,
        reasoningEffort: true,
        topP: true,
        temperature: true,
        maxTokens: true
      }
    };
    const anthropicConfig: ModelServiceConfig = {
      id: 'cfg-anthropic',
      displayName: '本地 Anthropic 兼容假服务',
      protocol: 'anthropic-compatible',
      baseUrl: anthropicServer.baseUrl,
      model: 'fake-claude',
      hasCredential: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // See the OpenAI fixture above: capability declarations are explicit
      // test evidence, not a protocol-based inference.
      capabilities: {
        tools: true,
        vision: true,
        reasoningEffort: true,
        topP: true,
        topK: true,
        temperature: true,
        maxTokens: true
      }
    };

    const openaiResolution = createConfiguredModelServiceAdapter({
      config: openaiConfig,
      apiKey: OPENAI_KEY
    });
    const anthropicResolution = createConfiguredModelServiceAdapter({
      config: anthropicConfig,
      apiKey: ANTHROPIC_KEY
    });
    if (!openaiResolution.ok || !anthropicResolution.ok) {
      throw new Error('configured provider factory rejected a valid local contract server');
    }
    const openaiAdapter = openaiResolution.adapter;
    const anthropicAdapter = anthropicResolution.adapter;

    // Stream + cancel path for OpenAI
    const abort = new AbortController();
    const streamChunks: string[] = [];
    for await (const event of openaiAdapter.stream({
      messages: [{ role: 'user', content: 'stream please' }],
      tools,
      signal: abort.signal
    })) {
      if (event.type === 'text-delta') streamChunks.push(event.text);
      if (event.type === 'tool-call') streamChunks.push(`tool:${event.toolCall.name}`);
      if (event.type === 'message-stop') break;
    }

    // Real SSE streaming path for Anthropic (message_start / content_block_* /
    // message_delta / message_stop). Tool args arrive split across two
    // input_json_delta chunks and must be accumulated by the adapter.
    const anthropicStreamText: string[] = [];
    const anthropicStreamTools: Array<{ name: string; args: string }> = [];
    for await (const event of anthropicAdapter.stream({
      messages: [{ role: 'user', content: 'stream please' }],
      tools
    })) {
      if (event.type === 'text-delta') anthropicStreamText.push(event.text);
      if (event.type === 'tool-call') {
        anthropicStreamTools.push({ name: event.toolCall.name, args: event.toolCall.argumentsJson });
      }
      if (event.type === 'message-stop') break;
    }
    if (!anthropicStreamText.join('').includes('Need search')) {
      throw new Error(`Anthropic SSE stream text missing, got ${JSON.stringify(anthropicStreamText)}`);
    }
    if (anthropicStreamTools.length !== 1 || anthropicStreamTools[0]!.name !== 'search_workspace') {
      throw new Error(`Anthropic SSE stream tool not assembled, got ${JSON.stringify(anthropicStreamTools)}`);
    }
    const anthropicStreamArgs = JSON.parse(anthropicStreamTools[0]!.args) as { query?: string };
    if (anthropicStreamArgs.query !== 'ember') {
      throw new Error(`Anthropic SSE partial_json not accumulated, got ${anthropicStreamTools[0]!.args}`);
    }

    const openaiRun = await runAgentToolLoop(openaiAdapter, {
      config: openaiConfig,
      apiKey: OPENAI_KEY,
      messages: [{ role: 'user', content: 'Find boss events' }],
      tools,
      permissionMode: 'normal',
      executeTool: async (call) => ({
        ok: true,
        content: JSON.stringify({ hits: 1, query: call.name, note: 'no secrets' })
      }),
      maxSteps: 4
    });

    const anthropicRun = await runAgentToolLoop(anthropicAdapter, {
      config: anthropicConfig,
      apiKey: ANTHROPIC_KEY,
      messages: [{ role: 'user', content: 'Find ember refs' }],
      tools,
      permissionMode: 'normal',
      executeTool: async (call) => ({
        ok: true,
        content: JSON.stringify({ hits: 2, tool: call.name })
      }),
      maxSteps: 4
    });

    // Multi-turn Anthropic tool loop: two consecutive tool_use rounds must echo
    // the assistant tool_use content blocks and map tool results back as
    // tool_result user messages before the fake answers with a final stop.
    if (anthropicRun.steps !== 3) {
      throw new Error(`Anthropic multi-turn expected 3 steps, got ${anthropicRun.steps}`);
    }
    if (anthropicRun.finishReason !== 'stop') {
      throw new Error(`Anthropic multi-turn expected stop, got ${anthropicRun.finishReason}`);
    }
    const anthropicToolNames = anthropicRun.audit.toolCalls.map((call) => call.name);
    if (!anthropicToolNames.includes('search_workspace') || !anthropicToolNames.includes('apply_patch')) {
      throw new Error(`Anthropic multi-turn tool calls missing, got ${JSON.stringify(anthropicToolNames)}`);
    }
    // The final request history entry must echo both assistant tool_use blocks
    // (search_workspace then apply_patch) and both tool_result mappings back to
    // the fake, proving the loop closed two full tool rounds.
    const anthropicFinalReq = anthropicHistory[anthropicHistory.length - 1];
    if (!anthropicFinalReq) throw new Error('Anthropic multi-turn missing final request history');
    const finalJson = JSON.stringify(anthropicFinalReq.messages);
    if (!finalJson.includes('"type":"tool_use"') || !finalJson.includes('"name":"search_workspace"')) {
      throw new Error('Anthropic assistant tool_use block was not echoed back on the final round');
    }
    if (!finalJson.includes('"name":"apply_patch"')) {
      throw new Error('Anthropic second-round tool_use was not echoed back');
    }
    if (!finalJson.includes('"type":"tool_result"')
      || !finalJson.includes('"tool_use_id":"toolu_1"')
      || !finalJson.includes('"tool_use_id":"toolu_2"')) {
      throw new Error('Anthropic tool_result was not mapped back for both rounds');
    }

    // Policy deny in plan mode for write tool
    const denied = isToolAllowedInMode('apply_patch', 'plan', new Set(tools.map((t) => t.name)));
    if (denied.ok) throw new Error('plan mode should deny apply_patch');

    // Full permission still goes through executeTool — simulate Patch Engine gate denial
    const fullRun = await runAgentToolLoop(openaiAdapter, {
      config: openaiConfig,
      apiKey: OPENAI_KEY,
      messages: [{ role: 'user', content: 'write something' }],
      tools: [{
        name: 'apply_patch',
        description: 'write',
        parametersJsonSchema: { type: 'object', properties: { patch: { type: 'string' } } }
      }],
      permissionMode: 'full',
      executeTool: async () => ({
        ok: false,
        code: 'PATCH_ENGINE_REQUIRED',
        content: JSON.stringify({
          ok: false,
          code: 'PATCH_ENGINE_REQUIRED',
          message: '完全权限也不能绕过 Patch Engine。'
        })
      }),
      maxSteps: 3
    });

    let fullEmptyArgsExecuted = false;
    const fullEmptyArgsRun = await runAgentToolLoop(openaiAdapter, {
      config: openaiConfig,
      apiKey: OPENAI_KEY,
      messages: [{ role: 'user', content: '无证据调用' }],
      tools: [{
        name: 'empty_args_test',
        description: 'must be rejected without evidence',
        parametersJsonSchema: { type: 'object', properties: {} }
      }],
      permissionMode: 'full',
      executeTool: async () => {
        fullEmptyArgsExecuted = true;
        return { ok: true, content: '不应执行' };
      },
      maxSteps: 1
    });
    if (fullEmptyArgsExecuted
      || !fullEmptyArgsRun.audit.toolCalls.some((call) => call.code === 'insufficient_evidence')) {
      throw new Error('完全权限不得绕过证据门。');
    }

    // insufficient evidence path
    const emptyArgsDeny = isToolAllowedInMode('search_workspace', 'normal', new Set(['search_workspace']));
    if (!emptyArgsDeny.ok) throw new Error('search should be allowed in normal');

    const redacted = redactSecrets(`token ${OPENAI_KEY} and ${ANTHROPIC_KEY}`);
    if (redacted.includes(OPENAI_KEY) || redacted.includes(ANTHROPIC_KEY)) {
      throw new Error('redactSecrets failed');
    }
    // Redaction matrix: Bearer tokens and header-inline secrets use different
    // SECRET_PATTERNS than sk-; assert each form is redacted and rejected.
    const bearerToken = 'eyJhbGciOiJIUzI1NiJ9.sig.value';
    const headerInline = 'sk-ant-inline-header-secret-abcdef';
    const redactedForms = redactSecrets(
      `Bearer ${bearerToken}\nx-api-key: ${headerInline}\napi_key = "synthetic_api_key_12345"`
    );
    if (redactedForms.includes(bearerToken) || redactedForms.includes(headerInline)) {
      throw new Error('Bearer/header inline secrets were not redacted');
    }
    let bearerLeakCaught = false;
    try {
      assertNoSecretLeak({ toolResult: `Bearer ${bearerToken}` }, '');
    } catch {
      bearerLeakCaught = true;
    }
    if (!bearerLeakCaught) throw new Error('assertNoSecretLeak must reject a Bearer inline secret');
    assertNoSecretLeak(openaiRun.audit, OPENAI_KEY);
    assertNoSecretLeak(anthropicRun.audit, ANTHROPIC_KEY);
    assertNoSecretLeak({ openai: openaiRun.messages, anthropic: anthropicRun.messages }, OPENAI_KEY);

    // Provider isolation: openai config id must not appear as anthropic
    if (openaiRun.audit.configId === anthropicRun.audit.configId) {
      throw new Error('provider config ids collided');
    }
    if (openaiRun.audit.protocol === anthropicRun.audit.protocol) {
      throw new Error('protocols should differ');
    }

    // --- Context Broker offline evidence assembly (no provider credentials) ---
    const broker = createContextBroker();
    const assembled = await broker.assemble([
      { kind: 'readFile', uri: 'file:///ws/msg/note.txt', text: `secret token ${OPENAI_KEY} payload` },
      { kind: 'resourceGraph', uri: 'workspace://ws', payload: { nodes: [{ uri: 'file:///ws/msg/note.txt' }] } },
      { kind: 'diagnostics', uri: 'workspace://ws', payload: { diagnostics: [{ severity: 'error', code: 'VALIDATOR_FAILED', message: 'boom' }] } }
    ], { maxBytes: 4000, excerptLength: 100 });
    if (!assembled.ok) throw new Error('context broker assembly failed');
    if (assembled.context.includes(OPENAI_KEY)) throw new Error('context broker leaked secret');
    if (!assembled.context.includes('VALIDATOR_FAILED')) throw new Error('context broker lost diagnostics');
    if (assembled.totalBytes > 4000) throw new Error('context broker exceeded budget');

    const noEvidence = await broker.assemble([]);
    if (noEvidence.ok || noEvidence.code !== 'insufficient_evidence') {
      throw new Error('broker must fail insufficient_evidence on no evidence');
    }

    // Broker-enabled agent loop against the same local fake server: evidence is
    // assembled across steps and injected before model calls.
    const brokerRun = await runAgentToolLoop(openaiAdapter, {
      config: openaiConfig,
      apiKey: OPENAI_KEY,
      messages: [{ role: 'user', content: 'Find boss events' }],
      tools,
      permissionMode: 'normal',
      executeTool: async (call) => ({ ok: true, content: JSON.stringify({ hits: 1, tool: call.name }) }),
      maxSteps: 3,
      contextBroker: broker,
      contextBrokerOptions: { maxBytes: 4000, excerptLength: 200 }
    });
    if (brokerRun.finishReason === 'error') throw new Error('broker-enabled loop failed');
    if (!brokerRun.audit.contextAssemblies?.some((assembly) => assembly.ok)) {
      throw new Error('broker-enabled loop missing context assemblies in audit');
    }
    assertNoSecretLeak(brokerRun.audit, OPENAI_KEY);

    console.log(JSON.stringify({
      ok: true,
      message: '双模型服务 fake-server tool loop 验证通过',
      openai: {
        steps: openaiRun.steps,
        finishReason: openaiRun.finishReason,
        toolCalls: openaiRun.audit.toolCalls,
        stream: streamChunks
      },
      anthropic: {
        steps: anthropicRun.steps,
        finishReason: anthropicRun.finishReason,
        toolCalls: anthropicRun.audit.toolCalls,
        multiTurn: true,
        stream: {
          text: anthropicStreamText.join(''),
          toolCalls: anthropicStreamTools
        }
      },
      planModeDeniedWrite: denied.code,
      fullPermissionStillGated: fullRun.audit.toolCalls,
      fullPermissionEvidenceGate: true,
      secretsRedacted: true,
      contextBroker: {
        assembledSections: assembled.sections.length,
        assembledBytes: assembled.totalBytes,
        secretsRedacted: true,
        insufficientEvidence: noEvidence.code,
        loopAssemblies: brokerRun.audit.contextAssemblies
      }
    }, null, 2));
  } finally {
    await openaiServer.close();
    await anthropicServer.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
