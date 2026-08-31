/**
 * Agent / CLI PARAM field facade.
 *
 * Read and set named fields on rows inside gameparam.parambnd.dcx.
 * Encoding uses applyParamFieldMutation; unpack uses extract-bnd4-child;
 * write uses write-param mutations[] then write-bnd4 + applyNativeMutation.
 * Do not parse Smithbox XML here and do not scan BND by brute-force index.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Diagnostic, ParamDefDocument } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { applyNativeMutation } from '../editing/editorMutationService.js';
import {
  commitParamMutationsViaBridge,
  readParamDocumentViaBridge
} from '../editing/paramBridgeCommit.js';
import { stageBridgeOutput } from '../editing/bridgeStaging.js';
import type { NativeEditSession } from '../editing/nativeEditSession.js';
import { applyParamFieldMutation } from './paramFieldMutation.js';
import { decodeRowFields } from './paramdefLayout.js';
import { importPinnedSmithboxSdtParamMetadata } from './smithboxParamMetadataSource.js';

export interface ParamFieldEdit {
  table: string;
  rowId: number;
  fieldId: string;
  value: number | string | boolean;
}

export interface ParamFieldReadQuery {
  table: string;
  rowIds: number[];
  fieldIds: string[];
}

export interface ParamFieldSnapshot {
  table: string;
  rowId: number;
  /** Native row name returned by the PARAM document, when available. */
  rowName?: string;
  fieldId: string;
  displayName?: string;
  description?: string;
  /** Provenance returned by the same native document read, never a cached index fallback. */
  sourceHash?: string;
  sourceRevision?: number;
  value: number | string | boolean | null;
}

export interface ParamEditFailure {
  code: string;
  message: string;
  details?: unknown;
}

export type ParamReadResult =
  | {
      ok: true;
      containerPath: string;
      fields: ParamFieldSnapshot[];
      missingRows: Array<{ table: string; rowId: number }>;
      diagnostics: Diagnostic[];
    }
  | { ok: false; error: ParamEditFailure; diagnostics: Diagnostic[] };

export type ParamSetResult =
  | {
      ok: true;
      containerPath: string;
      before: ParamFieldSnapshot[];
      after: ParamFieldSnapshot[];
      changedTables: string[];
      diagnostics: Diagnostic[];
    }
  | { ok: false; error: ParamEditFailure; diagnostics: Diagnostic[]; before?: ParamFieldSnapshot[] };

interface ContainerEntry {
  index: number;
  name: string;
  contentHash: string;
}

let metadataCache: Awaited<ReturnType<typeof importPinnedSmithboxSdtParamMetadata>> | null = null;

export function groupParamEdits(edits: ParamFieldEdit[]): Map<string, ParamFieldEdit[]> {
  const groups = new Map<string, ParamFieldEdit[]>();
  for (const edit of edits) {
    const key = normalizeTableToken(edit.table);
    const list = groups.get(key) ?? [];
    list.push(edit);
    groups.set(key, list);
  }
  return groups;
}

export function applyEditsToRowBytes(input: {
  rowDataBase64: string;
  definition: ParamDefDocument;
  edits: Array<{ fieldId: string; value: number | string | boolean }>;
}):
  | { ok: true; nextDataBase64: string; before: Record<string, number | string | boolean | null>; after: Record<string, number | string | boolean | null> }
  | { ok: false; code: string; message: string } {
  let data = input.rowDataBase64;
  const before: Record<string, number | string | boolean | null> = {};
  const after: Record<string, number | string | boolean | null> = {};
  for (const edit of input.edits) {
    const current = readFieldValue(data, input.definition, edit.fieldId);
    before[edit.fieldId] = current;
    const applied = applyParamFieldMutation({
      rowDataBase64: data,
      definition: input.definition,
      fieldId: edit.fieldId,
      value: edit.value
    });
    if (!applied.ok) return applied;
    data = applied.nextDataBase64;
    after[edit.fieldId] = readFieldValue(data, input.definition, edit.fieldId);
  }
  return { ok: true, nextDataBase64: data, before, after };
}

export async function resolveGameparamContainer(
  overlayRoot: string,
  explicit?: string
): Promise<{ ok: true; path: string } | { ok: false; error: ParamEditFailure }> {
  if (explicit) {
    let cleanPath = explicit.trim();
    if (cleanPath.startsWith('file:///')) {
      try {
        cleanPath = fileURLToPath(cleanPath);
      } catch {
        cleanPath = cleanPath.slice(8);
      }
    } else if (cleanPath.startsWith('file://')) {
      cleanPath = cleanPath.slice(7);
    }
    const resolved = isAbsolute(cleanPath)
      ? resolve(cleanPath)
      : resolve(overlayRoot, cleanPath);
    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        return { ok: false, error: { code: 'PARAM_CONTAINER_NOT_FILE', message: `不是文件：${resolved}` } };
      }
    } catch {
      return { ok: false, error: { code: 'PARAM_CONTAINER_MISSING', message: `找不到容器：${resolved}` } };
    }
    return { ok: true, path: resolved };
  }
  const preferred = [
    join(overlayRoot, 'param', 'gameparam', 'gameparam.parambnd.dcx'),
    join(overlayRoot, 'param', 'gameparam.parambnd.dcx')
  ];
  for (const candidate of preferred) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return { ok: true, path: candidate };
    } catch {
      // try next
    }
  }
  const found = await findParamBnd(overlayRoot);
  if (found.length === 1) return { ok: true, path: found[0]! };
  if (found.length === 0) {
    return {
      ok: false,
      error: {
        code: 'PARAM_CONTAINER_NOT_FOUND',
        message: '工作区里没有 gameparam.parambnd.dcx。请传 --container。'
      }
    };
  }
  return {
    ok: false,
    error: {
      code: 'PARAM_CONTAINER_AMBIGUOUS',
      message: `找到多份 parambnd，请指定 --container：${found.join(' | ')}`
    }
  };
}

export async function readParamFields(input: {
  edit: NativeEditSession;
  queries: ParamFieldReadQuery[];
  containerPath?: string;
}): Promise<ParamReadResult> {
  const container = await resolveGameparamContainer(input.edit.session.layers.overlayRoot, input.containerPath);
  if (!container.ok) return { ok: false, error: container.error, diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const fields: ParamFieldSnapshot[] = [];
  const missingRows: Array<{ table: string; rowId: number }> = [];
  let sourceRevision: number | undefined;
  try {
    sourceRevision = (await stat(container.path)).mtimeMs;
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'PARAM_SOURCE_REVISION_UNAVAILABLE',
      message: error instanceof Error ? error.message : '无法读取 PARAM 容器的 source revision。',
      sourceUri: pathToFileURL(container.path).href
    });
  }
  const entries = await listParamEntries(input.edit, container.path);
  if (!entries.ok) return { ok: false, error: entries.error, diagnostics: entries.diagnostics };
  for (const query of input.queries) {
    const loaded = await loadTableRows(input.edit, container.path, entries.entries, query.table, query.rowIds, true);
    if (!loaded.ok) return { ok: false, error: loaded.error, diagnostics: [...diagnostics, ...loaded.diagnostics] };
    diagnostics.push(...loaded.diagnostics);
    for (const rowId of query.rowIds) {
      const row = loaded.rows.get(rowId);
      if (!row) {
        missingRows.push({ table: loaded.tableName, rowId });
        continue;
      }
      let foundAnyField = false;
      // An empty fieldIds list is an explicit request for the complete
      // trusted row projection. This lets the agent inspect a richly named
      // PARAM row before it has to guess a field id, while the writer still
      // requires explicit field ids for mutations.
      const requestedFieldIds = query.fieldIds.length > 0
        ? query.fieldIds
        : loaded.definition.fields.map((field) => field.id);
      for (const fieldId of requestedFieldIds) {
        const field = loaded.definition.fields.find((item) => item.id === fieldId);
        if (!field) {
          diagnostics.push({
            severity: 'warning',
            code: 'PARAM_FIELD_NOT_FOUND',
            message: `${query.table}.${fieldId} 不在授信定义里。`
          });
          continue;
        }
        foundAnyField = true;
        fields.push({
          table: loaded.tableName,
          rowId,
          ...(row.name ? { rowName: row.name } : {}),
          fieldId,
          ...(field.name && field.name !== fieldId ? { displayName: field.name } : {}),
          ...(field.description ? { description: field.description } : {}),
          sourceHash: loaded.sourceHash,
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          value: readFieldValue(row.dataBase64, loaded.definition, fieldId)
        });
      }
      if (!foundAnyField && requestedFieldIds.length > 0) {
        return {
          ok: false,
          error: { code: 'PARAM_FIELD_NOT_FOUND', message: `${query.table} 请求的字段均不在授信定义里（${requestedFieldIds.join(', ')}）。` },
          diagnostics
        };
      }
    }
  }
  if (fields.length === 0 && missingRows.length > 0) {
    return {
      ok: false,
      error: {
        code: 'PARAM_ROW_NOT_FOUND',
        message: `请求的 PARAM 行均不存在：${missingRows.map((row) => `${row.table}#${row.rowId}`).join(', ')}`
      },
      diagnostics
    };
  }
  return { ok: true, containerPath: container.path, fields, missingRows, diagnostics };
}

export async function setParamFields(input: {
  edit: NativeEditSession;
  edits: ParamFieldEdit[];
  containerPath?: string;
}): Promise<ParamSetResult> {
  if (input.edits.length === 0) {
    return { ok: false, error: { code: 'PARAM_EDIT_EMPTY', message: '没有要写入的字段。' }, diagnostics: [] };
  }
  const container = await resolveGameparamContainer(input.edit.session.layers.overlayRoot, input.containerPath);
  if (!container.ok) return { ok: false, error: container.error, diagnostics: [] };
  const file = await input.edit.indexFile(container.path, 'param');
  const entries = await listParamEntries(input.edit, container.path);
  if (!entries.ok) return { ok: false, error: entries.error, diagnostics: entries.diagnostics };

  const grouped = groupParamEdits(input.edits);
  const before: ParamFieldSnapshot[] = [];
  const after: ParamFieldSnapshot[] = [];
  const changedTables: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let containerHash = file.sha256 ?? await sha256Of(container.path);

  for (const [, tableEdits] of grouped) {
    const table = tableEdits[0]!.table;
    const rowIds = [...new Set(tableEdits.map((item) => item.rowId))];
    const loaded = await loadTableRows(input.edit, container.path, entries.entries, table, rowIds);
    if (!loaded.ok) {
      return { ok: false, error: loaded.error, diagnostics: [...diagnostics, ...loaded.diagnostics], before };
    }
    diagnostics.push(...loaded.diagnostics);
    const mutations: Array<{ kind: 'upsert'; id: number; dataBase64: string }> = [];
    const byRow = new Map<number, ParamFieldEdit[]>();
    for (const edit of tableEdits) {
      const list = byRow.get(edit.rowId) ?? [];
      list.push(edit);
      byRow.set(edit.rowId, list);
    }
    for (const [rowId, rowEdits] of byRow) {
      const row = loaded.rows.get(rowId);
      if (!row) {
        return {
          ok: false,
          error: { code: 'PARAM_ROW_NOT_FOUND', message: `${table}#${rowId} 不存在。` },
          diagnostics,
          before
        };
      }
      const applied = applyEditsToRowBytes({
        rowDataBase64: row.dataBase64,
        definition: loaded.definition,
        edits: rowEdits.map((item) => ({ fieldId: item.fieldId, value: item.value }))
      });
      if (!applied.ok) {
        return {
          ok: false,
          error: { code: applied.code, message: `${table}#${rowId}: ${applied.message}` },
          diagnostics,
          before
        };
      }
      for (const edit of rowEdits) {
        const field = loaded.definition.fields.find((item) => item.id === edit.fieldId);
        before.push({
          table: loaded.tableName,
          rowId,
          ...(row.name ? { rowName: row.name } : {}),
          fieldId: edit.fieldId,
          ...(field?.name && field.name !== edit.fieldId ? { displayName: field.name } : {}),
          ...(field?.description ? { description: field.description } : {}),
          value: applied.before[edit.fieldId] ?? null
        });
        after.push({
          table: loaded.tableName,
          rowId,
          ...(row.name ? { rowName: row.name } : {}),
          fieldId: edit.fieldId,
          ...(field?.name && field.name !== edit.fieldId ? { displayName: field.name } : {}),
          ...(field?.description ? { description: field.description } : {}),
          value: applied.after[edit.fieldId] ?? null
        });
      }
      if (applied.nextDataBase64 !== row.dataBase64) {
        mutations.push({ kind: 'upsert', id: rowId, dataBase64: applied.nextDataBase64 });
      }
    }
    if (mutations.length === 0) continue;

    const committed = await commitTableMutations({
      edit: input.edit,
      file: { ...file, sha256: containerHash },
      containerPath: container.path,
      containerHash,
      entry: loaded.entry,
      unpackedPath: loaded.unpackedPath,
      unpackedHash: loaded.sourceHash,
      mutations,
      title: `PARAM set ${mutations.length} row(s) in ${loaded.tableName}`
    });
    if (!committed.ok) {
      return { ok: false, error: committed.error, diagnostics: [...diagnostics, ...committed.diagnostics], before };
    }
    diagnostics.push(...committed.diagnostics);
    changedTables.push(loaded.tableName);
    containerHash = committed.nextContainerHash;
    file.sha256 = containerHash;
    const refreshed = entries.entries.find((item) => item.index === loaded.entry.index);
    if (refreshed) refreshed.contentHash = '';
  }

  return {
    ok: true,
    containerPath: container.path,
    before,
    after,
    changedTables,
    diagnostics
  };
}

async function commitTableMutations(input: {
  edit: NativeEditSession;
  file: Awaited<ReturnType<NativeEditSession['indexFile']>>;
  containerPath: string;
  containerHash: string;
  entry: ContainerEntry;
  unpackedPath: string;
  unpackedHash: string;
  mutations: Array<{ kind: 'upsert'; id: number; dataBase64: string }>;
  title: string;
}): Promise<
  | { ok: true; nextContainerHash: string; diagnostics: Diagnostic[] }
  | { ok: false; error: ParamEditFailure; diagnostics: Diagnostic[] }
> {
  const { edit } = input;
  const allowedRoots = () => [...edit.allowedRoots(), dirname(input.unpackedPath)];
  const paramStage = await stageBridgeOutput({
    stagingRoot: edit.stagingRoot,
    prefix: 'param-field',
    fileName: `${safeSegment(input.entry.name)}.mutated`,
    allowedRoots,
    write: async (context) => commitParamMutationsViaBridge({
      sourcePath: input.unpackedPath,
      outputPath: context.outputPath,
      expectedDocumentHash: input.unpackedHash,
      allowedRoots: context.allowedRoots,
      writableRoots: context.writableRoots,
      mutations: input.mutations,
      timeoutMs: 120_000
    })
  });
  if (!paramStage.ok || !paramStage.bytes) {
    const diagnostics: Diagnostic[] = [
      ...paramStage.diagnostics.map((item) => ({
        severity: item.severity as Diagnostic['severity'],
        code: item.code,
        message: item.message,
        sourceUri: input.file.sourceUri
      })),
      ...(paramStage.result?.diagnostics ?? []).map((item) => ({
        severity: item.severity as Diagnostic['severity'],
        code: item.code,
        message: item.message,
        sourceUri: input.file.sourceUri
      }))
    ];
    return {
      ok: false,
      error: { code: 'PARAM_FIELD_STAGE_FAILED', message: '字段改动未能产出裸 param 暂存文件，容器未被修改。' },
      diagnostics
    };
  }

  const childBase64 = paramStage.bytes.toString('base64');
  const outcome = await applyNativeMutation({
    file: input.file,
    sourceUri: input.file.sourceUri,
    expectedHash: input.containerHash,
    stagingRoot: edit.stagingRoot,
    allowedRoots: () => [...edit.allowedRoots()],
    stagingPrefix: 'parambnd',
    stagingFileName: `${basename(input.containerPath)}.repacked`,
    stageWrite: async (context) => {
      const written = await runBridge<Record<string, unknown>>({
        command: 'write-bnd4',
        filePath: input.containerPath,
        resourceUri: input.file.sourceUri,
        allowedRoots: context.allowedRoots,
        writableRoots: context.writableRoots,
        timeoutMs: 180_000,
        maxFrameBytes: 32 * 1024 * 1024,
        ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
        commandOptions: {
          outputPath: context.outputPath,
          mutation: 'replace',
          expectedContainerHash: input.containerHash,
          entryIndex: input.entry.index,
          expectedChildHash: input.entry.contentHash || await sha256Of(input.unpackedPath),
          contentBase64: childBase64
        }
      });
      return {
        ok: written.parseStatus !== 'failed'
          && written.diagnostics.some((item) => item.code === 'BND4_STAGING_WRITE_VERIFIED'),
        diagnostics: written.diagnostics
      };
    },
    title: input.title,
    confirmActionLabel: '提交容器内 PARAM 字段变更'
  }, { commit: edit.commitPort });

  if (outcome.status !== 'committed' || !outcome.result.ok) {
    const diagnostics = outcome.status === 'failed'
      ? outcome.diagnostics
      : outcome.status === 'committed'
        ? outcome.result.diagnostics
        : [{
          severity: 'error' as const,
          code: 'PARAM_WRITE_CANCELLED',
          message: '写入被取消。',
          sourceUri: input.file.sourceUri
        }];
    return {
      ok: false,
      error: { code: diagnostics[0]?.code ?? 'PARAM_WRITE_FAILED', message: diagnostics[0]?.message ?? '容器写入失败。' },
      diagnostics
    };
  }
  return {
    ok: true,
    nextContainerHash: await sha256Of(input.containerPath),
    diagnostics: outcome.result.diagnostics
  };
}

async function loadTableRows(
  edit: NativeEditSession,
  containerPath: string,
  entries: ContainerEntry[],
  table: string,
  rowIds: number[],
  allowMissingRows = false
): Promise<
  | {
      ok: true;
      tableName: string;
      entry: ContainerEntry;
      definition: ParamDefDocument;
      rows: Map<number, { id: number; dataBase64: string; name?: string }>;
      unpackedPath: string;
      sourceHash: string;
      missingRows: number[];
      diagnostics: Diagnostic[];
    }
  | { ok: false; error: ParamEditFailure; diagnostics: Diagnostic[] }
> {
  const entry = findTableEntry(entries, table);
  if (!entry) {
    return {
      ok: false,
      error: {
        code: 'PARAM_TABLE_NOT_FOUND',
        message: `容器内没有表 ${table}。`,
        details: { available: entries.map((item) => basename(item.name.replace(/\\/g, '/'))) }
      },
      diagnostics: []
    };
  }
  const unpackedDir = join(edit.stagingRoot, 'param-read');
  await mkdir(unpackedDir, { recursive: true });
  const unpackedPath = join(unpackedDir, `${safeSegment(basename(entry.name.replace(/\\/g, '/')))}.${entry.index}.param`);
  const extracted = await runBridge<{ name?: string; contentHash?: string }>({
    command: 'extract-bnd4-child',
    filePath: containerPath,
    allowedRoots: [...edit.allowedRoots(), unpackedDir],
    writableRoots: [unpackedDir],
    ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
    timeoutMs: 60_000,
    commandOptions: { entryIndex: entry.index, outputPath: unpackedPath }
  });
  if (extracted.parseStatus === 'failed') {
    return {
      ok: false,
      error: { code: 'PARAM_UNPACK_FAILED', message: `解包 ${entry.name} 失败。` },
      diagnostics: extracted.diagnostics
    };
  }
  if (extracted.data?.contentHash) entry.contentHash = extracted.data.contentHash;

  const readOnce = (includeAllPayloads: boolean) => readParamDocumentViaBridge({
    sourcePath: unpackedPath,
    allowedRoots: [...edit.allowedRoots(), unpackedDir],
    ...(includeAllPayloads ? { includeAllPayloads: true } : { rowIds }),
    timeoutMs: 120_000,
    maxFrameBytes: includeAllPayloads ? 32 * 1024 * 1024 : 8 * 1024 * 1024
  });
  let document = await readOnce(false);
  const documentDiagnostics = asDiagnostics(document.diagnostics);
  if (!document.ok || !document.data) {
    return {
      ok: false,
      error: { code: 'PARAM_READ_FAILED', message: `读取 ${entry.name} 失败。` },
      diagnostics: documentDiagnostics
    };
  }
  const definition = await loadTrustedDefinition(document.data.typeName, document.data.rowDataSize);
  if (!definition.ok) return { ok: false, error: definition.error, diagnostics: documentDiagnostics };

  let sourceHash = document.data.sourceHash;
  const rows = new Map<number, { id: number; dataBase64: string; name?: string }>();
  const ingest = (items: Array<{ id: number; dataBase64: string; name?: string }>): void => {
    rows.clear();
    for (const row of items) {
      if (typeof row.dataBase64 === 'string' && row.dataBase64.length > 0) {
        rows.set(row.id, {
          id: row.id,
          dataBase64: row.dataBase64,
          ...(row.name ? { name: row.name } : {})
        });
      }
    }
  };
  ingest(document.data.rows);
  let missing = rowIds.filter((id) => !rows.has(id));
  if (missing.length > 0) {
    const full = await readOnce(true);
    documentDiagnostics.push(...asDiagnostics(full.diagnostics));
    if (full.ok && full.data) {
      sourceHash = full.data.sourceHash;
      ingest(full.data.rows);
      missing = rowIds.filter((id) => !rows.has(id));
    }
  }
  if (missing.length > 0) {
    if (allowMissingRows && rows.size > 0) {
      documentDiagnostics.push({
        severity: 'warning',
        code: 'PARAM_ROWS_PARTIAL_MISSING',
        message: `${basename(entry.name.replace(/\\/g, '/'))} 未找到行：${missing.join(', ')}`
      });
    } else {
    return {
      ok: false,
      error: {
        code: 'PARAM_ROW_NOT_FOUND',
        message: `${basename(entry.name.replace(/\\/g, '/'))} 缺少行：${missing.join(', ')}`
      },
      diagnostics: documentDiagnostics
    };
    }
  }
  return {
    ok: true,
    tableName: basename(entry.name.replace(/\\/g, '/')).replace(/\.param$/i, ''),
    entry,
    definition: definition.document,
    rows,
    unpackedPath,
    sourceHash,
    missingRows: missing,
    diagnostics: documentDiagnostics
  };
}

async function listParamEntries(
  edit: NativeEditSession,
  containerPath: string
): Promise<{ ok: true; entries: ContainerEntry[]; diagnostics: Diagnostic[] } | { ok: false; error: ParamEditFailure; diagnostics: Diagnostic[] }> {
  const dcx = await runBridge<{
    nested?: { entries?: Array<{ index?: number; name?: string; contentHash?: string }> };
  }>({
    command: 'read-dcx-document',
    filePath: containerPath,
    resourceUri: pathToFileURL(containerPath).href,
    allowedRoots: edit.allowedRoots(),
    ...(edit.oodleRuntimeRoot ? { oodleRuntimeRoot: edit.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000
  });
  if (dcx.parseStatus === 'failed') {
    return {
      ok: false,
      error: { code: 'PARAM_CONTAINER_READ_FAILED', message: '无法枚举 parambnd 条目。' },
      diagnostics: dcx.diagnostics
    };
  }
  const raw = dcx.data?.nested?.entries ?? [];
  const entries: ContainerEntry[] = [];
  for (const [position, item] of raw.entries()) {
    const name = item.name ?? `entry_${position}`;
    if (!name.toLowerCase().endsWith('.param')) continue;
    entries.push({
      index: item.index ?? position,
      name,
      contentHash: item.contentHash ?? ''
    });
  }
  if (entries.length === 0) {
    return {
      ok: false,
      error: { code: 'PARAM_CONTAINER_EMPTY', message: '容器内没有 .param 条目。' },
      diagnostics: dcx.diagnostics
    };
  }
  return { ok: true, entries, diagnostics: dcx.diagnostics };
}

function findTableEntry(entries: ContainerEntry[], wanted: string): ContainerEntry | undefined {
  const token = normalizeTableToken(wanted);
  const exact = entries.find((entry) => normalizeTableToken(entry.name) === token);
  if (exact) return exact;
  return entries.find((entry) => {
    const name = normalizeTableToken(entry.name);
    return name === token || name.startsWith(`${token}param`) || token.startsWith(name);
  });
}

export function normalizeTableToken(value: string): string {
  return basename(value.replace(/\\/g, '/'))
    .replace(/\.param$/i, '')
    .toLowerCase();
}

function readFieldValue(
  rowDataBase64: string,
  definition: ParamDefDocument,
  fieldId: string
): number | string | boolean | null {
  const values = decodeRowFields(Buffer.from(rowDataBase64, 'base64'), definition);
  return values.find((item) => item.fieldId === fieldId)?.value ?? null;
}

async function loadTrustedDefinition(
  typeName: string,
  rowDataSize: number
): Promise<{ ok: true; document: ParamDefDocument } | { ok: false; error: ParamEditFailure }> {
  if (!metadataCache) {
    const local = process.env.LOCALAPPDATA;
    if (!local) {
      return {
        ok: false,
        error: { code: 'PARAM_METADATA_NO_LOCALAPPDATA', message: '无法定位 LOCALAPPDATA，未加载 PARAM 字段定义。' }
      };
    }
    metadataCache = await importPinnedSmithboxSdtParamMetadata({
      cacheRoot: join(local, 'SoulForge', 'tools', 'smithbox', '2.2.4')
    });
  }
  if (!metadataCache.ok) {
    const first = metadataCache.diagnostics[0];
    return {
      ok: false,
      error: {
        code: first?.code ?? 'PARAM_METADATA_IMPORT_REJECTED',
        message: first?.message ?? 'PARAM 字段定义导入被拒绝。'
      }
    };
  }
  const entry = metadataCache.package.definitions.find((item) => item.document.typeName === typeName);
  if (!entry) {
    return {
      ok: false,
      error: { code: 'PARAM_METADATA_TYPE_NOT_FOUND', message: `元数据包里没有类型 ${typeName}。` }
    };
  }
  if (entry.document.rowDataSize !== rowDataSize) {
    return {
      ok: false,
      error: {
        code: 'PARAM_METADATA_ROW_WIDTH_MISMATCH',
        message: `字段定义行宽（${entry.document.rowDataSize}）与真实 PARAM（${rowDataSize}）不一致。`
      }
    };
  }
  return { ok: true, document: { ...entry.document, origin: 'imported' } };
}

async function findParamBnd(root: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || hits.length > 8) return;
    let items: string[] = [];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }
    for (const name of items) {
      const full = join(dir, name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(full, depth + 1);
      } else if (name.toLowerCase().endsWith('.parambnd.dcx')) {
        hits.push(full);
      }
    }
  };
  await walk(root, 0);
  return hits;
}

function asDiagnostics(
  items: Array<{ severity: string; code: string; message: string }>
): Diagnostic[] {
  return items.map((item) => ({
    severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'error',
    code: item.code,
    message: item.message
  }));
}

function safeSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'param';
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
