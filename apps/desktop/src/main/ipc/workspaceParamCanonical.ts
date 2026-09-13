import type {
  Diagnostic,
  IndexedFile,
  ParamExport,
  RagChunk,
  RagCorpus,
  ReferenceEdge
} from '@soulforge/shared';
import {
  buildRagCorpus,
  cloneParamExport,
  cloneParamExports,
  createRagCorpus,
  mergeCatalogAndPersisted,
  refreshNativeSemanticSources,
  type NativeSemanticRefreshOptions,
  type NativeSemanticRefreshResult,
  WorkspaceIndex
} from '@soulforge/core';

/**
 * Per-analysis-generation cache for the PARAM-only native projection.
 *
 * The cache is deliberately owned by one workspace.analyze invocation.  It is
 * not a second durable authority: it only prevents the stage callback and the
 * final callback of the same generation from decoding an unchanged outer
 * source twice.  A new generation gets a new cache.
 */
export interface ParamCanonicalProjectionCache {
  readonly sources: Map<string, ParamCanonicalProjectionReceipt>;
}

export interface ParamCanonicalProjectionReceipt {
  sourceUri: string;
  identity: string;
  status: ParamCanonicalProjectionStatus;
  exports: ParamExport[];
  diagnostics: Diagnostic[];
}

export type ParamCanonicalProjectionStatus = 'refreshed' | 'partial' | 'failed' | 'stale';

export interface PrepareParamCanonicalProjectionInput {
  index: WorkspaceIndex;
  sourceFiles: readonly IndexedFile[];
  stagingRoot: string;
  allowedRoots: readonly string[];
  oodleRuntimeRoot?: string;
  signal?: AbortSignal;
  cache: ParamCanonicalProjectionCache;
  /** Injectable for the IPC behavior test; production uses the core helper. */
  refresh?: (input: NativeSemanticRefreshOptions) => Promise<NativeSemanticRefreshResult>;
}

export interface PrepareParamCanonicalProjectionResult {
  /** Isolated index used to build the canonical PARAM RAG projection. */
  canonicalIndex: WorkspaceIndex;
  /** Successful canonical exports that may be merged into the live index. */
  canonicalExports: ParamExport[];
  /** Every PARAM source attempted in this call, including failed/stale ones. */
  attemptedSourceUris: string[];
  reusedSourceUris: string[];
  refreshedSources: string[];
  partialSources: string[];
  failedSources: string[];
  staleSources: string[];
  diagnostics: Diagnostic[];
  /** Cancellation never yields a publishable candidate. */
  publishable: boolean;
}

export interface PersistCanonicalRagProjectionInput {
  index: WorkspaceIndex;
  diagnostics?: readonly Diagnostic[];
  attemptedParamSourceUris: readonly string[];
  signal?: AbortSignal;
  now?: string;
  loadPersisted: () => Promise<{
    chunks: readonly RagChunk[];
    references: readonly ReferenceEdge[];
  }>;
  /** Injected so the IPC layer keeps its session-safe durable publication gate. */
  persist: (corpus: RagCorpus, previous: RagCorpus) => Promise<void>;
}

export interface PersistCanonicalRagProjectionResult {
  catalog: RagCorpus;
  persisted: RagCorpus;
  mergeView: RagCorpus;
  corpus: RagCorpus;
}

/**
 * Assemble and durably publish one canonical RAG view.
 *
 * The durable corpus remains the delta baseline.  Only the merge view is
 * filtered for attempted PARAM sources, so a failed leaf is deleted by the
 * injected persistence gate while unattempted PARAM and non-PARAM families
 * remain eligible for merge.
 */
export async function persistCanonicalRagProjection(
  input: PersistCanonicalRagProjectionInput
): Promise<PersistCanonicalRagProjectionResult> {
  throwIfCanonicalAborted(input.signal);
  const catalog = buildRagCorpus(
    input.index,
    input.now ?? new Date().toISOString(),
    input.diagnostics ?? [],
    undefined,
    undefined,
    { lookupIndex: 'deferred' }
  );
  throwIfCanonicalAborted(input.signal);
  const loaded = await input.loadPersisted();
  throwIfCanonicalAborted(input.signal);
  const persisted = createRagCorpus({
    workspaceId: input.index.workspaceId,
    builtAt: catalog.builtAt,
    chunks: loaded.chunks,
    references: loaded.references,
    lookupIndex: 'deferred'
  });
  const mergeView = filterPersistedParamRowsForSources(persisted, input.attemptedParamSourceUris);
  const corpus = mergeCatalogAndPersisted(catalog, mergeView);
  throwIfCanonicalAborted(input.signal);
  await input.persist(corpus, persisted);
  throwIfCanonicalAborted(input.signal);
  return { catalog, persisted, mergeView, corpus };
}

export function createParamCanonicalProjectionCache(): ParamCanonicalProjectionCache {
  return { sources: new Map() };
}

/**
 * Build a PARAM-only canonical candidate.
 *
 * The base index may contain the generic Bridge export.  The candidate first
 * removes every attempted PARAM source, then restores only cached or newly
 * accepted native exports.  Consequently a skipped/failed leaf cannot be
 * reintroduced into the RAG body from the generic base index.  The caller may
 * still keep the base index as the structured-candidate index.
 */
export async function prepareParamCanonicalProjection(
  input: PrepareParamCanonicalProjectionInput
): Promise<PrepareParamCanonicalProjectionResult> {
  const sourceFiles = uniqueParamFiles(input.sourceFiles);
  const attemptedSourceUris = sourceFiles.map((file) => file.sourceUri);
  const canonicalIndex = input.index.cloneForRefresh();
  canonicalIndex.invalidateChangedSources(attemptedSourceUris);

  const diagnostics: Diagnostic[] = [];
  const reusedSourceUris: string[] = [];
  const toRefresh: IndexedFile[] = [];

  if (input.signal?.aborted) {
    return makeAbortedProjectionResult(
      canonicalIndex,
      attemptedSourceUris,
      [{ severity: 'warning', code: 'PARAM_CANONICAL_REFRESH_ABORTED', message: 'PARAM canonical projection 已取消，候选快照不会发布。' }]
    );
  }

  for (const file of sourceFiles) {
    const identity = paramSourceIdentity(file);
    const receipt = input.cache.sources.get(file.sourceUri);
    if (!receipt || receipt.identity !== identity
      || (receipt.status !== 'refreshed' && receipt.status !== 'partial')) {
      toRefresh.push(file);
      continue;
    }

    let reused = true;
    for (const value of receipt.exports) {
      if (!canonicalIndex.upsertParamExport(cloneParamExport(value))) reused = false;
    }
    if (!reused) {
      input.cache.sources.delete(file.sourceUri);
      canonicalIndex.invalidateChangedSources([file.sourceUri]);
      toRefresh.push(file);
      continue;
    }
    reusedSourceUris.push(file.sourceUri);
    diagnostics.push(...receipt.diagnostics);
  }

  let refreshResult: NativeSemanticRefreshResult = {
    refreshedSources: [],
    partialSources: [],
    failedSources: [],
    staleSources: [],
    diagnostics: []
  };

  if (toRefresh.length > 0) {
    try {
      refreshResult = await (input.refresh ?? refreshNativeSemanticSources)({
        index: canonicalIndex,
        sourceFiles: toRefresh,
        stagingRoot: input.stagingRoot,
        allowedRoots: input.allowedRoots,
        ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      refreshResult = {
        refreshedSources: [],
        partialSources: [],
        failedSources: toRefresh.map((file) => file.sourceUri),
        staleSources: [],
        diagnostics: toRefresh.map((file) => ({
          severity: 'error' as const,
          code: 'PARAM_CANONICAL_REFRESH_FAILED',
          message,
          sourceUri: file.sourceUri
        }))
      };
    }
  }

  if (input.signal?.aborted) {
    // The refresh helper may have accepted rows before observing cancellation.
    // Do not memoize or publish that speculative candidate.
    for (const file of toRefresh) input.cache.sources.delete(file.sourceUri);
    return makeAbortedProjectionResult(
      canonicalIndex,
      attemptedSourceUris,
      [...diagnostics, ...refreshResult.diagnostics]
    );
  }

  diagnostics.push(...refreshResult.diagnostics);
  const aborted = Boolean(input.signal?.aborted);
  const statusBySource = new Map<string, ParamCanonicalProjectionStatus>();
  for (const sourceUri of attemptedSourceUris) {
    const status = projectionStatus(refreshResult, sourceUri);
    statusBySource.set(sourceUri, status ?? input.cache.sources.get(sourceUri)?.status ?? 'failed');
  }

  // Capture only the exports in the isolated candidate.  Generic rows from
  // the base index were removed above, so an entry absent here is genuinely
  // unavailable to this canonical RAG attempt; do not infer status from
  // fields.length because zero-field definitions are valid.
  const candidateExportsBySource = paramExportsBySource(canonicalIndex);
  for (const file of sourceFiles) {
    const sourceUri = file.sourceUri;
    const status = statusBySource.get(sourceUri) ?? 'failed';
    // A source may have accepted one leaf before a later leaf failed.  A
    // failed/stale source is not a partial source: remove every accepted leaf
    // so the canonical candidate cannot publish an incomplete source under a
    // misleading status.  Partial sources intentionally retain successful
    // leaves and their per-leaf diagnostics.
    if (status === 'failed' || status === 'stale') {
      canonicalIndex.invalidateChangedSources([sourceUri]);
      candidateExportsBySource.delete(sourceUri);
      input.cache.sources.delete(sourceUri);
    }
    const receipt: ParamCanonicalProjectionReceipt = {
      sourceUri,
      identity: paramSourceIdentity(file),
      status,
      exports: cloneParamExports(candidateExportsBySource.get(sourceUri) ?? []),
      diagnostics: diagnostics.filter((diagnostic) => diagnostic.sourceUri === sourceUri)
    };
    if (status === 'refreshed' || status === 'partial') {
      input.cache.sources.set(sourceUri, receipt);
    }
  }

  const refreshedSources = uniqueStrings([
    ...refreshResult.refreshedSources,
    ...reusedSourceUris.filter((sourceUri) => statusBySource.get(sourceUri) === 'refreshed')
  ]);
  const partialSources = uniqueStrings([
    ...refreshResult.partialSources,
    ...reusedSourceUris.filter((sourceUri) => statusBySource.get(sourceUri) === 'partial')
  ]);
  const failedSources = uniqueStrings([
    ...refreshResult.failedSources,
    ...reusedSourceUris.filter((sourceUri) => statusBySource.get(sourceUri) === 'failed')
  ]);
  const staleSources = uniqueStrings([
    ...refreshResult.staleSources,
    ...reusedSourceUris.filter((sourceUri) => statusBySource.get(sourceUri) === 'stale')
  ]);

  for (const sourceUri of partialSources) {
    diagnostics.push({
      severity: 'warning',
      code: 'PARAM_CANONICAL_SOURCE_PARTIAL',
      message: 'PARAM source 仅有成功解码的 native leaf 进入 canonical RAG；失败 leaf 保持结构化候选但不会进入 RAG。',
      sourceUri
    });
  }
  for (const sourceUri of failedSources) {
    diagnostics.push({
      severity: 'warning',
      code: 'PARAM_CANONICAL_SOURCE_FAILED',
      message: 'PARAM source native projection 失败；该 source 的 generic PARAM leaf 不会进入 canonical RAG。',
      sourceUri
    });
  }
  for (const sourceUri of staleSources) {
    diagnostics.push({
      severity: 'warning',
      code: 'PARAM_CANONICAL_SOURCE_STALE',
      message: 'PARAM source identity 已过期；拒绝把该 source 的 generic leaf 当作 canonical RAG。',
      sourceUri
    });
  }

  const canonicalExports = attemptedSourceUris.flatMap((sourceUri) => (
    candidateExportsBySource.get(sourceUri) ?? []
  ));
  canonicalIndex.rebuildReferences();
  return {
    canonicalIndex,
    canonicalExports,
    attemptedSourceUris,
    reusedSourceUris,
    refreshedSources,
    partialSources,
    failedSources,
    staleSources,
    diagnostics: dedupeDiagnostics(diagnostics),
    publishable: !aborted
  };
}

/** Merge only accepted canonical PARAM exports into a structured live index. */
export function mergeCanonicalParamExports(index: WorkspaceIndex, exports: readonly ParamExport[]): void {
  for (const value of cloneParamExports(exports)) index.upsertParamExport(value);
  index.rebuildReferences();
}

function filterPersistedParamRowsForSources(
  persisted: RagCorpus,
  attemptedParamSourceUris: readonly string[]
): RagCorpus {
  if (attemptedParamSourceUris.length === 0) return persisted;
  const attempted = new Set(attemptedParamSourceUris);
  const chunks = persisted.chunks.filter((chunk) => (
    chunk.family !== 'param_row' || !attempted.has(chunk.sourceUri)
  ));
  return createRagCorpus({
    workspaceId: persisted.workspaceId,
    builtAt: persisted.builtAt,
    chunks,
    references: persisted.references,
    diagnostics: persisted.diagnostics,
    lookupIndex: 'deferred'
  });
}

export function paramSourceIdentity(file: Pick<IndexedFile, 'sourceUri' | 'sha256' | 'mtimeMs'>): string {
  return JSON.stringify([
    file.sourceUri,
    file.sha256 ?? null,
    file.mtimeMs ?? null
  ]);
}

function uniqueParamFiles(files: readonly IndexedFile[]): IndexedFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (file.resourceKind !== 'param' || seen.has(file.sourceUri)) return false;
    seen.add(file.sourceUri);
    return true;
  });
}

function paramExportsBySource(index: WorkspaceIndex): Map<string, ParamExport[]> {
  const bySource = new Map<string, ParamExport[]>();
  for (const value of index.toSymbolBundle().params ?? []) {
    const sourceUri = value.sourceUri ?? value.rows[0]?.sourceUri;
    if (!sourceUri) continue;
    const values = bySource.get(sourceUri) ?? [];
    values.push(value);
    bySource.set(sourceUri, values);
  }
  return bySource;
}

function projectionStatus(
  result: NativeSemanticRefreshResult,
  sourceUri: string
): ParamCanonicalProjectionStatus | undefined {
  if (result.staleSources.includes(sourceUri)) return 'stale';
  if (result.failedSources.includes(sourceUri)) return 'failed';
  if (result.partialSources.includes(sourceUri)) return 'partial';
  if (result.refreshedSources.includes(sourceUri)) return 'refreshed';
  return undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function dedupeDiagnostics(values: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return values.filter((diagnostic) => {
    const key = JSON.stringify([
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
      diagnostic.sourceUri ?? null
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeAbortedProjectionResult(
  canonicalIndex: WorkspaceIndex,
  attemptedSourceUris: readonly string[],
  diagnostics: readonly Diagnostic[]
): PrepareParamCanonicalProjectionResult {
  const abortDiagnostic: Diagnostic = {
    severity: 'warning',
    code: 'PARAM_CANONICAL_REFRESH_ABORTED',
    message: 'PARAM canonical projection 已取消，候选快照不会发布。'
  };
  return {
    canonicalIndex,
    canonicalExports: [],
    attemptedSourceUris: [...attemptedSourceUris],
    reusedSourceUris: [],
    refreshedSources: [],
    partialSources: [],
    failedSources: [],
    staleSources: [],
    diagnostics: dedupeDiagnostics([...diagnostics, abortDiagnostic]),
    publishable: false
  };
}

function throwIfCanonicalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('PARAM canonical RAG publication 已取消。');
  error.name = 'AbortError';
  throw error;
}
