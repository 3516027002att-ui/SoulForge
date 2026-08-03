/** Browser-safe compatibility exports backed by the shared scene IR. */
export {
  SceneProjectionError,
  buildMsbSceneManifest,
  buildSceneDrawList,
  chunkSceneNodes
} from '@soulforge/shared';
export type {
  MsbMapEventLike,
  MsbModelLike,
  MsbPartTransformLike as PartLike,
  MsbRegionLike,
  MsbSceneSourceCounts,
  SceneDrawItem,
  SceneDrawList,
  SceneManifest,
  SceneNode
} from '@soulforge/shared';
