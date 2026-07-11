/**
 * Scene asset inventory projection from MSB scene manifest nodes.
 * Maps parts → model/material candidates without claiming native FLVER.
 */

import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import type { SceneManifest, SceneNode } from './msbSceneManifest.js';

export type SceneAssetKind = 'model' | 'material' | 'texture' | 'collision' | 'unknown';

export interface SceneAssetRef {
  assetId: string;
  kind: SceneAssetKind;
  label: string;
  /** Relative-style resource label only — never absolute path. */
  resourceLabel: string;
  referencedByPartCount: number;
  partNames: string[];
  authority: 'candidate' | 'fixture-confirmed';
}

export interface SceneAssetInventory {
  mapResourceUri: string;
  assets: SceneAssetRef[];
  partCount: number;
  modelCount: number;
  diagnostics: StructuredDiagnostic[];
}

/**
 * Build inventory from an already renderer-safe scene manifest.
 * Without FLVER/material parsers, model refs stay candidate.
 */
export function buildSceneAssetInventory(
  manifest: SceneManifest,
  options?: { maxPartsSampled?: number }
): SceneAssetInventory {
  const maxParts = options?.maxPartsSampled ?? 10_000;
  const nodes = manifest.nodes.slice(0, maxParts);
  const byKey = new Map<string, SceneAssetRef>();
  const diagnostics: StructuredDiagnostic[] = [];

  for (const node of nodes) {
    const modelLabel = inferModelLabel(node);
    upsert(byKey, {
      assetId: `model:${modelLabel}`,
      kind: 'model',
      label: modelLabel,
      resourceLabel: modelLabel,
      partName: node.label,
      authority: 'candidate'
    });
    // Proxy inventory placeholders until native mesh/material graphs exist.
    upsert(byKey, {
      assetId: 'material:proxy_default',
      kind: 'material',
      label: 'proxy_default',
      resourceLabel: 'material/proxy_default',
      partName: node.label,
      authority: 'candidate'
    });
  }

  if (nodes.length === 0) {
    diagnostics.push(createDiagnostic({
      severity: 'info',
      code: 'SCENE_ASSET_INVENTORY_EMPTY',
      message: '场景清单无 part 节点，无法枚举资产。',
      targetUri: manifest.mapResourceUri
    }));
  } else {
    diagnostics.push(createDiagnostic({
      severity: 'info',
      code: 'SCENE_ASSET_AUTHORITY_CANDIDATE',
      message: '场景资产清单当前仅 candidate（无 FLVER/贴图原生解析）。',
      targetUri: manifest.mapResourceUri,
      details: { partCount: nodes.length, assetCount: byKey.size }
    }));
  }

  if (manifest.nodes.length > maxParts) {
    diagnostics.push(createDiagnostic({
      severity: 'warning',
      code: 'SCENE_ASSET_INVENTORY_TRUNCATED',
      message: `仅采样前 ${maxParts} 个 part（共 ${manifest.nodes.length}）。`,
      targetUri: manifest.mapResourceUri
    }));
  }

  const assets = [...byKey.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
  return {
    mapResourceUri: manifest.mapResourceUri,
    assets,
    partCount: nodes.length,
    modelCount: assets.filter((a) => a.kind === 'model').length,
    diagnostics
  };
}

function inferModelLabel(node: SceneNode): string {
  const name = node.label ?? 'unnamed';
  const prefix = name.split('_')[0] ?? name;
  return sanitizeLabel(
    prefix.startsWith('m') || prefix.startsWith('o') || prefix.startsWith('c')
      ? prefix
      : name
  );
}

function sanitizeLabel(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/+/, '')
    .slice(0, 200);
}

function upsert(
  map: Map<string, SceneAssetRef>,
  input: {
    assetId: string;
    kind: SceneAssetKind;
    label: string;
    resourceLabel: string;
    partName: string;
    authority: 'candidate' | 'fixture-confirmed';
  }
): void {
  const existing = map.get(input.assetId);
  if (!existing) {
    map.set(input.assetId, {
      assetId: input.assetId,
      kind: input.kind,
      label: input.label,
      resourceLabel: input.resourceLabel,
      referencedByPartCount: 1,
      partNames: [input.partName],
      authority: input.authority
    });
    return;
  }
  existing.referencedByPartCount += 1;
  if (existing.partNames.length < 32) {
    existing.partNames.push(input.partName);
  }
}
