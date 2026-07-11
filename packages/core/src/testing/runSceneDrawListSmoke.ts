import { buildMsbSceneManifest } from '../scene/msbSceneManifest.js';
import { buildSceneDrawList } from '../scene/sceneDrawList.js';

function main(): void {
  const manifest = buildMsbSceneManifest({
    mapResourceUri: 'file://map/m10_00_00_00.msb',
    parts: Array.from({ length: 25 }, (_, i) => ({
      name: `m000010_${1000 + i}`,
      posX: i * 2,
      posY: -10,
      posZ: i,
      rotX: i,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1
    })),
    chunkSize: 10
  });
  const full = buildSceneDrawList(manifest, { maxItems: 100 });
  if (full.itemCount !== 25) throw new Error(`expected 25 items, got ${full.itemCount}`);
  if (full.items.some((item) => !item.sourceResourceUri.includes('#part/'))) {
    throw new Error('draw items must keep part URIs');
  }
  const chunk = buildSceneDrawList(manifest, { chunkIndex: 1 });
  if (chunk.itemCount !== 10) throw new Error(`chunk size expected 10, got ${chunk.itemCount}`);
  if (chunk.items[0]?.label !== 'm000010_1010') throw new Error('chunk offset wrong');

  let leaked = false;
  try {
    buildSceneDrawList(buildMsbSceneManifest({
      mapResourceUri: 'file://map/x.msb',
      parts: [{ name: 'ok', posX: 0, posY: 0, posZ: 0 }]
    }));
  } catch {
    leaked = true;
  }
  if (leaked) throw new Error('clean list should not throw');

  console.log(JSON.stringify({
    ok: true,
    message: 'SceneDrawList 代理绘制列表验证通过',
    fullItems: full.itemCount,
    chunkItems: chunk.itemCount,
    center: full.bounds.center,
    samplePrimitive: full.items[0]?.primitive
  }, null, 2));
}

main();
