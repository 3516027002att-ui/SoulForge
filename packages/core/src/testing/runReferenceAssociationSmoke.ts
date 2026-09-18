import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { createRagCorpus } from '../rag/chunkBuilder.js';
import { createNativeSnapshotCache } from '../runtime/nativeSnapshotCache.js';
import { ResourceVersionClock } from '../runtime/resourceVersion.js';
import { NativeReadProofStore } from '../editing/nativeReadProofStore.js';
import { createReferenceQueryService } from '../references/referenceQueryService.js';
import { createWorkspaceReferenceRuntime } from '../references/workspaceReferenceRuntime.js';
import { openSqliteKnowledgeStore } from '../knowledge/sqliteKnowledgeStore.js';
import { makeSourceRef } from '../knowledge/knowledgeStore.js';
import type { KnowledgeClaim } from '../knowledge/knowledgeTypes.js';

const workspaceId = 'file:///smoke/reference-workspace';
const paramSource = 'file://param/gameparam/gameparam.parambnd.dcx';
const msgSource = 'file://msg/zhocn/item.msgbnd.dcx';
const outerHash = createHash('sha256').update('reference-smoke').digest('hex');
const revision = 1234;

export async function runReferenceAssociationSmoke(): Promise<void> {
  const index = new WorkspaceIndex(workspaceId);
  index.setFiles([
    file(paramSource, 'param', 'param/gameparam/gameparam.parambnd.dcx'),
    file(msgSource, 'msg', 'msg/zhocn/item.msgbnd.dcx')
  ]);
  index.upsertParamExport({
    sourceUri: paramSource,
    outerFileHash: outerHash,
    sourceRevision: revision,
    paramName: 'EQUIP_PARAM_GOODS_ST',
    entryName: 'EquipParamGoods.param',
    entryIndex: 1,
    rows: [{
      uri: 'param://EQUIP_PARAM_GOODS_ST/60',
      sourceUri: paramSource,
      paramName: 'EQUIP_PARAM_GOODS_ST',
      entryName: 'EquipParamGoods.param',
      entryIndex: 1,
      rowId: 60,
      rowName: 'smoke item',
      sourceHash: outerHash,
      outerFileHash: outerHash,
      sourceRevision: revision,
      fields: [{ fieldId: 'nameId', name: 'nameId', type: 'int', description: 'item text id', value: 60 }]
    }]
  });
  index.upsertMsgExport({
    outerFileHash: outerHash,
    sourceRevision: revision,
    category: 'zhocn/item/アイテム名',
    entries: [{
      uri: 'msg://zhocn/item/アイテム名/60',
      sourceUri: msgSource,
      category: 'zhocn/item/アイテム名',
      textId: 60,
      text: 'smoke item',
      confidence: 'high',
      outerFileHash: outerHash,
      sourceRevision: revision
    }]
  });
  index.rebuildReferences();

  const runtime = createWorkspaceReferenceRuntime({ workspaceIndex: index, workspaceId });
  const service = createReferenceQueryService({
    principal: 'smoke',
    workspaceId,
    workspaceSession: {} as never,
    editSession: {} as never,
    workspaceIndex: index,
    snapshotCache: createNativeSnapshotCache(),
    versionClock: new ResourceVersionClock(),
    nativeReadProofs: new NativeReadProofStore(),
    ...runtime
  });
  const page = await service.query({
    uri: 'msg://zhocn/item/アイテム名/60',
    direction: 'to',
    detail: 'context',
    depth: 3,
    limit: 8,
    includeHypotheses: false
  });
  assert.equal(page.resolution, 'resolved');
  assert.equal(page.relations.length, 1);
  assert.equal(page.relations[0]?.certainty, 'confirmed');
  assert.equal(page.relations[0]?.to.textId, 60);
  assert.equal(page.coverage.allowsNegativeClaim, false);

  const matching = createRagCorpus({
    workspaceId,
    builtAt: new Date().toISOString(),
    chunks: [{
      chunkId: 'rag:file:current', workspaceId, sourceUri: paramSource, symbolUri: paramSource,
      family: 'file', title: 'current', body: 'current', numericIds: [], contentHash: 'body',
      sourceRevision: revision, outerFileHash: outerHash, relativePath: 'param/gameparam/gameparam.parambnd.dcx', resourceKind: 'param'
    }]
  });
  assert.deepEqual(index.getRagStaleChunkIds(matching.chunks), []);
  const stale = createRagCorpus({
    workspaceId,
    builtAt: matching.builtAt,
    chunks: matching.chunks.map((chunk) => ({ ...chunk, sourceRevision: revision + 1 }))
  });
  assert.deepEqual(index.getRagStaleChunkIds(stale.chunks), ['rag:file:current']);

  const temp = await mkdtemp(join(tmpdir(), 'soulforge-knowledge-smoke-'));
  const databasePath = join(temp, 'workspace.db');
  const scope = { gameProfile: 'sekiro', version: '1.6.x', visibility: 'project' as const, workspaceId, namespace: 'smoke' };
  const claim: KnowledgeClaim = {
    claimId: 'claim-smoke', semanticKey: 'smoke:claim', pageId: 'page-smoke', subjectKey: 'smoke',
    predicateKey: 'works', value: true, scope, kind: 'tested_procedure', publicationState: 'accepted',
    evidenceStrength: 'executed_test', sourceRefs: [makeSourceRef('smoke', 'smoke')], dependencies: [], readerSchemaHash: 'schema',
    createdFrom: 'smoke', contentHash: 'hash'
  };
  const first = openSqliteKnowledgeStore({ databasePath, workspaceId, rootPath: temp, game: 'sekiro' });
  const generation = first.getCurrent();
  const committed = first.commitPatch({
    expectedGeneration: generation.generationId,
    sourceRevisions: [],
    pages: [{ pageId: 'page-smoke', path: 'wiki/smoke.md', body: 'smoke', expectedRevision: null, scope, claims: [claim] }],
    claims: [claim]
  });
  assert.equal(committed.ok, true);
  first.close();
  const reopened = openSqliteKnowledgeStore({ databasePath, workspaceId, rootPath: temp, game: 'sekiro' });
  assert.ok(reopened.getCurrent().claims['claim-smoke']);
  reopened.close();
  await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, suite: 'reference-association', cases: 8, checks: ['direction', 'coverage', 'rag-freshness', 'knowledge-restart'] }));
}

function file(sourceUri: string, resourceKind: 'param' | 'msg', relativePath: string) {
  return {
    id: `${workspaceId}:${relativePath}`,
    workspaceId,
    sourceUri,
    sourcePath: relativePath,
    absolutePath: relativePath,
    relativePath,
    game: 'sekiro',
    resourceKind,
    extension: '.dcx',
    compoundExtension: resourceKind === 'param' ? '.parambnd.dcx' : '.msgbnd.dcx',
    formatKind: (resourceKind === 'param' ? 'parambnd' : 'msgbnd') as any,
    formatLabel: resourceKind,
    size: 1,
    mtimeMs: revision,
    sha256: outerHash,
    parseStatus: 'parsed' as const,
    diagnostics: []
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runReferenceAssociationSmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
