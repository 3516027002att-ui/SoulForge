/**
 * Structural check that the shipped Three scene controller exists and enforces
 * path-leak guards in source. Full WebGL mount requires a browser/Electron window.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const path = resolve('../../apps/desktop/src/renderer/src/scene/threeSceneController.ts');
  const source = readFileSync(path, 'utf8');
  const compatibilityPath = resolve('../../apps/desktop/src/renderer/src/scene/sceneManifestBrowser.ts');
  const compatibilitySource = readFileSync(compatibilityPath, 'utf8');
  const sharedPath = resolve('../../packages/shared/src/scene-ir.ts');
  const sharedSource = readFileSync(sharedPath, 'utf8');
  for (const token of [
    'mountThreeProxyScene',
    "import('three')",
    'SCENE_ABSOLUTE_PATH_LEAK',
    'WebGLRenderer',
    'drawList'
  ]) {
    if (!source.includes(token)) throw new Error(`three scene module missing ${token}`);
  }
  if (source.includes('absolutePath') || source.includes('readFile')) {
    throw new Error('three scene controller must not touch filesystem paths');
  }
  if (!compatibilitySource.includes("from '@soulforge/shared'")
    || compatibilitySource.includes('.map((part')
    || compatibilitySource.includes('function buildMsbSceneManifest')) {
    throw new Error('renderer must consume the shared scene IR instead of maintaining a second builder');
  }
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
    message: 'Three.js 场景控制器源码契约验证通过',
    path: 'apps/desktop/src/renderer/src/scene/threeSceneController.ts',
    sharedContract: 'packages/shared/src/scene-ir.ts',
    usesDynamicThreeImport: true,
    filesystemAccess: false,
    duplicateRendererBuilder: false
  }, null, 2));
}

main();
