/**
 * GPU-agnostic draw list derived from SceneManifest.
 * Renderer backends (Three.js / tests) consume this — never absolute paths.
 */

import type { SceneManifest, SceneNode } from './msbSceneManifest.js';

export type ProxyPrimitive = 'box' | 'sphere' | 'point';

export interface SceneDrawItem {
  id: string;
  label: string;
  primitive: ProxyPrimitive;
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

export function buildSceneDrawList(
  manifest: SceneManifest,
  options?: { chunkIndex?: number; maxItems?: number }
): SceneDrawList {
  const maxItems = options?.maxItems ?? 10_000;
  let nodes = manifest.nodes;
  if (options?.chunkIndex !== undefined) {
    const start = options.chunkIndex * manifest.chunkSize;
    nodes = nodes.slice(start, start + manifest.chunkSize);
  }
  nodes = nodes.slice(0, maxItems);

  const items: SceneDrawItem[] = nodes.map((node, index) => ({
    id: node.id,
    label: node.label,
    primitive: pickPrimitive(node, index),
    position: node.position,
    rotation: node.rotation,
    scale: sanitizeScale(node.scale),
    sourceResourceUri: node.sourceResourceUri,
    colorRgb: colorForIndex(index)
  }));

  assertNoAbsolutePaths(items, manifest.mapResourceUri);

  return {
    schemaVersion: 1,
    mapResourceUri: manifest.mapResourceUri,
    itemCount: items.length,
    items,
    bounds: computeBounds(items)
  };
}

function pickPrimitive(node: SceneNode, index: number): ProxyPrimitive {
  if (node.label.toLowerCase().includes('col')) return 'box';
  if (index % 17 === 0) return 'sphere';
  return 'box';
}

function sanitizeScale(scale: [number, number, number]): [number, number, number] {
  return scale.map((value) => {
    if (!Number.isFinite(value) || value === 0) return 1;
    return Math.min(Math.max(Math.abs(value), 0.05), 50);
  }) as [number, number, number];
}

function colorForIndex(index: number): [number, number, number] {
  const hue = (index * 47) % 360;
  const s = 0.55;
  const l = 0.55;
  // HSL -> RGB
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function computeBounds(items: SceneDrawItem[]): SceneDrawList['bounds'] {
  if (items.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const item of items) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, item.position[i]!);
      max[i] = Math.max(max[i]!, item.position[i]!);
    }
  }
  return {
    min,
    max,
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2
    ]
  };
}

function assertNoAbsolutePaths(items: SceneDrawItem[], mapUri: string): void {
  const haystack = JSON.stringify({ mapUri, items });
  if (/[A-Za-z]:\\/.test(haystack) || haystack.includes('/Users/') || haystack.includes('C:/')) {
    throw new Error('SCENE_ABSOLUTE_PATH_LEAK');
  }
  for (const item of items) {
    if (!item.sourceResourceUri.startsWith('file://') && !item.sourceResourceUri.includes('://')) {
      throw new Error('SCENE_URI_INVALID');
    }
  }
}
