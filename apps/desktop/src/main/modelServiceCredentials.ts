/**
 * Main-process model service credential vault using Electron safeStorage (DPAPI on Windows).
 * app.db is the authority; the legacy JSON vault is imported once and archived.
 */

import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppModelServiceRecord } from '@soulforge/core';

export interface StoredModelServiceConfig {
  id: string;
  displayName: string;
  protocol: 'openai-compatible' | 'anthropic-compatible';
  baseUrl: string;
  model: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LegacyVaultFile {
  version: 1;
  configs: StoredModelServiceConfig[];
  secrets: Record<string, string>;
}

export interface ModelServiceVaultRepository {
  listModelServices(): Promise<AppModelServiceRecord[]>;
  getModelService(serviceId: string, includeDeleted?: boolean): Promise<AppModelServiceRecord | undefined>;
  upsertModelService(record: AppModelServiceRecord): Promise<AppModelServiceRecord>;
  importModelServices(records: AppModelServiceRecord[]): Promise<{ imported: number }>;
  softDeleteModelService(serviceId: string, deletedAt?: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredConfig(value: unknown): value is StoredModelServiceConfig {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.displayName === 'string'
    && (value.protocol === 'openai-compatible' || value.protocol === 'anthropic-compatible')
    && typeof value.baseUrl === 'string'
    && typeof value.model === 'string'
    && typeof value.hasCredential === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function parseLegacyVaultFile(raw: string): LegacyVaultFile {
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
  if (Object.keys(secrets).some((id) => !ids.has(id))) throw new Error('MODEL_SERVICE_VAULT_CORRUPT');
  return { version: 1, configs: structuredClone(value.configs), secrets: { ...secrets } };
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

export class ModelServiceCredentialVault {
  private readonly legacyVaultPath: string;
  private migration: Promise<void> | null = null;

  constructor(
    appDataRoot: string,
    private readonly repository: ModelServiceVaultRepository
  ) {
    this.legacyVaultPath = join(appDataRoot, 'model-services', 'vault.json');
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async listConfigs(): Promise<StoredModelServiceConfig[]> {
    await this.ensureLegacyMigrated();
    return (await this.repository.listModelServices()).map(toDto);
  }

  async upsertConfig(input: {
    id?: string;
    displayName: string;
    protocol: StoredModelServiceConfig['protocol'];
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): Promise<StoredModelServiceConfig> {
    if (!this.isEncryptionAvailable()) throw new Error('MODEL_SERVICE_SAFE_STORAGE_UNAVAILABLE');
    await this.ensureLegacyMigrated();
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const existing = await this.repository.getModelService(id, true);
    let credentialCiphertext = existing?.credentialCiphertext;
    if (input.apiKey !== undefined) {
      credentialCiphertext = input.apiKey
        ? Buffer.from(safeStorage.encryptString(input.apiKey)).toString('base64')
        : undefined;
    }
    const saved = await this.repository.upsertModelService({
      id,
      displayName: input.displayName,
      protocol: input.protocol,
      baseUrl: input.baseUrl.replace(/\/$/, ''),
      model: input.model,
      hasCredential: Boolean(credentialCiphertext),
      ...(credentialCiphertext ? { credentialCiphertext } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    return toDto(saved);
  }

  async deleteConfig(configId: string): Promise<void> {
    await this.ensureLegacyMigrated();
    await this.repository.softDeleteModelService(configId);
  }

  /** Resolve plaintext key for main/core agent loop only. Never send to renderer. */
  async resolveApiKey(configId: string): Promise<string | null> {
    if (!this.isEncryptionAvailable()) return null;
    await this.ensureLegacyMigrated();
    const config = await this.repository.getModelService(configId);
    if (!config?.credentialCiphertext) return null;
    return safeStorage.decryptString(Buffer.from(config.credentialCiphertext, 'base64'));
  }

  private async ensureLegacyMigrated(): Promise<void> {
    if (!this.migration) this.migration = this.migrateLegacyVault();
    return this.migration;
  }

  private async migrateLegacyVault(): Promise<void> {
    let legacy: LegacyVaultFile;
    try {
      legacy = parseLegacyVaultFile(await readFile(this.legacyVaultPath, 'utf8'));
    } catch (error) {
      if (isMissingFile(error)) return;
      if (error instanceof Error && error.message === 'MODEL_SERVICE_VAULT_CORRUPT') throw error;
      throw new Error('MODEL_SERVICE_VAULT_LOAD_FAILED');
    }
    const existing = new Set((await this.repository.listModelServices()).map((config) => config.id));
    const pending = legacy.configs
      .filter((config) => !existing.has(config.id))
      .map((config) => {
        const credentialCiphertext = legacy.secrets[config.id];
        return {
          ...config,
          hasCredential: Boolean(credentialCiphertext),
          ...(credentialCiphertext ? { credentialCiphertext } : {})
        };
      });
    await this.repository.importModelServices(pending);
    await rename(this.legacyVaultPath, `${this.legacyVaultPath}.migrated-${Date.now()}.json`);
  }
}

function toDto(config: AppModelServiceRecord): StoredModelServiceConfig {
  return {
    id: config.id,
    displayName: config.displayName,
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    model: config.model,
    hasCredential: config.hasCredential,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
}
