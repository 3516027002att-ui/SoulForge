import {
  AnthropicCompatibleAdapter,
  isAllowedEndpoint,
  OpenAiCompatibleAdapter,
  type ModelListResult
} from '@soulforge/core';
import type { ModelServiceCredentialVault } from '../modelServiceCredentials.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { TrustedIpcHandle } from './registration.js';

export interface ModelServiceIpcDeps {
  handle: TrustedIpcHandle;
  vault: ModelServiceCredentialVault;
  operationLogUtility: OperationLogUtilityClient;
  /** join(app.getPath('userData'), 'app.db') —— 进程内稳定，注册时绑定。 */
  appDatabasePath: string;
  /** agent 运行态只读探针（usageSummary 标注 active），不暴露 agent 内部状态。 */
  isAgentSessionActive(sessionId: string): boolean;
}

export function registerModelServiceIpcHandlers(deps: ModelServiceIpcDeps): void {
  // Model service configs — renderer receives DTO without secrets.
  deps.handle('modelService.list', async () => deps.vault.listConfigs());

  deps.handle('modelService.usageSummary', async () => {
    await deps.operationLogUtility.openAppDatabase(deps.appDatabasePath);
    const summary = await deps.operationLogUtility.providerUsageSummary();
    return {
      ...summary,
      ...(summary.latestSession
        ? {
            latestSession: {
              ...summary.latestSession,
              active: deps.isAgentSessionActive(summary.latestSession.sessionId)
            }
          }
        : {})
    };
  });

  deps.handle('modelService.encryptionAvailable', async () => deps.vault.isEncryptionAvailable());

  deps.handle(
    'modelService.upsert',
    async (
      _event,
      input: {
        id?: string;
        displayName: string;
        protocol: 'openai-compatible' | 'anthropic-compatible';
        baseUrl: string;
        model: string;
        apiKey?: string;
        temperature?: number;
        topP?: number;
        topK?: number;
        maxTokens?: number;
        contextWindowTokens?: number;
        thinkingLevel?: 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
        embeddingModel?: string;
      }
    ) => {
      // apiKey is accepted once for encryption; never returned in the response DTO.
      const saved = await deps.vault.upsertConfig(input);
      return {
        id: saved.id,
        displayName: saved.displayName,
        protocol: saved.protocol,
        baseUrl: saved.baseUrl,
        model: saved.model,
        hasCredential: saved.hasCredential,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
        ...(saved.temperature !== undefined ? { temperature: saved.temperature } : {}),
        ...(saved.topP !== undefined ? { topP: saved.topP } : {}),
        ...(saved.topK !== undefined ? { topK: saved.topK } : {}),
        ...(saved.maxTokens !== undefined ? { maxTokens: saved.maxTokens } : {}),
        ...(saved.contextWindowTokens !== undefined ? { contextWindowTokens: saved.contextWindowTokens } : {}),
        ...(saved.thinkingLevel !== undefined ? { thinkingLevel: saved.thinkingLevel } : {}),
        ...(saved.embeddingModel !== undefined ? { embeddingModel: saved.embeddingModel } : {})
      };
    }
  );

  deps.handle('modelService.delete', async (_event, configId: string) => {
    await deps.vault.deleteConfig(configId);
    return { ok: true };
  });

  /**
   * 拉取某模型服务的可用模型列表（GET /v1/models）。
   *
   * 输入是表单当前值而不是 configId：用户在「保存服务」之前就要能试拉模型列表，
   * 不必先存一个可能填错的配置。apiKey 可选 —— 本地服务（Ollama 等）通常没有
   * 密钥。endpoint 安全校验与生产工厂共用同一套（HTTPS 或回环 HTTP），key 只在
   * 本次调用内使用，不落盘、不进任何 DTO。
   */
  deps.handle(
    'modelService.listModels',
    async (_event, input: {
      protocol: 'openai-compatible' | 'anthropic-compatible';
      baseUrl: string;
      apiKey?: string;
    }): Promise<ModelListResult> => {
      const protocol = input?.protocol;
      const baseUrl = input?.baseUrl;
      if (protocol !== 'openai-compatible' && protocol !== 'anthropic-compatible') {
        return { ok: false, error: { code: 'MODEL_SERVICE_PROTOCOL_UNSUPPORTED', message: '模型服务协议不受支持。' } };
      }
      if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
        return { ok: false, error: { code: 'MODEL_SERVICE_ENDPOINT_INVALID', message: '请先填写服务地址。' } };
      }
      let endpoint: URL;
      try {
        endpoint = new URL(baseUrl.trim());
      } catch {
        return { ok: false, error: { code: 'MODEL_SERVICE_ENDPOINT_INVALID', message: '服务地址不是有效 URL。' } };
      }
      if (!isAllowedEndpoint(endpoint)) {
        return {
          ok: false,
          error: {
            code: 'MODEL_SERVICE_ENDPOINT_FORBIDDEN',
            message: '服务地址必须使用 HTTPS，或仅对本机回环地址使用 HTTP。'
          }
        };
      }
      const adapter = protocol === 'openai-compatible'
        ? new OpenAiCompatibleAdapter({
            baseUrl: endpoint.toString().replace(/\/$/, ''),
            apiKey: input.apiKey?.trim() ?? '',
            model: 'list-models'
          })
        : new AnthropicCompatibleAdapter({
            baseUrl: endpoint.toString().replace(/\/$/, ''),
            apiKey: input.apiKey?.trim() ?? '',
            model: 'list-models'
          });
      try {
        return await adapter.listModels({ timeoutMs: 15_000 });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'MODEL_SERVICE_LIST_FAILED',
            message: error instanceof Error ? error.message : '获取模型列表失败。'
          }
        };
      }
    }
  );
}
