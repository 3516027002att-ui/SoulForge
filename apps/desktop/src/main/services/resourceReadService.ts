import { openResourcePreview, type WorkspaceIndex, type WorkspaceSession } from '@soulforge/core';
import type { IndexedFile } from '@soulforge/shared';
import { sanitizeRendererValue, toRendererIndexedFile, toRendererResourcePreview } from '../rendererDto.js';

export interface ResourceReadServiceDeps {
  getIndexedFiles(): readonly IndexedFile[];
  getActiveIndex(): WorkspaceIndex | null;
  getActiveSession(): WorkspaceSession | null;
  withForegroundPriority<T>(fn: () => Promise<T>): Promise<T>;
}


/** Existing resource orchestration, callable without IPC registration or sender capability. */
export function createResourceReadService(deps: ResourceReadServiceDeps) {
  const preview = async (
    sourceUri: string
  ) => {
      return deps.withForegroundPriority(async () => {
        const indexedFiles = deps.getIndexedFiles();
        const activeSession = deps.getActiveSession();
        const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
        if (
          file &&
          (file.resourceKind === 'param' ||
            file.resourceKind === 'map' ||
            file.resourceKind === 'action')
        ) {
          return sanitizeRendererValue({
            sourceUri: file.sourceUri,
            relativePath: file.relativePath,
            kind: file.resourceKind,
            diagnostics: [],
            structured: null
          });
        }
        if (!file) return null;
        return toRendererResourcePreview(
          await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession?.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          })
        );
      });
    };

  const search = async (
    query: string
  ) => {
    const indexedFiles = deps.getIndexedFiles();
    const activeIndex = deps.getActiveIndex();
    if (activeIndex) {
      const items = activeIndex
        .searchResources({ query, limit: Math.max(100, indexedFiles.length) })
        .map(({ item }) => item);
      return items.map(toRendererIndexedFile);
    }

    // No active workspace means there is no resource catalog to search. Keep
    // the fallback tolerant of slashes, dots and underscores so an old/early
    // scan cannot turn a valid path query into a false empty result.
    const terms = query
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const items = terms.length === 0
      ? indexedFiles
      : indexedFiles.filter((file) => {
          const text = [
            file.relativePath,
            file.resourceKind,
            file.extension,
            file.compoundExtension,
            file.formatKind,
            file.formatLabel
          ].join(' ').toLowerCase().replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, ' ');
          return terms.every((term) => text.includes(term));
        });
    return items.map(toRendererIndexedFile);
  };

  return Object.freeze({ preview, search });
}
export type ResourceReadService = ReturnType<typeof createResourceReadService>;
