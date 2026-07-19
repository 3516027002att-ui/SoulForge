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
  const fmgSemanticCommit = readFileSync(resolve(root, 'packages/core/src/editing/fmgSemanticCommit.ts'), 'utf8');
  const fmgSemanticWriter = readFileSync(resolve(root, 'packages/core/src/writers/fmgSemanticWriter.ts'), 'utf8');
  const msb = readFileSync(resolve(root, 'packages/core/src/editing/msbBridgeRead.ts'), 'utf8');

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
  for (const token of [
    'commitFmgEntryTextThroughPatchIr',
    'commitFmgEntryDeleteThroughPatchIr',
    'commitFmgEntryAddThroughPatchIr',
    'commitFmgEntryReorderThroughPatchIr',
    'stringIndex'
  ]) {
    if (!ipc.includes(token)) throw new Error(`FMG IPC semantic route missing ${token}`);
  }
  if (!fmg.includes("kind: 'set_text'")
    || !fmg.includes("kind: 'insert'")
    || !fmg.includes("kind: 'reorder'")
    || !fmgSemanticCommit.includes("kind: 'resource_field_edit'")
    || !fmgSemanticCommit.includes("kind: 'resource_node_delete'")
    || !fmgSemanticCommit.includes("kind: 'resource_node_add'")
    || !fmgSemanticCommit.includes("kind: 'resource_node_reorder'")
    || !fmgSemanticCommit.includes('commitFmgEntryAddThroughPatchIr')
    || !fmgSemanticWriter.includes('captureInverse')
    || !fmgSemanticWriter.includes('postValidate')
    || !fmgSemanticWriter.includes('resource_node_delete')
    || !fmgSemanticWriter.includes('resource_node_add')
    || !fmgSemanticWriter.includes('resource_node_reorder')) {
    throw new Error(
      'FMG text/slot-delete/insert/reorder must use typed PatchIR, native staged validation and precise inverse'
    );
  }
  if (!msb.includes('read-msb-document')) {
    throw new Error('msbBridgeRead must use read-msb-document');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'FMG typed text/slot-delete/insert/reorder / raw id-wide fallback 与 MSB 桌面 IPC 契约验证通过',
    channels: [
      'resource.readFmgDocument',
      'resource.applyFmgMutation',
      'resource.readMsbDocument'
    ]
  }, null, 2));
}

main();
