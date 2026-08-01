/**
 * Structural contract for FMG/MSB desktop IPC channels.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const fmg = readFileSync(resolve(root, 'packages/core/src/editing/fmgBridgeCommit.ts'), 'utf8');
  const msb = readFileSync(resolve(root, 'packages/core/src/editing/msbBridgeRead.ts'), 'utf8');
  const protocol = readFileSync(resolve(root, 'packages/shared/src/editor-protocol.ts'), 'utf8');

  for (const token of [
    'resource.readFmgDocument',
    'resource.applyFmgMutation',
    'resource.readMsbDocument',
    'commitFmgMutationViaBridge',
    'readMsbDocumentViaBridge',
    'saveRawReplace'
  ]) {
    if (!ipc.includes(token) && token !== 'saveRawReplace') {
      // applyFmg uses saveRawReplace
    }
    if (!ipc.includes(token)) {
      throw new Error(`ipc missing ${token}`);
    }
  }
  for (const token of ['readFmgDocument', 'applyFmgMutation', 'readMsbDocument']) {
    if (!preload.includes(token)) throw new Error(`preload missing ${token}`);
  }
  if (!fmg.includes('write-fmg') || !fmg.includes('read-fmg-document')) {
    throw new Error('fmgBridgeCommit must use Bridge FMG commands');
  }
  if (!msb.includes('read-msb-document')) {
    throw new Error('msbBridgeRead must use read-msb-document');
  }

  // fmg_entry_add full-chain wiring: shared union -> bridge commit -> main IPC -> preload.
  if (!protocol.includes("'fmg_entry_add'")) {
    throw new Error('editor-protocol must include fmg_entry_add in EditorMutationKind');
  }
  if (!fmg.includes("kind: 'add'")) {
    throw new Error('fmgBridgeCommit must accept add mutation');
  }
  if (!ipc.includes("'upsert' | 'delete' | 'add'") || !ipc.includes("kind: 'add' as const")) {
    throw new Error('ipc resource.applyFmgMutation must accept and forward add');
  }
  if (!preload.includes("'upsert' | 'delete' | 'add'")) {
    throw new Error('preload applyFmgMutation must expose add kind');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'FMG/MSB 桌面 IPC 契约验证通过',
    channels: [
      'resource.readFmgDocument',
      'resource.applyFmgMutation',
      'resource.readMsbDocument'
    ],
    fmgAddWiring: 'shared union + bridge commit + main IPC + preload'
  }, null, 2));
}

main();
