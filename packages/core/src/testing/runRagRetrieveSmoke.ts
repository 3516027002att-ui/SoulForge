import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BridgeResult, IndexedFile, MapExport, RagChunk, RagCorpus } from '@soulforge/shared';
import { ingestBridgeResult } from '../indexing/ingestBridgeResult.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import type { ModelServiceAdapter, ModelServiceConfig } from '../model-services/types.js';
import { buildRagCorpus, createRagCorpus, mergeCatalogAndPersisted } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { getRagStaleChunkMaskCached } from '../rag/freshness.js';
import { parseRagQuery } from '../rag/queryParse.js';
import { diffRagCorpusBySource, loadRagCorpus, persistRagCorpus, sameRagReferences } from '../rag/persist.js';
import { openWorkspaceDatabase } from '../storage/sqliteDatabase.js';
import { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';
import { findPathLeak } from './assertNoPathLeak.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

function main(): Promise<void> {
  return withSmokeWorkspace('rag', async (workspace) => {
    const index = buildSyntheticIndex();
    const corpus = buildRagCorpus(index);
    if (corpus.stats.byFamily.file < 1 || corpus.stats.byFamily.event < 1) {
      throw new Error(`RAG corpus missing families: ${JSON.stringify(corpus.stats)}`);
    }
    // Native readback can identify one row inside a large PARAM source.  A
    // symbol-scoped rebuild must return only that row so the host can merge it
    // without rebuilding or replacing the rest of the table.
    const symbolSource = 'file://synthetic/param/symbol-scoped.param';
    const symbolIndex = new WorkspaceIndex('workspace-rag-symbol-scoped');
    symbolIndex.setFiles([makeFile('param/symbol-scoped.param', 'param', symbolSource, 'symbol-source-v1')]);
    assertAccepted(ingestBridgeResult(symbolIndex, {
      sourceUri: symbolSource,
      sourcePath: 'param/symbol-scoped.param',
      game: 'sekiro',
      resourceKind: 'param',
      parseStatus: 'parsed',
      diagnostics: [],
      data: {
        paramName: 'NpcParam',
        rows: [
          {
            uri: `${symbolSource}#NpcParam/100`,
            sourceUri: symbolSource,
            paramName: 'NpcParam',
            rowId: 100,
            rowName: 'first-row',
            fields: [{ name: 'hp', type: 'int32', value: 100 }]
          },
          {
            uri: `${symbolSource}#NpcParam/200`,
            sourceUri: symbolSource,
            paramName: 'NpcParam',
            rowId: 200,
            rowName: 'second-row',
            fields: [{ name: 'hp', type: 'int32', value: 200 }]
          }
        ]
      }
    }));
    const symbolScoped = buildRagCorpus(
      symbolIndex,
      new Date().toISOString(),
      [],
      [symbolSource],
      [`${symbolSource}#NpcParam/200`]
    );
    if (symbolScoped.chunks.length !== 1
      || symbolScoped.chunks[0]?.symbolUri !== `${symbolSource}#NpcParam/200`
      || symbolScoped.chunks[0]?.body.includes('first-row')) {
      throw new Error(`symbol-scoped RAG rebuild returned unrelated symbols: ${JSON.stringify(symbolScoped.chunks)}`);
    }
    await assertParamNameAliases();
    await assertParamTextLinks();

    // P0 regression: a changed file must invalidate semantic symbols before
    // the new catalog hash reaches RAG. Otherwise old-value + new-hash would
    // become indistinguishable from a freshly decoded symbol.
    const changedSource = 'file://synthetic/event/common.emevd.dcx';
    const revisionIndex = new WorkspaceIndex('workspace-rag-revision');
    revisionIndex.setFiles([makeFile('event/common.emevd.dcx', 'event', changedSource, 'event-source-v1')]);
    assertAccepted(ingestBridgeResult(revisionIndex, makeEventExport('event-source-v1', 'old-value')));
    const oldRevisionCorpus = buildRagCorpus(revisionIndex);
    if (!oldRevisionCorpus.chunks.some((chunk) => chunk.body.includes('old-value') && chunk.sourceHash === 'event-source-v1')) {
      throw new Error('revision fixture did not create the old semantic value');
    }
    revisionIndex.invalidateSource(changedSource);
    revisionIndex.setFiles([makeFile('event/common.emevd.dcx', 'event', changedSource, 'event-source-v2')]);
    const clearedCorpus = buildRagCorpus(revisionIndex);
    if (clearedCorpus.chunks.some((chunk) => chunk.family === 'event')) {
      throw new Error('changed source left stale semantic symbols in WorkspaceIndex');
    }
    assertAccepted(ingestBridgeResult(revisionIndex, makeEventExport('event-source-v2', 'new-value')));
    const newRevisionCorpus = buildRagCorpus(revisionIndex);
    const newEventChunk = newRevisionCorpus.chunks.find((chunk) => chunk.family === 'event');
    if (!newEventChunk || !newEventChunk.body.includes('new-value') || newEventChunk.sourceHash !== 'event-source-v2') {
      throw new Error(`new semantic value did not carry its own source revision: ${JSON.stringify(newEventChunk)}`);
    }
    if (newRevisionCorpus.chunks.some((chunk) => chunk.body.includes('old-value') || chunk.sourceHash === 'event-source-v1')) {
      throw new Error('old semantic value survived a source revision change');
    }

    const eventHit = retrieveEvidence(corpus, '1100800');
    if (!eventHit.ok) throw new Error(`id retrieve failed: ${eventHit.message}`);
    if (!eventHit.hits.some((hit) => hit.chunk.symbolUri === 'event://m10_00_00_00/1000')) {
      throw new Error(`event 1000 not retrieved for entity id: ${JSON.stringify(eventHit.hits.map((hit) => hit.chunk.symbolUri))}`);
    }
    if (!eventHit.hits.some((hit) => hit.chunk.symbolUri === 'map://m10_00_00_00/entity/1100800')) {
      throw new Error(`entity 1100800 not retrieved as a primary id hit: ${JSON.stringify(eventHit.hits.map((hit) => hit.chunk.symbolUri))}`);
    }

    const expanded = retrieveEvidence(corpus, '71000000');
    if (!expanded.ok) throw new Error(`flag retrieve failed: ${expanded.message}`);
    if (!expanded.hits.some((hit) => hit.chunk.family === 'map_entity' && hit.expandedFrom === 'event://m10_00_00_00/1000')) {
      throw new Error(`reference expansion did not attach the map entity: ${JSON.stringify(expanded.hits.map((hit) => ({
        uri: hit.chunk.symbolUri,
        family: hit.chunk.family,
        expandedFrom: hit.expandedFrom,
        reasons: hit.reasons
      })))} refs=${JSON.stringify(corpus.references.map((edge) => `${edge.fromUri}->${edge.toUri}:${edge.kind}`))}`);
    }

    const textHit = retrieveEvidence(corpus, '狼的义手');
    if (!textHit.ok) throw new Error(`CJK retrieve failed: ${textHit.message}`);
    if (!textHit.hits.some((hit) => hit.chunk.family === 'text_entry')) {
      throw new Error('CJK query did not hit the text entry');
    }
    const compoundCjkHit = retrieveEvidence(corpus, '把狼的义手设置成精英怪，出场时地上随机落雷5秒，击杀后掉落铃铛');
    if (!compoundCjkHit.ok || !compoundCjkHit.hits.some((hit) => hit.chunk.family === 'text_entry')) {
      throw new Error(`compound Chinese task query must hit the object phrase: ${JSON.stringify(compoundCjkHit)}`);
    }

    // Natural-language configuration values are not object IDs.  A previous
    // parser promoted the "2" health bars and "5" seconds in this task into
    // numeric lookup keys, so unrelated map entities with IDs 2/5 outranked
    // the actual character text evidence.
    const naturalTaskCorpus = createRagCorpus({
      workspaceId: 'workspace-rag-natural-task',
      builtAt: new Date().toISOString(),
      chunks: [
        {
          chunkId: 'rag:map_entity:natural-number-noise',
          workspaceId: 'workspace-rag-natural-task',
          sourceUri: 'file://synthetic/map/natural.msb',
          symbolUri: 'map://natural/entity/2',
          family: 'map_entity',
          title: 'unrelated map entity',
          body: 'entity unrelated to the requested character',
          numericIds: [2, 5],
          contentHash: 'natural-map-noise'
        },
        {
          chunkId: 'rag:text_entry:natural-character',
          workspaceId: 'workspace-rag-natural-task',
          sourceUri: 'file://synthetic/msg/menu.msg',
          symbolUri: 'msg://menu/1001',
          family: 'text_entry',
          title: 'npc name 1001',
          body: 'textId 1001\n鬼刑部',
          numericIds: [1001],
          contentHash: 'natural-character'
        }
      ]
    });
    const naturalTaskHit = retrieveEvidence(
      naturalTaskCorpus,
      '把鬼刑部设置成精英怪，血条设置为2，出场时地上随机落雷5秒，不攻击到狼，击杀后掉落义父的铃铛',
      { limit: 4, expandReferences: false }
    );
    if (!naturalTaskHit.ok
      || naturalTaskHit.hits[0]?.chunk.family !== 'text_entry'
      || naturalTaskHit.hits.some((hit) => hit.reasons.includes('id:2') || hit.reasons.includes('id:5'))) {
      throw new Error(`natural task values must not outrank object evidence: ${JSON.stringify(naturalTaskHit)}`);
    }
    const explicitShortId = parseRagQuery('rowId 2');
    if (!explicitShortId.numericIds.includes(2)) {
      throw new Error(`explicit rowId context must retain short numeric IDs: ${JSON.stringify(explicitShortId)}`);
    }

    const fileHit = retrieveEvidence(corpus, 'common.emevd.dcx', { families: ['file'] });
    if (!fileHit.ok || fileHit.hits[0]?.chunk.relativePath !== 'event/common.emevd.dcx') {
      throw new Error(`file catalog retrieve failed: ${JSON.stringify(fileHit)}`);
    }

    const empty = retrieveEvidence(corpus, 'zzzxqwy-not-a-symbol');
    if (empty.ok || empty.code !== 'insufficient_evidence') {
      throw new Error(`empty query must be insufficient_evidence, got ${JSON.stringify(empty)}`);
    }

    // 阶段1 评分修正：多 term 查询命中 ≥50% 即保留（「synthetic_event_1000」命中、
    // 噪音词 zzzxqwy 不命中 → 2 term 中 1 命中，≥ ceil(2/2)=1，必须保留 event）。
    const partialTerm = retrieveEvidence(corpus, 'synthetic_event_1000 zzzxqwy');
    if (!partialTerm.ok
      || !partialTerm.hits.some((hit) => hit.chunk.symbolUri === 'event://m10_00_00_00/1000')) {
      throw new Error(`50% term threshold must keep the event hit: ${JSON.stringify(partialTerm)}`);
    }

    // 阶段1 ID 前缀匹配：查询 110080（少写尾数 0）。实体 body 含完整数字时走
    // id-text 子串命中；body 截断（不含完整数字）时才轮到 id-prefix 分支。
    const prefixHit = retrieveEvidence(corpus, '110080');
    if (!prefixHit.ok
      || !prefixHit.hits.some((hit) => hit.chunk.symbolUri === 'map://m10_00_00_00/entity/1100800')) {
      throw new Error(`id prefix must retrieve entity 1100800: ${JSON.stringify(prefixHit)}`);
    }
    const prefixOnly = createRagCorpus({
      workspaceId: 'workspace-rag-smoke',
      builtAt: new Date().toISOString(),
      chunks: [{
        chunkId: 'rag:map_entity:prefix-only',
        workspaceId: 'workspace-rag-smoke',
        sourceUri: 'file://synthetic/map/truncated.msb',
        symbolUri: 'map://truncated/entity/1100800',
        family: 'map_entity',
        title: 'truncated entity',
        body: 'entity（字段已截断，不显示完整 ID）',
        numericIds: [1100800],
        contentHash: 'prefix-only-hash'
      }]
    });
    const prefixOnlyHit = retrieveEvidence(prefixOnly, '110080');
    if (!prefixOnlyHit.ok
      || !prefixOnlyHit.hits.some((hit) => hit.reasons.includes('id-prefix:110080'))) {
      throw new Error(`id-prefix reason must fire when body lacks the full id: ${JSON.stringify(prefixOnlyHit)}`);
    }

    // --- 问题6：动作 / 地图按参数同构编址（内存 corpus；sqlite open 之前必须全过）---
    const ragQueryMap = parseRagQuery('m11_01_00_00');
    if (!ragQueryMap.terms.includes('m11_01_00_00') && !ragQueryMap.phrases.includes('m11_01_00_00')) {
      throw new Error(`parseRagQuery must keep atomic map block m11_01_00_00: ${JSON.stringify(ragQueryMap)}`);
    }
    const ragQueryAction = parseRagQuery('c1050#A0200');
    if (!ragQueryAction.terms.includes('c1050') || !ragQueryAction.terms.includes('a0200')) {
      throw new Error(`parseRagQuery must keep action address parts c1050 / a0200: ${JSON.stringify(ragQueryAction)}`);
    }

    const chrHit = retrieveEvidence(corpus, 'c1050');
    if (!chrHit.ok || !chrHit.hits.some((hit) => hit.chunk.symbolUri === 'action://c1050/A0200/e0')) {
      throw new Error(`c1050 must retrieve the TAE event: ${JSON.stringify(chrHit)}`);
    }
    const animHit = retrieveEvidence(corpus, 'A0200');
    if (!animHit.ok || !animHit.hits.some((hit) => hit.chunk.symbolUri === 'action://c1050/A0200/e0')) {
      throw new Error(`A0200 must retrieve the TAE event: ${JSON.stringify(animHit)}`);
    }
    const eventAddrHit = retrieveEvidence(corpus, 'c1050#A0200');
    if (!eventAddrHit.ok || !eventAddrHit.hits.some((hit) => hit.chunk.symbolUri === 'action://c1050/A0200/e0')) {
      throw new Error(`c1050#A0200 must retrieve the TAE event: ${JSON.stringify(eventAddrHit)}`);
    }
    const soundHit = retrieveEvidence(corpus, '105011001');
    if (!soundHit.ok || !soundHit.hits.some((hit) => hit.chunk.family === 'tae_event')) {
      throw new Error(`SoundID 105011001 must numeric-hit the TAE event: ${JSON.stringify(soundHit)}`);
    }
    const mapBlockHit = retrieveEvidence(corpus, 'm11_01_00_00');
    if (!mapBlockHit.ok || !mapBlockHit.hits.some((hit) => hit.chunk.symbolUri === 'map://m11_01_00_00/part/c1050_0000')) {
      throw new Error(`m11_01_00_00 must retrieve the m11 part: ${JSON.stringify(mapBlockHit)}`);
    }
    const mapAreaHit = retrieveEvidence(corpus, 'M11');
    if (!mapAreaHit.ok || !mapAreaHit.hits.some((hit) => hit.chunk.symbolUri === 'map://m11_01_00_00/part/c1050_0000')) {
      throw new Error(`M11 must retrieve the m11 part: ${JSON.stringify(mapAreaHit)}`);
    }

    // A map name/part URI may repeat across physical MSB sources. Chunk
    // identity must include sourceUri, otherwise the second source overwrites
    // the first in SQLite and source-scoped refreshes cannot converge.
    const mapSourceA = 'file://synthetic/map/duplicate-a.msb';
    const mapSourceB = 'file://synthetic/map/duplicate-b.msb';
    const dualMapIndex = new WorkspaceIndex('workspace-rag-map-sources');
    assertAccepted(ingestBridgeResult(dualMapIndex, makeMapExport(mapSourceA)));
    assertAccepted(ingestBridgeResult(dualMapIndex, makeMapExport(mapSourceB)));
    const currentMapA = ingestBridgeResult(dualMapIndex, makeMapExport(mapSourceA, 'map-a-v2', 2, 'source-a-v2'));
    assertAccepted(currentMapA);
    const currentMapExport = dualMapIndex.toSymbolBundle().maps?.find((map) => (
      map.entities.some((entity) => entity.sourceUri === mapSourceA)
    ));
    if (!currentMapExport) throw new Error('current source-A map projection missing before stale rejection check');
    const staleMapExport: MapExport = {
      ...currentMapExport,
      sourceHash: 'map-a-v1',
      sourceRevision: 1
    };
    if (dualMapIndex.upsertMapExport(staleMapExport)) {
      throw new Error('stale map projection must be rejected without replacing current source');
    }
    const dualMapCatalog = buildRagCorpus(dualMapIndex);
    const mapChunkA = dualMapCatalog.chunks.find((chunk) => chunk.family === 'map_entity' && chunk.sourceUri === mapSourceA);
    const mapChunkB = dualMapCatalog.chunks.find((chunk) => chunk.family === 'map_entity' && chunk.sourceUri === mapSourceB);
    const mapRegionA = dualMapCatalog.chunks.find((chunk) => chunk.family === 'map_region' && chunk.sourceUri === mapSourceA);
    const mapRegionB = dualMapCatalog.chunks.find((chunk) => chunk.family === 'map_region' && chunk.sourceUri === mapSourceB);
    if (!mapChunkA || !mapChunkB || !mapRegionA || !mapRegionB || mapChunkA.chunkId === mapChunkB.chunkId
      || mapChunkA.sourceUri !== mapSourceA || mapChunkB.sourceUri !== mapSourceB
      || !mapChunkA.body.includes('source-a-v2') || mapChunkB.body.includes('source-a-v1')) {
      throw new Error(`map chunk identity must include physical source: ${JSON.stringify({ mapChunkA, mapChunkB, mapRegionA, mapRegionB, catalog: dualMapCatalog.stats })}`);
    }

    // PARAM typeName/rowId is only a logical address.  Two physical BND4
    // children can expose the same address, so both rows must remain
    // searchable and durable without changing the native row URI used by
    // read/write tools.
    const paramMigrationWorkspaceId = 'workspace-rag-param-migration';
    const paramMigrationSource = 'file://synthetic/param/collision.parambnd.dcx';
    const paramMigrationIndex = new WorkspaceIndex(paramMigrationWorkspaceId);
    paramMigrationIndex.setFiles([{
      ...makeFile('param/collision.parambnd.dcx', 'param', paramMigrationSource, 'param-source-v1', 1),
      workspaceId: paramMigrationWorkspaceId,
      id: `${paramMigrationWorkspaceId}:param/collision.parambnd.dcx`
    }]);
    assertAccepted(ingestBridgeResult(paramMigrationIndex, {
      sourceUri: paramMigrationSource,
      sourcePath: 'param/collision.parambnd.dcx',
      game: 'sekiro',
      resourceKind: 'param',
      parseStatus: 'partial',
      diagnostics: [],
      data: {
        sourceHash: 'param-source-v1',
        outerFileHash: 'param-source-v1',
        sourceRevision: 1,
        params: [
          {
            paramName: 'ATK_PARAM_ST',
            entryName: 'AtkParam_Npc.param',
            entryIndex: 4,
            rows: [{
              uri: 'param://ATK_PARAM_ST/42',
              rowId: 42,
              rowName: 'npc_child_row_42',
              raw: { rowIndex: 0 },
              fields: [{ name: 'damage', type: 'int32', value: 100 }]
            }]
          },
          {
            paramName: 'ATK_PARAM_ST',
            entryName: 'AtkParam_Pc.param',
            entryIndex: 5,
            rows: [{
              uri: 'param://ATK_PARAM_ST/42',
              rowId: 42,
              rowName: 'pc_child_row_42',
              raw: { rowIndex: 0 },
              fields: [{ name: 'damage', type: 'int32', value: 200 }]
            }]
          }
        ]
      }
    }));
    const paramMigrationCorpus = buildRagCorpus(paramMigrationIndex);
    const paramMigrationChunks = paramMigrationCorpus.chunks.filter((chunk) => chunk.family === 'param_row');
    if (paramMigrationChunks.length !== 2
      || new Set(paramMigrationChunks.map((chunk) => chunk.chunkId)).size !== 2
      || new Set(paramMigrationChunks.map((chunk) => chunk.symbolUri)).size !== 1
      || !paramMigrationChunks.some((chunk) => chunk.body.includes('entry AtkParam_Npc.param'))
      || !paramMigrationChunks.some((chunk) => chunk.body.includes('entry AtkParam_Pc.param'))) {
      throw new Error(`PARAM child-aware RAG identity failed: ${JSON.stringify(paramMigrationChunks)}`);
    }
    // A symbol-scoped refresh may have only child A while durable RAG already
    // contains a fresh child B with the same logical row URI.  The merge must
    // preserve B; only the old pre-child-aware ID is eligible for migration.
    const partialParamCatalog = createRagCorpus({
      workspaceId: paramMigrationWorkspaceId,
      builtAt: paramMigrationCorpus.builtAt,
      chunks: paramMigrationCorpus.chunks.filter((chunk) => (
        chunk.family === 'file' || chunk.body.includes('entry AtkParam_Npc.param')
      )),
      references: paramMigrationCorpus.references
    });
    const persistedNewParamChild = createRagCorpus({
      workspaceId: paramMigrationWorkspaceId,
      builtAt: paramMigrationCorpus.builtAt,
      chunks: paramMigrationCorpus.chunks.filter((chunk) => (
        chunk.family === 'file' || chunk.body.includes('entry AtkParam_Pc.param')
      )),
      references: paramMigrationCorpus.references
    });
    const partialParamMerge = mergeCatalogAndPersisted(partialParamCatalog, persistedNewParamChild);
    const partialParamRows = partialParamMerge.chunks.filter((chunk) => chunk.family === 'param_row');
    if (partialParamRows.length !== 2
      || !partialParamRows.some((chunk) => chunk.body.includes('entry AtkParam_Npc.param'))
      || !partialParamRows.some((chunk) => chunk.body.includes('entry AtkParam_Pc.param'))
      || new Set(partialParamRows.map((chunk) => chunk.chunkId)).size !== 2) {
      throw new Error(`partial PARAM child merge dropped a fresh sibling: ${JSON.stringify(partialParamRows)}`);
    }
    // This is the exact ID emitted by the pre-child-aware sourceUri+row.uri
    // identity.  Both physical children used to collapse onto this key.
    const legacyCollisionId = `rag:param_row:${createHash('sha256')
      .update(`${paramMigrationChunks[0]!.sourceUri}\u0000${paramMigrationChunks[0]!.symbolUri}`)
      .digest('hex').slice(0, 24)}`;
    const legacyCollisionCorpus = createRagCorpus({
      workspaceId: paramMigrationWorkspaceId,
      builtAt: paramMigrationCorpus.builtAt,
      chunks: paramMigrationCorpus.chunks.map((chunk) => chunk.family === 'param_row'
        ? { ...chunk, chunkId: legacyCollisionId }
        : chunk),
      references: paramMigrationCorpus.references
    });

    const leaked = findPathLeak(corpus, workspace.root) ?? findPathLeak(eventHit, 'D:\\') ?? findPathLeak(eventHit, 'C:\\');
    if (leaked) throw new Error(`RAG payload leaked a filesystem path at ${leaked}`);

    const dbPath = join(workspace.root, 'workspace.db');
    const database = openWorkspaceDatabase(dbPath);
    let reloadedChunkCount = 0;
    try {
      const now = new Date().toISOString();
      database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(index.workspaceId, workspace.root, 'sekiro', now, now);
      database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(paramMigrationWorkspaceId, workspace.root, 'sekiro', now, now);
      const repository = new WorkspaceDataRepository(database, index.workspaceId);
      const paramMigrationRepository = new WorkspaceDataRepository(database, paramMigrationWorkspaceId);

      // Start with the pre-fix durable shape: both physical children share
      // one legacy chunk ID, so SQLite necessarily leaves one winner.
      persistRagCorpus(paramMigrationRepository, legacyCollisionCorpus);
      const legacyReloaded = loadRagCorpus(paramMigrationRepository, paramMigrationWorkspaceId);
      const legacyRows = legacyReloaded.chunks.filter((chunk) => chunk.family === 'param_row');
      if (legacyRows.length !== 1 || legacyRows[0]?.chunkId !== legacyCollisionId) {
        throw new Error(`legacy collision fixture did not reproduce one persisted winner: ${JSON.stringify(legacyRows)}`);
      }
      const mergedParamMigration = mergeCatalogAndPersisted(paramMigrationCorpus, legacyReloaded);
      const mergedParamRows = mergedParamMigration.chunks.filter((chunk) => chunk.family === 'param_row');
      if (mergedParamRows.length !== 2 || mergedParamMigration.chunks.some((chunk) => chunk.chunkId === legacyCollisionId)
        || new Set(mergedParamRows.map((chunk) => chunk.chunkId)).size !== 2) {
        throw new Error(`legacy collision ID survived catalog merge: ${JSON.stringify(mergedParamRows)}`);
      }
      persistRagCorpus(paramMigrationRepository, mergedParamMigration);
      const migratedParamCorpus = loadRagCorpus(paramMigrationRepository, paramMigrationWorkspaceId);
      const migratedParamRows = migratedParamCorpus.chunks.filter((chunk) => chunk.family === 'param_row');
      if (migratedParamRows.length !== 2 || migratedParamCorpus.chunks.some((chunk) => chunk.chunkId === legacyCollisionId)
        || new Set(migratedParamRows.map((chunk) => chunk.chunkId)).size !== 2) {
        throw new Error(`legacy collision ID was not deleted/rebuilt in SQLite: ${JSON.stringify(migratedParamRows)}`);
      }
      for (const childEntryName of ['AtkParam_Npc.param', 'AtkParam_Pc.param']) {
        const childHit = retrieveEvidence(migratedParamCorpus, childEntryName, {
          families: ['param_row'],
          limit: 8,
          expandReferences: false
        });
        if (!childHit.ok || !childHit.hits.some((hit) => hit.chunk.body.includes(`entry ${childEntryName}`))) {
          throw new Error(`migrated PARAM child was not retrievable: ${childEntryName} ${JSON.stringify(childHit)}`);
        }
      }

      persistRagCorpus(repository, corpus);
      const dualSourceCorpus = createRagCorpus({
        workspaceId: index.workspaceId,
        builtAt: now,
        chunks: [
          ...corpus.chunks,
          { ...mapChunkA, workspaceId: index.workspaceId },
          { ...mapChunkB, workspaceId: index.workspaceId },
          { ...mapRegionA, workspaceId: index.workspaceId },
          { ...mapRegionB, workspaceId: index.workspaceId }
        ],
        references: corpus.references
      });
      persistRagCorpus(repository, dualSourceCorpus);
      const dualSourceReloaded = loadRagCorpus(repository, index.workspaceId);
      const dualMapChunks = dualSourceReloaded.chunks.filter((chunk) => (
        chunk.family === 'map_entity' && (chunk.sourceUri === mapSourceA || chunk.sourceUri === mapSourceB)
      ));
      if (dualMapChunks.length !== 2
        || new Set(dualMapChunks.map((chunk) => chunk.sourceUri)).size !== 2
        || new Set(dualMapChunks.map((chunk) => chunk.chunkId)).size !== 2) {
        throw new Error(`dual-source map persistence collapsed physical sources: ${JSON.stringify(dualMapChunks)}`);
      }
      const dualMapRegions = dualSourceReloaded.chunks.filter((chunk) => (
        chunk.family === 'map_region' && (chunk.sourceUri === mapSourceA || chunk.sourceUri === mapSourceB)
      ));
      if (dualMapRegions.length !== 2
        || new Set(dualMapRegions.map((chunk) => chunk.sourceUri)).size !== 2
        || new Set(dualMapRegions.map((chunk) => chunk.chunkId)).size !== 2) {
        throw new Error(`dual-source map region persistence collapsed physical sources: ${JSON.stringify(dualMapRegions)}`);
      }
      const updatedDualSourceCorpus = createRagCorpus({
        workspaceId: index.workspaceId,
        builtAt: now,
        chunks: dualSourceCorpus.chunks.map((chunk) => chunk.sourceUri === mapSourceA && chunk.family === 'map_entity'
          ? { ...chunk, body: `${chunk.body}\nsource-a-updated`, contentHash: 'map-source-a-updated' }
          : chunk),
        references: dualSourceCorpus.references
      });
      persistRagCorpus(repository, updatedDualSourceCorpus);
      const afterDualUpdate = loadRagCorpus(repository, index.workspaceId);
      const sourceBAfterUpdate = afterDualUpdate.chunks.find((chunk) => chunk.sourceUri === mapSourceB && chunk.family === 'map_entity');
      const sourceAAfterUpdate = afterDualUpdate.chunks.find((chunk) => chunk.sourceUri === mapSourceA && chunk.family === 'map_entity');
      if (!sourceBAfterUpdate || !sourceAAfterUpdate || !sourceAAfterUpdate.body.includes('source-a-updated')
        || sourceBAfterUpdate.body.includes('source-a-updated')) {
        throw new Error(`source-scoped map update affected the other source: ${JSON.stringify({ sourceAAfterUpdate, sourceBAfterUpdate })}`);
      }
      const dualSourceHit = retrieveEvidence(afterDualUpdate, '1100800', { limit: 8, expandReferences: false });
      const dualSourceHits = dualSourceHit.ok
        ? dualSourceHit.hits.filter((hit) => hit.chunk.sourceUri === mapSourceA || hit.chunk.sourceUri === mapSourceB)
        : [];
      if (!dualSourceHit.ok || dualSourceHits.length !== 2
        || !dualSourceHits.some((hit) => hit.chunk.sourceUri === mapSourceA && hit.chunk.body.includes('source-a-updated'))
        || !dualSourceHits.some((hit) => hit.chunk.sourceUri === mapSourceB && !hit.chunk.body.includes('source-a-updated'))) {
        throw new Error(`dual-source map retrieve did not preserve source identity: ${JSON.stringify(dualSourceHit)}`);
      }
      const dualRegionHit = retrieveEvidence(afterDualUpdate, 'boss_phase_2', { limit: 8, expandReferences: false });
      const dualRegionHits = dualRegionHit.ok
        ? dualRegionHit.hits.filter((hit) => hit.chunk.sourceUri === mapSourceA || hit.chunk.sourceUri === mapSourceB)
        : [];
      if (!dualRegionHit.ok || dualRegionHits.length !== 2) {
        throw new Error(`dual-source map region retrieve did not preserve source identity: ${JSON.stringify(dualRegionHit)}`);
      }
      if (!sameRagReferences(corpus.references, [...corpus.references].reverse())) {
        throw new Error('reference comparison must ignore SQLite/discovery ordering');
      }
      const fts = repository.searchRagChunks('义手', 10);
      if (!fts.some((chunk) => chunk.family === 'text_entry')) {
        throw new Error(`FTS persist search missed CJK text: ${fts.map((chunk) => chunk.title).join(',')}`);
      }
      // 阶段1 trigram 子串检索：3 字 CJK 子串命中（migration 8 trigram 索引）。
      const trigram = repository.searchRagChunks('狼的义', 10);
      if (!trigram.some((chunk) => chunk.family === 'text_entry')) {
        throw new Error(`trigram search missed CJK substring: ${trigram.map((chunk) => chunk.title).join(',')}`);
      }
      const reloaded = loadRagCorpus(repository, index.workspaceId);
      reloadedChunkCount = reloaded.chunks.length;
      if (reloaded.chunks.length !== dualSourceCorpus.chunks.length) {
        throw new Error(`reload lost chunks: ${reloaded.chunks.length} != ${dualSourceCorpus.chunks.length}`);
      }
      const reloadedHit = retrieveEvidence(reloaded, '71000000');
      if (!reloadedHit.ok) throw new Error(`reloaded retrieve failed: ${reloadedHit.message}`);

    const catalogOnly = buildRagCorpus(fileOnlyIndex(index.workspaceId));
    const merged = mergeCatalogAndPersisted(catalogOnly, reloaded);
    if (!merged.chunks.some((chunk) => chunk.family === 'event')) {
      throw new Error('scan merge dropped previously analyzed event chunks');
    }
    const persistedEvent = reloaded.chunks.find((chunk) => chunk.family === 'event');
    if (!persistedEvent) throw new Error('fixture must contain a persisted event for provenance checks');
    // P0 regression: an analyze result contains fresh semantic chunks.  The
    // merge must keep them even when the persisted database is empty; otherwise
    // the active RAG silently degrades to a file catalog.
    const currentOnly = mergeCatalogAndPersisted(corpus, createRagCorpus({
      workspaceId: corpus.workspaceId,
      builtAt: corpus.builtAt,
      chunks: []
    }));
    if (!currentOnly.chunks.some((chunk) => chunk.family === 'event')
      || !currentOnly.chunks.some((chunk) => chunk.family === 'param_row')
      || currentOnly.availability !== 'available') {
      throw new Error(`merge dropped current semantic catalog: ${JSON.stringify(currentOnly.stats)}`);
    }
    const currentChanged = createRagCorpus({
      workspaceId: corpus.workspaceId,
      builtAt: corpus.builtAt,
      chunks: corpus.chunks.map((chunk) => chunk.chunkId === persistedEvent.chunkId
        ? { ...chunk, body: 'fresh current semantic body', contentHash: 'fresh-current-hash' }
        : chunk),
      references: corpus.references
    });
    const currentWins = mergeCatalogAndPersisted(currentChanged, reloaded);
    if (currentWins.chunks.find((chunk) => chunk.chunkId === persistedEvent.chunkId)?.body !== 'fresh current semantic body') {
      throw new Error('merge allowed an older persisted chunk to overwrite current catalog data');
    }
    const deltas = diffRagCorpusBySource(catalogOnly, currentOnly);
    if (!deltas.some((delta) => delta.upserts.some((chunk) => chunk.family === 'event'))) {
      throw new Error('source delta did not include current semantic event chunks');
    }
    const unavailable = createRagCorpus({
      workspaceId: corpus.workspaceId,
      builtAt: corpus.builtAt,
      chunks: catalogOnly.chunks
    });
    if (unavailable.availability !== 'unavailable'
      || !unavailable.diagnostics.some((diagnostic) => diagnostic.code === 'RAG_SEMANTIC_CORPUS_EMPTY')) {
      throw new Error(`file-only corpus must be unavailable: ${JSON.stringify(unavailable)}`);
    }
    const unavailableHit = retrieveEvidence(unavailable, 'common.emevd.dcx');
    if (unavailableHit.ok || unavailableHit.code !== 'RAG_UNAVAILABLE') {
      throw new Error(`file-only RAG must fail closed: ${JSON.stringify(unavailableHit)}`);
    }
    const unavailableSearch = await registrySearchParamRowsForRagTest(fileOnlyIndex(index.workspaceId), unavailable);
    if (unavailableSearch.ok || unavailableSearch.error?.code !== 'RAG_UNAVAILABLE') {
      throw new Error(`specialized search must expose unavailable RAG: ${JSON.stringify(unavailableSearch)}`);
    }
    const stalePersisted = createRagCorpus({
      workspaceId: index.workspaceId,
      builtAt: reloaded.builtAt,
      chunks: reloaded.chunks.map((chunk) => chunk.family === 'event'
        ? { ...chunk, sourceHash: 'stale-source-hash', outerFileHash: 'stale-outer-file-hash' }
        : chunk),
      references: reloaded.references
    });
    const staleMerged = mergeCatalogAndPersisted(catalogOnly, stalePersisted);
    if (staleMerged.chunks.some((chunk) => chunk.family === 'event')) {
      throw new Error('scan merge retained an event chunk from a stale outer file hash');
    }
    const missingHashPersisted = createRagCorpus({
      workspaceId: index.workspaceId,
      builtAt: reloaded.builtAt,
      chunks: reloaded.chunks.map((chunk) => chunk === persistedEvent
        ? withoutOuterFileHash(chunk)
        : chunk),
      references: reloaded.references
    });
    const missingHashMerged = mergeCatalogAndPersisted(catalogOnly, missingHashPersisted);
    if (missingHashMerged.chunks.some((chunk) => chunk.chunkId === persistedEvent.chunkId)) {
      throw new Error('scan merge retained a semantic chunk with missing outer file hash');
    }
    const missingRevisionPersisted = createRagCorpus({
      workspaceId: index.workspaceId,
      builtAt: reloaded.builtAt,
      chunks: reloaded.chunks.map((chunk) => chunk === persistedEvent
        ? withoutSourceRevision(chunk)
        : chunk),
      references: reloaded.references
    });
    const missingRevisionMerged = mergeCatalogAndPersisted(catalogOnly, missingRevisionPersisted);
    if (missingRevisionMerged.chunks.some((chunk) => chunk.chunkId === persistedEvent.chunkId)) {
      throw new Error('scan merge retained a semantic chunk with missing source revision');
    }
    const mismatchedRevisionPersisted = createRagCorpus({
      workspaceId: index.workspaceId,
      builtAt: reloaded.builtAt,
      chunks: reloaded.chunks.map((chunk) => chunk === persistedEvent
        ? { ...chunk, sourceRevision: 999 }
        : chunk),
      references: reloaded.references
    });
    const mismatchedRevisionMerged = mergeCatalogAndPersisted(catalogOnly, mismatchedRevisionPersisted);
    if (mismatchedRevisionMerged.chunks.some((chunk) => chunk.chunkId === persistedEvent.chunkId)) {
      throw new Error('scan merge retained a semantic chunk from a mismatched source revision');
    }
    } finally {
      if (database.open) database.close();
    }

    const registry = createDefaultToolRegistry();
    const missing = await registry.run('retrieve_evidence', { query: 'x' }, { workspaceIndex: null, mode: 'plan' });
    if (missing.ok || missing.error?.code !== 'WORKSPACE_REQUIRED') {
      throw new Error(`retrieve_evidence must require a workspace, got ${JSON.stringify(missing)}`);
    }

    // P0 regression: a durable corpus may still contain the previous native
    // projection while the live index is stale between commit and refresh.
    // The tool path must fail closed for that source instead of returning the
    // old semantic value from context.rag.
    const staleToolSource = 'file://synthetic/event/stale-tool.emevd.dcx';
    const staleToolIndex = new WorkspaceIndex('workspace-rag-stale-tool');
    staleToolIndex.setFiles([makeFile('event/stale-tool.emevd.dcx', 'event', staleToolSource, 'stale-tool-v1')]);
    const staleToolExport = makeEventExport('stale-tool-v1', 'stale-tool-old-value', staleToolSource);
    staleToolExport.sourcePath = 'event/stale-tool.emevd.dcx';
    assertAccepted(ingestBridgeResult(staleToolIndex, staleToolExport));
    const staleDurableCorpus = buildRagCorpus(staleToolIndex);
    staleToolIndex.invalidateSource(staleToolSource);
    staleToolIndex.setFiles([makeFile('event/stale-tool.emevd.dcx', 'event', staleToolSource, 'stale-tool-v2')]);
    const staleToolResult = await registry.run(
      'retrieve_evidence',
      { query: 'stale-tool-old-value', limit: 5 },
      { workspaceIndex: staleToolIndex, mode: 'plan', rag: staleDurableCorpus }
    );
    if (!staleToolResult.ok) throw new Error(`stale retrieve_evidence tool failed: ${JSON.stringify(staleToolResult.error)}`);
    const staleToolHits = (staleToolResult.data as { hits?: Array<{ chunk: RagChunk }> } | undefined)?.hits ?? [];
    if (staleToolHits.some((hit) => hit.chunk.body.includes('stale-tool-old-value'))) {
      throw new Error(`retrieve_evidence returned old durable RAG content for a stale source: ${JSON.stringify(staleToolResult)}`);
    }

    // P0 mixed-version regression: a durable corpus can retain an old row and
    // a fresh partial-upsert row for the same physical source.  Source-level
    // exclusion would hide both; the host freshness mask must reject only the
    // old/missing-provenance chunk and preserve the fresh row.
    const mixedSource = 'file://synthetic/event/mixed-version.emevd.dcx';
    const mixedIndex = new WorkspaceIndex(index.workspaceId);
    mixedIndex.setFiles([makeFile('event/mixed-version.emevd.dcx', 'event', mixedSource, 'mixed-version-v1', 1)]);
    assertAccepted(ingestBridgeResult(mixedIndex, makeEventExport('mixed-version-v1', 'mixed-version-old-value', mixedSource, 1)));
    const mixedOldCorpus = buildRagCorpus(mixedIndex);
    mixedIndex.setFiles([makeFile('event/mixed-version.emevd.dcx', 'event', mixedSource, 'mixed-version-v2', 2)]);
    assertAccepted(ingestBridgeResult(mixedIndex, makeEventExport('mixed-version-v2', 'mixed-version-new-value', mixedSource, 2)));
    const mixedFreshChunk = buildRagCorpus(mixedIndex).chunks.find((chunk) => chunk.family === 'event');
    const mixedOldChunk = mixedOldCorpus.chunks.find((chunk) => chunk.family === 'event');
    if (!mixedFreshChunk || !mixedOldChunk) throw new Error('mixed-version fixture did not build event chunks');
    const mixedOldRow: RagChunk = {
      ...mixedOldChunk,
      // A partial-upsert row may carry a distinct locator while sharing the
      // physical source and symbol URI with the fresh native row.
      chunkId: `${mixedOldChunk.chunkId}:old-partial`,
      sourceHash: 'mixed-version-v1'
    };
    const mixedDurableCorpus = createRagCorpus({
      workspaceId: index.workspaceId,
      builtAt: mixedFreshChunk.sourceHash ?? new Date().toISOString(),
      chunks: [mixedOldRow, mixedFreshChunk]
    });
    const mixedStaleIds = mixedIndex.getRagStaleChunkIds(mixedDurableCorpus.chunks);
    if (!mixedStaleIds.includes(mixedOldRow.chunkId) || mixedStaleIds.includes(mixedFreshChunk.chunkId)) {
      throw new Error(`mixed-version mask classified the wrong rows: ${JSON.stringify({ mixedStaleIds, old: mixedOldRow, fresh: mixedFreshChunk })}`);
    }
    const cachedMixedMask = getRagStaleChunkMaskCached(mixedIndex, mixedDurableCorpus);
    const reusedMixedMask = getRagStaleChunkMaskCached(mixedIndex, mixedDurableCorpus);
    if (!cachedMixedMask || cachedMixedMask !== reusedMixedMask) {
      throw new Error('mixed-version freshness mask was not reused within one native epoch');
    }
    mixedIndex.setFiles([makeFile('event/mixed-version.emevd.dcx', 'event', mixedSource, 'mixed-version-v2', 2)]);
    const nextEpochMask = getRagStaleChunkMaskCached(mixedIndex, mixedDurableCorpus);
    if (!nextEpochMask || nextEpochMask === cachedMixedMask) {
      throw new Error('mixed-version freshness mask was reused across a native epoch change');
    }
    const mixedOldHit = retrieveEvidence(mixedDurableCorpus, 'mixed-version-old-value', {
      expandReferences: false,
      excludeChunkIds: mixedStaleIds
    });
    if (mixedOldHit.ok && mixedOldHit.hits.some((hit) => (
      hit.chunk.chunkId === mixedOldRow.chunkId || hit.chunk.body.includes('mixed-version-old-value')
    ))) {
      throw new Error(`direct RAG returned an excluded old mixed-version row: ${JSON.stringify(mixedOldHit)}`);
    }
    const mixedFreshHit = retrieveEvidence(mixedDurableCorpus, 'mixed-version-new-value', {
      expandReferences: false,
      excludeChunkIds: mixedStaleIds
    });
    if (!mixedFreshHit.ok || !mixedFreshHit.hits.some((hit) => hit.chunk.chunkId === mixedFreshChunk.chunkId)) {
      throw new Error(`direct RAG dropped the fresh mixed-version row: ${JSON.stringify(mixedFreshHit)}`);
    }
    const mixedToolResult = await registry.run(
      'retrieve_evidence',
      { query: 'mixed-version-new-value', limit: 5 },
      { workspaceIndex: mixedIndex, mode: 'plan', rag: mixedDurableCorpus }
    );
    if (!mixedToolResult.ok || !((mixedToolResult.data as { hits?: Array<{ chunk: RagChunk }> } | undefined)?.hits
      ?? []).some((hit) => hit.chunk.chunkId === mixedFreshChunk.chunkId)) {
      throw new Error(`tool RAG did not preserve the fresh mixed-version row: ${JSON.stringify(mixedToolResult)}`);
    }

    const tool = await registry.run(
      'retrieve_evidence',
      { query: 'synthetic_event_1000', limit: 5 },
      { workspaceIndex: index, mode: 'plan', rag: corpus }
    );
    if (!tool.ok) throw new Error(`retrieve_evidence tool failed: ${JSON.stringify(tool.error)}`);
    const toolHits = (tool.data as { hits?: Array<{ chunk: RagChunk }> } | undefined)?.hits ?? [];
    if (toolHits.length === 0) throw new Error('retrieve_evidence tool returned no hits');

    // --- 阶段3：loop 级 RAG 自动注入 ---
    const seenQueries: string[] = [];
    const injected: Array<{ role: string; content: string }> = [];
    const loopAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      async complete(request) {
        for (const message of request.messages) {
          if (message.content.includes('[rag-evidence')) {
            injected.push({ role: message.role, content: message.content });
          }
        }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', diagnostics: [] };
      },
      async *stream() { /* batch path only */ },
      listModels: async () => ({ ok: true, models: [] })
    };
    const loopConfig: ModelServiceConfig = {
      id: 'rag-loop-fixture',
      displayName: 'rag loop fixture',
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:3000',
      model: 'fixture',
      hasCredential: true,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z'
    };
    const hitRun = await runAgentToolLoop(loopAdapter, {
      config: loopConfig,
      apiKey: 'sk-rag-loop-fixture-key',
      messages: [{ role: 'user', content: 'flag 71000000 在哪个事件里使用' }],
      taskQuery: 'flag 71000000 在哪个事件里使用',
      tools: [],
      permissionMode: 'plan',
      executeTool: async () => ({ ok: true, content: '' }),
      ragSearch: {
        maxHits: 2,
        retrieve: async (query) => {
          seenQueries.push(query);
          return retrieveEvidence(corpus, query);
        }
      }
    });
    if (hitRun.finishReason !== 'stop') throw new Error(`rag loop run failed: ${hitRun.finishReason}`);
    const firstQuery = seenQueries[0];
    if (seenQueries.length === 0 || !firstQuery || !firstQuery.includes('71000000')) {
      throw new Error(`rag loop must query with the user message: ${JSON.stringify(seenQueries)}`);
    }
    const firstInjected = injected[0];
    if (injected.length !== 1 || !firstInjected || !firstInjected.content.includes('hits=')) {
      throw new Error(`rag loop must inject one [rag-evidence] message: ${JSON.stringify(injected)}`);
    }
    if (firstInjected.content.includes('hits=0')) {
      throw new Error(`rag loop must not inject empty hits: ${firstInjected.content}`);
    }
    // maxHits 生效：注入命中数 ≤ 2。
    const hitCount = Number(/hits=(\d+)/.exec(firstInjected.content)?.[1] ?? '99');
    if (hitCount > 2) throw new Error(`rag maxHits not honored: ${firstInjected.content}`);

    // 无命中 → 不注入。
    const missRun = await runAgentToolLoop(loopAdapter, {
      config: loopConfig,
      apiKey: 'sk-rag-loop-fixture-key',
      messages: [{ role: 'user', content: 'zzzxqwy 是什么' }],
      taskQuery: 'zzzxqwy 是什么',
      tools: [],
      permissionMode: 'plan',
      executeTool: async () => ({ ok: true, content: '' }),
      ragSearch: {
        retrieve: async (query) => retrieveEvidence(corpus, query)
      }
    });
    if (missRun.finishReason !== 'stop') throw new Error(`rag miss run failed: ${missRun.finishReason}`);

    // adversarial E2 regression: an internal continuation is appended as a
    // role=user message after a tool call, but retrieval must keep using the
    // host-captured external taskQuery.
    const retryQueries: string[] = [];
    const retryInjected: string[] = [];
    let retryCalls = 0;
    const retryAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      async complete(request) {
        retryCalls += 1;
        retryInjected.push(request.messages.filter((message) =>
          message.content.includes('[rag-evidence')
        ).map((message) => message.content).join('\n'));
        if (retryCalls === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'retry-tool', name: 'noop', argumentsJson: '{}' }]
            },
            finishReason: 'tool_use' as const,
            diagnostics: []
          };
        }
        if (retryCalls === 2) {
          return { message: { role: 'assistant', content: '' }, finishReason: 'stop' as const, diagnostics: [] };
        }
        return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' as const, diagnostics: [] };
      },
      async *stream() { /* batch path only */ },
      listModels: async () => ({ ok: true, models: [] })
    };
    const retryResult = await runAgentToolLoop(retryAdapter, {
      config: loopConfig,
      apiKey: 'sk-rag-loop-fixture-key',
      messages: [{ role: 'user', content: 'flag 71000000 在哪个事件里使用' }],
      taskQuery: 'flag 71000000 在哪个事件里使用',
      tools: [{ name: 'noop', description: 'test', parametersJsonSchema: { type: 'object' }, permissionLevel: 'read' }],
      permissionMode: 'plan',
      executeTool: async () => ({ ok: true, content: 'internal retry text' }),
      ragSearch: {
        retrieve: async (query) => {
          retryQueries.push(query);
          return retrieveEvidence(corpus, query);
        }
      }
    });
    if (retryResult.finishReason !== 'stop' || retryCalls !== 3 || retryQueries.length !== 1
      || retryInjected.filter((content) => content.length > 0).length !== 1
      || retryQueries.some((query) => query !== 'flag 71000000 在哪个事件里使用')) {
      throw new Error(`RAG evidence/query must be cached per context window: ${JSON.stringify({ retryCalls, retryQueries, retryInjected, finish: retryResult.finishReason })}`);
    }

    const fatChunks: RagChunk[] = [];
    for (let i = 0; i < 8_000; i += 1) {
      fatChunks.push({
        chunkId: `rag:param_row:fat-${i}`,
        workspaceId: index.workspaceId,
        sourceUri: `file://synthetic/param/fat.param`,
        symbolUri: `param://Fat/${i}`,
        family: 'param_row',
        title: `Fat ${i}`,
        body: `param Fat row ${i} filler-${i}`,
        numericIds: [i],
        contentHash: `fat-${i}`
      });
    }
    fatChunks.push({
      chunkId: 'rag:param_row:needle',
      workspaceId: index.workspaceId,
      sourceUri: 'file://synthetic/param/needle.param',
      symbolUri: 'param://Needle/999001',
      family: 'param_row',
      title: 'Needle 999001',
      body: 'param Needle row 999001',
      numericIds: [999001],
      contentHash: 'needle'
    });
    const fat = createRagCorpus({
      workspaceId: index.workspaceId,
      builtAt: new Date().toISOString(),
      chunks: fatChunks
    });
    const fatHit = retrieveEvidence(fat, '999001');
    if (!fatHit.ok || !fatHit.hits.some((hit) => hit.chunk.symbolUri === 'param://Needle/999001')) {
      throw new Error(`indexed retrieve missed the needle: ${JSON.stringify(fatHit)}`);
    }
    if (fatHit.stats.scanned > 8) {
      throw new Error(`indexed retrieve must not scan the whole corpus, scanned=${fatHit.stats.scanned}`);
    }

    console.log(JSON.stringify({
      ok: true,
      message: 'workspace RAG retrieve smoke: ok',
      chunks: corpus.stats,
      references: corpus.references.length,
      idHits: eventHit.hits.length,
      cjkHits: textHit.hits.length,
      reloaded: reloadedChunkCount,
      ragLoopInjected: injected.length,
      nonClaims: [
        'lexical + structured ID + one-hop graph, not embedding similarity',
        'synthetic fixture only; does not lift native-verified or Gate state'
      ]
    }, null, 2));
  });
}

async function registrySearchParamRowsForRagTest(index: WorkspaceIndex, rag: RagCorpus) {
  const registry = createDefaultToolRegistry();
  return registry.run(
    'search_param_rows',
    { query: '鬼刑部', paramNames: ['NpcParam'] },
    { workspaceIndex: index, mode: 'plan', rag }
  );
}

async function assertParamNameAliases(): Promise<void> {
  const index = new WorkspaceIndex('workspace-rag-param-alias');
  const sourceUri = 'file://synthetic/param/gameparam.parambnd.dcx';
  index.setFiles([makeFile('param/gameparam.parambnd.dcx', 'param', sourceUri)]);
  assertAccepted(ingestBridgeResult(index, {
    sourceUri,
    sourcePath: 'param/gameparam.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'parsed',
    diagnostics: [],
    data: {
      // Native export uses the type name while the BND4 child is the table
      // name the model receives from read-dcx-document.
      paramName: 'NPC_PARAM_ST',
      entryName: 'NpcParam.param',
      sourceHash: 'event-source-v1',
      sourceRevision: 1,
      rows: [{
        uri: `${sourceUri}#NpcParam/50800000`,
        sourceUri,
        paramName: 'NPC_PARAM_ST',
        entryName: 'NpcParam.param',
        rowId: 50800000,
        rowName: '鬼形部'
      }]
    }
  }));

  for (const requested of ['NpcParam', 'NpcParam.param', 'NPC_PARAM_ST']) {
    const hits = index.searchParamRows('鬼形部', 10, [requested]);
    if (hits.length !== 1 || hits[0]?.item.rowId !== 50800000) {
      throw new Error(`PARAM table alias ${requested} did not resolve the physical/native identity: ${JSON.stringify(hits)}`);
    }
  }

  // Exercise the same identity rule after the native path falls back to RAG.
  // This models a partially parsed index whose persisted semantic corpus still
  // has the row, and guards against a second silent zero-hit path.
  const fallbackIndex = new WorkspaceIndex(index.workspaceId);
  fallbackIndex.setFiles([makeFile('param/gameparam.parambnd.dcx', 'param', sourceUri)]);
  const fallback = await createDefaultToolRegistry().run(
    'search_param_rows',
    { query: '鬼形部', paramNames: ['NpcParam.param'] },
    { workspaceIndex: fallbackIndex, mode: 'plan', rag: buildRagCorpus(index) }
  );
  const fallbackData = fallback.data as { hits?: unknown[]; totalHits?: number } | undefined;
  if (!fallback.ok || !fallbackData || fallbackData.totalHits !== 1 || fallbackData.hits?.length !== 1) {
    throw new Error(`RAG PARAM table alias fallback failed: ${JSON.stringify(fallback)}`);
  }
}

async function assertParamTextLinks(): Promise<void> {
  const index = new WorkspaceIndex('workspace-rag-param-text-links');
  const paramSource = 'file://synthetic/param/gameparam.parambnd.dcx';
  const msgSource = 'file://synthetic/msg/zhocn/item.msgbnd.dcx';
  index.setFiles([
    makeFile('param/gameparam.parambnd.dcx', 'param', paramSource),
    makeFile('msg/zhocn/item.msgbnd.dcx', 'msg', msgSource)
  ]);
  assertAccepted(ingestBridgeResult(index, {
    sourceUri: paramSource,
    sourcePath: 'param/gameparam.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'parsed',
    diagnostics: [],
    data: {
       paramName: 'EQUIP_PARAM_GOODS_ST',
        rows: [{
          uri: `${paramSource}#EQUIP_PARAM_GOODS_ST/3504`,
          sourceUri: paramSource,
         paramName: 'EQUIP_PARAM_GOODS_ST',
         rowId: 3504,
        fields: [{ fieldId: 'maxNum', name: '最大持有数', value: 1 }]
      }]
    }
  }));
  assertAccepted(ingestBridgeResult(index, {
    sourceUri: msgSource,
    sourcePath: 'msg/zhocn/item.msgbnd.dcx',
    game: 'sekiro',
    resourceKind: 'msg',
    parseStatus: 'parsed',
    diagnostics: [],
    data: {
      category: 'item',
      entries: [{
        uri: `${msgSource}#item/3504`,
        sourceUri: msgSource,
        category: 'item',
        textId: 3504,
        text: '义父的铃铛'
      }, {
        uri: `${msgSource}#menu/3504`,
        sourceUri: msgSource,
        category: 'menu',
        textId: 3504,
        text: '无关菜单文本'
      }]
    }
  }));

  // An unscoped search may have equally strong hits in multiple physical
  // tables. Keep the same-table Goods row visible in the first bounded page
  // even when a ShopLineup row has the same display name.
  index.upsertParamExport({
    paramName: 'SHOP_LINEUP_PARAM',
    sourceUri: paramSource,
    entryName: 'ShopLineupParam.param',
    rows: [{
      uri: `${paramSource}#SHOP_LINEUP_PARAM/1301`,
      sourceUri: paramSource,
      paramName: 'SHOP_LINEUP_PARAM',
      entryName: 'ShopLineupParam.param',
      rowId: 1301,
      rowName: '义父的铃铛'
    }]
  });

  const nativeSearch = index.searchParamRows('义父的铃铛', 10, ['EquipParamGoods']);
  if (nativeSearch.length !== 1 || nativeSearch[0]?.item.rowId !== 3504) {
    throw new Error(`PARAM native search did not use the declared row-FMG association: ${JSON.stringify(nativeSearch)}`);
  }
  const unscopedSearch = index.searchParamRows('义父的铃铛', 2);
  if (!unscopedSearch.some((hit) => hit.item.paramName === 'EQUIP_PARAM_GOODS_ST' && hit.item.rowId === 3504)) {
    throw new Error(`unscoped PARAM search hid the physical Goods row: ${JSON.stringify(unscopedSearch)}`);
  }

  const corpus = buildRagCorpus(index);
  const ragSearch = retrieveEvidence(corpus, '击杀后掉落义父的铃铛', {
    limit: 8,
    expandReferences: true
  });
  const paramHit = ragSearch.ok
    ? ragSearch.hits.find((hit) => hit.chunk.family === 'param_row' && hit.chunk.symbolUri.endsWith('/3504'))
    : undefined;
  if (!ragSearch.ok || !paramHit || !paramHit.chunk.body.includes('义父的铃铛')) {
    throw new Error(`RAG did not project the row-FMG text association: ${JSON.stringify(ragSearch)}`);
  }

  index.rebuildReferences({ enableNumericFallback: false });
  const textEntryUri = `${msgSource}#item/3504`;
  if (!index.findReferences(textEntryUri, 'to').some((edge) => (
        edge.fromUri === `${paramSource}#EQUIP_PARAM_GOODS_ST/3504`
      && edge.toUri === textEntryUri
      && edge.kind === 'references_text'
  ))) {
    throw new Error('PARAM↔FMG row association was not published to the evidence graph.');
  }
}

function buildSyntheticIndex(): WorkspaceIndex {
  const index = new WorkspaceIndex('workspace-rag-smoke');
  index.setFiles([makeFile('event/common.emevd.dcx', 'event', 'file://synthetic/event/common.emevd.dcx')]);
  assertAccepted(ingestBridgeResult(index, makeEventExport()));
  assertAccepted(ingestBridgeResult(index, makeMapExport()));
  assertAccepted(ingestBridgeResult(index, makeMapExportM11()));
  assertAccepted(ingestBridgeResult(index, makeTaeExport()));
  assertAccepted(ingestBridgeResult(index, makeParamExport()));
  assertAccepted(ingestBridgeResult(index, makeMsgExport()));
  index.rebuildReferences({ enableNumericFallback: true });
  return index;
}

function fileOnlyIndex(workspaceId: string): WorkspaceIndex {
  const index = new WorkspaceIndex(workspaceId);
  index.setFiles([makeFile('event/common.emevd.dcx', 'event', 'file://synthetic/event/common.emevd.dcx')]);
  return index;
}

function assertAccepted(result: { accepted: boolean; diagnostics: Array<{ code: string }> }): void {
  if (!result.accepted) {
    throw new Error(`synthetic ingest rejected: ${result.diagnostics.map((item) => item.code).join(',')}`);
  }
}

function makeFile(
  relativePath: string,
  resourceKind: IndexedFile['resourceKind'],
  sourceUri: string,
  sha256 = 'event-source-v1',
  mtimeMs = 1
): IndexedFile {
  return {
    id: sourceUri,
    workspaceId: 'workspace-rag-smoke',
    sourceUri,
    sourcePath: relativePath,
    absolutePath: relativePath,
    relativePath,
    game: 'sekiro',
    resourceKind,
    extension: '.dcx',
    compoundExtension: '.emevd.dcx',
    formatKind: 'emevd',
    formatLabel: 'EMEVD',
    size: 32,
    mtimeMs,
    sha256,
    parseStatus: 'partial',
    diagnostics: []
  };
}

function withoutOuterFileHash(chunk: RagChunk): RagChunk {
  const copy = { ...chunk };
  delete copy.outerFileHash;
  return copy;
}

function withoutSourceRevision(chunk: RagChunk): RagChunk {
  const copy = { ...chunk };
  delete copy.sourceRevision;
  return copy;
}

function makeEventExport(
  sourceHash = 'event-source-v1',
  eventName = 'synthetic_event_1000',
  sourceUri = 'file://synthetic/event/common.emevd.dcx',
  sourceRevision = 1
): BridgeResult<unknown> {
  return {
    sourceUri,
    sourcePath: 'event/common.emevd.dcx',
    game: 'sekiro',
    resourceKind: 'event',
    parseStatus: 'partial',
    diagnostics: [],
    data: {
      mapId: 'm10_00_00_00',
      sourceHash,
      outerFileHash: sourceHash,
      sourceRevision,
      events: [{
        uri: 'event://m10_00_00_00/1000',
        sourceUri,
        mapId: 'm10_00_00_00',
        eventId: 1000,
        name: eventName,
        instructions: [{
          uri: 'event://m10_00_00_00/1000/instruction/0',
          index: 0,
          name: 'SetEventFlag',
          args: [{ name: 'flag', value: 71000000, role: 'flag', confidence: 'high' }]
        }, {
          uri: 'event://m10_00_00_00/1000/instruction/1',
          index: 1,
          name: 'IfCharacterInsideRegion',
          args: [{ name: 'entityId', value: 1100800, role: 'entityId', confidence: 'high' }]
        }]
      }]
    }
  };
}

function makeMapExport(
  sourceUri = 'file://synthetic/map/m10_00_00_00.msb',
  sourceHash?: string,
  sourceRevision?: number,
  name = 'synthetic_entity_1100800'
): BridgeResult<unknown> {
  return {
    sourceUri,
    sourcePath: 'map/m10_00_00_00.msb',
    game: 'sekiro',
    resourceKind: 'map',
    parseStatus: 'partial',
    diagnostics: [],
    data: {
      mapId: 'm10_00_00_00',
      ...(sourceHash !== undefined ? { sourceHash } : {}),
      ...(sourceRevision !== undefined ? { sourceRevision } : {}),
      entities: [{
        uri: 'map://m10_00_00_00/entity/1100800',
        sourceUri,
        mapId: 'm10_00_00_00',
        entityId: 1100800,
        name,
        ...(sourceHash !== undefined ? { sourceHash } : {}),
        ...(sourceRevision !== undefined ? { sourceRevision } : {}),
        kind: 'character'
      }],
      regions: [{
        uri: 'map://m10_00_00_00/region/boss_phase_2',
        sourceUri,
        mapId: 'm10_00_00_00',
        entityId: 1100900,
        name: 'boss_phase_2',
        ...(sourceHash !== undefined ? { sourceHash } : {}),
        ...(sourceRevision !== undefined ? { sourceRevision } : {}),
        shape: 'box'
      }]
    }
  };
}

/** 问题 6：完整地图块（m11_01_00_00）→ 默认 /part/ uri（不再 /entity/）。 */
function makeMapExportM11(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/map/m11_01_00_00/m11_01_00_00.msb.dcx',
    sourcePath: 'map/m11_01_00_00/m11_01_00_00.msb.dcx',
    game: 'sekiro',
    resourceKind: 'map',
    parseStatus: 'parsed',
    diagnostics: [],
    data: {
      mapId: 'm11_01_00_00',
      entities: [{
        sourceUri: 'file://synthetic/map/m11_01_00_00/m11_01_00_00.msb.dcx',
        name: 'c1050_0000',
        kind: 'character',
        model: 'c1050',
        modelIndex: 3,
        position: [12.5, 0, -3.2],
        rotation: [0, 90, 0],
        scale: [1, 1, 1]
      }],
      regions: [{
        sourceUri: 'file://synthetic/map/m11_01_00_00/m11_01_00_00.msb.dcx',
        name: 'boss_phase_2',
        shape: 'box'
      }]
    }
  };
}

/** 问题 6：TAE 信封（非截断）→ action://c1050/A0200/e0，SoundID 进 numericIds。 */
function makeTaeExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/anibnd/c1050.anibnd.dcx',
    sourcePath: 'chr/c1050.anibnd.dcx',
    game: 'sekiro',
    resourceKind: 'action',
    parseStatus: 'parsed',
    diagnostics: [],
    data: {
      format: 'TAE',
      version: '0x0001000D',
      sourceSize: 1234,
      sourceHash: 'tae-synthetic-hash',
      animationCount: 1,
      totalEventCount: 1,
      totalGroupCount: 0,
      animationsTruncated: false,
      eventTypes: [128],
      animations: [{
        animId: 200,
        eventCount: 1,
        groupCount: 0,
        timesCount: 1,
        hkxName: 'a000_020000',
        events: [{
          startTime: 14.6,
          endTime: 14.7,
          eventTypeId: 128,
          typeName: 'PlaySound_General',
          parameterDecoded: true,
          templateFields: [
            { name: 'SoundType', kind: 's32', value: 1 },
            { name: 'SoundID', kind: 's32', value: 105011001 }
          ]
        }],
        eventsTruncated: false
      }],
      roundTrip: { byteIdentical: true, semanticIdentical: true, sourceHash: 'h', animationCount: 1, totalEventCount: 1, totalGroupCount: 0 },
      diagnostics: [],
      authority: 'candidate'
    }
  };
}

function makeParamExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/param/SpEffectParam.param',
    sourcePath: 'param/SpEffectParam.param',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus: 'partial',
    diagnostics: [],
    data: {
      paramName: 'SpEffectParam',
      sourceHash: 'event-source-v1',
      sourceRevision: 1,
      rows: [{
        uri: 'param://SpEffectParam/2000',
        sourceUri: 'file://synthetic/param/SpEffectParam.param',
        paramName: 'SpEffectParam',
        rowId: 2000,
        rowName: 'synthetic_row_2000',
        fields: [{ name: 'value', type: 'int32', value: 1 }]
      }]
    }
  };
}

function makeMsgExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/msg/Goods.fmg',
    sourcePath: 'msg/Goods.fmg',
    game: 'sekiro',
    resourceKind: 'msg',
    parseStatus: 'partial',
    diagnostics: [],
    data: {
      category: 'Goods',
      sourceHash: 'event-source-v1',
      sourceRevision: 1,
      entries: [{
        uri: 'msg://Goods/1000',
        sourceUri: 'file://synthetic/msg/Goods.fmg',
        category: 'Goods',
        textId: 1000,
        text: '狼的义手',
        confidence: 'high'
      }]
    }
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
