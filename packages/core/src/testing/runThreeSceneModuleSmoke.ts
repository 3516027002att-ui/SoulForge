/**
 * Structural check on the shared scene IR contract plus the renderer scene
 * projection module. The projection layer (threeSceneController.ts) is the
 * authoritative WebGPU-first / WebGL2-fallback scene renderer; this smoke
 * asserts it exists, that it is projection-only (hard constraint 18), and that
 * it keeps the shared scene-ir contract any renderer must consume.
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

  const rendererPath = resolve('../../apps/desktop/src/renderer/src/scene/threeSceneController.ts');
  const rendererSource = readFileSync(rendererPath, 'utf8');
  // Projection entry points: MSB proxy scene + real FLVER mesh scene.
  for (const token of ['mountThreeProxyScene', 'mountFlverScene']) {
    if (!rendererSource.includes(token)) throw new Error(`renderer scene module missing ${token}`);
  }
  // WebGPU-first / WebGL2-fallback contract.
  for (const token of [
    "import('three')",
    "import('three/webgpu')",
    'WebGLRenderer',
    'WebGPURenderer',
    'detectWebGpu'
  ]) {
    if (!rendererSource.includes(token)) throw new Error(`renderer scene module missing backend token ${token}`);
  }
  // Renderer-independent semantic scene + render contract (hard constraint 18).
  for (const token of ['FlverSemanticScene', 'SceneDrawList', 'drawList', 'bounds']) {
    if (!rendererSource.includes(token)) throw new Error(`renderer scene module missing semantic token ${token}`);
  }
  // Picking 视觉反馈 + resource release + deterministic test seams.
  for (const token of [
    'setSelected',
    'selectedId',
    'SCENE_ABSOLUTE_PATH_LEAK',
    'rendererBackend',
    'rendererFactory',
    'resourceAudit',
    'dispose'
  ]) {
    if (!rendererSource.includes(token)) throw new Error(`renderer scene module missing token ${token}`);
  }
  // Projection-only guard: the controller must not claim authority over scene docs.
  if (rendererSource.includes('projection only') === false) {
    throw new Error('renderer scene module must declare it is projection only');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '共享 scene IR 契约 + renderer 投影模块（WebGPU-first/WebGL2 fallback）结构验证通过',
    sharedContract: 'packages/shared/src/scene-ir.ts',
    rendererSceneModule: 'apps/desktop/src/renderer/src/scene/threeSceneController.ts',
    projectionOnly: true,
    filesystemAccess: false
  }, null, 2));
}

main();
