import type {
  EventExport,
  IndexedFile,
  MapExport,
  MsgExport,
  ParamExport,
  ResourceKind,
  SymbolBundle,
  TaeExport
} from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';

export interface SemanticFileCacheEntry {
  relativePath: string;
  fileSha256: string;
  resourceKind: ResourceKind;
  payload: SymbolBundle;
  mtimeMs: number;
}

export interface SemanticCacheProvider {
  load: (file: IndexedFile) => Promise<SymbolBundle | null> | SymbolBundle | null;
  save: (file: IndexedFile, bundle: SymbolBundle) => Promise<void> | void;
}

/**
 * Native semantic caches are only reusable when the cached projection carries
 * the same verified packed-file identity and scan revision as the current
 * catalog.  Older cache rows predate outerFileHash/sourceRevision; treating
 * those rows as a hit would silently skip the Bridge export and leave RAG
 * without a freshness proof.  Text/JSON fixture caches intentionally retain
 * the historical cache behavior because they are not native byte projections.
 */
export function isNativeSemanticBundleCurrent(file: IndexedFile, bundle: SymbolBundle): boolean {
  if (!isNativeSemanticCacheCandidate(file)) return true;
  if (!file.sha256) return false;

  const proven = [
    ...(bundle.events ?? []).flatMap((item) => [item, ...item.events]),
    ...(bundle.maps ?? []).flatMap((item) => [item, ...item.entities, ...item.regions]),
    ...(bundle.params ?? []).flatMap((item) => [item, ...item.rows]),
    ...(bundle.msgs ?? []).flatMap((item) => [item, ...item.entries]),
    ...(bundle.tae ?? []).flatMap((item) => [item, ...item.animations.flatMap((anim) => [item, ...anim.events])])
  ] as Array<{ sourceRevision?: number; outerFileHash?: string }>;
  if (proven.length === 0) return false;
  return proven.every((value) => (
    value.sourceRevision === file.mtimeMs
      && value.outerFileHash === file.sha256
  ));
}

function isNativeSemanticCacheCandidate(file: IndexedFile): boolean {
  const path = file.relativePath.toLowerCase();
  if (file.resourceKind === 'event') return path.includes('.emevd');
  if (file.resourceKind === 'map') return path.includes('.msb');
  if (file.resourceKind === 'param') return path.includes('.param');
  if (file.resourceKind === 'msg') {
    return path.endsWith('.fmg')
      || path.endsWith('.fmg.dcx')
      || path.includes('msgbnd')
      || path.includes('.msgbnd');
  }
  return false;
}

/**
 * Extract symbols belonging to a single file from the populated WorkspaceIndex.
 */
export function extractFileSymbolBundle(index: WorkspaceIndex, sourceUri: string): SymbolBundle {
  const full = index.toSymbolBundle();
  const bundle: SymbolBundle = {};

  if (full.params && full.params.length > 0) {
    const params: ParamExport[] = [];
    for (const item of full.params) {
      if (item.sourceUri === sourceUri) {
        params.push(item);
      } else {
        const rows = item.rows.filter((row) => row.sourceUri === sourceUri);
        if (rows.length > 0) {
          params.push({ ...item, rows });
        }
      }
    }
    if (params.length > 0) bundle.params = params;
  }

  if (full.msgs && full.msgs.length > 0) {
    const msgs: MsgExport[] = [];
    for (const item of full.msgs) {
      const entries = item.entries.filter((entry) => entry.sourceUri === sourceUri);
      if (entries.length > 0) {
        msgs.push({ ...item, entries });
      }
    }
    if (msgs.length > 0) bundle.msgs = msgs;
  }

  if (full.events && full.events.length > 0) {
    const events: EventExport[] = [];
    for (const item of full.events) {
      const filteredEvents = item.events.filter((event) => event.sourceUri === sourceUri);
      if (filteredEvents.length > 0) {
        events.push({ ...item, events: filteredEvents });
      }
    }
    if (events.length > 0) bundle.events = events;
  }

  if (full.maps && full.maps.length > 0) {
    const maps: MapExport[] = [];
    for (const item of full.maps) {
      const entities = item.entities.filter((entity) => entity.sourceUri === sourceUri);
      const regions = item.regions.filter((region) => region.sourceUri === sourceUri);
      if (entities.length > 0 || regions.length > 0) {
        maps.push({ ...item, entities, regions });
      }
    }
    if (maps.length > 0) bundle.maps = maps;
  }

  if (full.tae && full.tae.length > 0) {
    const tae = full.tae.filter((item) => item.sourceUri === sourceUri);
    if (tae.length > 0) bundle.tae = tae;
  }

  return bundle;
}

/**
 * Hydrate a cached SymbolBundle into an active WorkspaceIndex.
 */
export function loadSymbolBundleIntoIndex(index: WorkspaceIndex, bundle: SymbolBundle): void {
  if (bundle.events) {
    for (const item of bundle.events) index.upsertEventExport(item);
  }
  if (bundle.maps) {
    for (const item of bundle.maps) index.upsertMapExport(item);
  }
  if (bundle.params) {
    for (const item of bundle.params) index.upsertParamExport(item);
  }
  if (bundle.msgs) {
    for (const item of bundle.msgs) index.upsertMsgExport(item);
  }
  if (bundle.tae) {
    for (const item of bundle.tae) index.upsertTaeExport(item);
  }
}
