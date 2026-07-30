import { createConfiguredModelServiceAdapter } from '../model-services/configuredAdapter.js';
import type { ModelServiceConfig, ModelServiceProtocol } from '../model-services/types.js';

let networkAttempts = 0;
const forbiddenFetch: typeof fetch = async () => {
  networkAttempts += 1;
  throw new Error('network must not be reached by configuration validation');
};

const cases: Array<{
  name: string;
  config?: ModelServiceConfig | null;
  apiKey?: string | null;
  expectedStatus: 'unconfigured' | 'invalid-configuration';
  expectedCode: string;
}> = [
  {
    name: 'missing config',
    config: null,
    apiKey: null,
    expectedStatus: 'unconfigured',
    expectedCode: 'MODEL_SERVICE_UNCONFIGURED'
  },
  {
    name: 'empty endpoint and model',
    config: buildConfig('openai-compatible', '', '', false),
    apiKey: '',
    expectedStatus: 'unconfigured',
    expectedCode: 'MODEL_SERVICE_UNCONFIGURED'
  },
  {
    name: 'credential marker false',
    config: buildConfig('anthropic-compatible', 'https://example.invalid', 'model', false),
    apiKey: 'synthetic-key',
    expectedStatus: 'unconfigured',
    expectedCode: 'MODEL_SERVICE_UNCONFIGURED'
  },
  {
    name: 'missing resolved credential',
    config: buildConfig('openai-compatible', 'https://example.invalid', 'model', true),
    apiKey: null,
    expectedStatus: 'unconfigured',
    expectedCode: 'MODEL_SERVICE_UNCONFIGURED'
  },
  {
    name: 'remote plaintext endpoint',
    config: buildConfig('openai-compatible', 'http://example.invalid', 'model', true),
    apiKey: 'synthetic-key',
    expectedStatus: 'invalid-configuration',
    expectedCode: 'MODEL_SERVICE_ENDPOINT_FORBIDDEN'
  },
  {
    name: 'endpoint embeds credentials',
    config: buildConfig('anthropic-compatible', 'https://user:password@example.invalid', 'model', true),
    apiKey: 'synthetic-key',
    expectedStatus: 'invalid-configuration',
    expectedCode: 'MODEL_SERVICE_ENDPOINT_FORBIDDEN'
  },
  {
    name: 'unsupported runtime protocol',
    config: buildConfig('unknown' as ModelServiceProtocol, 'https://example.invalid', 'model', true),
    apiKey: 'synthetic-key',
    expectedStatus: 'invalid-configuration',
    expectedCode: 'MODEL_SERVICE_PROTOCOL_UNSUPPORTED'
  }
];

for (const testCase of cases) {
  const result = createConfiguredModelServiceAdapter({
    ...(testCase.config !== undefined ? { config: testCase.config } : {}),
    ...(testCase.apiKey !== undefined ? { apiKey: testCase.apiKey } : {}),
    fetchImpl: forbiddenFetch
  });
  if (result.ok
    || result.status !== testCase.expectedStatus
    || result.diagnostics[0].code !== testCase.expectedCode) {
    throw new Error(`configuration case failed: ${testCase.name}`);
  }
}
if (networkAttempts !== 0) {
  throw new Error('unconfigured or invalid model service attempted a network request');
}

const configured = [
  createConfiguredModelServiceAdapter({
    config: buildConfig('openai-compatible', 'http://127.0.0.1:3000/', 'model-a', true),
    apiKey: 'synthetic-key-a',
    fetchImpl: forbiddenFetch
  }),
  createConfiguredModelServiceAdapter({
    config: buildConfig('anthropic-compatible', 'https://example.invalid/', 'model-b', true),
    apiKey: 'synthetic-key-b',
    fetchImpl: forbiddenFetch
  })
];
if (!configured.every((result) => result.ok)
  || configured[0]?.adapter?.protocol !== 'openai-compatible'
  || configured[1]?.adapter?.protocol !== 'anthropic-compatible') {
  throw new Error('configured protocol adapter selection failed');
}
if (networkAttempts !== 0) {
  throw new Error('adapter construction must not perform network I/O');
}

console.log(JSON.stringify({
  ok: true,
  status: 'fixture-confirmed',
  cases: cases.length + configured.length,
  protocols: configured.map((result) => result.ok ? result.adapter.protocol : 'rejected'),
  emptyConfiguration: 'unconfigured',
  networkAttempts,
  credentialBundled: false,
  nativeMutationAuthority: false,
  nonClaims: [
    'Offline configuration conformance does not prove a third-party provider is available.',
    'Provider adapters cannot grant native writer or Patch Engine authority.'
  ]
}, null, 2));

function buildConfig(
  protocol: ModelServiceProtocol,
  baseUrl: string,
  model: string,
  hasCredential: boolean
): ModelServiceConfig {
  return {
    id: `fixture-${protocol}`,
    displayName: 'fixture',
    protocol,
    baseUrl,
    model,
    hasCredential,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z'
  };
}
