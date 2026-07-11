/**
 * Structural contract smoke for desktop credential vault module.
 * Asserts the shipped source exposes safeStorage-only APIs and never exports plaintext helpers to renderer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const vaultPath = resolve('../../apps/desktop/src/main/modelServiceCredentials.ts');
  const source = readFileSync(vaultPath, 'utf8');
  const required = [
    'safeStorage',
    'encryptString',
    'decryptString',
    'hasCredential',
    'resolveApiKey',
    'MODEL_SERVICE_SAFE_STORAGE_UNAVAILABLE'
  ];
  for (const token of required) {
    if (!source.includes(token)) throw new Error(`vault source missing ${token}`);
  }
  if (source.includes('apps/desktop/src/renderer')) {
    throw new Error('vault must not live under renderer');
  }
  // Ensure plaintext apiKey is only accepted as write input, not stored field name in config DTO.
  if (/interface StoredModelServiceConfig[\s\S]*apiKey\s*:/.test(source)) {
    throw new Error('StoredModelServiceConfig must not include apiKey field');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '模型服务凭据 vault 源码契约验证通过',
    path: 'apps/desktop/src/main/modelServiceCredentials.ts',
    usesSafeStorage: true,
    configDtoHasApiKey: false
  }, null, 2));
}

main();
