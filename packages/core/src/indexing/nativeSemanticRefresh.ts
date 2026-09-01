/**
 * Rebuild semantic projections for native files after a committed write.
 *
 * `scanWorkspace` only knows the outer file catalog.  Sekiro's EMEVD/MSB
 * files may be directly readable by Bridge, while PARAM/FMG semantic rows
 * live inside DCX/BND children.  Keeping this boundary here prevents the
 * post-commit refresh from declaring convergence after merely changing the
 * outer file hash.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  Diagnostic,
  EventExport,
  IndexedFile,
  MapExport,
  MsgExport,
  ParamMetadataPackage,
  ParamExport,
  ParamFieldSymbol,
  ParamRowSymbol,
  BridgeResult
} from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { decodeRowFields } from '../param/paramdefLayout.js';
import { importPinnedSmithboxSdtParamMetadata } from '../param/smithboxParamMetadataSource.js';
import { mapExportFromMsbDocument } from './ingestBridgeResult.js';
import { WorkspaceIndex } from './workspaceIndex.js';

export interface NativeSemanticRefreshOptions {
  index: WorkspaceIndex;
  sourceFiles: readonly IndexedFile[];
  stagingRoot: string;
  allowedRoots?: readonly string[];
  oodleRuntimeRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NativeSemanticRefreshResult {
  refreshedSources: string[];
  partialSources: string[];
  failedSources: string[];
  diagnostics: Diagnostic[];
}

interface NativeSourceReadResult {
  complete: boolean;
  semanticCount: number;
  diagnostics: Diagnostic[];
}

interface NativeContainerEntry {
  index: number;
  name: string;
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
    return { refreshedSources: [], partialSources: [], failedSources: [], diagnostics: [] };
  }

  await mkdir(input.stagingRoot, { recursive: true });
  const scratchRoot = await mkdtemp(join(resolve(input.stagingRoot), 'native-semantic-refresh-'));
  const diagnostics: Diagnostic[] = [];
  const refreshedSources: string[] = [];
  const partialSources: string[] = [];
  const failedSources: string[] = [];
  try {
    for (const file of sourceFiles) {
      try {
        throwIfAborted(input.signal);
        const roots = refreshAllowedRoots(input, file, scratchRoot);
        if (file.resourceKind === 'event') {
          const eventExport = await readEventExport(file, roots, input);
          input.index.upsertEventExport(eventExport);
        } else if (file.resourceKind === 'map') {
          const mapExport = await readMapExport(file, roots, input);
          input.index.upsertMapExport(mapExport);
        } else if (file.resourceKind === 'param') {
          const result = await readParamExports(file, roots, scratchRoot, input);
          diagnostics.push(...result.diagnostics);
          if (result.semanticCount === 0) {
            throw new Error('PARAM native reread 没有产出任何完整表的 semantic rows。');
          }
          if (!result.complete) partialSources.push(file.sourceUri);
        } else if (file.resourceKind === 'msg') {
          const result = await readMsgExports(file, roots, scratchRoot, input);
          diagnostics.push(...result.diagnostics);
          if (result.semanticCount === 0) {
            throw new Error('FMG native reread 没有产出任何 semantic entries。');
          }
          if (!result.complete) partialSources.push(file.sourceUri);
        }
        refreshedSources.push(file.sourceUri);
      } catch (error) {
        failedSources.push(file.sourceUri);
        diagnostics.push({
          severity: 'error',
          code: 'NATIVE_SEMANTIC_REFRESH_FAILED',
          message: error instanceof Error ? error.message : String(error),
          sourceUri: file.sourceUri
        });
      }
    }
    input.index.rebuildReferences();
    return { refreshedSources, partialSources, failedSources, diagnostics };
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

async function readEventExport(
  file: IndexedFile,
  allowedRoots: string[],
  input: NativeSemanticRefreshOptions
): Promise<EventExport> {
  const result = await runBridge<Record<string, unknown>>({
    command: 'read-emevd-document',
    filePath: file.absolutePath,
    resourceUri: file.sourceUri,
    allowedRoots,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    maxFrameBytes: 32 * 1024 * 1024,
    commandOptions: {
      cachePolicy: 'bypass',
      instructionPage: 0,
      instructionPageSize: 65_536
    }
  });
  const data = requireBridgeData(result, file.sourceUri, 'EMEVD');
  const eventsRaw = arrayValue(data.events);
  if (eventsRaw.length === 0 && numberValue(data.eventCount) !== 0) {
    throw new Error('EMEVD native read returned no event table.');
  }
  const sourceHash = file.sha256;
  const sourceRevision = file.mtimeMs;
  const mapId = stripNativeExtension(file.relativePath || file.absolutePath, 'emevd');
  const events = eventsRaw.map((value, index) => {
    const record = recordValue(value);
    const eventId = numberValue(record.id) ?? numberValue(record.eventId);
    if (eventId === undefined || !Number.isSafeInteger(eventId)) {
      throw new Error(`EMEVD events[${index}] 缺少合法 id。`);
    }
    const raw: Record<string, unknown> = {
      authority: 'native-verified-outline',
      instructionCount: numberValue(record.instructionCount) ?? 0,
      restBehavior: numberValue(record.restBehavior) ?? 0,
      parameterCount: Array.isArray(record.parameters) ? record.parameters.length : 0,
      parameters: Array.isArray(record.parameters) ? record.parameters : []
    };
    return {
      uri: `${file.sourceUri}#event/${eventId}`,
      sourceUri: file.sourceUri,
      mapId,
      eventId,
      ...(sourceHash ? { sourceHash } : {}),
      ...(sourceRevision !== undefined ? { sourceRevision } : {}),
      instructions: [],
      raw
    };
  });
  return {
    mapId,
    ...(sourceHash ? { sourceHash } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    events
  };
}

async function readMapExport(
  file: IndexedFile,
  allowedRoots: string[],
  input: NativeSemanticRefreshOptions
): Promise<MapExport> {
  const result = await runBridge<Record<string, unknown>>({
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
  const mapId = stripNativeExtension(file.relativePath || file.absolutePath, 'msb');
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
    return region;
  });
  return mapExportFromMsbDocument({
    mapId,
    sourceUri: file.sourceUri,
    ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
    ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
    parts,
    regions
  });
}

async function readParamExports(
  file: IndexedFile,
  allowedRoots: string[],
  scratchRoot: string,
  input: NativeSemanticRefreshOptions
): Promise<NativeSourceReadResult> {
  const entries = await listNativeEntries(file, allowedRoots, input, '.param');
  if (entries.length === 0) throw new Error('PARAM native container 没有 .param 子项。');
  const metadata = await loadParamMetadata();
  if (!metadata.ok || !metadata.package) {
    throw new Error(metadata.diagnostics[0]?.message ?? 'PARAM 元数据不可用，拒绝生成无字段语义的 RAG。');
  }
  const diagnostics: Diagnostic[] = [];
  let semanticCount = 0;
  for (const entry of entries) {
    throwIfAborted(input.signal);
    try {
      const childPath = await materializeNativeEntry(file, entry, allowedRoots, scratchRoot, input);
      const result = await runBridge<Record<string, unknown>>({
        command: 'read-param-document',
        filePath: childPath,
        allowedRoots: [...allowedRoots, scratchRoot],
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        maxFrameBytes: 32 * 1024 * 1024,
        commandOptions: { includeAllPayloads: true, rowPage: 0, rowPageSize: 100_000 }
      });
      const data = requireBridgeData(result, file.sourceUri, `PARAM ${entry.name}`);
      if (data.rowsTruncated === true) {
        throw new Error(`PARAM ${entry.name} 返回截断行表，拒绝把不完整语义写入 RAG。`);
      }
      const typeName = stringValue(data.typeName);
      const rowDataSize = numberValue(data.rowDataSize);
      const definition = metadata.package.definitions.find((candidate) => (
        candidate.document.typeName === typeName
        && candidate.document.rowDataSize === rowDataSize
      ))?.document;
      if (!definition) {
        throw new Error(`PARAM ${entry.name} 缺少匹配的授信字段定义：${typeName}/${rowDataSize ?? 'unknown'}。`);
      }
      const tableName = stripLeafExtension(entry.name, '.param');
      const rowsRaw = arrayValue(data.rows);
      const rows: ParamRowSymbol[] = rowsRaw.map((value, index) => {
        const record = recordValue(value);
        const rowId = numberValue(record.id);
        const dataBase64 = stringValue(record.dataBase64);
        if (rowId === undefined || !Number.isSafeInteger(rowId) || dataBase64.length === 0) {
          throw new Error(`PARAM ${entry.name} rows[${index}] 缺少合法 id/dataBase64。`);
        }
        const bytes = Buffer.from(dataBase64, 'base64');
        if (bytes.length !== definition.rowDataSize) {
          throw new Error(`PARAM ${entry.name}#${rowId} 行宽 ${bytes.length} != ${definition.rowDataSize}。`);
        }
        const fields: ParamFieldSymbol[] = decodeRowFields(bytes, definition).map((field) => {
          const definitionField = definition.fields.find((candidate) => candidate.id === field.fieldId);
          return {
            fieldId: field.fieldId,
            name: field.name,
            type: field.type,
            ...(definitionField?.description ? { description: definitionField.description } : {}),
            value: field.value
          };
        });
        const row: ParamRowSymbol = {
          uri: `${file.sourceUri}#${tableName}/${rowId}`,
          sourceUri: file.sourceUri,
          paramName: tableName,
          rowId,
          ...(stringValue(record.name) ? { rowName: stringValue(record.name) } : {}),
          ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
          ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
          fields,
          raw: { typeName, dataHash: stringValue(record.dataHash) }
        };
        return row;
      });
      const exported: ParamExport = {
        paramName: tableName,
        ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
        ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
        rows
      };
      input.index.upsertParamExport(exported);
      semanticCount += rows.length;
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'NATIVE_PARAM_TABLE_SKIPPED',
        message: error instanceof Error ? error.message : String(error),
        sourceUri: file.sourceUri
      });
    }
  }
  return { complete: diagnostics.length === 0, semanticCount, diagnostics };
}

async function readMsgExports(
  file: IndexedFile,
  allowedRoots: string[],
  scratchRoot: string,
  input: NativeSemanticRefreshOptions
): Promise<NativeSourceReadResult> {
  const entries = await listNativeEntries(file, allowedRoots, input, '.fmg');
  if (entries.length === 0) throw new Error('FMG native container 没有 .fmg 子项。');
  const diagnostics: Diagnostic[] = [];
  let semanticCount = 0;
  for (const entry of entries) {
    throwIfAborted(input.signal);
    try {
      const childPath = await materializeNativeEntry(file, entry, allowedRoots, scratchRoot, input);
      const result = await runBridge<Record<string, unknown>>({
        command: 'read-fmg-document',
        filePath: childPath,
        allowedRoots: [...allowedRoots, scratchRoot],
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        maxFrameBytes: 32 * 1024 * 1024
      });
      const data = requireBridgeData(result, file.sourceUri, `FMG ${entry.name}`);
      const category = stripLeafExtension(entry.name, '.fmg');
      const entriesRaw = arrayValue(data.entries);
      const entries = entriesRaw.map((value, index) => {
        const record = recordValue(value);
        const textId = numberValue(record.id);
        if (textId === undefined || !Number.isSafeInteger(textId)) {
          throw new Error(`FMG ${entry.name} entries[${index}] 缺少合法 id。`);
        }
        return {
          uri: `${file.sourceUri}#${category}/${textId}`,
          sourceUri: file.sourceUri,
          category,
          textId,
          text: stringValue(record.text),
          confidence: 'high' as const,
          ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
          ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
          raw: { child: entry.name }
        };
      });
      const exported: MsgExport = {
        category,
        ...(file.sha256 ? { sourceHash: file.sha256 } : {}),
        ...(file.mtimeMs !== undefined ? { sourceRevision: file.mtimeMs } : {}),
        entries
      };
      input.index.upsertMsgExport(exported);
      semanticCount += entries.length;
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'NATIVE_FMG_TABLE_SKIPPED',
        message: error instanceof Error ? error.message : String(error),
        sourceUri: file.sourceUri
      });
    }
  }
  return { complete: diagnostics.length === 0, semanticCount, diagnostics };
}

async function listNativeEntries(
  file: IndexedFile,
  allowedRoots: string[],
  input: NativeSemanticRefreshOptions,
  extension: string
): Promise<NativeContainerEntry[]> {
  const lower = file.absolutePath.toLowerCase();
  if (lower.endsWith(extension)) {
    return [{ index: -1, name: basename(file.absolutePath) }];
  }
  const result = await runBridge<Record<string, unknown>>({
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
  const result = await runBridge<Record<string, unknown>>({
    command: 'extract-bnd4-child',
    filePath: file.absolutePath,
    allowedRoots: [...allowedRoots, scratchRoot],
    writableRoots: [scratchRoot],
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
  const local = process.env.LOCALAPPDATA;
  if (!local) {
    paramMetadataCache = {
      ok: false,
      diagnostics: [{ severity: 'error', code: 'PARAM_METADATA_NO_LOCALAPPDATA', message: '无法定位 LOCALAPPDATA。' }]
    };
    return paramMetadataCache;
  }
  const imported = await importPinnedSmithboxSdtParamMetadata({
    cacheRoot: join(local, 'SoulForge', 'tools', 'smithbox', '2.2.4')
  });
  paramMetadataCache = imported.ok
    ? { ok: true, package: imported.package, diagnostics: [] }
    : {
        ok: false,
        diagnostics: imported.diagnostics.map((diagnostic) => ({
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message
        }))
      };
  return paramMetadataCache;
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
  if (signal?.aborted) throw new Error('native semantic refresh aborted');
}
