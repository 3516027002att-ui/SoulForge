/**
 * 有界 RAG SQLite/FTS 持久化计时。
 *
 * 这是诊断/回归，不是 native 或 Electron 启动证明：在临时 SQLite 中把
 * synthetic PARAM 行按桌面层相同的 512 行批次写入，记录每个事务耗时，并
 * 验证增量更新不会删除同一 source 的未变化 chunk。默认只写 5000 行；需要
 * 复核真实 50295 行量时显式设置 SF_RAG_PERF_ROWS=50295，避免普通回归误占
 * 满桌面/磁盘资源。
 */

import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import type { RagChunk } from '@soulforge/shared';
import { createRagCorpus } from '../rag/chunkBuilder.js';
import { collectIndexedCandidates, ensureLookupIndex } from '../rag/lookupIndex.js';
import { diffRagCorpusBySource, loadRagCorpus, persistRagCorpus } from '../rag/persist.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import {
  isRagChunkDeltaStats,
  WorkspaceDataRepository,
  type RagChunkDeltaStats
} from '../storage/workspaceDataRepository.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const BATCH_SIZE = 512;
const DEFAULT_ROWS = 5_000;
const WORKSPACE_ID = 'rag-persistence-performance';
const SOURCE_URI = 'file://param/gameparam.parambnd.dcx#NpcParam';
const VERBOSE = process.env.SF_RAG_PERF_VERBOSE === '1';

function main(): Promise<void> {
  const rows = parseRows(process.env.SF_RAG_PERF_ROWS);
  return withSmokeWorkspace('rag-persistence-performance', async (workspace) => {
    const database = openWorkspaceDatabase(join(workspace.root, 'workspace.db'));
    try {
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(WORKSPACE_ID, workspace.root, 'sekiro', now, now);

      const repository = new WorkspaceDataRepository(database, WORKSPACE_ID);
      const chunks = Array.from({ length: rows }, (_, index) => makeChunk(index));
      const desiredCorpus = createRagCorpus({
        workspaceId: WORKSPACE_ID,
        builtAt: now,
        chunks,
        references: []
      });
      const batchDurationsMs: number[] = [];
      let initialStats: RagChunkDeltaStats | null = null;
      const persistStarted = performance.now();
      for (let offset = 0; offset < chunks.length; offset += BATCH_SIZE) {
        const started = performance.now();
        const stats = repository.mergeRagChunkDelta({
          sourceUri: SOURCE_URI,
          upserts: chunks.slice(offset, offset + BATCH_SIZE),
          deletedChunkIds: []
        });
        assertRagChunkDeltaStats(stats);
        if (initialStats === null) initialStats = stats;
        batchDurationsMs.push(performance.now() - started);
        if (VERBOSE && (batchDurationsMs.length === 1 || batchDurationsMs.length % 10 === 0)) {
          process.stderr.write(JSON.stringify({
            phase: 'persist',
            batch: batchDurationsMs.length,
            batchesTotal: Math.ceil(chunks.length / BATCH_SIZE),
            elapsedMs: round(performance.now() - persistStarted),
            batchMs: round(batchDurationsMs.at(-1) ?? 0)
          }) + '\n');
        }
      }
      const persistElapsedMs = performance.now() - persistStarted;
      const persistedCount = countChunks(database);
      if (persistedCount !== rows) {
        throw new Error(`初次持久化行数错误：${persistedCount} != ${rows}。`);
      }
      assertRagChunkDeltaStats(initialStats, {
        finalUpserts: Math.min(BATCH_SIZE, rows),
        newUpserts: Math.min(BATCH_SIZE, rows),
        bodyChangedUpserts: 0,
        metadataOnlyUpserts: 0,
        ftsRebuilds: Math.min(BATCH_SIZE, rows),
        embeddingDeletes: 0
      });
      const invalidStats: readonly unknown[] = [
        null,
        { ...initialStats, ftsRebuilds: undefined },
        { ...initialStats, ftsRebuilds: Number.NaN },
        { ...initialStats, privateDiagnostic: 1 }
      ];
      if (invalidStats.some((value) => isRagChunkDeltaStats(value))) {
        throw new Error('RAG delta stats validator accepted null/missing/nonfinite/extra diagnostic data。');
      }

      // The SQLite loader has its own ORDER BY and reconstructs optional
      // fields, so verify the complete build -> persist -> load -> diff path
      // rather than assuming JSON field order is stable.  This must be a true
      // no-op: an accidental delta would clear FTS/embeddings on every refresh.
      const loadedCorpus = loadRagCorpus(repository, WORKSPACE_ID);
      const noOpDeltas = diffRagCorpusBySource(loadedCorpus, desiredCorpus);
      if (noOpDeltas.length !== 0 || noOpDeltas.some((delta) => delta.upserts.length > 0 || delta.deletedChunkIds.length > 0)) {
        throw new Error(`持久化后重新加载的语料 diff 不是 no-op：${JSON.stringify(noOpDeltas.slice(0, 2).map((delta) => ({
          sourceUri: delta.sourceUri,
          upserts: delta.upserts.length,
          deletedChunkIds: delta.deletedChunkIds.length
        })))}。`);
      }
      // persistRagCorpus must observe the same no-op and leave the durable
      // rows untouched; this exercises the production core persistence path.
      persistRagCorpus(repository, desiredCorpus);

      // A reorder is not equivalent for a positional inverted index.  Mutate
      // one corpus in place and require ensureLookupIndex to rebuild it; a
      // signature that sorted chunk identities would incorrectly reuse stale
      // row positions here.
      const beforeReorderIndex = ensureLookupIndex(desiredCorpus);
      desiredCorpus.chunks.reverse();
      const afterReorderIndex = ensureLookupIndex(desiredCorpus);
      const reorderedPositions = afterReorderIndex.byUri.get('param://npcparam/0') ?? [];
      const reorderedHits = collectIndexedCandidates(desiredCorpus.chunks, afterReorderIndex, {
        numericIds: [],
        terms: [],
        phrases: [],
        uris: ['param://NpcParam/0']
      }, null);
      if (beforeReorderIndex === afterReorderIndex
        || reorderedPositions.some((position) => desiredCorpus.chunks[position]?.symbolUri !== 'param://NpcParam/0')
        || reorderedHits.length !== 1
        || reorderedHits[0]?.symbolUri !== 'param://NpcParam/0') {
        throw new Error('corpus 原地重排后 lookup index 未按新数组下标重建。');
      }

      // A packed native source can change its source identity while a row's
      // searchable title/body/contentHash stays byte-for-byte stable.  Keep
      // both contentless FTS rowids as a direct proof that this path updates
      // only the main-table provenance.  Embedding invalidation intentionally
      // retains the existing contract and is checked separately.
      const metadataChunk = chunks[1]!;
      const metadataFtsBefore = readFtsProbe(database, metadataChunk.chunkId);
      repository.mergeRagEmbeddings({
        model: 'synthetic-rag-model',
        entries: [{
          chunkId: metadataChunk.chunkId,
          contentHash: metadataChunk.contentHash,
          vector: new Float32Array([0.25, 0.5, 0.75, 1])
        }],
        deletedChunkIds: []
      });
      const metadataChunks = chunks.map((chunk) => ({
        ...chunk,
        sourceRevision: 2,
        sourceHash: 'synthetic-source-hash-v2',
        outerFileHash: 'synthetic-outer-hash-v2'
      }));
      const metadataChurnBatchDurationsMs: number[] = [];
      let metadataStats: RagChunkDeltaStats | null = null;
      const metadataChangesBefore = readTotalChanges(database);
      const metadataChurnStarted = performance.now();
      for (let offset = 0; offset < metadataChunks.length; offset += BATCH_SIZE) {
        const started = performance.now();
        const stats = repository.mergeRagChunkDelta({
          sourceUri: SOURCE_URI,
          upserts: metadataChunks.slice(offset, offset + BATCH_SIZE),
          deletedChunkIds: []
        });
        assertRagChunkDeltaStats(stats);
        if (metadataStats === null) metadataStats = stats;
        metadataChurnBatchDurationsMs.push(performance.now() - started);
      }
      const metadataChurnElapsedMs = performance.now() - metadataChurnStarted;
      const metadataChangesAfter = readTotalChanges(database);
      const metadataChangeDelta = metadataChangesAfter - metadataChangesBefore;
      const metadataFtsAfter = readFtsProbe(database, metadataChunk.chunkId);
      const metadataRow = repository.loadRagChunks().find((chunk) => chunk.chunkId === metadataChunk.chunkId);
      if (metadataFtsBefore.unicodeRowId === null
        || metadataFtsBefore.trigramRowId === null
        || metadataFtsBefore.unicodeRowId !== metadataFtsAfter.unicodeRowId
        || metadataFtsBefore.trigramRowId !== metadataFtsAfter.trigramRowId) {
        throw new Error(`metadata-only 更新重建了 FTS：${JSON.stringify({ before: metadataFtsBefore, after: metadataFtsAfter })}。`);
      }
      if (!metadataRow
        || metadataRow.sourceRevision !== 2
        || metadataRow.sourceHash !== 'synthetic-source-hash-v2'
        || metadataRow.outerFileHash !== 'synthetic-outer-hash-v2') {
        throw new Error('metadata-only 更新没有把最新 source identity 写入主表。');
      }
      if (repository.searchRagChunks('metadataonlystabletoken').length !== 1) {
        throw new Error('metadata-only 更新后原有 FTS 词不可检索。');
      }
      if (repository.loadRagEmbeddings().has(metadataChunk.chunkId)) {
        throw new Error('metadata-only 更新改变 source identity 后 embedding 未按既有契约失效。');
      }
      // With unchanged title/body/contentHash, this phase should touch only
      // the main row per chunk plus the one deliberately seeded embedding.
      // FTS5 writes update shadow tables and would add extra total_changes;
      // this catches a hidden rebuild even if one sampled rowid happened to
      // be reused by SQLite.
      const expectedMetadataChangeDelta = rows + 1;
      if (metadataChangeDelta !== expectedMetadataChangeDelta) {
        throw new Error(`metadata-only 更新发生了额外 SQLite 写入：${JSON.stringify({
          metadataChangeDelta,
          expectedMetadataChangeDelta
        })}。`);
      }
      assertRagChunkDeltaStats(metadataStats, {
        finalUpserts: Math.min(BATCH_SIZE, rows),
        newUpserts: 0,
        bodyChangedUpserts: 0,
        metadataOnlyUpserts: Math.min(BATCH_SIZE, rows),
        ftsRebuilds: 0,
        embeddingDeletes: Math.min(BATCH_SIZE, rows)
      });

      // A delete+reinsert may carry byte-for-byte identical searchable text
      // while refreshing only provenance.  The delete must still clear the
      // old contentless FTS rows before the replacement is inserted; otherwise
      // the stable token disappears from search (or a stale duplicate row is
      // left behind).
      const reinsertPreparedChunk = {
        ...chunks[4]!,
        body: `${chunks[4]!.body} deletereinsertstabletoken`,
        contentHash: 'content-delete-reinsert'
      };
      repository.mergeRagChunkDelta({
        sourceUri: SOURCE_URI,
        upserts: [reinsertPreparedChunk],
        deletedChunkIds: []
      });
      const reinsertBefore = readFtsProbe(database, reinsertPreparedChunk.chunkId);
      if (repository.searchRagChunks('deletereinsertstabletoken').length !== 1) {
        throw new Error('delete+reinsert 准备阶段的稳定词不可检索。');
      }
      const reinsertMetadataChunk = {
        ...reinsertPreparedChunk,
        sourceRevision: 3,
        sourceHash: 'synthetic-source-hash-v3',
        outerFileHash: 'synthetic-outer-hash-v3'
      };
      const reinsertStats = repository.mergeRagChunkDelta({
        sourceUri: SOURCE_URI,
        upserts: [reinsertMetadataChunk],
        deletedChunkIds: [reinsertPreparedChunk.chunkId]
      });
      assertRagChunkDeltaStats(reinsertStats, {
        finalUpserts: 1,
        newUpserts: 0,
        bodyChangedUpserts: 0,
        metadataOnlyUpserts: 0,
        ftsRebuilds: 1,
        embeddingDeletes: 1
      });
      const reinsertAfter = readFtsProbe(database, reinsertPreparedChunk.chunkId);
      const reinsertRow = repository.loadRagChunks().find((chunk) => chunk.chunkId === reinsertPreparedChunk.chunkId);
      const reinsertHits = repository.searchRagChunks('deletereinsertstabletoken');
      const reinsertFtsCounts = database.prepare(`
SELECT
  (SELECT COUNT(*) FROM rag_chunks_fts WHERE chunk_id = ?) AS unicodeCount,
  (SELECT COUNT(*) FROM rag_chunks_fts_trigram WHERE chunk_id = ?) AS trigramCount
`).get(reinsertPreparedChunk.chunkId, reinsertPreparedChunk.chunkId) as {
        unicodeCount: number;
        trigramCount: number;
      };
      if (!reinsertRow
        || reinsertRow.sourceRevision !== 3
        || reinsertRow.sourceHash !== 'synthetic-source-hash-v3'
        || reinsertRow.outerFileHash !== 'synthetic-outer-hash-v3'
        || reinsertHits.length !== 1
        || reinsertHits[0]?.chunkId !== reinsertPreparedChunk.chunkId
        || Number(reinsertFtsCounts.unicodeCount) !== 1
        || Number(reinsertFtsCounts.trigramCount) !== 1
        || reinsertBefore.unicodeRowId === null
        || reinsertBefore.trigramRowId === null
        || reinsertAfter.unicodeRowId === null
        || reinsertAfter.trigramRowId === null) {
        throw new Error(`delete+metadata-only reinsert 未恢复稳定 FTS 行：${JSON.stringify({
          before: reinsertBefore,
          after: reinsertAfter,
          counts: reinsertFtsCounts,
          hits: reinsertHits.length,
          row: reinsertRow
        })}。`);
      }

      // One failing row must roll back the whole bounded transaction: the
      // valid metadata update and all FTS mutations from the same batch must
      // not become partially visible.
      const atomicBefore = repository.loadRagChunks().find((chunk) => chunk.chunkId === metadataChunk.chunkId);
      const atomicFtsBefore = readFtsProbe(database, metadataChunk.chunkId);
      let atomicFailed = false;
      try {
        repository.mergeRagChunkDelta({
          sourceUri: SOURCE_URI,
          upserts: [
            { ...metadataChunks[1]!, sourceRevision: 3, sourceHash: 'atomic-source-hash' },
            {
              ...metadataChunks[2]!,
              body: `${metadataChunks[2]!.body} atomic-new-token`,
              contentHash: null as unknown as string
            }
          ],
          deletedChunkIds: []
        });
      } catch {
        atomicFailed = true;
      }
      const atomicAfter = repository.loadRagChunks().find((chunk) => chunk.chunkId === metadataChunk.chunkId);
      const atomicFtsAfter = readFtsProbe(database, metadataChunk.chunkId);
      if (!atomicFailed
        || atomicBefore?.sourceRevision !== atomicAfter?.sourceRevision
        || atomicBefore?.sourceHash !== atomicAfter?.sourceHash
        || atomicFtsBefore.unicodeRowId !== atomicFtsAfter.unicodeRowId
        || atomicFtsBefore.trigramRowId !== atomicFtsAfter.trigramRowId
        || repository.searchRagChunks('atomic-new-token').length !== 0) {
        throw new Error('RAG delta 失败事务没有保持 source/FTS 原子性。');
      }

      // A delete from source A must not erase source B's FTS row even when the
      // caller accidentally supplies B's chunk ID in A's bounded delta.
      const foreignSourceUri = `${SOURCE_URI}#other-source`;
      const foreignChunk: RagChunk = {
        ...makeChunk(rows + 1),
        chunkId: 'rag:param:foreign-source',
        sourceUri: foreignSourceUri,
        symbolUri: 'param://Other/foreign-source',
        body: 'sourceguardstabletoken foreign source',
        contentHash: 'foreign-source-content'
      };
      repository.mergeRagChunkDelta({
        sourceUri: foreignSourceUri,
        upserts: [foreignChunk],
        deletedChunkIds: []
      });
      const foreignFtsBefore = readFtsProbe(database, foreignChunk.chunkId);
      repository.mergeRagChunkDelta({
        sourceUri: SOURCE_URI,
        upserts: [],
        deletedChunkIds: [foreignChunk.chunkId]
      });
      const foreignStillThere = repository.loadRagChunks().some((chunk) => chunk.chunkId === foreignChunk.chunkId);
      const foreignFtsAfter = readFtsProbe(database, foreignChunk.chunkId);
      if (!foreignStillThere
        || foreignFtsBefore.unicodeRowId !== foreignFtsAfter.unicodeRowId
        || foreignFtsBefore.trigramRowId !== foreignFtsAfter.trigramRowId
        || repository.searchRagChunks('sourceguardstabletoken').length !== 1) {
        throw new Error('source guard 误删了其它 source 的主表/FTS。');
      }
      repository.mergeRagChunkDelta({
        sourceUri: foreignSourceUri,
        upserts: [],
        deletedChunkIds: [foreignChunk.chunkId]
      });

      let workspaceGuardFailed = false;
      try {
        repository.mergeRagChunkDelta({
          sourceUri: SOURCE_URI,
          upserts: [{ ...chunks[3]!, chunkId: 'rag:param:workspace-guard', workspaceId: 'other-workspace' }],
          deletedChunkIds: []
        });
      } catch {
        workspaceGuardFailed = true;
      }
      if (!workspaceGuardFailed || repository.loadRagChunks().some((chunk) => chunk.chunkId === 'rag:param:workspace-guard')) {
        throw new Error('跨 workspace RAG delta 未失败关闭。');
      }

      // 同一批内重复 upsert 不得留下重复的 FTS 行；更新已有 chunk
      // 也必须清除旧词和旧 embedding。
      const duplicateChunk = chunks[0]!;
      repository.mergeRagEmbeddings({
        model: 'synthetic-rag-model',
        entries: [{
          chunkId: duplicateChunk.chunkId,
          contentHash: duplicateChunk.contentHash,
          vector: new Float32Array([1, 0, 0, 1])
        }],
        deletedChunkIds: []
      });
      const duplicateOld = {
        ...duplicateChunk,
        body: `${duplicateChunk.body} ragduplicateoldtoken`,
        contentHash: 'content-duplicate-old'
      };
      const duplicateNew = {
        ...duplicateChunk,
        body: `${duplicateChunk.body} ragduplicatenewtoken`,
        contentHash: 'content-duplicate-new'
      };
      const duplicateStats = repository.mergeRagChunkDelta({
        sourceUri: SOURCE_URI,
        upserts: [duplicateOld, duplicateNew],
        deletedChunkIds: []
      });
      assertRagChunkDeltaStats(duplicateStats, {
        finalUpserts: 1,
        newUpserts: 0,
        bodyChangedUpserts: 1,
        metadataOnlyUpserts: 0,
        ftsRebuilds: 1,
        embeddingDeletes: 1
      });
      const duplicateFtsCounts = database.prepare(`
SELECT
  (SELECT COUNT(*) FROM rag_chunks_fts WHERE chunk_id = ?) AS unicodeCount,
  (SELECT COUNT(*) FROM rag_chunks_fts_trigram WHERE chunk_id = ?) AS trigramCount
`).get(duplicateChunk.chunkId, duplicateChunk.chunkId) as {
        unicodeCount: number;
        trigramCount: number;
      };
      if (Number(duplicateFtsCounts.unicodeCount) !== 1
        || Number(duplicateFtsCounts.trigramCount) !== 1) {
        throw new Error(`重复 upsert 留下重复 FTS 行：${JSON.stringify(duplicateFtsCounts)}。`);
      }
      if (repository.searchRagChunks('ragduplicateoldtoken').length !== 0) {
        throw new Error('重复 upsert 后旧 FTS 词仍可命中。');
      }
      const duplicateNewHits = repository.searchRagChunks('ragduplicatenewtoken');
      if (duplicateNewHits.length !== 1 || duplicateNewHits[0]?.chunkId !== duplicateChunk.chunkId) {
        throw new Error('重复 upsert 后新 FTS 词未唯一命中最终 chunk。');
      }
      if (repository.loadRagEmbeddings().has(duplicateChunk.chunkId)) {
        throw new Error('已有 chunk 更新后旧 embedding 未失效。');
      }

      // 更新一批时只替换该批的主表/FTS 行；同一 source 的其余行必须保留。
      const changed = chunks.slice(0, Math.min(BATCH_SIZE, chunks.length)).map((chunk) => ({
        ...chunk,
        body: `${chunk.body} changed`
      }));
      const changedStats = repository.mergeRagChunkDelta({
        sourceUri: SOURCE_URI,
        upserts: changed,
        deletedChunkIds: []
      });
      assertRagChunkDeltaStats(changedStats, {
        finalUpserts: changed.length,
        newUpserts: 0,
        bodyChangedUpserts: changed.length,
        metadataOnlyUpserts: 0,
        ftsRebuilds: changed.length,
        embeddingDeletes: changed.length
      });
      const afterDeltaCount = countChunks(database);
      if (afterDeltaCount !== rows) {
        throw new Error(`增量更新错误删除同源 chunk：${afterDeltaCount} != ${rows}。`);
      }
      const unchanged = repository.loadRagChunks().find((chunk) => chunk.chunkId === chunks.at(-1)?.chunkId);
      if (!unchanged || unchanged.body.endsWith(' changed')) {
        throw new Error('增量更新覆盖了未变化 chunk。');
      }
      const changedRead = repository.searchRagChunks('changed', BATCH_SIZE);
      if (changedRead.length === 0) {
        throw new Error('增量更新没有刷新 FTS 检索结果。');
      }

      const result = {
        ok: true,
        status: 'passed',
        test: 'rag-persistence-performance',
        scope: 'synthetic-sqlite-only',
        rows,
        batchSize: BATCH_SIZE,
        batches: batchDurationsMs.length,
        persistElapsedMs: round(persistElapsedMs),
        batchMs: summarize(batchDurationsMs),
        persistedCount,
        afterDeltaCount,
        noOpDeltaCount: noOpDeltas.length,
        noOpUpsertCount: noOpDeltas.reduce((total, delta) => total + delta.upserts.length, 0),
        metadataOnly: {
          rows: metadataChunks.length,
          elapsedMs: round(metadataChurnElapsedMs),
          batchMs: summarize(metadataChurnBatchDurationsMs),
          unicodeFtsRowPreserved: metadataFtsBefore.unicodeRowId === metadataFtsAfter.unicodeRowId,
          trigramFtsRowPreserved: metadataFtsBefore.trigramRowId === metadataFtsAfter.trigramRowId,
          ftsWritesDetected: metadataChangeDelta !== expectedMetadataChangeDelta,
          sqliteChangeDelta: metadataChangeDelta,
          embeddingInvalidated: !repository.loadRagEmbeddings().has(metadataChunk.chunkId),
          sourceIdentityUpdated: metadataRow?.sourceRevision === 2
            && metadataRow.sourceHash === 'synthetic-source-hash-v2'
            && metadataRow.outerFileHash === 'synthetic-outer-hash-v2'
        },
        nonClaims: [
          '不证明 Electron utility IPC 或 workspace pipeline 阶段回调不会等待。',
          '不证明真实游戏语料、native parser、生产 Bridge 或发布构建。'
        ]
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      database.close();
    }
  });
}

function makeChunk(index: number): RagChunk {
  return {
    chunkId: `rag:param:${index}`,
    workspaceId: WORKSPACE_ID,
    sourceUri: SOURCE_URI,
    symbolUri: `param://NpcParam/${index}`,
    family: 'param_row',
    title: `NpcParam ${index}`,
    body: `param NpcParam row ${index} npcType ${index % 9} ninsatuNum ${index % 4} 鬼刑部${index === 1 ? ' metadataonlystabletoken' : ''}`,
    numericIds: [index],
    contentHash: `content-${index}`,
    sourceRevision: 1,
    sourceHash: 'synthetic-source-hash',
    outerFileHash: 'synthetic-outer-hash',
    relativePath: 'param/gameparam.parambnd.dcx',
    resourceKind: 'param'
  };
}

const RAG_DELTA_STAT_KEYS: readonly (keyof RagChunkDeltaStats)[] = [
  'finalUpserts',
  'newUpserts',
  'bodyChangedUpserts',
  'metadataOnlyUpserts',
  'ftsRebuilds',
  'embeddingDeletes'
];

function assertRagChunkDeltaStats(
  stats: RagChunkDeltaStats | null,
  expected?: Partial<RagChunkDeltaStats>
): asserts stats is RagChunkDeltaStats {
  if (stats === null || typeof stats !== 'object') {
    throw new Error('RAG delta stats 缺失，不能把缺失结果归零。');
  }
  const actualKeys = Object.keys(stats).sort();
  const expectedKeys = [...RAG_DELTA_STAT_KEYS].sort();
  if (actualKeys.join(',') !== expectedKeys.join(',')) {
    throw new Error(`RAG delta stats keys 不完整或包含额外字段：${actualKeys.join(',')}`);
  }
  for (const key of RAG_DELTA_STAT_KEYS) {
    const value = stats[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > BATCH_SIZE) {
      throw new Error(`RAG delta stats ${key} 不是有限非负整数：${String(value)}`);
    }
  }
  if (stats.metadataOnlyUpserts + stats.ftsRebuilds !== stats.finalUpserts
    || stats.newUpserts + stats.embeddingDeletes !== stats.finalUpserts
    || stats.bodyChangedUpserts > stats.ftsRebuilds - stats.newUpserts) {
    throw new Error(`RAG delta stats 分类不守恒：${JSON.stringify(stats)}`);
  }
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (stats[key as keyof RagChunkDeltaStats] !== value) {
      throw new Error(`RAG delta stats ${key} 不符合预期：${String(stats[key as keyof RagChunkDeltaStats])} != ${String(value)}`);
    }
  }
}

function readFtsProbe(
  database: ReturnType<typeof openWorkspaceDatabase>,
  chunkId: string
): { unicodeRowId: number | null; trigramRowId: number | null } {
  const unicode = database.prepare(
    'SELECT rowid AS rowId FROM rag_chunks_fts WHERE chunk_id = ?'
  ).get(chunkId) as { rowId?: number } | undefined;
  const trigram = database.prepare(
    'SELECT rowid AS rowId FROM rag_chunks_fts_trigram WHERE chunk_id = ?'
  ).get(chunkId) as { rowId?: number } | undefined;
  return {
    unicodeRowId: unicode?.rowId === undefined ? null : Number(unicode.rowId),
    trigramRowId: trigram?.rowId === undefined ? null : Number(trigram.rowId)
  };
}

function readTotalChanges(database: ReturnType<typeof openWorkspaceDatabase>): number {
  const row = database.prepare('SELECT total_changes() AS totalChanges').get() as { totalChanges: number };
  return Number(row.totalChanges);
}

function countChunks(database: ReturnType<typeof openWorkspaceDatabase>): number {
  const row = database.prepare('SELECT COUNT(*) AS count FROM rag_chunks WHERE workspace_id = ?').get(WORKSPACE_ID) as { count: number };
  return Number(row.count);
}

function parseRows(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ROWS;
  const rows = Number(raw);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 200_000) {
    throw new Error(`SF_RAG_PERF_ROWS 必须是 1..200000 的整数，收到 ${raw}。`);
  }
  return rows;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarize(values: readonly number[]): { p50Ms: number; p95Ms: number; maxMs: number } {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(Math.max(...sorted))
  };
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
