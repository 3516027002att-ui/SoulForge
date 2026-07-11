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
    'applyMsbMutation'
  ]) {
    if (!preload.includes(token)) throw new Error(`preload missing ${token}`);
  }
  if (!param.includes('write-param') || !param.includes('read-param-document')) {
    throw new Error('paramBridgeCommit incomplete');
  }
  if (!msb.includes('write-msb')) throw new Error('msbBridgeCommit must use write-msb');
  if (!portable.includes('electron-builder.yml') || !portable.includes('test:release-content')) {
    throw new Error('portable gate incomplete');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'PARAM/MSB 写回 IPC + portable 门禁脚本契约验证通过',
    channels: [
      'resource.readParamDocument',
      'resource.applyParamMutation',
      'resource.applyMsbMutation'
    ],
    portableGate: 'scripts/verify-portable-packaging-gate.mjs'
  }, null, 2));
}

main();
