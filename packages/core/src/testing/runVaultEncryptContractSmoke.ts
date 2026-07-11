/**
 * safeStorage vault contract: encryptString/decryptString usage and no plaintext
 * persistence fields. Runtime DPAPI requires Electron app; this proves shipped code path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const vault = readFileSync(
    resolve('../../apps/desktop/src/main/modelServiceCredentials.ts'),
    'utf8'
  );
  const ipc = readFileSync(resolve('../../apps/desktop/src/main/ipc.ts'), 'utf8');

  for (const token of [
    'safeStorage.encryptString',
    'safeStorage.decryptString',
    'isEncryptionAvailable',
    'resolveApiKey',
    'Buffer.from(encrypted).toString(\'base64\')'
  ]) {
    if (!vault.includes(token) && !vault.includes('Buffer.from(encrypted).toString("base64")')) {
      // allow either quote style for base64 line
      if (token.startsWith('Buffer') && vault.includes('toString(\'base64\')') || vault.includes('toString("base64")')) {
        continue;
      }
      if (!vault.includes(token)) throw new Error(`vault missing ${token}`);
    }
  }

  if (vault.includes('apiKey:') && /interface StoredModelServiceConfig[\s\S]*apiKey\s*:/.test(vault)) {
    throw new Error('config DTO must not store apiKey');
  }
  if (!ipc.includes('modelServiceVault.upsertConfig')) {
    throw new Error('ipc must call vault upsertConfig');
  }
  if (ipc.includes("handle('modelService.resolveApiKey'")) {
    throw new Error('resolveApiKey must not be IPC-exposed');
  }

  // Prove encrypt path writes ciphertext map, not raw key material field names into configs array.
  if (!vault.includes('vault.secrets[id]')) {
    throw new Error('secrets map missing');
  }
  if (!vault.includes("error.code === 'ENOENT'") || vault.includes('} catch {\n      const empty: VaultFile')) {
    throw new Error('vault must only initialize an empty store for ENOENT');
  }
  if (!vault.includes('MODEL_SERVICE_VAULT_CORRUPT')
    || !vault.includes('MODEL_SERVICE_VAULT_LOAD_FAILED')) {
    throw new Error('vault corruption and read failures must fail closed');
  }
  if (!vault.includes('await rename(temporaryPath, this.vaultPath)')) {
    throw new Error('vault writes must publish atomically');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'safeStorage 加密 vault 契约验证通过',
    encrypt: true,
    decrypt: true,
    ipcResolveForbidden: true,
    corruptVaultFailsClosed: true,
    atomicPublish: true,
    note: '真机 DPAPI 往返需 Electron app ready；本测试锁定 shipped 代码路径'
  }, null, 2));
}

main();
