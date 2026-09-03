import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RagChunk, RagCorpus } from '@soulforge/shared';
import type { OperationLogUtilityClient } from './operationLogUtilityClient.js';

export const INTERNAL_RAG_EMBEDDING = {
  id: 'soulforge-local-bge-small-zh-v1.5@75c43b069aac4d136ba6bc1122f995fedcfd2781',
  model: 'Xenova/bge-small-zh-v1.5',
  revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
  dim: 512,
  normalization: 'l2',
  chunkerRevision: 'rag-chunk-v2'
} as const;

const EMBED_BATCH_SIZE = 16;
const PERSIST_BATCH_SIZE = 128;
const EMBEDDING_RETRY_COOLDOWN_MS = 10 * 60_000;
/** 自动 embedding 是增益，不得因为大型工作区反过来拖垮主机。 */
export const INTERNAL_RAG_MAX_EMBEDDABLE_CHUNKS = 20_000;
export const INTERNAL_RAG_EMBEDDABLE_FAMILIES: readonly RagChunk['family'][] = [
  'event',
  'map_entity',
  'param_row',
  'text_entry'
];

export interface RagEmbeddingRecord {
  chunkId: string;
  model: string;
  contentHash: string | null;
  vector: Float32Array;
}

interface EmbeddingStore {
  loadRagEmbeddingRecords(): Promise<RagEmbeddingRecord[]>;
  mergeRagEmbeddings(input: {
    model: string;
    entries: Array<{ chunkId: string; contentHash: string; vector: Float32Array }>;
    deletedChunkIds: string[];
  }): Promise<void>;
}

interface WorkerRequest {
  id: number;
  texts: string[];
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  dim?: number;
  vectors?: ArrayBuffer[];
  error?: string;
}

interface PendingRequest {
  resolve: (value: WorkerResponse) => void;
  reject: (error: Error) => void;
}

export type InternalEmbeddingResult =
  | { ok: true; embedded: number; reused: number; failed: number; model: string; dim: number; fingerprint: string }
  | { ok: false; code: string; message: string; fingerprint: string };

function workerFilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'ragEmbeddingWorker.js');
}

export function internalRagCorpusFingerprint(corpus: RagCorpus): string {
  const hash = createHash('sha256');
  // 非向量家族由词法/结构化索引覆盖；它们变化时不应触发整套 embedding
  // 缓存失效或重新探测。
  for (const chunk of [...internalRagEmbeddableChunks(corpus)].sort((left, right) => left.chunkId.localeCompare(right.chunkId))) {
    hash.update(`${chunk.chunkId}\u0000${chunk.contentHash}\u0000${chunk.sourceHash ?? ''}\u0000${chunk.sourceRevision ?? ''}\n`);
  }
  return hash.digest('hex');
}

/**
 * 语义向量只覆盖 Agent 最常用且可稳定回溯的四类对象；文件、区域和
 * TAE 事件仍然始终走词法/结构化路径，不因为没有向量而从检索中消失。
 */
export function internalRagEmbeddableChunks(corpus: RagCorpus): RagChunk[] {
  const families = new Set(INTERNAL_RAG_EMBEDDABLE_FAMILIES);
  return corpus.chunks.filter((chunk) => families.has(chunk.family));
}

function chunkText(chunk: RagChunk): string {
  return `${chunk.title}\n${chunk.body}`;
}

export class InternalRagEmbeddingService {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private activeAbort: AbortController | null = null;
  private activeJob: Promise<InternalEmbeddingResult> | null = null;
  private activeFingerprint: string | null = null;
  private scheduled: { corpus: RagCorpus; store: EmbeddingStore; fingerprint: string } | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private unavailableUntil = 0;
  private completed: { workspaceId: string; fingerprint: string; vectors: Map<string, Float32Array> } | null = null;

  constructor(private readonly cacheDir: string) {}

  schedule(corpus: RagCorpus, store: EmbeddingStore): void {
    if (corpus.availability !== 'available' || corpus.chunks.length === 0) return;
    if (Date.now() < this.unavailableUntil) return;
    const fingerprint = internalRagCorpusFingerprint(corpus);
    if (this.activeFingerprint === fingerprint && this.activeJob) return;
    if (this.scheduled?.fingerprint === fingerprint) return;
    this.scheduled = { corpus, store, fingerprint };
    this.activeAbort?.abort();
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    // 同一轮工作区分析可能连续提交多个 source delta；合并一个短窗口，
    // 防止每个 delta 都取消并重启一次全局 embedding。
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      this.startScheduledJob();
    }, 250);
  }

  async ensure(corpus: RagCorpus, store: EmbeddingStore, signal?: AbortSignal): Promise<InternalEmbeddingResult> {
    if (corpus.availability !== 'available' || corpus.chunks.length === 0) {
      return { ok: false, code: 'RAG_UNAVAILABLE', message: 'RAG 语义语料为空。', fingerprint: internalRagCorpusFingerprint(corpus) };
    }
    const fingerprint = internalRagCorpusFingerprint(corpus);
    if (this.activeFingerprint === fingerprint && this.activeJob) return this.activeJob;
    // 显式兼容入口代表用户/测试要求立即重试，覆盖自动后台失败冷却。
    this.unavailableUntil = 0;
    this.scheduled = null;
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.activeAbort?.abort();
    this.activeAbort = new AbortController();
    this.activeFingerprint = fingerprint;
    this.completed = null;
    const job = this.startCorpusJob(corpus, store, this.activeAbort.signal, fingerprint);
    this.activeJob = job;
    if (!signal) return job;
    if (signal.aborted) return { ok: false, code: 'RAG_EMBEDDING_CANCELLED', message: 'embedding 更新已取消。', fingerprint };
    return await Promise.race([
      job,
      new Promise<InternalEmbeddingResult>((resolve) => signal.addEventListener('abort', () => resolve({
        ok: false,
        code: 'RAG_EMBEDDING_CANCELLED',
        message: 'embedding 更新已取消。',
        fingerprint
      }), { once: true }))
    ]);
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<Float32Array | null> {
    if (!query.trim()) return null;
    if (Date.now() < this.unavailableUntil) return null;
    try {
      const result = await this.request([query], signal);
      if (!result.ok || !result.vectors?.[0] || result.dim !== INTERNAL_RAG_EMBEDDING.dim) {
        this.unavailableUntil = Date.now() + EMBEDDING_RETRY_COOLDOWN_MS;
        void this.resetWorker();
        return null;
      }
      return new Float32Array(result.vectors[0]);
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.message === 'RAG_EMBEDDING_CANCELLED')) throw error;
      this.unavailableUntil = Date.now() + EMBEDDING_RETRY_COOLDOWN_MS;
      void this.resetWorker();
      return null;
    }
  }

  async close(): Promise<void> {
    this.scheduled = null;
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.activeJob = null;
    this.unavailableUntil = 0;
    this.completed = null;
    for (const pending of this.pending.values()) pending.reject(new Error('RAG_EMBEDDING_CLOSED'));
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  private async embedCorpus(
    corpus: RagCorpus,
    store: EmbeddingStore,
    signal: AbortSignal,
    fingerprint: string
  ): Promise<InternalEmbeddingResult> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const targetChunks = internalRagEmbeddableChunks(corpus);
      if (targetChunks.length > INTERNAL_RAG_MAX_EMBEDDABLE_CHUNKS) {
        return {
          ok: false,
          code: 'RAG_EMBEDDING_SKIPPED_LARGE_CORPUS',
          message: `可向量化语料有 ${targetChunks.length} 条，超过自动上限 ${INTERNAL_RAG_MAX_EMBEDDABLE_CHUNKS}；已保留词法与结构化检索。`,
          fingerprint
        };
      }
      const records = await store.loadRagEmbeddingRecords();
      const desired = new Map(targetChunks.map((chunk) => [chunk.chunkId, chunk] as const));
      const reusable = new Map<string, RagEmbeddingRecord>();
      const completeVectors = new Map<string, Float32Array>();
      const staleIds = new Set<string>();
      for (const record of records) {
        const current = desired.get(record.chunkId);
        if (record.model === INTERNAL_RAG_EMBEDDING.id
          && record.contentHash !== null
          && current?.contentHash === record.contentHash
          && record.vector.length === INTERNAL_RAG_EMBEDDING.dim) {
          reusable.set(record.chunkId, record);
          completeVectors.set(record.chunkId, record.vector);
        } else {
          staleIds.add(record.chunkId);
        }
      }
      const missing = targetChunks.filter((chunk) => !reusable.has(chunk.chunkId));
      let embedded = 0;
      for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
        if (signal.aborted) throw new Error('RAG_EMBEDDING_CANCELLED');
        const batch = missing.slice(start, start + EMBED_BATCH_SIZE);
        const response = await this.request(batch.map(chunkText), signal);
        if (!response.ok || !response.vectors || response.vectors.length !== batch.length || response.dim !== INTERNAL_RAG_EMBEDDING.dim) {
          return {
            ok: false,
            code: 'RAG_EMBEDDING_UNAVAILABLE',
            message: response.error ?? 'SoulForge 内置 embedding 后端不可用，已保留词法检索。',
            fingerprint
          };
        }
        const entries = batch.map((chunk, index) => ({
          chunkId: chunk.chunkId,
          contentHash: chunk.contentHash,
          vector: new Float32Array(response.vectors![index]!)
        }));
        for (let entryStart = 0; entryStart < entries.length; entryStart += PERSIST_BATCH_SIZE) {
          if (signal.aborted) throw new Error('RAG_EMBEDDING_CANCELLED');
          await store.mergeRagEmbeddings({
            model: INTERNAL_RAG_EMBEDDING.id,
            entries: entries.slice(entryStart, entryStart + PERSIST_BATCH_SIZE),
            deletedChunkIds: entryStart === 0 ? [...staleIds] : []
          });
        }
        for (const entry of entries) completeVectors.set(entry.chunkId, entry.vector);
        embedded += entries.length;
        // 即使 ONNX 会话只有一个线程，也要把主进程事件循环和 Electron
        // 窗口的响应权让出来；大量 batch 不能形成连续的长宏任务。
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (missing.length === 0 && staleIds.size > 0) {
        await store.mergeRagEmbeddings({ model: INTERNAL_RAG_EMBEDDING.id, entries: [], deletedChunkIds: [...staleIds] });
      }
      this.completed = { workspaceId: corpus.workspaceId, fingerprint, vectors: completeVectors };
      return {
        ok: true,
        embedded,
        reused: reusable.size,
        failed: 0,
        model: INTERNAL_RAG_EMBEDDING.id,
        dim: INTERNAL_RAG_EMBEDDING.dim,
        fingerprint
      };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.message === 'RAG_EMBEDDING_CANCELLED')) {
        return { ok: false, code: 'RAG_EMBEDDING_CANCELLED', message: 'embedding 更新已取消，保留现有索引。', fingerprint };
      }
      return {
        ok: false,
        code: 'RAG_EMBEDDING_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
        fingerprint
      };
    }
  }

  getCachedVectors(corpus: RagCorpus): Map<string, Float32Array> | null {
    const fingerprint = internalRagCorpusFingerprint(corpus);
    if (this.completed?.workspaceId !== corpus.workspaceId || this.completed.fingerprint !== fingerprint) return null;
    return this.completed.vectors;
  }

  private startCorpusJob(
    corpus: RagCorpus,
    store: EmbeddingStore,
    signal: AbortSignal,
    fingerprint: string
  ): Promise<InternalEmbeddingResult> {
    const job = this.embedCorpus(corpus, store, signal, fingerprint);
    void job.then((result) => {
      if (!result.ok && result.code !== 'RAG_EMBEDDING_CANCELLED' && this.activeJob === job) {
        this.unavailableUntil = Date.now() + EMBEDDING_RETRY_COOLDOWN_MS;
        void this.resetWorker();
      }
    }).catch(() => {
      if (this.activeJob === job) {
        this.unavailableUntil = Date.now() + EMBEDDING_RETRY_COOLDOWN_MS;
        void this.resetWorker();
      }
    });
    void job.finally(() => {
      if (this.activeJob === job) {
        this.activeJob = null;
        this.activeFingerprint = null;
        this.activeAbort = null;
        this.startScheduledJob();
      }
    }).catch(() => undefined);
    return job;
  }

  private startScheduledJob(): void {
    const next = this.scheduled;
    if (!next || this.activeJob || Date.now() < this.unavailableUntil) return;
    this.scheduled = null;
    this.activeAbort = new AbortController();
    this.activeFingerprint = next.fingerprint;
    this.completed = null;
    this.activeJob = this.startCorpusJob(next.corpus, next.store, this.activeAbort.signal, next.fingerprint);
  }

  private async resetWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    // 终止 worker 时不能把其他正在等待的请求遗留在 pending map 中，
    // 否则取消/失败后的下一次索引会永久等待一个永远不会回来的响应。
    for (const pending of this.pending.values()) pending.reject(new Error('RAG_EMBEDDING_WORKER_RESET'));
    this.pending.clear();
    await worker.terminate();
  }

  private async request(texts: string[], signal?: AbortSignal): Promise<WorkerResponse> {
    if (signal?.aborted) throw new Error('RAG_EMBEDDING_CANCELLED');
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    const request: WorkerRequest = { id, texts };
    const response = new Promise<WorkerResponse>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        reject(new Error('RAG_EMBEDDING_CANCELLED'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        }
      });
    });
    worker.postMessage(request);
    return response;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const script = workerFilePath();
    if (!existsSync(script)) throw new Error('RAG_EMBEDDING_WORKER_UNAVAILABLE');
    const worker = new Worker(script, { workerData: { cacheDir: this.cacheDir } });
    worker.on('message', (message: WorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    worker.on('error', (error) => {
      this.worker = null;
      for (const pending of this.pending.values()) pending.reject(error instanceof Error ? error : new Error(String(error)));
      this.pending.clear();
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (code !== 0) {
        for (const pending of this.pending.values()) pending.reject(new Error(`RAG_EMBEDDING_WORKER_EXIT_${code}`));
        this.pending.clear();
      }
    });
    this.worker = worker;
    return worker;
  }
}
