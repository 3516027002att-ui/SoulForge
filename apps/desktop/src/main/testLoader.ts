import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import electron from 'electron';
import type { StoredModelServiceConfig } from './modelServiceCredentials.js';

const electronApp = (electron as unknown as { app?: typeof electron.app })?.app;

export interface DecryptedPlatformTestConfig {
  url: string;
  api: string;
  protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
  model: string;
}

const TEST_SECRET_SALT = 'soulforge_test_secret_salt_2026';
export const TEST_CONFIG_ID = 'test-service';

function deriveKey(): Buffer {
  return createHash('sha256').update(TEST_SECRET_SALT).digest();
}

/**
 * 对配置进行加密并输出 cipher payload 字符串（ivHex:base64Cipher）
 */
export function encryptTestConfig(config: DecryptedPlatformTestConfig): string {
  const secretKey = deriveKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', secretKey, iv);
  let encrypted = cipher.update(JSON.stringify(config), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * 解密 cipher payload 字符串
 */
export function decryptTestPayload(payload: string): DecryptedPlatformTestConfig | null {
  try {
    const trimmed = payload.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) return null;
    const ivHex = trimmed.slice(0, colonIdx);
    const enc = trimmed.slice(colonIdx + 1);
    if (!ivHex || !enc) return null;
    const secretKey = deriveKey();
    const decipher = createDecipheriv('aes-256-cbc', secretKey, Buffer.from(ivHex, 'hex'));
    let decrypted = decipher.update(enc, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    if (typeof parsed?.url === 'string' && typeof parsed?.api === 'string' && typeof parsed?.model === 'string') {
      let protocol: DecryptedPlatformTestConfig['protocol'] = 'openai-responses';
      if (parsed.protocol === 'openai-compatible' || parsed.protocol === 'anthropic-compatible') {
        protocol = parsed.protocol;
      }
      return {
        url: parsed.url,
        api: parsed.api,
        protocol,
        model: parsed.model
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 遍历收集所有可能的基准探测目录，并向上回溯
 */
function collectSearchDirectories(): string[] {
  const baseDirs = new Set<string>();

  try {
    baseDirs.add(process.cwd());
  } catch {
    // ignore
  }

  try {
    if (typeof electronApp?.getAppPath === 'function') {
      baseDirs.add(electronApp.getAppPath());
    }
  } catch {
    // ignore
  }

  try {
    if (process.resourcesPath) {
      baseDirs.add(process.resourcesPath);
    }
  } catch {
    // ignore
  }

  try {
    if (process.execPath) {
      baseDirs.add(dirname(process.execPath));
    }
  } catch {
    // ignore
  }

  const allCandidateDirs = new Set<string>();

  for (const base of baseDirs) {
    let current = resolve(base);
    for (let i = 0; i < 8; i++) {
      allCandidateDirs.add(current);
      allCandidateDirs.add(join(current, 'SoulForge'));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return Array.from(allCandidateDirs);
}

let cachedTestConfig: DecryptedPlatformTestConfig | null = null;
let lastFoundPath: string | null = null;

/**
 * 探测项目根目录或运行根目录下的 test 文件并加载解密配置
 */
export function loadTestConfiguration(): DecryptedPlatformTestConfig | null {
  if (lastFoundPath && existsSync(lastFoundPath)) {
    try {
      const raw = readFileSync(lastFoundPath, 'utf8');
      const decrypted = decryptTestPayload(raw);
      if (decrypted) {
        cachedTestConfig = decrypted;
        return decrypted;
      }
    } catch {
      // ignore
    }
  }

  const searchDirs = collectSearchDirectories();

  for (const dir of searchDirs) {
    const candidatePath = join(dir, 'test');
    if (existsSync(candidatePath)) {
      try {
        const raw = readFileSync(candidatePath, 'utf8');
        const decrypted = decryptTestPayload(raw);
        if (decrypted) {
          lastFoundPath = candidatePath;
          cachedTestConfig = decrypted;
          return decrypted;
        }
      } catch {
        // ignore read failure
      }
    }
  }

  cachedTestConfig = null;
  lastFoundPath = null;
  return null;
}

export function isTestConfigPresent(): boolean {
  return loadTestConfiguration() !== null;
}

export function getTestServiceConfig(): StoredModelServiceConfig | null {
  const config = loadTestConfiguration();
  if (!config) return null;
  const now = new Date().toISOString();
  return {
    id: TEST_CONFIG_ID,
    displayName: 'test',
    protocol: config.protocol,
    baseUrl: config.url.replace(/\/$/, ''),
    model: config.model,
    hasCredential: true,
    createdAt: now,
    updatedAt: now
  };
}

export function getTestApiKey(configId: string): string | null {
  if (configId !== TEST_CONFIG_ID) return null;
  const config = loadTestConfiguration();
  return config ? config.api : null;
}
