/**
 * 模型列表拉取（GET /v1/models）smoke：mock fetch 断言三个适配器对
 * `{ data: [{ id, display_name }] }` 的解析、非法条目过滤与错误分类。
 * 不发真实网络。
 */
import {
  AnthropicCompatibleAdapter,
  OpenAiCompatibleAdapter,
  OpenAiResponsesAdapter
} from '../model-services/index.js';
import type { ModelListResult } from '../model-services/types.js';

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    if (method !== 'GET' || !url.endsWith('/v1/models')) {
      throw new Error(`unexpected request in list-models smoke: ${method} ${url}`);
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    } as unknown as Response;
  }) as typeof fetch;
}

function failingFetch(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as typeof fetch;
}

let checked = 0;
function expect(condition: boolean, label: string): void {
  checked += 1;
  if (!condition) throw new Error(`list-models smoke assertion failed: ${label}`);
}

async function main(): Promise<void> {
  const validPayload = {
    data: [
      { id: 'model-a' },
      { id: 'model-b', display_name: '模型 B' },
      { id: '' },
      { id: 42 },
      { object: 'model', id: 'model-c' }
    ]
  };

  // 1. OpenAI chat：合法条目保留、display_name 投影、非法条目过滤。
  const openAiResult = await new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'x',
    fetchImpl: jsonFetch(validPayload)
  }).listModels();
  expect(openAiResult.ok, 'openai listModels ok');
  if (openAiResult.ok) {
    expect(openAiResult.models.length === 3, 'openai filters invalid entries');
    expect(openAiResult.models[0]?.id === 'model-a', 'openai first model id');
    expect(openAiResult.models[1]?.displayName === '模型 B', 'openai display_name projection');
    expect(openAiResult.models[2]?.id === 'model-c', 'openai keeps object entries with id');
  }

  // 2. Anthropic：同样解析。
  const anthropicResult = await new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'x',
    fetchImpl: jsonFetch(validPayload)
  }).listModels();
  expect(anthropicResult.ok, 'anthropic listModels ok');
  if (anthropicResult.ok) {
    expect(anthropicResult.models.length === 3, 'anthropic filters invalid entries');
  }

  // 3. OpenAI Responses：同样解析。
  const responsesResult = await new OpenAiResponsesAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'x',
    fetchImpl: jsonFetch(validPayload)
  }).listModels();
  expect(responsesResult.ok, 'responses listModels ok');
  if (responsesResult.ok) {
    expect(responsesResult.models.length === 3, 'responses filters invalid entries');
  }

  // 4. 401 → 结构化 AUTH 错误。
  const authResult = await new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'bad',
    model: 'x',
    fetchImpl: jsonFetch({ error: { message: 'invalid key' } }, 401)
  }).listModels();
  expect(!authResult.ok, '401 -> not ok');
  if (!authResult.ok) expect(authResult.error.code === 'MODEL_SERVICE_AUTH_ERROR', '401 -> AUTH_ERROR code');

  // 5. 网络异常 → 结构化 NETWORK 错误（不吞异常）。真实 fetch 拒绝连接抛 TypeError；
  //    其他异常归 REQUEST_FAILED，同样结构化返回。
  const networkResult = await new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'x',
    fetchImpl: failingFetch(new TypeError('fetch failed (synthetic ECONNREFUSED)'))
  }).listModels();
  expect(!networkResult.ok, 'network failure -> not ok');
  if (!networkResult.ok) {
    expect(networkResult.error.code === 'MODEL_SERVICE_NETWORK_ERROR', 'network -> NETWORK_ERROR code');
  }
  const requestFailedResult = await new AnthropicCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'x',
    fetchImpl: failingFetch(new Error('unexpected harness failure'))
  }).listModels();
  expect(!requestFailedResult.ok, 'generic failure -> not ok');
  if (!requestFailedResult.ok) {
    expect(requestFailedResult.error.code === 'MODEL_SERVICE_REQUEST_FAILED', 'generic -> REQUEST_FAILED code');
  }

  // 6. 响应体不是 JSON → 结构化 PARSE 错误。
  const parseResult = await new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'x',
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => { throw new SyntaxError('Unexpected token'); },
      text: async () => 'not-json'
    }) as unknown as Response) as typeof fetch
  }).listModels();
  expect(!parseResult.ok, 'bad json -> not ok');
  if (!parseResult.ok) {
    expect(parseResult.error.code === 'MODEL_SERVICE_RESPONSE_PARSE_FAILED', 'bad json -> PARSE code');
  }

  // 7. 空 data → ok 且空列表（不是错误）。
  const emptyResult = await new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'k',
    model: 'x',
    fetchImpl: jsonFetch({ data: [] })
  }).listModels() as Extract<ModelListResult, { ok: true }>;
  expect(emptyResult.ok, 'empty data -> ok');
  expect(emptyResult.models.length === 0, 'empty data -> empty list');

  console.log(JSON.stringify({
    ok: true,
    status: 'fixture-confirmed',
    assertions: checked,
    protocols: ['openai-compatible', 'openai-responses', 'anthropic-compatible'],
    endpoint: 'GET {baseUrl}/v1/models',
    errorCodes: [
      'MODEL_SERVICE_AUTH_ERROR (401)',
      'MODEL_SERVICE_NETWORK_ERROR (fetch TypeError)',
      'MODEL_SERVICE_REQUEST_FAILED (generic exception)',
      'MODEL_SERVICE_RESPONSE_PARSE_FAILED (invalid json)'
    ],
    nonClaims: [
      'Mock responses do not prove any real provider serves /v1/models with this shape.',
      'No network request was made; provider availability is outside this smoke.'
    ]
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
