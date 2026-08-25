/**
 * Real Sekiro regression for native write -> Patch Engine -> knowledge refresh
 * -> immediate RAG query.  The source files are copied into a temporary
 * opened overlay; no installed game or user Mod bytes are changed.
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { IndexedFile, ParamDefDocument, RagChunkFamily } from '@soulforge/shared';
import { pathToFileURL } from 'node:url';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decodeRowFields, encodeFieldMutation } from '../param/paramdefLayout.js';
import { importPinnedSmithboxSdtParamMetadata } from '../param/smithboxParamMetadataSource.js';
import { buildRagCorpus } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { refreshKnowledgeAfterCommit } from '../indexing/knowledgeRefresh.js';
import { refreshNativeSemanticSources } from '../indexing/nativeSemanticRefresh.js';
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
      note: '真实 native writer 暂存产物经 Patch Engine 写入临时 overlay；每次提交后立即 refresh + retrieve_evidence。'
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
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
  const written = await runBridge({
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
  const written = await runBridge({
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
  const writtenParam = await runBridge({
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
  const writtenBnd = await runBridge({
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
  return {
    sourceUri: file.sourceUri,
    oldQuery: `ActionGuideParam ${first.id} ${targetField.name} ${targetField.value}`,
    newQuery: `ActionGuideParam ${first.id} ${targetField.name} ${nextValue}`,
    oldNeedles: [`param ActionGuideParam`, `row ${first.id}`, `${targetField.name}=${targetField.value}`],
    newNeedles: [`param ActionGuideParam`, `row ${first.id}`, `${targetField.name}=${nextValue}`]
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
  const target = read.entries.find((item) => item.text.length > 0 && item.text !== '<?null?>');
  if (!target) throw new Error('真实 FMG 没有可变更文本。');
  const nextText = `${target.text} SoulForgeRefreshProbe`;
  const stagedChild = join(state.staging, 'weapon_names.mutated.fmg');
  const writtenFmg = await runBridge({
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
  const writtenBnd = await runBridge({
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
  const result = await runBridge({
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
  const result = await runBridge<T>({
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
  const oldResult = retrieveEvidence(corpus, query.oldQuery, { families: [family], expandReferences: false });
  const oldHit = oldResult.ok ? oldResult.hits.find((hit) => hit.chunk.sourceUri === query.sourceUri
    && query.oldNeedles.every((needle) => hit.chunk.body.includes(needle))
    && (!query.oldLine || hit.chunk.body.split('\n').includes(query.oldLine))) : undefined;
  if (oldHit) {
    throw new Error(`old ${family} evidence survived immediate refresh: ${query.oldQuery} ${JSON.stringify({ symbolUri: oldHit.chunk.symbolUri, body: oldHit.chunk.body })}`);
  }
  const newResult = retrieveEvidence(corpus, query.newQuery, { families: [family], expandReferences: false });
  if (!newResult.ok || !newResult.hits.some((hit) => hit.chunk.sourceUri === query.sourceUri
    && query.newNeedles.every((needle) => hit.chunk.body.includes(needle))
    && (!query.newLine || hit.chunk.body.split('\n').includes(query.newLine)))) {
    throw new Error(`new ${family} evidence missing after immediate refresh: ${query.newQuery}`);
  }
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
}

void main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
