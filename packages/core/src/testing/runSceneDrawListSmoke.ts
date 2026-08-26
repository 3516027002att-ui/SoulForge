import {
  SceneProjectionError,
  buildMsbSceneManifest
} from '../scene/msbSceneManifest.js';
import { buildSceneDrawList } from '../scene/sceneDrawList.js';

function main(): void {
  const parts = Array.from({ length: 25 }, (_, index) => ({
    name: `m000010_${1000 + index}`,
    nativeOffset: 0x1000 + index * 0x348,
    posX: index * 2,
    posY: -10,
    posZ: index,
    rotX: index,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1
  }));
  const metadata = {
    sourceUri: 'file://map/m10_00_00_00.msb',
    sourcePath: 'map/mapstudio/m10_00_00_00.msb',
    game: 'sekiro',
    resourceKind: 'map' as const,
    revision: 'fixture-1'
  };
  const sourceCounts = { models: 34, parts: 4500, regions: 1089, events: 46, routes: 12 };
  const entities = {
    models: [{ name: 'm000010', nativeOffset: 0x200, typeId: 0 }],
    parts,
    regions: [
      { name: 'Env_Point000', nativeOffset: 0x9000, typeId: 1, posX: 2, posY: 3, posZ: 4 },
      { name: 'Sound_Point000', nativeOffset: 0x9080, typeId: 2, posX: 5, posY: 6, posZ: 7 }
    ],
    events: [{ name: 'Treasure_00', nativeOffset: 0xa000, typeId: 5 }],
    routes: [{ name: 'Route_00', nativeOffset: 0xb000, typeId: 8, id: 42 }]
  };
  const manifest = buildMsbSceneManifest({
    ...metadata,
    ...entities,
    sourceCounts,
    chunkSize: 10
  });
  if (manifest.schemaVersion !== 2 || manifest.revision !== metadata.revision) {
    throw new Error('scene manifest schema/revision mismatch');
  }
  if (manifest.entityCount !== 30 || manifest.nodeCount !== 27) {
    throw new Error(`unexpected scene projection counts: ${manifest.entityCount}/${manifest.nodeCount}`);
  }
  if (!manifest.diagnostics.some((item) => item.code === 'SCENE_PROJECTION_PARTIAL')) {
    throw new Error('truncated native preview must stay partial');
  }
  if (manifest.entities.filter((entity) => entity.kind === 'msb-model').length !== 1
    || manifest.entities.filter((entity) => entity.kind === 'msb-event').length !== 1
    || manifest.entities.filter((entity) => entity.kind === 'msb-route' && entity.routeId === 42).length !== 1
    || manifest.nodes.filter((node) => node.kind === 'msb-region').length !== 2) {
    throw new Error('model/part/region/event/route projection incomplete');
  }

  const full = buildSceneDrawList(manifest, { maxItems: 100 });
  if (full.itemCount !== 27 || full.totalItemCount !== 27 || full.chunkCount !== 1) {
    throw new Error(`unexpected render packet counts: ${JSON.stringify(full)}`);
  }
  if (full.revision !== metadata.revision || full.sourcePath !== metadata.sourcePath) {
    throw new Error('render packet lost source metadata or revision');
  }
  if (full.items.some((item) => !item.sourceResourceUri.includes('#entity/'))) {
    throw new Error('draw items must keep stable entity URIs');
  }
  const chunk = buildSceneDrawList(manifest, { chunkIndex: 1, maxItems: 100 });
  if (chunk.itemCount !== 10 || chunk.chunkCount !== 3) {
    throw new Error(`chunk size/count expected 10/3, got ${chunk.itemCount}/${chunk.chunkCount}`);
  }
  if (chunk.items[0]?.label !== 'm000010_1010') throw new Error('chunk offset wrong');
  const regionPacket = buildSceneDrawList(manifest, { chunkIndex: 2, maxItems: 100 });
  if (!regionPacket.items.some((item) => item.entityKind === 'msb-region' && item.primitive === 'sphere')) {
    throw new Error('region render projection missing');
  }

  const reordered = buildSceneDrawList(buildMsbSceneManifest({
    ...metadata,
    ...entities,
    parts: [...parts].reverse(),
    sourceCounts,
    chunkSize: 100
  }), { maxItems: 100 });
  const originalById = new Map(
    buildSceneDrawList(buildMsbSceneManifest({
      ...metadata,
      ...entities,
      sourceCounts,
      chunkSize: 100
    }), { maxItems: 100 }).items.map((item) => [item.id, item.colorRgb.join(',')])
  );
  for (const item of reordered.items) {
    if (originalById.get(item.id) !== item.colorRgb.join(',')) {
      throw new Error(`entity identity/color changed after reorder: ${item.id}`);
    }
  }

  let rejected: SceneProjectionError | null = null;
  try {
    buildMsbSceneManifest({
      ...metadata,
      sourcePath: 'C:\\private\\m10.msb',
      parts: []
    });
  } catch (error) {
    if (error instanceof SceneProjectionError) rejected = error;
    else throw error;
  }
  if (rejected?.diagnostic.code !== 'SCENE_SOURCE_PATH_INVALID') {
    throw new Error('absolute source path must return a structured projection error');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'MSB semantic scene / render packet 契约验证通过',
    schemaVersion: manifest.schemaVersion,
    revision: manifest.revision,
    entityCount: manifest.entityCount,
    nodeCount: manifest.nodeCount,
    chunkCount: full.chunkCount,
    projectedKinds: [...new Set(manifest.entities.map((entity) => entity.kind))],
    stableIdentityAfterReorder: true,
    absolutePathRejected: rejected.diagnostic.code
  }, null, 2));
}

main();
