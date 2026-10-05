import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeWorkspace, scanWorkspace, buildRagCorpus, createRagCorpus, mergeCatalogAndPersisted, preparePostCommitRefreshBaseline, refreshKnowledgeAfterCommit, detectChangedSourceUris, refreshNativeSemanticSources, summarizeKnowledgeRefresh, disposeIdleBridgeDaemonPool, loadSymbolBundleIntoIndex, type WorkspaceIndex, type WorkspaceSession, type RagCorpus, type KnowledgeRefreshResult } from '@soulforge/core';
import type { IndexedFile, SaveTextResourceResult } from '@soulforge/shared';
import type { OperationLogUtilityClient, WorkspaceBoundUtilityStore } from '../operationLogUtilityClient.js';
import { createPostCommitSemanticAnalysisOptions } from '../postCommitSemanticAnalysis.js';
import { persistRagCorpusBySourceDelta } from '../ragPersistence.js';
import { createInvalidatedRagCorpus, createPostCommitRagCorpus } from '../ragRefreshCorpus.js';
import { createSemanticRefreshTelemetry, measureSemanticRefreshStage, measureSemanticRefreshStageSync, type SemanticRefreshTelemetry } from '../semanticRefreshTelemetry.js';

type KnowledgeRefreshCarrier = Pick<SaveTextResourceResult, 'knowledgeRefresh'>;
type SemanticRefreshDatabase = Pick<OperationLogUtilityClient, 'forWorkspace'>;
interface RefreshOwner {
  session: WorkspaceSession | null;
  sessionId: string | null;
  generation: number;
}

export interface SemanticRefreshDeps {
  getWorkspaceSession(): WorkspaceSession | null;
  getActiveWorkspaceSessionIdState(): string | null;
  getActiveWorkspaceSessionGenerationState(): number;
  getWorkspaceIndexedFilesRevisionState(): number;
  getWorkspaceActiveIndex(): WorkspaceIndex | null;
  getWorkspaceRag(): RagCorpus | null;
  applyWorkspaceIndexSnapshot(index: WorkspaceIndex): void;
  applyWorkspaceRag(corpus: RagCorpus): void;
  getActiveOperationLog(): SemanticRefreshDatabase | null;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<SemanticRefreshDatabase>;
  durableStoragePaths(workspaceId: string): { stagingRoot: string };
  hasActiveAgentRuns(): boolean;
  scheduleInternalRagEmbedding(corpus: RagCorpus, database: WorkspaceBoundUtilityStore): void;
}

/** Application-owned refresh scheduling and durable projection. Root supplies
 * live workspace and store ports; native/domain and journal authority remain
 * with their existing implementations. */
export function createSemanticRefreshService(input: SemanticRefreshDeps) {
  const deps = Object.freeze({ ...input });
  let pendingRefreshOwner: RefreshOwner | null = null;

  function captureRefreshOwner(): RefreshOwner {
    return {
      session: deps.getWorkspaceSession(),
      sessionId: deps.getActiveWorkspaceSessionIdState(),
      generation: deps.getActiveWorkspaceSessionGenerationState()
    };
  }

  function sameRefreshOwner(first: RefreshOwner, second: RefreshOwner): boolean {
    return first.session === second.session && first.sessionId === second.sessionId
      && first.generation === second.generation;
  }

  function isRefreshCurrent(owner: RefreshOwner): boolean {
    return sameRefreshOwner(owner, captureRefreshOwner());
  }

  function assertRefreshOwner(owner: RefreshOwner): void {
    if (!isRefreshCurrent(owner)) {
      throw new Error('工作区会话或 generation 已切换，旧语义刷新结果已丢弃。');
    }
  }

  function assertRefreshCatalog(revision: number): void {
    if (deps.getWorkspaceIndexedFilesRevisionState() !== revision) {
      throw Object.assign(new Error('文件目录已更新，旧 RAG 候选不会持久化或发布。'), { code: 'RAG_CATALOG_CHANGED' });
    }
  }
  let semanticRefreshInFlight: Promise<void> | null = null;

  let semanticRefreshQueued = false;

  const semanticRefreshSources = new Set<string>();

  const semanticRefreshSymbols = new Set<string>();

  let semanticRefreshTimer: NodeJS.Timeout | null = null;

  async function persistActiveRag(
    database: WorkspaceBoundUtilityStore,
    corpus: RagCorpus,
    previous: RagCorpus | null = null,
    signal?: AbortSignal,
    telemetry?: SemanticRefreshTelemetry,
    owner: RefreshOwner = captureRefreshOwner(),
    catalogRevision = deps.getWorkspaceIndexedFilesRevisionState()
  ): Promise<void> {
    throwIfRagRefreshAborted(signal);
    const publishingSessionId = owner.sessionId;
    const publishingGeneration = owner.generation;
    const assertRefreshCurrent = (): void => {
      throwIfRagRefreshAborted(signal);
      assertRefreshOwner(owner);
      assertRefreshCatalog(catalogRevision);
      if (publishingSessionId !== deps.getActiveWorkspaceSessionIdState()
        || publishingGeneration !== deps.getActiveWorkspaceSessionGenerationState()
        || deps.getWorkspaceActiveIndex()?.workspaceId !== corpus.workspaceId) {
        throw new Error('工作区已切换，旧语义语料不会持久化。');
      }
    };
    assertRefreshCurrent();
    await persistRagCorpusBySourceDelta(database, corpus, previous, signal, telemetry, assertRefreshCurrent);
    // Do not publish an in-memory corpus before its delta is durable.  A
    // cancelled refresh may already have written one bounded SQLite batch; if
    // the speculative corpus became the next `previous` snapshot, the retry
    // would incorrectly conclude that the database was current and skip the
    // remaining batches.
    throwIfRagRefreshAborted(signal);
    assertRefreshOwner(owner);
    assertRefreshCatalog(catalogRevision);
    if (publishingSessionId !== deps.getActiveWorkspaceSessionIdState()
      || publishingGeneration !== deps.getActiveWorkspaceSessionGenerationState()
      || deps.getWorkspaceActiveIndex()?.workspaceId !== corpus.workspaceId) {
      throw new Error('工作区已切换，旧语义语料不会发布到新会话。');
    }
    deps.applyWorkspaceRag(corpus);
    deps.scheduleInternalRagEmbedding(corpus, database);
  }

  function throwIfRagRefreshAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('RAG 语义持久化已被更新任务取消。');
    error.name = 'AbortError';
    throw error;
  }

  function invalidateActiveRagForPostCommit(index: WorkspaceIndex, invalidatedSources: readonly string[]): void {
    if (invalidatedSources.length === 0) return;
    const current = deps.getWorkspaceRag();
    if (!current || current.workspaceId !== index.workspaceId) return;
    deps.applyWorkspaceRag(createInvalidatedRagCorpus({
      current,
      invalidatedSources,
      builtAt: new Date().toISOString()
    }));
  }

  async function refreshRagAfterScan(
    database: SemanticRefreshDatabase,
    index: WorkspaceIndex,
    signal?: AbortSignal,
    telemetry?: SemanticRefreshTelemetry
  ): Promise<void> {
    const scopedDatabase = database.forWorkspace(index.workspaceId);
    const catalog = buildRagCorpusForRefresh(index, undefined, undefined, undefined, undefined, telemetry);
    const persisted = createRagCorpus({
      workspaceId: index.workspaceId,
      builtAt: catalog.builtAt,
      chunks: await scopedDatabase.loadRagChunks(),
      references: await scopedDatabase.loadReferences(),
      lookupIndex: 'deferred'
    });
    await persistActiveRag(scopedDatabase, mergeCatalogAndPersisted(catalog, persisted, { lookupIndex: 'deferred' }), persisted, signal, telemetry);
  }

  async function refreshRagAfterAnalyze(
    database: SemanticRefreshDatabase,
    index: WorkspaceIndex,
    signal?: AbortSignal,
    changedSources: readonly string[] = [],
    changedSymbols: readonly string[] = [],
    telemetry?: SemanticRefreshTelemetry,
    owner: RefreshOwner = captureRefreshOwner(),
    catalogRevision = deps.getWorkspaceIndexedFilesRevisionState()
  ): Promise<void> {
    assertRefreshOwner(owner);
    assertRefreshCatalog(catalogRevision);
    const scopedDatabase = database.forWorkspace(index.workspaceId);
    const builtAt = new Date().toISOString();
    const sourceFilter = new Set(changedSources.filter((sourceUri) => sourceUri.trim().length > 0));
    const symbolFilter = new Set(changedSymbols.filter((symbolUri) => symbolUri.trim().length > 0));

    // Live native reads already enriched the active in-memory index.  Reusing
    // the last durable in-memory corpus here avoids loading every persisted
    // chunk over the database utility IPC for each read.  Only the changed
    // source is rebuilt and `persistRagCorpusBySourceDelta` writes its delta.
    // The full load below remains the recovery path for the first publication
    // or after the active corpus was intentionally cleared.
    const current = deps.getWorkspaceRag();
    if ((sourceFilter.size > 0 || symbolFilter.size > 0) && current?.workspaceId === index.workspaceId) {
      const changedCatalog = buildRagCorpusForRefresh(
        index,
        builtAt,
        [],
        sourceFilter.size > 0 ? [...sourceFilter] : undefined,
        symbolFilter.size > 0 ? [...symbolFilter] : undefined,
        telemetry
      );
      const next = createPostCommitRagCorpus({
        current,
        changedCatalog,
        changedSources,
        changedSymbols,
        references: index.listReferences(),
        builtAt
      });
      await persistActiveRag(scopedDatabase, next, current, signal, telemetry, owner, catalogRevision);
      return;
    }

    const chunks = await scopedDatabase.loadRagChunks();
    assertRefreshOwner(owner);
    assertRefreshCatalog(catalogRevision);
    throwIfRagRefreshAborted(signal);
    const references = await scopedDatabase.loadReferences();
    assertRefreshOwner(owner);
    assertRefreshCatalog(catalogRevision);
    throwIfRagRefreshAborted(signal);
    const persisted = createRagCorpus({
      workspaceId: index.workspaceId,
      builtAt,
      chunks,
      references,
      lookupIndex: 'deferred'
    });
    let catalog: RagCorpus;
    if (sourceFilter.size === 0 && symbolFilter.size === 0) {
      catalog = buildRagCorpusForRefresh(index, builtAt, undefined, undefined, undefined, telemetry);
    } else {
      const changedCatalog = buildRagCorpusForRefresh(
        index,
        builtAt,
        [],
        sourceFilter.size > 0 ? [...sourceFilter] : undefined,
        symbolFilter.size > 0 ? [...symbolFilter] : undefined,
        telemetry
      );
      const current = deps.getWorkspaceRag();
      const base = current?.workspaceId === index.workspaceId ? current : persisted;
      catalog = createPostCommitRagCorpus({
        current: base,
        changedCatalog,
        changedSources: [...sourceFilter],
        changedSymbols: [...symbolFilter],
        references: index.listReferences(),
        builtAt
      });
    }
    await persistActiveRag(scopedDatabase, mergeCatalogAndPersisted(catalog, persisted, { lookupIndex: 'deferred' }), persisted, signal, telemetry, owner, catalogRevision);
  }

  function buildRagCorpusForRefresh(
    index: WorkspaceIndex,
    builtAt?: string,
    diagnostics?: readonly import('@soulforge/shared').Diagnostic[],
    sourceUris?: readonly string[],
    symbolUris?: readonly string[],
    telemetry?: SemanticRefreshTelemetry
  ): RagCorpus {
    const build = () => buildRagCorpus(index, builtAt, diagnostics, sourceUris, symbolUris, {
      lookupIndex: 'deferred',
      ...((sourceUris?.length ?? 0) > 0 || (symbolUris?.length ?? 0) > 0 ? { includeReferences: false } : {})
    });
    if (!telemetry) return build();
    return measureSemanticRefreshStageSync(telemetry, 'ragBuild', build, (value) => ({
      chunkCount: value.chunks.length,
      referenceCount: value.references.length,
      sourceCount: new Set(value.chunks.map((chunk) => chunk.sourceUri)).size
    }));
  }

  async function performActiveIndexSemanticRefresh(
    owner: RefreshOwner,
    changedSources: readonly string[] = [],
    changedSymbols: readonly string[] = [],
    signal?: AbortSignal
  ): Promise<void> {
    const index = deps.getWorkspaceActiveIndex();
    const sessionId = owner.sessionId;
    if (!index || !sessionId) return;
    throwIfRagRefreshAborted(signal);
    const telemetry = createSemanticRefreshTelemetry('deferred');
    // Live read tools have already replaced/merged the relevant semantic export
    // in this index.  Do not rescan the whole workspace here: the callback is
    // invoked from every native read, and a full scan + Binder rebuild per read
    // was the main CPU/SQLite queue multiplier in long agent searches.  The next
    // normal workspace scan still refreshes file hashes and Binder membership;
    // this path only publishes the already-authoritative in-memory read result.
    try {
      assertRefreshOwner(owner);
      index.rebuildReferences();
      deps.applyWorkspaceIndexSnapshot(index);
      const catalogRevision = deps.getWorkspaceIndexedFilesRevisionState();
      const session = owner.session;
      if (!session || sessionId !== deps.getActiveWorkspaceSessionIdState()) {
        telemetry.finish('invalidated');
        return;
      }
      const database = deps.getActiveOperationLog() ?? await deps.ensureActiveOperationLog(session);
      assertRefreshOwner(owner);
      assertRefreshCatalog(catalogRevision);
      if (sessionId !== deps.getActiveWorkspaceSessionIdState()) {
        telemetry.finish('invalidated');
        return;
      }
      await refreshRagAfterAnalyze(database, index, signal, changedSources, changedSymbols, telemetry, owner, catalogRevision);
      telemetry.finish('completed');
    } catch (error) {
      telemetry.finish(isRefreshCurrent(owner) ? 'failed' : 'invalidated', error);
      throw error;
    }
  }

  const SEMANTIC_REFRESH_DEBOUNCE_MS = 40;

  const SEMANTIC_REFRESH_IDLE_POLL_MS = 250;

  const NATIVE_KNOWLEDGE_REFRESH_DEADLINE_MS = 180_000;

  function reportDeferredSemanticRefreshFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[SoulForge RAG] deferred semantic refresh failed: ${message}`);
  }

  function startSemanticRefresh(): Promise<void> {
    if (semanticRefreshInFlight) return semanticRefreshInFlight;
    semanticRefreshInFlight = (async () => {
      // Assign the in-flight promise before a stale/no-work batch can finish.
      await Promise.resolve();
      try {
        // Keep collecting callbacks which arrive during the debounce window or
        // while the source-delta write is running.  If an Agent is still active,
        // leave the batch queued and let the idle timer resume it later.
        do {
          if (deps.hasActiveAgentRuns()) {
            scheduleSemanticRefreshWhenIdle();
            return;
          }
          semanticRefreshQueued = false;
          const owner = pendingRefreshOwner;
          pendingRefreshOwner = null;
          const sourcesForRefresh = [...semanticRefreshSources];
          const symbolsForRefresh = [...semanticRefreshSymbols];
          // Take ownership of this batch before awaiting.  A callback that
          // arrives while the refresh is running must remain in the next batch;
          // deleting the set after await would lose that update.
          semanticRefreshSources.clear();
          semanticRefreshSymbols.clear();
          if (owner && isRefreshCurrent(owner)) {
            await performActiveIndexSemanticRefresh(owner, sourcesForRefresh, symbolsForRefresh);
          }
        } while (semanticRefreshQueued || semanticRefreshSources.size > 0 || semanticRefreshSymbols.size > 0);
      } finally {
        semanticRefreshInFlight = null;
        if (semanticRefreshQueued || semanticRefreshSources.size > 0 || semanticRefreshSymbols.size > 0) {
          scheduleSemanticRefreshWhenIdle();
        }
      }
    })();
    return semanticRefreshInFlight;
  }

  function scheduleSemanticRefreshWhenIdle(): void {
    if (semanticRefreshTimer) return;
    if (!semanticRefreshQueued && semanticRefreshSources.size === 0 && semanticRefreshSymbols.size === 0) return;
    const delay = deps.hasActiveAgentRuns() ? SEMANTIC_REFRESH_IDLE_POLL_MS : SEMANTIC_REFRESH_DEBOUNCE_MS;
    semanticRefreshTimer = setTimeout(() => {
      semanticRefreshTimer = null;
      if (deps.hasActiveAgentRuns()) {
        scheduleSemanticRefreshWhenIdle();
        return;
      }
      if (!semanticRefreshQueued && semanticRefreshSources.size === 0 && semanticRefreshSymbols.size === 0) return;
      void startSemanticRefresh().catch(reportDeferredSemanticRefreshFailure);
    }, delay);
    semanticRefreshTimer.unref?.();
  }

  function refreshActiveIndexAfterSemanticEvidence(
    sourceUris: readonly string[] = [],
    symbolUris: readonly string[] = []
  ): Promise<void> {
    const owner = captureRefreshOwner();
    if (!owner.session || !owner.sessionId || !deps.getWorkspaceActiveIndex()) return Promise.resolve();
    if (pendingRefreshOwner && !sameRefreshOwner(pendingRefreshOwner, owner)) {
      semanticRefreshSources.clear();
      semanticRefreshSymbols.clear();
    }
    pendingRefreshOwner = owner;
    for (const sourceUri of sourceUris) {
      if (sourceUri.trim().length > 0) semanticRefreshSources.add(sourceUri);
    }
    for (const symbolUri of symbolUris) {
      if (symbolUri.trim().length > 0) semanticRefreshSymbols.add(symbolUri);
    }
    semanticRefreshQueued = true;
    if (deps.hasActiveAgentRuns()) {
      scheduleSemanticRefreshWhenIdle();
      return Promise.resolve();
    }
    if (semanticRefreshTimer) {
      clearTimeout(semanticRefreshTimer);
      semanticRefreshTimer = null;
    }
    return startSemanticRefresh();
  }

  async function refreshActiveIndexAfterNativeWrite(
    changedSources: readonly string[] = [],
    carrier?: KnowledgeRefreshCarrier
  ): Promise<KnowledgeRefreshResult | void> {
    const owner = captureRefreshOwner();
    const session = deps.getWorkspaceSession();
    const currentIndex = deps.getWorkspaceActiveIndex();
    const sessionId = deps.getActiveWorkspaceSessionIdState();
    const sessionGeneration = deps.getActiveWorkspaceSessionGenerationState();
    let catalogRevision = deps.getWorkspaceIndexedFilesRevisionState();
    if (!session || !currentIndex || !sessionId) return;
    const telemetry = createSemanticRefreshTelemetry('postcommit');
    const refreshController = new AbortController();
    let rejectRefreshDeadline!: (reason: Error) => void;
    const refreshDeadline = new Promise<never>((_, reject) => {
      rejectRefreshDeadline = reject;
    });
    const refreshTimer = setTimeout(
      () => {
        const error = new Error('post-commit knowledge refresh deadline exceeded');
        refreshController.abort(error);
        rejectRefreshDeadline(error);
      },
      NATIVE_KNOWLEDGE_REFRESH_DEADLINE_MS
    );
    refreshTimer.unref?.();
    const assertCurrentGeneration = (): void => {
      if (refreshController.signal.aborted) {
        throw new Error('写后 knowledge refresh 已超时或被取消。');
      }
      assertRefreshOwner(owner);
      assertRefreshCatalog(catalogRevision);
      if (deps.getActiveWorkspaceSessionIdState() !== sessionId
        || deps.getActiveWorkspaceSessionGenerationState() !== sessionGeneration) {
        throw new Error('工作区会话或 generation 已切换，迟到的写后刷新结果已丢弃。');
      }
    };
    try {
      const beforeFiles = currentIndex.getFiles();
      const requestedSources = resolveKnowledgeSourceUris(changedSources, beforeFiles);
      let actualChangedSources = [...requestedSources];
      // The write is already committed.  Invalidate the known requested sources
      // before the potentially slow catalog scan so a scan timeout cannot leave
      // the old semantic projection looking current.
      let liveInvalidation = preparePostCommitRefreshBaseline(currentIndex, requestedSources).invalidated;
      invalidateActiveRagForPostCommit(currentIndex, liveInvalidation.sourceUris);
      deps.applyWorkspaceIndexSnapshot(currentIndex);
      catalogRevision = deps.getWorkspaceIndexedFilesRevisionState();

      // The live index is now a stale-safe baseline: all requested semantics were
      // removed before the scan. Reuse it while the scoped analyzer builds fresh
      // source projections, then clone once at publish to keep fresh semantics
      // isolated until freshness checks and RAG persistence pass.
      const workPromise = (async () => {
        // Idle cleanup belongs to the same bounded workflow. A stalled cleanup
        // must not postpone observing the existing postcommit deadline.
        // Reclaim only idle clients; concurrent native requests stay untouched.
        try {
          const bridgeClients = await disposeIdleBridgeDaemonPool();
          if (bridgeClients.disposedClientCount > 0) {
            console.info(`[SoulForge native-refresh] released ${bridgeClients.disposedClientCount} idle Bridge client(s); active=${bridgeClients.activeClientCount}.`);
          }
        } catch (error) {
          console.warn('[SoulForge native-refresh] idle Bridge client cleanup failed; continuing with committed write refresh.', error);
        }
        assertCurrentGeneration();
        const result = await measureSemanticRefreshStage(
          telemetry,
          'scan',
          () => scanWorkspace({
            workspaceRoot: session.layers.overlayRoot,
            game: session.meta.game,
            signal: refreshController.signal
          }),
          (value) => ({
            fileCount: value.files.length,
            changedSourceCount: detectChangedSourceUris(beforeFiles, value.files, requestedSources).length
          })
        );
        assertCurrentGeneration();

        actualChangedSources = detectChangedSourceUris(beforeFiles, result.files, requestedSources);
        const additionalInvalidation = preparePostCommitRefreshBaseline(currentIndex, actualChangedSources).invalidated;
        invalidateActiveRagForPostCommit(currentIndex, additionalInvalidation.sourceUris);
        liveInvalidation = mergeKnowledgeInvalidations(liveInvalidation, additionalInvalidation);
        deps.applyWorkspaceIndexSnapshot(currentIndex);
        catalogRevision = deps.getWorkspaceIndexedFilesRevisionState();
        assertCurrentGeneration();

        const database = deps.getActiveOperationLog() ?? await deps.ensureActiveOperationLog(session);
        assertCurrentGeneration();
        return refreshKnowledgeAfterCommit({
          index: currentIndex,
          beforeFiles,
          afterFiles: result.files,
          requestedSources,
          signal: refreshController.signal,
          onRefreshBoundary: (stage, phase) => {
            if (phase === 'started') telemetry.begin(stage);
            else telemetry.complete(stage, phase);
          },
          // A catalog scan cannot prove semantic truth. Re-run the production
          // analyzer only for the actual changed source set, including changes
          // discovered by the scan, while unchanged projections stay in the
          // stale-safe live baseline.
          reanalyze: async (changedSourceUris, signal) => {
            assertCurrentGeneration();
            const changedFiles = result.files.filter((file) => changedSourceUris.includes(file.sourceUri));
            const analyzed = await measureSemanticRefreshStage(
              telemetry,
              'analyze',
              () => analyzeWorkspace(createPostCommitSemanticAnalysisOptions({
                workspaceRoot: session.layers.overlayRoot,
                files: changedFiles,
                ...(signal ? { signal } : {}),
                ...(session.layers.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {})
              })),
              (value) => ({
                fileCount: changedFiles.length,
                parsedFiles: value.parsedFiles,
                inspectedFiles: value.inspectedFiles
              })
            );
            assertCurrentGeneration();
            const nativeRefresh = await measureSemanticRefreshStage(
              telemetry,
              'nativeDecode',
              () => refreshNativeSemanticSources({
                index: analyzed.index,
                workspaceSessionId: sessionId,
                // analyzeWorkspace produced a disposable source-scoped candidate;
                // the active workspace already holds a separate stale-safe,
                // invalidated baseline. Decode in place instead of duplicating
                // a large PARAM/MSG projection during post-commit readback.
                indexOwnership: 'isolated-candidate',
                sourceFiles: changedFiles,
                stagingRoot: deps.durableStoragePaths(session.meta.workspaceId).stagingRoot,
                allowedRoots: [
                  session.layers.overlayRoot,
                  ...(session.layers.baseRoot ? [session.layers.baseRoot] : [])
                ],
                ...(signal ? { signal } : {}),
                ...(session.layers.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {}),
                ...(process.env.SOULFORGE_NATIVE_PARAM_TRACE === '1'
                  ? { paramReadProgress: (progress) => console.info(`[SoulForge native-param-progress] ${JSON.stringify(progress)}`) }
                  : {})
              }),
              (value) => ({
                sourceCount: changedFiles.length,
                partialSourceCount: value.partialSources.length,
                failedSourceCount: value.failedSources.length,
                changedSourceCount: value.refreshedSources.length
              })
            );
            if (nativeRefresh.failedSources.length > 0) {
              const detail = nativeRefresh.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('；');
              throw new Error(detail || `native semantic refresh failed for ${nativeRefresh.failedSources.length} source(s)`);
            }
            assertCurrentGeneration();
            return {
              // Keep the candidate isolated until refreshKnowledgeAfterCommit has
              // checked every changed source's post-scan revision.
              index: analyzed.index,
              semanticState: nativeRefresh.partialSources.length > 0 ? 'partial' as const : 'reanalyzed' as const,
              ...(nativeRefresh.partialSources.length > 0
                ? { error: nativeRefresh.diagnostics.map((diagnostic) => diagnostic.message).join('；') }
                : {})
            };
          },
          publish: async (candidate) => {
            assertCurrentGeneration();
            // `analyzeWorkspace({ files })` returns a source-scoped index. Merge
            // it into one isolated full snapshot; the live baseline has already
            // invalidated changed sources and remains safe if persistence fails.
            const publishedIndex = currentIndex.cloneForRefreshShared();
            loadSymbolBundleIntoIndex(publishedIndex, candidate.toSymbolBundle());
            // refreshKnowledgeAfterCommit rebuilds the graph exactly once after
            // publish; doing it here as well needlessly keeps two full graphs live
            // during the large PARAM post-commit path.
            publishedIndex.markActionBinderMembershipGlobalNotReady();
            return publishedIndex;
          },
          persist: async (index, changedSourceUris, signal) => {
            assertCurrentGeneration();
            // Do not publish the live index until the RAG source delta is durable.
            await refreshRagAfterAnalyze(database, index, signal, changedSourceUris, [], telemetry, owner, catalogRevision);
            assertCurrentGeneration();
            deps.applyWorkspaceIndexSnapshot(index);
            catalogRevision = deps.getWorkspaceIndexedFilesRevisionState();
          }
        });
      })();
      try {
        // Both branches are observed immediately. If a non-cooperative
        // Bridge/SQLite promise finishes after the deadline, its rejection cannot
        // become an unhandled rejection or publish a late candidate.
        const output = await Promise.race([workPromise, refreshDeadline]);
        assertCurrentGeneration();
        const result = {
          ...output.result,
          invalidated: mergeKnowledgeInvalidations(liveInvalidation, output.result.invalidated)
        };
        deps.applyWorkspaceIndexSnapshot(output.index);
        telemetry.finish(
          result.status === 'partial'
            ? 'partial'
            : result.status === 'failed'
              ? 'failed'
              : result.status === 'invalidated'
                ? 'invalidated'
                : 'completed',
          result.error
        );
        if (carrier) carrier.knowledgeRefresh = summarizeKnowledgeRefresh(result);
        return result;
      } catch (error) {
        const stillCurrent = isRefreshCurrent(owner) && deps.getWorkspaceIndexedFilesRevisionState() === catalogRevision
          && deps.getActiveWorkspaceSessionIdState() === sessionId
          && deps.getActiveWorkspaceSessionGenerationState() === sessionGeneration;
        const failureInvalidation = preparePostCommitRefreshBaseline(currentIndex, actualChangedSources).invalidated;
        const invalidated = mergeKnowledgeInvalidations(
          liveInvalidation,
          failureInvalidation
        );
        if (stillCurrent) deps.applyWorkspaceIndexSnapshot(currentIndex);
        const result: KnowledgeRefreshResult = {
          status: 'failed',
          changedSources: [...new Set(actualChangedSources)],
          invalidated,
          semanticState: 'empty',
          error: error instanceof Error ? error.message : String(error)
        };
        telemetry.finish(stillCurrent ? 'failed' : 'invalidated', error);
        if (carrier && stillCurrent) carrier.knowledgeRefresh = summarizeKnowledgeRefresh(result);
        return result;
      } finally {
        void workPromise.catch(() => undefined);
      }
    } finally {
      clearTimeout(refreshTimer);
    }
  }

  function mergeKnowledgeInvalidations(
    first: KnowledgeRefreshResult['invalidated'],
    second: KnowledgeRefreshResult['invalidated']
  ): KnowledgeRefreshResult['invalidated'] {
    return {
      sourceUris: [...new Set([...first.sourceUris, ...second.sourceUris])],
      removed: {
        events: first.removed.events + second.removed.events,
        mapEntities: first.removed.mapEntities + second.removed.mapEntities,
        mapRegions: first.removed.mapRegions + second.removed.mapRegions,
        paramRows: first.removed.paramRows + second.removed.paramRows,
        textEntries: first.removed.textEntries + second.removed.textEntries,
        taeExports: first.removed.taeExports + second.removed.taeExports
      },
      // This is the final reference-edge count, not an increment.
      referencesRebuilt: Math.max(first.referencesRebuilt, second.referencesRebuilt)
    };
  }

  function resolveKnowledgeSourceUris(sourceIds: readonly string[], files: readonly IndexedFile[]): string[] {
    const resolved: string[] = [];
    for (const sourceId of sourceIds) {
      const match = files.find((file) => (
        file.sourceUri === sourceId
        || file.absolutePath === sourceId
        || file.sourcePath === sourceId
        || file.relativePath === sourceId
      ));
      if (match) {
        resolved.push(match.sourceUri);
      } else if (sourceId.startsWith('file://')) {
        resolved.push(sourceId);
      } else if (resolve(sourceId) === sourceId) {
        resolved.push(pathToFileURL(sourceId).href);
      }
    }
    return [...new Set(resolved)];
  }

  return Object.freeze({ refreshActiveIndexAfterSemanticEvidence, refreshActiveIndexAfterNativeWrite });
}

export type SemanticRefreshService = ReturnType<typeof createSemanticRefreshService>;
