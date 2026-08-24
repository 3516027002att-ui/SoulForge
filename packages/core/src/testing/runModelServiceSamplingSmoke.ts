/**
 * 采样/能力参数（temperature / topP / topK / maxTokens / thinkingLevel）在三个
 * 适配器请求体里的协议映射 smoke。用 mock fetch 捕获请求体断言，不发真实网络。
 *
 * 锁的是 2026-08-19 对照官方文档核实的 effort 档位：
 * - OpenAI Chat Completions：reasoning_effort 官方值原样下发（none/minimal/low/medium/
 *   high/xhigh/max），off → 字段缺席；max 不得折成 high；topK 不下发（协议无此字段）。
 * - OpenAI Responses：reasoning: { effort } 同上但 maxTokens→max_output_tokens。
 * - Anthropic：output_config: { effort }（low/medium/high/xhigh/max），off → 字段缺席；
 *   禁止再发 thinking.budget_tokens 冒充 effort；temperature/top_p/top_k 原样下发。
 * - 遗留档 fast/normal/deep/extreme 只在读路径兼容映射（见 migrateThinkingLevel /
 *   resolveOpenAiReasoningEffort / resolveAnthropicEffort），不写入新请求。
 *
 * 断言失败必须红：captureFetch 里的 expect 抛错会先被适配器的 fetch 错误路径吞掉
 * （classifyFetchError → errorResult），所以每次 complete() 之后还必须断言结果里
 * 没有 error diagnostic——否则「把 max 折回 high」这种扰动只会让断言数变少、进程
 * 仍以 0 退出（假门禁）。
 */
import {
  AnthropicCompatibleAdapter,
  createConfiguredModelServiceAdapter,
  OpenAiCompatibleAdapter,
  OpenAiResponsesAdapter
} from '../model-services/index.js';
import type {
  ChatMessage,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelServiceAdapter,
  ModelServiceConfig
} from '../model-services/types.js';
import {
  migrateThinkingLevel,
  resolveAnthropicEffort,
  resolveOpenAiReasoningEffort
} from '../model-services/types.js';

function captureFetch(assertBody: (body: Record<string, unknown>) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/v1/chat/completions') && !url.endsWith('/v1/messages') && !url.endsWith('/v1/responses')) {
      throw new Error(`unexpected URL in sampling smoke: ${url}`);
    }
    assertBody(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      }),
      text: async () => ''
    } as unknown as Response;
  }) as typeof fetch;
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const baseRequest = { messages } satisfies ModelCompleteRequest;

let checked = 0;
function expect(condition: boolean, label: string): void {
  checked += 1;
  if (!condition) throw new Error(`sampling smoke assertion failed: ${label}`);
}

/**
 * 跑一次 complete() 并断言结果没有 error diagnostic。
 * 适配器会把 captureFetch 里断言抛出的错误吞成 errorResult（classifyFetchError），
 * 因此只在 assertBody 里 expect 不够：错误被吞后进程仍会以 0 退出。这里把「结果
 * 里出现 error diagnostic」也判为断言失败，保证扰动真的红。
 */
async function completeAndCheck(
  adapter: ModelServiceAdapter,
  request: ModelCompleteRequest,
  label: string
): Promise<ModelCompleteResult> {
  const result = await adapter.complete(request);
  if (result.diagnostics.length > 0) {
    throw new Error(`sampling smoke: ${label} → adapter returned error diagnostic: `
      + (result.diagnostics[0]?.message ?? 'unknown'));
  }
  return result;
}

async function main(): Promise<void> {
  // 1. OpenAI chat：完整参数 + max 思考；max 必须原样下发（禁止折成 high）；
  //    topK 必须不下发。
  await completeAndCheck(new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.temperature === 0.7, 'openai temperature');
      expect(body.top_p === 0.9, 'openai top_p');
      expect(body.reasoning_effort === 'max', 'openai max -> reasoning_effort max (not high)');
      expect(body.max_tokens === 2048, 'openai max_tokens');
      expect(body.top_k === undefined, 'openai must not send top_k');
    })
  }), { ...baseRequest, temperature: 0.7, topP: 0.9, maxTokens: 2048, topK: 5, thinkingLevel: 'max' }, 'openai max');

  // 2. OpenAI chat：xhigh / none / minimal 官方值原样下发；off → 不下发；缺省字段不下发。
  await completeAndCheck(new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.reasoning_effort === 'xhigh', 'openai xhigh -> reasoning_effort xhigh');
      expect(body.max_tokens === undefined, 'openai no maxTokens -> absent');
      expect(body.temperature === undefined, 'openai no temperature -> absent');
    })
  }), { ...baseRequest, thinkingLevel: 'xhigh' }, 'openai xhigh');
  await completeAndCheck(new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.reasoning_effort === 'none', 'openai none -> reasoning_effort none');
    })
  }), { ...baseRequest, thinkingLevel: 'none' }, 'openai none');
  await completeAndCheck(new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.reasoning_effort === 'minimal', 'openai minimal -> reasoning_effort minimal');
    })
  }), { ...baseRequest, thinkingLevel: 'minimal' }, 'openai minimal');
  await completeAndCheck(new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.reasoning_effort === undefined, 'openai off -> absent');
    })
  }), { ...baseRequest, thinkingLevel: 'off' }, 'openai off');

  // 2-A. Explicitly negotiated capability negatives must suppress optional
  // fields instead of assuming every OpenAI-compatible endpoint is official.
  await completeAndCheck(new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.tools === undefined, 'capabilities.tools=false omits tools');
      expect(body.reasoning_effort === undefined, 'capabilities.reasoningEffort=false omits reasoning');
      expect(body.temperature === undefined, 'capabilities.temperature=false omits temperature');
      expect(body.top_p === undefined, 'capabilities.topP=false omits top_p');
      expect(body.max_tokens === undefined, 'capabilities.maxTokens=false omits max_tokens');
    })
  }), {
    ...baseRequest,
    tools: [{ name: 'probe', description: 'probe', parametersJsonSchema: { type: 'object' } }],
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
    thinkingLevel: 'high',
    capabilities: {
      tools: false,
      reasoningEffort: false,
      temperature: false,
      topP: false,
      maxTokens: false
    }
  }, 'openai explicit capability negatives');

  // 2-B. Production factory path: an absent declaration is not treated as
  // official OpenAI support. The strict adapter omits every optional field and
  // exposes the fail-closed provenance for audit/debugging.
  const factoryFailClosed = createConfiguredModelServiceAdapter({
    config: {
      id: 'strict-factory',
      displayName: 'strict factory',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:3000',
      model: 'model-a',
      hasCredential: true,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z'
    } satisfies ModelServiceConfig,
    apiKey: 'k',
    fetchImpl: captureFetch((body) => {
      expect(body.tools === undefined, 'factory missing tools capability fails closed');
      expect(body.temperature === undefined, 'factory missing temperature capability fails closed');
      expect(body.top_p === undefined, 'factory missing topP capability fails closed');
      expect(body.max_tokens === undefined, 'factory missing maxTokens capability fails closed');
      expect(body.reasoning_effort === undefined, 'factory missing reasoning capability fails closed');
      const message = (body.messages as Array<{ content?: unknown }>)[0];
      expect(typeof message?.content === 'string', 'factory missing vision capability omits image parts');
    })
  });
  if (!factoryFailClosed.ok) throw new Error('strict factory configuration unexpectedly rejected');
  expect(
    factoryFailClosed.adapter.capabilityState?.policy === 'explicit-or-fail-closed',
    'configured factory enables explicit-or-fail-closed policy'
  );
  expect(
    factoryFailClosed.adapter.capabilityState?.sources.tools === 'fail-closed',
    'missing factory capability is labeled fail-closed, not negotiated'
  );
  await completeAndCheck(factoryFailClosed.adapter, {
    ...baseRequest,
    messages: [{
      role: 'user',
      content: 'hi',
      images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }]
    }],
    tools: [{ name: 'probe', description: 'probe', parametersJsonSchema: { type: 'object' } }],
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
    thinkingLevel: 'high'
  }, 'factory fail-closed capabilities');

  // 2-C. The same fail-closed policy is protocol independent. Direct adapter
  // construction opts into it explicitly here; direct adapters without the
  // policy retain legacy mapping for compatibility-only callers.
  await completeAndCheck(new OpenAiResponsesAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    capabilityPolicy: 'explicit-or-fail-closed',
    fetchImpl: captureFetch((body) => {
      expect(body.tools === undefined, 'responses missing tools capability fails closed');
      expect(body.reasoning === undefined, 'responses missing reasoning capability fails closed');
      expect(body.temperature === undefined, 'responses missing temperature capability fails closed');
      expect(body.max_output_tokens === undefined, 'responses missing maxTokens capability fails closed');
      expect(body.top_p === undefined, 'responses missing topP capability fails closed');
      const input = (body.input as Array<{ content?: unknown }>)[0];
      expect(Array.isArray(input?.content) === false, 'responses missing vision capability omits image parts');
    })
  }), {
    ...baseRequest,
    messages: [{
      role: 'user',
      content: 'hi',
      images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }]
    }],
    tools: [{ name: 'probe', description: 'probe', parametersJsonSchema: { type: 'object' } }],
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
    thinkingLevel: 'high'
  }, 'responses fail-closed capabilities');

  await completeAndCheck(new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-b',
    capabilityPolicy: 'explicit-or-fail-closed',
    fetchImpl: captureFetch((body) => {
      expect(body.tools === undefined, 'anthropic missing tools capability fails closed');
      expect(body.output_config === undefined, 'anthropic missing reasoning capability fails closed');
      expect(body.temperature === undefined, 'anthropic missing temperature capability fails closed');
      expect(body.top_p === undefined, 'anthropic missing topP capability fails closed');
      expect(body.top_k === undefined, 'anthropic missing topK capability fails closed');
      expect(body.max_tokens === 1024, 'anthropic required max_tokens remains protocol-required');
      const message = (body.messages as Array<{ content?: unknown }>)[0];
      expect(typeof message?.content === 'string', 'anthropic missing vision capability omits image parts');
    })
  }), {
    ...baseRequest,
    messages: [{
      role: 'user',
      content: 'hi',
      images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }]
    }],
    tools: [{ name: 'probe', description: 'probe', parametersJsonSchema: { type: 'object' } }],
    temperature: 0.7,
    topP: 0.9,
    topK: 5,
    thinkingLevel: 'high'
  }, 'anthropic fail-closed capabilities');

  // 2-D. Explicit config is a declaration, not an automatic probe result;
  // true fields are allowed while an explicit false remains suppressed.
  const configuredFactory = createConfiguredModelServiceAdapter({
    config: {
      id: 'configured-factory',
      displayName: 'configured factory',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:3000',
      model: 'model-a',
      hasCredential: true,
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      capabilities: {
        tools: true,
        vision: true,
        reasoningEffort: false,
        temperature: true,
        topP: true,
        maxTokens: true
      }
    } satisfies ModelServiceConfig,
    apiKey: 'k',
    fetchImpl: captureFetch((body) => {
      expect(body.tools !== undefined, 'explicit config tools=true is honored');
      expect(body.temperature === 0.7, 'explicit config temperature=true is honored');
      expect(body.top_p === 0.9, 'explicit config topP=true is honored');
      expect(body.max_tokens === 2048, 'explicit config maxTokens=true is honored');
      expect(body.reasoning_effort === undefined, 'explicit config reasoningEffort=false is honored');
      const message = (body.messages as Array<{ content?: unknown }>)[0];
      expect(Array.isArray(message?.content), 'explicit config vision=true is honored');
    })
  });
  if (!configuredFactory.ok) throw new Error('explicit capability factory configuration rejected');
  expect(
    configuredFactory.adapter.capabilityState?.sources.tools === 'explicit-config',
    'explicit config provenance is preserved'
  );
  await completeAndCheck(configuredFactory.adapter, {
    ...baseRequest,
    messages: [{
      role: 'user',
      content: 'hi',
      images: [{ mediaType: 'image/png', dataBase64: 'AAAA' }]
    }],
    tools: [{ name: 'probe', description: 'probe', parametersJsonSchema: { type: 'object' } }],
    temperature: 0.7,
    topP: 0.9,
    maxTokens: 2048,
    thinkingLevel: 'high'
  }, 'factory explicit capabilities');

  // 3. OpenAI Responses：max → reasoning.effort max；medium → reasoning.effort medium；
  //    maxTokens → max_output_tokens。
  await completeAndCheck(new OpenAiResponsesAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      const reasoning = body.reasoning as { effort?: string } | undefined;
      expect(reasoning?.effort === 'max', 'responses max -> reasoning.effort max');
      expect(body.max_output_tokens === 4096, 'responses max_output_tokens');
      expect(body.top_p === 0.8, 'responses top_p');
    })
  }), { ...baseRequest, thinkingLevel: 'max', maxTokens: 4096, topP: 0.8 }, 'responses max');
  await completeAndCheck(new OpenAiResponsesAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      const reasoning = body.reasoning as { effort?: string } | undefined;
      expect(reasoning?.effort === 'medium', 'responses medium -> reasoning.effort medium');
    })
  }), { ...baseRequest, thinkingLevel: 'medium' }, 'responses medium');

  // 4. Anthropic：max 思考 → output_config.effort max；不得再发 thinking.budget_tokens；
  //    temperature/top_p/top_k 原样下发。
  await completeAndCheck(new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-b',
    fetchImpl: captureFetch((body) => {
      const outputConfig = body.output_config as { effort?: string } | undefined;
      expect(outputConfig?.effort === 'max', 'anthropic max -> output_config.effort max');
      expect(body.thinking === undefined, 'anthropic must not send thinking.budget_tokens');
      expect(body.temperature === 0.7, 'anthropic temperature kept');
      expect(body.top_p === 0.9, 'anthropic top_p');
      expect(body.top_k === 5, 'anthropic top_k');
      expect(body.max_tokens === 30000, 'anthropic explicit maxTokens kept');
    })
  }), { ...baseRequest, thinkingLevel: 'max', topP: 0.9, topK: 5, temperature: 0.7, maxTokens: 30000 }, 'anthropic max');

  // 5. Anthropic：xhigh / low / medium / high 原样下发；off → 无 output_config 块。
  await completeAndCheck(new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-b',
    fetchImpl: captureFetch((body) => {
      const outputConfig = body.output_config as { effort?: string } | undefined;
      expect(outputConfig?.effort === 'xhigh', 'anthropic xhigh -> output_config.effort xhigh');
    })
  }), { ...baseRequest, thinkingLevel: 'xhigh' }, 'anthropic xhigh');
  await completeAndCheck(new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-b',
    fetchImpl: captureFetch((body) => {
      expect(body.temperature === 1.2, 'anthropic off -> temperature sent');
      expect(body.max_tokens === 1024, 'anthropic default max_tokens');
      expect(body.output_config === undefined, 'anthropic off -> no output_config block');
      expect(body.thinking === undefined, 'anthropic off -> no thinking block');
    })
  }), { ...baseRequest, temperature: 1.2, thinkingLevel: 'off' }, 'anthropic off');

  // 6. 读路径遗留档兼容映射（不写入请求，只在解析旧配置时转换）。
  expect(migrateThinkingLevel('fast') === 'low', 'legacy fast -> low');
  expect(migrateThinkingLevel('normal') === 'medium', 'legacy normal -> medium');
  expect(migrateThinkingLevel('deep') === 'high', 'legacy deep -> high');
  expect(migrateThinkingLevel('extreme') === 'max', 'legacy extreme -> max');
  expect(resolveOpenAiReasoningEffort('deep') === 'high', 'resolve legacy deep -> high');
  expect(resolveOpenAiReasoningEffort('extreme') === 'max', 'resolve legacy extreme -> max (not high)');
  expect(resolveAnthropicEffort('extreme') === 'max', 'resolve anthropic legacy extreme -> max');

  console.log(JSON.stringify({
    ok: true,
    status: 'fixture-confirmed',
    assertions: checked,
    protocols: ['openai-compatible', 'openai-responses', 'anthropic-compatible'],
    coveredMappings: [
      'temperature / top_p / top_k / max_tokens|max_output_tokens',
      'reasoning_effort none|minimal|low|medium|high|xhigh|max (openai)',
      'reasoning: { effort } (openai responses)',
      'output_config: { effort low|medium|high|xhigh|max } + off omits (anthropic)',
      'max never folded to high; budget_tokens never sent as effort',
      'legacy read-path mapping fast->low / normal->medium / deep->high / extreme->max'
    ],
    nonClaims: [
      'Mock-fetch body mapping does not prove any real provider accepts these fields.',
      'No network request was made; provider-side validation is outside this smoke.',
      'Configured production adapters do not auto-probe; absent capability declarations are fail-closed.',
      'Model-specific support for some effort levels remains model-dependent; the UI shows the full official ladder.'
    ]
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
