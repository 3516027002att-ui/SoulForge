/**
 * Scene asset inventory from MSB scene manifest (candidate authority).
 */
import { buildMsbSceneManifest } from '../scene/msbSceneManifest.js';
import { buildSceneAssetInventory } from '../scene/sceneAssetInventory.js';

function main(): void {
  const manifest = buildMsbSceneManifest({
    mapResourceUri: 'file://map/m10_00_00_00.msb',
    parts: [
      { name: 'm000010_1077', posX: 1, posY: 2, posZ: 3 },
      { name: 'm000010_1143', posX: 4, posY: 5, posZ: 6 },
      { name: 'o123456_0000', posX: 0, posY: 0, posZ: 0 },
      { name: 'gate_proxy_a', posX: 8, posY: 0, posZ: 1 }
    ]
  });

  // Absolute path leakage guard
  try {
    buildMsbSceneManifest({
      mapResourceUri: 'file://map/x.msb',
      parts: [{ name: 'C:\\Users\\secret\\evil', posX: 0, posY: 0, posZ: 0 }]
    });
    throw new Error('expected absolute path rejection');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('SCENE_ABSOLUTE_PATH_LEAK')) {
      throw error;
    }
  }

  const inventory = buildSceneAssetInventory(manifest);
  if (inventory.partCount !== 4) {
    throw new Error(`partCount=${inventory.partCount}`);
  }
  if (inventory.modelCount < 2) {
    throw new Error(`expected model groups, got ${inventory.modelCount}`);
  }
  if (!inventory.diagnostics.some((d) => d.code === 'SCENE_ASSET_AUTHORITY_CANDIDATE')) {
    throw new Error('missing candidate authority diagnostic');
  }
  if (JSON.stringify(inventory).includes('C:\\') || JSON.stringify(inventory).includes('/Users/')) {
    throw new Error('absolute path leak in inventory');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '场景资产清单（candidate）验证通过',
    partCount: inventory.partCount,
    modelCount: inventory.modelCount,
    assetCount: inventory.assets.length,
    sample: inventory.assets.slice(0, 4).map((a) => a.assetId)
  }, null, 2));
}

main();
