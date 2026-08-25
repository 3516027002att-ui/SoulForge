/**
 * §五十七 / §五十八 / §六十七：Agent 写后知识刷新 E2E。
 *
 * 这条 smoke 不绕过 Agent facade：read_tae_events 和
 * mutate_tae_event_times 都从 createAgentToolBridge 进入 production
 * ToolRegistry，随后经过 C# Bridge、Patch Engine、authoritative reread、
 * WorkspaceIndex merge/revision 和 ToolContext.onIndexUpdated。
 *
 * fixture 是隔离的、合法的 synthetic TAE。它证明的是 production wiring，
 * 不提升真实 Sekiro 语料 authority；真实 embedding provider 只在显式提供
 * SOULFORGE_EMBEDDING_BASE_URL / SOULFORGE_EMBEDDING_API_KEY /
 * SOULFORGE_EMBEDDING_MODEL 时调用，绝不在测试内伪造 provider。
 *
 * 没有真实 provider 时，A→B、reread、index、reference/RAG 持久化和旧向量
 * 失效仍必须通过，最后以 ok=false/status=BLOCKED/knowledgeFresh=false
 * 退出非零，避免把「只失效、未重建」误报成完成。
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RagChunk, RagCorpus } from '@soulforge/shared';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import {
  createDefaultToolRegistry,
  type KnowledgeRefreshNotice,
  type KnowledgeRefreshResult,
  type ToolContext
} from '../ai/toolRegistry.js';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { buildRagCorpus, createRagCorpus } from '../rag/chunkBuilder.js';
import { persistRagCorpus } from '../rag/persist.js';
import { fetchEmbeddings } from '../model-services/embeddingClient.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const SYNTHETIC = {
  fileSize: 0x240,
  declaredSizeAbs: 0x0c,
  anim0EntryAbs: 0xa8,
  anim0EventTableAbs: 0x128,
  anim0Event0StartTimeAbs: 0xd8,
  anim0Event0EndTimeAbs: 0xdc,
  templateParam: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
} as const;

type ToolResponse = {
  ok: boolean;
  content: string;
  code?: string;
  completionEvidence?: Array<{ kind: string; evidenceIds: string[] }>;
  postCommit?: KnowledgeRefreshResult;
};

type TaeEvent = {
  uri: string;
  address: string;
  animId: number;
  eventIndex: number;
  startFrame: number;
  endFrame: number;
  startTime: number;
  endTime: number;
};

type TaeReadData = {
  filePath: string;
  chrId: string;
  events: TaeEvent[];
};

type RefreshTrace = {
  chunkCount: number;
  referenceCount: number;
  coverageRevisionHash?: string;
  targetChunkRevision?: string;
};

type EmbeddingResult =
  | {
    status: 'rebuilt';
    model: string;
    dimension: number;
    count: number;
    sourceRevision: string;
  }
  | {
    status: 'BLOCKED';
    code: string;
    message: string;
  };

type SmokeResult = {
  ok: boolean;
  status: 'PASS' | 'BLOCKED';
  authority: 'fixture-confirmed' | 'partial';
  syntheticFixture: true;
  knowledgeFresh: boolean;
  target: {
    address: string;
    initial: { startFrame: number; endFrame: number };
    current: { startFrame: number; endFrame: number };
  };
  assertions: {
    agentExactReadA: boolean;
    agentMutationAtoB: boolean;
    authoritativeRereadB: boolean;
    indexCurrentB: boolean;
    referencesPersisted: boolean;
    ragCurrentB: boolean;
    oldAAbsent: boolean;
    oldRevisionAbsent: boolean;
    embeddingInvalidated: boolean;
    embeddingRebuilt: boolean;
  };
  revisions: {
    initialCoverageHash?: string;
    currentCoverageHash?: string;
    initialChunk?: string;
    currentChunk?: string;
  };
  refreshes: RefreshTrace[];
  embedding: EmbeddingResult;
  completionEvidence: string[];
  blocked?: {
    code: string;
    message: string;
    missing: string[];
  };
  nonClaims: string[];
};

let checks = 0;

function check(condition: unknown, message: string): asserts condition {
  checks += 1;
  if (!condition) throw new Error(`Agent/RAG postwrite smoke assertion failed: ${message}`);
}

function hashRevision(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

async function main(): Promise<void> {
  let result: SmokeResult | undefined;
  try {
    result = await withSmokeWorkspace('agent-rag-postwrite', runInWorkspace);
  } finally {
    await disposeBridgeDaemonPool();
  }

  console.log(JSON.stringify({ ...result, checks }, null, 2));
  if (result?.status === 'BLOCKED') process.exitCode = 1;
}

async function runInWorkspace(workspace: { root: string }): Promise<SmokeResult> {
  const overlayRoot = join(workspace.root, 'mod');
  const taePath = join(overlayRoot, 'chr', 'c0000', 'a00.tae');
  const stagingRoot = join(workspace.root, 'staging');
  const backupBaseDir = join(workspace.root, 'backups');
  const recoveryDir = join(workspace.root, 'recovery');
  await mkdir(join(overlayRoot, 'chr', 'c0000'), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(backupBaseDir, { recursive: true });
  await mkdir(recoveryDir, { recursive: true });
  await writeFile(taePath, buildSyntheticTae());

  const session = await openWorkspaceSession({
    overlayRoot,
    stagingRoot,
    game: 'sekiro'
  });
  const operationLog = new MemoryOperationLogStore();
  const database = openWorkspaceDatabase(join(workspace.root, 'workspace.db'));
  const now = new Date().toISOString();
  database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)`)
    .run(session.meta.workspaceId, overlayRoot, 'sekiro', now, now);
  const repository = new WorkspaceDataRepository(database, session.meta.workspaceId);
  const index = new WorkspaceIndex(session.meta.workspaceId);
  const refreshes: RefreshTrace[] = [];
  let activeRag: RagCorpus | null = null;
  let lastCommittedEmbedding: EmbeddingResult | undefined;

  const refreshAfterPostcommit = async (notice?: KnowledgeRefreshNotice): Promise<KnowledgeRefreshResult> => {
    if (!activeRag && index.getFiles().length === 0) {
      throw new Error('postcommit refresh called before the authoritative source entered WorkspaceIndex');
    }
    const next = buildRagCorpus(index);
    // Durable state is committed before the in-memory snapshot is switched.
    persistRagCorpus(repository, next);
    activeRag = next;
    const embedding: EmbeddingResult = notice?.reason === 'committed-mutation'
      ? await rebuildWithRealProvider(repository, next)
      : {
        status: 'BLOCKED',
        code: 'EMBEDDING_DEFERRED_UNTIL_COMMIT',
        message: 'read enrichment 只刷新 lexical chunks/references；embedding 由 committed mutation 触发。'
      };
    if (notice?.reason === 'committed-mutation') lastCommittedEmbedding = embedding;
    const targetChunk = next.chunks.find((chunk) => chunk.family === 'tae_event');
    refreshes.push({
      chunkCount: next.chunks.length,
      referenceCount: next.references.length,
      ...(next.coverage?.sourceRevision
        ? { coverageRevisionHash: hashRevision(next.coverage.sourceRevision) }
        : {}),
      ...(targetChunk?.sourceRevision ? { targetChunkRevision: targetChunk.sourceRevision } : {})
    });
    const knowledgeFresh = notice?.reason === 'committed-mutation'
      && embedding.status === 'rebuilt'
      && repository.loadRagEmbeddings().size === next.chunks.length
      && next.coverage?.sourceRevision !== undefined
      && repository.ragEmbeddingSourceRevision() === next.coverage.sourceRevision;
    const result: KnowledgeRefreshResult = {
      indexRefreshed: true,
      referencesRefreshed: true,
      ragRefreshed: true,
      knowledgeFresh,
      embeddingStatus: knowledgeFresh ? 'fresh' : 'blocked',
      ...(next.coverage?.sourceRevision ? { sourceRevision: next.coverage.sourceRevision } : {}),
      ...(embedding.status === 'rebuilt' ? { embeddingModel: embedding.model } : {}),
      ...(embedding.status === 'BLOCKED'
        ? { diagnostics: [{ code: embedding.code, message: embedding.message }] }
        : {})
    };
    return result;
  };

  const confirmation = createConfirmationReceipt({
    subjects: ['CLI_NATIVE_EDIT', 'ALL_RISKS', 'TITLE:Agent/RAG postwrite smoke'],
    riskLevel: 'high',
    sourceUri: 'fixture://agent-rag-postwrite/c0000/a00.tae',
    note: '隔离 synthetic fixture 的 Agent TAE 写回验证'
  });
  const context: ToolContext = {
    workspaceIndex: index,
    mode: 'fullPermission',
    session,
    operationLogStore: operationLog,
    backupBaseDir,
    recoveryDir,
    confirmation,
    onIndexUpdated: refreshAfterPostcommit
  };
  const bridge = createAgentToolBridge({
    registry: createDefaultToolRegistry(),
    context,
    externalTaskGoal: '读取并修改 c0000 的动作事件，然后确认 RAG 已看到新时间。'
  });

  try {
    // 1. Agent exact read：A。该调用会走 Bridge read + index merge + postcommit RAG persist。
    const initialReadResponse = await execute(bridge, 'read_tae_events', { file: taePath });
    const initialRead = parseData<TaeReadData>(initialReadResponse);
    const initialEvent = initialRead.events.find((event) => event.animId === 10 && event.eventIndex === 0);
    check(initialEvent, 'Agent exact read 必须找到 synthetic c0000#A0010.e0');
    const targetAddress = initialEvent.address;
    const initialA = {
      startFrame: initialEvent.startFrame,
      endFrame: initialEvent.endFrame
    };
    const currentB = { startFrame: 15, endFrame: 75 };

    const initialSearchResponse = await execute(bridge, 'search_tae_events', {
      query: targetAddress,
      limit: 8
    });
    const initialSearch = parseData<{ items?: Array<{ item?: { uri?: string; startFrame?: number; endFrame?: number } }> }>(initialSearchResponse);
    check(
      (initialSearch.items ?? []).some((hit) => hit.item?.uri === initialEvent.uri
        && hit.item.startFrame === initialA.startFrame
        && hit.item.endFrame === initialA.endFrame),
      'WorkspaceIndex exact action symbol 必须保留 A'
    );
    check(refreshes.length >= 1 && activeRag !== null, 'initial read 必须触发 durable RAG refresh');
    const initialCorpus = requireRag(activeRag, 'initial read');
    const initialCoverageRevision = initialCorpus.coverage?.sourceRevision;
    const initialTargetChunk = findTargetChunk(initialCorpus, targetAddress);
    check(initialTargetChunk, 'initial RAG 必须有目标 TAE chunk');
    const initialChunkRevision = initialTargetChunk.sourceRevision;
    check(initialChunkRevision, 'initial TAE chunk 必须带 source revision');

    // 这是数据库层的旧 embedding sentinel，不是 provider 输出；它只证明 FK
    // cascade/invalidation 真正发生。没有真实 provider 时绝不把 sentinel 当向量服务。
    repository.replaceRagEmbeddings(initialCorpus.chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      model: 'fixture-sentinel-not-a-provider',
      vector: new Float32Array([1, 0, 0]),
      sourceRevision: chunk.sourceRevision ?? initialChunkRevision
    })));
    check(repository.loadRagEmbeddings().size === initialCorpus.chunks.length, '旧 embedding sentinel 必须落库');
    check(repository.ragEmbeddingSourceRevision() === initialChunkRevision, '旧 embedding 必须绑定 A revision');

    // 2. Agent mutation：A → B。mutation handler 自己做 Patch Engine + reread +
    // WorkspaceIndex merge，然后调用上面与 desktop 同形状的 postcommit boundary。
    const mutationResponse = await execute(bridge, 'mutate_tae_event_times', {
      file: taePath,
      edits: [{ address: targetAddress, startFrame: currentB.startFrame, endFrame: currentB.endFrame }]
    });
    const mutation = parseData<{
      after?: TaeEvent[];
      postCommit?: KnowledgeRefreshResult;
    }>(mutationResponse);
    check(
      mutation.after?.some((event) => event.address === targetAddress
        && event.startFrame === currentB.startFrame
        && event.endFrame === currentB.endFrame),
      'Agent mutation 必须返回 A→B 的 authoritative after snapshot'
    );
    check(
      mutationResponse.completionEvidence?.some((evidence) => evidence.kind === 'index_refreshed') === true,
      '现有 Agent bridge 必须保留 index_refreshed evidence'
    );
    check(mutation.postCommit?.indexRefreshed === true, 'mutation result 必须显式报告 index refreshed');
    check(mutation.postCommit?.ragRefreshed === true, 'mutation result 必须显式报告 lexical RAG refreshed');
    check(
      mutationResponse.completionEvidence?.some((evidence) => evidence.kind === 'rag_refreshed')
        === (mutation.postCommit?.knowledgeFresh === true),
      '只有 embedding 与 current revision 一致时才允许发出 rag_refreshed evidence'
    );

    // 3. 第二次 Agent exact read：B；不是只读 mutation 返回值。
    const rereadResponse = await execute(bridge, 'read_tae_events', {
      file: taePath,
      addresses: [targetAddress]
    });
    const reread = parseData<TaeReadData>(rereadResponse);
    const rereadEvent = reread.events.find((event) => event.address === targetAddress);
    check(
      rereadEvent?.startFrame === currentB.startFrame && rereadEvent.endFrame === currentB.endFrame,
      '第二次 Agent exact read 必须得到 B'
    );
    check(refreshes.length >= 3, 'mutation 后必须再次经过 postcommit refresh（含 reread refresh）');
    check(activeRag, 'mutation 后 active in-memory RAG 必须已切换');

    const currentCorpus = requireRag(activeRag, 'mutation');
    const currentCoverageRevision = currentCorpus.coverage?.sourceRevision;
    const currentTargetChunk = findTargetChunk(currentCorpus, targetAddress);
    check(currentTargetChunk, 'current RAG 必须有目标 TAE chunk');
    const currentChunkRevision = currentTargetChunk.sourceRevision;
    check(currentChunkRevision, 'current TAE chunk 必须带 source revision');
    check(currentCoverageRevision !== initialCoverageRevision, 'source file revision 必须从 A 推进到 B');
    check(currentChunkRevision !== initialChunkRevision, '目标 chunk revision 必须从 A 推进到 B');

    const persistedChunks = repository.loadRagChunks();
    const persistedCurrentTarget = findTargetChunk(createRagCorpus({
      workspaceId: session.meta.workspaceId,
      builtAt: currentCorpus.builtAt,
      chunks: persistedChunks,
      references: repository.loadReferences()
    }), targetAddress);
    check(
      persistedCurrentTarget !== undefined
        && persistedCurrentTarget.body.includes(`startFrame ${currentB.startFrame}`)
        && persistedCurrentTarget.body.includes(`endFrame ${currentB.endFrame}`),
      'SQLite 持久化 chunk 必须看到 B'
    );
    check(
      persistedCurrentTarget?.sourceRevision === currentChunkRevision,
      'SQLite 持久化 chunk 必须绑定 current revision'
    );
    check(
      persistedChunks.every((chunk) => chunk.sourceUri !== initialTargetChunk.sourceUri
        || chunk.sourceRevision !== initialChunkRevision),
      '旧 A revision chunk 不得继续作为 current source projection'
    );

    // 4. 第二次 RAG query：query 只包含 B 的时间值，不依赖 mutation 返回值。
    const newQueryResponse = await execute(bridge, 'retrieve_evidence', {
      query: `startFrame ${currentB.startFrame} endFrame ${currentB.endFrame}`,
      families: ['tae_event'],
      limit: 8,
      expandReferences: false
    });
    const newQuery = parseData<{ hits?: Array<{ chunk?: RagChunk }> }>(newQueryResponse);
    check(
      newQuery.hits?.some((hit) => hit.chunk?.symbolUri === currentTargetChunk.symbolUri
        && hit.chunk.sourceRevision === currentChunkRevision
        && hit.chunk.body.includes(`endFrame ${currentB.endFrame}`)),
      '立即第二次 RAG query 必须看到 B/current revision'
    );

    const oldQueryResponse = await execute(bridge, 'retrieve_evidence', {
      query: `startFrame ${initialA.startFrame} endFrame ${initialA.endFrame}`,
      families: ['tae_event'],
      limit: 8,
      expandReferences: false
    });
    const oldQuery = parseData<{ hits?: Array<{ chunk?: RagChunk }> }>(oldQueryResponse);
    check(
      !(oldQuery.hits ?? []).some((hit) => hit.chunk?.sourceUri === initialTargetChunk.sourceUri
        && hit.chunk?.sourceRevision === initialChunkRevision),
      '旧 A/current old revision 不得出现在第二次 RAG query'
    );
    const embeddingInvalidated = repository.loadRagEmbeddings().size === 0;
    check(embeddingInvalidated, '替换 current chunks 后旧 embedding 必须被 FK cascade 清掉');

    const embedding = lastCommittedEmbedding ?? {
      status: 'BLOCKED' as const,
      code: 'POST_COMMIT_EMBEDDING_RESULT_MISSING',
      message: 'mutation postcommit 未产生可审计的 embedding 结果。'
    };
    const embeddingRebuilt = embedding.status === 'rebuilt'
      && repository.loadRagEmbeddings().size === currentCorpus.chunks.length
      && repository.ragEmbeddingSourceRevision() === currentChunkRevision;
    check(
      embedding.status === 'BLOCKED' || embeddingRebuilt,
      'embedding 必须真实重建，或在无 provider 时结构化 BLOCKED'
    );

    const referencesPersisted = repository.loadReferences().length === currentCorpus.references.length;
    check(referencesPersisted, 'reference projection 必须与 current index refresh 一起持久化');
    const oldAAbsent = !(persistedChunks.some((chunk) => chunk.sourceUri === initialTargetChunk.sourceUri
      && chunk.body.includes(`startFrame ${initialA.startFrame}`)
      && chunk.body.includes(`endFrame ${initialA.endFrame}`)));
    const oldRevisionAbsent = !persistedChunks.some((chunk) => chunk.sourceUri === initialTargetChunk.sourceUri
      && chunk.sourceRevision === initialChunkRevision);
    check(oldAAbsent, 'persisted current chunks 不得保留旧 A 内容');
    check(oldRevisionAbsent, 'persisted current chunks 不得保留旧 A revision');

    const blocked = embedding.status === 'BLOCKED'
      ? {
        code: embedding.code,
        message: embedding.message,
        missing: embedding.code === 'REAL_EMBEDDING_PROVIDER_REQUIRED'
          ? ['真实 OpenAI-compatible embedding provider 或可用 provider 配置']
          : []
      }
      : undefined;
    const knowledgeFresh = mutation.postCommit?.knowledgeFresh === true
      && embeddingRebuilt
      && oldAAbsent
      && oldRevisionAbsent
      && referencesPersisted
      && currentCoverageRevision !== initialCoverageRevision
      && currentChunkRevision !== initialChunkRevision;

    return {
      ok: knowledgeFresh,
      status: knowledgeFresh ? 'PASS' : 'BLOCKED',
      authority: knowledgeFresh ? 'fixture-confirmed' : 'partial',
      syntheticFixture: true,
      knowledgeFresh,
      target: {
        address: targetAddress,
        initial: initialA,
        current: currentB
      },
      assertions: {
        agentExactReadA: true,
        agentMutationAtoB: true,
        authoritativeRereadB: true,
        indexCurrentB: true,
        referencesPersisted,
        ragCurrentB: true,
        oldAAbsent,
        oldRevisionAbsent,
        embeddingInvalidated,
        embeddingRebuilt
      },
      revisions: {
        ...(initialCoverageRevision ? { initialCoverageHash: hashRevision(initialCoverageRevision) } : {}),
        ...(currentCoverageRevision ? { currentCoverageHash: hashRevision(currentCoverageRevision) } : {}),
        ...(initialChunkRevision ? { initialChunk: initialChunkRevision } : {}),
        ...(currentChunkRevision ? { currentChunk: currentChunkRevision } : {})
      },
      refreshes,
      embedding,
      completionEvidence: (mutationResponse.completionEvidence ?? []).map((evidence) => evidence.kind),
      ...(blocked ? { blocked } : {}),
      nonClaims: [
        'synthetic TAE 只证明 production Agent/Bridge/Patch Engine/index/RAG wiring，不提升真实 Sekiro corpus authority。',
        'fixture-sentinel-not-a-provider 只用于证明旧 embedding 的持久化失效，不代表任何模型服务输出。',
        '没有真实 provider 时 knowledgeFresh=false；不会把 embedding invalidation 冒充成 rebuild。'
      ]
    };
  } finally {
    database.close();
  }
}

async function execute(
  bridge: ReturnType<typeof createAgentToolBridge>,
  name: string,
  input: Record<string, unknown>
): Promise<ToolResponse> {
  const response = await bridge.executeTool({
    id: `agent-rag-postwrite-${name}`,
    name,
    argumentsJson: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(`production Agent tool ${name} failed (${response.code ?? 'TOOL_FAILED'}): ${response.content}`);
  }
  return response;
}

function parseData<T>(response: ToolResponse): T {
  try {
    return JSON.parse(response.content) as T;
  } catch (error) {
    throw new Error(`Agent tool returned non-JSON content: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findTargetChunk(corpus: RagCorpus, address: string): RagChunk | undefined {
  return corpus.chunks.find((chunk) => chunk.family === 'tae_event'
    && (chunk.title === address || chunk.body.includes(`address ${address}`)));
}

function requireRag(corpus: RagCorpus | null, stage: string): RagCorpus {
  if (!corpus) throw new Error(`${stage} 后没有 active RAG snapshot`);
  return corpus;
}

async function rebuildWithRealProvider(
  repository: WorkspaceDataRepository,
  corpus: RagCorpus
): Promise<EmbeddingResult> {
  // The current source revision invalidates any older vectors before a new
  // provider attempt.  A blocked/partial response must never leave stale
  // vectors queryable.
  repository.replaceRagEmbeddings([]);
  const baseUrl = process.env.SOULFORGE_EMBEDDING_BASE_URL?.trim();
  const apiKey = process.env.SOULFORGE_EMBEDDING_API_KEY?.trim();
  const model = process.env.SOULFORGE_EMBEDDING_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) {
    return {
      status: 'BLOCKED',
      code: 'REAL_EMBEDDING_PROVIDER_REQUIRED',
      message: '未配置真实 embedding provider；已验证旧向量失效，但拒绝假造重建。'
    };
  }

  let result: Awaited<ReturnType<typeof fetchEmbeddings>>;
  try {
    result = await fetchEmbeddings({
      baseUrl,
      apiKey,
      model,
      inputs: corpus.chunks.map((chunk) => `${chunk.title}\n${chunk.body}`),
      timeoutMs: 60_000
    });
  } catch (error) {
    return {
      status: 'BLOCKED',
      code: 'EMBEDDING_REQUEST_FAILED',
      message: `真实 embedding provider 请求异常：${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!result.ok) {
    return {
      status: 'BLOCKED',
      code: result.error.code,
      message: `真实 embedding provider 未完成重建：${result.error.message}`
    };
  }
  const sourceRevision = corpus.coverage?.sourceRevision ?? corpus.chunks[0]?.sourceRevision;
  const vectorsValid = result.vectors.every((vector) => vector.length === result.dim
    && vector.every((value) => Number.isFinite(value)));
  if (!sourceRevision || result.vectors.length !== corpus.chunks.length || result.dim <= 0
    || !vectorsValid || corpus.chunks.some((chunk) => chunk.sourceRevision !== sourceRevision)) {
    return {
      status: 'BLOCKED',
      code: 'EMBEDDING_REBUILD_INCOMPLETE',
      message: `provider 返回 ${result.vectors.length}/${corpus.chunks.length} 个向量，dim=${result.dim}。`
    };
  }
  repository.replaceRagEmbeddings(corpus.chunks.map((chunk, index) => ({
    chunkId: chunk.chunkId,
    model,
    vector: result.vectors[index]!,
    sourceRevision: chunk.sourceRevision ?? sourceRevision
  })));
  if (repository.loadRagEmbeddings().size !== corpus.chunks.length
    || repository.ragEmbeddingSourceRevision() !== sourceRevision
    || repository.ragEmbeddingModel() !== model) {
    repository.replaceRagEmbeddings([]);
    return {
      status: 'BLOCKED',
      code: 'EMBEDDING_PERSISTENCE_VERIFY_FAILED',
      message: 'provider 向量已返回，但 SQLite 持久化校验未通过。'
    };
  }
  return {
    status: 'rebuilt',
    model,
    dimension: result.dim,
    count: result.vectors.length,
    sourceRevision
  };
}

/**
 * Synthetic TAE copied from the already verified C# writer fixture shape.
 * It contains two animations; anim 10/event 0 has unique time slots so the
 * production update-event-times writer can safely perform a surgical update.
 */
function buildSyntheticTae(): Buffer {
  const b = Buffer.alloc(SYNTHETIC.fileSize);
  b.write('TAE ', 0x00, 'ascii');
  b.writeUInt8(0x00, 0x04);
  b.writeUInt8(0x00, 0x05);
  b.writeUInt8(0x00, 0x06);
  b.writeUInt8(0xff, 0x07);
  b.writeInt32LE(0x0001000d, 0x08);
  b.writeInt32LE(SYNTHETIC.fileSize, SYNTHETIC.declaredSizeAbs);
  b.writeBigInt64LE(64n, 0x10);
  b.writeBigInt64LE(1n, 0x18);
  b.writeBigInt64LE(0x50n, 0x20);
  b.writeBigInt64LE(0x80n, 0x28);
  b.writeBigInt64LE(0n, 0x30);
  b.writeBigInt64LE(0n, 0x38);

  b.writeInt32LE(0, 0x50);
  b.writeInt32LE(2, 0x54);
  b.writeBigInt64LE(0x80n, 0x58);
  b.writeBigInt64LE(0n, 0x60);
  b.writeBigInt64LE(0n, 0x68);
  b.writeBigInt64LE(2n, 0x70);
  b.writeBigInt64LE(0n, 0x78);

  b.writeBigInt64LE(0n, 0x80);
  b.writeBigInt64LE(0xa8n, 0x88);
  b.writeBigInt64LE(10n, 0x90);
  b.writeBigInt64LE(0xe8n, 0x98);
  b.writeBigInt64LE(20n, 0xa0);

  b.writeBigInt64LE(0x128n, 0xa8);
  b.writeBigInt64LE(0x180n, 0xb0);
  b.writeBigInt64LE(0xd8n, 0xb8);
  b.writeBigInt64LE(0n, 0xc0);
  b.writeInt32LE(2, 0xc8);
  b.writeInt32LE(1, 0xcc);
  b.writeBigInt64LE(4n, 0xd0);
  b.writeFloatLE(0.0, 0xd8);
  b.writeFloatLE(1.0, 0xdc);
  b.writeFloatLE(0.5, 0xe0);
  b.writeFloatLE(2.0, 0xe4);

  b.writeBigInt64LE(0x1b8n, 0xe8);
  b.writeBigInt64LE(0x208n, 0xf0);
  b.writeBigInt64LE(0x118n, 0xf8);
  b.writeBigInt64LE(0n, 0x100);
  b.writeInt32LE(2, 0x108);
  b.writeInt32LE(1, 0x10c);
  b.writeBigInt64LE(4n, 0x110);
  b.writeFloatLE(0.0, 0x118);
  b.writeFloatLE(2.0, 0x11c);
  b.writeFloatLE(0.0, 0x120);
  b.writeFloatLE(2.0, 0x124);

  b.writeBigInt64LE(0xd8n, 0x128);
  b.writeBigInt64LE(0xdcn, 0x130);
  b.writeBigInt64LE(0x158n, 0x138);
  b.writeBigInt64LE(0xe0n, 0x140);
  b.writeBigInt64LE(0xe4n, 0x148);
  b.writeBigInt64LE(0x168n, 0x150);
  b.writeInt32LE(16, 0x158);
  b.writeInt32LE(0, 0x15c);
  b.writeBigInt64LE(0n, 0x160);
  b.writeInt32LE(700, 0x168);
  b.writeInt32LE(0, 0x16c);
  b.writeBigInt64LE(0x178n, 0x170);
  Buffer.from(SYNTHETIC.templateParam).copy(b, 0x178);

  b.writeBigInt64LE(2n, 0x180);
  b.writeBigInt64LE(0x1a0n, 0x188);
  b.writeBigInt64LE(0x1a8n, 0x190);
  b.writeBigInt64LE(0n, 0x198);
  b.writeInt32LE(0x158, 0x1a0);
  b.writeInt32LE(0x168, 0x1a4);
  b.writeInt32LE(16, 0x1a8);
  b.writeInt32LE(0, 0x1ac);
  b.writeBigInt64LE(0n, 0x1b0);

  b.writeBigInt64LE(0x118n, 0x1b8);
  b.writeBigInt64LE(0x11cn, 0x1c0);
  b.writeBigInt64LE(0x1e8n, 0x1c8);
  b.writeBigInt64LE(0x118n, 0x1d0);
  b.writeBigInt64LE(0x11cn, 0x1d8);
  b.writeBigInt64LE(0x1f8n, 0x1e0);
  b.writeInt32LE(16, 0x1e8);
  b.writeInt32LE(0, 0x1ec);
  b.writeBigInt64LE(0n, 0x1f0);
  b.writeInt32LE(16, 0x1f8);
  b.writeInt32LE(0, 0x1fc);
  b.writeBigInt64LE(0n, 0x200);

  b.writeBigInt64LE(2n, 0x208);
  b.writeBigInt64LE(0x228n, 0x210);
  b.writeBigInt64LE(0x230n, 0x218);
  b.writeBigInt64LE(0n, 0x220);
  b.writeInt32LE(0x1e8, 0x228);
  b.writeInt32LE(0x1f8, 0x22c);
  b.writeInt32LE(16, 0x230);
  b.writeInt32LE(0, 0x234);
  b.writeBigInt64LE(0n, 0x238);
  return b;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
