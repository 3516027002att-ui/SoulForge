/**
 * OpenAI-compatible embedding client (POST /v1/embeddings).
 *
 * Only openai-compatible services support embeddings — Anthropic has no
 * embedding endpoint, so the anthropic-compatible protocol is out of scope.
 * Credentials never appear in diagnostics or returned payloads.
 */

import {
  classifyFetchError,
  classifyHttpError,
  classifyParseError,
  createRequestSignal
} from './errorClassification.js';

export interface FetchEmbeddingsOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Texts to embed; empty array returns ok with an empty vector list. */
  inputs: readonly string[];
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Max texts per POST. OpenAI caps at 2048; 64 keeps one batch small enough
   * for local models while bounding request count for large corpora.
   */
  batchSize?: number;
}

export type EmbeddingBatchResult =
  | { ok: true; vectors: Float32Array[]; dim: number }
  | { ok: false; error: { code: string; message: string } };

const DEFAULT_BATCH_SIZE = 64;

/**
 * Embed a list of texts, batching by `batchSize`. Vectors are ordered to match
 * `inputs` even when the server returns `data` out of order (matched by `index`).
 */
export async function fetchEmbeddings(options: FetchEmbeddingsOptions): Promise<EmbeddingBatchResult> {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const batchSize = Math.max(1, Math.min(256, Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE)));
  const vectors: Float32Array[] = [];

  for (let start = 0; start < options.inputs.length; start += batchSize) {
    const batch = options.inputs.slice(start, start + batchSize);
    const result = await embedBatch(fetchImpl, baseUrl, options, batch);
    if (!result.ok) return result;
    vectors.push(...result.vectors);
  }
  return { ok: true, vectors, dim: vectors[0]?.length ?? 0 };
}

async function embedBatch(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: FetchEmbeddingsOptions,
  inputs: readonly string[]
): Promise<Extract<EmbeddingBatchResult, { ok: true }> | Extract<EmbeddingBatchResult, { ok: false }>> {
  if (inputs.length === 0) return { ok: true, vectors: [], dim: 0 };
  const { signal, cleanup } = createRequestSignal(options.signal, options.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({ model: options.model, input: [...inputs] }),
      ...(signal ? { signal } : {})
    });
  } catch (error) {
    cleanup();
    return embedError(classifyFetchError(error, 'OpenAI-compatible embedding', signal, { callerSignal: options.signal }));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    cleanup();
    return embedError(classifyHttpError(
      response.status, text, 'OpenAI-compatible embedding',
      response.headers.get('retry-after')
    ));
  }
  let json: {
    data?: Array<{ embedding?: unknown; index?: unknown }>;
    model?: unknown;
  };
  try {
    json = await response.json() as typeof json;
  } catch (error) {
    cleanup();
    return embedError(classifyParseError(error, 'OpenAI-compatible embedding'));
  }
  cleanup();

  const parsed = parseEmbeddingData(json.data ?? [], inputs.length);
  if (!parsed.ok) return parsed;
  return { ok: true, vectors: parsed.vectors, dim: parsed.dim };
}

function parseEmbeddingData(
  data: Array<{ embedding?: unknown; index?: unknown }>,
  expectedCount: number
): Extract<EmbeddingBatchResult, { ok: true }> | Extract<EmbeddingBatchResult, { ok: false }> {
  const indexed = new Map<number, Float32Array>();
  let fallbackIndex = 0;
  let dim = 0;
  for (const entry of data) {
    const vector = toFloat32Array(entry.embedding);
    if (!vector) continue;
    dim = dim || vector.length;
    if (vector.length !== dim) continue;
    const index = typeof entry.index === 'number' && Number.isInteger(entry.index) && entry.index >= 0
      ? entry.index
      : fallbackIndex;
    indexed.set(index, vector);
    fallbackIndex += 1;
  }
  if (indexed.size !== expectedCount) {
    return embedError({
      severity: 'error',
      code: 'MODEL_SERVICE_RESPONSE_PARSE_FAILED',
      message: `OpenAI-compatible embedding 返回 ${indexed.size}/${expectedCount} 条向量。`
    });
  }
  const vectors: Float32Array[] = [];
  for (let i = 0; i < expectedCount; i += 1) {
    const vector = indexed.get(i);
    if (!vector) {
      return embedError({
        severity: 'error',
        code: 'MODEL_SERVICE_RESPONSE_PARSE_FAILED',
        message: `OpenAI-compatible embedding 缺少 index=${i} 的向量。`
      });
    }
    vectors.push(vector);
  }
  return { ok: true, vectors, dim };
}

function toFloat32Array(value: unknown): Float32Array | null {
  if (!Array.isArray(value)) return null;
  const array = new Float32Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    array[i] = item;
  }
  return array;
}

function embedError(diagnostic: { severity: string; code: string; message: string }): Extract<EmbeddingBatchResult, { ok: false }> {
  return { ok: false, error: { code: diagnostic.code, message: diagnostic.message } };
}

/** 余弦相似度（a、b 必须等长；任意一方为零向量返回 0）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
