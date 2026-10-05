import { types as utilTypes } from 'node:util';
import type { RagChunk, RagCorpus, ReferenceEdge } from '@soulforge/shared';
import type { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import { createRagCorpus, ragPersistenceChunks } from './chunkBuilder.js';
import { invalidateRetrievalCache } from './retrievalScope.js';

export interface RagChunkDelta {
  sourceUri: string;
  upserts: RagChunk[];
  deletedChunkIds: string[];
}

const PERSIST_BATCH_SIZE = 512;
// `RagChunk` is a closed plain-data DTO on the production build/load paths.
// Keep JSON.stringify as the compatibility fallback for anything outside that
// shape, but compare ordinary chunks by value so object insertion order does
// not cause false upserts after SQLite hydration.
const RAG_CHUNK_REQUIRED_FIELDS = [
  'chunkId', 'workspaceId', 'sourceUri', 'symbolUri', 'family', 'title', 'body', 'numericIds', 'contentHash'
] as const satisfies readonly (keyof RagChunk)[];
const RAG_CHUNK_OPTIONAL_FIELDS = [
  'sourceRevision', 'outerFileHash', 'sourceHash', 'relativePath', 'resourceKind', 'confidence',
  'taeActionEventCount', 'taeActionEventsComplete'
] as const satisfies readonly (keyof RagChunk)[];
const RAG_CHUNK_FIELDS = [...RAG_CHUNK_REQUIRED_FIELDS, ...RAG_CHUNK_OPTIONAL_FIELDS] as const;
type RagChunkField = (typeof RAG_CHUNK_FIELDS)[number];
type UnclassifiedRagChunkField = Exclude<keyof RagChunk, RagChunkField>;
const assertRagChunkComparisonCoversEveryField: (value: UnclassifiedRagChunkField extends never ? true : never) => void = () => {};
assertRagChunkComparisonCoversEveryField(true);
const RAG_CHUNK_FIELD_SET = new Set<string>(RAG_CHUNK_FIELDS);
// These intrinsics inspect accessors without invoking getters or allocating a
// descriptor object for every field. Older hosts without them keep native JSON.
type LegacyAccessorLookup = (this: object, key: string) => unknown;
const objectPrototypeWithLegacyLookup = Object.prototype as unknown as {
  __lookupGetter__?: LegacyAccessorLookup;
  __lookupSetter__?: LegacyAccessorLookup;
};
const lookupGetter = objectPrototypeWithLegacyLookup.__lookupGetter__;
const lookupSetter = objectPrototypeWithLegacyLookup.__lookupSetter__;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;
const hasLegacyAccessorLookup = typeof lookupGetter === 'function' && typeof lookupSetter === 'function';

function sameRagChunk(left: RagChunk, right: RagChunk): boolean {
  const plainLeft = getPlainRagChunk(left);
  const plainRight = getPlainRagChunk(right);
  if (!plainLeft || !plainRight) return JSON.stringify(left) === JSON.stringify(right);

  for (const field of RAG_CHUNK_FIELDS) {
    if (field === 'numericIds') {
      const leftIds = plainLeft.numericIds;
      const rightIds = plainRight.numericIds;
      if (leftIds.length !== rightIds.length) return false;
      for (let index = 0; index < leftIds.length; index += 1) {
        if (leftIds[index] !== rightIds[index]) return false;
      }
    } else if (plainLeft[field] !== plainRight[field]) {
      return false;
    }
  }
  return true;
}

function getPlainRagChunk(value: unknown): RagChunk | undefined {
  if (!hasLegacyAccessorLookup || !value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype || 'toJSON' in value) return undefined;

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > RAG_CHUNK_FIELDS.length) return undefined;
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !isRagChunkField(key)
      || !propertyIsEnumerable.call(value, key)
      || lookupGetter!.call(value, key) !== undefined
      || lookupSetter!.call(value, key) !== undefined
      || !isPlainRagChunkFieldValue(key, (value as Record<string, unknown>)[key])) return undefined;
  }
  for (const key of RAG_CHUNK_REQUIRED_FIELDS) {
    if (!ownKeys.includes(key)) return undefined;
  }
  // Missing optional fields serialize as absent/undefined. Do not read an
  // inherited Object.prototype value as if it were part of the own JSON DTO.
  for (const key of RAG_CHUNK_OPTIONAL_FIELDS) {
    if (!ownKeys.includes(key) && key in value) return undefined;
  }
  return value as RagChunk;
}

function isPlainRagChunkFieldValue(key: RagChunkField, value: unknown): boolean {
  switch (key) {
    case 'numericIds':
      return isDenseFiniteNumberArray(value);
    case 'sourceRevision':
    case 'taeActionEventCount':
      return value === undefined || (typeof value === 'number' && Number.isFinite(value));
    case 'taeActionEventsComplete':
      return value === undefined || typeof value === 'boolean';
    case 'outerFileHash':
    case 'sourceHash':
    case 'relativePath':
    case 'resourceKind':
    case 'confidence':
      return value === undefined || typeof value === 'string';
    default:
      return typeof value === 'string';
  }
}

function isRagChunkField(key: string): key is RagChunkField {
  return RAG_CHUNK_FIELD_SET.has(key);
}

function isDenseFiniteNumberArray(value: unknown): value is number[] {
  if (!hasLegacyAccessorLookup || !Array.isArray(value) || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype || 'toJSON' in value) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || ownKeys[value.length] !== 'length') return false;
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (ownKeys[index] !== key || !propertyIsEnumerable.call(value, key)
      || lookupGetter!.call(value, key) !== undefined
      || lookupSetter!.call(value, key) !== undefined) return false;
    const item = value[index];
    if (typeof item !== 'number' || !Number.isFinite(item)) return false;
  }
  return true;
}

/**
 * Compare two corpora by native source.  The desktop persistence path uses
 * this to send only changed rows instead of the complete workspace corpus.
 */
export function diffRagCorpusBySource(previous: RagCorpus | null | undefined, next: RagCorpus): RagChunkDelta[] {
  const oldChunks = previous ? ragPersistenceChunks(previous) : [];
  const oldById = new Map(oldChunks.map((chunk) => [chunk.chunkId, chunk] as const));
  const nextById = new Map(next.chunks.map((chunk) => [chunk.chunkId, chunk] as const));
  const oldBySource = groupChunksBySource(oldChunks);
  const nextBySource = groupChunksBySource(next.chunks);
  const sourceUris = new Set([...oldBySource.keys(), ...nextBySource.keys()]);
  const deltas: RagChunkDelta[] = [];
  for (const sourceUri of sourceUris) {
    const oldForSource = oldBySource.get(sourceUri) ?? [];
    const nextForSource = nextBySource.get(sourceUri) ?? [];
    const deletedChunkIds = oldForSource
      .filter((chunk) => nextById.get(chunk.chunkId)?.sourceUri !== sourceUri)
      .map((chunk) => chunk.chunkId);
    const upserts = nextForSource.filter((chunk) => {
      const old = oldById.get(chunk.chunkId);
      return !old || !sameRagChunk(old, chunk);
    });
    if (deletedChunkIds.length > 0 || upserts.length > 0) {
      deltas.push({ sourceUri, upserts, deletedChunkIds });
    }
  }
  return deltas;
}

function groupChunksBySource(chunks: readonly RagChunk[]): Map<string, RagChunk[]> {
  const grouped = new Map<string, RagChunk[]>();
  for (const chunk of chunks) {
    const bucket = grouped.get(chunk.sourceUri);
    if (bucket) bucket.push(chunk);
    else grouped.set(chunk.sourceUri, [chunk]);
  }
  return grouped;
}

export function persistRagCorpus(repository: WorkspaceDataRepository, corpus: RagCorpus): void {
  const previous = loadRagCorpus(repository, corpus.workspaceId);
  // Corpus hydration hides stale parser identities; the delta still needs
  // their durable rows so a refreshed source removes old SQLite/FTS entries.
  const deltas = diffRagCorpusBySource({ ...previous, chunks: repository.loadRagChunks() }, corpus);
  for (const delta of deltas) {
    for (let dStart = 0; dStart < delta.deletedChunkIds.length; dStart += PERSIST_BATCH_SIZE) {
      repository.mergeRagChunkDelta({
        sourceUri: delta.sourceUri,
        upserts: [],
        deletedChunkIds: delta.deletedChunkIds.slice(dStart, dStart + PERSIST_BATCH_SIZE)
      });
    }
    for (let start = 0; start < delta.upserts.length; start += PERSIST_BATCH_SIZE) {
      repository.mergeRagChunkDelta({
        sourceUri: delta.sourceUri,
        upserts: delta.upserts.slice(start, start + PERSIST_BATCH_SIZE),
        deletedChunkIds: []
      });
    }
  }
  const referencesChanged = !sameRagReferences(previous.references, corpus.references);
  if (referencesChanged) {
    repository.replaceReferences(corpus.references);
  }
  // A source/relation refresh must not leave an earlier retrieval result in a
  // write-planning cache.  The corpus fingerprint also guards callers that
  // do not persist through this function, while this explicit invalidation
  // handles the normal incremental persistence path immediately.
  if (deltas.length > 0 || referencesChanged) invalidateRetrievalCache(corpus.workspaceId);
}

/** Reference rows are loaded from SQLite in a stable sort order, while the
 * in-memory WorkspaceIndex preserves discovery order.  Compare by content so
 * an unchanged graph does not trigger a full reference-table replacement on
 * every semantic refresh. */
export function sameRagReferences(
  left: readonly ReferenceEdge[],
  right: readonly ReferenceEdge[]
): boolean {
  if (left.length !== right.length) return false;
  const canonical = (edge: ReferenceEdge): string => JSON.stringify([
    edge.fromUri,
    edge.toUri,
    edge.kind,
    edge.confidence,
    edge.reason,
    edge.evidence
  ]);
  const leftKeys = left.map(canonical).sort();
  const rightKeys = right.map(canonical).sort();
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

export function loadRagCorpus(repository: WorkspaceDataRepository, workspaceId: string): RagCorpus {
  return createRagCorpus({
    workspaceId,
    builtAt: new Date().toISOString(),
    chunks: repository.loadRagChunks(),
    references: repository.loadReferences()
  });
}
