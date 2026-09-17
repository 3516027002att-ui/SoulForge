import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const TEST_SECRET_SALT = 'soulforge_test_secret_salt_2026';
const TEST_CONFIG_ID = 'test-service';

function deriveKey() {
  return createHash('sha256').update(TEST_SECRET_SALT).digest();
}

export function encryptTestConfig(config) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', deriveKey(), iv);
  let encrypted = cipher.update(JSON.stringify(config), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return `${iv.toString('hex')}:${encrypted}`;
}

export function decryptTestPayload(payload) {
  try {
    const trimmed = payload.trim();
    const separator = trimmed.indexOf(':');
    if (separator <= 0) return null;
    const iv = Buffer.from(trimmed.slice(0, separator), 'hex');
    const encrypted = trimmed.slice(separator + 1);
    if (iv.length !== 16 || encrypted.length === 0) return null;
    const decipher = createDecipheriv('aes-256-cbc', deriveKey(), iv);
    let plain = decipher.update(encrypted, 'base64', 'utf8');
    plain += decipher.final('utf8');
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed !== 'object'
      || typeof parsed.url !== 'string' || parsed.url.trim() === ''
      || typeof parsed.api !== 'string' || parsed.api.trim() === ''
      || typeof parsed.model !== 'string' || parsed.model.trim() === '') return null;
    const protocol = parsed.protocol === 'openai-compatible' || parsed.protocol === 'openai-responses'
      || parsed.protocol === 'anthropic-compatible'
      ? parsed.protocol
      : 'openai-responses';
    return {
      id: TEST_CONFIG_ID,
      displayName: 'test',
      protocol,
      baseUrl: parsed.url.replace(/\/$/u, ''),
      model: parsed.model,
      apiKey: parsed.api
    };
  } catch {
    return null;
  }
}

function candidatePaths(repoRoot, explicitPath) {
  if (explicitPath) return [resolve(explicitPath)];
  const current = resolve(process.cwd());
  return [
    join(repoRoot, 'test'),
    join(current, 'test'),
    join(dirname(repoRoot), 'test')
  ];
}

export function loadTestAgentProvider({ repoRoot, explicitPath } = {}) {
  const candidates = candidatePaths(repoRoot ?? process.cwd(), explicitPath);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const config = decryptTestPayload(readFileSync(path, 'utf8'));
      if (config) return { config, source: path };
    } catch {
      // Keep searching only inside the explicit simulation candidates.
    }
  }
  return null;
}
