import type { IndexedFile, KnowledgeRefreshSummary } from '@soulforge/shared';
import { WorkspaceIndex, type SourceInvalidationResult } from './workspaceIndex.js';

export type KnowledgeRefreshStatus = 'converged' | 'partial' | 'invalidated' | 'failed' | 'preserved';

export interface KnowledgeRefreshResult {
  status: KnowledgeRefreshStatus;
  changedSources: string[];
  invalidated: SourceInvalidationResult;
  semanticState: 'reanalyzed' | 'partial' | 'empty' | 'preserved';
  error?: string;
}

export interface RefreshKnowledgeAfterCommitInput {
  index: WorkspaceIndex;
  beforeFiles: readonly IndexedFile[];
  afterFiles: readonly IndexedFile[];
  requestedSources?: readonly string[];
  /**
   * Rebuild semantic projections from the post-commit bytes.  A callback is
   * deliberately required by production callers: scanning the file catalog
   * alone is not a semantic refresh.
   */
  reanalyze?: () => Promise<WorkspaceIndex | {
    index: WorkspaceIndex;
    semanticState: 'reanalyzed' | 'partial';
    error?: string;
  }>;
  persist?: (index: WorkspaceIndex) => Promise<void>;
}

export interface RefreshKnowledgeAfterCommitOutput {
  index: WorkspaceIndex;
  result: KnowledgeRefreshResult;
}

export function summarizeKnowledgeRefresh(result: KnowledgeRefreshResult): KnowledgeRefreshSummary {
  const removed = result.invalidated.removed;
  return {
    status: result.status,
    semanticState: result.semanticState,
    changedSourceCount: result.changedSources.length,
    invalidatedSourceCount: result.invalidated.sourceUris.length,
    removedSemanticCount: removed.events
      + removed.mapEntities
      + removed.mapRegions
      + removed.paramRows
      + removed.textEntries
      + removed.taeExports,
    ...(result.error ? { error: result.error } : {})
  };
}

/**
 * The single post-commit knowledge boundary.
 *
 * The order is intentional and must not be weakened to `scan -> setFiles`:
 * changed sources lose their old semantic projections before a new file
 * catalog or persisted RAG corpus can be considered current.  Reanalysis is
 * allowed to fail, but the returned status then remains `invalidated`/`failed`
 * and the caller must not report semantic convergence.
 */
export async function refreshKnowledgeAfterCommit(
  input: RefreshKnowledgeAfterCommitInput
): Promise<RefreshKnowledgeAfterCommitOutput> {
  const changedSources = detectChangedSourceUris(input.beforeFiles, input.afterFiles, input.requestedSources ?? []);
  const invalidated = input.index.invalidateChangedSources(changedSources);
  input.index.setFiles(input.afterFiles);
  input.index.rebuildReferences();

  if (changedSources.length === 0) {
    await input.persist?.(input.index);
    return {
      index: input.index,
      result: {
        status: 'preserved',
        changedSources,
        invalidated,
        semanticState: 'preserved'
      }
    };
  }

  if (!input.reanalyze) {
    await input.persist?.(input.index);
    return {
      index: input.index,
      result: {
        status: 'invalidated',
        changedSources,
        invalidated,
        semanticState: 'empty'
      }
    };
  }

  try {
    const reanalyzedOutput = await input.reanalyze();
    const reanalyzed = reanalyzedOutput instanceof WorkspaceIndex
      ? { index: reanalyzedOutput, semanticState: 'reanalyzed' as const }
      : reanalyzedOutput;
    const semanticState = reanalyzed.semanticState;
    reanalyzed.index.rebuildReferences();
    await input.persist?.(reanalyzed.index);
    return {
      index: reanalyzed.index,
      result: {
        status: semanticState === 'partial' ? 'partial' : 'converged',
        changedSources,
        invalidated,
        semanticState,
        ...(reanalyzed.error ? { error: reanalyzed.error } : {})
      }
    };
  } catch (error) {
    await input.persist?.(input.index);
    return {
      index: input.index,
      result: {
        status: 'failed',
        changedSources,
        invalidated,
        semanticState: 'empty',
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export function detectChangedSourceUris(
  before: readonly IndexedFile[],
  after: readonly IndexedFile[],
  requestedSources: readonly string[] = []
): string[] {
  const beforeByUri = new Map(before.map((file) => [file.sourceUri, file] as const));
  const changed = new Set(requestedSources.filter((sourceUri) => sourceUri.trim().length > 0));

  for (const file of after) {
    const previous = beforeByUri.get(file.sourceUri);
    if (!previous
      || previous.sha256 !== file.sha256
      || previous.size !== file.size
      || previous.mtimeMs !== file.mtimeMs
      || previous.parseStatus !== file.parseStatus) {
      changed.add(file.sourceUri);
    }
  }
  const afterUris = new Set(after.map((file) => file.sourceUri));
  for (const previous of before) {
    if (!afterUris.has(previous.sourceUri)) changed.add(previous.sourceUri);
  }
  return [...changed];
}
