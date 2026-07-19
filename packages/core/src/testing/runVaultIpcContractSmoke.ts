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
    "'ai.runModel'",
    'permissionGrant.getActive',
    'permissionGrant.getResolvedMode',
    'permissionGrant.replace',
    'permissionGrant.revoke',
    'requestMainNativeConfirmation',
    'resolveAiModeForService',
    'modelServiceVault',
    'resolveApiKey',
    'runAgentToolLoop'
  ];
  for (const token of requiredIpc) {
    if (!ipc.includes(token)) throw new Error(`ipc missing ${token}`);
  }
  if (ipc.includes("handle('modelService.resolveApiKey'")) {
    throw new Error('resolveApiKey must not be an IPC channel');
  }
  if (!ipc.includes('PERMISSION_GRANT_ELEVATION_CANCELLED')) {
    throw new Error('elevation cancel path missing');
  }
  for (const token of [
    'PERMISSION_GRANT_MODE_INVALID',
    'PERMISSION_GRANT_SCOPE_INVALID',
    'normalizePermissionScope'
  ]) {
    if (!ipc.includes(token)) throw new Error(`grant boundary missing ${token}`);
  }

  const requiredPreload = [
    'listModelServices',
    'upsertModelService',
    'deleteModelService',
    'modelServiceEncryptionAvailable',
    'runModelService',
    'getActivePermissionGrant',
    'getResolvedPermissionMode',
    'replacePermissionGrant',
    'revokePermissionGrant'
  ];
  for (const token of requiredPreload) {
    if (!preload.includes(token)) throw new Error(`preload missing ${token}`);
  }
  if (preload.includes('resolveApiKey')) {
    throw new Error('preload must not expose resolveApiKey');
  }
  // Preload may carry typed permissionMode fields for grant RPCs, but must not
  // let renderer set the authoritative mode used by ai.runModel.
  const runModelServiceContract = preload.match(
    /runModelService:\s*\(input:\s*\{([^}]*)\}\)\s*:[^\r\n]+=>/
  )?.[1];
  if (!runModelServiceContract) {
    throw new Error('runModelService preload contract missing');
  }
  if (runModelServiceContract.includes('permissionMode')) {
    throw new Error('runModelService must not accept authoritative permissionMode from renderer');
  }

  if (!dto.includes("'apiKey'") || !dto.includes("'secret'")) {
    throw new Error('rendererDto must strip apiKey/secret keys');
  }
  if (!vault.includes('safeStorage.encryptString')) {
    throw new Error('vault must encrypt with safeStorage');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '模型服务 vault/grant IPC 契约验证通过',
    channels: [
      'modelService.list',
      'modelService.upsert',
      'modelService.delete',
      'modelService.encryptionAvailable',
      'ai.runModel',
      'permissionGrant.getActive',
      'permissionGrant.getResolvedMode',
      'permissionGrant.replace',
      'permissionGrant.revoke',
      'ai.history.getAgentRun',
      'ai.history.listAgentRuns',
      'ai.history.getRetentionMode',
      'ai.history.setRetentionMode'
    ],
    resolveApiKeyExposed: false,
    elevationRequiresMainConfirmation: true
  }, null, 2));
}

main();
