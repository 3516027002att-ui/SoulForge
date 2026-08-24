import { AnthropicCompatibleAdapter } from './anthropicCompatibleAdapter.js';
import { OpenAiCompatibleAdapter } from './openaiCompatibleAdapter.js';
import { OpenAiResponsesAdapter } from './openaiResponsesAdapter.js';
import type {
  ModelServiceAdapter,
  ModelServiceConfig,
  ModelServiceProtocol
} from './types.js';
import type { ModelProviderCapabilityPolicy } from './providerCapabilities.js';

export interface ConfiguredModelServiceAdapterOptions {
  config?: ModelServiceConfig | null;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}

export type ConfiguredModelServiceAdapterResult =
  | {
      ok: true;
      status: 'configured';
      adapter: ModelServiceAdapter;
      diagnostics: [];
    }
  | {
      ok: false;
      status: 'unconfigured' | 'invalid-configuration';
      adapter: null;
      diagnostics: [{ severity: 'error'; code: string; message: string }];
    };

/**
 * Main/core production factory for model-service adapters.
 *
 * Keeping this check ahead of adapter construction gives the default empty
 * configuration a deterministic, network-free result. Callers must not create
 * provider adapters directly from renderer input.
 */
export function createConfiguredModelServiceAdapter(
  options: ConfiguredModelServiceAdapterOptions
): ConfiguredModelServiceAdapterResult {
  const config = options.config;
  const apiKey = options.apiKey?.trim() ?? '';
  if (!config
    || config.baseUrl.trim() === ''
    || config.model.trim() === ''
    || config.hasCredential !== true
    || apiKey === '') {
    return rejected(
      'unconfigured',
      'MODEL_SERVICE_UNCONFIGURED',
      '模型服务未配置完整；未发起网络请求。'
    );
  }

  const protocol = config.protocol as ModelServiceProtocol;
  if (protocol !== 'openai-compatible' && protocol !== 'openai-responses' && protocol !== 'anthropic-compatible') {
    return rejected(
      'invalid-configuration',
      'MODEL_SERVICE_PROTOCOL_UNSUPPORTED',
      '模型服务协议不受支持；未发起网络请求。'
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.baseUrl);
  } catch {
    return rejected(
      'invalid-configuration',
      'MODEL_SERVICE_ENDPOINT_INVALID',
      '模型服务 endpoint 不是有效 URL；未发起网络请求。'
    );
  }
  if (!isAllowedEndpoint(endpoint)) {
    return rejected(
      'invalid-configuration',
      'MODEL_SERVICE_ENDPOINT_FORBIDDEN',
      '模型服务 endpoint 必须使用 HTTPS，或仅对本机回环地址使用 HTTP；未发起网络请求。'
    );
  }

  const adapterOptions = {
    baseUrl: endpoint.toString().replace(/\/$/, ''),
    apiKey,
    model: config.model.trim(),
    // Configured production calls must not infer optional support from the
    // protocol name. Missing fields remain unknown and are suppressed by the
    // adapter; only explicit config/request declarations enable them.
    capabilityPolicy: 'explicit-or-fail-closed' as ModelProviderCapabilityPolicy,
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  };
  let adapter: ModelServiceAdapter;
  if (protocol === 'openai-compatible') adapter = new OpenAiCompatibleAdapter(adapterOptions);
  else if (protocol === 'openai-responses') adapter = new OpenAiResponsesAdapter(adapterOptions);
  else adapter = new AnthropicCompatibleAdapter(adapterOptions);
  return {
    ok: true,
    status: 'configured',
    adapter,
    diagnostics: []
  };
}

/**
 * 模型服务 endpoint 安全校验：HTTPS 或本机回环 HTTP（127.0.0.1/localhost/[::1]）。
 * 生产工厂与 modelService.listModels 共用，安全口径只有一份。
 */
export function isAllowedEndpoint(endpoint: URL): boolean {
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
  if (endpoint.protocol === 'https:') return true;
  if (endpoint.protocol !== 'http:') return false;
  const hostname = endpoint.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function rejected(
  status: 'unconfigured' | 'invalid-configuration',
  code: string,
  message: string
): ConfiguredModelServiceAdapterResult {
  return {
    ok: false,
    status,
    adapter: null,
    diagnostics: [{ severity: 'error', code, message }]
  };
}
