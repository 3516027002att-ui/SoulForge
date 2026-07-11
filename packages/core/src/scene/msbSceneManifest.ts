/**
 * Build a renderer-safe scene manifest from MSB part transforms.
 * Never includes absolute filesystem paths — only resource URIs and GPU-ready numbers.
 */

export interface MsbPartTransformLike {
  name: string;
  posX: number;
  posY: number;
  posZ: number;
  rotX?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

export interface SceneNode {
  id: string;
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  sourceResourceUri: string;
  kind: 'msb-part';
}

export interface SceneManifest {
  schemaVersion: 1;
  mapResourceUri: string;
  nodeCount: number;
  nodes: SceneNode[];
  /** Chunking hint for large maps. */
  chunkSize: number;
  diagnostics: Array<{ severity: 'info' | 'warning'; code: string; message: string }>;
}

export function buildMsbSceneManifest(input: {
  mapResourceUri: string;
  parts: MsbPartTransformLike[];
  maxNodes?: number;
  chunkSize?: number;
}): SceneManifest {
  const maxNodes = input.maxNodes ?? 50_000;
  const chunkSize = input.chunkSize ?? 512;
  const diagnostics: SceneManifest['diagnostics'] = [];
  const limited = input.parts.slice(0, maxNodes);
  if (input.parts.length > maxNodes) {
    diagnostics.push({
      severity: 'warning',
      code: 'SCENE_NODE_TRUNCATED',
      message: `场景节点超过 ${maxNodes}，已截断。`
    });
  }

  const nodes: SceneNode[] = limited.map((part, index) => ({
    id: `part:${index}:${part.name}`,
    label: part.name,
    position: [part.posX, part.posY, part.posZ],
    rotation: [part.rotX ?? 0, 0, 0],
    scale: [part.scaleX ?? 1, part.scaleY ?? 1, part.scaleZ ?? 1],
    sourceResourceUri: `${input.mapResourceUri}#part/${encodeURIComponent(part.name)}`,
    kind: 'msb-part'
  }));

  // Reject absolute path leakage in labels/uris.
  for (const node of nodes) {
    if (/^[A-Za-z]:\\/.test(node.label) || node.sourceResourceUri.includes(':/Users/') || node.sourceResourceUri.includes('C:\\')) {
      throw new Error('SCENE_ABSOLUTE_PATH_LEAK');
    }
  }

  diagnostics.push({
    severity: 'info',
    code: 'SCENE_MANIFEST_BUILT',
    message: `已从 MSB parts 生成 ${nodes.length} 个场景节点（无绝对路径）。`
  });

  return {
    schemaVersion: 1,
    mapResourceUri: input.mapResourceUri,
    nodeCount: nodes.length,
    nodes,
    chunkSize,
    diagnostics
  };
}

export function chunkSceneNodes(manifest: SceneManifest, chunkIndex: number): SceneNode[] {
  const size = manifest.chunkSize;
  const start = chunkIndex * size;
  return manifest.nodes.slice(start, start + size);
}
