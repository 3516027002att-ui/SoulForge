import { getRagStaleChunkMaskCached, retrieveEvidence, retrieveEvidenceHybrid, resolveRagCorpus, createRagCorpus, type RagCorpus, type ToolContext, type WorkspaceIndex, type WorkspaceSession } from '@soulforge/core';
import { maskPathFragments, type RagChunkFamily, type RagLocalModelStatus, type RagRetrieveResult } from '@soulforge/shared';
import { INTERNAL_RAG_EMBEDDING, type InternalRagEmbeddingService } from '../ragEmbedding.js';
import type { OperationLogUtilityClient, WorkspaceBoundUtilityStore } from '../operationLogUtilityClient.js';
import { prepareAgentRagSearchCorpus } from '../ragRefreshCorpus.js';
import { isAgentRagSearchIdentityCurrent, type AgentRagSearchIdentity } from '../ipc/agentRagIdentity.js';

export interface AgentEvidenceServiceDeps {
  internalRagEmbedding: InternalRagEmbeddingService;
  operationLogUtility: OperationLogUtilityClient;
  getActiveIndex(): WorkspaceIndex | null;
  getActiveSession(): WorkspaceSession | null;
  getActiveWorkspaceSessionId(): string | null;
  getActiveWorkspaceSessionGeneration(): number;
  currentToolContext(): ToolContext;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
}

/** Local-only vector acceleration and source-bound evidence retrieval. */
export function createAgentEvidenceService(input: AgentEvidenceServiceDeps) {
  const deps = Object.freeze({ ...input });

  function currentEvidenceIdentity(): AgentRagSearchIdentity {
    const context = deps.currentToolContext();
    return {
      activeIndex: deps.getActiveIndex(), activeSession: deps.getActiveSession(),
      workspaceSessionId: deps.getActiveWorkspaceSessionId(), workspaceSessionGeneration: deps.getActiveWorkspaceSessionGeneration(),
      ragEpoch: context.ragEpoch, ragScope: context.ragScope, ragSessionId: context.ragSessionId,
      ragGeneration: context.ragGeneration, ragIndexedFilesRevision: context.ragIndexedFilesRevision
    };
  }

  function embeddingOwnerCurrent(expected: AgentRagSearchIdentity): boolean {
    return isAgentRagSearchIdentityCurrent(expected, currentEvidenceIdentity());
  }

  function staleEmbeddingResult(): { ok: false; error: { code: string; message: string } } {
    return { ok: false, error: { code: 'RAG_UNAVAILABLE', message: '工作区会话或 RAG 语料已切换，已丢弃旧向量生成结果；请重试。' } };
  }
  function publicRagLocalModelStatus(): RagLocalModelStatus {
    const status = deps.internalRagEmbedding.getLocalModelStatus();
    const diagnostic = status.diagnostic === undefined
      ? undefined
      : maskPathFragments(status.diagnostic);
    return {
      state: status.state,
      modelId: status.modelId,
      revision: status.revision,
      dimension: status.dimension,
      ...(status.source ? { source: status.source } : {}),
      ...(status.diagnosticCode ? { diagnosticCode: status.diagnosticCode } : {}),
      ...(diagnostic ? { diagnostic } : {})
    };
  }

  const loadWorkspaceVectorMap = async (
      corpus: RagCorpus,
      database: WorkspaceBoundUtilityStore | null
    ): Promise<Map<string, Float32Array> | null> => {
      const cached = deps.internalRagEmbedding.getCachedVectors(corpus);
      if (cached && cached.size > 0) return cached;
      if (!database) return null;
      try {
        const model = await database.ragEmbeddingModel();
        if (model !== INTERNAL_RAG_EMBEDDING.id) return null;
        const records = await database.loadRagEmbeddingRecords();
        if (records.length === 0) return null;
        const currentContentHashes = new Map(corpus.chunks.map((chunk) => [chunk.chunkId, chunk.contentHash] as const));
        const vectorMap = new Map<string, Float32Array>();
        for (const record of records) {
          if (record.model === INTERNAL_RAG_EMBEDDING.id
            && record.contentHash !== null
            && currentContentHashes.get(record.chunkId) === record.contentHash
            && record.vector?.length === INTERNAL_RAG_EMBEDDING.dim) {
            vectorMap.set(record.chunkId, record.vector);
          }
        }
        return vectorMap.size > 0 ? vectorMap : null;
      } catch {
        return null;
      }
    };

  const searchWorkspaceEvidence = async (
      database: WorkspaceBoundUtilityStore | null,
      query: string,
      options: {
        limit?: number;
        families?: readonly RagChunkFamily[];
        expandReferences?: boolean;
        signal?: AbortSignal;
      }
    ): Promise<RagRetrieveResult> => {
      const initialIndex = deps.getActiveIndex();
      const initialSession = deps.getActiveSession();
      const initialSessionId = deps.getActiveWorkspaceSessionId();
      const initialGeneration = deps.getActiveWorkspaceSessionGeneration();
      const initialContext = deps.currentToolContext();
      const initialRagEpoch = initialContext.ragEpoch;
      const initialRagScope = initialContext.ragScope;
      const initialRagSessionId = initialContext.ragSessionId;
      const initialRagGeneration = initialContext.ragGeneration;
      const initialRagIndexedFilesRevision = initialContext.ragIndexedFilesRevision;
      const initialRag = resolveRagCorpus(initialContext);
      if (!initialIndex) {
        return { ok: false as const, code: 'WORKSPACE_REQUIRED' as const, message: '先打开 Mod 工作区。' };
      }
      const activeRag = initialRag;
      const expectedSearchIdentity = {
        activeIndex: initialIndex,
        activeSession: initialSession,
        workspaceSessionId: initialSessionId,
        workspaceSessionGeneration: initialGeneration,
        ragEpoch: initialRagEpoch,
        ragScope: initialRagScope,
        ragSessionId: initialRagSessionId,
        ragGeneration: initialRagGeneration,
        ragIndexedFilesRevision: initialRagIndexedFilesRevision
      };
      const workspaceStillCurrent = (): boolean => {
        const currentContext = deps.currentToolContext();
        const currentIndex = deps.getActiveIndex();
        return isAgentRagSearchIdentityCurrent(expectedSearchIdentity, {
          activeIndex: currentIndex,
          activeSession: deps.getActiveSession(),
          workspaceSessionId: deps.getActiveWorkspaceSessionId(),
          workspaceSessionGeneration: deps.getActiveWorkspaceSessionGeneration(),
          ragEpoch: currentContext.ragEpoch,
          ragScope: currentContext.ragScope,
          ragSessionId: currentContext.ragSessionId,
          ragGeneration: currentContext.ragGeneration,
          ragIndexedFilesRevision: currentContext.ragIndexedFilesRevision
        });
      };
      const staleSearchResult = (): RagRetrieveResult => ({
        ok: false,
        code: 'RAG_UNAVAILABLE',
        message: '工作区会话或 RAG 语料已切换，已丢弃旧检索结果；请重试。'
      });
      if (!activeRag && !database) {
        return {
          ok: false,
          code: 'RAG_UNAVAILABLE',
          message: '内存 RAG 语料尚未就绪；查询不会启动数据库 recovery。'
        };
      }
      const persistedChunks = database ? await database.loadRagChunks() : [];
      const persistedReferences = database ? await database.loadReferences() : [];
      // A freshly published in-memory semantic index is the current authority;
      // persisted chunks only fill verified source/revision gaps. Intermediate
      // views stay deferred so each fallback query does not build two full RAG
      // indexes on the Electron main-process heap.
      const corpus = await prepareAgentRagSearchCorpus({
        workspaceId: initialIndex.workspaceId,
        builtAt: activeRag?.builtAt ?? new Date().toISOString(),
        activeRag,
        persistedChunks,
        persistedReferences,
        ...(options.signal ? { signal: options.signal } : {})
      });

      // Database loading and local-vector checks may await long enough for a
      // remount or semantic publication.  Recheck before any retrieval branch,
      // including lexical-only fallback; otherwise the old corpus can escape
      // through the fast path while hybrid happens to be protected below.
      if (!workspaceStillCurrent()) return staleSearchResult();

      const staleChunkMask = getRagStaleChunkMaskCached(initialIndex, corpus);
      const lexicalOptions = {
        ...(options.limit != null && options.limit > 0 ? { limit: Math.trunc(options.limit) } : {}),
        ...(options.expandReferences === undefined ? {} : { expandReferences: options.expandReferences === true }),
        ...(options.families && options.families.length > 0 ? { families: options.families } : {}),
        ...(staleChunkMask ? { excludeChunkIds: staleChunkMask.ids } : {})
      };

      // Embeddings are an optional local accelerator. Never make lexical RAG
      // depend on a model or on a vector cache left by a different revision.
      const vectorMap = await loadWorkspaceVectorMap(corpus, database);
      if (!vectorMap || vectorMap.size === 0 || deps.internalRagEmbedding.getLocalModelStatus().state !== 'local-ready') {
        if (!workspaceStillCurrent()) return staleSearchResult();
        return retrieveEvidence(corpus, query, lexicalOptions);
      }

      const queryVector = await deps.internalRagEmbedding.embedQuery(query, options.signal);
      if (!queryVector) {
        if (!workspaceStillCurrent()) return staleSearchResult();
        return retrieveEvidence(corpus, query, lexicalOptions);
      }

      // All inputs above may await database/vector/embedding work.  A remount,
      // scan replacement, or semantic RAG publication during that window must
      // not let an old workspace snapshot reach the Agent evidence preflight.
      const currentIndex = deps.getActiveIndex();
      if (!workspaceStillCurrent() || !currentIndex) return staleSearchResult();

      const currentStaleChunkMask = getRagStaleChunkMaskCached(currentIndex, corpus);
      return retrieveEvidenceHybrid(corpus, query, {
        ...(options.limit != null && options.limit > 0 ? { limit: Math.trunc(options.limit) } : {}),
        ...(options.expandReferences === undefined ? {} : { expandReferences: options.expandReferences === true }),
        ...(options.families && options.families.length > 0 ? { families: options.families } : {}),
        ...(currentStaleChunkMask ? { excludeChunkMask: currentStaleChunkMask } : {}),
        vectors: {
          vectors: vectorMap,
          queryVector
        }
      });
    };

        const hasRagSearchCorpus = async (): Promise<boolean> => {
          if (!deps.getActiveIndex() || !deps.getActiveSession()) return false;
          const liveStats = deps.getActiveIndex()!.getStats();
          if (liveStats.events > 0 || liveStats.mapEntities > 0 || liveStats.paramRows > 0 || liveStats.textEntries > 0) {
            return true;
          }
          const activeRag = resolveRagCorpus(deps.currentToolContext());
          if (activeRag) {
            return activeRag.availability === 'available' && activeRag.chunks.length > 0;
          }
          try {
            // 只做轻量只读检查，不执行耗时的 recovery cleanup 全盘扫描
            const chunks = await Promise.race([
              deps.operationLogUtility.forWorkspace(deps.getActiveIndex()!.workspaceId).loadRagChunks(),
              new Promise<unknown[]>((resolve) => setTimeout(() => resolve([]), 100))
            ]);
            return chunks.length > 0;
          } catch {
            return false;
          }
        };


  async function embed(): Promise<{ok: true; embedded: number; reused: number; failed: number; model: string; dim: number} | {ok: false; error: {code: string; message: string}}> {
        if (!deps.getActiveIndex()) {
          return {
            ok: false,
            error: { code: 'WORKSPACE_REQUIRED', message: '先打开 Mod 工作区并完成分析，再生成向量索引。' }
          };
        }
        if (!deps.getActiveSession()) {
          return {
            ok: false,
            error: { code: 'WORKSPACE_REQUIRED', message: '工作区会话未就绪。' }
          };
        }
        const owner = currentEvidenceIdentity();
        const session = deps.getActiveSession()!;
        const index = deps.getActiveIndex()!;
        const database = await deps.ensureActiveOperationLog(session);
        if (!embeddingOwnerCurrent(owner)) return staleEmbeddingResult();
        const scopedDatabase = database.forWorkspace(index.workspaceId);
        let corpus = resolveRagCorpus(deps.currentToolContext());
        if (!corpus) {
          const chunks = await scopedDatabase.loadRagChunks();
          if (!embeddingOwnerCurrent(owner)) return staleEmbeddingResult();
          const references = await scopedDatabase.loadReferences();
          if (!embeddingOwnerCurrent(owner)) return staleEmbeddingResult();
          corpus = createRagCorpus({ workspaceId: index.workspaceId, builtAt: new Date().toISOString(), chunks, references, lookupIndex: 'deferred' });
        }
        if (corpus.availability !== 'available') {
          return {
            ok: false,
            error: {
              code: 'RAG_UNAVAILABLE',
              message: corpus.diagnostics.find((diagnostic) => diagnostic.code === 'RAG_SEMANTIC_CORPUS_EMPTY')?.message
                ?? 'RAG 语义语料不可用，请先完成工作区原生分析。'
            }
          };
        }
        if (corpus.chunks.length === 0) {
          return { ok: false, error: { code: 'INSUFFICIENT_CORPUS', message: '语料为空：先扫描并分析工作区。' } };
        }

        const result = await deps.internalRagEmbedding.ensure(corpus, scopedDatabase);
        if (!embeddingOwnerCurrent(owner)) return staleEmbeddingResult();
        if (!result.ok) return { ok: false, error: { code: result.code, message: result.message } };
        return { ok: true, embedded: result.embedded, reused: result.reused, failed: result.failed, model: result.model, dim: result.dim };

  }

  async function localModelStatus(): Promise<RagLocalModelStatus> {
      // Read-only refresh: it never downloads or starts an embedding worker.
      deps.internalRagEmbedding.refreshLocalModelStatus();
      return publicRagLocalModelStatus();

  }

  async function searchEvidence(input: {query: string; limit?: number; families?: readonly RagChunkFamily[]; expandReferences?: boolean}): Promise<RagRetrieveResult> {
        if (typeof input?.query !== 'string' || input.query.trim() === '') {
          return { ok: false, code: 'INVALID_INPUT', message: 'rag.searchEvidence 需要非空 query。' };
        }
        if (!deps.getActiveIndex() || !deps.getActiveSession()) {
          return { ok: false as const, code: 'WORKSPACE_REQUIRED' as const, message: '先打开 Mod 工作区。' };
        }
        const databaseClient = resolveRagCorpus(deps.currentToolContext())
          ? deps.operationLogUtility
          : await deps.ensureActiveOperationLog(deps.getActiveSession()!);
        const database = databaseClient.forWorkspace(deps.getActiveIndex()!.workspaceId);
        return searchWorkspaceEvidence(database, input.query, {
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.families !== undefined ? { families: input.families } : {}),
          ...(input.expandReferences !== undefined ? { expandReferences: input.expandReferences } : {})
        });

  }

  return Object.freeze({ embed, localModelStatus, searchEvidence, searchWorkspaceEvidence, hasRagSearchCorpus });
}
export type AgentEvidenceService = ReturnType<typeof createAgentEvidenceService>;
