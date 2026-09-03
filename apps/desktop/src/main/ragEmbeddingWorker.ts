/**
 * SoulForge 内置 RAG embedding worker。
 *
 * 这里是唯一加载模型和执行 ONNX 推理的地方：主进程不阻塞，worker 只开
 * 一个顺序会话，且把 ONNX 线程数固定为 1。模型缓存位于 userData，不写入
 * 工作区或 Mod 资源目录。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
const MODEL_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781';

interface WorkerInput {
  cacheDir: string;
}

interface EmbedRequest {
  id: number;
  texts: string[];
}

interface EmbedResponse {
  id: number;
  ok: boolean;
  dim?: number;
  vectors?: ArrayBuffer[];
  error?: string;
}

type FeatureExtractor = (texts: string | string[], options?: { pooling?: 'mean'; normalize?: boolean }) => Promise<{
  dims: number[];
  data: Float32Array;
}>;

const input = workerData as WorkerInput;
env.cacheDir = input.cacheDir;
env.allowRemoteModels = true;
env.allowLocalModels = true;

const session = pipeline('feature-extraction', MODEL_ID, {
  revision: MODEL_REVISION,
  dtype: 'q8',
  device: 'cpu',
  session_options: {
    executionMode: 'sequential',
    intraOpNumThreads: 1,
    interOpNumThreads: 1
  }
}).then((value) => value as unknown as FeatureExtractor);

async function embed(request: EmbedRequest): Promise<EmbedResponse> {
  try {
    if (!Array.isArray(request.texts) || request.texts.length === 0) {
      return { id: request.id, ok: true, dim: 0, vectors: [] };
    }
    const extractor = await session;
    const output = await extractor(request.texts, { pooling: 'mean', normalize: true });
    const dim = output.dims[output.dims.length - 1] ?? 0;
    if (!Number.isInteger(dim) || dim <= 0 || output.data.length !== dim * request.texts.length) {
      throw new Error('RAG_EMBEDDING_OUTPUT_INVALID');
    }
    const vectors: ArrayBuffer[] = [];
    for (let index = 0; index < request.texts.length; index += 1) {
      const vector = output.data.slice(index * dim, (index + 1) * dim);
      vectors.push(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
    }
    return { id: request.id, ok: true, dim, vectors };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

let queue = Promise.resolve();
parentPort?.on('message', (request: EmbedRequest) => {
  queue = queue.then(async () => {
    const response = await embed(request);
    parentPort?.postMessage(response, response.vectors ?? []);
  }).catch((error) => {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies EmbedResponse);
  });
});
