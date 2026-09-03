/**
 * Agent / CLI EMEVD facade.
 *
 * Compile DSL (patch or DarkScript) through the existing four-view submit
 * path. Does not parse native EMEVD or call write-emevd directly.
 */
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { access, stat } from 'node:fs/promises';
import type { Diagnostic, IndexedFile } from '@soulforge/shared';
import { fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import { decodeInstructionArgs, findInstructionDef, type DecodedArg, type EmedfRegistry } from '../emevd/emedfSchema.js';
import { renderEmevdDarkScript } from '../emevd/darkScriptRenderer.js';
import { resolveEmevdRegistry } from '../emevd/emedfRegistryResolver.js';
import { searchRealEmedf } from '../testing/realEmedfLocator.js';
import { readFullEmevdDocumentViaBridge, sanitizeResourceUri } from './emevdFullDocument.js';
import { submitEmevdDslPlanViaFourView } from './emevdFourViewController.js';
import type { NativeEditSession } from './nativeEditSession.js';
import { decodeStrictBase64, StrictBase64Error } from '../util/base64.js';

export interface EmevdApplyResult {
  ok: boolean;
  filePath?: string;
  mutationCount?: number;
  error?: { code: string; message: string };
  diagnostics: Diagnostic[];
}

export interface EmevdReadResult {
  ok: boolean;
  filePath?: string;
  /** Hash from the same Bridge native read, not from a cached WorkspaceIndex file. */
  sourceHash?: string;
  events?: Array<{ eventId: number; restBehavior: number; instructionCount: number }>;
  error?: { code: string; message: string };
  diagnostics: Diagnostic[];
}

export type EmevdEventReadFormat = 'darkscript' | 'json';

export interface EmevdEventInstructionReadDto {
  index: number;
  bank: number;
  id: number;
  argsBase64: string;
  /** True for source-marked unknowns, missing EMEDF definitions, or failed decoding. */
  unknown: boolean;
  emedfName?: string;
  typedArgs?: DecodedArg[];
  diagnostics: Array<{ severity: 'warning' | 'info'; code: string; message: string }>;
}

export interface EmevdEventReadDto {
  ok: true;
  sourceUri: string;
  sourcePath: string;
  filePath: string;
  eventId: number;
  restBehavior: number;
  /** Total number of native instructions in the selected event. */
  instructionCount: number;
  /** Total number of native instructions represented by this response. */
  total: number;
  /** Effective zero-based offset of `instructions` within the event. */
  offset: number;
  /** Effective instruction window size requested for this response. */
  limit: number;
  /** Number of instruction DTOs included in this response. */
  returned: number;
  /** True when instructions remain after this response window. */
  truncated: boolean;
  /** DarkScript is safe to feed back into apply only when this is true. */
  darkScriptComplete: boolean;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  game: string;
  resourceKind: 'event';
  registryOrigin: EmedfRegistry['origin'];
  registryFingerprint: string;
  registry: { origin: EmedfRegistry['origin']; fingerprint: string };
  format: EmevdEventReadFormat;
  darkScript?: string;
  instructions: EmevdEventInstructionReadDto[];
  diagnostics: Diagnostic[];
}

export interface EmevdEventReadFailure {
  ok: false;
  sourceUri?: string;
  filePath?: string;
  eventId?: number;
  error: { code: string; message: string };
  diagnostics: Diagnostic[];
}

export type EmevdEventReadResult = EmevdEventReadDto | EmevdEventReadFailure;

/** Keep one event read bounded; callers page with instructionOffset. */
const MAX_EVENT_INSTRUCTION_WINDOW = 256;

export interface EmevdInstructionSearchMatch {
  sourceUri: string;
  eventId: number;
  instructionIndex: number;
  instruction: EmevdEventInstructionReadDto;
  sourceHash?: string;
  outerFileHash?: string;
  authority: 'native-verified-event' | 'native-read-event';
}

export interface EmevdInstructionSearchResult {
  ok: true;
  query: string;
  matches: EmevdInstructionSearchMatch[];
  scannedFiles: number;
  scannedEvents: number;
  complete: boolean;
  truncated: boolean;
  diagnostics: Diagnostic[];
}

export interface EmevdInstructionSearchFailure {
  ok: false;
  query: string;
  error: { code: string; message: string };
  diagnostics: Diagnostic[];
}

export type EmevdInstructionSearchResponse = EmevdInstructionSearchResult | EmevdInstructionSearchFailure;

/**
 * Only precise instruction names and bounded numeric identifiers may trigger
 * a native cross-file scan. Chinese behavior phrases remain discovery/RAG
 * queries and must not cause an unbounded native read of the workspace.
 */
export function isPreciseEmevdInstructionQuery(query: string): boolean {
  const value = query.trim();
  return /^(?:[A-Za-z][A-Za-z0-9_.:]*)$/.test(value) || /^\d{1,15}$/.test(value);
}

/**
 * Scan each indexed EMEVD file once, reusing its assembled full document for
 * all events. The full document stays inside this core facade; the Agent only
 * receives matching instruction DTOs plus native identity and diagnostics.
 */
export async function searchEmevdInstructionMatches(input: {
  edit: NativeEditSession;
  files: readonly IndexedFile[];
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<EmevdInstructionSearchResponse> {
  const query = input.query.trim();
  if (!isPreciseEmevdInstructionQuery(query)) {
    return {
      ok: false,
      query,
      error: {
        code: 'EMEVD_NATIVE_SEARCH_QUERY_NOT_PRECISE',
        message: '跨文件 native EMEVD 搜索只接受精确英文指令名或安全数字 ID。'
      },
      diagnostics: []
    };
  }
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
  const registry = await loadImportedRegistry(input.edit, undefined);
  if (!registry.ok) {
    return { ok: false, query, error: registry.error, diagnostics: [] };
  }
  const files = [...new Map(
    input.files
      .filter((file) => file.resourceKind === 'event' && /\.emevd(?:\.dcx)?$/i.test(file.absolutePath))
      .map((file) => [file.sourceUri, file])
  ).values()];
  const needle = normalizeInstructionSearchText(query);
  const matches: EmevdInstructionSearchMatch[] = [];
  const diagnostics: Diagnostic[] = [];
  let scannedFiles = 0;
  let scannedEvents = 0;
  let complete = true;
  let truncated = false;

  for (const file of files) {
    if (input.signal?.aborted) {
      complete = false;
      diagnostics.push({
        severity: 'warning',
        code: 'EMEVD_NATIVE_SEARCH_CANCELLED',
        message: '跨文件 EMEVD native 搜索已取消。',
        sourceUri: file.sourceUri
      });
      break;
    }
    try {
      const full = await readFullEmevdDocumentViaBridge({
        filePath: file.absolutePath,
        allowedRoots: input.edit.allowedRoots(),
        resourceUri: sanitizeResourceUri(pathToFileURL(file.absolutePath).href),
        registry: registry.registry,
        timeoutMs: 120_000,
        attachIdentity: true,
        cachePolicy: 'bypass',
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {})
      });
      scannedFiles += 1;
      diagnostics.push(...asDiagnostics(full.diagnostics));
      if (!full.ok || !full.document) {
        complete = false;
        continue;
      }
      for (const event of full.document.events) {
        scannedEvents += 1;
        for (let index = 0; index < event.instructions.length; index += 1) {
          const instruction = readEventInstruction(event.instructions[index]!, index, registry.registry);
          if (!instructionSearchMatches(instruction, needle)) continue;
          matches.push({
            sourceUri: file.sourceUri,
            eventId: event.eventId,
            instructionIndex: index,
            instruction,
            ...(full.sourceHash ? { sourceHash: full.sourceHash } : {}),
            ...(full.outerFileHash ? { outerFileHash: full.outerFileHash } : {}),
            authority: full.authority === 'native-verified' ? 'native-verified-event' : 'native-read-event'
          });
          if (matches.length >= limit) {
            truncated = true;
            complete = false;
            break;
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    } catch (error) {
      complete = false;
      diagnostics.push({
        severity: 'error',
        code: 'EMEVD_NATIVE_SEARCH_FILE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        sourceUri: file.sourceUri
      });
    }
  }
  return { ok: true, query, matches, scannedFiles, scannedEvents, complete, truncated, diagnostics };
}

/**
 * Read one event through the native full-document path and return only an
 * event-level Agent DTO. The full editor document never crosses this facade.
 */
export async function readEmevdEvent(input: {
  edit: NativeEditSession;
  file: string;
  eventId: number;
  format?: EmevdEventReadFormat;
  /** Zero-based event-instruction offset. Defaults to the first instruction. */
  instructionOffset?: number;
  /** Maximum number of event instructions to return. Omitted uses the bounded default. */
  instructionLimit?: number;
  signal?: AbortSignal;
}): Promise<EmevdEventReadResult> {
  const format = input.format ?? 'darkscript';
  if (format !== 'darkscript' && format !== 'json') {
    return {
      ok: false,
      eventId: input.eventId,
      error: { code: 'EMEVD_EVENT_FORMAT_INVALID', message: `不支持的事件读取格式：${String(format)}。` },
      diagnostics: []
    };
  }
  if (input.instructionOffset !== undefined
    && (!Number.isSafeInteger(input.instructionOffset) || input.instructionOffset < 0)) {
    return {
      ok: false,
      eventId: input.eventId,
      error: { code: 'EMEVD_INSTRUCTION_OFFSET_INVALID', message: 'instructionOffset 必须是非负安全整数。' },
      diagnostics: []
    };
  }
  if (input.instructionLimit !== undefined
    && (!Number.isSafeInteger(input.instructionLimit) || input.instructionLimit < 0)) {
    return {
      ok: false,
      eventId: input.eventId,
      error: { code: 'EMEVD_INSTRUCTION_LIMIT_INVALID', message: 'instructionLimit 必须是非负安全整数。' },
      diagnostics: []
    };
  }
  if (input.instructionLimit !== undefined && input.instructionLimit > MAX_EVENT_INSTRUCTION_WINDOW) {
    return {
      ok: false,
      eventId: input.eventId,
      error: {
        code: 'EMEVD_INSTRUCTION_LIMIT_TOO_LARGE',
        message: `单次事件读取最多返回 ${MAX_EVENT_INSTRUCTION_WINDOW} 条指令，请使用 instructionOffset 分页。`
      },
      diagnostics: []
    };
  }
  if (!Number.isSafeInteger(input.eventId)) {
    return {
      ok: false,
      eventId: input.eventId,
      error: { code: 'EMEVD_EVENT_ID_INVALID', message: 'eventId 必须是安全整数。' },
      diagnostics: []
    };
  }

  const resolved = await resolveEmevdFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, eventId: input.eventId, error: resolved.error, diagnostics: [] };
  const registry = await loadImportedRegistry(input.edit, undefined);
  if (!registry.ok) {
    return { ok: false, filePath: resolved.path, eventId: input.eventId, error: registry.error, diagnostics: [] };
  }

  // Full-document assembly deliberately sanitizes absolute file URIs. Use the
  // exact same resource identity for compile/plan matching; sourcePath remains
  // the physical target used by the Patch Engine.
  const sourceUri = sanitizeResourceUri(pathToFileURL(resolved.path).href);
  const full = await readFullEmevdDocumentViaBridge({
    filePath: resolved.path,
    allowedRoots: input.edit.allowedRoots(),
    resourceUri: sourceUri,
    registry: registry.registry,
    timeoutMs: 120_000,
    attachIdentity: true,
    cachePolicy: 'bypass',
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {})
  });
  if (!full.ok || !full.document) {
    return {
      ok: false,
      filePath: resolved.path,
      eventId: input.eventId,
      error: { code: 'EMEVD_READ_FAILED', message: '无法读取 EMEVD，拒绝返回事件 DTO。' },
      diagnostics: asDiagnostics(full.diagnostics)
    };
  }

  const event = full.document.events.find((candidate) => candidate.eventId === input.eventId);
  if (!event) {
    return {
      ok: false,
      sourceUri: full.document.resourceUri,
      filePath: resolved.path,
      eventId: input.eventId,
      error: { code: 'EMEVD_EVENT_NOT_FOUND', message: `EMEVD 中不存在事件 ${input.eventId}。` },
      diagnostics: asDiagnostics(full.diagnostics)
    };
  }

  const total = event.instructions.length;
  const offset = Math.min(input.instructionOffset ?? 0, total);
  const limit = Math.min(
    input.instructionLimit ?? MAX_EVENT_INSTRUCTION_WINDOW,
    MAX_EVENT_INSTRUCTION_WINDOW
  );
  const end = Math.min(total, offset + limit);
  const instructions = event.instructions.slice(offset, end).map((instruction, index) =>
    readEventInstruction(instruction, offset + index, registry.registry)
  );
  const truncated = end < total;
  const fileRevision = await stat(resolved.path).then((value) => value.mtimeMs).catch(() => undefined);
  const fingerprint = fingerprintEmedfRegistry(registry.registry);
  const eventForRead = { ...event, instructions: event.instructions.slice(offset, end) };
  const dto: EmevdEventReadDto = {
    ok: true,
    sourceUri: full.document.resourceUri,
    sourcePath: resolved.path,
    filePath: resolved.path,
    eventId: event.eventId,
    restBehavior: event.restBehavior,
    instructionCount: total,
    total,
    offset,
    limit,
    returned: instructions.length,
    truncated,
    darkScriptComplete: !truncated,
    ...(full.sourceHash ? { sourceHash: full.sourceHash } : {}),
    ...(full.outerFileHash ? { outerFileHash: full.outerFileHash } : {}),
    ...(fileRevision !== undefined ? { sourceRevision: fileRevision } : {}),
    game: input.edit.session.meta.game,
    resourceKind: 'event',
    registryOrigin: registry.registry.origin,
    registryFingerprint: fingerprint,
    registry: { origin: registry.registry.origin, fingerprint },
    format,
    ...(format === 'darkscript'
      ? { darkScript: renderEmevdDarkScript({ ...full.document, events: [eventForRead] }, registry.registry) }
      : {}),
    instructions,
    diagnostics: [
      ...asDiagnostics(full.diagnostics),
      ...(truncated ? [{
        severity: 'warning' as const,
        code: 'EMEVD_EVENT_INSTRUCTIONS_PAGED',
        message: `仅返回指令 ${offset}..${Math.max(offset, end - 1)}；DarkScript 不完整，不能直接作为写回源码。`
      }] : [])
    ]
  };
  return dto;
}

export async function readEmevdOutline(input: {
  edit: NativeEditSession;
  file: string;
}): Promise<EmevdReadResult> {
  const resolved = await resolveEmevdFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const registry = await loadImportedRegistry(input.edit, undefined);
  if (!registry.ok) {
    return { ok: false, error: registry.error, diagnostics: [] };
  }
  const full = await readFullEmevdDocumentViaBridge({
    filePath: resolved.path,
    allowedRoots: input.edit.allowedRoots(),
    resourceUri: pathToFileURL(resolved.path).href,
    registry: registry.registry,
    timeoutMs: 120_000,
    attachIdentity: true,
    cachePolicy: 'bypass',
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {})
  });
  if (!full.ok || !full.document) {
    return {
      ok: false,
      error: { code: 'EMEVD_READ_FAILED', message: '无法读取 EMEVD。' },
      diagnostics: asDiagnostics(full.diagnostics)
    };
  }
  return {
    ok: true,
    filePath: resolved.path,
    ...(full.sourceHash ? { sourceHash: full.sourceHash } : {}),
    events: full.document.events.map((event) => ({
      eventId: event.eventId,
      restBehavior: event.restBehavior,
      instructionCount: event.instructions.length
    })),
    diagnostics: asDiagnostics(full.diagnostics)
  };
}

export async function applyEmevdDsl(input: {
  edit: NativeEditSession;
  file: string;
  dsl: string;
  mode?: 'patch' | 'dark-script';
  emedfPath?: string;
  /** Canonical event-scoped DarkScript target. */
  scopeEventId?: number;
  /** Short alias accepted by Agent callers. */
  eventId?: number;
  /** Structured alias for callers that model scope explicitly. */
  scope?: { eventId: number };
  /** Optional read receipt used to reject a stale model edit before commit. */
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  /** False means the supplied DarkScript was only an instruction page. */
  darkScriptComplete?: boolean;
}): Promise<EmevdApplyResult> {
  if (input.dsl.trim().length === 0) {
    return { ok: false, error: { code: 'EMEVD_DSL_EMPTY', message: 'DSL 为空。' }, diagnostics: [] };
  }
  const resolved = await resolveEmevdFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const scopeIds = [input.scopeEventId, input.eventId, input.scope?.eventId]
    .filter((value): value is number => value !== undefined);
  const distinctScopeIds = [...new Set(scopeIds)];
  if (distinctScopeIds.length > 1) {
    return {
      ok: false,
      filePath: resolved.path,
      error: { code: 'EMEVD_DSL_SCOPE_CONFLICT', message: 'eventId、scopeEventId 与 scope.eventId 不一致。' },
      diagnostics: []
    };
  }
  const scopeEventId = distinctScopeIds[0];
  if (scopeEventId !== undefined && !Number.isSafeInteger(scopeEventId)) {
    return {
      ok: false,
      filePath: resolved.path,
      error: { code: 'EMEVD_DSL_SCOPE_EVENT_ID_INVALID', message: '事件作用域 eventId 必须是安全整数。' },
      diagnostics: []
    };
  }
  const mode = input.mode ?? 'patch';
  if (scopeEventId !== undefined && mode === 'patch' && !looksLikeDarkScriptSource(input.dsl)) {
    return {
      ok: false,
      filePath: resolved.path,
      error: { code: 'EMEVD_DSL_SCOPE_REQUIRES_DARKSCRIPT', message: '事件作用域只允许 DarkScript 单事件源码。' },
      diagnostics: []
    };
  }
  if (scopeEventId !== undefined && input.darkScriptComplete === false) {
    return {
      ok: false,
      filePath: resolved.path,
      error: {
        code: 'EMEVD_DSL_INCOMPLETE_SOURCE',
        message: '事件作用域拒绝使用分页 DarkScript；请先读取完整事件后再写回。'
      },
      diagnostics: []
    };
  }
  const registry = await loadImportedRegistry(input.edit, input.emedfPath);
  if (!registry.ok) return { ok: false, error: registry.error, diagnostics: [] };

  // Full-document assembly deliberately sanitizes absolute file URIs. Use the
  // exact same resource identity for compile/plan matching; sourcePath remains
  // the physical target used by the Patch Engine.
  const sourceUri = sanitizeResourceUri(pathToFileURL(resolved.path).href);
  const full = await readFullEmevdDocumentViaBridge({
    filePath: resolved.path,
    allowedRoots: input.edit.allowedRoots(),
    resourceUri: sourceUri,
    registry: registry.registry,
    timeoutMs: 120_000,
    attachIdentity: true,
    cachePolicy: 'bypass',
    ...(input.edit.oodleRuntimeRoot ? { oodleRuntimeRoot: input.edit.oodleRuntimeRoot } : {})
  });
  if (!full.ok || !full.document) {
    return {
      ok: false,
      error: { code: 'EMEVD_READ_FAILED', message: '无法读取 EMEVD，拒绝提交 DSL。' },
      diagnostics: asDiagnostics(full.diagnostics)
    };
  }
  const currentRevision = await stat(resolved.path).then((value) => value.mtimeMs).catch(() => undefined);
  const staleIdentity = (input.sourceHash !== undefined
    && (!full.sourceHash || input.sourceHash !== full.sourceHash))
    || (input.outerFileHash !== undefined
      && (!full.outerFileHash || input.outerFileHash !== full.outerFileHash))
    || (input.sourceRevision !== undefined
      && (currentRevision === undefined || input.sourceRevision !== currentRevision));
  if (staleIdentity) {
    return {
      ok: false,
      filePath: resolved.path,
      error: {
        code: 'EMEVD_DSL_SOURCE_STALE',
        message: 'EMEVD 文件在读取后已变化，或写入请求未匹配当前 source identity；拒绝基于旧源码写回。'
      },
      diagnostics: [{
        severity: 'warning',
        code: 'EMEVD_DSL_SOURCE_STALE',
        message: `sourceHash/sourceRevision 不匹配：expected=${input.sourceHash ?? input.sourceRevision ?? '未提供'} actual=${full.sourceHash ?? currentRevision ?? '未知'}`
      }]
    };
  }
  const result = await submitEmevdDslPlanViaFourView({
    compileRequest: {
      schemaVersion: 1,
      resourceUri: sourceUri,
      documentInstanceId: full.document.documentInstanceId ?? '',
      baseRevision: full.document.revision,
      emedfSchemaFingerprint: fingerprintEmedfRegistry(registry.registry),
      sourceText: input.dsl,
      mode,
      ...(scopeEventId !== undefined ? { scopeEventId } : {})
    },
    document: full.document,
    registry: registry.registry,
    sourcePath: resolved.path,
    expectedDocumentHash: full.sourceHash ?? '',
    ...(full.outerFileHash ? { expectedOuterFileHash: full.outerFileHash } : {}),
    allowedRoots: input.edit.allowedRoots(),
    workspaceId: input.edit.session.meta.workspaceId,
    workspaceRoot: input.edit.session.layers.overlayRoot,
    stagingRoot: input.edit.stagingRoot,
    targetUri: sourceUri,
    title: `EMEVD DSL ${basename(resolved.path)}`,
    session: input.edit.session,
    operationLog: input.edit.operationLog,
    backupBaseDir: input.edit.backupBaseDir,
    recoveryDir: input.edit.recoveryDir,
    timeoutMs: 120_000
  });
  if (!result.ok) {
    const diagnostics = asDiagnostics(result.diagnostics);
    const resourceMismatch = diagnostics.find((diagnostic) => diagnostic.code === 'EMEVD_DSL_RESOURCE_MISMATCH');
    return {
      ok: false,
      error: {
        code: diagnostics[0]?.code ?? 'EMEVD_DSL_REJECTED',
        message: resourceMismatch
          ? `${resourceMismatch.message} request=${sourceUri} document=${full.document.resourceUri}`
          : diagnostics[0]?.message ?? 'DSL 编译或提交失败。'
      },
      diagnostics
    };
  }
  return {
    ok: true,
    filePath: resolved.path,
    mutationCount: result.commit?.mutationCount ?? 0,
    diagnostics: asDiagnostics(result.diagnostics)
  };
}

function looksLikeDarkScriptSource(source: string): boolean {
  return /\$Event\s*\(/.test(source);
}

function readEventInstruction(
  instruction: Pick<EmevdEventInstructionReadDto, 'bank' | 'id' | 'argsBase64' | 'unknown'>,
  index: number,
  registry: EmedfRegistry
): EmevdEventInstructionReadDto {
  const diagnostics: EmevdEventInstructionReadDto['diagnostics'] = [];
  const definition = instruction.unknown ? undefined : findInstructionDef(registry, instruction.bank, instruction.id);
  if (instruction.unknown) {
    diagnostics.push({ severity: 'warning', code: 'EMEVD_INSTRUCTION_MARKED_UNKNOWN', message: '原生文档将该指令标记为 unknown，保持不透明。' });
    return { index, bank: instruction.bank, id: instruction.id, argsBase64: instruction.argsBase64, unknown: true, diagnostics };
  }
  if (!definition) {
    diagnostics.push({ severity: 'warning', code: 'EMEDF_UNKNOWN_INSTRUCTION', message: `EMEDF 中没有 bank=${instruction.bank} id=${instruction.id}。` });
    return { index, bank: instruction.bank, id: instruction.id, argsBase64: instruction.argsBase64, unknown: true, diagnostics };
  }
  try {
    const rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
    const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, rawArgs);
    if (!decoded.ok) {
      diagnostics.push({ severity: 'warning', code: decoded.code, message: decoded.message });
      return {
        index, bank: instruction.bank, id: instruction.id, argsBase64: instruction.argsBase64,
        unknown: true, emedfName: definition.name, diagnostics
      };
    }
    return {
      index,
      bank: instruction.bank,
      id: instruction.id,
      argsBase64: instruction.argsBase64,
      unknown: false,
      emedfName: decoded.def.name,
      typedArgs: decoded.args,
      diagnostics
    };
  } catch (error) {
    const code = error instanceof StrictBase64Error ? error.code : 'EMEVD_INSTRUCTION_DECODE_FAILED';
    const message = error instanceof Error ? error.message : '指令参数解码失败。';
    diagnostics.push({ severity: 'warning', code, message });
    return {
      index, bank: instruction.bank, id: instruction.id, argsBase64: instruction.argsBase64,
      unknown: true, emedfName: definition.name, diagnostics
    };
  }
}

function normalizeInstructionSearchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll('_', ' ')
    .replaceAll(':', ' ')
    .replaceAll('.', ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function instructionSearchMatches(
  instruction: EmevdEventInstructionReadDto,
  normalizedQuery: string
): boolean {
  const values = [
    instruction.emedfName,
    String(instruction.bank),
    String(instruction.id),
    ...(instruction.typedArgs ?? []).flatMap((arg) => [arg.name, String(arg.value), arg.parameterSymbol])
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(normalizeInstructionSearchText);
  const haystack = values.join(' ');
  return haystack.split(' ').includes(normalizedQuery)
    || haystack.includes(normalizedQuery);
}

async function resolveEmevdFile(
  edit: NativeEditSession,
  file: string
): Promise<{ ok: true; path: string } | { ok: false; error: { code: string; message: string } }> {
  const overlay = edit.session.layers.overlayRoot;
  const base = edit.session.layers.baseRoot;
  const candidates = [
    resolve(file),
    join(overlay, file),
    join(overlay, 'event', file),
    join(overlay, 'event', `${file}.emevd.dcx`)
  ];
  if (base) {
    candidates.push(
      join(base, file),
      join(base, 'event', file),
      join(base, 'event', `${file}.emevd.dcx`)
    );
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { ok: true, path: candidate };
    } catch {
      // try next
    }
  }
  return {
    ok: false,
    error: { code: 'EMEVD_FILE_NOT_FOUND', message: `工作区内找不到事件文件：${file}` }
  };
}

async function loadImportedRegistry(
  edit: NativeEditSession,
  explicit: string | undefined
): Promise<
  | { ok: true; registry: ReturnType<typeof resolveEmevdRegistry>['registry'] }
  | { ok: false; error: { code: string; message: string } }
> {
  const path = explicit
    ?? edit.emedfPath
    ?? process.env.SOULFORGE_EMEDF_PATH
    ?? await searchRealEmedfFromGame(edit.session.layers.baseRoot);
  const resolved = resolveEmevdRegistry(path);
  if (resolved.origin !== 'imported') {
    return {
      ok: false,
      error: {
        code: 'EMEVD_EMEDF_NOT_IMPORTED',
        message: resolved.fallbackReason
          ?? '未找到本机 DarkScript3 EMEDF（sekiro-common.emedf.json）。请传 --emedf 或设 SOULFORGE_EMEDF_PATH。'
      }
    };
  }
  return { ok: true, registry: resolved.registry };
}

async function searchRealEmedfFromGame(baseRoot: string | undefined): Promise<string | undefined> {
  return baseRoot ? searchRealEmedf({ gameRoot: baseRoot }) : searchRealEmedf();
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
