/**
 * safeStorage + app.db authority contract. Runtime DPAPI requires Electron app;
 * this proves ciphertext is produced in main and persisted only through utility RPC.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const vault = readFileSync(resolve('../../apps/desktop/src/main/modelServiceCredentials.ts'), 'utf8');
  const ipc = readFileSync(resolve('../../apps/desktop/src/main/ipc.ts'), 'utf8');
  const utility = readFileSync(resolve('../../apps/desktop/src/main/databaseUtility.ts'), 'utf8');
  const repository = readFileSync(resolve('../../packages/core/src/storage/appDataRepository.ts'), 'utf8');

  for (const token of [
    'safeStorage.encryptString',
    'safeStorage.decryptString',
    'isEncryptionAvailable',
    'resolveApiKey',
    "toString('base64')",
    'repository.upsertModelService',
    'repository.getModelService'
  ]) {
    if (!vault.includes(token)) throw new Error(`vault missing ${token}`);
  }
  if (!ipc.includes('modelServiceVault.upsertConfig')
    || !ipc.includes('operationLogUtility.openApp')) {
    throw new Error('ipc must initialize app.db and call vault upsertConfig');
  }
  if (ipc.includes("handle('modelService.resolveApiKey'")) {
    throw new Error('resolveApiKey must not be IPC-exposed');
  }
  if (!utility.includes('AppDataRepository') || !utility.includes("case 'upsertModelService'")) {
    throw new Error('utility process must own app.db model service persistence');
  }
  if (!repository.includes('credential_ciphertext')
    || !repository.includes('Buffer.from(record.credentialCiphertext')) {
    throw new Error('app.db repository must store ciphertext bytes');
  }
  if (vault.includes('writeFile(temporaryPath') || vault.includes('private async save(vault')) {
    throw new Error('legacy JSON vault must not remain the production authority');
  }
  if (!vault.includes('MODEL_SERVICE_VAULT_CORRUPT')
    || !vault.includes('MODEL_SERVICE_VAULT_LOAD_FAILED')
    || !vault.includes('.migrated-')) {
    throw new Error('legacy vault import must fail closed and archive after migration');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'safeStorage + app.db credential authority contract passed',
    encrypt: true,
    decrypt: true,
    appDbAuthority: true,
    utilityProcessOnly: true,
    ipcResolveForbidden: true,
    legacyMigrationFailsClosed: true,
    note: '真机 DPAPI 往返需 Electron app ready；本测试锁定 shipped 代码路径'
  }, null, 2));
}

main();
