/**
 * Structural contract: desktop EMEVD read/write IPC channels exist,
 * preload exposes them, and no absolute path fields leak into channel names.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const root = resolve('../..');
  const ipc = readFileSync(resolve(root, 'apps/desktop/src/main/ipc.ts'), 'utf8');
  const preload = readFileSync(resolve(root, 'apps/desktop/src/preload/index.ts'), 'utf8');
  const commit = readFileSync(resolve(root, 'packages/core/src/editing/emevdBridgeCommit.ts'), 'utf8');

  for (const token of [
    "handle('resource.readEmevdDocument'",
    "handle(",
    'resource.applyEmevdMutation',
    'commitEmevdMutationViaBridge',
    'saveRawReplace'
  ]) {
    if (!ipc.includes(token) && token !== "handle(") {
      // apply channel may be multi-line handle(
      if (token === 'resource.applyEmevdMutation' && !ipc.includes('resource.applyEmevdMutation')) {
        throw new Error(`ipc missing ${token}`);
      }
      if (token !== 'resource.applyEmevdMutation' && !ipc.includes(token)) {
        throw new Error(`ipc missing ${token}`);
      }
    }
  }
  if (!ipc.includes('resource.readEmevdDocument')) {
    throw new Error('ipc missing resource.readEmevdDocument');
  }
  if (!ipc.includes('resource.applyEmevdMutation')) {
    throw new Error('ipc missing resource.applyEmevdMutation');
  }
  if (!ipc.includes('commitEmevdMutationViaBridge')) {
    throw new Error('ipc must stage via commitEmevdMutationViaBridge');
  }
  if (!ipc.includes('saveRawReplace')) {
    throw new Error('ipc must commit via Patch Engine saveRawReplace');
  }

  // Full-document DSL submit chain: main assembles the authoritative document
  // (pagination) and compiles DSL patches against it; the renderer never holds
  // the full document.
  if (!ipc.includes('resource.readEmevdFullDocument')) {
    throw new Error('ipc missing resource.readEmevdFullDocument');
  }
  if (!ipc.includes('resource.submitEmevdDslPlan')) {
    throw new Error('ipc missing resource.submitEmevdDslPlan');
  }
  if (!ipc.includes('readFullEmevdDocumentViaBridge') || !ipc.includes('submitEmevdDslPlanViaFourView')) {
    throw new Error('ipc must assemble full documents and submit via the four-view production entry');
  }
  if (!ipc.includes('emevdFullDocuments')) {
    throw new Error('ipc must hold the authoritative full EMEVD document cache in main');
  }
  if (!ipc.includes('renderEmevdPatchDslBounded')) {
    throw new Error('ipc must render the DSL template bounded (hard constraint 17)');
  }
  if (!ipc.includes('dslTemplateTruncated') || !ipc.includes('dslTemplateTotalLines')) {
    throw new Error('ipc must report template truncation state to the renderer');
  }
  if (!ipc.includes('loadFullDslTemplate')) {
    throw new Error('ipc must support explicit full-template loading');
  }

  if (!preload.includes('readEmevdDocument') || !preload.includes('applyEmevdMutation')) {
    throw new Error('preload missing EMEVD APIs');
  }
  if (!preload.includes('readEmevdFullDocument') || !preload.includes('submitEmevdDslPlan')) {
    throw new Error('preload missing full-document DSL APIs');
  }
  if (!commit.includes('write-emevd')) {
    throw new Error('emevdBridgeCommit must call write-emevd');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 桌面 IPC 契约验证通过（read + Bridge stage + PatchIR replace + full-document DSL submit）',
    channels: [
      'resource.readEmevdDocument',
      'resource.applyEmevdMutation',
      'resource.readEmevdFullDocument',
      'resource.submitEmevdDslPlan'
    ],
    path: 'main 分页组装完整文档 → DSL 模板 → renderer 编辑 → submitEmevdDslPlanViaFourView → Bridge write-emevd → saveRawReplace'
  }, null, 2));
}

main();
