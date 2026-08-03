/**
 * Structural check on the shared scene IR contract. The renderer Three scene
 * controller was removed from the repository (renderer UI deleted), so this
 * smoke no longer asserts a renderer module exists; it keeps verifying the
 * shared scene-ir contract that any future renderer must consume.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const sharedPath = resolve('../../packages/shared/src/scene-ir.ts');
  const sharedSource = readFileSync(sharedPath, 'utf8');
  for (const token of [
    'schemaVersion: 2',
    'sourcePath: string',
    'revision: string',
    'SCENE_PROJECTION_PARTIAL',
    'SCENE_IDENTITY_FALLBACK',
    'packetId: string'
  ]) {
    if (!sharedSource.includes(token)) throw new Error(`shared scene IR missing ${token}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: '共享 scene IR 契约验证通过（renderer 场景模块已随 renderer UI 移除）',
    sharedContract: 'packages/shared/src/scene-ir.ts',
    rendererSceneModule: 'removed',
    filesystemAccess: false
  }, null, 2));
}

main();
