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
