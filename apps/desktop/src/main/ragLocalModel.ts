import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  RagLocalModelSource,
  RagLocalModelState,
  RagLocalModelStatus
} from '@soulforge/shared';

/** The only embedding model accepted by the production RAG worker. */
export const SOULFORGE_RAG_MODEL = {
  id: 'Xenova/bge-small-zh-v1.5',
  revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
  dimension: 512,
  modelFile: 'onnx/model_quantized.onnx',
  files: [
    { path: 'config.json', size: 716, sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f' },
    { path: 'tokenizer.json', size: 439125, sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26' },
    { path: 'tokenizer_config.json', size: 367, sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a' },
    { path: 'special_tokens_map.json', size: 125, sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3' },
    { path: 'vocab.txt', size: 109540, sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c' },
    { path: 'onnx/model_quantized.onnx', size: 24010842, sha256: 'b7a243d1720eaeee61b127c5b69ecfbbbfda78479b629694ea25062884c45989' }
  ]
} as const;

export const SOULFORGE_RAG_MODEL_ID =
  `${SOULFORGE_RAG_MODEL.id}@${SOULFORGE_RAG_MODEL.revision}`;

export interface RagLocalModelResolution extends RagLocalModelStatus {
  modelPath?: string;
  diagnostic?: string;
}

interface Candidate {
  path: string;
  source: RagLocalModelSource;
  /** An arbitrary explicit path needs an adjacent identity manifest. */
  requiresManifest?: boolean;
}

interface ModelIdentityManifest {
  modelId?: unknown;
  model?: unknown;
  revision?: unknown;
  dimension?: unknown;
}

const digestCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

export function resolveRagLocalModel(input: {
  cacheDir: string;
  userDataDir: string;
  /** Test/validation override; production omits it and uses standard caches. */
  standardCacheRoots?: readonly string[];
}): RagLocalModelResolution {
  const explicit = process.env.SOULFORGE_RAG_MODEL_PATH?.trim();
  if (explicit) {
    return inspectCandidate({
      path: resolve(explicit),
      source: 'explicit',
      requiresManifest: true
    });
  }

  const managedRoot = join(input.userDataDir, 'rag', 'models');
  const embeddingRoot = input.cacheDir;
  const candidates: Candidate[] = [
    { path: join(managedRoot, 'Xenova', 'bge-small-zh-v1.5', SOULFORGE_RAG_MODEL.revision), source: 'managed' },
    { path: join(managedRoot, 'Xenova', 'bge-small-zh-v1.5'), source: 'managed' },
    { path: join(managedRoot, SOULFORGE_RAG_MODEL_ID), source: 'managed' },
    { path: join(embeddingRoot, 'Xenova', 'bge-small-zh-v1.5', SOULFORGE_RAG_MODEL.revision), source: 'embedding-cache' },
    { path: join(embeddingRoot, 'Xenova', 'bge-small-zh-v1.5'), source: 'embedding-cache' },
    { path: join(embeddingRoot, SOULFORGE_RAG_MODEL_ID), source: 'embedding-cache' }
  ];
  for (const root of input.standardCacheRoots ?? standardHuggingFaceCacheRoots()) {
    candidates.push({
      path: join(root, 'models--Xenova--bge-small-zh-v1.5', 'snapshots', SOULFORGE_RAG_MODEL.revision),
      source: 'huggingface-cache'
    });
  }

  let sawExistingCandidate = false;
  let lastFailure: RagLocalModelResolution | null = null;
  for (const candidate of candidates) {
    if (!isDirectory(candidate.path)) continue;
    sawExistingCandidate = true;
    const inspected = inspectCandidate(candidate);
    if (inspected.state === 'local-ready') return inspected;
    lastFailure = inspected;
  }
  if (lastFailure && sawExistingCandidate) return lastFailure;
  return unavailable('RAG_LOCAL_MODEL_UNAVAILABLE', '未发现已安装且身份可验证的本地 RAG 模型。');
}

function inspectCandidate(candidate: Candidate): RagLocalModelResolution {
  const base = {
    modelId: SOULFORGE_RAG_MODEL.id,
    revision: SOULFORGE_RAG_MODEL.revision,
    dimension: SOULFORGE_RAG_MODEL.dimension,
    source: candidate.source
  } satisfies Omit<RagLocalModelStatus, 'state'>;
  if (!isDirectory(candidate.path)) {
    return { ...base, state: 'local-files-missing', diagnosticCode: 'RAG_LOCAL_MODEL_PATH_MISSING', diagnostic: '模型目录不存在。' };
  }

  const manifest = readIdentityManifest(candidate.path);
  if (candidate.requiresManifest && !manifest) {
    return {
      ...base,
      state: 'model-id-mismatch',
      diagnosticCode: 'RAG_MODEL_MANIFEST_REQUIRED',
      diagnostic: '显式模型目录必须包含 SoulForge RAG 身份清单。'
    };
  }
  if (manifest) {
    const modelId = stringValue(manifest.modelId ?? manifest.model);
    if (modelId !== SOULFORGE_RAG_MODEL.id) {
      return { ...base, state: 'model-id-mismatch', diagnosticCode: 'RAG_MODEL_ID_MISMATCH', diagnostic: '本地模型 ID 与 SoulForge 固定模型不匹配。' };
    }
    if (stringValue(manifest.revision) !== SOULFORGE_RAG_MODEL.revision) {
      return { ...base, state: 'revision-mismatch', diagnosticCode: 'RAG_MODEL_REVISION_MISMATCH', diagnostic: '本地模型 revision 与 SoulForge 固定 revision 不匹配。' };
    }
    if (manifest.dimension !== undefined && manifest.dimension !== SOULFORGE_RAG_MODEL.dimension) {
      return { ...base, state: 'local-files-missing', diagnosticCode: 'RAG_MODEL_DIMENSION_MISMATCH', diagnostic: '本地模型维度与固定 embedding 维度不匹配。' };
    }
  }

  const revisionFromPath = pathRevision(candidate.path);
  if (candidate.source !== 'explicit' && revisionFromPath !== SOULFORGE_RAG_MODEL.revision) {
    return { ...base, state: 'revision-mismatch', diagnosticCode: 'RAG_MODEL_REVISION_MISMATCH', diagnostic: '模型目录 revision 不匹配。' };
  }

  const missingOrInvalid = SOULFORGE_RAG_MODEL.files.find((file) => {
    const path = join(candidate.path, file.path);
    if (!existsSync(path)) return true;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size !== file.size) return true;
      return sha256File(path, stat.size, stat.mtimeMs) !== file.sha256;
    } catch {
      return true;
    }
  });
  if (missingOrInvalid) {
    return {
      ...base,
      state: 'local-files-missing',
      diagnosticCode: 'RAG_LOCAL_MODEL_FILES_INVALID',
      diagnostic: `本地模型缺少或校验失败：${missingOrInvalid.path}`
    };
  }

  try {
    const config = JSON.parse(readFileSync(join(candidate.path, 'config.json'), 'utf8')) as { hidden_size?: unknown; model_type?: unknown };
    if (config.model_type !== 'bert' || config.hidden_size !== SOULFORGE_RAG_MODEL.dimension) {
      return { ...base, state: 'local-files-missing', diagnosticCode: 'RAG_MODEL_CONFIG_INVALID', diagnostic: '模型 config 的架构或维度不匹配。' };
    }
  } catch {
    return { ...base, state: 'local-files-missing', diagnosticCode: 'RAG_MODEL_CONFIG_INVALID', diagnostic: '模型 config.json 不是有效 JSON。' };
  }
  return { ...base, state: 'local-ready', modelPath: resolve(candidate.path) };
}

function standardHuggingFaceCacheRoots(): string[] {
  const roots = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value?.trim()) return;
    roots.add(resolve(value));
  };
  const hfHome = process.env.HF_HOME?.trim();
  add(process.env.HUGGINGFACE_HUB_CACHE);
  if (hfHome) add(join(hfHome, 'hub'));
  add(join(homedir(), '.cache', 'huggingface', 'hub'));
  add(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'huggingface', 'hub'));
  add(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), '.cache', 'huggingface', 'hub'));
  return [...roots];
}

function readIdentityManifest(directory: string): ModelIdentityManifest | null {
  for (const name of ['soulforge-rag-model.json', 'soulforge-model.json']) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as ModelIdentityManifest
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function pathRevision(directory: string): string | null {
  const parts = resolve(directory).split(/[\\/]/u).filter(Boolean);
  const snapshot = parts.lastIndexOf('snapshots');
  if (snapshot >= 0 && parts[snapshot + 1]) return parts[snapshot + 1] ?? null;
  const last = parts.at(-1);
  return last && /^[a-f0-9]{40}$/iu.test(last) ? last : null;
}

function sha256File(path: string, size: number, mtimeMs: number): string {
  const cached = digestCache.get(path);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.sha256;
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  digestCache.set(path, { size, mtimeMs, sha256: digest });
  return digest;
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function unavailable(code: string, diagnostic: string): RagLocalModelResolution {
  return {
    state: 'unavailable' satisfies RagLocalModelState,
    modelId: SOULFORGE_RAG_MODEL.id,
    revision: SOULFORGE_RAG_MODEL.revision,
    dimension: SOULFORGE_RAG_MODEL.dimension,
    diagnosticCode: code,
    diagnostic
  };
}
