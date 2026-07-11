/**
 * Browser-safe SceneManifest / DrawList builders (no Node imports).
 * Mirrors packages/core scene helpers for renderer use only.
 */

export interface PartLike {
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
  chunkSize: number;
}

export interface SceneDrawItem {
  id: string;
  label: string;
  primitive: 'box' | 'sphere' | 'point';
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  sourceResourceUri: string;
  colorRgb: [number, number, number];
}

export interface SceneDrawList {
  schemaVersion: 1;
  mapResourceUri: string;
  itemCount: number;
  items: SceneDrawItem[];
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
  };
}

export function buildMsbSceneManifest(input: {
  mapResourceUri: string;
  parts: PartLike[];
  maxNodes?: number;
  chunkSize?: number;
}): SceneManifest {
  const maxNodes = input.maxNodes ?? 50_000;
  const nodes: SceneNode[] = input.parts.slice(0, maxNodes).map((part, index) => ({
    id: `part:${index}:${part.name}`,
    label: part.name,
    position: [part.posX, part.posY, part.posZ],
    rotation: [part.rotX ?? 0, 0, 0],
    scale: [part.scaleX ?? 1, part.scaleY ?? 1, part.scaleZ ?? 1],
    sourceResourceUri: `${input.mapResourceUri}#part/${encodeURIComponent(part.name)}`,
    kind: 'msb-part'
  }));
  const payload = JSON.stringify({ map: input.mapResourceUri, nodes });
  if (/[A-Za-z]:\\/.test(payload) || payload.includes('/Users/')) {
    throw new Error('SCENE_ABSOLUTE_PATH_LEAK');
  }
  return {
    schemaVersion: 1,
    mapResourceUri: input.mapResourceUri,
    nodeCount: nodes.length,
    nodes,
    chunkSize: input.chunkSize ?? 512
  };
}

export function buildSceneDrawList(manifest: SceneManifest, options?: { maxItems?: number }): SceneDrawList {
  const items: SceneDrawItem[] = manifest.nodes.slice(0, options?.maxItems ?? 10_000).map((node, index) => ({
    id: node.id,
    label: node.label,
    primitive: index % 17 === 0 ? 'sphere' : 'box',
    position: node.position,
    rotation: node.rotation,
    scale: node.scale.map((v) => (!Number.isFinite(v) || v === 0 ? 1 : Math.min(Math.max(Math.abs(v), 0.05), 50))) as [number, number, number],
    sourceResourceUri: node.sourceResourceUri,
    colorRgb: [0.4 + (index % 5) * 0.1, 0.5, 0.6]
  }));
  const serialized = JSON.stringify(items);
  if (/[A-Za-z]:\\/.test(serialized) || serialized.includes('/Users/')) {
    throw new Error('SCENE_ABSOLUTE_PATH_LEAK');
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const item of items) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, item.position[i]!);
      max[i] = Math.max(max[i]!, item.position[i]!);
    }
  }
  if (items.length === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  return {
    schemaVersion: 1,
    mapResourceUri: manifest.mapResourceUri,
    itemCount: items.length,
    items,
    bounds: {
      min,
      max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
    }
  };
}
