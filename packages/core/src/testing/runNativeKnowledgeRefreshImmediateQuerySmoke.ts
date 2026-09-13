/**
 * Real Sekiro regression for native write -> Patch Engine -> knowledge refresh
 * -> immediate RAG query.  The source files are copied into a temporary
 * opened overlay; no installed game or user Mod bytes are changed.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { IndexedFile, ParamDefDocument, ParamRowSymbol, RagChunkFamily } from '@soulforge/shared';
import { pathToFileURL } from 'node:url';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decodeRowFields, encodeFieldMutation } from '../param/paramdefLayout.js';
import { importPinnedSmithboxSdtParamMetadata } from '../param/smithboxParamMetadataSource.js';
import { buildRagCorpus } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { refreshKnowledgeAfterCommit } from '../indexing/knowledgeRefresh.js';
import { refreshNativeSemanticSources } from '../indexing/nativeSemanticRefresh.js';
import { analyzeWorkspace } from '../pipeline/workspacePipeline.js';
import { scanWorkspace } from '../workspace/scanWorkspace.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { saveRawReplace } from '../editing/saveRawResource.js';

interface EventEnvelope {
  sourceHash: string;
  events: Array<{ id: number; restBehavior: number }>;
}

interface MapEnvelope {
  sourceHash: string;
  parts: Array<{ name: string; offset: number; posX: number; posY: number; posZ: number }>;
}

interface ParamEnvelope {
  sourceHash: string;
  typeName: string;
  dataVersion?: number;
  rowDataSize: number;
  rows: Array<{ id: number; dataBase64: string; dataHash: string }>;
}

interface FmgEnvelope {
  sourceHash: string;
  entries: Array<{ id: number; text: string }>;
}

interface BndEnvelope {
  nested?: {
    entries?: Array<{ index?: number; name?: string; contentHash?: string }>;
  };
}

interface NativeTestState {
  root: string;
  overlay: string;
  staging: string;
  gameRoot: string;
  index: WorkspaceIndex;
  session: Awaited<ReturnType<typeof openWorkspaceSession>>;
  operationLog: MemoryOperationLogStore;
  files: Map<string, IndexedFile>;
}

const GAME_ROOT = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
  || process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
  || '';
const BRIDGE_EXECUTABLE_OVERRIDE = process.env.SOULFORGE_NATIVE_BRIDGE_EXECUTABLE?.trim() || undefined;

function runNativeBridge<T = unknown>(options: Parameters<typeof runBridge>[0]) {
  return runBridge<T>({
    ...options,
    ...(BRIDGE_EXECUTABLE_OVERRIDE ? { bridgeExecutablePath: BRIDGE_EXECUTABLE_OVERRIDE } : {})
  });
}

async function main(): Promise<void> {
  if (!GAME_ROOT) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      authority: 'unverified',
      reason: 'SOULFORGE_SEKIRO_GAME_ROOT 未设置；真实 native refresh smoke fail-closed 跳过。'
    }, null, 2));
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-knowledge-refresh-'));
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  const game = GAME_ROOT.replaceAll('\\', '/');
  await mkdir(overlay, { recursive: true });
  await mkdir(staging, { recursive: true });

  try {
    await copyGameSource(game, overlay, 'event/common.emevd.dcx');
    await copyGameSource(game, overlay, 'map/mapstudio/m10_00_00_00.msb.dcx');
    await copyGameSource(game, overlay, 'param/gameparam/gameparam.parambnd.dcx');
    await copyGameSource(game, overlay, 'msg/engus/item.msgbnd.dcx');

    const scan = await scanWorkspace({ workspaceRoot: overlay, game: 'sekiro' });
    const index = new WorkspaceIndex(scan.workspaceId);
    index.setFiles(scan.files);
    const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
    const state: NativeTestState = {
      root,
      overlay,
      staging,
      gameRoot: game,
      index,
      session,
      operationLog: new MemoryOperationLogStore(),
      files: new Map(scan.files.map((file) => [file.sourceUri, file]))
    };

    // Seed the empty index through the same production Bridge semantic export
    // used by ordinary analyze/search flows before exercising the native
    // refresh path.  The refresh must replace these PARAM projections by the
    // physical child identity, not append a second copy under another name.
    const paramFile = findFile(state, 'param', 'gameparam.parambnd.dcx');
    const paramAnalyzeReceipt = await seedParamProjectionFromProductionExport(state, paramFile);

    const initial = await refreshNativeSemanticSources({
      index,
      sourceFiles: scan.files,
      stagingRoot: staging,
      allowedRoots: [overlay],
      oodleRuntimeRoot: game,
      timeoutMs: 180_000
    });
    if (initial.failedSources.length > 0) {
      throw new Error(`initial native semantic refresh failed: ${JSON.stringify(initial.diagnostics)}`);
    }
    const paramRefreshReceipt = assertParamRefreshIdentity(state.index, paramAnalyzeReceipt);

    const eventResult = await mutateEvent(state);
    state.index = await refreshAfterCommit(state, eventResult.sourceUri);
    assertOnlyNew(state.index, 'event', eventResult);

    const mapResult = await mutateMap(state);
    state.index = await refreshAfterCommit(state, mapResult.sourceUri);
    assertOnlyNew(state.index, 'map_entity', mapResult);

    const paramResult = await mutateParam(state);
    state.index = await refreshAfterCommit(state, paramResult.sourceUri);
    assertOnlyNew(state.index, 'param_row', paramResult);

    const fmgResult = await mutateFmg(state);
    state.index = await refreshAfterCommit(state, fmgResult.sourceUri);
    assertOnlyNew(state.index, 'text_entry', fmgResult);

    console.log(JSON.stringify({
      ok: true,
      status: 'verified',
      authority: 'native-verified',
      sources: ['EMEVD', 'MSB', 'PARAM', 'FMG'],
      immediateQueries: 4,
      paramAnalyzeReceipt: paramRefreshReceipt,
      note: '真实 native writer 暂存产物经 Patch Engine 写入临时 overlay；每次提交后立即 refresh + retrieve_evidence。'
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

interface ParamAnalyzeReceipt {
  sourceUri: string;
  physicalEntries: Array<{ index: number; name: string }>;
  seededExportCount: number;
  seededRowCount: number;
  seededIdentities: string[];
  seededRag: ParamRagSnapshot;
}

interface ParamRagSnapshot {
  chunkCount: number;
  rowCount: number;
  uniquePhysicalRowKeyCount: number;
  duplicatePhysicalRowKeyCount: number;
  duplicateRowIdGroupCount: number;
  duplicateRowIdExtraCount: number;
  missingRowIndexCount: number;
  uniqueChunkIdCount: number;
  chunkIds: Set<string>;
  chunkIdsByPhysicalRowKey: Map<string, string[]>;
}

interface ParamRagComparison {
  beforeChunkCount: number;
  afterChunkCount: number;
  beforeRowCount: number;
  afterRowCount: number;
  beforeUniquePhysicalRowKeyCount: number;
  afterUniquePhysicalRowKeyCount: number;
  physicalKeyIntersectionCount: number;
  physicalKeyOnlyBeforeCount: number;
  physicalKeyOnlyAfterCount: number;
  mismatchCount: number;
  beforeUniqueChunkIdCount: number;
  afterUniqueChunkIdCount: number;
  chunkIdIntersectionCount: number;
  chunkIdOnlyBeforeCount: number;
  chunkIdOnlyAfterCount: number;
  beforeDuplicatePhysicalRowKeyCount: number;
  afterDuplicatePhysicalRowKeyCount: number;
  beforeDuplicateRowIdGroupCount: number;
  afterDuplicateRowIdGroupCount: number;
  beforeDuplicateRowIdExtraCount: number;
  afterDuplicateRowIdExtraCount: number;
  beforeMissingRowIndexCount: number;
  afterMissingRowIndexCount: number;
  onlyBeforeSample: string[];
  onlyAfterSample: string[];
  chunkIdOnlyBeforeSample: string[];
  chunkIdOnlyAfterSample: string[];
  mismatchSample: Array<{
    physicalRowKey: string;
    before: string[];
    after: string[];
  }>;
}

interface ParamRefreshReceipt {
  sourceUri: string;
  physicalEntryCount: number;
  before: {
    exportCount: number;
    rowCount: number;
    physicalIdentityCount: number;
  };
  after: {
    exportCount: number;
    rowCount: number;
    physicalIdentityCount: number;
  };
  physicalIdentitiesMatch: true;
  ragComparison: ParamRagComparison;
}

async function seedParamProjectionFromProductionExport(
  state: NativeTestState,
  file: IndexedFile
): Promise<ParamAnalyzeReceipt> {
  const container = await bridgeRead<BndEnvelope>({
    command: 'read-dcx-document',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay],
    oodleRuntimeRoot: state.gameRoot
  });
  const physicalEntries = (container.nested?.entries ?? []).flatMap((entry) => (
    Number.isSafeInteger(entry.index)
      && typeof entry.name === 'string'
      && entry.name.toLowerCase().endsWith('.param')
      ? [{ index: entry.index as number, name: entry.name }]
      : []
  ));
  if (physicalEntries.length === 0) throw new Error('真实 PARAM BND4 没有可验证的 .param 物理子项。');

  // Use the same production analyze path as ordinary workspace analysis.  It
  // canonicalizes the Bridge envelope recursively, including nested row
  // sourceUri values, before ingesting the first PARAM projection.
  const analyzed = await analyzeWorkspace({
    workspaceRoot: state.overlay,
    files: [file],
    inspectNativeResources: false,
    parseTextResources: false,
    parseJsonFixtures: false,
    bridgeTimeoutMs: 180_000,
    oodleRuntimeRoot: state.gameRoot,
    ...(BRIDGE_EXECUTABLE_OVERRIDE ? { bridgeExecutablePath: BRIDGE_EXECUTABLE_OVERRIDE } : {})
  });
  const analyzedProjections = paramExportsFor(analyzed.index, file.sourceUri);
  if (analyzed.parsedFiles !== 1 || analyzedProjections.length === 0) {
    throw new Error(`production PARAM analyze was not accepted: ${JSON.stringify({
      parsedFiles: analyzed.parsedFiles,
      projections: analyzedProjections.length,
      diagnostics: analyzed.diagnostics
    })}`);
  }
  for (const projection of analyzedProjections) {
    if (!state.index.upsertParamExport(projection)) {
      throw new Error(`production PARAM projection was rejected by the test index: ${projection.entryName ?? projection.paramName}`);
    }
  }

  const projections = paramExportsFor(state.index, file.sourceUri);
  const seededIdentities = projectionIdentities(projections);
  assertPhysicalParamIdentities(projections, physicalEntries, 'production export');
  if (seededIdentities.length === 0 || seededIdentities.length !== new Set(seededIdentities).size) {
    const indexedParams = state.index.toSymbolBundle().params ?? [];
    throw new Error(`production PARAM export has missing/duplicate physical identities: ${JSON.stringify({
      analysis: {
        parsedFiles: analyzed.parsedFiles,
        diagnostics: analyzed.diagnostics.map((diagnostic) => diagnostic.code).slice(0, 16)
      },
      indexed: {
        sourceCount: indexedParams.length,
        sourceUris: [...new Set(indexedParams.map((item) => item.sourceUri))].slice(0, 8),
        matchingSourceCount: projections.length
      }
    })}`);
  }
  return {
    sourceUri: file.sourceUri,
    physicalEntries,
    seededExportCount: projections.length,
    seededRowCount: projections.reduce((count, item) => count + item.rows.length, 0),
    seededIdentities,
    seededRag: captureParamRagSnapshot(state.index, file.sourceUri)
  };
}

function assertParamRefreshIdentity(index: WorkspaceIndex, receipt: ParamAnalyzeReceipt): ParamRefreshReceipt {
  const projections = paramExportsFor(index, receipt.sourceUri);
  const identities = projectionIdentities(projections);
  if (projections.length !== receipt.seededExportCount) {
    throw new Error(`PARAM export count changed during native refresh: ${receipt.seededExportCount} -> ${projections.length}`);
  }
  const rowCount = projections.reduce((count, item) => count + item.rows.length, 0);
  if (rowCount !== receipt.seededRowCount) {
    throw new Error(`PARAM row count changed during native refresh: ${receipt.seededRowCount} -> ${rowCount}`);
  }
  if (JSON.stringify([...identities].sort()) !== JSON.stringify([...receipt.seededIdentities].sort())) {
    throw new Error(`PARAM physical identities changed during native refresh: ${JSON.stringify({ before: receipt.seededIdentities, after: identities })}`);
  }
  assertPhysicalParamIdentities(projections, receipt.physicalEntries, 'native refresh');

  const refreshedRag = captureParamRagSnapshot(index, receipt.sourceUri);
  const ragComparison = compareParamRagSnapshots(receipt.seededRag, refreshedRag);
  if (
    ragComparison.beforeChunkCount !== ragComparison.afterChunkCount
    || ragComparison.beforeUniqueChunkIdCount !== ragComparison.beforeRowCount
    || ragComparison.afterUniqueChunkIdCount !== ragComparison.afterRowCount
    || ragComparison.beforeUniquePhysicalRowKeyCount !== ragComparison.beforeRowCount
    || ragComparison.afterUniquePhysicalRowKeyCount !== ragComparison.afterRowCount
    || ragComparison.beforeMissingRowIndexCount !== 0
    || ragComparison.afterMissingRowIndexCount !== 0
    || ragComparison.beforeDuplicatePhysicalRowKeyCount !== 0
    || ragComparison.afterDuplicatePhysicalRowKeyCount !== 0
    || ragComparison.physicalKeyOnlyBeforeCount !== 0
    || ragComparison.physicalKeyOnlyAfterCount !== 0
    || ragComparison.chunkIdOnlyBeforeCount !== 0
    || ragComparison.chunkIdOnlyAfterCount !== 0
    || ragComparison.mismatchCount !== 0
  ) {
    throw new Error(`PARAM RAG physical row chunk identity did not converge: ${JSON.stringify(ragComparison)}`);
  }

  // Native refresh must enrich the production projection with typed fields;
  // an identity-only replacement with empty field arrays is not convergence.
  const actionGuide = projections.find((item) => item.entryIndex === 1
    && item.entryName?.toLowerCase().endsWith('actionguideparam.param'));
  if (!actionGuide || actionGuide.rows.length === 0
    || actionGuide.rows.some((row) => !Array.isArray(row.fields) || row.fields.length === 0)) {
    throw new Error('ActionGuideParam native refresh did not retain complete typed fields.');
  }
  return {
    sourceUri: receipt.sourceUri,
    physicalEntryCount: receipt.physicalEntries.length,
    before: {
      exportCount: receipt.seededExportCount,
      rowCount: receipt.seededRowCount,
      physicalIdentityCount: receipt.seededIdentities.length
    },
    after: {
      exportCount: projections.length,
      rowCount,
      physicalIdentityCount: identities.length
    },
    physicalIdentitiesMatch: true,
    ragComparison
  };
}

function paramExportsFor(index: WorkspaceIndex, sourceUri: string) {
  return (index.toSymbolBundle().params ?? []).filter((item) => item.sourceUri === sourceUri);
}

function projectionIdentities(projections: ReturnType<typeof paramExportsFor>): string[] {
  return projections.map((item) => `${item.entryIndex ?? ''}\u0000${item.entryName ?? ''}`);
}

function captureParamRagSnapshot(index: WorkspaceIndex, sourceUri: string): ParamRagSnapshot {
  const corpus = buildRagCorpus(index);
  const chunks = corpus.chunks.filter((chunk) => (
    chunk.family === 'param_row' && chunk.sourceUri === sourceUri
  ));
  const rows = (index.toSymbolBundle().params ?? [])
    .filter((item) => item.sourceUri === sourceUri)
    .flatMap((item) => item.rows);
  if (chunks.length !== rows.length) {
    throw new Error(`PARAM RAG chunk/row count mismatch: ${chunks.length}/${rows.length}`);
  }

  const chunkIdsByPhysicalRowKey = new Map<string, string[]>();
  const rowIdGroups = new Map<string, number>();
  rows.forEach((row, rowIndex) => {
    if (row.sourceUri !== sourceUri) {
      throw new Error(`PARAM RAG row sourceUri was not canonicalized: ${JSON.stringify({
        expected: sourceUri,
        actual: row.sourceUri,
        rowIndex
      })}`);
    }
    const chunk = chunks[rowIndex];
    if (!chunk || chunk.symbolUri !== row.uri) {
      throw new Error(`PARAM RAG chunk/row order mismatch at row ${rowIndex}: ${JSON.stringify({
        rowUri: row.uri,
        chunkId: chunk?.chunkId,
        chunkUri: chunk?.symbolUri
      })}`);
    }
    const physicalRowKey = paramPhysicalRowKey(row, sourceUri);
    const chunkIds = chunkIdsByPhysicalRowKey.get(physicalRowKey) ?? [];
    chunkIds.push(chunk.chunkId);
    chunkIdsByPhysicalRowKey.set(physicalRowKey, chunkIds);

    const rowIdGroup = JSON.stringify([
      sourceUri,
      row.entryName ?? null,
      row.entryIndex ?? null,
      row.rowId
    ]);
    rowIdGroups.set(rowIdGroup, (rowIdGroups.get(rowIdGroup) ?? 0) + 1);
  });

  const duplicateRowIdGroups = [...rowIdGroups.values()].filter((count) => count > 1);
  const chunkIds = new Set(chunks.map((chunk) => chunk.chunkId));
  return {
    chunkCount: chunks.length,
    rowCount: rows.length,
    uniquePhysicalRowKeyCount: chunkIdsByPhysicalRowKey.size,
    duplicatePhysicalRowKeyCount: [...chunkIdsByPhysicalRowKey.values()]
      .filter((chunkIds) => chunkIds.length > 1).length,
    duplicateRowIdGroupCount: duplicateRowIdGroups.length,
    duplicateRowIdExtraCount: duplicateRowIdGroups.reduce((count, size) => count + size - 1, 0),
    missingRowIndexCount: rows.filter((row) => paramRowIndex(row) === null).length,
    uniqueChunkIdCount: chunkIds.size,
    chunkIds,
    chunkIdsByPhysicalRowKey
  };
}

function compareParamRagSnapshots(
  before: ParamRagSnapshot,
  after: ParamRagSnapshot
): ParamRagComparison {
  const beforeKeys = new Set(before.chunkIdsByPhysicalRowKey.keys());
  const afterKeys = new Set(after.chunkIdsByPhysicalRowKey.keys());
  const intersection = [...beforeKeys].filter((key) => afterKeys.has(key));
  const onlyBefore = [...beforeKeys].filter((key) => !afterKeys.has(key));
  const onlyAfter = [...afterKeys].filter((key) => !beforeKeys.has(key));
  const mismatches = intersection.filter((key) => (
    JSON.stringify(before.chunkIdsByPhysicalRowKey.get(key))
      !== JSON.stringify(after.chunkIdsByPhysicalRowKey.get(key))
  ));
  const beforeChunkIds = before.chunkIds;
  const afterChunkIds = after.chunkIds;
  const chunkIdIntersection = [...beforeChunkIds].filter((chunkId) => afterChunkIds.has(chunkId));
  const chunkIdOnlyBefore = [...beforeChunkIds].filter((chunkId) => !afterChunkIds.has(chunkId));
  const chunkIdOnlyAfter = [...afterChunkIds].filter((chunkId) => !beforeChunkIds.has(chunkId));
  return {
    beforeChunkCount: before.chunkCount,
    afterChunkCount: after.chunkCount,
    beforeRowCount: before.rowCount,
    afterRowCount: after.rowCount,
    beforeUniquePhysicalRowKeyCount: before.uniquePhysicalRowKeyCount,
    afterUniquePhysicalRowKeyCount: after.uniquePhysicalRowKeyCount,
    physicalKeyIntersectionCount: intersection.length,
    physicalKeyOnlyBeforeCount: onlyBefore.length,
    physicalKeyOnlyAfterCount: onlyAfter.length,
    mismatchCount: mismatches.length,
    beforeUniqueChunkIdCount: before.uniqueChunkIdCount,
    afterUniqueChunkIdCount: after.uniqueChunkIdCount,
    chunkIdIntersectionCount: chunkIdIntersection.length,
    chunkIdOnlyBeforeCount: chunkIdOnlyBefore.length,
    chunkIdOnlyAfterCount: chunkIdOnlyAfter.length,
    beforeDuplicatePhysicalRowKeyCount: before.duplicatePhysicalRowKeyCount,
    afterDuplicatePhysicalRowKeyCount: after.duplicatePhysicalRowKeyCount,
    beforeDuplicateRowIdGroupCount: before.duplicateRowIdGroupCount,
    afterDuplicateRowIdGroupCount: after.duplicateRowIdGroupCount,
    beforeDuplicateRowIdExtraCount: before.duplicateRowIdExtraCount,
    afterDuplicateRowIdExtraCount: after.duplicateRowIdExtraCount,
    beforeMissingRowIndexCount: before.missingRowIndexCount,
    afterMissingRowIndexCount: after.missingRowIndexCount,
    onlyBeforeSample: onlyBefore.slice(0, 8),
    onlyAfterSample: onlyAfter.slice(0, 8),
    chunkIdOnlyBeforeSample: chunkIdOnlyBefore.slice(0, 8),
    chunkIdOnlyAfterSample: chunkIdOnlyAfter.slice(0, 8),
    mismatchSample: mismatches.slice(0, 8).map((physicalRowKey) => ({
      physicalRowKey,
      before: before.chunkIdsByPhysicalRowKey.get(physicalRowKey) ?? [],
      after: after.chunkIdsByPhysicalRowKey.get(physicalRowKey) ?? []
    }))
  };
}

function paramPhysicalRowKey(row: ParamRowSymbol, sourceUri: string): string {
  return JSON.stringify([
    sourceUri,
    row.entryName ?? null,
    row.entryIndex ?? null,
    paramRowIndex(row),
    row.rowId
  ]);
}

function paramRowIndex(row: ParamRowSymbol): number | null {
  const raw = row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw)
    ? row.raw as Record<string, unknown>
    : undefined;
  const rowIndex = raw?.rowIndex;
  return typeof rowIndex === 'number'
    && Number.isSafeInteger(rowIndex)
    && rowIndex >= 0
    ? rowIndex
    : null;
}

function assertPhysicalParamIdentities(
  projections: ReturnType<typeof paramExportsFor>,
  physicalEntries: Array<{ index: number; name: string }>,
  phase: string
): void {
  const physical = new Set(physicalEntries.map((entry) => `${entry.index}\u0000${entry.name}`));
  const invalid = projections
    .map((item) => `${item.entryIndex ?? ''}\u0000${item.entryName ?? ''}`)
    .filter((identity) => !physical.has(identity));
  if (invalid.length > 0) {
    throw new Error(`PARAM ${phase} projection identity is not present in read-dcx entries: ${JSON.stringify(invalid.slice(0, 8))}`);
  }
}

async function mutateEvent(state: NativeTestState): Promise<MutationQuery> {
  const file = findFile(state, 'event', 'common.emevd.dcx');
  const read = await bridgeRead<EventEnvelope>({
    command: 'read-emevd-document',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay],
    oodleRuntimeRoot: state.gameRoot,
    commandOptions: { cachePolicy: 'bypass', instructionPage: 0, instructionPageSize: 65_536 }
  });
  const target = read.events.find((event) => event.id === 100) ?? read.events.find((event) => event.id !== 0) ?? read.events[0];
  if (!target) throw new Error('真实 EMEVD 没有可变更事件。');
  const nextRest = target.restBehavior === 0 ? 1 : 0;
  const staged = join(state.staging, 'event-rest.emevd.dcx');
  const written = await runNativeBridge({
    command: 'write-emevd',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay, state.staging],
    writableRoots: [state.staging],
    oodleRuntimeRoot: state.gameRoot,
    timeoutMs: 180_000,
    commandOptions: {
      outputPath: staged,
      expectedDocumentHash: read.sourceHash,
      mutation: 'set_rest_behavior',
      eventId: target.id,
      restBehavior: nextRest
    }
  });
  assertStaged(written.diagnostics, 'EMEVD');
  await commitStaged(state, file, staged, 'EMEVD rest behavior');
  return {
    sourceUri: file.sourceUri,
    oldQuery: `event ${target.id} restBehavior ${target.restBehavior}`,
    newQuery: `event ${target.id} restBehavior ${nextRest}`,
    oldNeedles: [`event ${target.id}`, `restBehavior ${target.restBehavior}`],
    newNeedles: [`event ${target.id}`, `restBehavior ${nextRest}`]
  };
}

async function mutateMap(state: NativeTestState): Promise<MutationQuery> {
  const file = findFile(state, 'map', 'm10_00_00_00.msb.dcx');
  const read = await bridgeRead<MapEnvelope>({
    command: 'read-msb-document',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay],
    oodleRuntimeRoot: state.gameRoot
  });
  const target = read.parts[0];
  if (!target) throw new Error('真实 MSB 没有可变更 Part。');
  const nextX = target.posX + 1.25;
  const staged = join(state.staging, 'map-position.msb.dcx');
  const written = await runNativeBridge({
    command: 'write-msb',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay, state.staging],
    writableRoots: [state.staging],
    oodleRuntimeRoot: state.gameRoot,
    timeoutMs: 180_000,
    commandOptions: {
      outputPath: staged,
      expectedDocumentHash: read.sourceHash,
      kind: 'set_part_position',
      family: 'part',
      nativeOffset: target.offset,
      expectedName: target.name,
      posX: nextX,
      posY: target.posY,
      posZ: target.posZ
    }
  });
  assertStaged(written.diagnostics, 'MSB');
  await commitStaged(state, file, staged, 'MSB position');
  return {
    sourceUri: file.sourceUri,
    oldQuery: `part ${target.name} pos ${target.posX}`,
    newQuery: `part ${target.name} pos ${nextX}`,
    oldNeedles: [`part ${target.name}`, `pos ${target.posX}`],
    newNeedles: [`part ${target.name}`, `pos ${nextX}`]
  };
}

async function mutateParam(state: NativeTestState): Promise<MutationQuery> {
  const file = findFile(state, 'param', 'gameparam.parambnd.dcx');
  const bnd = await bridgeRead<BndEnvelope>({
    command: 'read-dcx-document',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay],
    oodleRuntimeRoot: state.gameRoot
  });
  const entry = (bnd.nested?.entries ?? []).find((item) => item.index === 1);
  if (entry?.index === undefined || !entry.name || !entry.contentHash) throw new Error('真实 PARAM 缺少 ActionGuideParam 子项。');
  const child = join(state.staging, 'ActionGuideParam.param');
  await extractChild(state, file, entry.index, child);
  const read = await bridgeRead<ParamEnvelope>({
    command: 'read-param-document',
    filePath: child,
    allowedRoots: [state.staging],
    commandOptions: {}
  });
  const first = read.rows[0];
  if (!first) throw new Error('ActionGuideParam 没有行。');
  const metadata = await importPinnedSmithboxSdtParamMetadata({
    cacheRoot: join(process.env.LOCALAPPDATA ?? '', 'SoulForge', 'tools', 'smithbox', '2.2.4')
  });
  if (!metadata.ok) throw new Error(metadata.diagnostics[0]?.message ?? 'PARAM metadata unavailable');
  const definition = metadata.package.definitions.find((candidate) => (
    candidate.document.typeName === read.typeName
    && candidate.document.rowDataSize === read.rowDataSize
  ))?.document;
  if (!definition) throw new Error(`PARAM metadata missing ${read.typeName}/${read.rowDataSize}`);
  const beforeFields = decodeRowFields(Buffer.from(first.dataBase64, 'base64'), definition);
  const targetField = beforeFields.find((field) => typeof field.value === 'number');
  if (!targetField) throw new Error('ActionGuideParam 没有可验证的数值字段。');
  const fieldDef = definition.fields.find((field) => field.id === targetField.fieldId);
  if (!fieldDef || typeof targetField.value !== 'number') throw new Error('PARAM numeric field definition missing');
  const nextValue = nextNumericValue(targetField.value, fieldDef.min, fieldDef.max);
  const encoded = encodeFieldMutation(
    Buffer.from(first.dataBase64, 'base64'),
    definition,
    targetField.fieldId,
    nextValue
  );
  if (!encoded.ok) throw new Error(encoded.message);
  const stagedChild = join(state.staging, 'ActionGuideParam.mutated.param');
  const writtenParam = await runNativeBridge({
    command: 'write-param',
    filePath: child,
    allowedRoots: [state.staging],
    writableRoots: [state.staging],
    commandOptions: {
      outputPath: stagedChild,
      expectedDocumentHash: read.sourceHash,
      mutation: 'upsert',
      id: first.id,
      dataBase64: encoded.next.toString('base64')
    }
  });
  assertStaged(writtenParam.diagnostics, 'PARAM');
  const stagedContainer = join(state.staging, 'gameparam.parambnd.dcx');
  const writtenBnd = await runNativeBridge({
    command: 'write-bnd4',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay, state.staging],
    writableRoots: [state.staging],
    oodleRuntimeRoot: state.gameRoot,
    timeoutMs: 180_000,
    commandOptions: {
      outputPath: stagedContainer,
      mutation: 'replace',
      expectedContainerHash: await sha256File(file.absolutePath),
      entryIndex: entry.index,
      expectedChildHash: entry.contentHash,
      contentBase64: (await readFile(stagedChild)).toString('base64')
    }
  });
  assertStaged(writtenBnd.diagnostics, 'PARAM BND4');
  await commitStaged(state, file, stagedContainer, 'PARAM field');
  const symbolUri = `${file.sourceUri}#ActionGuideParam/${first.id}`;
  return {
    sourceUri: file.sourceUri,
    // Keep the query tied to the native row/field identity.  The RAG body is
    // emitted as `${fieldId} ${displayName} value=...`; querying only the
    // display label (for example `Text ID`) made a legitimate row/value look
    // absent even though the refreshed chunk was present.
    // Include the exact typed symbol URI so a small numeric value such as 0
    // cannot turn every PARAM row containing zero into an exact candidate.
    // The field/value terms remain in the query for the immediate evidence
    // check, while URI identity is what bounds retrieval to this row.
    oldQuery: `${symbolUri} fieldId ${targetField.fieldId} value=${targetField.value}`,
    newQuery: `${symbolUri} fieldId ${targetField.fieldId} value=${nextValue}`,
    oldNeedles: [
      `param ActionGuideParam`,
      `row ${first.id}`,
      `${targetField.fieldId} ${targetField.name} value=${targetField.value}`
    ],
    newNeedles: [
      `param ActionGuideParam`,
      `row ${first.id}`,
      `${targetField.fieldId} ${targetField.name} value=${nextValue}`
    ],
    paramIdentity: {
      table: 'ActionGuideParam',
      rowId: first.id,
      fieldId: targetField.fieldId,
      oldValue: targetField.value,
      newValue: nextValue
    }
  };
}

async function mutateFmg(state: NativeTestState): Promise<MutationQuery> {
  const file = findFile(state, 'msg', 'item.msgbnd.dcx');
  const bnd = await bridgeRead<BndEnvelope>({
    command: 'read-dcx-document',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay],
    oodleRuntimeRoot: state.gameRoot
  });
  const entry = (bnd.nested?.entries ?? []).find((item) => item.index === 1);
  if (entry?.index === undefined || !entry.name || !entry.contentHash) throw new Error('真实 FMG 缺少可写子项。');
  const child = join(state.staging, 'weapon_names.fmg');
  await extractChild(state, file, entry.index, child);
  const read = await bridgeRead<FmgEnvelope>({
    command: 'read-fmg-document',
    filePath: child,
    allowedRoots: [state.staging]
  });
  const target = read.entries.find((item) => typeof item.text === 'string'
    && item.text.length > 0 && item.text !== '<?null?>');
  if (!target) throw new Error('真实 FMG 没有可变更文本。');
  const nextText = `${target.text} SoulForgeRefreshProbe`;
  const stagedChild = join(state.staging, 'weapon_names.mutated.fmg');
  const writtenFmg = await runNativeBridge({
    command: 'write-fmg',
    filePath: child,
    allowedRoots: [state.staging],
    writableRoots: [state.staging],
    commandOptions: {
      outputPath: stagedChild,
      expectedDocumentHash: read.sourceHash,
      mutation: 'upsert',
      id: target.id,
      text: nextText
    }
  });
  assertStaged(writtenFmg.diagnostics, 'FMG');
  const stagedContainer = join(state.staging, 'item.msgbnd.dcx');
  const writtenBnd = await runNativeBridge({
    command: 'write-bnd4',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay, state.staging],
    writableRoots: [state.staging],
    oodleRuntimeRoot: state.gameRoot,
    timeoutMs: 180_000,
    commandOptions: {
      outputPath: stagedContainer,
      mutation: 'replace',
      expectedContainerHash: await sha256File(file.absolutePath),
      entryIndex: entry.index,
      expectedChildHash: entry.contentHash,
      contentBase64: (await readFile(stagedChild)).toString('base64')
    }
  });
  assertStaged(writtenBnd.diagnostics, 'FMG BND4');
  await commitStaged(state, file, stagedContainer, 'FMG text');
  return {
    sourceUri: file.sourceUri,
    oldQuery: target.text,
    newQuery: 'SoulForgeRefreshProbe',
    oldNeedles: [`textId ${target.id}`, target.text],
    newNeedles: [`textId ${target.id}`, 'SoulForgeRefreshProbe'],
    oldLine: target.text,
    newLine: nextText
  };
}

async function refreshAfterCommit(state: NativeTestState, sourceUri: string): Promise<WorkspaceIndex> {
  const beforeFiles = state.index.getFiles();
  const scan = await scanWorkspace({ workspaceRoot: state.overlay, game: 'sekiro' });
  const output = await refreshKnowledgeAfterCommit({
    index: state.index,
    beforeFiles,
    afterFiles: scan.files,
    requestedSources: [sourceUri],
    reanalyze: async () => {
      const reanalyzed = new WorkspaceIndex(scan.workspaceId);
      reanalyzed.setFiles(scan.files);
      const native = await refreshNativeSemanticSources({
        index: reanalyzed,
        sourceFiles: scan.files.filter((file) => file.sourceUri === sourceUri),
        stagingRoot: state.staging,
        allowedRoots: [state.overlay],
        oodleRuntimeRoot: state.gameRoot,
        timeoutMs: 180_000
      });
      if (native.failedSources.length > 0) {
        throw new Error(native.diagnostics.map((diagnostic) => diagnostic.message).join('；'));
      }
      return {
        index: reanalyzed,
        semanticState: native.partialSources.length > 0 ? 'partial' as const : 'reanalyzed' as const,
        ...(native.partialSources.length > 0
          ? { error: native.diagnostics.map((diagnostic) => diagnostic.message).join('；') }
          : {})
      };
    }
  });
  if (output.result.status !== 'converged' && output.result.status !== 'partial') {
    throw new Error(`knowledge refresh did not converge: ${JSON.stringify(output.result)}`);
  }
  state.files = new Map(output.index.getFiles().map((file) => [file.sourceUri, file]));
  return output.index;
}

async function commitStaged(
  state: NativeTestState,
  file: IndexedFile,
  stagedPath: string,
  title: string
): Promise<void> {
  const staged = await readFile(stagedPath);
  const result = await saveRawReplace({
    file,
    expectedHash: await sha256File(file.absolutePath),
    newContentBase64: staged.toString('base64'),
    title,
    session: state.session,
    operationLog: state.operationLog,
    backupBaseDir: join(state.root, 'backups'),
    recoveryDir: join(state.root, 'recovery'),
    confirmation: createConfirmationReceipt({
      subjects: ['NATIVE_KNOWLEDGE_REFRESH_SMOKE', file.sourceUri, `TITLE:${title}`],
      riskLevel: 'high',
      sourceUri: file.sourceUri,
      note: '真实 native writer 暂存产物的临时 Patch Engine 提交。'
    })
  });
  if (!result.ok) throw new Error(`${title} Patch Engine commit failed: ${JSON.stringify(result.diagnostics)}`);
}

async function extractChild(
  state: NativeTestState,
  file: IndexedFile,
  index: number,
  outputPath: string
): Promise<void> {
  const result = await runNativeBridge({
    command: 'extract-bnd4-child',
    filePath: file.absolutePath,
    allowedRoots: [state.overlay, state.staging],
    writableRoots: [state.staging],
    oodleRuntimeRoot: state.gameRoot,
    commandOptions: { entryIndex: index, outputPath }
  });
  if (result.parseStatus === 'failed') throw new Error(`extract child failed: ${JSON.stringify(result.diagnostics)}`);
}

async function bridgeRead<T>(input: {
  command: 'read-emevd-document' | 'read-msb-document' | 'read-dcx-document' | 'read-param-document' | 'read-fmg-document';
  filePath: string;
  allowedRoots: string[];
  oodleRuntimeRoot?: string;
  commandOptions?: Record<string, unknown>;
}): Promise<T> {
  const result = await runNativeBridge<T>({
    command: input.command,
    filePath: input.filePath,
    resourceUri: pathToFileURL(input.filePath).href,
    allowedRoots: input.allowedRoots,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    timeoutMs: 180_000,
    maxFrameBytes: 32 * 1024 * 1024,
    ...(input.commandOptions ? { commandOptions: input.commandOptions } : {})
  });
  if (result.parseStatus === 'failed' || !result.data) {
    throw new Error(`${input.command} failed: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

function assertOnlyNew(index: WorkspaceIndex, family: RagChunkFamily, query: MutationQuery): void {
  const corpus = buildRagCorpus(index);
  const retrieveOptions = {
    families: [family],
    sourceUris: [query.sourceUri],
    expandReferences: false,
    limit: 8
  } as const;
  const oldResult = retrieveEvidence(corpus, query.oldQuery, retrieveOptions);
  const oldHit = oldResult.ok ? oldResult.hits.find((hit) => hit.chunk.sourceUri === query.sourceUri
    && (!query.paramIdentity || hit.chunk.symbolUri === paramSymbolUri(query.paramIdentity, query.sourceUri))
    && (!query.paramIdentity
      ? query.oldNeedles.every((needle) => hit.chunk.body.includes(needle))
      : hasParamRowAndField(hit.chunk.body, query.paramIdentity.rowId, query.paramIdentity.fieldId, query.paramIdentity.oldValue))
    && (!query.oldLine || hit.chunk.body.split('\n').includes(query.oldLine))) : undefined;
  if (oldHit) {
    throw new Error(`old ${family} evidence survived immediate refresh: ${query.oldQuery} ${JSON.stringify({ symbolUri: oldHit.chunk.symbolUri, body: oldHit.chunk.body })}`);
  }
  const newResult = retrieveEvidence(corpus, query.newQuery, retrieveOptions);
  const newHit = newResult.ok ? newResult.hits.find((hit) => hit.chunk.sourceUri === query.sourceUri
    && (!query.paramIdentity || hit.chunk.symbolUri === paramSymbolUri(query.paramIdentity, query.sourceUri))
    && (!query.paramIdentity
      ? query.newNeedles.every((needle) => hit.chunk.body.includes(needle))
      : hasParamRowAndField(hit.chunk.body, query.paramIdentity.rowId, query.paramIdentity.fieldId, query.paramIdentity.newValue))
    && (!query.newLine || hit.chunk.body.split('\n').includes(query.newLine))) : undefined;
  if (query.paramIdentity) {
    const oldTypedField = findParamField(index, query.paramIdentity, query.sourceUri, query.paramIdentity.oldValue);
    if (oldTypedField) {
      throw new Error(`old PARAM typed projection survived immediate refresh: ${query.oldQuery} ${JSON.stringify(oldTypedField)}`);
    }
    const newTypedField = findParamField(index, query.paramIdentity, query.sourceUri, query.paramIdentity.newValue);
    if (!newTypedField) {
      throw new Error(`new PARAM typed projection missing after immediate refresh: ${query.newQuery} ${JSON.stringify({
        expectedSymbolUri: paramSymbolUri(query.paramIdentity, query.sourceUri),
        rows: getParamRows(index, query.paramIdentity, query.sourceUri)
      })}`);
    }
  }
  if (!newHit) {
    throw new Error(`new ${family} evidence missing after immediate refresh: ${query.newQuery} ${JSON.stringify({
      sourceUri: query.sourceUri,
      expectedSymbolUri: query.paramIdentity ? paramSymbolUri(query.paramIdentity, query.sourceUri) : undefined,
      result: newResult.ok ? newResult.hits.map((hit) => ({ symbolUri: hit.chunk.symbolUri, body: hit.chunk.body })) : newResult
    })}`);
  }
}

function paramSymbolUri(identity: NonNullable<MutationQuery['paramIdentity']>, sourceUri: string): string {
  return `${sourceUri}#${identity.table}/${identity.rowId}`;
}

/**
 * PARAM evidence is line-oriented.  Match the native field id at the start
 * of one field line and require the serialized value at the line end.  This
 * deliberately ignores displayName and description: both are presentation
 * metadata and may contain arbitrary text (including the expected value).
 */
function hasParamRowAndField(body: string, rowId: number, fieldId: string, value: string | number | boolean): boolean {
  const lines = body.split('\n');
  const fieldPrefix = `${fieldId} `;
  const valueSuffix = ` value=${String(value)}`;
  return lines.includes(`row ${rowId}`)
    && lines.some((line) => line.startsWith(fieldPrefix) && line.endsWith(valueSuffix));
}

function getParamRows(
  index: WorkspaceIndex,
  identity: NonNullable<MutationQuery['paramIdentity']>,
  sourceUri: string
): ParamRowSymbol[] {
  return (index.toSymbolBundle().params ?? [])
    .filter((table) => table.sourceUri === sourceUri && table.paramName === identity.table)
    .flatMap((table) => table.rows)
    .filter((row) => row.sourceUri === sourceUri
      && row.paramName === identity.table
      && row.rowId === identity.rowId
      && row.uri === paramSymbolUri(identity, sourceUri));
}

function findParamField(
  index: WorkspaceIndex,
  identity: NonNullable<MutationQuery['paramIdentity']>,
  sourceUri: string,
  value: string | number | boolean
): NonNullable<ParamRowSymbol['fields']>[number] | undefined {
  const rows = getParamRows(index, identity, sourceUri);
  if (rows.length !== 1) return undefined;
  return rows[0]?.fields?.find((field) => field.fieldId === identity.fieldId && Object.is(field.value, value));
}

function findFile(state: NativeTestState, kind: IndexedFile['resourceKind'], suffix: string): IndexedFile {
  const file = [...state.files.values()].find((candidate) => (
    candidate.resourceKind === kind && candidate.relativePath.toLowerCase().endsWith(suffix.toLowerCase())
  ));
  if (!file) throw new Error(`test source not found: ${kind}/${suffix}`);
  return file;
}

function assertStaged(diagnostics: Array<{ code: string; message: string }>, label: string): void {
  if (!diagnostics.some((diagnostic) => diagnostic.code.includes('STAGING_WRITE_VERIFIED'))) {
    throw new Error(`${label} staging write failed: ${JSON.stringify(diagnostics)}`);
  }
}

async function copyGameSource(gameRoot: string, overlayRoot: string, relativePath: string): Promise<void> {
  const destination = join(overlayRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(gameRoot, relativePath), destination);
}

function nextNumericValue(value: number, min?: number, max?: number): number {
  const candidate = value + 1;
  if (max === undefined || candidate <= max) {
    if (min === undefined || candidate >= min) return candidate;
  }
  return value - 1;
}

function sha256File(path: string): Promise<string> {
  return readFile(path).then((bytes) => createHash('sha256').update(bytes).digest('hex'));
}

interface MutationQuery {
  sourceUri: string;
  oldQuery: string;
  newQuery: string;
  oldNeedles: string[];
  newNeedles: string[];
  oldLine?: string;
  newLine?: string;
  paramIdentity?: {
    table: string;
    rowId: number;
    fieldId: string;
    oldValue: number | string | boolean;
    newValue: number | string | boolean;
  };
}

void main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
