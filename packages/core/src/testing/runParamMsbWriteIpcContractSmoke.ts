/**
 * Structural contract: PARAM + MSB write IPC channels exist and go through Patch Engine.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const param = readFileSync(resolve(root, 'packages/core/src/editing/paramBridgeCommit.ts'), 'utf8');
  const msb = readFileSync(resolve(root, 'packages/core/src/editing/msbBridgeCommit.ts'), 'utf8');
  const portable = readFileSync(resolve(root, 'scripts/verify-portable-packaging-gate.mjs'), 'utf8');

  for (const token of [
    'resource.readParamDocument',
    'resource.applyParamMutation',
    'resource.applyParamFieldMutation',
    'resource.applyMsbMutation',
    'commitParamMutationViaBridge',
    'commitMsbMutationViaBridge',
    'saveRawReplace'
  ]) {
    if (!ipc.includes(token)) throw new Error(`ipc missing ${token}`);
  }
  for (const token of [
    'readParamDocument',
    'applyParamMutation',
    'applyParamFieldMutation',
    'applyMsbMutation'
  ]) {
    if (!preload.includes(token)) throw new Error(`preload missing ${token}`);
  }
  if (!ipc.includes('applyParamFieldMutation')) {
    throw new Error('ipc must wire applyParamFieldMutation to the TS field codec');
  }
  if (!preload.includes('rowDataBase64') || !preload.includes('fieldId')) {
    throw new Error('preload applyParamFieldMutation must carry rowDataBase64/fieldId');
  }
  if (!param.includes('write-param') || !param.includes('read-param-document')) {
    throw new Error('paramBridgeCommit incomplete');
  }
  if (!msb.includes('write-msb')) throw new Error('msbBridgeCommit must use write-msb');
  if (!portable.includes('electron-builder.json') || !portable.includes('test:release-content')) {
    throw new Error('portable gate incomplete');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'PARAM/MSB 写回 IPC + portable 门禁脚本契约验证通过',
    channels: [
      'resource.readParamDocument',
      'resource.applyParamMutation',
      'resource.applyParamFieldMutation',
      'resource.applyMsbMutation'
    ],
    paramFieldWiring: 'main IPC -> applyParamFieldMutation -> param_field_set -> whole-row Bridge upsert',
    portableGate: 'scripts/verify-portable-packaging-gate.mjs'
  }, null, 2));
}

main();
