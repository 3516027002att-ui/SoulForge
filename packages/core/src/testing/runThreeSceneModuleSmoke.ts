/**
 * Structural check that the shipped Three scene controller exists and enforces
 * path-leak guards in source. Full WebGL mount requires a browser/Electron window.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function main(): void {
  const path = resolve('../../apps/desktop/src/renderer/src/scene/threeSceneController.ts');
  const source = readFileSync(path, 'utf8');
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

  console.log(JSON.stringify({
    ok: true,
    message: 'Three.js 场景控制器源码契约验证通过',
    path: 'apps/desktop/src/renderer/src/scene/threeSceneController.ts',
    usesDynamicThreeImport: true,
    filesystemAccess: false
  }, null, 2));
}

main();
