/**
 * 有界原生内容补充层（只读）。
 *
 * 初始工作区索引可能只有目录/outline，或 export-event 的 instruction
 * args 为空。本模块把一次关联查询需要的事件、脚本和 PARAM 字段按来源分批
 * 补齐，再交回同一个 WorkspaceIndex；它不写 Mod、不执行脚本，也不维护第二
 * 套原生格式 parser。事件仍由 Bridge 读取，参数布局仍由 first-party EMEDF
 * 和 PARAM metadata 解释。
 */
import type {
  Diagnostic,
  EmevdEditorDocument,
  EmevdEventIr,
  EmevdInstructionIr,
  EventArg,
  EventExport,
  EventInstruction,
  IndexedFile,
  ParamExport,
  ScriptContentKind,
  ScriptExport,
  ScriptSymbol
} from '@soulforge/shared';
import { decodeForRender } from '../emevd/darkScriptRenderer.js';
import { findInstructionDef, type EmedfRegistry } from '../emevd/emedfSchema.js';
import {
  readFullEmevdDocumentViaBridge,
  type ReadFullEmevdDocumentResult
} from '../editing/emevdFullDocument.js';
import {
  listLuabndScripts,
  readLuabndScript,
  type LuabndListResult,
  type LuabndReadResult
} from '../editing/luabndEdit.js';
import type { NativeEditSession } from '../editing/nativeEditSession.js';
import { refreshNativeSemanticSources } from '../indexing/nativeSemanticRefresh.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { getFirstPartyEmedfRegistry } from '../schema/sekiro/firstPartySchema.js';
import { matchEmevdRoleRule } from './emevdRoleRules.js';

export type { ScriptLiteralTargetIndexes } from './scriptReferenceProvider.js';

export const NATIVE_REFERENCE_CURSOR_VERSION = 1;

export interface NativeReferenceContentCursor {
  version: 1;
  eventOffset: number;
  scriptOffset: number;
  paramOffset: number;
  completedSourceKeys?: string[];
  failedSourceKeys?: string[];
  scriptChildOffsets?: Record<string, number>;
}

export interface NativeReferenceEditPort {
  stagingRoot: string;
  allowedRoots(): string[];
  oodleRuntimeRoot?: string;
}

export interface NativeEventReadRequest {
  file: IndexedFile;
  edit?: NativeReferenceEditPort;
  registry: EmedfRegistry;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
}

export type NativeEventReader =
  (input: NativeEventReadRequest) => Promise<ReadFullEmevdDocumentResult>;

export interface NativeScriptListRequest {
  file: IndexedFile;
  edit: NativeReferenceEditPort;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
}

export interface NativeScriptReadRequest extends NativeScriptListRequest {
  childPath: string;
  expectedContainerHash?: string;
  expectedChildHash?: string;
}

export type NativeScriptListReader =
  (input: NativeScriptListRequest) => Promise<LuabndListResult>;
export type NativeScriptReader =
  (input: NativeScriptReadRequest) => Promise<LuabndReadResult>;

export interface NativeReferenceSourceVersion {
  domain: 'event' | 'script' | 'param';
  sourceUri: string;
  sourceHash?: string;
  outerFileHash?: string;
  childHash?: string;
  childPath?: string;
  sourceRevision?: number;
}

export interface NativeReferenceContentOptions {
  index: WorkspaceIndex;
  /** Native edit session/port used only for read roots and staging. */
  edit?: NativeReferenceEditPort;
  /** Restrict the scan to caller-selected files; defaults to index catalog. */
  sourceFiles?: readonly IndexedFile[];
  /** Sources directly involved in the current target/query are scanned first. */
  prioritySourceUris?: readonly string[];
  /** Optional target URI; its source portion is added to prioritySourceUris. */
  targetUri?: string;
  cursor?: NativeReferenceContentCursor;
  /** Alias used by find_references source-scan continuation payloads. */
  sourceCursor?: NativeReferenceContentCursor;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Per-domain native source cap for one invocation. */
  maxSources?: number;
  /** Maximum script children decoded in one invocation. */
  maxScripts?: number;
  /** Byte budget for decoded script text in one invocation. */
  maxBytes?: number;
  registry?: EmedfRegistry;
  /** PARAM fields are refreshed only when rows lack a field projection. */
  hydrateParamFields?: boolean;
  /** Internal/test seams; production uses Bridge wrappers. */
  eventReader?: NativeEventReader;
  scriptListReader?: NativeScriptListReader;
  scriptReader?: NativeScriptReader;
  paramRefresher?: typeof refreshNativeSemanticSources;
}

export interface NativeReferenceContentResult {
  ok: boolean;
  complete: boolean;
  added: number;
  updated: number;
  skipped: number;
  processed: {
    eventSources: number;
    scriptSources: number;
    scriptChildren: number;
    paramSources: number;
    paramRows: number;
  };
  remaining: {
    eventSources: number;
    scriptSources: number;
    scriptChildren: number;
    paramSources: number;
  };
  nextCursor?: NativeReferenceContentCursor;
  /** Alias for callers that persist scan state under sourceCursor. */
  sourceCursor?: NativeReferenceContentCursor;
  completedSourceKeys: string[];
  failedSourceKeys: string[];
  updatedSourceUris: string[];
  sourceVersions: NativeReferenceSourceVersion[];
  diagnostics: Diagnostic[];
  /** Current projection; root may serialize only updatedSourceUris/sourceVersions. */
  bundle: ReturnType<WorkspaceIndex['toSymbolBundle']>;
}

const DEFAULT_MAX_SOURCES = 8;
const DEFAULT_MAX_SCRIPTS = 32;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Enrich the selected native sources and publish only through WorkspaceIndex
 * upsert APIs.  The result is deliberately resumable: offsets are advisory,
 * while source keys contain the current outer hash/revision so a changed file
 * is never skipped by an old cursor.
 */
export async function enrichReferenceContent(
  input: NativeReferenceContentOptions
): Promise<NativeReferenceContentResult> {
  const signal = input.signal;
  throwIfAborted(signal);
  const registry = input.registry ?? loadReferenceRegistry();
  const maxSources = clampPositive(input.maxSources ?? DEFAULT_MAX_SOURCES, DEFAULT_MAX_SOURCES);
  const maxScripts = clampPositive(input.maxScripts ?? DEFAULT_MAX_SCRIPTS, DEFAULT_MAX_SCRIPTS);
  const maxBytes = clampPositive(input.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
  const deadline = input.timeoutMs !== undefined ? Date.now() + Math.max(1, input.timeoutMs) : undefined;
  const sourceFiles = sortFiles(input.sourceFiles ?? input.index.getFiles(), prioritySourceSet(input));
  const matchesSource = (file: IndexedFile, pattern: RegExp) => pattern.test(file.relativePath) || pattern.test(file.sourceUri);
  const eventFiles = sourceFiles.filter((file) => file.resourceKind === 'event' && matchesSource(file, /\.emevd(?:\.dcx)?$/iu));
  const scriptFiles = sourceFiles.filter((file) => (file.resourceKind === 'script' || file.resourceKind === 'ai') && matchesSource(file, /\.(?:luabnd(?:\.dcx)?|lua|hks)$/iu));
  const paramFiles = sourceFiles.filter((file) => file.resourceKind === 'param' && matchesSource(file, /\.(?:parambnd|param)(?:\.dcx)?$/iu));
  const cursor = normalizeCursor(input.cursor ?? input.sourceCursor);
  const completed = new Set(cursor.completedSourceKeys ?? []);
  const failed = new Set(cursor.failedSourceKeys ?? []);
  const scriptChildOffsets = new Map(Object.entries(cursor.scriptChildOffsets ?? {}));
  const diagnostics: Diagnostic[] = [];
  const sourceVersions: NativeReferenceSourceVersion[] = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const processed = {
    eventSources: 0,
    scriptSources: 0,
    scriptChildren: 0,
    paramSources: 0,
    paramRows: 0
  };

  const eventProgress = await enrichEvents({
    ...input,
    index: input.index,
    registry,
    files: eventFiles,
    cursorOffset: cursor.eventOffset,
    maxSources,
    completed,
    failed,
    diagnostics,
    sourceVersions,
    signal,
    deadline
  });
  added += eventProgress.added;
  updated += eventProgress.updated;
  skipped += eventProgress.skipped;
  processed.eventSources += eventProgress.processed;
  throwIfAborted(signal);

  const paramProgress = await enrichParams({
    ...input,
    index: input.index,
    files: paramFiles,
    cursorOffset: cursor.paramOffset,
    maxSources,
    completed,
    failed,
    diagnostics,
    sourceVersions,
    signal,
    deadline
  });
  added += paramProgress.added;
  updated += paramProgress.updated;
  skipped += paramProgress.skipped;
  processed.paramSources += paramProgress.processedSources;
  processed.paramRows += paramProgress.processedRows;
  throwIfAborted(signal);

  const scriptProgress = await enrichScripts({
    ...input,
    index: input.index,
    files: scriptFiles,
    cursorOffset: cursor.scriptOffset,
    maxSources,
    maxScripts,
    maxBytes,
    completed,
    failed,
    scriptChildOffsets,
    diagnostics,
    sourceVersions,
    signal,
    deadline
  });
  added += scriptProgress.added;
  updated += scriptProgress.updated;
  skipped += scriptProgress.skipped;
  processed.scriptSources += scriptProgress.processedSources;
  processed.scriptChildren += scriptProgress.processedChildren;

  const nextCursorValue: NativeReferenceContentCursor = {
    version: NATIVE_REFERENCE_CURSOR_VERSION,
    eventOffset: eventProgress.nextOffset,
    scriptOffset: scriptProgress.nextOffset,
    paramOffset: paramProgress.nextOffset,
    completedSourceKeys: [...completed].sort(),
    failedSourceKeys: [...failed].sort(),
    ...(scriptChildOffsets.size > 0
      ? { scriptChildOffsets: Object.fromEntries([...scriptChildOffsets].sort(([a], [b]) => a.localeCompare(b))) }
      : {})
  };
  const remaining = {
    eventSources: countRemaining(eventFiles, completed, failed),
    scriptSources: countRemaining(scriptFiles, completed, failed),
    scriptChildren: countScriptChildren(input.index, scriptFiles, completed, failed, scriptChildOffsets),
    paramSources: countRemaining(paramFiles, completed, failed)
  };
  const hasRemaining = remaining.eventSources > 0 || remaining.scriptSources > 0
    || remaining.scriptChildren > 0 || remaining.paramSources > 0;
  const hasFailures = failed.size > 0;
  const nextCursor = hasRemaining
    ? nextCursorValue
    : undefined;
  return {
    ok: !signal?.aborted,
    complete: !hasRemaining && !hasFailures,
    added,
    updated,
    skipped,
    processed,
    remaining,
    ...(nextCursor ? { nextCursor } : {}),
    ...(nextCursor ? { sourceCursor: nextCursor } : {}),
    completedSourceKeys: [...completed].sort(),
    failedSourceKeys: [...failed].sort(),
    sourceVersions,
    updatedSourceUris: [...new Set(sourceVersions.map((item) => item.sourceUri))].sort(),
    diagnostics,
    // Root persistence owns serialization; avoid cloning a 50k-row workspace
    // on every bounded query invocation.
    bundle: input.index.toSymbolBundle()
  };
}

/** Convert a complete native editor document into the index's typed symbols. */
export function documentToNativeEventExport(input: {
  sourceUri: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  document: EmevdEditorDocument;
  registry: EmedfRegistry;
}): EventExport {
  const events = input.document.events.map((event) => eventToSymbol(event, input));
  return {
    ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
    ...(input.outerFileHash ? { outerFileHash: input.outerFileHash } : {}),
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}),
    events
  };
}

async function enrichEvents(input: {
  index: WorkspaceIndex;
  edit?: NativeReferenceEditPort;
  files: readonly IndexedFile[];
  cursorOffset: number;
  maxSources: number;
  registry: EmedfRegistry;
  timeoutMs?: number;
  signal: AbortSignal | undefined;
  eventReader?: NativeEventReader;
  completed: Set<string>;
  failed: Set<string>;
  diagnostics: Diagnostic[];
  sourceVersions: NativeReferenceSourceVersion[];
  deadline: number | undefined;
}): Promise<{ added: number; updated: number; skipped: number; processed: number; nextOffset: number }> {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let processed = 0;
  let cursorOffset = clampOffset(input.cursorOffset, input.files.length);
  let inspected = 0;
  for (let index = cursorOffset; index < input.files.length && inspected < input.maxSources; index += 1) {
    throwIfAborted(input.signal);
    if (budgetExhausted(input.deadline)) {
      input.diagnostics.push({ severity: 'info', code: 'NATIVE_REFERENCE_TIME_BUDGET', message: '事件补充达到本次 timeout budget，保留 nextCursor 与 remaining。' });
      break;
    }
    cursorOffset = index + 1;
    const file = input.files[index]!;
    const key = sourceKey('event', file);
    if (input.completed.has(key) || input.failed.has(key)) continue;
    inspected += 1;
    const existing = eventExportsForSource(input.index, file.sourceUri);
    const indexed = enrichIndexedEventExports(existing, file, input.registry, input.sourceVersions);
    if (indexed.exported.length > 0) {
      for (const exportItem of indexed.exported) {
        if (input.index.upsertEventExport(exportItem)) updated += indexed.enrichedCount;
      }
      if (indexed.complete) {
        input.completed.add(key);
        skipped += indexed.enrichedCount === 0 ? 1 : 0;
        processed += 1;
        continue;
      }
    }
    if (!input.edit && !input.eventReader) {
      input.failed.add(key);
      input.diagnostics.push({
        severity: 'warning',
        code: 'NATIVE_REFERENCE_EVENT_READ_DEFERRED',
        message: `事件 ${file.sourceUri} 缺少 native edit read port，保留已有 outline 并报告未补齐内容。`,
        sourceUri: file.sourceUri
      });
      continue;
    }
    try {
      const reader = input.eventReader ?? defaultEventReader;
      const result = await reader({
        file,
        ...(input.edit ? { edit: input.edit } : {}),
        registry: input.registry,
        timeoutMs: remainingTimeout(input.deadline, input.timeoutMs),
        signal: input.signal
      });
      throwIfAborted(input.signal);
      if (!result.ok || !result.document) {
        input.failed.add(key);
        input.diagnostics.push({
          severity: 'warning',
          code: 'NATIVE_REFERENCE_EVENT_READ_FAILED',
          message: result.diagnostics[0]?.message ?? `Bridge 未返回事件 ${file.sourceUri} 的完整文档。`,
          sourceUri: file.sourceUri,
          details: result.diagnostics
        });
        continue;
      }
      const exported = documentToNativeEventExport({
        sourceUri: file.sourceUri,
        ...(result.sourceHash ? { sourceHash: result.sourceHash } : {}),
        ...(result.outerFileHash ? { outerFileHash: result.outerFileHash } : file.sha256 ? { outerFileHash: file.sha256 } : {}),
        sourceRevision: file.mtimeMs,
        document: result.document,
        registry: input.registry
      });
      if (!input.index.upsertEventExport(exported)) {
        input.failed.add(key);
        input.diagnostics.push({
          severity: 'warning',
          code: 'NATIVE_REFERENCE_EVENT_STALE',
          message: '事件原生内容因 source revision/hash 过旧被索引拒绝。',
          sourceUri: file.sourceUri
        });
        continue;
      }
      const count = exported.events.reduce((sum, event) => sum + event.instructions.length, 0);
      added += count > 0 ? count : 1;
      processed += 1;
      input.completed.add(key);
      input.sourceVersions.push({
        domain: 'event',
        sourceUri: file.sourceUri,
        ...(result.sourceHash ? { sourceHash: result.sourceHash } : {}),
        ...(result.outerFileHash ? { outerFileHash: result.outerFileHash } : file.sha256 ? { outerFileHash: file.sha256 } : {}),
        sourceRevision: file.mtimeMs
      });
      input.diagnostics.push(...result.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity === 'error' ? 'warning' : diagnostic.severity as Diagnostic['severity'],
        code: diagnostic.code,
        message: diagnostic.message,
        sourceUri: file.sourceUri
      })));
    } catch (error) {
      if (isAbortLike(error)) throw error;
      input.failed.add(key);
      input.diagnostics.push({
        severity: 'warning',
        code: 'NATIVE_REFERENCE_EVENT_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
        sourceUri: file.sourceUri
      });
    }
  }
  return { added, updated, skipped, processed, nextOffset: cursorOffset };
}

async function enrichScripts(input: {
  index: WorkspaceIndex;
  edit?: NativeReferenceEditPort;
  files: readonly IndexedFile[];
  cursorOffset: number;
  maxSources: number;
  maxScripts: number;
  maxBytes: number;
  timeoutMs?: number;
  signal: AbortSignal | undefined;
  scriptListReader?: NativeScriptListReader;
  scriptReader?: NativeScriptReader;
  completed: Set<string>;
  failed: Set<string>;
  scriptChildOffsets: Map<string, number>;
  diagnostics: Diagnostic[];
  sourceVersions: NativeReferenceSourceVersion[];
  deadline: number | undefined;
}): Promise<{ added: number; updated: number; skipped: number; processedSources: number; processedChildren: number; nextOffset: number }> {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let processedSources = 0;
  let processedChildren = 0;
  let cursorOffset = clampOffset(input.cursorOffset, input.files.length);
  let inspected = 0;
  let remainingScriptBudget = input.maxScripts;
  for (let index = cursorOffset; index < input.files.length && inspected < input.maxSources; index += 1) {
    throwIfAborted(input.signal);
    if (budgetExhausted(input.deadline)) {
      input.diagnostics.push({ severity: 'info', code: 'NATIVE_REFERENCE_TIME_BUDGET', message: '脚本补充达到本次 timeout budget，保留 nextCursor 与 remaining。' });
      break;
    }
    cursorOffset = index + 1;
    const file = input.files[index]!;
    const key = sourceKey('script', file);
    if (input.completed.has(key) || input.failed.has(key)) continue;
    inspected += 1;
    if (!input.edit && !input.scriptListReader) {
      input.failed.add(key);
      input.diagnostics.push({
        severity: 'warning',
        code: 'NATIVE_REFERENCE_SCRIPT_READ_DEFERRED',
        message: `脚本 ${file.sourceUri} 缺少 native edit read port，未把目录候选冒充源码。`,
        sourceUri: file.sourceUri
      });
      continue;
    }
    try {
      const listReader = input.scriptListReader ?? defaultScriptListReader;
      const listed = await listReader({
        file,
        edit: input.edit!,
        timeoutMs: remainingTimeout(input.deadline, input.timeoutMs),
        signal: input.signal
      });
      throwIfAborted(input.signal);
      if (!listed.ok) {
        input.failed.add(key);
        input.diagnostics.push(...listed.diagnostics);
        continue;
      }
      const childOffset = Math.max(0, input.scriptChildOffsets.get(key) ?? 0);
      const existing = findScriptExport(input.index, file.sourceUri);
      const children = new Map((existing?.scripts ?? []).map((child) => [child.uri, child]));
      for (const [catalogIndex, catalog] of listed.scripts.entries()) {
        const childUri = scriptChildUri(file.sourceUri, catalog.sanitizedName || catalog.name);
        if (!children.has(childUri)) {
          children.set(childUri, catalogChildSymbol(file, catalog, childUri, listed.outerFileHash, listed.sourceRevision));
        }
      }
      let childIndex = childOffset;
      let hitBudget = false;
      for (; childIndex < listed.scripts.length; childIndex += 1) {
        if (remainingScriptBudget <= 0) { hitBudget = true; break; }
        throwIfAborted(input.signal);
        const catalog = listed.scripts[childIndex]!;
        const childPath = catalog.sanitizedName || catalog.name;
        const childUri = scriptChildUri(file.sourceUri, childPath);
        const expectedChildHash = catalog.contentHash;
        if (!input.edit && !input.scriptReader) break;
        const reader = input.scriptReader ?? defaultScriptReader;
        const read = await reader({
          file,
          edit: input.edit!,
          childPath,
          expectedContainerHash: listed.outerFileHash,
          ...(expectedChildHash ? { expectedChildHash } : {}),
          timeoutMs: remainingTimeout(input.deadline, input.timeoutMs),
          signal: input.signal
        });
        throwIfAborted(input.signal);
        if (!read.ok) input.failed.add(`${key}#child:${childIndex}`);
        processedChildren += 1;
        remainingScriptBudget -= 1;
        const previous = children.get(childUri);
        const projected = scriptSymbolFromRead(file, childUri, childPath, listed, catalog, read);
        children.set(childUri, projected);
        if (!previous || previous.sourceHash !== projected.sourceHash || previous.sourceText !== projected.sourceText) updated += 1;
        if (projected.sourceText !== undefined) {
          const size = Buffer.byteLength(projected.sourceText, 'utf8');
          if (size > input.maxBytes) {
            const { sourceText: _sourceText, ...withoutSourceText } = projected;
            children.set(childUri, { ...withoutSourceText, contentKind: 'catalog-only', encodingDiagnostics: ['NATIVE_REFERENCE_SCRIPT_BYTE_BUDGET'] });
            input.diagnostics.push({
              severity: 'warning',
              code: 'NATIVE_REFERENCE_SCRIPT_BYTE_BUDGET',
              message: `脚本 ${childUri} 超过本次 ${input.maxBytes} 字节内容上限，保留目录身份并报告剩余。`,
              sourceUri: file.sourceUri
            });
            input.failed.add(`${key}#child:${childIndex}`);
            // This child cannot fit under the fixed scan budget. Keep an
            // explicit partial result and advance; its read tool can still
            // deliver the full source in windows.
            continue;
          }
        }
        for (const diagnostic of read.diagnostics) input.diagnostics.push({ ...diagnostic, sourceUri: file.sourceUri });
        input.sourceVersions.push({
          domain: 'script',
          sourceUri: file.sourceUri,
          ...(projected.sourceHash ? { childHash: projected.sourceHash } : {}),
          ...(projected.outerFileHash ? { outerFileHash: projected.outerFileHash } : listed.outerFileHash ? { outerFileHash: listed.outerFileHash } : {}),
          childPath,
          sourceRevision: projected.sourceRevision ?? listed.sourceRevision
        });
      }
      const partial = hitBudget || childIndex < listed.scripts.length;
      const exportItem: ScriptExport = {
        sourceUri: file.sourceUri,
        containerKind: 'luabnd',
        outerFileHash: listed.outerFileHash,
        sourceRevision: listed.sourceRevision,
        catalogComplete: listed.catalogComplete,
        scripts: [...children.values()]
      };
      if (!input.index.upsertScriptExport(exportItem)) {
        input.failed.add(key);
        input.diagnostics.push({ severity: 'warning', code: 'NATIVE_REFERENCE_SCRIPT_STALE', message: '脚本原生内容因 source revision/hash 过旧被索引拒绝。', sourceUri: file.sourceUri });
        continue;
      }
      if (partial) {
        input.scriptChildOffsets.set(key, childIndex);
        // Keep the source offset at this file so the next invocation resumes
        // its child offset instead of skipping the partially read container.
        cursorOffset = index;
        processedSources += 1;
        continue;
      }
      input.scriptChildOffsets.delete(key);
      input.completed.add(key);
      processedSources += 1;
      added += children.size;
    } catch (error) {
      if (isAbortLike(error)) throw error;
      input.failed.add(key);
      input.diagnostics.push({
        severity: 'warning',
        code: 'NATIVE_REFERENCE_SCRIPT_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
        sourceUri: file.sourceUri
      });
    }
  }
  return { added, updated, skipped, processedSources, processedChildren, nextOffset: cursorOffset };
}

async function enrichParams(input: {
  index: WorkspaceIndex;
  edit?: NativeReferenceEditPort;
  files: readonly IndexedFile[];
  cursorOffset: number;
  maxSources: number;
  timeoutMs?: number;
  signal: AbortSignal | undefined;
  hydrateParamFields?: boolean;
  paramRefresher?: typeof refreshNativeSemanticSources;
  completed: Set<string>;
  failed: Set<string>;
  diagnostics: Diagnostic[];
  sourceVersions: NativeReferenceSourceVersion[];
  deadline: number | undefined;
}): Promise<{ added: number; updated: number; skipped: number; processedSources: number; processedRows: number; nextOffset: number }> {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let processedSources = 0;
  let processedRows = 0;
  let cursorOffset = clampOffset(input.cursorOffset, input.files.length);
  let inspected = 0;
  const shouldHydrate = input.hydrateParamFields ?? true;
  for (let index = cursorOffset; index < input.files.length && inspected < input.maxSources; index += 1) {
    throwIfAborted(input.signal);
    if (budgetExhausted(input.deadline)) {
      input.diagnostics.push({ severity: 'info', code: 'NATIVE_REFERENCE_TIME_BUDGET', message: 'PARAM 字段补充达到本次 timeout budget，保留 nextCursor 与 remaining。' });
      break;
    }
    cursorOffset = index + 1;
    const file = input.files[index]!;
    const key = sourceKey('param', file);
    if (input.completed.has(key) || input.failed.has(key)) continue;
    inspected += 1;
    const current = paramsForSource(input.index, file.sourceUri);
    const needsFields = current.some((item) => item.rows.some((row) => !row.fields || row.fields.length === 0));
    if (!shouldHydrate || !needsFields) {
      input.completed.add(key);
      skipped += 1;
      processedSources += 1;
      continue;
    }
    if (!input.edit) {
      input.failed.add(key);
      input.diagnostics.push({
        severity: 'warning',
        code: 'NATIVE_REFERENCE_PARAM_FIELDS_DEFERRED',
        message: `PARAM ${file.sourceUri} 的 fields 为空；没有 edit staging/read roots，不能猜字段值。`,
        sourceUri: file.sourceUri
      });
      continue;
    }
    try {
      const refreshTimeout = remainingTimeout(input.deadline, input.timeoutMs);
      // A reference-field read must not clone/rebuild every decoded event and
      // script in the workspace. Refresh this PARAM source in isolation, then
      // publish its verified tables back to the live index.
      const paramIndex = new WorkspaceIndex(input.index.workspaceId);
      paramIndex.setFiles([file]);
      for (const table of current) paramIndex.upsertParamExport(table);
      const refreshOptions = {
        index: paramIndex,
        sourceFiles: [file],
        stagingRoot: input.edit.stagingRoot,
        allowedRoots: input.edit.allowedRoots(),
        referenceFieldsOnly: true,
        ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
        ...(refreshTimeout === undefined ? {} : { timeoutMs: refreshTimeout }),
        ...(input.signal ? { signal: input.signal } : {})
      };
      const result = await (input.paramRefresher ?? refreshNativeSemanticSources)(refreshOptions);
      throwIfAborted(input.signal);
      input.diagnostics.push(...result.diagnostics);
      if (result.failedSources.includes(file.sourceUri) || result.staleSources.includes(file.sourceUri)) {
        input.failed.add(key);
        continue;
      }
      const refreshed = paramsForSource(paramIndex, file.sourceUri);
      // The initial catalog and the full native reader can use different
      // child hash projections at the same outer revision. Replace this
      // complete source observation atomically, rather than silently losing
      // every table to the old projection's same-revision guard.
      input.index.invalidateChangedSources([file.sourceUri]);
      for (const table of refreshed) {
        if (!input.index.upsertParamExport(table)) {
          const acceptance = input.index.acceptNativeProjection(file.sourceUri, table);
          throw new Error(`PARAM 内容更新被拒绝：${table.paramName} ${acceptance.code ?? ''} ${acceptance.reason ?? ''}`);
        }
      }
      if (result.partialSources.includes(file.sourceUri)) input.index.markCoveragePartial([file.sourceUri]);
      processedRows += refreshed.reduce((sum, item) => sum + item.rows.length, 0);
      updated += refreshed.reduce((sum, item) => sum + item.rows.filter((row) => (row.fields?.length ?? 0) > 0).length, 0);
      processedSources += 1;
      if (result.partialSources.includes(file.sourceUri)) input.failed.add(key);
      else input.completed.add(key);
      for (const item of refreshed) {
        input.sourceVersions.push({
          domain: 'param',
          sourceUri: file.sourceUri,
          ...(item.sourceHash ? { sourceHash: item.sourceHash } : {}),
          ...(item.outerFileHash ? { outerFileHash: item.outerFileHash } : file.sha256 ? { outerFileHash: file.sha256 } : {}),
          sourceRevision: item.sourceRevision ?? file.mtimeMs
        });
      }
    } catch (error) {
      if (isAbortLike(error)) throw error;
      input.failed.add(key);
      input.diagnostics.push({ severity: 'warning', code: 'NATIVE_REFERENCE_PARAM_FIELDS_FAILED', message: error instanceof Error ? error.message : String(error), sourceUri: file.sourceUri });
    }
  }
  return { added, updated, skipped, processedSources, processedRows, nextOffset: cursorOffset };
}

function eventToSymbol(
  event: EmevdEventIr,
  input: {
    sourceUri: string;
    sourceHash?: string;
    outerFileHash?: string;
    sourceRevision?: number;
    registry: EmedfRegistry;
  }
): EventExport['events'][number] {
  const eventUri = `${input.sourceUri}#event/${event.eventId}`;
  const parameters = event.parameters?.map((parameter) => ({ ...parameter }));
  const instructions = event.instructions.map((instruction, index) => instructionToSymbol(instruction, index, eventUri, parameters, input.registry));
  return {
    uri: eventUri,
    sourceUri: input.sourceUri,
    eventId: event.eventId,
    ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
    ...(input.outerFileHash ? { outerFileHash: input.outerFileHash } : {}),
    ...(input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}),
    instructions,
    raw: {
      authority: 'native-read-full-document',
      instructionCount: event.instructions.length,
      ...(parameters ? { parameters } : {})
    }
  };
}

function instructionToSymbol(
  instruction: EmevdInstructionIr,
  index: number,
  eventUri: string,
  parameters: EmevdEventIr['parameters'],
  registry: EmedfRegistry
): EventInstruction {
  const symbolUri = `${eventUri}#instruction/${index}`;
  const rendered = decodeForRender(instruction, registry, index, parameters);
  const args: EventArg[] = rendered.status.kind === 'ok'
    ? rendered.args.map((arg, argIndex) => {
        const roleRule = matchEmevdRoleRule(registry, instruction.bank, instruction.id, argIndex);
        const role = roleRule ? namespaceToRole(roleRule.namespace) : undefined;
        return {
          name: arg.name,
          value: arg.parameterSymbol ?? arg.value,
          argIndex,
          ...(role ? { role, roleSource: 'registry' as const } : {})
        };
      })
    : [];
  const definition = findInstructionDef(registry, instruction.bank, instruction.id);
  return {
    uri: symbolUri,
    index,
    ...(definition?.name ? { name: definition.name } : {}),
    bank: instruction.bank,
    id: instruction.id,
    args,
    raw: {
      bank: instruction.bank,
      id: instruction.id,
      argsBase64: instruction.argsBase64,
      ...(rendered.status.kind !== 'ok' ? { decodeStatus: rendered.status } : {})
    }
  };
}

function namespaceToRole(namespace: 'event' | 'event-common' | 'flag' | 'param' | 'map-entity' | 'map-region' | 'text'): NonNullable<EventArg['role']> {
  switch (namespace) {
    case 'event':
    case 'event-common': return 'eventId';
    case 'flag': return 'flag';
    case 'param': return 'paramId';
    case 'map-entity': return 'entityId';
    case 'map-region': return 'regionId';
    case 'text': return 'textId';
  }
}

function enrichIndexedEventExports(
  exports: readonly EventExport[],
  file: IndexedFile,
  registry: EmedfRegistry,
  sourceVersions: NativeReferenceSourceVersion[]
): { exported: EventExport[]; complete: boolean; enrichedCount: number } {
  let complete = exports.length > 0;
  let enrichedCount = 0;
  const exported = exports.map((item) => ({
    ...item,
    events: item.events.map((event) => {
      let eventComplete = true;
      const parameters = readParameters(event.raw);
      const instructions = event.instructions.map((instruction, index) => {
        const wire = record(instruction.raw);
        const bank = safeInt(wire.bank) ?? instruction.bank;
        const id = safeInt(wire.id) ?? instruction.id;
        const argsBase64 = typeof wire.argsBase64 === 'string' ? wire.argsBase64 : undefined;
        if (bank === undefined || id === undefined || !argsBase64) {
          if (instruction.args.length === 0) eventComplete = false;
          return instruction;
        }
        const decoded = instructionToSymbol({
          instructionUri: instruction.uri,
          bank,
          id,
          argsBase64,
          unknown: false
        }, index, `${file.sourceUri}#event/${event.eventId}`, parameters, registry);
        if (decoded.args.length === 0 && instruction.args.length === 0) eventComplete = false;
        if (decoded.args.length > 0) enrichedCount += 1;
        return decoded;
      });
      const expected = safeInt(record(event.raw).instructionCount);
      if (expected !== undefined && instructions.length < expected) eventComplete = false;
      complete = complete && eventComplete;
      return {
        ...event,
        sourceUri: file.sourceUri,
        instructions,
        ...(file.sha256 && !event.outerFileHash ? { outerFileHash: file.sha256 } : {})
      };
    })
  }));
  if (exported.length > 0) {
    sourceVersions.push({
      domain: 'event',
      sourceUri: file.sourceUri,
      ...(file.sha256 ? { outerFileHash: file.sha256 } : {}),
      sourceRevision: file.mtimeMs
    });
  }
  return { exported, complete, enrichedCount };
}

function scriptSymbolFromRead(
  file: IndexedFile,
  childUri: string,
  childPath: string,
  listed: Extract<LuabndListResult, { ok: true }>,
  catalog: Extract<Extract<LuabndListResult, { ok: true }>['scripts'][number], { contentKind: string }>,
  result: LuabndReadResult
): ScriptSymbol {
  if (!result.ok) {
    return { ...catalogChildSymbol(file, catalog, childUri, listed.outerFileHash, listed.sourceRevision, result.diagnostics.map((item) => item.message)), contentKind: 'catalog-only' };
  }
  const script = result.script;
  const contentKind: ScriptContentKind = script.sourceText !== undefined
    ? (script.isBytecode ? 'decompiled-view' : 'source')
    : script.isBytecode ? 'bytecode' : 'catalog-only';
  return {
    uri: childUri,
    sourceUri: file.sourceUri,
    childChain: [childPath],
    entryName: childPath,
    contentKind,
    ...(script.sourceText !== undefined ? { sourceText: script.sourceText } : {}),
    ...(script.warnings ? { encodingDiagnostics: script.warnings } : {}),
    ...(script.sourceHash ? { sourceHash: script.sourceHash } : {}),
    ...(script.outerFileHash ? { outerFileHash: script.outerFileHash } : listed.outerFileHash ? { outerFileHash: listed.outerFileHash } : {}),
    sourceRevision: listed.sourceRevision
  };
}

function catalogChildSymbol(
  file: IndexedFile,
  catalog: { name: string; sanitizedName: string; contentKind: 'source' | 'bytecode' | 'catalog-only'; contentHash?: string },
  childUri: string,
  outerFileHash: string,
  sourceRevision: number,
  diagnostics: string[] = []
): ScriptSymbol {
  return {
    uri: childUri,
    sourceUri: file.sourceUri,
    childChain: [catalog.sanitizedName || catalog.name],
    entryName: catalog.sanitizedName || catalog.name,
    contentKind: catalog.contentKind,
    ...(catalog.contentHash ? { sourceHash: catalog.contentHash } : {}),
    outerFileHash,
    sourceRevision,
    ...(diagnostics.length > 0 ? { encodingDiagnostics: diagnostics } : {})
  };
}

async function defaultEventReader(input: NativeEventReadRequest): Promise<ReadFullEmevdDocumentResult> {
  if (!input.edit) {
    return { ok: false, diagnostics: [{ severity: 'warning', code: 'NATIVE_REFERENCE_EVENT_EDIT_REQUIRED', message: '读取事件内容需要 NativeEditSession。' }], pageCount: 0, instructionTotal: 0 };
  }
  return readFullEmevdDocumentViaBridge({
    filePath: input.file.absolutePath,
    resourceUri: input.file.sourceUri,
    allowedRoots: input.edit.allowedRoots(),
    registry: input.registry,
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    cachePolicy: 'default',
    attachIdentity: false
  });
}

async function defaultScriptListReader(input: NativeScriptListRequest): Promise<LuabndListResult> {
  return listLuabndScripts({
    edit: input.edit as NativeEditSession,
    file: input.file.absolutePath,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
}

async function defaultScriptReader(input: NativeScriptReadRequest): Promise<LuabndReadResult> {
  return readLuabndScript({
    edit: input.edit as NativeEditSession,
    file: input.file.absolutePath,
    childPath: input.childPath,
    ...(input.expectedContainerHash ? { expectedContainerHash: input.expectedContainerHash } : {}),
    ...(input.expectedChildHash ? { expectedChildHash: input.expectedChildHash } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  });
}

function sourceKey(domain: 'event' | 'script' | 'param', file: IndexedFile): string {
  return `${domain}\u0000${file.sourceUri}\u0000${file.sha256 ?? ''}\u0000${String(file.mtimeMs)}`;
}

function scriptChildUri(sourceUri: string, childPath: string): string {
  return `${sourceUri}!/${childPath.replaceAll('\\', '/')}`;
}

function sortFiles(files: readonly IndexedFile[], priority: ReadonlySet<string> = new Set()): IndexedFile[] {
  return [...files].sort((left, right) => {
    const leftPriority = priority.has(left.sourceUri) ? 0 : 1;
    const rightPriority = priority.has(right.sourceUri) ? 0 : 1;
    return leftPriority - rightPriority || left.sourceUri.localeCompare(right.sourceUri);
  });
}

function prioritySourceSet(input: NativeReferenceContentOptions): Set<string> {
  const values = new Set(input.prioritySourceUris ?? []);
  if (input.targetUri) {
    const hash = input.targetUri.indexOf('#');
    const bang = input.targetUri.indexOf('!/');
    const cut = [hash, bang].filter((value) => value >= 0).sort((a, b) => a - b)[0];
    values.add(cut === undefined ? input.targetUri : input.targetUri.slice(0, cut));
  }
  return values;
}

function eventExportsForSource(index: WorkspaceIndex, sourceUri: string): EventExport[] {
  return (index.toSymbolBundle().events ?? []).filter((item) => item.events.some((event) => event.sourceUri === sourceUri));
}

function findScriptExport(index: WorkspaceIndex, sourceUri: string): ScriptExport | undefined {
  return (index.toSymbolBundle().scripts ?? []).find((item) => item.sourceUri === sourceUri);
}

function paramsForSource(index: WorkspaceIndex, sourceUri: string): ParamExport[] {
  return (index.toSymbolBundle().params ?? []).filter((item) => item.sourceUri === sourceUri || item.rows.some((row) => row.sourceUri === sourceUri));
}

function countRemaining(files: readonly IndexedFile[], completed: Set<string>, failed: Set<string>): number {
  return files.filter((file) => !completed.has(sourceKey(domainForFile(file), file)) && !failed.has(sourceKey(domainForFile(file), file))).length;
}

function countScriptChildren(
  index: WorkspaceIndex,
  files: readonly IndexedFile[],
  completed: Set<string>,
  failed: Set<string>,
  offsets: Map<string, number>
): number {
  const scripts = index.toSymbolBundle().scripts ?? [];
  return files.reduce((sum, file) => {
    const key = sourceKey('script', file);
    if (completed.has(key) || failed.has(key)) return sum;
    const exportItem = scripts.find((item) => item.sourceUri === file.sourceUri);
    return sum + Math.max(1, (exportItem?.scripts.length ?? 1) - (offsets.get(key) ?? 0));
  }, 0);
}

function domainForFile(file: IndexedFile): 'event' | 'script' | 'param' {
  return file.resourceKind === 'event' ? 'event' : file.resourceKind === 'param' ? 'param' : 'script';
}

function normalizeCursor(cursor: NativeReferenceContentCursor | undefined): NativeReferenceContentCursor {
  return {
    version: NATIVE_REFERENCE_CURSOR_VERSION,
    eventOffset: clampOffset(cursor?.eventOffset ?? 0, Number.MAX_SAFE_INTEGER),
    scriptOffset: clampOffset(cursor?.scriptOffset ?? 0, Number.MAX_SAFE_INTEGER),
    paramOffset: clampOffset(cursor?.paramOffset ?? 0, Number.MAX_SAFE_INTEGER),
    ...(cursor?.completedSourceKeys ? { completedSourceKeys: [...new Set(cursor.completedSourceKeys)] } : {}),
    ...(cursor?.failedSourceKeys ? { failedSourceKeys: [...new Set(cursor.failedSourceKeys)] } : {}),
    ...(cursor?.scriptChildOffsets ? { scriptChildOffsets: { ...cursor.scriptChildOffsets } } : {})
  };
}

function clampOffset(value: number, max: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
}

function clampPositive(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function budgetExhausted(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

function remainingTimeout(deadline: number | undefined, configured: number | undefined): number | undefined {
  const configuredBudget = configured !== undefined ? Math.max(1, configured) : undefined;
  if (deadline === undefined) return configuredBudget;
  const remaining = Math.max(1, deadline - Date.now());
  return configuredBudget === undefined ? remaining : Math.min(configuredBudget, remaining);
}

function safeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readParameters(value: unknown): EmevdEventIr['parameters'] {
  const raw = record(value).parameters;
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((item) => {
    const row = record(item);
    const values = ['instructionIndex', 'targetStartByte', 'sourceStartByte', 'byteCount', 'unkId'].map((key) => safeInt(row[key]));
    if (values.some((entry) => entry === undefined || entry < 0)) return [];
    return [{
      instructionIndex: values[0]!,
      targetStartByte: values[1]!,
      sourceStartByte: values[2]!,
      byteCount: values[3]!,
      unkId: values[4]!
    }];
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('native reference content enrichment aborted');
  error.name = 'AbortError';
  throw error;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /\b(abort|cancel)ed?\b/iu.test(error.message));
}

function loadReferenceRegistry(): EmedfRegistry {
  return getFirstPartyEmedfRegistry();
}
