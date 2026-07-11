/**
 * Main-process model service credential vault using Electron safeStorage (DPAPI on Windows).
 * Renderer never receives plaintext keys — only config ids and hasCredential flags.
 */

import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

interface VaultFile {
  version: 1;
  configs: StoredModelServiceConfig[];
  /** configId -> base64 ciphertext from safeStorage.encryptString */
  secrets: Record<string, string>;
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
    return structuredClone(vault.configs);
  }

  async upsertConfig(input: {
    id?: string;
    displayName: string;
    protocol: StoredModelServiceConfig['protocol'];
    baseUrl: string;
    model: string;
    apiKey?: string;
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
      updatedAt: now
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
