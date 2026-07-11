/**
 * Structural IPC contract: model service channels exist, preload does not
 * expose resolveApiKey, renderer DTO strips secret fields.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const dto = readFileSync(resolve(root, 'apps/desktop/src/main/rendererDto.ts'), 'utf8');
  const vault = readFileSync(resolve(root, 'apps/desktop/src/main/modelServiceCredentials.ts'), 'utf8');

  const requiredIpc = [
    'modelService.list',
    'modelService.upsert',
    'modelService.delete',
    'modelService.encryptionAvailable',
    'modelServiceVault'
  ];
  for (const token of requiredIpc) {
    if (!ipc.includes(token)) throw new Error(`ipc missing ${token}`);
  }
  if (ipc.includes("handle('modelService.resolveApiKey'")) {
    throw new Error('resolveApiKey must not be an IPC channel');
  }

  const requiredPreload = [
    'listModelServices',
    'upsertModelService',
    'deleteModelService',
    'modelServiceEncryptionAvailable'
  ];
  for (const token of requiredPreload) {
    if (!preload.includes(token)) throw new Error(`preload missing ${token}`);
  }
  if (preload.includes('resolveApiKey')) {
    throw new Error('preload must not expose resolveApiKey');
  }

  if (!dto.includes("'apiKey'") || !dto.includes("'secret'")) {
    throw new Error('rendererDto must strip apiKey/secret keys');
  }
  if (!vault.includes('safeStorage.encryptString')) {
    throw new Error('vault must encrypt with safeStorage');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '模型服务 vault IPC 契约验证通过',
    channels: ['modelService.list', 'modelService.upsert', 'modelService.delete', 'modelService.encryptionAvailable'],
    resolveApiKeyExposed: false
  }, null, 2));
}

main();
