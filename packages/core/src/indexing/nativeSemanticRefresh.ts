/**
 * Rebuild semantic projections for native files after a committed write.
 *
 * `scanWorkspace` only knows the outer file catalog.  Sekiro's EMEVD/MSB
 * files may be directly readable by Bridge, while PARAM/FMG semantic rows
 * live inside DCX/BND children.  Keeping this boundary here prevents the
 * post-commit refresh from declaring convergence after merely changing the
 * outer file hash.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  Diagnostic,
  EventInstruction,
  EventExport,
  IndexedFile,
  MapExport,
  MsgExport,
  ParamDefDocument,
  ParamMetadataPackage,
  ParamExport,
  ParamFieldSymbol,
  ParamRowSymbol,
  BridgeResult,
  SymbolBundle
} from '@soulforge/shared';
import { parseParamFieldRefs } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { readParamDocumentViaBridge } from '../editing/paramBridgeCommit.js';
import { decodeRowFields } from '../param/paramdefLayout.js';
import { matchParamMetadataPackage, resolveParamMetadataRowWidth } from '../param/paramMetadata.js';
import { loadFirstPartyParamMetadata } from '../schema/sekiro/firstPartySchema.js';
import { mapExportFromMsbDocument } from './ingestBridgeResult.js';
import { WorkspaceIndex } from './workspaceIndex.js';
import { loadSymbolBundleIntoIndex } from '../workspace/semanticFileCache.js';

/** Internal test seam; production callers use the imported Bridge runner. */
type NativeSemanticBridgeRunner = typeof runBridge;

export interface NativeSemanticRefreshOptions {
  index: WorkspaceIndex;
  sourceFiles: readonly IndexedFile[];
  stagingRoot: string;
  allowedRoots?: readonly string[];
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** @internal Test-only seam; never supplied by production IPC. */
  bridgeRunner?: NativeSemanticBridgeRunner;
  /** @internal Test-only seam for the PARAM document reader. */
  paramDocumentReader?: typeof readParamDocumentViaBridge;
  /**
   * Reference-only projection used by on-demand find_references enrichment.
   * Normal post-write refreshes keep their historical complete field rows.
   */
  referenceFieldsOnly?: boolean;
}

export interface NativeSemanticRefreshResult {
  refreshedSources: string[];
  partialSources: string[];
  failedSources: string[];
  staleSources: string[];
  diagnostics: Diagnostic[];
}

interface NativeSourceReadResult {
  complete: boolean;
  semanticCount: number;
  stale: boolean;
  diagnostics: Diagnostic[];
}

interface NativeContainerEntry {
  index: number;
  name: string;
}

interface NativeSourceSnapshot {
  path: string;
  outerFileHash: string;
}

interface ParamMetadataCache {
  ok: boolean;
  package?: ParamMetadataPackage;
  diagnostics: Diagnostic[];
}

interface NativeMapPartInput {
  name: string;
  typeId?: number;
  modelIndex?: number;
  posX?: number;
  posY?: number;
  posZ?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

interface NativeMapRegionInput {
  name: string;
  typeId?: number;
  posX?: number;
  posY?: number;
  posZ?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
}

const PARAM_DECODE_YIELD_BATCH_SIZE = 64;

let paramMetadataCache: ParamMetadataCache | undefined;

/**
 * Refresh only the requested native source files.  A failed native read is
 * reported to the caller so the knowledge transaction can remain failed with
 * an empty semantic state instead of preserving stale rows.
 */
export async function refreshNativeSemanticSources(
  input: NativeSemanticRefreshOptions
): Promise<NativeSemanticRefreshResult> {
  const sourceFiles = uniqueFiles(input.sourceFiles).filter((file) => (
    file.resourceKind === 'event'
    || file.resourceKind === 'map'
    || file.resourceKind === 'param'
    || file.resourceKind === 'msg'
  ));
  if (sourceFiles.length === 0) {
    return { refreshedSources: [], partialSources: [], failedSources: [], staleSources: [], diagnostics: [] };
  }

  await mkdir(input.stagingRoot, { recursive: true });
  const scratchRoot = await mkdtemp(join(resolve(input.stagingRoot), 'native-semantic-refresh-'));
  const diagnostics: Diagnostic[] = [];
  // Native reads and entry fan-out happen on an isolated projection.  The
  // live index is changed only after every requested source has reached a
  // terminal non-cancelled state.
  const refreshIndex = input.index.cloneForRefresh();
  // The clone must start with every requested source invalidated.  Otherwise
  // a failed/partial container read can leave an old export in the clone and
  // commitRefreshProjection will faithfully copy that stale export back into
  // the live index together with the newly decoded leaves.
  refreshIndex.invalidateChangedSources(sourceFiles.map((file) => file.sourceUri));
  const refreshInput: NativeSemanticRefreshOptions = { ...input, index: refreshIndex };
  const refreshedSources: string[] = [];
  const partialSources: string[] = [];
  const failedSources: string[] = [];
  const staleSources: string[] = [];
  try {
    for (const file of sourceFiles) {
      try {
        throwIfAborted(refreshInput.signal);
        // Freeze one complete source receipt before asking Bridge to enumerate
        // or extract anything.  Every subsequent native read uses this copy,
        // so a mutable mod workspace cannot mix catalog-v1 and readback-v2
        // bytes between list/extract/parse calls.
        const snapshot = await captureNativeSourceSnapshot(file, scratchRoot, input.signal);
        if (!snapshot) {
          staleSources.push(file.sourceUri);
          diagnostics.push({
            severity: 'warning',
            code: 'NATIVE_SEMANTIC_REFRESH_SOURCE_STALE',
            message: 'native refresh source 在建立固定读取副本时已变化，拒绝把活动路径的后续读取当作同一版本。',
            sourceUri: file.sourceUri
          });
          continue;
        }
        if (!refreshInput.index.isNativeProjectionCurrent(file.sourceUri, {
          // IndexedFile.sha256 is the packed/outer catalog identity.  A
          // semantic child hash must never be compared to it as if it were
          // the same byte domain.
          outerFileHash: snapshot.outerFileHash,
          sourceRevision: file.mtimeMs
        })) {
          staleSources.push(file.sourceUri);
          diagnostics.push({
            severity: 'warning',
            code: 'NATIVE_SEMANTIC_REFRESH_STALE',
            message: '拒绝发布晚到的旧 native semantic projection；当前工作区 source revision 已更新。',
            sourceUri: file.sourceUri
          });
          continue;
        }
        const snapshotFile = {
          ...file,
          absolutePath: snapshot.path,
          // From this point on `sha256` is the verified snapshot receipt, not
          // an unchecked catalog fallback.  Child projections copy it only as
          // their outerFileHash; their sourceHash remains the native leaf hash.
          sha256: snapshot.outerFileHash
        };
        const roots = refreshAllowedRoots(input, snapshotFile, scratchRoot);
        if (file.resourceKind === 'event') {
          const eventExport = await readEventExport(snapshotFile, roots, refreshInput, snapshot.outerFileHash);
          throwIfAborted(refreshInput.signal);
          if (!refreshInput.index.upsertEventExport(eventExport)) {
            staleSources.push(file.sourceUri);
            diagnostics.push({
              severity: 'warning',
              code: 'NATIVE_SEMANTIC_REFRESH_STALE',
              message: 'EMEVD semantic projection version was rejected as stale.',
              sourceUri: file.sourceUri
            });
            continue;
          }
        } else if (file.resourceKind === 'map') {
          const mapExport = await readMapExport(snapshotFile, roots, refreshInput, snapshot.outerFileHash);
          throwIfAborted(refreshInput.signal);
          if (!refreshInput.index.upsertMapExport(mapExport)) {
            staleSources.push(file.sourceUri);
            diagnostics.push({
              severity: 'warning',
              code: 'NATIVE_SEMANTIC_REFRESH_STALE',
              message: 'MSB semantic projection version/schema was rejected as stale.',
              sourceUri: file.sourceUri
            });
            continue;
          }
        } else if (file.resourceKind === 'param') {
          const result = await readParamExports(snapshotFile, roots, scratchRoot, refreshInput, snapshot.outerFileHash);
          diagnostics.push(...result.diagnostics);
          if (result.stale) {
            staleSources.push(file.sourceUri);
            continue;
          }
          if (result.semanticCount === 0) {
            throw new Error('PARAM native reread 没有产出任何完整表的 semantic rows。');
          }
          if (!result.complete) partialSources.push(file.sourceUri);
        } else if (file.resourceKind === 'msg') {
          const result = await readMsgExports(snapshotFile, roots, scratchRoot, refreshInput, snapshot.outerFileHash);
          diagnostics.push(...result.diagnostics);
          if (result.stale) {
            staleSources.push(file.sourceUri);
            continue;
          }
          if (result.semanticCount === 0) {
            throw new Error('FMG native reread 没有产出任何 semantic entries。');
          }
          if (!result.complete) partialSources.push(file.sourceUri);
        }
        refreshedSources.push(file.sourceUri);
      } catch (error) {
        if (refreshInput.signal?.aborted || isAbortLike(error)) throw error;
        failedSources.push(file.sourceUri);
        diagnostics.push({
          severity: 'error',
          code: 'NATIVE_SEMANTIC_REFRESH_FAILED',
          message: error instanceof Error ? error.message : String(error),
          sourceUri: file.sourceUri
        });
      }
    }
    throwIfAborted(refreshInput.signal);
    refreshIndex.rebuildReferences();
    commitRefreshProjection(
      input.index,
      refreshIndex,
      sourceFiles.map((file) => file.sourceUri),
      partialSources
    );
    return { refreshedSources, partialSources, failedSources, staleSources, diagnostics };
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

function commitRefreshProjection(
  target: WorkspaceIndex,
  refreshed: WorkspaceIndex,
  sourceUris: readonly string[],
  partialSources: readonly string[]
): void {
  const sourceSet = new Set(sourceUris);
  // Remove every requested source from the live projection first, including a
  // source whose native read failed.  That keeps failed sources stale and
  // partial sources explicitly incomplete instead of leaving an old row set
  // that looks current.
  target.invalidateChangedSources(sourceUris);
  const bundle = refreshed.toSymbolBundle();
  const sourceBundle: SymbolBundle = {
    ...(bundle.events ? {
      events: bundle.events
        .map((item) => ({ ...item, events: item.events.filter((event) => sourceSet.has(event.sourceUri)) }))
        .filter((item) => item.events.length > 0)
    } : {}),
    ...(bundle.maps ? {
      maps: bundle.maps
        .map((item) => ({
          ...item,
          entities: item.entities.filter((entity) => sourceSet.has(entity.sourceUri)),
          regions: item.regions.filter((region) => sourceSet.has(region.sourceUri))
        }))
        .filter((item) => item.entities.length > 0 || item.regions.length > 0)
    } : {}),
    ...(bundle.params ? {
      params: bundle.params.filter((item) => sourceSet.has(item.sourceUri ?? '')
        || item.rows.some((row) => sourceSet.has(row.sourceUri)))
    } : {}),
    ...(bundle.msgs ? {
      msgs: bundle.msgs
        .map((item) => ({ ...item, entries: item.entries.filter((entry) => sourceSet.has(entry.sourceUri)) }))
        .filter((item) => item.entries.length > 0)
    } : {}),
    ...(bundle.tae ? { tae: bundle.tae.filter((item) => sourceSet.has(item.sourceUri)) } : {})
  };
  loadSymbolBundleIntoIndex(target, sourceBundle);
  if (partialSources.length > 0) {
    target.markCoveragePartial(partialSources);
  }
  target.rebuildReferences();
}

async function readEventExport(
  file: IndexedFile,
  allowedRoots: string[],
  input: NativeSemanticRefreshOptions,
  expectedOuterFileHash: string
): Promise<EventExport> {
  const bridgeRunner = input.bridgeRunner ?? runBridge;
  const result = await bridgeRunner<Record<string, unknown>>({
    // The outline document is deliberately bounded and has no per-event
    // instruction body.  Refreshing the semantic index through it recreates
    // the old empty `instructions: []` projection.  `export-event` is the
    // native semantic export that already expands every event/instruction
    // while keeping the raw args opaque until EMEDF is bound by the caller.
    command: 'export-event',
    filePath: file.absolutePath,
    resourceUri: file.sourceUri,
    allowedRoots,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    maxFrameBytes: 32 * 1024 * 1024,
    commandOptions: { cachePolicy: 'bypass' }
  });
  const data = requireBridgeData(result, file.sourceUri, 'EMEVD');
  const reportedOuterFileHash = stringValue(data.outerFileHash);
  if (reportedOuterFileHash && reportedOuterFileHash !== expectedOuterFileHash) {
    throw new Error('EMEVD native read outer hash 与固定 source receipt 不一致。');
  }
  const eventsRaw = arrayValue(data.events);
  if (eventsRaw.length === 0 && numberValue(data.eventCount) !== 0) {
    throw new Error('EMEVD native read returned no event table.');
  }
  const sourceHash = stringValue(data.sourceHash) || undefined;
  const outerFileHash = reportedOuterFileHash || expectedOuterFileHash;
  const sourceRevision = file.mtimeMs;
  const mapId = stripNativeExtension(file.relativePath || file.absolutePath, 'emevd');
  const events = eventsRaw.map((value, index) => {
    const record = recordValue(value);
    const eventId = numberValue(record.id) ?? numberValue(record.eventId);
    if (eventId === undefined || !Number.isSafeInteger(eventId)) {
      throw new Error(`EMEVD events[${index}] 缺少合法 id。`);
    }
    const raw: Record<string, unknown> = {
      authority: 'native-read-semantic-export',
      instructionCount: numberValue(record.instructionCount) ?? 0,
      restBehavior: numberValue(record.restBehavior) ?? 0,
      parameterCount: Array.isArray(record.parameters) ? record.parameters.length : 0,
      parameters: Array.isArray(record.parameters) ? record.parameters : []
    };
    const eventUri = `${file.sourceUri}#event/${eventId}`;
    const semanticInstructions = nativeSemanticInstructions(record, eventUri);
    return {
      uri: eventUri,
      sourceUri: file.sourceUri,
      mapId,
      eventId,
      ...(stringValue(record.name) ? { name: stringValue(record.name) } : {}),
      ...(sourceHash ? { sourceHash } : {}),
      ...(outerFileHash ? { outerFileHash } : {}),
      ...(sourceRevision !== undefined ? { sourceRevision } : {}),
      instructions: semanticInstructions,
      raw
    };
  });
  return {
    mapId,
    ...(sourceHash ? { sourceHash } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    events
  };
}

/**
 * Some Bridge semantic exports already attach decoded rows to each event,
 * while the native outline normally omits them. Keep rows only when they are
 * actually present and preserve their args/raw wire data; an absent row is not
 * replaced by a guessed instruction.
 */
function nativeSemanticInstructions(
  event: Record<string, unknown>,
  eventUri: string
): EventInstruction[] {
  const rows = Array.isArray(event.instructions)
    ? event.instructions
    : Array.isArray(event.instructionRows) ? event.instructionRows : [];
  return rows.flatMap((value, index) => {
    const record = recordValue(value);
    const instructionIndex = numberValue(record.index);
    const args = Array.isArray(record.args)
      ? record.args.flatMap((arg) => nativeSemanticArg(arg))
      : [];
    const wireRaw: Record<string, unknown> = {};
    if (numberValue(record.bank) !== undefined) wireRaw.bank = numberValue(record.bank);
    if (numberValue(record.id) !== undefined) wireRaw.id = numberValue(record.id);
    if (stringValue(record.argsBase64)) wireRaw.argsBase64 = stringValue(record.argsBase64);
    if (numberValue(record.layerOffset) !== undefined) wireRaw.layerOffset = numberValue(record.layerOffset);
    return [{
      uri: stringValue(record.uri) || `${eventUri}/instruction/${instructionIndex ?? index}`,
      index: instructionIndex !== undefined && Number.isSafeInteger(instructionIndex) && instructionIndex >= 0
        ? instructionIndex
        : index,
      ...(stringValue(record.name) ? { name: stringValue(record.name) } : {}),
      ...(stringValue(record.category) ? { category: stringValue(record.category) } : {}),
      args,
      ...(record.raw === undefined && Object.keys(wireRaw).length > 0
        ? { raw: wireRaw }
        : record.raw === undefined ? {} : { raw: record.raw })
    }];
  });
}

function nativeSemanticArg(value: unknown): EventInstruction['args'][number][] {
  const record = recordValue(value);
  const scalar = record.value;
  if (typeof scalar !== 'string' && typeof scalar !== 'number' && typeof scalar !== 'boolean') return [];
  return [{
    ...(stringValue(record.name) ? { name: stringValue(record.name) } : {}),
    value: scalar,
    ...(record.role === 'flag' || record.role === 'eventId' || record.role === 'entityId'
      || record.role === 'regionId' || record.role === 'paramId' || record.role === 'textId' || record.role === 'unknown'
      ? { role: record.role } : {}),
    ...(stringValue(record.paramName) ? { paramName: stringValue(record.paramName) } : {}),
    ...(record.confidence === 'high' || record.confidence === 'medium' || record.confidence === 'low'
      ? { confidence: record.confidence } : {})
  }];
}

async function readMapExport(
  file: IndexedFile,
  allowedRoots: string[],
  input: NativeSemanticRefreshOptions,
  expectedOuterFileHash: string
): Promise<MapExport> {
  const bridgeRunner = input.bridgeRunner ?? runBridge;
  const result = await bridgeRunner<Record<string, unknown>>({
    command: 'read-msb-document',
    filePath: file.absolutePath,
    resourceUri: file.sourceUri,
    allowedRoots,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    maxFrameBytes: 32 * 1024 * 1024
  });
  const data = requireBridgeData(result, file.sourceUri, 'MSB');
  const reportedOuterFileHash = stringValue(data.outerFileHash);
  if (reportedOuterFileHash && reportedOuterFileHash !== expectedOuterFileHash) {
    throw new Error('MSB native read outer hash 与固定 source receipt 不一致。');
  }
  const mapId = stripNativeExtension(file.relativePath || file.absolutePath, 'msb');
  const sourceHash = stringValue(data.sourceHash) || undefined;
  const outerFileHash = reportedOuterFileHash || expectedOuterFileHash;
  const parts: NativeMapPartInput[] = arrayValue(data.parts).map((value) => {
    const record = recordValue(value);
    const part: NativeMapPartInput = { name: stringValue(record.name) };
    assignNumber(part, 'typeId', record.typeId);
    assignNumber(part, 'modelIndex', record.modelIndex);
    assignNumber(part, 'posX', record.posX);
    assignNumber(part, 'posY', record.posY);
    assignNumber(part, 'posZ', record.posZ);
    assignNumber(part, 'rotX', record.rotX);
    assignNumber(part, 'rotY', record.rotY);
    assignNumber(part, 'rotZ', record.rotZ);
    assignNumber(part, 'scaleX', record.scaleX);
    assignNumber(part, 'scaleY', record.scaleY);
    assignNumber(part, 'scaleZ', record.scaleZ);
    assignNumber(part, 'internalEntryId', record.internalEntryId);
    assignNumber(part, 'entityId', record.entityId);
    return part;
  });
  const regions: NativeMapRegionInput[] = arrayValue(data.regions).map((value) => {
    const record = recordValue(value);
    const region: NativeMapRegionInput = { name: stringValue(record.name) };
    assignNumber(region, 'typeId', record.typeId);
    assignNumber(region, 'posX', record.posX);
    assignNumber(region, 'posY', record.posY);
    assignNumber(region, 'posZ', record.posZ);
    assignNumber(region, 'rotX', record.rotX);
    assignNumber(region, 'rotY', record.rotY);
    assignNumber(region, 'rotZ', record.rotZ);
    assignNumber(region, 'scaleX', record.scaleX);
    assignNumber(region, 'scaleY', record.scaleY);
    assignNumber(region, 'scaleZ', record.scaleZ);
    assignNumber(region, 'internalEntryId', record.internalEntryId);
    assignNumber(region, 'entityId', record.entityId);
    return region;
  });
  return mapExportFromMsbDocument({
    mapId,
    sourceUri: file.sourceUri,
    ...(sourceHash ? { sourceHash } : {}),
    ...(outerFileHash ? { outerFileHash } : {}),
    ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
    readerSchemaRevision: numberValue(data.readerSchemaRevision) ?? 2,
    parts,
    regions
  });
}

/**
 * Decode one native PARAM table into semantic rows in bounded event-loop
 * batches.  Keeping this loop as a small runtime unit makes its cancellation
 * and output-equivalence contract directly testable without needing a full
 * DCX/BND fixture.
 */
export async function decodeNativeParamRows(input: {
  file: Pick<IndexedFile, 'sourceUri' | 'sha256' | 'mtimeMs'>;
  /** Hash of the decoded PARAM child payload, when known. */
  sourceHash?: string;
  /** Hash of the packed/outer source file, when known. */
  outerFileHash?: string;
  tableName: string;
  entryName: string;
  entryIndex: number;
  typeName: string;
  definition: ParamDefDocument;
  rows: readonly unknown[];
  signal?: AbortSignal;
  referenceFieldsOnly?: boolean;
}): Promise<ParamRowSymbol[]> {
  const fieldsById = new Map(input.definition.fields.map((field) => [field.id, field]));
  // PARAM reference enrichment only needs fields carrying trusted Refs= rules
  // plus their condition siblings.  Keeping the projection narrow matters on
  // real gameparam tables with tens of thousands of rows: unrelated fields
  // remain available to the explicit read_param_fields path instead of being
  // copied into every reference snapshot.
  const referenceFieldIds = new Set<string>();
  if (input.referenceFieldsOnly) {
    for (const definitionField of input.definition.fields) {
      if (!definitionField.refs) continue;
      referenceFieldIds.add(definitionField.id);
      const parsed = parseParamFieldRefs(definitionField.refs);
      for (const target of parsed.targets) {
        if (target.condition) referenceFieldIds.add(target.condition.fieldId);
      }
    }
  }
  // Keep backwards-compatible fixture callers (which only supplied
  // file.sha256) while making the packed/native path explicit.  Once either
  // identity is supplied, do not copy one hash into the other domain.
  const sourceHash = input.sourceHash ?? (input.outerFileHash === undefined ? input.file.sha256 : undefined);
  const outerFileHash = input.outerFileHash ?? (input.sourceHash === undefined ? input.file.sha256 : undefined);
  const rows: ParamRowSymbol[] = [];
  for (let index = 0; index < input.rows.length; index += 1) {
    throwIfAborted(input.signal);
    const value = input.rows[index];
    const record = recordValue(value);
    const rowId = numberValue(record.id);
    const dataBase64 = stringValue(record.dataBase64);
    if (rowId === undefined || !Number.isSafeInteger(rowId) || dataBase64.length === 0) {
      throw new Error(`PARAM ${input.entryName} rows[${index}] 缺少合法 id/dataBase64。`);
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length !== input.definition.rowDataSize) {
      throw new Error(`PARAM ${input.entryName}#${rowId} 行宽 ${bytes.length} != ${input.definition.rowDataSize}。`);
    }
    // Bridge's rowIndex is the physical position in the complete native
    // table, not the position in this page/array.  Preserve that receipt for
    // downstream physical identities; never substitute the local `index`.
    const nativeRowIndex = numberValue(record.rowIndex);
    const rowIndex = nativeRowIndex !== undefined
      && Number.isSafeInteger(nativeRowIndex)
      && nativeRowIndex >= 0
      ? nativeRowIndex
      : undefined;
    const fields: ParamFieldSymbol[] = decodeRowFields(bytes, input.definition)
      .filter((field) => !input.referenceFieldsOnly || referenceFieldIds.has(field.fieldId))
      .map((field) => {
      const definitionField = fieldsById.get(field.fieldId);
      const refs = input.referenceFieldsOnly && definitionField?.refs
        ? parseParamFieldRefs(definitionField.refs)
        : undefined;
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        ...(definitionField?.description ? { description: definitionField.description } : {}),
        value: field.value,
        ...(refs && refs.targets.length > 0 ? { refs: refs.targets, refsProvenance: 'trusted-metadata' as const } : {}),
        ...(refs && refs.rejected.length > 0 ? { refsRejected: refs.rejected, refsProvenance: 'trusted-metadata' as const } : {})
      };
    });
    rows.push({
      uri: `${input.file.sourceUri}#${input.tableName}/${rowId}`,
      sourceUri: input.file.sourceUri,
      paramName: input.tableName,
      entryName: input.entryName,
      entryIndex: input.entryIndex,
      rowId,
      ...(stringValue(record.name) ? { rowName: stringValue(record.name) } : {}),
      ...(sourceHash ? { sourceHash } : {}),
      ...(outerFileHash ? { outerFileHash } : {}),
      ...(input.file.mtimeMs !== undefined ? { sourceRevision: input.file.mtimeMs } : {}),
      fields,
      raw: {
        typeName: input.typeName,
        dataHash: stringValue(record.dataHash),
        ...(rowIndex === undefined ? {} : { rowIndex })
      }
    });
    if ((index + 1) % PARAM_DECODE_YIELD_BATCH_SIZE === 0) {
      throwIfAborted(input.signal);
      await yieldNativeSemanticRefresh();
    }
  }
  throwIfAborted(input.signal);
  return rows;
}

async function runWithConcurrencyPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const poolSize = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  const workers = Array.from({ length: poolSize }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      await fn(items[currentIndex]!, currentIndex);
    }
  });
  await Promise.all(workers);
}

async function readParamExports(
  file: IndexedFile,
  allowedRoots: string[],
  scratchRoot: string,
  input: NativeSemanticRefreshOptions,
  expectedOuterFileHash: string
): Promise<NativeSourceReadResult> {
  const entries = await listNativeEntries(file, allowedRoots, input, '.param', expectedOuterFileHash);
  if (entries.length === 0) throw new Error('PARAM native container 没有 .param 子项。');
  const metadata = await loadParamMetadata();
  if (!metadata.ok || !metadata.package) {
    throw new Error(metadata.diagnostics[0]?.message ?? 'PARAM 元数据不可用，拒绝生成无字段语义的 RAG。');
  }
  const paramPackage = metadata.package;
  const diagnostics: Diagnostic[] = [];
  let semanticCount = 0;
  let stale = false;

  const entryResults: Array<{
    entry: NativeContainerEntry;
    exported?: ParamExport;
    errorDiagnostic?: Diagnostic;
  }> = new Array(entries.length);

  await runWithConcurrencyPool(entries, 8, async (entry, idx) => {
    throwIfAborted(input.signal);
    try {
      const childPath = await materializeNativeEntry(file, entry, allowedRoots, scratchRoot, input);
      const readParamDocument = input.paramDocumentReader ?? readParamDocumentViaBridge;
      const result = await readParamDocument({
        sourcePath: childPath,
        allowedRoots: [...allowedRoots, scratchRoot],
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        maxRows: 100_000,
        includeAllPayloads: true,
        maxFrameBytes: 32 * 1024 * 1024,
        maxConcurrency: 8,
        resolveRowDataSize: async (header) => resolveTrustedParamRowWidth(paramPackage, header)
      });
      if (!result.ok || !result.data) {
        const first = result.diagnostics[0];
        throw new Error(`PARAM ${entry.name} native reread failed: ${first?.code ?? 'PARAM_READ_FAILED'} ${first?.message ?? file.sourceUri}`);
      }
      const data = result.data;
      if (data.rows.length < data.rowCount) {
        throw new Error(`PARAM ${entry.name} 返回截断行表 ${data.rows.length}/${data.rowCount}，拒绝把不完整语义写入 RAG。`);
      }
      const typeName = stringValue(data.typeName);
      const rowDataSize = numberValue(data.rowDataSize);
      const dataVersion = numberValue(data.dataVersion);
      const definition = dataVersion !== undefined && Number.isSafeInteger(dataVersion) && rowDataSize !== undefined
        ? resolveTrustedParamDefinition(paramPackage, {
            typeName,
            dataVersion,
            rowDataSize
          })
        : undefined;
      if (!definition) {
        throw new Error(`PARAM ${entry.name} 缺少严格匹配的授信字段定义：${typeName}/${dataVersion ?? 'unknown-version'}/${rowDataSize ?? 'unknown-width'}。`);
      }
      const tableName = stripLeafExtension(entry.name, '.param');
      const rows = await decodeNativeParamRows({
        file,
        sourceHash: data.sourceHash,
        outerFileHash: expectedOuterFileHash,
        tableName,
        entryName: entry.name,
        entryIndex: entry.index,
        typeName,
        definition,
        rows: arrayValue(data.rows),
        ...(input.referenceFieldsOnly ? { referenceFieldsOnly: true } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
      const exported: ParamExport = {
        paramName: tableName,
        sourceUri: file.sourceUri,
        entryName: entry.name,
        entryIndex: entry.index,
        ...(data.sourceHash ? { sourceHash: data.sourceHash } : {}),
        outerFileHash: expectedOuterFileHash,
        ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
        rows
      };
      entryResults[idx] = { entry, exported };
    } catch (error) {
      if (input.signal?.aborted || isAbortLike(error)) throw error;
      entryResults[idx] = {
        entry,
        errorDiagnostic: {
          severity: 'warning',
          code: 'NATIVE_PARAM_TABLE_SKIPPED',
          message: error instanceof Error ? error.message : String(error),
          sourceUri: file.sourceUri
        }
      };
    }
  });

  throwIfAborted(input.signal);
  for (const item of entryResults) {
    if (!item) continue;
    if (item.errorDiagnostic) {
      diagnostics.push(item.errorDiagnostic);
      continue;
    }
    if (item.exported) {
      if (input.index.upsertParamExport(item.exported)) {
        semanticCount += item.exported.rows.length;
      } else {
        stale = true;
        diagnostics.push({
          severity: 'warning',
          code: 'NATIVE_PARAM_TABLE_STALE',
          message: `PARAM ${item.entry.name} semantic projection was rejected because its source revision is stale.`,
          sourceUri: file.sourceUri
        });
      }
    }
  }

  return { complete: diagnostics.length === 0, semanticCount, stale, diagnostics };
}

async function readMsgExports(
  file: IndexedFile,
  allowedRoots: string[],
  scratchRoot: string,
  input: NativeSemanticRefreshOptions,
  expectedOuterFileHash: string
): Promise<NativeSourceReadResult> {
  const entries = await listNativeEntries(file, allowedRoots, input, '.fmg', expectedOuterFileHash);
  if (entries.length === 0) throw new Error('FMG native container 没有 .fmg 子项。');
  const diagnostics: Diagnostic[] = [];
  let semanticCount = 0;
  let stale = false;

  const msgResults: Array<{
    entry: NativeContainerEntry;
    exported?: MsgExport;
    errorDiagnostic?: Diagnostic;
  }> = new Array(entries.length);

  await runWithConcurrencyPool(entries, 8, async (entry, idx) => {
    throwIfAborted(input.signal);
    try {
      const childPath = await materializeNativeEntry(file, entry, allowedRoots, scratchRoot, input);
      const bridgeRunner = input.bridgeRunner ?? runBridge;
      const result = await bridgeRunner<Record<string, unknown>>({
        command: 'read-fmg-document',
        filePath: childPath,
        allowedRoots: [...allowedRoots, scratchRoot],
        maxConcurrency: 8,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        maxFrameBytes: 32 * 1024 * 1024
      });
      const data = requireBridgeData(result, file.sourceUri, `FMG ${entry.name}`);
      const category = stripLeafExtension(entry.name, '.fmg');
      const entriesRaw = arrayValue(data.entries);
      const msgEntries = entriesRaw.map((value, index) => {
        const record = recordValue(value);
        const textId = numberValue(record.id);
        if (textId === undefined || !Number.isSafeInteger(textId)) {
          throw new Error(`FMG ${entry.name} entries[${index}] 缺少合法 id。`);
        }
        return {
          uri: `${file.sourceUri}#${category}/${textId}`,
          sourceUri: file.sourceUri,
          category,
          entryIndex: index,
          textId,
          text: stringValue(record.text),
          confidence: 'high' as const,
          ...(stringValue(data.sourceHash) ? { sourceHash: stringValue(data.sourceHash) } : {}),
          outerFileHash: expectedOuterFileHash,
          ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
          raw: { child: entry.name }
        };
      });
      const exported: MsgExport = {
        category,
        ...(stringValue(data.sourceHash) ? { sourceHash: stringValue(data.sourceHash) } : {}),
        outerFileHash: expectedOuterFileHash,
        ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
        entries: msgEntries
      };
      msgResults[idx] = { entry, exported };
    } catch (error) {
      if (input.signal?.aborted || isAbortLike(error)) throw error;
      msgResults[idx] = {
        entry,
        errorDiagnostic: {
          severity: 'warning',
          code: 'NATIVE_FMG_TABLE_SKIPPED',
          message: error instanceof Error ? error.message : String(error),
          sourceUri: file.sourceUri
        }
      };
    }
  });

  throwIfAborted(input.signal);
  for (const item of msgResults) {
    if (!item) continue;
    if (item.errorDiagnostic) {
      diagnostics.push(item.errorDiagnostic);
      continue;
    }
    if (item.exported) {
      if (input.index.upsertMsgExport(item.exported)) {
        semanticCount += item.exported.entries.length;
      } else {
        stale = true;
        diagnostics.push({
          severity: 'warning',
          code: 'NATIVE_FMG_TABLE_STALE',
          message: `FMG ${item.entry.name} semantic projection was rejected because its source revision is stale.`,
          sourceUri: file.sourceUri
        });
      }
    }
  }

  return { complete: diagnostics.length === 0, semanticCount, stale, diagnostics };
}

async function listNativeEntries(
  file: IndexedFile,
  allowedRoots: string[],
  input: NativeSemanticRefreshOptions,
  extension: string,
  expectedOuterFileHash: string
): Promise<NativeContainerEntry[]> {
  const lower = file.absolutePath.toLowerCase();
  if (lower.endsWith(extension)) {
    return [{ index: -1, name: basename(file.absolutePath) }];
  }
  const bridgeRunner = input.bridgeRunner ?? runBridge;
  const result = await bridgeRunner<Record<string, unknown>>({
    command: 'read-dcx-document',
    filePath: file.absolutePath,
    resourceUri: file.sourceUri,
    allowedRoots,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    maxFrameBytes: 32 * 1024 * 1024
  });
  const data = requireBridgeData(result, file.sourceUri, 'native container');
  const reportedOuterFileHash = stringValue(data.outerFileHash) || stringValue(data.sourceHash);
  if (reportedOuterFileHash !== expectedOuterFileHash) {
    throw new Error('native container read outer hash 与固定 source receipt 不一致。');
  }
  const nested = recordValue(data.nested);
  return arrayValue(nested.entries).flatMap((value) => {
    const record = recordValue(value);
    const index = numberValue(record.index);
    const name = stringValue(record.name);
    return index !== undefined && Number.isSafeInteger(index) && name.toLowerCase().endsWith(extension)
      ? [{ index, name }]
      : [];
  });
}

async function materializeNativeEntry(
  file: IndexedFile,
  entry: NativeContainerEntry,
  allowedRoots: string[],
  scratchRoot: string,
  input: NativeSemanticRefreshOptions
): Promise<string> {
  if (entry.index < 0) return file.absolutePath;
  const outputPath = join(scratchRoot, `${entry.index}-${safeSegment(stripLeafExtension(entry.name, ''))}${extensionOf(entry.name)}`);
  const bridgeRunner = input.bridgeRunner ?? runBridge;
  const result = await bridgeRunner<Record<string, unknown>>({
    command: 'extract-bnd4-child',
    filePath: file.absolutePath,
    resourceUri: file.sourceUri,
    allowedRoots: [...allowedRoots, scratchRoot],
    writableRoots: [scratchRoot],
    maxConcurrency: 8,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    commandOptions: { entryIndex: entry.index, outputPath }
  });
  requireBridgeData(result, file.sourceUri, `extract ${entry.name}`);
  return outputPath;
}

async function loadParamMetadata(): Promise<ParamMetadataCache> {
  if (paramMetadataCache) return paramMetadataCache;
  const loaded = loadFirstPartyParamMetadata();
  paramMetadataCache = loaded.ok
    ? { ok: true, package: loaded.package, diagnostics: [] }
    : {
        ok: false,
        diagnostics: loaded.diagnostics.map((diagnostic) => ({
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message
        }))
      };
  return paramMetadataCache;
}

function resolveTrustedParamRowWidth(
  metadata: ParamMetadataPackage,
  header: { typeName: string; dataVersion: number }
): number | undefined {
  return resolveParamMetadataRowWidth(
    metadata,
    { game: 'sekiro', gameBuild: '1.6', typeName: header.typeName, dataVersion: header.dataVersion }
  );
}

function resolveTrustedParamDefinition(
  metadata: ParamMetadataPackage,
  input: { typeName: string; dataVersion: number; rowDataSize: number }
): ParamDefDocument | undefined {
  const matched = matchParamMetadataPackage(
    metadata,
    {
      game: 'sekiro',
      gameBuild: '1.6',
      typeName: input.typeName,
      dataVersion: input.dataVersion,
      rowDataSize: input.rowDataSize
    },
    undefined
  );
  return matched.ok ? matched.definition.document : undefined;
}

function requireBridgeData<T>(result: BridgeResult<T>, sourceUri: string, label: string): T {
  if (result.parseStatus === 'failed' || result.data === null || result.data === undefined) {
    const first = result.diagnostics[0];
    throw new Error(`${label} native reread failed: ${first?.code ?? 'BRIDGE_READ_FAILED'} ${first?.message ?? sourceUri}`);
  }
  return result.data;
}

function refreshAllowedRoots(
  input: NativeSemanticRefreshOptions,
  file: IndexedFile,
  scratchRoot: string
): string[] {
  return uniquePaths([
    ...(input.allowedRoots ?? []),
    dirname(file.absolutePath),
    scratchRoot,
    ...(input.oodleRuntimeRoot ? [input.oodleRuntimeRoot] : [])
  ]);
}

/**
 * Capture one immutable source receipt for a refresh.  The catalog hash is
 * checked against the bytes actually copied; all Bridge calls then target the
 * copy, never the mutable workspace path.  A stat-before/stat-after mismatch
 * is treated as stale and does not publish a partial semantic projection.
 */
async function captureNativeSourceSnapshot(
  file: IndexedFile,
  scratchRoot: string,
  signal?: AbortSignal
): Promise<NativeSourceSnapshot | undefined> {
  throwIfAborted(signal);
  const before = await stat(file.absolutePath);
  const bytes = await readFile(file.absolutePath);
  throwIfAborted(signal);
  const after = await stat(file.absolutePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return undefined;

  const outerFileHash = createHash('sha256').update(bytes).digest('hex');
  if (file.sha256 && file.sha256 !== outerFileHash) return undefined;

  const sourceToken = createHash('sha256').update(file.sourceUri).digest('hex').slice(0, 16);
  const snapshotPath = join(
    scratchRoot,
    `${sourceToken}-${safeSegment(basename(file.absolutePath))}`
  );
  await writeFile(snapshotPath, bytes);
  return { path: snapshotPath, outerFileHash };
}

function uniqueFiles(files: readonly IndexedFile[]): IndexedFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.sourceUri)) return false;
    seen.add(file.sourceUri);
    return true;
  });
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.map((path) => resolve(path)).filter((path) => {
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function assignNumber(
  target: object,
  key: string,
  value: unknown
): void {
  const number = numberValue(value);
  if (number !== undefined) Object.assign(target, { [key]: number });
}

function stripNativeExtension(path: string, extension: 'emevd' | 'msb'): string {
  const normalized = path.replaceAll('\\', '/');
  const marker = new RegExp(`\\.${extension}(?:\\.dcx)?$`, 'i');
  return basename(normalized).replace(marker, '');
}

function stripLeafExtension(name: string, extension: string): string {
  const leaf = name.replaceAll('\\', '/').split('/').pop() ?? name;
  return extension.length > 0
    ? leaf.replace(new RegExp(`${escapeRegExp(extension)}$`, 'i'), '')
    : leaf;
}

function extensionOf(name: string): string {
  const leaf = name.replaceAll('\\', '/').split('/').pop() ?? name;
  const index = leaf.lastIndexOf('.');
  return index > 0 ? leaf.slice(index) : '.bin';
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'native';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('native semantic refresh aborted');
  error.name = 'AbortError';
  throw error;
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || /\b(abort|cancel)ed?\b/i.test(error.message);
}

function yieldNativeSemanticRefresh(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
