import type { CanonicalEntity } from './types.js';

/**
 * Precedence for canonical projections which may coexist during an edit.
 *
 * A dirty working copy is the only uncommitted layer that may override the
 * indexed view.  Pending plans are deliberately excluded from the effective
 * view by default: a plan is intent, not an observed canonical fact.
 */
export type CanonicalProjectionLayer = 'base' | 'overlay' | 'workspace' | 'pending' | 'dirty';

/**
 * Projection provenance is intentionally narrower than a model/tool status.
 * Only a canonical read may produce an observed projection.  A pending plan
 * is an intent and must never be selected as an effective canonical value.
 */
export type CanonicalProjectionObservation = 'canonical-read' | 'pending-plan';

export interface CanonicalProjection<T> {
  identity: string;
  revision: string;
  layer: CanonicalProjectionLayer;
  value: T;
  updatedAt: string;
  /** Stable owner of a dirty projection; absent for legacy/base projections. */
  documentId?: string;
  sourceUri?: string;
  /** Authoritative source revision observed before the working copy changed. */
  baseRevision?: string;
  observation?: CanonicalProjectionObservation;
}

export interface CanonicalSuppressionProjection {
  identity: string;
  revision: string;
  layer: 'dirty';
  documentId: string;
  sourceUri: string;
  baseRevision: string;
  updatedAt: string;
  observation: 'canonical-read';
}

export type CanonicalProjectionEntry<T> = CanonicalProjection<T> | CanonicalSuppressionProjection;

export type CanonicalProjectionSelection<T> =
  | { status: 'empty' }
  | { status: 'resolved'; projection: CanonicalProjection<T> }
  | { status: 'conflict'; projections: CanonicalProjectionEntry<T>[] }
  | { status: 'intent'; projections: CanonicalProjection<T>[] };

export interface CanonicalProjectionStale<T> {
  status: 'stale';
  projections: CanonicalProjectionEntry<T>[];
  actualRevision?: string;
  expectedBaseRevisions: string[];
}

export interface CanonicalProjectionSuppressed {
  status: 'suppressed';
  identity: string;
  documentIds: string[];
  revision: string;
  updatedAt: string;
}

export type CanonicalProjectionResolution<T> =
  | CanonicalProjectionSelection<T>
  | CanonicalProjectionStale<T>
  | CanonicalProjectionSuppressed;

/** The only observation accepted when a dirty working copy enters the index. */
export interface CanonicalReadObservation {
  kind: 'canonical-read';
  sourceUri: string;
  revision: string;
}

/**
 * A document-level dirty snapshot.  `baseRevision` belongs to the
 * authoritative indexed source; `revision` belongs to the observed working
 * copy.  `removedIdentities` are explicit tombstones so a deleted entity does
 * not fall back to an older indexed symbol.
 */
export interface DirtyCanonicalDocument<T extends CanonicalEntityLike = CanonicalEntity> {
  documentId: string;
  sourceUri: string;
  baseRevision: string;
  revision: string;
  observation: CanonicalReadObservation;
  entities: T[];
  removedIdentities: string[];
  observedAt: string;
  updatedAt: string;
}

/** Minimal shape used here to avoid coupling precedence to one entity model. */
export interface CanonicalEntityLike {
  identity: string;
  sourceUri: string;
  revision: string;
  epistemic: string;
}

export interface DirtyCanonicalDocumentInput<T extends CanonicalEntityLike = CanonicalEntity> {
  documentId: string;
  sourceUri: string;
  baseRevision: string;
  revision: string;
  observation: CanonicalReadObservation;
  entities: readonly T[];
  removedIdentities?: readonly string[];
  observedAt?: string;
  updatedAt?: string;
}

export type DirtyCanonicalDocumentErrorCode =
  | 'DIRTY_CANONICAL_INVALID_INPUT'
  | 'DIRTY_CANONICAL_SOURCE_NOT_INDEXED'
  | 'DIRTY_CANONICAL_DUPLICATE'
  | 'DIRTY_CANONICAL_NOT_FOUND'
  | 'DIRTY_CANONICAL_REVISION_CONFLICT'
  | 'DIRTY_CANONICAL_BASE_REVISION_CONFLICT'
  | 'DIRTY_CANONICAL_AUTHORITATIVE_REVISION_CONFLICT';

export interface DirtyCanonicalDocumentFailure {
  ok: false;
  code: DirtyCanonicalDocumentErrorCode;
  diagnostics: string[];
  expectedRevision?: string;
  actualRevision?: string;
}

export interface DirtyCanonicalDocumentSuccess<T extends CanonicalEntityLike = CanonicalEntity> {
  ok: true;
  document: DirtyCanonicalDocument<T>;
}

export type DirtyCanonicalDocumentMutationResult<T extends CanonicalEntityLike = CanonicalEntity> =
  | DirtyCanonicalDocumentFailure
  | DirtyCanonicalDocumentSuccess<T>;

const LAYER_RANK: Readonly<Record<CanonicalProjectionLayer, number>> = {
  base: 10,
  overlay: 20,
  workspace: 30,
  pending: 5,
  dirty: 40
};

export function selectEffectiveCanonicalProjection<T>(
  projections: readonly CanonicalProjection<T>[],
  options: { includePending?: boolean } = {}
): CanonicalProjectionSelection<T> {
  const pending = projections.filter((projection) => projection.layer === 'pending' || projection.observation === 'pending-plan');
  const eligible = projections.filter((projection) => projection.layer !== 'pending' && projection.observation !== 'pending-plan');
  if (eligible.length === 0) {
    return pending.length > 0 && options.includePending === true
      ? { status: 'intent', projections: [...pending] }
      : { status: 'empty' };
  }
  const highestRank = Math.max(...eligible.map((projection) => LAYER_RANK[projection.layer]));
  const highest = eligible.filter((projection) => LAYER_RANK[projection.layer] === highestRank);
  const revisions = new Set(highest.map((projection) => projection.revision));
  if (revisions.size > 1) return { status: 'conflict', projections: highest };
  const documentIds = new Set(highest.map((projection) => projection.documentId).filter((value): value is string => Boolean(value)));
  if (documentIds.size > 1) return { status: 'conflict', projections: highest };
  return {
    status: 'resolved',
    projection: [...highest].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!
  };
}
