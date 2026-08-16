/**
 * 采样/能力参数（temperature / topP / topK / maxTokens / thinkingLevel）在三个
 * 适配器请求体里的协议映射 smoke。用 mock fetch 捕获请求体断言，不发真实网络。
 *
 * 覆盖的映射规则：
 * - OpenAI Chat Completions：temperature→temperature、topP→top_p、
 *   thinkingLevel→reasoning_effort（fast→low / normal→medium / deep·extreme→high）、
 *   maxTokens→max_tokens；topK 不下发（协议无此字段）。
 * - OpenAI Responses：同上但 maxTokens→max_output_tokens、思考走 reasoning.effort。
 * - Anthropic：temperature→temperature（thinking 启用时省略）、topP→top_p、
 *   topK→top_k、thinking→thinking.budget_tokens（2048/4096/8192/16384）、
 *   max_tokens = max(配置值, budget×2)（Anthropic 要求 max_tokens > budget）。
 */
import {
  AnthropicCompatibleAdapter,
  OpenAiCompatibleAdapter,
  OpenAiResponsesAdapter
} from '../model-services/index.js';
import type { ChatMessage, ModelCompleteRequest } from '../model-services/types.js';

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

async function main(): Promise<void> {
  // 1. OpenAI chat：完整参数 + fast 思考；topK 必须不下发。
  await new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.temperature === 0.7, 'openai temperature');
      expect(body.top_p === 0.9, 'openai top_p');
      expect(body.reasoning_effort === 'low', 'openai fast -> reasoning_effort low');
      expect(body.max_tokens === 2048, 'openai max_tokens');
      expect(body.top_k === undefined, 'openai must not send top_k');
    })
  }).complete({ ...baseRequest, temperature: 0.7, topP: 0.9, maxTokens: 2048, topK: 5, thinkingLevel: 'fast' });

  // 2. OpenAI chat：extreme → high；off → 不下发；缺省字段不下发。
  await new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.reasoning_effort === 'high', 'openai extreme -> high');
      expect(body.max_tokens === undefined, 'openai no maxTokens -> absent');
      expect(body.temperature === undefined, 'openai no temperature -> absent');
    })
  }).complete({ ...baseRequest, thinkingLevel: 'extreme' });
  await new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      expect(body.reasoning_effort === undefined, 'openai off -> absent');
    })
  }).complete({ ...baseRequest, thinkingLevel: 'off' });

  // 3. OpenAI Responses：normal → reasoning.effort medium；maxTokens → max_output_tokens。
  await new OpenAiResponsesAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-a',
    fetchImpl: captureFetch((body) => {
      const reasoning = body.reasoning as { effort?: string } | undefined;
      expect(reasoning?.effort === 'medium', 'responses normal -> reasoning.effort medium');
      expect(body.max_output_tokens === 4096, 'responses max_output_tokens');
      expect(body.top_p === 0.8, 'responses top_p');
    })
  }).complete({ ...baseRequest, thinkingLevel: 'normal', maxTokens: 4096, topP: 0.8 });

  // 4. Anthropic：normal 思考 → thinking budget 4096、temperature 省略（Anthropic
  //    要求=1，省略即默认 1）、max_tokens = max(1024, 4096×2) = 8192、top_p/top_k 下发。
  await new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-b',
    fetchImpl: captureFetch((body) => {
      const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
      expect(thinking?.type === 'enabled' && thinking?.budget_tokens === 4096,
        'anthropic normal -> thinking budget 4096');
      expect(body.temperature === undefined, 'anthropic thinking -> temperature omitted');
      expect(body.max_tokens === 8192, 'anthropic thinking -> max_tokens = budget*2');
      expect(body.top_p === 0.9, 'anthropic top_p');
      expect(body.top_k === 5, 'anthropic top_k');
    })
  }).complete({ ...baseRequest, thinkingLevel: 'normal', topP: 0.9, topK: 5 });

  // 5. Anthropic：无思考 → temperature 原样下发、max_tokens 默认 1024、无 thinking 块。
  await new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-b',
    fetchImpl: captureFetch((body) => {
      expect(body.temperature === 1.2, 'anthropic no thinking -> temperature sent');
      expect(body.max_tokens === 1024, 'anthropic default max_tokens');
      expect(body.thinking === undefined, 'anthropic off -> no thinking block');
    })
  }).complete({ ...baseRequest, temperature: 1.2, thinkingLevel: 'off' });

  // 6. Anthropic：thinking + 显式 maxTokens 30000 → 保持 30000（配置值优先，仍 > budget×2）。
  await new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-b',
    fetchImpl: captureFetch((body) => {
      const thinking = body.thinking as { budget_tokens?: number } | undefined;
      expect(body.max_tokens === 30000, 'anthropic explicit maxTokens kept');
      expect(thinking?.budget_tokens === 2048, 'anthropic fast -> budget 2048');
    })
  }).complete({ ...baseRequest, thinkingLevel: 'fast', maxTokens: 30000 });

  // 7. Anthropic：extreme → budget 16384、max_tokens = 32768。
  await new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'model-b',
    fetchImpl: captureFetch((body) => {
      const thinking = body.thinking as { budget_tokens?: number } | undefined;
      expect(thinking?.budget_tokens === 16384, 'anthropic extreme -> budget 16384');
      expect(body.max_tokens === 32768, 'anthropic extreme -> max_tokens 32768');
    })
  }).complete({ ...baseRequest, thinkingLevel: 'extreme' });

  console.log(JSON.stringify({
    ok: true,
    status: 'fixture-confirmed',
    assertions: checked,
    protocols: ['openai-compatible', 'openai-responses', 'anthropic-compatible'],
    coveredMappings: [
      'temperature / top_p / top_k / max_tokens|max_output_tokens',
      'reasoning_effort low|medium|high (openai)',
      'thinking budget_tokens 2048|4096|8192|16384 + temperature omitted + max_tokens > budget (anthropic)',
      'top_k never sent on openai-compatible'
    ],
    nonClaims: [
      'Mock-fetch body mapping does not prove any real provider accepts these fields.',
      'No network request was made; provider-side validation is outside this smoke.'
    ]
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
