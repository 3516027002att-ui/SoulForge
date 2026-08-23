/**
 * Main-process model service credential vault using Electron safeStorage (DPAPI on Windows).
 * Renderer never receives plaintext keys — only config ids and hasCredential flags.
 */

import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { migrateThinkingLevel } from '@soulforge/core';
import type { ModelThinkingLevel } from '@soulforge/core';

export interface StoredModelServiceConfig {
  id: string;
  displayName: string;
  protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
  baseUrl: string;
  model: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
  /** 采样/能力参数（高级选项）。全部可选：缺失 = 使用 provider 默认值。 */
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  /** 上下文预算（token）：agent 侧自动压缩触发阈值。 */
  contextWindowTokens?: number;
  /** 思考强度（采样/能力参数）。类型只写官方 effort 值；旧 vault 的遗留档由
      listConfigs 读路径兼容映射，写路径只写新值。 */
  thinkingLevel?: ModelThinkingLevel;
  /**
   * 该服务同时用作 embedding（POST /v1/embeddings，仅 openai-compatible 支持）。
   * 配置后 workspace 语料可生成向量索引，检索走 RRF 混合（lexical + 向量）。
   */
  embeddingModel?: string;
}

const THINKING_LEVELS: ReadonlySet<string> = new Set([
  'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
  'fast', 'normal', 'deep', 'extreme'
]);

function isValidOptionalNumber(value: unknown, min: number, max: number): boolean {
  return value === undefined
    || (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max);
}

function isStoredConfig(value: unknown): value is StoredModelServiceConfig {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.displayName === 'string'
    && (value.protocol === 'openai-compatible' || value.protocol === 'openai-responses' || value.protocol === 'anthropic-compatible')
    && typeof value.baseUrl === 'string'
    && typeof value.model === 'string'
    && typeof value.hasCredential === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && isValidOptionalNumber(value.temperature, 0, 2)
    && isValidOptionalNumber(value.topP, 0, 1)
    && (value.topK === undefined || (typeof value.topK === 'number' && Number.isInteger(value.topK) && value.topK >= 1))
    && (value.maxTokens === undefined || (typeof value.maxTokens === 'number' && Number.isInteger(value.maxTokens) && value.maxTokens >= 1))
    && (value.contextWindowTokens === undefined
      || (typeof value.contextWindowTokens === 'number' && Number.isInteger(value.contextWindowTokens) && value.contextWindowTokens >= 1))
    && (value.thinkingLevel === undefined
      || (typeof value.thinkingLevel === 'string' && THINKING_LEVELS.has(value.thinkingLevel)))
    && (value.embeddingModel === undefined
      || (typeof value.embeddingModel === 'string' && value.embeddingModel.trim() !== ''));
}

interface VaultFile {
  version: 1;
  configs: StoredModelServiceConfig[];
  /** configId -> base64 ciphertext from safeStorage.encryptString */
  secrets: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function parseVaultFile(raw: string): VaultFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('MODEL_SERVICE_VAULT_CORRUPT');
  }
  if (!isRecord(value)
    || value.version !== 1
    || !Array.isArray(value.configs)
    || !value.configs.every(isStoredConfig)
    || !isRecord(value.secrets)
    || !Object.values(value.secrets).every((secret) => typeof secret === 'string' && isCanonicalBase64(secret))) {
    throw new Error('MODEL_SERVICE_VAULT_CORRUPT');
  }
  const ids = new Set<string>();
  for (const config of value.configs) {
    if (ids.has(config.id)) throw new Error('MODEL_SERVICE_VAULT_CORRUPT');
    ids.add(config.id);
  }
  const secrets = value.secrets as Record<string, string>;
  return {
    version: 1,
    configs: value.configs.map((config) => ({
      ...config,
      hasCredential: Boolean(secrets[config.id])
    })),
    secrets: { ...secrets }
  };
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export class ModelServiceCredentialVault {
  private readonly vaultPath: string;
  private cache: VaultFile | null = null;

  constructor(appDataRoot: string) {
    this.vaultPath = join(appDataRoot, 'model-services', 'vault.json');
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async listConfigs(): Promise<StoredModelServiceConfig[]> {
    const vault = await this.load();
    // 读路径兼容：旧 vault 里的遗留档（fast/normal/deep/extreme）在这里映射成官方档，
    // 下游（renderer DTO / sampling）只看到官方 effort 值；写路径照旧只写新值。
    // migrateThinkingLevel 对官方值幂等，只有遗留档才发生转换。
    return structuredClone(vault.configs).map((config) => (
      config.thinkingLevel !== undefined
        ? { ...config, thinkingLevel: migrateThinkingLevel(config.thinkingLevel) }
        : config
    ));
  }

  async upsertConfig(input: {
    id?: string;
    displayName: string;
    protocol: StoredModelServiceConfig['protocol'];
    baseUrl: string;
    model: string;
    apiKey?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    contextWindowTokens?: number;
    thinkingLevel?: StoredModelServiceConfig['thinkingLevel'];
    embeddingModel?: string;
  }): Promise<StoredModelServiceConfig> {
    if (!this.isEncryptionAvailable()) {
      throw new Error('MODEL_SERVICE_SAFE_STORAGE_UNAVAILABLE');
    }
    const vault = await this.load();
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const existing = vault.configs.find((c) => c.id === id);
    const next: StoredModelServiceConfig = {
      id,
      displayName: input.displayName,
      protocol: input.protocol,
      baseUrl: input.baseUrl.replace(/\/$/, ''),
      model: input.model,
      hasCredential: existing?.hasCredential ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.topK !== undefined ? { topK: input.topK } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.contextWindowTokens !== undefined ? { contextWindowTokens: input.contextWindowTokens } : {}),
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.embeddingModel !== undefined && input.embeddingModel.trim() !== ''
        ? { embeddingModel: input.embeddingModel.trim() }
        : {})
    };
    if (input.apiKey !== undefined) {
      if (!input.apiKey) {
        delete vault.secrets[id];
        next.hasCredential = false;
      } else {
        const encrypted = safeStorage.encryptString(input.apiKey);
        vault.secrets[id] = Buffer.from(encrypted).toString('base64');
        next.hasCredential = true;
      }
    }
    vault.configs = [...vault.configs.filter((c) => c.id !== id), next];
    await this.save(vault);
    return structuredClone(next);
  }

  async deleteConfig(configId: string): Promise<void> {
    const vault = await this.load();
    vault.configs = vault.configs.filter((c) => c.id !== configId);
    delete vault.secrets[configId];
    await this.save(vault);
  }

  /**
   * Resolve plaintext key for main/core agent loop only. Never send to renderer.
   */
  async resolveApiKey(configId: string): Promise<string | null> {
    if (!this.isEncryptionAvailable()) return null;
    const vault = await this.load();
    const encoded = vault.secrets[configId];
    if (!encoded) return null;
    const buf = Buffer.from(encoded, 'base64');
    return safeStorage.decryptString(buf);
  }

  private async load(): Promise<VaultFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.vaultPath, 'utf8');
      const parsed = parseVaultFile(raw);
      this.cache = parsed;
      return parsed;
    } catch (error) {
      if (!isMissingFile(error)) {
        if (error instanceof Error && error.message === 'MODEL_SERVICE_VAULT_CORRUPT') throw error;
        throw new Error('MODEL_SERVICE_VAULT_LOAD_FAILED');
      }
      const empty: VaultFile = { version: 1, configs: [], secrets: {} };
      this.cache = empty;
      return empty;
    }
  }

  private async save(vault: VaultFile): Promise<void> {
    await mkdir(dirname(this.vaultPath), { recursive: true });
    // Never write plaintext keys.
    const safe: VaultFile = {
      version: 1,
      configs: vault.configs.map((c) => ({ ...c, hasCredential: Boolean(vault.secrets[c.id]) })),
      secrets: { ...vault.secrets }
    };
    const temporaryPath = `${this.vaultPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(safe, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });
      await rename(temporaryPath, this.vaultPath);
      this.cache = safe;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
