import type { Diagnostic } from './types.js';

export type AssemblyProvenance =
  | {
      kind: 'param-field';
      paramUri: string;
      table: string;
      rowIndex: number;
      fieldId: string;
      expectedDataHash: string;
    }
  | {
      kind: 'explicit-selection';
      selectionEventId: string;
      selectedResourceUri: string;
    };

export interface CharacterAssemblyContext {
  leaderModelUri: string;
  leaderProvenance: AssemblyProvenance;
  bodyParts: Array<{
    slot: string;
    resourceUri: string;
    provenance: AssemblyProvenance;
  }>;
  attachments: Array<{
    resourceUri: string;
    attachBoneName: string;
    provenance: AssemblyProvenance;
  }>;
  workspaceGeneration: number;
}

export interface AnimationPlaybackContext {
  animationContainerUri: string;
  skeletonContainerUri: string;
  animationId: number;
  animationProvenance: AssemblyProvenance;
  skeletonProvenance: AssemblyProvenance;
  workspaceGeneration: number;
}

export interface CharacterAssemblyResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export function isAssemblyProvenance(value: unknown): value is AssemblyProvenance {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (r.kind === 'param-field') {
    return typeof r.paramUri === 'string' && typeof r.table === 'string' && Number.isInteger(r.rowIndex) && typeof r.fieldId === 'string' && typeof r.expectedDataHash === 'string';
  }
  if (r.kind === 'explicit-selection') {
    return typeof r.selectionEventId === 'string' && typeof r.selectedResourceUri === 'string';
  }
  return false;
}

export function isCharacterAssemblyContext(value: unknown): value is CharacterAssemblyContext {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r.leaderModelUri !== 'string' || !isAssemblyProvenance(r.leaderProvenance)) return false;
  if (!Array.isArray(r.bodyParts) || !Array.isArray(r.attachments)) return false;
  if (typeof r.workspaceGeneration !== 'number' || !Number.isInteger(r.workspaceGeneration)) return false;
  for (const part of r.bodyParts as unknown[]) {
    if (!part || typeof part !== 'object') return false;
    const p = part as Record<string, unknown>;
    if (typeof p.slot !== 'string' || typeof p.resourceUri !== 'string' || !isAssemblyProvenance(p.provenance)) return false;
  }
  for (const att of r.attachments as unknown[]) {
    if (!att || typeof att !== 'object') return false;
    const a = att as Record<string, unknown>;
    if (typeof a.resourceUri !== 'string' || typeof a.attachBoneName !== 'string' || !isAssemblyProvenance(a.provenance)) return false;
  }
  return true;
}

export function isAnimationPlaybackContext(value: unknown): value is AnimationPlaybackContext {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.animationContainerUri === 'string'
    && typeof r.skeletonContainerUri === 'string'
    && typeof r.animationId === 'number' && Number.isInteger(r.animationId)
    && isAssemblyProvenance(r.animationProvenance)
    && isAssemblyProvenance(r.skeletonProvenance)
    && typeof r.workspaceGeneration === 'number' && Number.isInteger(r.workspaceGeneration);
}
