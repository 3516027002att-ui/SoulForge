import { join } from 'node:path';
import type { BridgeResult, IndexedFile, RagChunk } from '@soulforge/shared';
import { ingestBridgeResult } from '../indexing/ingestBridgeResult.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import type { ModelServiceAdapter, ModelServiceConfig } from '../model-services/types.js';
import { buildRagCorpus, createRagCorpus, mergeCatalogAndPersisted } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { loadRagCorpus, persistRagCorpus } from '../rag/persist.js';
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

    const leaked = findPathLeak(corpus, workspace.root) ?? findPathLeak(eventHit, 'D:\\') ?? findPathLeak(eventHit, 'C:\\');
    if (leaked) throw new Error(`RAG payload leaked a filesystem path at ${leaked}`);

    const dbPath = join(workspace.root, 'workspace.db');
    const database = openWorkspaceDatabase(dbPath);
    const now = new Date().toISOString();
    database.prepare(`
INSERT INTO workspaces (workspace_id, root_path, game, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)`).run(index.workspaceId, workspace.root, 'sekiro', now, now);
    const repository = new WorkspaceDataRepository(database, index.workspaceId);
    persistRagCorpus(repository, corpus);
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
    if (reloaded.chunks.length !== corpus.chunks.length) {
      throw new Error(`reload lost chunks: ${reloaded.chunks.length} != ${corpus.chunks.length}`);
    }
    const reloadedHit = retrieveEvidence(reloaded, '71000000');
    if (!reloadedHit.ok) throw new Error(`reloaded retrieve failed: ${reloadedHit.message}`);

    const catalogOnly = buildRagCorpus(fileOnlyIndex(index.workspaceId));
    const merged = mergeCatalogAndPersisted(catalogOnly, reloaded);
    if (!merged.chunks.some((chunk) => chunk.family === 'event')) {
      throw new Error('scan merge dropped previously analyzed event chunks');
    }
    database.close();

    const registry = createDefaultToolRegistry();
    const missing = await registry.run('retrieve_evidence', { query: 'x' }, { workspaceIndex: null, mode: 'plan' });
    if (missing.ok || missing.error?.code !== 'WORKSPACE_REQUIRED') {
      throw new Error(`retrieve_evidence must require a workspace, got ${JSON.stringify(missing)}`);
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
          if (message.role === 'system' && message.content.startsWith('[rag-evidence')) {
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
      tools: [],
      permissionMode: 'plan',
      executeTool: async () => ({ ok: true, content: '' }),
      ragSearch: {
        retrieve: async (query) => retrieveEvidence(corpus, query)
      }
    });
    if (missRun.finishReason !== 'stop') throw new Error(`rag miss run failed: ${missRun.finishReason}`);

    console.log(JSON.stringify({
      ok: true,
      message: 'workspace RAG retrieve smoke: ok',
      chunks: corpus.stats,
      references: corpus.references.length,
      idHits: eventHit.hits.length,
      cjkHits: textHit.hits.length,
      reloaded: reloaded.chunks.length,
      ragLoopInjected: injected.length,
      nonClaims: [
        'lexical + structured ID + one-hop graph, not embedding similarity',
        'synthetic fixture only; does not lift native-verified or Gate state'
      ]
    }, null, 2));
  });
}

function buildSyntheticIndex(): WorkspaceIndex {
  const index = new WorkspaceIndex('workspace-rag-smoke');
  index.setFiles([makeFile('event/common.emevd.dcx', 'event', 'file://synthetic/event/common.emevd.dcx')]);
  assertAccepted(ingestBridgeResult(index, makeEventExport()));
  assertAccepted(ingestBridgeResult(index, makeMapExport()));
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

function makeFile(relativePath: string, resourceKind: IndexedFile['resourceKind'], sourceUri: string): IndexedFile {
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
    mtimeMs: 1,
    parseStatus: 'partial',
    diagnostics: []
  };
}

function makeEventExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/event/common.emevd.dcx',
    sourcePath: 'event/common.emevd.dcx',
    game: 'sekiro',
    resourceKind: 'event',
    parseStatus: 'partial',
    diagnostics: [],
    data: {
      mapId: 'm10_00_00_00',
      events: [{
        uri: 'event://m10_00_00_00/1000',
        sourceUri: 'file://synthetic/event/common.emevd.dcx',
        mapId: 'm10_00_00_00',
        eventId: 1000,
        name: 'synthetic_event_1000',
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

function makeMapExport(): BridgeResult<unknown> {
  return {
    sourceUri: 'file://synthetic/map/m10_00_00_00.msb',
    sourcePath: 'map/m10_00_00_00.msb',
    game: 'sekiro',
    resourceKind: 'map',
    parseStatus: 'partial',
    diagnostics: [],
    data: {
      mapId: 'm10_00_00_00',
      entities: [{
        uri: 'map://m10_00_00_00/entity/1100800',
        sourceUri: 'file://synthetic/map/m10_00_00_00.msb',
        mapId: 'm10_00_00_00',
        entityId: 1100800,
        name: 'synthetic_entity_1100800',
        kind: 'character'
      }],
      regions: [{
        uri: 'map://m10_00_00_00/region/boss_phase_2',
        sourceUri: 'file://synthetic/map/m10_00_00_00.msb',
        mapId: 'm10_00_00_00',
        entityId: 1100900,
        name: 'boss_phase_2',
        shape: 'box'
      }]
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
