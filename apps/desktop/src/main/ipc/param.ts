import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dialog } from 'electron';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import {
  applyParamFieldMutation,
  decodeRowFields,
  encodeFieldMutation,
  toCsvText,
  parseCsvText,
  commitParamMutationViaBridge,
  readParamDocumentViaBridge,
  stageBridgeOutput,
  applyNativeMutation,
  runBridge,
  isParamBackupPath,
  sanitizeEntryName,
  normalizePageWindow,
  loadFirstPartyParamMetadata,
  matchParamMetadataPackage,
  type WorkspaceSession,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  classifyScriptEntry,
  magicLabel,
  type ScriptContainerEntryEvidence,
  type ScriptEntryClassification,
} from '@soulforge/core';
import {
  PARAM_PAGE_SIZE,
  PARAM_ROW_PAYLOAD_BATCH_MAX,
  type Diagnostic,
  type IndexedFile,
  type ParamDefDocument,
  type ParamNativeTelemetry,
  type ParamSessionMetadata,
  type ParamMetadataPackage,
  type StructuredDiagnostic
} from '@soulforge/shared';
import { PARAM_SESSION_IPC_CHANNELS } from '@soulforge/shared';
import { prepareBridgeRoots, type BridgeRootSession, type PrepareBridgeRootsResult } from '../bridgeRoots.js';
import type { NativeBnd4EntryLike, NativeDcxEnvelopeLike } from './bridgeEnvelopes.js';
import { sanitizeDiagnostics, sanitizeRendererValue, type RendererSaveResult } from '../rendererDto.js';
import type { TrustedIpcHandle } from './registration.js';
import {
  appendPostCommitFailureDiagnostic,
  runCallerOwnedPostCommit,
  type KnowledgeRefreshOwner
} from '../knowledgeRefreshOwnership.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
// Forensics counters (V1, pure diagnostic — no business logic change).
const _forensicsCounters = new Map<string, number>();
function _forensicsInc(key: string, delta = 1): void { _forensicsCounters.set(key, (_forensicsCounters.get(key) ?? 0) + delta); }
export function getForensicsCounters(): Record<string, number> { return Object.fromEntries(_forensicsCounters); }

/** Keep the existing Bridge telemetry observable without granting it authority. */
function projectParamNativeTelemetry(value: unknown): ParamNativeTelemetry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const count = (key: string): number | null => {
    const candidate = raw[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : null;
  };
  const telemetry: ParamNativeTelemetry = {
    paramParse: count('paramParse'),
    paramDecodedRows: count('paramDecodedRows'),
    paramSessionOpen: count('paramSessionOpen'),
    paramStructuralValidation: count('paramStructuralValidation'),
    paramSerializedRows: count('paramSerializedRows')
  };
  return Object.values(telemetry).some((candidate) => candidate !== null) ? telemetry : null;
}

const sessionBindings = new Map<string, { sourceUri: string; workspaceSessionId: string; sourceHash: string; pathSourceGeneration: number; entryIdentity?: string }>();
// Isolated dummy for pre-split shared cache — real invalidation now via composition root (raw domain owns its cache).
const containerChildrenCache = new Map<string, unknown>();
interface CachedParamDocument {
  sourceHash: string;
  typeName: string;
  rowDataSize: number;
  rowCount: number;
  rows: Array<{ rowIndex: number; id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
  authority?: string;
}
const paramPageCache = new Map<string, CachedParamDocument>();
/**
 * Legacy renderer compatibility only. New PARAM session IPC must never read or populate this cache.
 * Isolated: only the legacy `resource.readParamPage` (loadAll) path may get/set this map;
 * slim handlers (`resource.openParamSession` / `readParamIndexPage` / `readParamRows`) close over
 * `sessionBindings` only and must never import or reference this symbol.
 */
const paramAllCache = new Map<string, CachedParamDocument>();
interface UnpackedParamChild { absolutePath: string; entryIndex: number; name: string; storedContentHash: string; }
const unpackedParamCache = new Map<string, UnpackedParamChild>();
interface ParamUnpackExtractionResult {
  parseStatus: string;
  outputExists: boolean;
  diagnostics: Diagnostic[];
}
const unpackedParamInFlight = new Map<string, Promise<ParamUnpackExtractionResult>>();
type MemoizedParamEntryTable = Array<{ index: number; name: string; storedContentHash: string }>;
const paramEntryTableCache = new Map<string, MemoizedParamEntryTable>();
const CONTAINER_PARAM_ALL_CACHE_LIMIT = 4;
const containerParamAllCache = new Map<string, CachedParamDocument>();
interface CachedContainerParamSession {
  document: CachedParamDocument;
  sessionToken: string;
  workspaceSessionId: string;
  absolutePath: string;
}
const containerParamSessionCache = new Map<string, CachedContainerParamSession>();
const takeContainerParamSession = (
  key: string,
  workspaceSessionId: string,
  absolutePath: string
): CachedContainerParamSession | undefined => {
  const hit = containerParamSessionCache.get(key);
  if (!hit || hit.workspaceSessionId !== workspaceSessionId || hit.absolutePath !== absolutePath) return undefined;
  containerParamSessionCache.delete(key);
  containerParamSessionCache.set(key, hit);
  return hit;
};
const putContainerParamSession = (key: string, value: CachedContainerParamSession): void => {
  containerParamSessionCache.delete(key);
  containerParamSessionCache.set(key, value);
  while (containerParamSessionCache.size > CONTAINER_PARAM_ALL_CACHE_LIMIT) {
    const oldest = containerParamSessionCache.keys().next();
    if (oldest.done) break;
    containerParamSessionCache.delete(oldest.value);
  }
};
const takeContainerParamAll = (key: string): CachedParamDocument | undefined => {
  const hit = containerParamAllCache.get(key);
  if (!hit) return undefined;
  containerParamAllCache.delete(key);
  containerParamAllCache.set(key, hit);
  return hit;
};
const putContainerParamAll = (key: string, value: CachedParamDocument): void => {
  containerParamAllCache.delete(key);
  containerParamAllCache.set(key, value);
  while (containerParamAllCache.size > CONTAINER_PARAM_ALL_CACHE_LIMIT) {
    const oldest = containerParamAllCache.keys().next();
    if (oldest.done) break;
    containerParamAllCache.delete(oldest.value);
  }
};
const MAX_PAGED_PARAM_ROWS = 100_000;
export interface ParamIpcDeps {
  handle: TrustedIpcHandle;
  readonly indexedFiles: readonly IndexedFile[];
  readonly activeSession: WorkspaceSession | null;
  readonly activeWorkspaceSessionId: string | null;
  getIndexedFiles?(): readonly IndexedFile[];
  getActiveSession?(): WorkspaceSession | null;
  getActiveWorkspaceSessionId?(): string | null;
  durableStoragePaths(workspaceId: string): { root: string; backupBaseDir: string; recoveryDir: string; stagingRoot: string };
  bridgeRootSession(session: WorkspaceSession, storage: { root: string }): BridgeRootSession;
  bridgeRootsDiagnostic(code: string, result: Extract<PrepareBridgeRootsResult, { ok: false }>): Diagnostic;
  verifiedReadRoots(session: WorkspaceSession | null, fallback: string): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  verifiedStageRoots(session: WorkspaceSession, storage: { root: string }, code: string): Promise<{ allowedRoots: string[]; writableRoots: string[]; diagnostics: Diagnostic[] }>;
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  sessionCommitPort(session: WorkspaceSession, operationLog: OperationLogUtilityClient, storage: { root: string; backupBaseDir: string; recoveryDir: string; stagingRoot: string }, options?: { knowledgeRefreshOwner?: KnowledgeRefreshOwner }): RawReplaceCommitPort;
  electronConfirmationPort(event: IpcMainInvokeEvent): import("@soulforge/core").WriteConfirmationPort;
  toSaveResultFromOutcome(outcome: NativeMutationOutcome, files: readonly IndexedFile[]): RendererSaveResult;
  refreshActiveIndexAfterNativeWrite(changedSources?: readonly string[], carrier?: unknown): Promise<unknown>;
  sha256FileNow(filePath: string): Promise<string>;
}

export function clearParamIpcCaches(): void {
  sessionBindings.clear();
  paramPageCache.clear();
  paramAllCache.clear();
  paramEntryTableCache.clear();
  containerParamAllCache.clear();
  containerParamSessionCache.clear();
  unpackedParamCache.clear();
  unpackedParamInFlight.clear();
}
export function registerParamIpcHandlers(deps: ParamIpcDeps): void {
  const handle = deps.handle;
  const getFiles = (): readonly IndexedFile[] => (deps.getIndexedFiles ? deps.getIndexedFiles() : deps.indexedFiles);
  const getSession = (): WorkspaceSession | null => (deps.getActiveSession ? deps.getActiveSession() : deps.activeSession);
  // Renderer cutover must preserve value-search semantics without reintroducing loadAll; implement native/session-side value search before removing the legacy path.
  // Slim PARAM session — Parse once → Project many (B6). C# ParamDocumentSessionCache is native authority;
  // Electron only keeps opaque token + lightweight binding. Never touches paramAllCache / includeAllPayloads.
  handle(PARAM_SESSION_IPC_CHANNELS.open, async (_event, request: unknown) => {
    _forensicsInc('param:main:open:count');
    const req = request as { sourceUri?: string } | undefined;
    const sourceUri = typeof req?.sourceUri === 'string' ? req.sourceUri : '';
    const file = getFiles().find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return sanitizeRendererValue({
        ok: false,
        diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法打开 PARAM 会话。', sourceUri }]
      });
    }
    if (isParamBackupPath(file.relativePath)) {
      return sanitizeRendererValue({
        ok: false,
        diagnostics: [{ severity: 'error' as const, code: 'BACKUP_READ_FORBIDDEN', message: '备份文件只能在“历史与恢复”中只读查看。', sourceUri }]
      });
    }
    const session = getSession();
    if (!session) {
      return sanitizeRendererValue({
        ok: false,
        diagnostics: [{ severity: 'error' as const, code: 'PARAM_OPEN_NO_SESSION', message: '需要已打开的工作区才能打开 PARAM 会话。', sourceUri }]
      });
    }
    const roots = await deps.verifiedReadRoots(session!, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) {
      return sanitizeRendererValue({ ok: false, diagnostics: roots.diagnostics });
    }
    const workspaceSessionId = deps.getActiveWorkspaceSessionId ? deps.getActiveWorkspaceSessionId() : deps.activeWorkspaceSessionId;
    const oodle = session.layers?.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {};
    const result = await runBridge<{
      sourceHash?: string;
      typeName?: string;
      rowCount?: number;
      rowDataSize?: number;
      rows?: Array<{ rowIndex: number; id: number; name?: string | null; dataHash: string }>;
      sessionToken?: string;
      pathSourceGeneration?: number;
      telemetry?: unknown;
    }>({
      command: 'read-param-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      commandOptions: { includeRowPayloads: false, includeRowHashes: true, rowPage: 0, rowPageSize: PARAM_PAGE_SIZE },
      ...oodle
    });
    if (result.parseStatus === 'failed' || !result.data?.sessionToken) {
      return sanitizeRendererValue({ ok: false, diagnostics: sanitizeDiagnostics(result.diagnostics) });
    }
    const sessionToken = result.data.sessionToken;
    const sourceHash = result.data.sourceHash ?? '';
    const pathSourceGeneration = typeof result.data.pathSourceGeneration === 'number' ? result.data.pathSourceGeneration : 0;
    sessionBindings.set(sessionToken, {
      sourceUri,
      workspaceSessionId: workspaceSessionId ?? '',
      sourceHash,
      pathSourceGeneration
    });
    const rows = (result.data.rows ?? []).map((r) => ({
      rowIndex: r.rowIndex,
      id: r.id,
      name: (r.name ?? null) as string | null,
      dataHash: r.dataHash ?? ''
    }));
    const typeName = result.data.typeName ?? 'UNKNOWN_PARAM';
    const rowDataSize = result.data.rowDataSize ?? 0;
    const resolved = typeName
      ? await resolveTrustedParamDefinition(typeName, rowDataSize)
      : { document: null, trusted: false, diagnostic: null };
    _forensicsInc('param:main:open:indexRows', rows.length);
    return sanitizeRendererValue({
      ok: true,
      sessionToken,
      workspaceSessionId: workspaceSessionId ?? '',
      sourceHash,
      pathSourceGeneration,
      rowCount: result.data.rowCount ?? rows.length,
      metadata: projectParamSessionMetadata(typeName, rowDataSize, resolved),
      nativeTelemetry: projectParamNativeTelemetry(result.data.telemetry),
      firstPage: { page: 0, pageSize: PARAM_PAGE_SIZE, rows },
      diagnostics: sanitizeDiagnostics(result.diagnostics)
    });
  });
  handle(PARAM_SESSION_IPC_CHANNELS.readIndexPage, async (_event, request: unknown) => {
    _forensicsInc('param:main:readIndexPage:count');
    const req = request as { sourceUri?: string; sessionToken?: string; page?: number; pageSize?: number } | undefined;
    const sourceUri = typeof req?.sourceUri === 'string' ? req.sourceUri : '';
    const sessionToken = typeof req?.sessionToken === 'string' ? req.sessionToken : '';
    const page = typeof req?.page === 'number' ? req.page : 0;
    const pageSize = typeof req?.pageSize === 'number' ? req.pageSize : PARAM_PAGE_SIZE;
    if (!sessionToken) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'PARAM_SESSION_TOKEN_REQUIRED', message: '缺少 PARAM 会话令牌。', sourceUri }] });
    }
    const binding = sessionBindings.get(sessionToken);
    if (!binding || binding.sourceUri !== sourceUri) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'PARAM_SESSION_BINDING_MISMATCH', message: '会话与资源不匹配，请重开 PARAM 会话。', sourceUri }] });
    }
    const file = getFiles().find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 PARAM 索引页。', sourceUri }] });
    }
    const session = getSession();
    if (!session) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'PARAM_READ_NO_SESSION', message: '需要已打开的工作区。', sourceUri }] });
    }
    const roots = await deps.verifiedReadRoots(session!, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return sanitizeRendererValue({ ok: false, diagnostics: roots.diagnostics });
    const oodle = session.layers?.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {};
    const result = await runBridge<{
      rowCount?: number;
      rows?: Array<{ rowIndex: number; id: number; name?: string | null; dataHash: string }>;
      sessionToken?: string;
      telemetry?: unknown;
    }>({
      command: 'read-param-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 60_000,
      commandOptions: { documentSession: sessionToken, includeRowPayloads: false, includeRowHashes: true, rowPage: page, rowPageSize: pageSize },
      ...oodle
    });
    if (result.parseStatus === 'failed') {
      return sanitizeRendererValue({ ok: false, diagnostics: sanitizeDiagnostics(result.diagnostics) });
    }
    const rows = (result.data?.rows ?? []).map((r) => ({ rowIndex: r.rowIndex, id: r.id, name: (r.name ?? null) as string | null, dataHash: r.dataHash ?? '' }));
    _forensicsInc('param:main:readIndexPage:indexRows', rows.length);
    return sanitizeRendererValue({
      ok: true,
      sessionToken,
      rowCount: result.data?.rowCount ?? rows.length,
      page,
      pageSize,
      rows,
      nativeTelemetry: projectParamNativeTelemetry(result.data?.telemetry),
      diagnostics: sanitizeDiagnostics(result.diagnostics)
    });
  });
  // rowSelections — slim selected-row projection (B4.3)
  handle(PARAM_SESSION_IPC_CHANNELS.readRows, async (_event, request: unknown) => {
    _forensicsInc('param:main:readRows:count');
    const req = request as { sourceUri?: string; sessionToken?: string; rows?: Array<{ rowIndex: number; id: number; dataHash: string }> } | undefined;
    const sourceUri = typeof req?.sourceUri === 'string' ? req.sourceUri : '';
    const sessionToken = typeof req?.sessionToken === 'string' ? req.sessionToken : '';
    const rowsIn = Array.isArray(req?.rows) ? req.rows : [];
    if (!sessionToken) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'PARAM_SESSION_TOKEN_REQUIRED', message: '缺少 PARAM 会话令牌。', sourceUri }] });
    }
    if (rowsIn.length === 0) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'PARAM_ROW_SELECTION_EMPTY', message: '未选择任何行。', sourceUri }] });
    }
    if (rowsIn.length > PARAM_ROW_PAYLOAD_BATCH_MAX) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'PARAM_ROW_SELECTION_TOO_LARGE', message: `单次选中行请求 ${rowsIn.length} 行超过上限 ${PARAM_ROW_PAYLOAD_BATCH_MAX}。`, sourceUri }] });
    }
    const binding = sessionBindings.get(sessionToken);
    if (!binding || binding.sourceUri !== sourceUri) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'PARAM_SESSION_BINDING_MISMATCH', message: '会话与资源不匹配，请重开 PARAM 会话。', sourceUri }] });
    }
    const file = getFiles().find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引。', sourceUri }] });
    }
    const session = getSession();
    if (!session) {
      return sanitizeRendererValue({ ok: false, diagnostics: [{ severity: 'error' as const, code: 'PARAM_READ_NO_SESSION', message: '需要已打开的工作区。', sourceUri }] });
    }
    const roots = await deps.verifiedReadRoots(session!, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return sanitizeRendererValue({ ok: false, diagnostics: roots.diagnostics });
    const rowSelections = rowsIn.map((r) => ({ rowIndex: r.rowIndex, expectedId: r.id, expectedDataHash: r.dataHash }));
    const oodle2 = session.layers?.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {};
    const result = await runBridge<{
      rows?: Array<{ rowIndex: number; id: number; name?: string | null; dataBase64: string; dataHash: string }>;
      sessionToken?: string;
      telemetry?: unknown;
    }>({
      command: 'read-param-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 60_000,
      commandOptions: { documentSession: sessionToken, includeRowPayloads: true, rowSelections },
      ...oodle2
    });
    if (result.parseStatus === 'failed') {
      return sanitizeRendererValue({ ok: false, diagnostics: sanitizeDiagnostics(result.diagnostics) });
    }
    const payloadRows = (result.data?.rows ?? []).map((r) => ({
      identity: { rowIndex: r.rowIndex, id: r.id, dataHash: r.dataHash ?? '' },
      dataBase64: r.dataBase64
    }));
    _forensicsInc('param:main:readRows:payloadRows', payloadRows.length);
    return sanitizeRendererValue({
      ok: true,
      sessionToken,
      rows: payloadRows,
      nativeTelemetry: projectParamNativeTelemetry(result.data?.telemetry),
      diagnostics: sanitizeDiagnostics(result.diagnostics)
    });
  });
async function unpackContainerParamChild(input: {
  containerPath: string;
  containerUri: string;
  containerHash: string;
  /** 条目索引，或条目名（basename，如 `AtkParam_Npc.param`）。 */
  entry: { index: number } | { name: string };
}): Promise<
  | { ok: true; child: UnpackedParamChild; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const storage = getSession() ? deps.durableStoragePaths(getSession()!.meta.workspaceId) : null;
  if (!getSession() || !storage) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'PARAM_UNPACK_NO_SESSION',
        message: '没有活动工作区会话，无法解包容器内 param（解包产物需要会话暂存区）。',
        sourceUri: input.containerUri
      }]
    };
  }

  // ROOT-07：解包需要 staging——mkdir → realpath → boundary check 后注册。
  const roots = await prepareBridgeRoots(deps.bridgeRootSession(getSession()!, storage), 'stage');
  if (!roots.ok) {
    return {
      ok: false,
      diagnostics: [deps.bridgeRootsDiagnostic('PARAM_UNPACK_STAGING_PREPARE_FAILED', roots)]
    };
  }
  const allowedRoots = [...roots.allowedRoots];
  const oodle = getSession()!.layers.baseRoot
    ? { oodleRuntimeRoot: getSession()!.layers.baseRoot as string }
    : {};
  const workspaceSessionId = deps.getActiveWorkspaceSessionId
    ? deps.getActiveWorkspaceSessionId()
    : deps.activeWorkspaceSessionId;
  const bridgeSession = workspaceSessionId ? { workspaceSessionId } : {};

  // ── 第一步：枚举条目，把「名字」解析成索引 ──
  // 条目表按「容器 URI + 容器哈希」备忘（paramEntryTableCache）：整张表属于
  // 容器，不属于某一条。备忘命中时跳过 read-dcx-document —— 否则每次点表都
  // 先把整个 parambnd（game-side 是 KRAK，几十 MB）解压一遍，然后才发现
  // 解包缓存命中（问题 5-B）。失败路径不 set：一次瞬时失败不能被钉住。
  const entryTableKey = `${input.containerUri}#${input.containerHash}`;
  let named = paramEntryTableCache.get(entryTableKey);
  const entryTableReused = named !== undefined;
  if (!named) {
    const dcx = await runBridge<NativeDcxEnvelopeLike & { entries?: NativeBnd4EntryLike[] }>({
      command: 'list-bnd4-entries',
      filePath: input.containerPath,
      resourceUri: input.containerUri,
      allowedRoots,
      timeoutMs: 120_000,
      commandOptions: { includeContentHashes: true },
      ...bridgeSession,
      ...oodle
    });
    if (dcx.parseStatus === 'failed') {
      return { ok: false, diagnostics: sanitizeDiagnostics(dcx.diagnostics) };
    }
    const entries = dcx.data?.entries ?? dcx.data?.nested?.entries ?? [];
    if (entries.length === 0) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          code: 'PARAM_UNPACK_CONTAINER_EMPTY',
          message: 'Bridge 未返回容器内 BND4 条目表；该资源可能不是 param 容器。',
          sourceUri: input.containerUri
        }]
      };
    }

    const seen = new Set<string>();
    named = entries.map((entry, position) => ({
      index: entry.index ?? position,
      name: sanitizeEntryName(entry.name ?? `entry_${position}`, entry.index ?? position, seen),
      storedContentHash: entry.contentHash ?? ''
    }));
    paramEntryTableCache.set(entryTableKey, named);
  }
  // 先把联合类型解到局部常量再比较：直接在回调里访问 input.entry.index
  // 拿不到窄化后的类型（回调边界会丢失 `'index' in` 的判别结果）。
  const wanted = input.entry;
  const target = 'index' in wanted
    ? named.find((candidate) => candidate.index === wanted.index)
    : named.find((candidate) => candidate.name === wanted.name);
  if (!target) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'PARAM_UNPACK_ENTRY_NOT_FOUND',
        message: `容器内没有匹配的 param 条目：${JSON.stringify(input.entry)}。`,
        sourceUri: input.containerUri
      }]
    };
  }

  // 缓存键含容器哈希：容器被写回后哈希变化，旧解包不会被误用。
  const cacheKey = `${input.containerUri}#${input.containerHash}#${target.index}`;
  const directCachedChild = unpackedParamCache.get(cacheKey);
  // 扫描是异步补 sha256 的：首次点击可能用「路径摘要」建缓存，下一次
  // 点击时同一 IndexedFile 已被后台补上真实容器哈希。不能因为缓存键变了
  // 就重新解包到另一条路径——调用方手里的 native document session token
  // 绑定的是旧路径。先按 sourceUri + entryIndex + native 条目内容哈希
  // 找到旧缓存，再把它挂到新键；若条目内容真的变了，storedContentHash
  // 不会相等，仍然走重新解包和新 session。
  const migratedCachedChild = directCachedChild === undefined
    ? [...unpackedParamCache.entries()].find(([key, candidate]) =>
        key.startsWith(`${input.containerUri}#`)
        && candidate.entryIndex === target.index
        && candidate.storedContentHash === target.storedContentHash
        && existsSync(candidate.absolutePath))?.[1]
    : undefined;
  const cachedChild = directCachedChild ?? migratedCachedChild;
  // 缓存命中还要求条目哈希未变：容器被写回后条目内容会变，沿用旧的
  // storedContentHash 会让 write-bnd4 的并发保护形同虚设（拿一个过期哈希去比对，
  // 要么误拒要么放过本该拒绝的覆盖）。哈希不符时重新解包。
  if (cachedChild
    && cachedChild.storedContentHash === target.storedContentHash
    && existsSync(cachedChild.absolutePath)) {
    if (migratedCachedChild !== undefined) unpackedParamCache.set(cacheKey, migratedCachedChild);
    return {
      ok: true,
      child: cachedChild,
      diagnostics: [{
        severity: 'info',
        code: 'PARAM_UNPACK_CACHE_HIT',
        message: `复用已解包的 ${cachedChild.name}。`
          + (entryTableReused ? '（条目表亦复用，本次未解压容器）' : '（本次重新枚举了条目表）')
          + (migratedCachedChild !== undefined ? '（后台补齐容器哈希后仍复用原暂存文件）' : ''),
        sourceUri: input.containerUri
      }]
    };
  }

  // ── 第二步：解包到会话暂存区 ──
  //
  // 不用 stageBridgeOutput：它用完即删，而解包产物要跨多次分页调用存活。
  // 目录名含容器哈希前缀与条目索引，避免不同容器/条目互相覆盖。
  const unpackDirectory = join(
    storage.stagingRoot,
    'param-unpack',
    `${input.containerHash.slice(0, 16)}-${target.index}`
  );
  const outputPath = join(unpackDirectory, target.name);
  // StrictMode/快速切换可能让同一个条目同时进入两次。解包是昂贵的 native
  // 写暂存操作，必须共享同一条 in-flight promise；键额外带 stagingRoot，避免
  // 两个工作区恰好打开同一 sourceUri/hash 时把一个工作区的路径交给另一个。
  const extractionKey = `${cacheKey}#${resolve(storage.stagingRoot)}`;
  let extraction = unpackedParamInFlight.get(extractionKey);
  if (!extraction) {
    extraction = (async (): Promise<ParamUnpackExtractionResult> => {
      try {
        await mkdir(unpackDirectory, { recursive: true });
      } catch (error) {
        return {
          parseStatus: 'failed',
          outputExists: false,
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_UNPACK_STAGING_PREPARE_FAILED',
            message: `解包暂存目录创建失败：${error instanceof Error ? error.message : String(error)}`,
            sourceUri: input.containerUri
          }]
        };
      }

      try {
        const extracted = await runBridge({
          command: 'extract-bnd4-child',
          filePath: input.containerPath,
          resourceUri: input.containerUri,
          allowedRoots,
          // 写命令必须显式声明 main 拥有的可写根，否则 Bridge 报
          // BRIDGE_WRITABLE_ROOT_REQUIRED（实测）。只给 stagingRoot —— 解包永远
          // 不该能写到原版目录或 Mod 工作区。
          writableRoots: [storage.stagingRoot],
          timeoutMs: 120_000,
          commandOptions: { entryIndex: target.index, outputPath },
          ...bridgeSession,
          ...oodle
        });
        return {
          parseStatus: extracted.parseStatus,
          outputExists: existsSync(outputPath),
          diagnostics: sanitizeDiagnostics(extracted.diagnostics)
        };
      } catch (error) {
        return {
          parseStatus: 'failed',
          outputExists: false,
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_UNPACK_EXTRACT_EXCEPTION',
            message: `解包 ${target.name} 时 Bridge 调用异常：${error instanceof Error ? error.message : String(error)}`,
            sourceUri: input.containerUri
          }]
        };
      }
    })();
    unpackedParamInFlight.set(extractionKey, extraction);
    void extraction.finally(() => {
      if (unpackedParamInFlight.get(extractionKey) === extraction) {
        unpackedParamInFlight.delete(extractionKey);
      }
    }).catch(() => undefined);
  }
  const extracted = await extraction;
  if (extracted.parseStatus === 'failed' || !existsSync(outputPath)) {
    return {
      ok: false,
      diagnostics: [
        ...extracted.diagnostics,
        {
          severity: 'error',
          code: 'PARAM_UNPACK_EXTRACT_FAILED',
          message: `解包 ${target.name} 失败，未产出可读文件。`,
          sourceUri: input.containerUri
        }
      ]
    };
  }

  const child: UnpackedParamChild = {
    absolutePath: outputPath,
    entryIndex: target.index,
    name: target.name,
    storedContentHash: target.storedContentHash
  };
  unpackedParamCache.set(cacheKey, child);
  return {
    ok: true,
    child,
    diagnostics: [{
      severity: 'info',
      code: 'PARAM_UNPACK_COMPLETE',
      message: `已解包 ${target.name}（条目 ${target.index}/${named.length}）。`
        + (entryTableReused ? '（条目表复用，本次未枚举容器）' : '（本次重新枚举了条目表）'),
      sourceUri: input.containerUri
    }]
  };
}

/** Inner BND4 entry row from the Bridge `read-dcx-document` command. */
interface ScriptDcxEntryLike {
  index?: number;
  id?: number;
  name?: string;
  flags?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  contentHash?: string;
}

interface ScriptDcxDocumentLike {
  format?: string;
  nested?: {
    format?: string;
    entryCount?: number;
    entries?: ScriptDcxEntryLike[];
    authority?: string;
  };
}

/** Bounded sample fallback from the Bridge `inventory-asset-resources` command. */
interface ScriptInventoryEntryLike {
  name?: string;
  index?: number;
  uncompressedSize?: number;
  compressedSize?: number;
  flags?: number;
  id?: number;
}

interface ScriptInventoryDataLike {
  format?: string;
  containerType?: string;
  entryCount?: number;
  entries?: ScriptInventoryEntryLike[];
  sampleEntries?: ScriptInventoryEntryLike[];
  extensionDistribution?: Record<string, number>;
  resourceKindDistribution?: Record<string, number>;
}

/**
 * 把 Bridge 枚举行映射成 renderer-safe 脚本条目 DTO。
 *
 * Sekiro luabnd 内层名是构建机绝对路径（如
 * `N:\NTC\data\Target\INTERROOT_win64\script\ai\out\bin\goal_list.lua`），直接
 * 出站会被 sanitizeRendererValue 的 maskPathFragments 打成 `[本机路径已隐藏]`。
 * 因此出站名一律经 sanitizeEntryName 液化到 basename（重名加 `#index`，与
 * PARAM 解包 / enumerateNativeContainerEntries 同口径）；分类与扩展名仍按
 * 原始名判定（液化名带 `#index` 后缀会污染扩展名解析）。
 */
function scriptEntryEvidenceFromBridge(
  entry: ScriptDcxEntryLike | ScriptInventoryEntryLike,
  size: number,
  seen: Set<string>
): ScriptContainerEntryEvidence {
  const rawName = entry.name ?? `entry_${entry.index ?? 0}`;
  const name = sanitizeEntryName(rawName, entry.index ?? 0, seen);
  const classification = classifyScriptEntry(rawName);
  return {
    name,
    index: entry.index ?? 0,
    size,
    extension: rawName.split('.').pop()?.toLowerCase() ?? '',
    classification,
    magicLabel: magicLabel(classification)
  };
}

/**
 * 脚本容器内子项按 BND4 `entryIndex` 用 Bridge native 读链取真实字节
 * （13-A：luabnd 里的 Lua 必须能点开看到反编译文本）。
 *
 * 枚举走 `read-dcx-document`（与 listScriptContainerEntriesPage / PARAM
 * unpackContainerParamChild 同源，只读），取字节走 `snapshot-bnd4-child`
 * （与 core scriptContainerEvidence 的 magic 采样同命令，返回完整
 * contentBase64）。刻意**不**走 readContainerChild → readSyntheticBnd：
 * 合成 SFBN 只认 TS 合成 BND，真 luabnd 无 SFBN 标记必失败（红字英文
 * `not authoritative`），反编译器一行都吃不到字节。
 *
 * 返回的 `name` 是 sanitizeEntryName 液化的 basename（内层名是构建机绝对路径，
 * 直接入 DTO 会被打码成 `[本机路径已隐藏]`）；`rawName`/`storedContentHash`
 * 供主进程内部使用。
 */
interface ReadScriptContainerChildResult {
  ok: true;
  bytes: Uint8Array;
  rawName: string;
  /** sanitizeEntryName 液化的 basename（DTO 出站名）。 */
  name: string;
  storedContentHash: string;
  diagnostics: StructuredDiagnostic[];
}
async function readScriptContainerChildByIndex(input: {
  containerPath: string;
  containerUri: string;
  entryIndex: number;
  allowedRoots: string[];
}): Promise<ReadScriptContainerChildResult | { ok: false; diagnostics: StructuredDiagnostic[] }> {
  const dcx = await runBridge<ScriptDcxDocumentLike>({
    command: 'read-dcx-document',
    filePath: input.containerPath,
    resourceUri: input.containerUri,
    allowedRoots: input.allowedRoots,
    timeoutMs: 60_000
  });
  if (dcx.parseStatus === 'failed') {
    return { ok: false, diagnostics: sanitizeDiagnostics(dcx.diagnostics) };
  }
  const entries = dcx.data?.nested?.entries ?? [];
  const target = entries.find((entry) => (entry.index ?? -1) === input.entryIndex);
  if (!target || !target.name) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error' as const,
        code: 'SCRIPT_SOURCE_ENTRY_NOT_FOUND',
        message: `脚本容器内没有索引 ${input.entryIndex} 的条目。`,
        sourceUri: input.containerUri
      }]
    };
  }
  const snapshot = await runBridge<{ contentBase64?: string }>({
    command: 'snapshot-bnd4-child',
    filePath: input.containerPath,
    resourceUri: input.containerUri,
    allowedRoots: input.allowedRoots,
    timeoutMs: 120_000,
    commandOptions: { entryIndex: input.entryIndex }
  });
  if (snapshot.parseStatus === 'failed' || !snapshot.data?.contentBase64) {
    return {
      ok: false,
      diagnostics: [
        ...sanitizeDiagnostics(snapshot.diagnostics),
        {
          severity: 'error' as const,
          code: 'SCRIPT_SOURCE_CHILD_SNAPSHOT_FAILED',
          message: `读取脚本容器条目 ${target.name}（索引 ${input.entryIndex}）字节失败。`,
          sourceUri: input.containerUri
        }
      ]
    };
  }
  const name = sanitizeEntryName(target.name, input.entryIndex, new Set());
  return {
    ok: true,
    bytes: new Uint8Array(Buffer.from(snapshot.data.contentBase64, 'base64')),
    rawName: target.name,
    name,
    storedContentHash: target.contentHash ?? '',
    diagnostics: []
  };
}


type ParamMetadataLoadResult = {
  package: ParamMetadataPackage | null;
  diagnostic: { code: string; message: string } | null;
};

let paramMetadataCache: {
    loaded: true;
    package: ParamMetadataPackage | null;
    diagnostic: { code: string; message: string } | null;
  } | null = null;

  const loadParamMetadataOnce = async (): Promise<ParamMetadataLoadResult> => {
    if (paramMetadataCache) return paramMetadataCache;
    try {
      const loaded = loadFirstPartyParamMetadata();
      if (!loaded.ok) {
        const first = loaded.diagnostics[0];
        paramMetadataCache = {
          loaded: true,
          package: null,
          diagnostic: {
            code: first?.code ?? 'PARAM_FIRST_PARTY_SCHEMA_UNAVAILABLE',
            message: first?.message ?? 'SoulForge 内置 PARAM schema 不可用。'
          }
        };
        return paramMetadataCache;
      }
      paramMetadataCache = { loaded: true, package: loaded.package, diagnostic: null };
      return paramMetadataCache;
    } catch (error) {
      paramMetadataCache = {
        loaded: true,
        package: null,
        diagnostic: {
          code: 'PARAM_FIRST_PARTY_SCHEMA_LOAD_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }
      };
      return paramMetadataCache;
    }
  };

  // 多个 PARAM handler 可能在冷启动同时请求同一份元数据（容器条目列表
  // 会主动预取，选中行又会解析字段）。共享 in-flight promise，避免 cache
  // 尚未落地时重复导入/校验同一套包，把 UI 的首行等待时间放大。
  let paramMetadataLoad: Promise<ParamMetadataLoadResult> | null = null;
  const loadParamMetadata = (): Promise<ParamMetadataLoadResult> => {
    if (paramMetadataCache) return Promise.resolve(paramMetadataCache);
    if (paramMetadataLoad) return paramMetadataLoad;
    paramMetadataLoad = loadParamMetadataOnce().finally(() => {
      paramMetadataLoad = null;
    });
    return paramMetadataLoad;
  };

  /**
   * 走**正规**路径取字段定义：内置包校验 → 描述符匹配 → 原生行宽核对。
   *
   * 此前生产侧是 `definitions.find((e) => e.document.typeName === typeName)`，
   * 绕过了 matchParamMetadataPackage 的五键严格匹配、包摘要与行宽检查。
   * 这些检查守的是「同名定义内容或版本不一致」——偏移对不上就是
   * 往错误字节位置写数值，存出来的 param 静默损坏。
   *
   * 返回的 origin 决定渲染器是否放行字段写入：只有 first-party 定义在包摘要、
   * 五键匹配和原生行宽核对均通过时，才放行字段写入；外部 schema 不再进入生产链。
   */
  const resolveTrustedParamDefinition = async (
    typeName: string,
    rowDataSize: number
  ): Promise<{
    document: ParamDefDocument | null;
    trusted: boolean;
    diagnostic: { code: string; message: string } | null;
  }> => {
    const metadata = await loadParamMetadata();
    if (!metadata.package) {
      return { document: null, trusted: false, diagnostic: metadata.diagnostic };
    }
    const candidates = metadata.package.definitions.filter((candidate) =>
      candidate.document.typeName === typeName && candidate.document.rowDataSize === rowDataSize
    );
    if (candidates.length === 0) {
      return {
        document: null,
        trusted: false,
        diagnostic: {
          code: 'PARAM_METADATA_TYPE_NOT_FOUND',
          message: `元数据包里没有类型 ${typeName} 的字段定义。`
        }
      };
    }
    if (candidates.length !== 1) {
      return {
        document: null,
        trusted: false,
        diagnostic: {
          code: 'PARAM_METADATA_AMBIGUOUS_MATCH',
          message: `内置 PARAM schema 对 ${typeName} 与行宽 ${rowDataSize} 存在多个定义，拒绝猜测。`
        }
      };
    }
    const entry = candidates[0]!;
    const matched = matchParamMetadataPackage(metadata.package, entry.key, undefined);
    if (!matched.ok) {
      return {
        document: null,
        trusted: false,
        diagnostic: {
          code: matched.diagnostics[0]?.code ?? 'PARAM_METADATA_MATCH_REJECTED',
          message: matched.diagnostics[0]?.message ?? '内置 PARAM schema 匹配被拒绝。'
        }
      };
    }
    return {
      document: { ...matched.definition.document, origin: 'first-party' },
      trusted: true,
      diagnostic: null
    };
  };

  /**
   * Re-resolve a renderer-supplied field definition against the immutable
   * first-party package before any bytes are mutated. Origin is a projection,
   * not an authority: a caller must not be able to forge `origin: first-party`
   * together with an arbitrary offset/layout and reach the writer.
   */
  const resolveCanonicalParamFieldDefinition = async (
    input: unknown
  ): Promise<
    | { ok: true; definition: ParamDefDocument }
    | { ok: false; diagnostic: { code: string; message: string } }
  > => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return {
        ok: false,
        diagnostic: {
          code: 'PARAM_FIELD_DEFINITION_INVALID',
          message: '字段定义不是有效对象，拒绝写入。'
        }
      };
    }
    const candidate = input as Record<string, unknown>;
    const typeName = typeof candidate.typeName === 'string' ? candidate.typeName.trim() : '';
    const rowDataSize = typeof candidate.rowDataSize === 'number' ? candidate.rowDataSize : NaN;
    if (!typeName || !Number.isSafeInteger(rowDataSize) || rowDataSize <= 0) {
      return {
        ok: false,
        diagnostic: {
          code: 'PARAM_FIELD_DEFINITION_INVALID',
          message: '字段定义缺少有效的 typeName 或 rowDataSize，拒绝写入。'
        }
      };
    }
    const resolved = await resolveTrustedParamDefinition(typeName, rowDataSize);
    if (!resolved.document || !resolved.trusted) {
      return {
        ok: false,
        diagnostic: resolved.diagnostic ?? {
          code: 'PARAM_FIELD_DEFINITION_NOT_TRUSTED',
          message: '字段定义未通过 SoulForge 内置 schema 校验，拒绝写入。'
        }
      };
    }
    return { ok: true, definition: resolved.document };
  };

  function projectParamSessionMetadata(
    typeName: string,
    rowDataSize: number,
    resolved: {
      document: ParamDefDocument | null;
      trusted: boolean;
      diagnostic: { code: string; message: string } | null;
    }
  ): ParamSessionMetadata {
    return {
      typeName,
      rowDataSize,
      fieldDefs: resolved.document?.fields ?? null,
      fieldEnums: resolved.document?.enums ?? null,
      fieldDefsDiagnostic: resolved.diagnostic,
      fieldDefsOrigin: resolved.document?.origin ?? null,
      fieldDefsTrusted: resolved.trusted
    };
  }

  /** 当前元数据包的身份与信任状态，供界面显示确认入口。 */
  handle('param.metadata.trustState', async () => {
    const metadata = await loadParamMetadata();
    if (!metadata.package) {
      return {
        ok: false,
        trusted: false,
        packageId: null,
        packageVersion: null,
        diagnostics: metadata.diagnostic
          ? [{
              severity: 'error' as const,
              code: metadata.diagnostic.code,
              message: metadata.diagnostic.message
            }]
          : []
      };
    }
    return {
      ok: true,
      trusted: true,
      packageId: metadata.package.packageId,
      packageVersion: metadata.package.packageVersion,
      sourceIdentity: metadata.package.source?.identity ?? null,
      sourceRevision: metadata.package.source?.revision ?? null,
      licenseSpdxExpression: metadata.package.license?.spdxExpression ?? null,
      diagnostics: []
    };
  });

  handle('param.metadata.setTrust', async (_event, trusted: boolean) => {
    void trusted;
    return {
      ok: false,
      trusted: true,
      diagnostics: [{
        severity: 'error' as const,
        code: 'PARAM_METADATA_EXTERNAL_SCHEMA_FORBIDDEN',
        message: '生产 PARAM 仅使用 SoulForge 内置 first-party schema，不接受外部 schema 或信任覆盖。'
      }]
    };
  });

  handle('resource.readParamDocument', async (_event, sourceUri: string) => {
    const file = getFiles().find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 PARAM。',
          sourceUri
        }]
      };
    }
    // PARAM-10A「backup 不读」：backup/previous 只经 History & Recovery 显式
    // 只读打开（ROUTE-06）。路由层挡住普通打开路径还不够——绕过路由直接
    // invoke 本通道的调用方也要被同一把锁拒绝，否则 backup 会以普通 PARAM
    // 文档的身份出现在编辑器里。
    if (isParamBackupPath(file.relativePath)) {
      return {
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        fieldDefs: null,
        fieldEnums: null,
        fieldDefsDiagnostic: null,
        fieldDefsOrigin: null,
        fieldDefsTrusted: false,
        rows: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'BACKUP_READ_FORBIDDEN',
          message: '备份文件只能在“历史与恢复”中只读查看，不能作为 PARAM 文档读取。',
          sourceUri
        }]
      };
    }
    const roots = await deps.verifiedReadRoots(getSession()!, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) {
      return sanitizeRendererValue({
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        fieldDefs: null,
        fieldEnums: null,
        fieldDefsDiagnostic: null,
        fieldDefsOrigin: null,
        fieldDefsTrusted: false,
        rows: [],
        diagnostics: roots.diagnostics
      });
    }
    const result = await readParamDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      maxRows: 500
    });
    // 字段定义：走 resolveTrustedParamDefinition（包校验 + 行宽核对 + 用户信任
    // 策略），不再直接 definitions.find(...) 绕过那三层检查。
    //
    // 缺失不影响行数据返回 —— 那部分来自 native 解析，是权威的。fieldDefs 为
    // null 时界面显示「无字段定义」并说明原因，而不是一个空的第三列。
    //
    // definitions[].document 才是 ParamDefDocument —— definitions[] 本身只有
    // key/digest/document 三项。逐字段核对过 shared/paramdef.ts，没有靠猜：
    // 第一版我写成 def.typeName、f.enumId、f.bitSize，三处全错（真实为
    // def.document.typeName、f.enumRef、f.bitfield）。IPC 边界上这类错误
    // typecheck 未必拦得住，只表现为「字段列空着」。
    const typeName = result.data?.typeName ?? '';
    const resolved = typeName && result.data
      ? await resolveTrustedParamDefinition(typeName, result.data.rowDataSize)
      : { document: null, trusted: false, diagnostic: null };
    const paramDef = resolved.document;
    // 行宽已在 resolveTrustedParamDefinition 里核对过：拿到 document 就意味着
    // 行宽一致，拿不到时它给出 ROW_WIDTH_MISMATCH 诊断。
    const rowWidthMatches = paramDef !== null;

    return sanitizeRendererValue({
      ok: result.ok,
      sourceUri,
      relativePath: file.relativePath,
      // 字段定义与行宽是否对得上：行宽不一致时不做解码 —— 用错位的布局解释字节
      // 会产出看起来合理但完全错误的数值，那比没有字段列危险得多。
      fieldDefs: rowWidthMatches && paramDef
        ? paramDef.fields.map((field) => ({
            id: field.id,
            name: field.name,
            type: field.type,
            offset: field.offset,
            size: field.size,
            ...(field.bitfield ? { bitfield: field.bitfield } : {}),
            ...(field.enumRef ? { enumRef: field.enumRef } : {}),
            // 跨表引用原样透传（解析在渲染器侧用 core 的纯函数做）：
            // 这里做解析会把一个字段变成一棵结构，IPC 面上更容易漂移。
            ...(field.refs ? { refs: field.refs } : {}),
            ...(field.min !== undefined ? { min: field.min } : {}),
            ...(field.max !== undefined ? { max: field.max } : {}),
             // 字段描述来自 SoulForge 内置 PARAM schema，与裸 param 读链和容器
             // readContainerParamPage/readContainerParamRowIndex 使用同一份定义。
            ...(field.description ? { description: field.description } : {})
          }))
        : null,
      // 枚举定义随字段一起给：界面要把 0/1/2 显示成可读名称，
      // 而不是让用户对着裸数字猜。
      fieldEnums: rowWidthMatches && paramDef?.enums
        ? paramDef.enums.map((enumDef) => ({
            id: enumDef.id,
            name: enumDef.name,
            // 枚举值的显示名叫 label（不是 name）——这是本轮第四处猜错的字段名，
            // 前三处是 def.typeName / f.enumId / f.bitSize。全部按
            // shared/paramdef.ts 逐字段核对后改正。
            values: enumDef.values.map((value) => ({ value: value.value, label: value.label }))
          }))
        : null,
      // 诊断统一来自 resolveTrustedParamDefinition：它区分内置包不可用、
      // 类型不存在、行宽不符和歧义匹配，各自给出可行动的码。
      fieldDefsDiagnostic: resolved.diagnostic,
      /**
       * 字段定义的授信状态。渲染器据此决定是否放行字段写入。
       *
       * first-party 与严格行宽匹配通过后放行；这个值不是渲染器自己拼的，
       * 而是主进程从内置包校验结果投影出来的。
       */
      fieldDefsOrigin: paramDef?.origin ?? null,
      fieldDefsTrusted: resolved.trusted,
      data: result.data
        ? {
            sourceHash: result.data.sourceHash,
            typeName: result.data.typeName,
            rowCount: result.data.rowCount,
            rowDataSize: result.data.rowDataSize,
            // dataBase64 必须逐行判类型：Bridge 对超出载荷门限的页不下发行字节
            // （见 resource.readParamPage 头部注释的实测因果），真实 gameparam
            // 几乎总是这种情况。此前无条件 Buffer.from(undefined) 会抛 TypeError，
            // 而 handle 包装没有 try/catch，于是整个 IPC promise reject，渲染器
            // 只看到「PARAM 读取异常」——把「本页没有字节」报成了「读取失败」。
            rows: result.data.rows.map((r) => ({
              id: r.id,
              ...(typeof r.dataBase64 === 'string'
                ? {
                    dataBase64: r.dataBase64,
                    dataHexPreview: Buffer.from(r.dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              dataHash: r.dataHash,
              ...(r.name ? { name: r.name } : {})
            })),
            rowsTruncated: result.data.rowCount > result.data.rows.length,
            authority: result.data.authority
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  /**
   * GPARAM-11A：graphics param（.gparam / .gparam.dcx）typed 读取。
   *
   * 与 PARAM 同一把锁：backup 不读（.bak/.prev 只经 History & Recovery 显式
   * 只读打开）；未索引资源结构化失败。Bridge 侧 read-gparam-document 解 DCX
   * （KRAK 需要 Oodle 运行时，故传 getSession()!.layers.baseRoot）并返回
   * 分组分页的 typed 文档 —— 不能借 PARAM parser，也不能把读取失败显示成
   * 空 bank（失败一律 ok:false + 结构化诊断）。
   */
  handle(
    'resource.readParamPage',
    async (
      _event,
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      query?: string,
      loadAll?: boolean
    ) => {
      _forensicsInc('param:main:readParamPage:count');
      if (loadAll) _forensicsInc('param:main:readParamPage:loadAllTrue:count');
      const file = getFiles().find((item) => item.sourceUri === sourceUri);
      const failure = (message: string, code = 'RESOURCE_NOT_INDEXED') => ({
        ok: false,
        sourceUri,
        sourceHash: null,
        rowCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        rows: [],
        rowsTruncated: false,
        diagnostics: [{
          severity: 'error' as const,
          code,
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('资源未索引，无法分页读取 PARAM。');
      }
      // PARAM-10A「backup 不读」：与 readParamDocument 同一把锁。backup 只经
      // History & Recovery 只读打开（ROUTE-06），分页通道不提供绕过出口。
      if (isParamBackupPath(file.relativePath)) {
        return failure('备份文件只能在“历史与恢复”中只读查看，不能分页读取 PARAM。', 'BACKUP_READ_FORBIDDEN');
      }
          // Legacy renderer compatibility path; remove only after renderer cutover and value-search replacement.
    let cached = loadAll ? paramAllCache.get(sourceUri) : paramPageCache.get(sourceUri);
      if (!cached) {
        // 直接调 Bridge 而不用 readParamDocumentViaBridge：后者不传 commandOptions。
        //
        // 注意原注释声称「不传 commandOptions 会让 C# 抛 InvalidOperationException」
        // ——2026-08-10 实测该说法**已不成立**：BridgeCommandService 的 optionsIsObject
        // 守卫（commit 5b669c6）修掉了那个 crash，现在不传会正常返回、只是没有行字节。
        // 保留显式空对象仍然是对的（不依赖对端的缺省行为），但理由变了，故更正记录，
        // 避免后来者按过期结论去「修」一个不存在的 crash。
        //
        // 这里刻意读全表（无 rowPage/rowPageSize）：全表用于 id/name 索引与跨页搜索。
        // 全表必然超出载荷门限因而无字节，当前页的字节在下方单独取一次。
        // loadAll（用户裁定 2026-08-14）则相反：includeAllPayloads 跳过门控，
        // 一次拿回全表 + 全部行字节（帧上限提到 32 MiB 绝对上限）。
        const roots = await deps.verifiedReadRoots(getSession()!, dirname(file.absolutePath));
        if (roots.diagnostics.length > 0) {
          return {
            ok: false,
            sourceUri,
            sourceHash: null,
            rowCount: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            rows: [],
            rowsTruncated: false,
            diagnostics: roots.diagnostics
          };
        }
        const result = await runBridge<{
          sourceHash?: string;
          typeName?: string;
          dataVersion?: number;
          rowCount?: number;
          rowDataSize?: number;
          rows?: Array<{ rowIndex: number; id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
          authority?: string;
        }>({
          command: 'read-param-document',
          filePath: file.absolutePath,
          allowedRoots: roots.allowedRoots,
          timeoutMs: 120_000,
          commandOptions: loadAll ? { includeAllPayloads: true } : {},
          ...(loadAll ? { maxFrameBytes: 32 * 1024 * 1024 } : {})
        });
        if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
          return {
            ok: false,
            sourceUri,
            sourceHash: null,
            rowCount: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            rows: [],
            rowsTruncated: false,
            diagnostics: result.diagnostics
          };
        }
        const rows = (result.data.rows ?? []).slice(0, MAX_PAGED_PARAM_ROWS);
        cached = {
          sourceHash: result.data.sourceHash,
          typeName: result.data.typeName ?? 'UNKNOWN_PARAM',
          rowDataSize: result.data.rowDataSize ?? 0,
          rowCount: result.data.rowCount ?? rows.length,
          rows,
          ...(result.data.authority ? { authority: result.data.authority } : {})
        };
        if (loadAll) paramAllCache.set(sourceUri, cached);
        else paramPageCache.set(sourceUri, cached);
      }
      const q = (query ?? '').trim().toLowerCase();
      const filtered = q.length === 0
        ? cached.rows
        : cached.rows.filter((row) =>
            String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
          );

      // ── 全量路径（用户裁定）：打开表一次返回全部行（含字节），renderer 本地
      //    过滤/虚拟化，不再分批续取。行字节已经随 includeAllPayloads 全量在手，
      //    不再走下方的页字节二次读取。字段定义照常解析（裸 param 路径的
      //    ParamDefPanel 依赖它，与 readParamDocument 同一套三层检查）。
      if (loadAll) {
        const loadAllTypeName = cached.typeName ?? '';
        const loadAllResolved = loadAllTypeName
          ? await resolveTrustedParamDefinition(loadAllTypeName, cached.rowDataSize)
          : { document: null, trusted: false, diagnostic: null };
        const loadAllParamDef = loadAllResolved.document;
        const loadAllWidthMatches = loadAllParamDef !== null;
        return {
          ok: true,
          sourceUri,
          sourceHash: cached.sourceHash,
          typeName: cached.typeName,
          rowDataSize: cached.rowDataSize,
          fieldDefs: loadAllWidthMatches && loadAllParamDef
            ? loadAllParamDef.fields.map((field) => ({
                id: field.id,
                name: field.name,
                type: field.type,
                offset: field.offset,
                size: field.size,
                ...(field.bitfield ? { bitfield: field.bitfield } : {}),
                ...(field.enumRef ? { enumRef: field.enumRef } : {}),
                ...(field.refs ? { refs: field.refs } : {}),
                ...(field.min !== undefined ? { min: field.min } : {}),
                ...(field.max !== undefined ? { max: field.max } : {}),
                // 与 readParamDocument / readContainerParamPage 一致：透传内置
                // schema 提供的 Description 悬停。
                ...(field.description ? { description: field.description } : {})
              }))
            : null,
          fieldEnums: loadAllWidthMatches && loadAllParamDef?.enums
            ? loadAllParamDef.enums.map((enumDef) => ({
                id: enumDef.id,
                name: enumDef.name,
                values: enumDef.values.map((value) => ({ value: value.value, label: value.label }))
              }))
            : null,
          fieldDefsDiagnostic: loadAllResolved.diagnostic,
          fieldDefsOrigin: loadAllParamDef?.origin ?? null,
          fieldDefsTrusted: loadAllResolved.trusted,
          rowCount: filtered.length,
          page: 0,
          pageSize: filtered.length,
          pageCount: 1,
          rows: filtered.map((row) => {
            const dataBase64 = typeof row.dataBase64 === 'string' ? row.dataBase64 : undefined;
            return {
              rowIndex: row.rowIndex,
              id: row.id,
              dataHash: row.dataHash,
              ...(dataBase64 !== undefined
                ? {
                    dataBase64,
                    dataHexPreview: Buffer.from(dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              ...(row.name ? { name: row.name } : {})
            };
          }),
          rowsTruncated: cached.rowCount > cached.rows.length,
          ...(cached.authority ? { authority: cached.authority } : {}),
          diagnostics: []
        };
      }
      const window = normalizePageWindow(
        filtered.length,
        requestedPage,
        requestedPageSize || PARAM_PAGE_SIZE
      );

      /**
       * 取当前页的真实行字节（见本 handler 头部注释的实测因果）。
       *
       * 仅在无搜索时进行：有搜索时页内容是过滤后的子集，与 bridge 的物理页不
       * 对应，按物理页取回的字节会**对错行**。宁可不给字节，也不能给错字节 ——
       * 错字节会被写回去，那是静默的数据损坏。
       *
       * 失败不影响行表：字节缺失只让字段编辑不可用，而 id/name 列表仍然有用。
       * 因此这里吞掉分页读取的失败但把诊断带出去，不让整个面板变空。
       */
      const pagePayloadsBare = new Map<number, { base64: string; dataHash: string }>();
      const pageByteDiagnostics: Diagnostic[] = [];
      if (q.length === 0 && window.size > 0) {
        const bridgePage = Math.floor(window.offset / window.size);
        const alignedOffset = bridgePage * window.size;
        if (alignedOffset === window.offset) {
          // ROOT-07：只读分页字节读取同样只传已存在并 verified 的 roots；
          // 失败与读取失败同语义——字节缺失只让字段编辑不可用，不影响行表。
          const pageRoots = await deps.verifiedReadRoots(getSession()!, dirname(file.absolutePath));
          if (pageRoots.diagnostics.length > 0) {
            pageByteDiagnostics.push(...pageRoots.diagnostics);
          } else {
          try {
            const paged = await runBridge<{
              rows?: Array<{ rowIndex: number; id: number; dataBase64?: string | null; dataHash: string }>;
              payloadsIncluded?: boolean;
            }>({
              command: 'read-param-document',
              filePath: file.absolutePath,
              allowedRoots: pageRoots.allowedRoots,
              timeoutMs: 60_000,
              commandOptions: { rowPage: bridgePage, rowPageSize: window.size }
            });
            for (const row of paged.data?.rows ?? []) {
              if (typeof row.dataBase64 === 'string') pagePayloadsBare.set(row.rowIndex, { base64: row.dataBase64, dataHash: row.dataHash });
            }
            if (paged.data?.payloadsIncluded === false) {
              pageByteDiagnostics.push({
                severity: 'info',
                code: 'PARAM_PAGE_PAYLOAD_OMITTED',
                message: '本页行字节未随分页下发（页字节数超出 Bridge 载荷门限）；'
                  + '字段编辑对本页不可用，行列表不受影响。',
                sourceUri
              });
            }
          } catch (error) {
            pageByteDiagnostics.push({
              severity: 'warning',
              code: 'PARAM_PAGE_PAYLOAD_READ_FAILED',
              message: `本页行字节读取失败：${error instanceof Error ? error.message : String(error)}`,
              sourceUri
            });
          }
          }
        }
      }

      return {
        ok: true,
        sourceUri,
        sourceHash: cached.sourceHash,
        typeName: cached.typeName,
        rowDataSize: cached.rowDataSize,
        rowCount: filtered.length,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        rows: filtered
          .slice(window.offset, window.offset + window.size)
          .map((row) => {
            // 字节优先取本页分页读取的结果（全表读取的行恒无字节，见头部注释）。
            // 两处都没有时如实不带该字段——绝不伪造字节。
            const payload = pagePayloadsBare.get(row.rowIndex);
            const dataBase64 = typeof row.dataBase64 === 'string'
              ? row.dataBase64
              : payload?.base64;
            const dataHash = typeof row.dataHash === 'string' && row.dataHash.length > 0 ? row.dataHash : payload?.dataHash ?? '';
            return {
              rowIndex: row.rowIndex,
              id: row.id,
              dataHash,
              ...(typeof dataBase64 === 'string'
                ? {
                    dataBase64,
                    dataHexPreview: Buffer.from(dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              ...(row.name ? { name: row.name } : {})
            };
          }),
        rowsTruncated: cached.rowCount > cached.rows.length,
        ...(cached.authority ? { authority: cached.authority } : {}),
        diagnostics: pageByteDiagnostics
      };
    }
  );

  handle(
    'resource.applyParamMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: {
        kind: 'upsert' | 'delete';
        id: number;
        dataBase64?: string;
        rowIndex?: number;
        expectedDataHash?: string;
      }
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === sourceUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 PARAM。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (mutation.kind === 'upsert' && !mutation.dataBase64) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_UPSERT_DATA_REQUIRED',
            message: 'PARAM upsert 需要 dataBase64。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(getSession()!.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(getSession()!, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const bridgeMutation =
        mutation.kind === 'delete'
          ? {
              kind: 'delete' as const,
              id: mutation.id,
              ...(mutation.rowIndex !== undefined ? { rowIndex: mutation.rowIndex } : {}),
              ...(mutation.expectedDataHash ? { expectedDataHash: mutation.expectedDataHash } : {})
            }
          : {
              kind: 'upsert' as const,
              id: mutation.id,
              dataBase64: mutation.dataBase64!,
              ...(mutation.rowIndex !== undefined ? { rowIndex: mutation.rowIndex } : {}),
              ...(mutation.expectedDataHash ? { expectedDataHash: mutation.expectedDataHash } : {})
            };
      const operationLog = await deps.ensureActiveOperationLog(getSession()!);
      // S29：裸 param 行写入同样走「哈希缺失现算」兜底，renderer 空串不拒写；
      // 现算值同时喂给 Bridge 的 expectedDocumentHash 与 Patch Engine 前置。
      const rowExpectedHash = expectedHash || file.sha256 || await deps.sha256FileNow(file.absolutePath);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: rowExpectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'param',
        stagingFileName: `${basename(file.relativePath)}.mut.param`,
        stageWrite: (context) => commitParamMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: rowExpectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation
        }),
        title: `PARAM mutation ${mutation.kind} ${mutation.id}`,
        confirmActionLabel: '提交 PARAM 变更'
      }, {
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(getSession()!, operationLog, storage, { knowledgeRefreshOwner: 'caller' })
      });
      if (outcome.status === 'committed' && outcome.result.ok) {
        await runCallerOwnedPostCommit(outcome.result, {
          prepare: () => { paramPageCache.delete(sourceUri); },
          refresh: (result) => deps.refreshActiveIndexAfterNativeWrite([sourceUri], result),
          onRefreshError: (result, error) => appendPostCommitFailureDiagnostic(
            result,
            'POSTCOMMIT_REFRESH_FAILED',
            sourceUri,
            error
          )
        });
      }
      return deps.toSaveResultFromOutcome(outcome, getFiles());
    }
  );

  handle(
    'resource.applyParamFieldMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: {
        rowId: number;
        rowIndex?: number;
        expectedDataHash?: string;
        fieldId: string;
        value: number | string | boolean;
        rowDataBase64: string;
        definition: unknown;
      }
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === sourceUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 PARAM。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;

      // Origin is not trusted merely because it arrived from the renderer.
      // Resolve the submitted shape back to the immutable first-party layout
      // before calculating any byte offset.
      const definitionResult = await resolveCanonicalParamFieldDefinition(mutation.definition);
      if (!definitionResult.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: definitionResult.diagnostic.code,
            message: definitionResult.diagnostic.message,
            sourceUri
          }]
        };
      }

      // Apply field-level mutation to get the modified row bytes
      const fieldResult = applyParamFieldMutation({
        rowDataBase64: mutation.rowDataBase64,
        definition: definitionResult.definition,
        fieldId: mutation.fieldId,
        value: mutation.value
      });
      if (!fieldResult.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: fieldResult.code,
            message: fieldResult.message,
            sourceUri
          }]
        };
      }

      // Send the modified row as a whole-row upsert to the Bridge
      const storage = deps.durableStoragePaths(getSession()!.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(getSession()!, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(getSession()!);
      // S29：裸 param 字段写入同样走「哈希缺失现算」兜底，renderer 空串不拒写。
      const fieldExpectedHash = expectedHash || file.sha256 || await deps.sha256FileNow(file.absolutePath);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: fieldExpectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'param',
        stagingFileName: `${basename(file.relativePath)}.field.param`,
        stageWrite: (context) => commitParamMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: fieldExpectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: {
            kind: 'upsert' as const,
            id: mutation.rowId,
            dataBase64: fieldResult.nextDataBase64,
            ...(mutation.rowIndex !== undefined ? { rowIndex: mutation.rowIndex } : {}),
            ...(mutation.expectedDataHash ? { expectedDataHash: mutation.expectedDataHash } : {})
          }
        }),
        title: `PARAM field set ${mutation.fieldId} on row ${mutation.rowId}`,
        confirmActionLabel: '提交 PARAM 字段变更'
      }, {
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(getSession()!, operationLog, storage, { knowledgeRefreshOwner: 'caller' })
      });
      if (outcome.status === 'committed' && outcome.result.ok) {
        await runCallerOwnedPostCommit(outcome.result, {
          prepare: () => { paramPageCache.delete(sourceUri); },
          refresh: (result) => deps.refreshActiveIndexAfterNativeWrite([sourceUri], result),
          onRefreshError: (result, error) => appendPostCommitFailureDiagnostic(
            result,
            'POSTCOMMIT_REFRESH_FAILED',
            sourceUri,
            error
          )
        });
      }
      return deps.toSaveResultFromOutcome(outcome, getFiles());
    }
  );

  /**
   * 容器内 param 的字段写入：改字段 → 重打包容器 → Patch Engine 提交。
   *
   * ── 为什么单独一条通道 ──
   *
   * resource.applyParamFieldMutation 的写目标是**裸 param 文件**；而用户实际打开
   * 的是 parambnd 容器，改动必须回到容器里才算生效。这一段此前缺失：write-param
   * 只能产出一个裸 param 暂存文件，没有路径把它塞回 BND4 再压 DCX。
   *
   * ── 三段链路，全部在 staging 完成，只有最后一步经 Patch Engine 落盘 ──
   *
   *   ① applyParamFieldMutation（TS）——把字段值编码进行字节，得到整行 base64；
   *   ② write-param（C#）——以整行 upsert 产出改过的裸 param（暂存）；
   *   ③ write-bnd4 replace（C#）——把该裸 param 按 entryIndex 塞回容器副本，
   *      C# 侧写完会重读验证（BND4_STAGING_WRITE_VERIFIED）。
   *
   * ②③ 的输出都落会话 stagingRoot；真正的落盘由 applyNativeMutation 的
   * commit port（Patch Engine）完成，含备份与回滚元数据。
   *
   * ── 实测（2026-08-10，mods/param/gameparam/gameparam.parambnd.dcx 副本）──
   *
   * 138 个条目：条目数不变，只有目标条目（index 7 = BehaviorParam）内容哈希变化，
   * 其余 137 个字节不变，write-bnd4 重读验证通过。也就是说重打包不会波及无关条目。
   *
   * ── expectedChildHash 为什么必须由调用方给 ──
   *
   * C# 的 replace 会拿它比对容器内当前条目的存储字节（Bnd4NativeWriter 的
   * RequireHash）。不给就没有并发保护：两个改动同时基于同一份旧字节时，
   * 后一个会静默覆盖前一个。渲染器持有解包时的条目哈希，原样回传。
   */
  handle(
    'resource.applyContainerParamFieldMutation',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      mutation: {
        entryIndex: number;
        expectedChildHash: string;
        rowIndex: number;
        rowId: number;
        expectedDataHash: string;
        expectedRowDataSize?: number;
        fieldId: string;
        value: number | string | boolean;
        rowDataBase64: string;
        definition: unknown;
      }
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入容器内 PARAM。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;

      // ① 先将 renderer 提交的定义重新绑定到 immutable first-party layout。
      //    不以 origin 字段作为权限证明，避免伪造来源后改变字段偏移。
      const definitionResult = await resolveCanonicalParamFieldDefinition(mutation.definition);
      if (!definitionResult.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: definitionResult.diagnostic.code,
            message: definitionResult.diagnostic.message,
            sourceUri: containerUri
          }]
        };
      }
      const definition = definitionResult.definition;
      const fieldResult = applyParamFieldMutation({
        rowDataBase64: mutation.rowDataBase64,
        definition,
        fieldId: mutation.fieldId,
        value: mutation.value
      });
      if (!fieldResult.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: fieldResult.code,
            message: fieldResult.message,
            sourceUri: containerUri
          }]
        };
      }

      // 解包目标条目：write-param 需要一个裸 param 作为输入基底。
      // S29：容器哈希缺失时现算（索引没扫到 sha256 的罕见情况），不挡写入。
      const containerHashNow = file.sha256 ?? await deps.sha256FileNow(file.absolutePath);
      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: containerHashNow,
        entry: { index: mutation.entryIndex }
      });
      if (!unpacked.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: sanitizeDiagnostics(unpacked.diagnostics)
        };
      }

      const storage = deps.durableStoragePaths(getSession()!.meta.workspaceId);
      // ROOT-07：stage 前 mkdir → realpath → boundary check；两处回调共用。
      const stage = await deps.verifiedStageRoots(getSession()!, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(getSession()!);
      const oodle = getSession()!.layers.baseRoot
        ? { oodleRuntimeRoot: getSession()!.layers.baseRoot as string }
        : {};

      // ② 先在暂存区产出改过的裸 param。用 stageBridgeOutput 而不是自己建目录：
      //    它保证输出路径不逃逸、用完清理，且失败带结构化诊断。
      const paramStage = await stageBridgeOutput({
        stagingRoot: storage.stagingRoot,
        prefix: 'param-field',
        fileName: `${basename(unpacked.child.name)}.mutated`,
        allowedRoots: () => [...stage.allowedRoots],
        write: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-param',
            filePath: unpacked.child.absolutePath,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 120_000,
            commandOptions: {
              outputPath: context.outputPath,
              // expectedDocumentHash 是 Bridge write-param 的必填并发保护：哈希不符
              // 说明「读与写之间条目被改过」，拒绝写入。实测（probeParamWrite）缺它会
              // 恒定 PARAM_STAGING_WRITE_FAILED。unpacked.child.storedContentHash 就是
              // 该裸 param 文件的 SourceHash（entry ContentHash 对存储字节取哈希）。
              // S29：storedContentHash 缺失时对解包文件现算（写前读到的就是写时文件）。
              expectedDocumentHash: unpacked.child.storedContentHash
                || await deps.sha256FileNow(unpacked.child.absolutePath),
              ...(mutation.expectedRowDataSize !== undefined ? { expectedRowDataSize: mutation.expectedRowDataSize } : {}),
              mutation: 'upsert',
              rowIndex: mutation.rowIndex,
              id: mutation.rowId,
              expectedDataHash: mutation.expectedDataHash,
              dataBase64: fieldResult.nextDataBase64
            }
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        }
      });
      if (!paramStage.ok || !paramStage.bytes) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            ...sanitizeDiagnostics(paramStage.result?.diagnostics ?? []),
            ...paramStage.diagnostics.map((diagnostic) => ({
              severity: 'error' as const,
              code: diagnostic.code,
              message: diagnostic.message,
              sourceUri: containerUri
            })),
            {
              severity: 'error' as const,
              code: 'PARAM_FIELD_STAGE_FAILED',
              message: '字段改动未能产出裸 param 暂存文件，容器未被修改。',
              sourceUri: containerUri
            }
          ]
        };
      }
      const mutatedChildBase64 = paramStage.bytes.toString('base64');

      // ③ 把裸 param 塞回容器，经 Patch Engine 提交重打包后的容器。
      const outcome = await applyNativeMutation({
        file,
        sourceUri: containerUri,
        expectedHash: containerHashNow,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'parambnd',
        stagingFileName: `${basename(file.relativePath)}.repacked`,
        stageWrite: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-bnd4',
            filePath: file.absolutePath,
            resourceUri: containerUri,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 180_000,
            commandOptions: {
              outputPath: context.outputPath,
              mutation: 'replace',
              expectedContainerHash: containerHashNow,
              entryIndex: mutation.entryIndex,
              // S29：child 哈希缺失时现算（解包文件即条目存储字节，与 C# Hash 同算法）。
              expectedChildHash: mutation.expectedChildHash
                || await deps.sha256FileNow(unpacked.child.absolutePath),
              contentBase64: mutatedChildBase64
            },
            ...oodle
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'BND4_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        },
        title: `PARAM field ${mutation.fieldId} on row ${mutation.rowId}`
          + ` in ${unpacked.child.name}`,
        confirmActionLabel: '提交容器内 PARAM 字段变更'
      }, {
        // S29：确认端口不再接入 —— writerContract 不再要求「高风险写入」确认，
        // 弹窗由 applyNativeMutation 的 requiresConfirmation 分支驱动，端口已无效果。
        commit: deps.sessionCommitPort(getSession()!, operationLog, storage, { knowledgeRefreshOwner: 'caller' })
      });

      if (outcome.status === 'committed' && outcome.result.ok) {
        await runCallerOwnedPostCommit(outcome.result, {
          prepare: () => {
            // 容器变了：行缓存、条目缓存与解包缓存全部失效，否则下一次读会拿到旧字节。
            paramPageCache.delete(containerUri);
            containerChildrenCache.clear();
            paramEntryTableCache.clear();
            containerParamAllCache.clear();
            unpackedParamCache.clear();
          },
          refresh: (result) => deps.refreshActiveIndexAfterNativeWrite([containerUri], result),
          onRefreshError: (result, error) => appendPostCommitFailureDiagnostic(
            result,
            'POSTCOMMIT_REFRESH_FAILED',
            containerUri,
            error
          )
        });
      }
      return deps.toSaveResultFromOutcome(outcome, getFiles());
    }
  );

  /**
   * 容器内 PARAM 的**行名**写入（T5-3）。
   *
   * 与 resource.applyContainerParamFieldMutation 走同一条 Patch 链（grok T5：
   * 「提交走与字段写入相同的 Patch 链，禁止 fs.writeFile 写 Mod」）：
   *
   *   ① write-param upsert（C#）—— 行数据原样回传、只带新 name，产出改过的裸 param；
   *   ② write-bnd4 replace（C#）—— 按 entryIndex 塞回容器副本，C# 侧重读验证；
   *   ③ 真正落盘由 applyNativeMutation 的 commit port（Patch Engine）完成，含备份
   *      与回滚元数据。
   *
   * name 允许空串（清掉该行名字）。upsert 的 dataBase64 必须原样携带当前行字节：
   * C# 的 ApplyCompactMutations 对 upsert 强制要求 dataBase64 且长度=行宽，
   * 名字只改不改数据，字节原样回传即可。
   */
  handle(
    'resource.applyContainerParamRowNameMutation',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      mutation: {
        entryIndex: number;
        expectedChildHash: string;
        rowIndex: number;
        rowId: number;
        expectedDataHash: string;
        expectedRowDataSize?: number;
        name: string;
        rowDataBase64: string;
      }
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入容器内 PARAM 行名。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      if (typeof mutation.name !== 'string') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_ROW_NAME_INVALID',
            message: '行名必须是字符串。',
            sourceUri: containerUri
          }]
        };
      }
      if (typeof mutation.rowDataBase64 !== 'string' || mutation.rowDataBase64.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_ROW_DATA_MISSING',
            message: '行名写入需要当前行字节（原样回传，避免写宽错位）。',
            sourceUri: containerUri
          }]
        };
      }

      // 解包目标条目：write-param 需要一个裸 param 作为输入基底。
      // S29：容器哈希缺失时现算（索引没扫到 sha256 的罕见情况），不挡写入。
      const containerHashNow = file.sha256 ?? await deps.sha256FileNow(file.absolutePath);
      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: containerHashNow,
        entry: { index: mutation.entryIndex }
      });
      if (!unpacked.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: sanitizeDiagnostics(unpacked.diagnostics)
        };
      }

      const storage = deps.durableStoragePaths(getSession()!.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(getSession()!, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(getSession()!);
      const oodle = getSession()!.layers.baseRoot
        ? { oodleRuntimeRoot: getSession()!.layers.baseRoot as string }
        : {};

      // ① 暂存区产出改过行名的裸 param。expectedDocumentHash = 该裸 param 的
      //    SourceHash（= 容器条目的 ContentHash，见字段写入的注释）。
      const paramStage = await stageBridgeOutput({
        stagingRoot: storage.stagingRoot,
        prefix: 'param-row-name',
        fileName: `${basename(unpacked.child.name)}.renamed`,
        allowedRoots: () => [...stage.allowedRoots],
        write: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-param',
            filePath: unpacked.child.absolutePath,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 120_000,
            commandOptions: {
              outputPath: context.outputPath,
              // S29：storedContentHash 缺失时对解包文件现算（写前读到的就是写时文件）。
              expectedDocumentHash: unpacked.child.storedContentHash
                || await deps.sha256FileNow(unpacked.child.absolutePath),
              ...(mutation.expectedRowDataSize !== undefined ? { expectedRowDataSize: mutation.expectedRowDataSize } : {}),
              mutation: 'upsert',
              rowIndex: mutation.rowIndex,
              id: mutation.rowId,
              expectedDataHash: mutation.expectedDataHash,
              dataBase64: mutation.rowDataBase64,
              name: mutation.name
            }
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        }
      });
      if (!paramStage.ok || !paramStage.bytes) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            ...sanitizeDiagnostics(paramStage.result?.diagnostics ?? []),
            ...paramStage.diagnostics.map((diagnostic) => ({
              severity: 'error' as const,
              code: diagnostic.code,
              message: diagnostic.message,
              sourceUri: containerUri
            })),
            {
              severity: 'error' as const,
              code: 'PARAM_ROW_NAME_STAGE_FAILED',
              message: '行名改动未能产出裸 param 暂存文件，容器未被修改。',
              sourceUri: containerUri
            }
          ]
        };
      }
      const renamedChildBase64 = paramStage.bytes.toString('base64');

      // ② 把裸 param 塞回容器，经 Patch Engine 提交重打包后的容器。
      const outcome = await applyNativeMutation({
        file,
        sourceUri: containerUri,
        expectedHash: containerHashNow,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'parambnd',
        stagingFileName: `${basename(file.relativePath)}.repacked`,
        stageWrite: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-bnd4',
            filePath: file.absolutePath,
            resourceUri: containerUri,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 180_000,
            commandOptions: {
              outputPath: context.outputPath,
              mutation: 'replace',
              expectedContainerHash: containerHashNow,
              entryIndex: mutation.entryIndex,
              // S29：child 哈希缺失时现算（解包文件即条目存储字节，与 C# Hash 同算法）。
              expectedChildHash: mutation.expectedChildHash
                || await deps.sha256FileNow(unpacked.child.absolutePath),
              contentBase64: renamedChildBase64
            },
            ...oodle
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'BND4_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        },
        title: `PARAM row name for row ${mutation.rowId} in ${unpacked.child.name}`,
        confirmActionLabel: '提交容器内 PARAM 行名变更'
      }, {
        // S29：不再接确认端口（见字段链注释）。
        commit: deps.sessionCommitPort(getSession()!, operationLog, storage, { knowledgeRefreshOwner: 'caller' })
      });

      if (outcome.status === 'committed' && outcome.result.ok) {
        await runCallerOwnedPostCommit(outcome.result, {
          prepare: () => {
            paramPageCache.delete(containerUri);
            containerChildrenCache.clear();
            paramEntryTableCache.clear();
            containerParamAllCache.clear();
            unpackedParamCache.clear();
          },
          refresh: (result) => deps.refreshActiveIndexAfterNativeWrite([containerUri], result),
          onRefreshError: (result, error) => appendPostCommitFailureDiagnostic(
            result,
            'POSTCOMMIT_REFRESH_FAILED',
            containerUri,
            error
          )
        });
      }
      return deps.toSaveResultFromOutcome(outcome, getFiles());
    }
  );

  /**
   * 容器内 PARAM 的**行级**写入：新建行 / 复制当前行 / 删除当前行（问题 4）。
   *
   * 与 resource.applyContainerParamRowNameMutation（T5-3）、
   * resource.applyContainerParamFieldMutation 走同一条 Patch 链，
   * 禁止 fs.writeFile、禁止 changeStore —— 只有 applyNativeMutation 的
   * commit port（Patch Engine）能落盘：
   *
   *   ① write-param（C#）—— add/copy 用 mutation='add' 带新 id 与整行字节新增一行
   *      （ParamNativeDocument.ApplyCompactMutations 的 add 分支：id 已存在会拒绝，
   *      不会静默覆盖）；delete 用 mutation='delete' 按 id 移除（id 不存在会拒绝）。
   *      产出改过的裸 param（暂存，C# 侧重读验证 PARAM_STAGING_WRITE_VERIFIED）；
   *   ② write-bnd4 replace（C#）—— 按 entryIndex 把裸 param 塞回容器副本；
   *   ③ 真正落盘由 applyNativeMutation 的 commit port（Patch Engine）完成，
   *      含备份与回滚元数据。
   *
   * rowId 由渲染器按「当前表最大 id + 1」给出（不跳过空洞，保持编辑器约定）；
   * add/copy 必须携带整行字节（copy = 当前行原样；add = 长度=行宽的 0 行），
   * 长度由 C# 侧对 RowDataSize 校验。旧布局（无行头）PARAM 不支持行数变更，
   * C# add/delete 会返回结构化失败，不会破坏无损性。
   */
  handle(
    'resource.applyContainerParamRowMutations',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      mutation: {
        kind: 'add' | 'copy' | 'delete';
        entryIndex: number;
        expectedChildHash: string;
        rowId: number;
        rowDataBase64: string;
      }
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入容器内 PARAM 行。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      if (mutation.kind !== 'add' && mutation.kind !== 'copy' && mutation.kind !== 'delete') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_ROW_MUTATION_INVALID',
            message: '行级写入必须显式声明 add / copy / delete 之一。',
            sourceUri: containerUri
          }]
        };
      }
      if (mutation.kind !== 'delete'
        && (typeof mutation.rowDataBase64 !== 'string' || mutation.rowDataBase64.length === 0)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_ROW_DATA_MISSING',
            message: `${mutation.kind === 'copy' ? '复制' : '新建'}行需要整行字节`
              + '（copy = 当前行原样，add = 行宽 0 行）。',
            sourceUri: containerUri
          }]
        };
      }

      // 解包目标条目：write-param 需要一个裸 param 作为输入基底。
      // S29：容器哈希缺失时现算（索引没扫到 sha256 的罕见情况），不挡写入。
      const containerHashNow = file.sha256 ?? await deps.sha256FileNow(file.absolutePath);
      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: containerHashNow,
        entry: { index: mutation.entryIndex }
      });
      if (!unpacked.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: sanitizeDiagnostics(unpacked.diagnostics)
        };
      }

      const storage = deps.durableStoragePaths(getSession()!.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(getSession()!, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(getSession()!);
      const oodle = getSession()!.layers.baseRoot
        ? { oodleRuntimeRoot: getSession()!.layers.baseRoot as string }
        : {};

      // ① 暂存区产出改过行的裸 param。add/copy → add（新 id 已存在会被 C# 拒绝）；
      //    delete → delete（id 不存在会被 C# 拒绝）。
      const patchOptions = mutation.kind === 'delete'
        ? { mutation: 'delete' as const, id: mutation.rowId }
        : { mutation: 'add' as const, id: mutation.rowId, dataBase64: mutation.rowDataBase64 };
      const paramStage = await stageBridgeOutput({
        stagingRoot: storage.stagingRoot,
        prefix: 'param-row',
        fileName: `${basename(unpacked.child.name)}.rows-${mutation.kind}`,
        allowedRoots: () => [...stage.allowedRoots],
        write: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-param',
            filePath: unpacked.child.absolutePath,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 120_000,
            commandOptions: {
              outputPath: context.outputPath,
              // S29：storedContentHash 缺失时对解包文件现算（写前读到的就是写时文件）。
              expectedDocumentHash: unpacked.child.storedContentHash
                || await deps.sha256FileNow(unpacked.child.absolutePath),
              ...patchOptions
            }
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        }
      });
      if (!paramStage.ok || !paramStage.bytes) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            ...sanitizeDiagnostics(paramStage.result?.diagnostics ?? []),
            ...paramStage.diagnostics.map((diagnostic) => ({
              severity: 'error' as const,
              code: diagnostic.code,
              message: diagnostic.message,
              sourceUri: containerUri
            })),
            {
              severity: 'error' as const,
              code: 'PARAM_ROW_STAGE_FAILED',
              message: '行级改动未能产出裸 param 暂存文件，容器未被修改。',
              sourceUri: containerUri
            }
          ]
        };
      }
      const mutatedChildBase64 = paramStage.bytes.toString('base64');

      // ② 把裸 param 塞回容器，经 Patch Engine 提交重打包后的容器。
      const outcome = await applyNativeMutation({
        file,
        sourceUri: containerUri,
        expectedHash: containerHashNow,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'parambnd',
        stagingFileName: `${basename(file.relativePath)}.repacked`,
        stageWrite: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-bnd4',
            filePath: file.absolutePath,
            resourceUri: containerUri,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 180_000,
            commandOptions: {
              outputPath: context.outputPath,
              mutation: 'replace',
              expectedContainerHash: containerHashNow,
              entryIndex: mutation.entryIndex,
              // S29：child 哈希缺失时现算（解包文件即条目存储字节，与 C# Hash 同算法）。
              expectedChildHash: mutation.expectedChildHash
                || await deps.sha256FileNow(unpacked.child.absolutePath),
              contentBase64: mutatedChildBase64
            },
            ...oodle
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'BND4_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        },
        title: `PARAM row ${mutation.kind} ${mutation.rowId} in ${unpacked.child.name}`,
        confirmActionLabel: '提交容器内 PARAM 行级变更'
      }, {
        // S29：不再接确认端口（见字段链注释）。
        commit: deps.sessionCommitPort(getSession()!, operationLog, storage, { knowledgeRefreshOwner: 'caller' })
      });

      if (outcome.status === 'committed' && outcome.result.ok) {
        await runCallerOwnedPostCommit(outcome.result, {
          prepare: () => {
            paramPageCache.delete(containerUri);
            containerChildrenCache.clear();
            unpackedParamCache.clear();
          },
          refresh: (result) => deps.refreshActiveIndexAfterNativeWrite([containerUri], result),
          onRefreshError: (result, error) => appendPostCommitFailureDiagnostic(
            result,
            'POSTCOMMIT_REFRESH_FAILED',
            containerUri,
            error
          )
        });
      }
      return deps.toSaveResultFromOutcome(outcome, getFiles());
    }
  );

  /**
   * 解包容器内 param 并全量读出（T5-4 导入导出的公共前置）。
   *
   * 与 resource.readContainerParamPage 同一条前置链：unpackContainerParamChild
   * 先把条目解成裸 param 落会话暂存区，再 read-param-document（includeAllPayloads）
   * 一次拿回全部行字节。返回的 child 同时携带 storedContentHash —— 那是写回
   * write-param 时 requiredDocumentHash 的并发保护凭据。
   */
  const readContainerParamFull = async (input: {
    file: IndexedFile;
    containerUri: string;
    expectedContainerHash: string;
    entryIndex: number;
  }): Promise<
    | {
        ok: true;
        child: UnpackedParamChild;
        typeName: string;
        rowDataSize: number;
        rows: Array<{ id: number; dataBase64?: string | null; name?: string }>;
        diagnostics: Diagnostic[];
      }
    | { ok: false; diagnostics: Diagnostic[] }
  > => {
    const unpacked = await unpackContainerParamChild({
      containerPath: input.file.absolutePath,
      containerUri: input.containerUri,
      containerHash: input.file.sha256 ?? input.expectedContainerHash,
      entry: { index: input.entryIndex }
    });
    if (!unpacked.ok) return { ok: false, diagnostics: sanitizeDiagnostics(unpacked.diagnostics) };
    const stageRoots = getSession()
      ? await deps.verifiedStageRoots(
            getSession()!,
          deps.durableStoragePaths(getSession()!.meta.workspaceId),
          'PARAM_STAGING_PREPARE_FAILED'
        )
      : null;
    if (stageRoots && stageRoots.diagnostics.length > 0) {
      return { ok: false, diagnostics: stageRoots.diagnostics };
    }
    const allowedRoots = stageRoots
      ? [...stageRoots.allowedRoots]
      : [dirname(unpacked.child.absolutePath)];
    const full = await runBridge<{
      sourceHash?: string;
      typeName?: string;
      rowDataSize?: number;
      rows?: Array<{ rowIndex: number; id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
    }>({
      command: 'read-param-document',
      filePath: unpacked.child.absolutePath,
      allowedRoots,
      timeoutMs: 120_000,
      commandOptions: { includeAllPayloads: true },
      maxFrameBytes: 32 * 1024 * 1024
    });
    if (full.parseStatus === 'failed' || !full.data?.sourceHash) {
      return { ok: false, diagnostics: sanitizeDiagnostics(full.diagnostics) };
    }
    return {
      ok: true,
      child: unpacked.child,
      typeName: full.data.typeName ?? '',
      rowDataSize: full.data.rowDataSize ?? 0,
      rows: full.data.rows ?? [],
      diagnostics: []
    };
  };

  /**
   * T5-4 批量导入的共享提交路径（grok T5：「提交走与字段写入相同的 Patch 链，
   * 禁止 fs.writeFile 写 Mod」）。
   *
   * ① write-param mutations（C#）—— 批量 upsert 行数据/行名，产出改过的裸 param；
   * ② write-bnd4 replace（C#）—— 按 entryIndex 塞回容器副本，C# 侧重读验证；
   * ③ 真正落盘由 applyNativeMutation 的 commit port（Patch Engine）完成，含备份
   *    与回滚元数据。
   *
   * unpackedChild 由调用方（readContainerParamFull）解包并读出，这里直接复用，
   * 不重复解包；expectedDocumentHash 用它的 storedContentHash（并发保护，与
   * 字段/行名写入一致）。write-param 的 upsert 强制 dataBase64 且长度=行宽——
   * 导入路径的行字节一律由读回的最新字节承载，不凭空构造。
   */
  const commitContainerParamBulk = async (
    event: IpcMainInvokeEvent,
    input: {
      containerUri: string;
      expectedContainerHash: string;
      file: IndexedFile;
      entryIndex: number;
      expectedChildHash: string;
      unpackedChild: UnpackedParamChild;
      mutations: Array<Record<string, unknown>>;
      title: string;
      confirmActionLabel: string;
    }
  ): Promise<RendererSaveResult> => {
    const session = getSession();
    if (!session) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'PARAM_IMPORT_NO_SESSION',
          message: '需要已打开的工作区才能写入容器内 PARAM。',
          sourceUri: input.containerUri
        }]
      };
    }
    const storage = deps.durableStoragePaths(session!.meta.workspaceId);
    const stage = await deps.verifiedStageRoots(session!, storage, 'PARAM_STAGING_PREPARE_FAILED');
    if (stage.diagnostics.length > 0) {
      return { ok: false, changedFiles: [], diagnostics: stage.diagnostics };
    }
    const operationLog = await deps.ensureActiveOperationLog(session!);
    const oodle = session.layers.baseRoot
      ? { oodleRuntimeRoot: session.layers.baseRoot as string }
      : {};

    // S29：容器哈希缺失时现算，不挡写入。
    const containerHashNow = input.file.sha256 ?? await deps.sha256FileNow(input.file.absolutePath);
    const childHashNow = input.expectedChildHash
      || await deps.sha256FileNow(input.unpackedChild.absolutePath);

    const paramStage = await stageBridgeOutput({
      stagingRoot: storage.stagingRoot,
      prefix: 'param-import',
      fileName: `${basename(input.unpackedChild.name)}.imported`,
      allowedRoots: () => [...stage.allowedRoots],
      write: async (context) => {
        const written = await runBridge<Record<string, unknown>>({
          command: 'write-param',
          filePath: input.unpackedChild.absolutePath,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          timeoutMs: 120_000,
          commandOptions: {
            outputPath: context.outputPath,
            // S29：storedContentHash 缺失时现算（写前读到的就是写时文件）。
            expectedDocumentHash: input.unpackedChild.storedContentHash
              || await deps.sha256FileNow(input.unpackedChild.absolutePath),
            mutations: input.mutations
          }
        });
        return {
          ok: written.parseStatus !== 'failed'
            && written.diagnostics.some(
              (diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED'
            ),
          diagnostics: written.diagnostics
        };
      }
    });
    if (!paramStage.ok || !paramStage.bytes) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [
          ...sanitizeDiagnostics(paramStage.result?.diagnostics ?? []),
          ...paramStage.diagnostics.map((diagnostic) => ({
            severity: 'error' as const,
            code: diagnostic.code,
            message: diagnostic.message,
            sourceUri: input.containerUri
          })),
          {
            severity: 'error' as const,
            code: 'PARAM_IMPORT_STAGE_FAILED',
            message: '批量改动未能产出裸 param 暂存文件，容器未被修改。',
            sourceUri: input.containerUri
          }
        ]
      };
    }
    const childBase64 = paramStage.bytes.toString('base64');

    const outcome = await applyNativeMutation({
      file: input.file,
      sourceUri: input.containerUri,
      expectedHash: containerHashNow,
      stagingRoot: storage.stagingRoot,
      allowedRoots: () => [...stage.allowedRoots],
      stagingPrefix: 'parambnd',
      stagingFileName: `${basename(input.file.relativePath)}.repacked`,
      stageWrite: async (context) => {
        const written = await runBridge<Record<string, unknown>>({
          command: 'write-bnd4',
          filePath: input.file.absolutePath,
          resourceUri: input.containerUri,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          timeoutMs: 180_000,
          commandOptions: {
            outputPath: context.outputPath,
            mutation: 'replace',
            expectedContainerHash: containerHashNow,
            entryIndex: input.entryIndex,
            expectedChildHash: childHashNow,
            contentBase64: childBase64
          },
          ...oodle
        });
        return {
          ok: written.parseStatus !== 'failed'
            && written.diagnostics.some(
              (diagnostic) => diagnostic.code === 'BND4_STAGING_WRITE_VERIFIED'
            ),
          diagnostics: written.diagnostics
        };
      },
      title: input.title,
      confirmActionLabel: input.confirmActionLabel
    }, {
      // S29：不再接确认端口（见字段链注释）。
      commit: deps.sessionCommitPort(session!, operationLog, storage, { knowledgeRefreshOwner: 'caller' })
    });

    if (outcome.status === 'committed' && outcome.result.ok) {
      await runCallerOwnedPostCommit(outcome.result, {
        prepare: () => {
          paramPageCache.delete(input.containerUri);
          paramAllCache.delete(input.containerUri);
          containerChildrenCache.clear();
          paramEntryTableCache.clear();
          containerParamAllCache.clear();
          unpackedParamCache.clear();
        },
        refresh: (result) => deps.refreshActiveIndexAfterNativeWrite([input.containerUri], result),
        onRefreshError: (result, error) => appendPostCommitFailureDiagnostic(
          result,
          'POSTCOMMIT_REFRESH_FAILED',
          input.containerUri,
          error
        )
      });
    }
    return deps.toSaveResultFromOutcome(outcome, getFiles());
  };

  /**
   * 校验导出目标路径不在受 Patch Engine 管理的目录内。
   *
   * 导出 CSV 是用户主动保存到自选路径的新文件，不是 Mod 资源改动，因此不走
   * Patch Engine（硬约束针对的是「改 Mod 资源」）。但游戏目录只读、Mod 工作区
   * 不落旁路文件，两者都挡 —— 选中这两处时拒绝并给可复现的下一步。
   */
  const rejectExportIntoManagedRoots = (
    target: string,
    containerUri: string
  ): RendererSaveResult | null => {
    const abs = resolve(target);
    const roots = [
      getSession()?.layers.baseRoot,
      getSession()?.layers.overlayRoot
    ];
    for (const root of roots) {
      if (root && (abs === root || abs.startsWith(root + sep))) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_EXPORT_INTO_MANAGED_ROOT',
            message: '不要导出到游戏目录或 Mod 工作区：那里由 Patch Engine 管理。请选择工作区外的目录。',
            sourceUri: containerUri
          }]
        };
      }
    }
    return null;
  };

  /**
   * T5-4：导出行（CSV，主进程保存对话框）。
   *
   * 表头 = `id,name,<字段内部 id>…`。用内部 id 而不是显示名做表头，是为了让
   * param.importRowsCsv 能按表头精确回写 —— 显示名（中文 DisplayName）可能重名，
   * 拿它定位字段会写错列。字段值经 decodeRowFields 解码，解码失败或缺失的单元格
   * 导成空串（导入时空串 = 不改，见 importRowsCsv）。
   */
  handle(
    'param.exportRowsCsv',
    async (
      _event,
      containerUri: string,
      expectedContainerHash: string,
      entryIndex: number
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_EXPORT_NO_SESSION',
            message: '需要已打开的工作区才能导出 PARAM。',
            sourceUri: containerUri
          }]
        };
      }
      const full = await readContainerParamFull({ file, containerUri, expectedContainerHash, entryIndex });
      if (!full.ok) {
        return { ok: false, changedFiles: [], diagnostics: full.diagnostics };
      }
      const resolved = full.typeName
        ? await resolveTrustedParamDefinition(full.typeName, full.rowDataSize)
        : { document: null };
      const def = resolved.document;
      if (!def) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_EXPORT_NO_DEF',
            message: `无法解析 ${full.typeName ?? '该表'} 的字段定义，不能导出字段值。`,
            sourceUri: containerUri
          }]
        };
      }
      const headers = ['id', 'name', ...def.fields.map((field) => field.id)];
      const rows = full.rows.map((row) => {
        const data = typeof row.dataBase64 === 'string' && row.dataBase64.length > 0
          ? Buffer.from(row.dataBase64, 'base64')
          : null;
        const values = data ? decodeRowFields(data, def) : [];
        const byId = new Map(values.map((value) => [value.fieldId, value]));
        return [
          String(row.id),
          row.name ?? '',
          ...def.fields.map((field) => {
            const value = byId.get(field.id);
            if (!value || value.diagnostic) return '';
            return value.value === null ? '' : String(value.value);
          })
        ];
      });
      const csv = toCsvText(headers, rows);
      const opened = await dialog.showSaveDialog({
        title: '导出 PARAM 行（CSV）',
        defaultPath: `${full.child.name.replace(/\.param$/i, '')}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (opened.canceled || !opened.filePath) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'info',
            code: 'CSV_EXPORT_CANCELLED',
            message: '已取消导出。',
            sourceUri: containerUri
          }]
        };
      }
      const blocked = rejectExportIntoManagedRoots(opened.filePath, containerUri);
      if (blocked) return blocked;
      try {
        await writeFile(opened.filePath, csv, 'utf8');
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_EXPORT_WRITE_FAILED',
            message: error instanceof Error ? error.message : '写入导出文件失败。',
            sourceUri: containerUri
          }]
        };
      }
      return {
        ok: true,
        changedFiles: [],
        diagnostics: [{
          severity: 'info',
          code: 'CSV_EXPORT_SAVED',
          message: `已导出 ${rows.length} 行到 ${opened.filePath}。`,
          sourceUri: containerUri
        }]
      };
    }
  );

  /**
   * T5-4：导出备注（行名，CSV：id,name）。
   */
  handle(
    'param.exportNamesCsv',
    async (
      _event,
      containerUri: string,
      expectedContainerHash: string,
      entryIndex: number
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_EXPORT_NO_SESSION',
            message: '需要已打开的工作区才能导出 PARAM 行名。',
            sourceUri: containerUri
          }]
        };
      }
      const full = await readContainerParamFull({ file, containerUri, expectedContainerHash, entryIndex });
      if (!full.ok) {
        return { ok: false, changedFiles: [], diagnostics: full.diagnostics };
      }
      const csv = toCsvText(
        ['id', 'name'],
        full.rows.map((row) => [String(row.id), row.name ?? ''])
      );
      const opened = await dialog.showSaveDialog({
        title: '导出 PARAM 行名（CSV）',
        defaultPath: `${full.child.name.replace(/\.param$/i, '')}.names.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (opened.canceled || !opened.filePath) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'info',
            code: 'CSV_EXPORT_CANCELLED',
            message: '已取消导出行名。',
            sourceUri: containerUri
          }]
        };
      }
      const blocked = rejectExportIntoManagedRoots(opened.filePath, containerUri);
      if (blocked) return blocked;
      try {
        await writeFile(opened.filePath, csv, 'utf8');
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_EXPORT_WRITE_FAILED',
            message: error instanceof Error ? error.message : '写入导出文件失败。',
            sourceUri: containerUri
          }]
        };
      }
      return {
        ok: true,
        changedFiles: [],
        diagnostics: [{
          severity: 'info',
          code: 'CSV_EXPORT_SAVED',
          message: `已导出 ${full.rows.length} 行行名到 ${opened.filePath}。`,
          sourceUri: containerUri
        }]
      };
    }
  );

  /**
   * T5-4：导入备注（行名 CSV：id,name）。
   *
   * 主进程打开对话框选文件；逐 id 把「当前行字节原样回传 + 新 name」拼成
   * write-param upsert，整批经 commitContainerParamBulk 走 Patch Engine。
   * 行 id 不存在的记录被跳过并汇总诊断 —— 导入是部分成功，不吞异常。
   */
  handle(
    'param.importNamesCsv',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      entryIndex: number,
      expectedChildHash: string
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_IMPORT_NO_SESSION',
            message: '需要已打开的工作区才能导入 PARAM 行名。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      const opened = await dialog.showOpenDialog({
        title: '导入行名（CSV：id,name）',
        properties: ['openFile'],
        filters: [{ name: 'CSV / 文本', extensions: ['csv', 'txt'] }]
      });
      if (opened.canceled || opened.filePaths.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'info',
            code: 'CSV_IMPORT_CANCELLED',
            message: '已取消导入行名。',
            sourceUri: containerUri
          }]
        };
      }
      const selectedNamesPath = opened.filePaths[0];
      if (!selectedNamesPath) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NO_FILE',
            message: '没有选中导入文件。',
            sourceUri: containerUri
          }]
        };
      }
      let csvText: string;
      try {
        csvText = await readFile(selectedNamesPath, 'utf8');
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_READ_FAILED',
            message: error instanceof Error ? error.message : '无法读取所选文件。',
            sourceUri: containerUri
          }]
        };
      }
      const parsed = parseCsvText(csvText);
      const header0 = (parsed.headers[0] ?? '').trim().toLowerCase();
      const header1 = (parsed.headers[1] ?? '').trim().toLowerCase();
      if (parsed.headers.length < 2 || header0 !== 'id' || header1 !== 'name') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_BAD_HEADER',
            message: '行名 CSV 的表头必须是 id,name（多余列会被忽略）。',
            sourceUri: containerUri
          }]
        };
      }
      const full = await readContainerParamFull({ file, containerUri, expectedContainerHash, entryIndex });
      if (!full.ok) {
        return { ok: false, changedFiles: [], diagnostics: full.diagnostics };
      }
      const rowById = new Map(full.rows.map((row) => [row.id, row]));
      const mutations: Array<Record<string, unknown>> = [];
      const skipped: string[] = [];
      for (const record of parsed.rows) {
        const idNum = Number(record[0]);
        if (!Number.isInteger(idNum)) {
          skipped.push(`「${record[0] ?? ''}」不是整数 id`);
          continue;
        }
        const existing = rowById.get(idNum);
        if (!existing) {
          skipped.push(`id ${idNum} 在表内不存在`);
          continue;
        }
        if (typeof existing.dataBase64 !== 'string' || existing.dataBase64.length === 0) {
          skipped.push(`id ${idNum} 没有可回传的行字节`);
          continue;
        }
        mutations.push({ kind: 'upsert', id: idNum, dataBase64: existing.dataBase64, name: record[1] ?? '' });
      }
      if (mutations.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NOTHING_TO_APPLY',
            message: skipped.length > 0
              ? `没有可导入的行名：${skipped.slice(0, 5).join('；')}${skipped.length > 5 ? ` 等 ${skipped.length} 条` : ''}`
              : 'CSV 没有数据行。',
            sourceUri: containerUri
          }]
        };
      }
      return commitContainerParamBulk(event, {
        containerUri,
        expectedContainerHash,
        file,
        entryIndex,
        expectedChildHash,
        unpackedChild: full.child,
        mutations,
        title: `import ${mutations.length} row names into ${full.child.name}`,
        confirmActionLabel: '提交批量行名导入'
      });
    }
  );

  /**
   * T5-4：导入行（CSV：id,name,<字段内部 id>…）。
   *
   * 表头第二列起的字段列必须是该表字段的内部 id（与 exportRowsCsv 对齐）。空
   * 单元格 = 不改该字段；bool 单元格按 /^(1|true|yes|on)$/ 判定；字段编码失败
   * 的记录跳过并汇总诊断。整批 upsert 经 commitContainerParamBulk 走 Patch Engine。
   */
  handle(
    'param.importRowsCsv',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      entryIndex: number,
      expectedChildHash: string
    ): Promise<RendererSaveResult> => {
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      if (!file || !getSession()) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_IMPORT_NO_SESSION',
            message: '需要已打开的工作区才能导入 PARAM 行。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      const opened = await dialog.showOpenDialog({
        title: '导入行（CSV：id,name,字段…）',
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (opened.canceled || opened.filePaths.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'info',
            code: 'CSV_IMPORT_CANCELLED',
            message: '已取消导入行。',
            sourceUri: containerUri
          }]
        };
      }
      const selectedRowsPath = opened.filePaths[0];
      if (!selectedRowsPath) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NO_FILE',
            message: '没有选中导入文件。',
            sourceUri: containerUri
          }]
        };
      }
      let csvText: string;
      try {
        csvText = await readFile(selectedRowsPath, 'utf8');
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_READ_FAILED',
            message: error instanceof Error ? error.message : '无法读取所选文件。',
            sourceUri: containerUri
          }]
        };
      }
      const parsed = parseCsvText(csvText);
      const header0 = (parsed.headers[0] ?? '').trim().toLowerCase();
      if (parsed.headers.length < 1 || header0 !== 'id') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_BAD_HEADER',
            message: '行数据 CSV 的表头必须是 id（其后可跟 name 与字段列）。',
            sourceUri: containerUri
          }]
        };
      }
      const header1 = (parsed.headers[1] ?? '').trim().toLowerCase();
      const fieldIds = parsed.headers.slice(header1 === 'name' ? 2 : 1)
        .map((header) => header.trim());
      if (fieldIds.length === 0 && header1 !== 'name') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NO_COLUMNS',
            message: '行数据 CSV 除了 id 外没有可导入的列（至少要有 name 或一个字段列）。',
            sourceUri: containerUri
          }]
        };
      }
      const full = await readContainerParamFull({ file, containerUri, expectedContainerHash, entryIndex });
      if (!full.ok) {
        return { ok: false, changedFiles: [], diagnostics: full.diagnostics };
      }
      const resolved = full.typeName
        ? await resolveTrustedParamDefinition(full.typeName, full.rowDataSize)
        : { document: null };
      const def = resolved.document;
      if (!def) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_IMPORT_NO_DEF',
            message: `无法解析 ${full.typeName ?? '该表'} 的字段定义，不能导入行数据。`,
            sourceUri: containerUri
          }]
        };
      }
      const fieldById = new Map(def.fields.map((field) => [field.id, field]));
      const unknownColumns = fieldIds.filter((id) => !fieldById.has(id));
      if (unknownColumns.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_UNKNOWN_FIELD',
            message: `CSV 含未知字段列：${unknownColumns.join('、')}。表头必须是该表的字段内部 id。`,
            sourceUri: containerUri
          }]
        };
      }
      const rowById = new Map(full.rows.map((row) => [row.id, row]));
      const mutations: Array<Record<string, unknown>> = [];
      const skipped: string[] = [];
      for (const record of parsed.rows) {
        const idNum = Number(record[0]);
        if (!Number.isInteger(idNum)) {
          skipped.push(`「${record[0] ?? ''}」不是整数 id`);
          continue;
        }
        const existing = rowById.get(idNum);
        if (!existing) {
          skipped.push(`id ${idNum} 在表内不存在`);
          continue;
        }
        if (typeof existing.dataBase64 !== 'string' || existing.dataBase64.length === 0) {
          skipped.push(`id ${idNum} 没有可回传的行字节`);
          continue;
        }
        let next: Buffer = Buffer.from(existing.dataBase64, 'base64');
        const fieldErrors: string[] = [];
        for (let column = 0; column < fieldIds.length; column += 1) {
          const raw = record[column + (header1 === 'name' ? 2 : 1)] ?? '';
          if (raw === '') continue; // 空单元格 = 不改该字段
          const field = fieldById.get(fieldIds[column]!);
          const effectiveValue = field?.type === 'bool'
            ? /^(1|true|yes|on)$/i.test(raw)
            : raw;
          const encoded = encodeFieldMutation(next, def, fieldIds[column]!, effectiveValue);
          if (!encoded.ok) {
            fieldErrors.push(`${fieldIds[column]}: ${encoded.message}`);
            continue;
          }
          next = encoded.next;
        }
        if (fieldErrors.length > 0) {
          skipped.push(`id ${idNum} 部分字段未应用（${fieldErrors.join('；')}）`);
        }
        const name = (record[1] ?? '').trim();
        mutations.push({
          kind: 'upsert',
          id: idNum,
          dataBase64: next.toString('base64'),
          ...(name && header1 === 'name' ? { name } : {})
        });
      }
      if (mutations.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NOTHING_TO_APPLY',
            message: skipped.length > 0
              ? `没有可导入的行：${skipped.slice(0, 5).join('；')}${skipped.length > 5 ? ` 等 ${skipped.length} 条` : ''}`
              : 'CSV 没有数据行。',
            sourceUri: containerUri
          }]
        };
      }
      return commitContainerParamBulk(event, {
        containerUri,
        expectedContainerHash,
        file,
        entryIndex,
        expectedChildHash,
        unpackedChild: full.child,
        mutations,
        title: `import ${mutations.length} rows into ${full.child.name}`,
        confirmActionLabel: '提交批量行数据导入'
      });
    }
  );

  /**
   * 列出 parambnd 容器内的 param 条目（Smithbox 的 Param List 那一栏）。
   *
   * 为什么不复用 listContainerChildrenPage：那条通道服务于通用容器工作台，
   * 返回全部条目类型且 childUri 不可读。这里只给 param 条目，并且每一项都能
   * 直接交给 resource.readContainerParamPage 拿到行 —— 也就是「列得出来就读得到」。
   * 报告过的形态是反面：UI 能列出 138 个名字，却拿不到其中任何一个的字节。
   */
  handle('resource.listContainerParams', async (_event, containerUri: string) => {
    const file = getFiles().find((item) => item.sourceUri === containerUri);
    if (!file) {
      return {
        ok: false,
        containerUri,
        params: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法列出容器内 param。',
          sourceUri: containerUri
        }]
      };
    }
    if (!getSession()) {
      return {
        ok: false,
        containerUri,
        params: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'PARAM_LIST_NO_SESSION',
          message: '没有活动工作区会话。',
          sourceUri: containerUri
        }]
      };
    }
    // 字段包只读校验与容器条目枚举彼此独立：提前启动一次元数据加载，
    // 让用户点进大型表时，native 行索引与字段定义可以并行准备，而不是
    // 把几秒级的首次包导入全部压到“选中首行”之后。
    void loadParamMetadata();
    // 内置 schema 校验在后台预热，不阻塞左侧条目列表。
    // ROOT-07：只读枚举只传已存在并 verified 的 roots，不附加 staging。
    const roots = await deps.verifiedReadRoots(getSession()!, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) {
      return {
        ok: false,
        containerUri,
        params: [],
        diagnostics: roots.diagnostics
      };
    }
    const workspaceSessionId = deps.getActiveWorkspaceSessionId
      ? deps.getActiveWorkspaceSessionId()
      : deps.activeWorkspaceSessionId;
    const bridgeSession = workspaceSessionId ? { workspaceSessionId } : {};
    const dcx = await runBridge<NativeDcxEnvelopeLike & { entries?: NativeBnd4EntryLike[] }>({
      command: 'list-bnd4-entries',
      filePath: file.absolutePath,
      resourceUri: containerUri,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      commandOptions: { includeContentHashes: true },
      // KRAK（game-side）容器缺 Oodle 连条目表都读不出 —— 实测。
      ...(getSession()!.layers.baseRoot
        ? { oodleRuntimeRoot: getSession()!.layers.baseRoot as string }
        : {}),
      ...bridgeSession
    });
    if (dcx.parseStatus === 'failed') {
      return {
        ok: false,
        containerUri,
        params: [],
        diagnostics: sanitizeDiagnostics(dcx.diagnostics)
      };
    }
    const entries = dcx.data?.entries ?? dcx.data?.nested?.entries ?? [];
    const seen = new Set<string>();
    const cachedEntryNames = new Set<string>();
    const cacheContainerHash = file.sha256
      ?? createHash('sha256').update(file.absolutePath).digest('hex');
    // listContainerParams 与后续 unpackContainerParamChild 共享同一份只读
    // 条目表；避免用户刚点开表时再次解压/枚举整个 parambnd。缓存键仍绑定
    // 容器哈希，后台补齐 sha256 或内容变化时不会把旧条目表当成新版本。
    paramEntryTableCache.set(
      `${containerUri}#${cacheContainerHash}`,
      entries.map((entry, position) => {
        const index = entry.index ?? position;
        return {
          index,
          name: sanitizeEntryName(entry.name ?? `entry_${position}`, index, cachedEntryNames),
          storedContentHash: entry.contentHash ?? ''
        };
      })
    );
    const params = entries
      .map((entry, position) => {
        const index = entry.index ?? position;
        return {
          entryIndex: index,
          name: sanitizeEntryName(entry.name ?? `entry_${position}`, index, seen),
          size: entry.uncompressedSize ?? 0
        };
      })
      // 只保留 .param —— 容器里也可能有别的东西，混进来会让左栏出现点不开的项。
      .filter((entry) => entry.name.toLowerCase().endsWith('.param'));
    return {
      ok: true,
      containerUri,
      containerFormat: dcx.data?.compressionFormat ?? null,
      params,
      diagnostics: params.length === 0
        ? [{
            severity: 'info' as const,
            code: 'PARAM_LIST_EMPTY',
            message: `容器内 ${entries.length} 个条目中没有 .param 文件。`,
            sourceUri: containerUri
          }]
        : []
    };
  });

  /**
   * 读取 parambnd 容器内某个 param 的一页行。
   *
   * 这条通道补的是「容器 → 内部 param 文件」那一跳（详见
   * unpackContainerParamChild 的注释）：先解包成裸 param 落会话暂存区，
   * 再复用 resource.readParamPage 的分页读取逻辑。
   *
   * 直接把容器 URI 交给 read-param-document 会硬失败（实测
   * `PARAM_DOCUMENT_READ_FAILED: PARAM 类型名偏移无效`），因为它不解 DCX/BND4。
   */
  handle(
    'resource.readContainerParamPage',
    async (
      _event,
      containerUri: string,
      entryIndex: number,
      requestedPage: number,
      requestedPageSize: number,
      query?: string,
      loadAll?: boolean,
      requestedDocumentSessionToken?: string
    ) => {
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      const failure = (code: string, message: string, extra: Diagnostic[] = []) => ({
        ok: false,
        containerUri,
        entryIndex,
        sourceHash: null,
        typeName: null,
        rowDataSize: 0,
        rowCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        rows: [],
        rowsTruncated: false,
        // P1 裁定：容器 PARAM 工作台 FIELDS 栏依赖字段定义。失败路径与成功路径
        // 保持同一字段面，只是定义一概为空——渲染器据此显示「没有可用的字段定义」
        // 的语义（而非「字段列渲染异常」）。
        fieldDefs: null,
        fieldEnums: null,
        fieldDefsDiagnostic: null,
        fieldDefsOrigin: null,
        fieldDefsTrusted: false,
        diagnostics: [
          { severity: 'error' as const, code, message, sourceUri: containerUri },
          ...extra
        ]
      });
      if (!file) return failure('RESOURCE_NOT_INDEXED', '资源未索引，无法读取容器内 param。');

      // 缓存键用的容器哈希：file.sha256 缺失时退化为路径摘要（解包、条目表备忘、
      // 文档 LRU 共用同一份）。回给渲染器的 containerHash 仍是 file.sha256 ?? '' ——
      // 那一处故意在缺哈希时留空（要喂 write-bnd4 的并发保护），两套哈希不许合并。
      const cacheContainerHash =
        file.sha256 ?? createHash('sha256').update(file.absolutePath).digest('hex');
      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: cacheContainerHash,
        entry: { index: entryIndex }
      });
      if (!unpacked.ok) {
        return failure(
          'PARAM_CONTAINER_UNPACK_FAILED',
          '容器内 param 解包失败，无法读取行。',
          unpacked.diagnostics
        );
      }

      const paramPath = unpacked.child.absolutePath;
      // ROOT-07：解包产物在 staging——先 mkdir/realpath/boundary 验证再注册，
      // 绝不把不存在的目录交给 Bridge。
      const stageRoots = getSession()
        ? await deps.verifiedStageRoots(
            getSession()!,
            deps.durableStoragePaths(getSession()!.meta.workspaceId),
            'PARAM_STAGING_PREPARE_FAILED'
          )
        : null;
      if (stageRoots && stageRoots.diagnostics.length > 0) {
        return failure(
          'PARAM_STAGING_PREPARE_FAILED',
          '无法准备安全暂存目录。',
          stageRoots.diagnostics
        );
      }
      const allowedRoots = stageRoots ? [...stageRoots.allowedRoots] : [dirname(paramPath)];
      // 容器 PARAM 的索引和行字节请求必须落到同一个 native document
      // session。显式绑定当前工作区身份，避免只靠 allowedRoots 的派生值在
      // staging/root 形态变化时产生两个可覆盖但互不相容的 daemon session。
      const workspaceSessionId = deps.getActiveWorkspaceSessionId
        ? deps.getActiveWorkspaceSessionId()
        : deps.activeWorkspaceSessionId;
      const bridgeSession = workspaceSessionId ? { workspaceSessionId } : {};
      const bridgeRuntime = getSession()?.layers.baseRoot
        ? { oodleRuntimeRoot: getSession()!.layers.baseRoot as string }
        : {};

      // ── 首次索引读：只取 rowIndex/id/name/dataHash，绝不取行字节。
      //    loadAll=true 仍保留为显式 legacy 兼容路径；冷启动与普通分页路径
      //    使用 includeRowPayloads=false 建立可复用的 native lazy session。
      //    回头再点同一张表不重跑 read-param-document：containerParamAllCache
      //    只给 legacy 全量路径使用，分页路径禁止写入该缓存，避免把全量 payload
      //    与轻量索引混在一起。字段定义不随 doc 缓存，信任裁决按当次策略现算。
      const docCacheKey = `${containerUri}#${cacheContainerHash}#${entryIndex}`;
      let doc = loadAll ? takeContainerParamAll(docCacheKey) : undefined;
      const activeWorkspaceSessionId = workspaceSessionId ?? '';
      let documentSessionToken = !loadAll
        && typeof requestedDocumentSessionToken === 'string'
        && requestedDocumentSessionToken.trim().length > 0
        ? requestedDocumentSessionToken
        : undefined;
      const sessionCacheKey = `${docCacheKey}#${unpacked.child.storedContentHash}`;
      const cachedSession = !loadAll
        ? takeContainerParamSession(sessionCacheKey, activeWorkspaceSessionId, paramPath)
        : undefined;
      if (!doc && cachedSession
        && (!documentSessionToken || documentSessionToken === cachedSession.sessionToken)) {
        doc = cachedSession.document;
        documentSessionToken = cachedSession.sessionToken;
      }
      const docReused = doc !== undefined;
      if (!doc) {
        const full = await runBridge<{
          sourceHash?: string;
          typeName?: string;
          rowCount?: number;
          rowDataSize?: number;
          rows?: Array<{ rowIndex: number; id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
          authority?: string;
          sessionToken?: string;
        }>({
          command: 'read-param-document',
          filePath: paramPath,
          allowedRoots,
          timeoutMs: 120_000,
          commandOptions: loadAll
            ? { includeAllPayloads: true }
            : {
                ...(documentSessionToken ? { documentSession: documentSessionToken } : {}),
                includeRowPayloads: false,
                includeRowHashes: true,
                rowPage: 0,
                rowPageSize: 0
              },
          ...(loadAll ? { maxFrameBytes: 32 * 1024 * 1024 } : {}),
          ...bridgeSession,
          ...bridgeRuntime
        });
        if (full.parseStatus === 'failed' || !full.data?.sourceHash) {
          return failure(
            'PARAM_DOCUMENT_READ_FAILED',
            `解包后的 ${unpacked.child.name} 无法解析为 PARAM。`,
            sanitizeDiagnostics(full.diagnostics)
          );
        }

        documentSessionToken = typeof full.data.sessionToken === 'string'
          && full.data.sessionToken.trim().length > 0
          ? full.data.sessionToken
          : documentSessionToken;
        if (!loadAll && !documentSessionToken) {
          return failure(
            'PARAM_DOCUMENT_SESSION_MISSING',
            `解包后的 ${unpacked.child.name} 未返回可复用的 PARAM 会话。`,
            sanitizeDiagnostics(full.diagnostics)
          );
        }

        const parsedRows = (full.data.rows ?? []).slice(0, MAX_PAGED_PARAM_ROWS);
        doc = {
          sourceHash: full.data.sourceHash,
          typeName: full.data.typeName ?? 'UNKNOWN_PARAM',
          rowDataSize: full.data.rowDataSize ?? 0,
          rowCount: full.data.rowCount ?? parsedRows.length,
          rows: parsedRows,
          ...(full.data.authority ? { authority: full.data.authority } : {})
        };
        if (loadAll) putContainerParamAll(docCacheKey, doc);
      }

      if (!loadAll && doc && documentSessionToken) {
        putContainerParamSession(sessionCacheKey, {
          document: doc,
          sessionToken: documentSessionToken,
          workspaceSessionId: activeWorkspaceSessionId,
          absolutePath: paramPath
        });
      }

      // P1 裁定：容器工作台走 readContainerParamPage，渲染器的 FIELDS 栏只从
      // fieldDefs 拿定义，而这条通道此前根本没返回。这里复用与
      // resource.readParamDocument 完全相同的 resolveTrustedParamDefinition 与
      // 逐字段映射（内置包校验 + 行宽核对不绕过）。
      // UNKNOWN_PARAM 按空串走「无定义」分支（等价于原来的 full.data.typeName ?? ''）。
      const containerTypeName = doc.typeName === 'UNKNOWN_PARAM' ? '' : doc.typeName;
      const resolvedContainerDef = containerTypeName
        ? await resolveTrustedParamDefinition(containerTypeName, doc.rowDataSize)
        : { document: null, trusted: false, diagnostic: null };
      const containerParamDef = resolvedContainerDef.document;
      // 行宽已在 resolveTrustedParamDefinition 内核对：拿到 document 即行宽一致。
      const containerRowWidthMatches = containerParamDef !== null;

      const allRows = doc.rows;
      const q = (query ?? '').trim().toLowerCase();
      const filtered = q.length === 0
        ? allRows
        : allRows.filter((row) =>
            String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
          );

      // ── 全量路径（用户裁定）：一次返回全部行（含字节）；渲染器本地过滤与
      //    虚拟化，不再分批续取；字段定义照常随页下发（P1 裁定，与分页路径一致）。
      if (loadAll) {
        return {
          ok: true,
          containerUri,
          entryIndex: unpacked.child.entryIndex,
          paramName: unpacked.child.name,
          containerHash: file.sha256 ?? '',
          childHash: unpacked.child.storedContentHash,
          sourceHash: doc.sourceHash,
          typeName: doc.typeName,
          rowDataSize: doc.rowDataSize,
          fieldDefs: containerRowWidthMatches && containerParamDef
            ? containerParamDef.fields.map((field) => ({
                id: field.id,
                name: field.name,
                type: field.type,
                offset: field.offset,
                size: field.size,
                ...(field.bitfield ? { bitfield: field.bitfield } : {}),
                ...(field.enumRef ? { enumRef: field.enumRef } : {}),
                ...(field.refs ? { refs: field.refs } : {}),
                ...(field.min !== undefined ? { min: field.min } : {}),
                ...(field.max !== undefined ? { max: field.max } : {}),
                ...(field.description ? { description: field.description } : {})
              }))
            : null,
          fieldEnums: containerRowWidthMatches && containerParamDef?.enums
            ? containerParamDef.enums.map((enumDef) => ({
                id: enumDef.id,
                name: enumDef.name,
                values: enumDef.values.map((value) => ({ value: value.value, label: value.label }))
              }))
            : null,
          fieldDefsDiagnostic: resolvedContainerDef.diagnostic,
          fieldDefsOrigin: containerParamDef?.origin ?? null,
          fieldDefsTrusted: resolvedContainerDef.trusted,
          rowCount: filtered.length,
          page: 0,
          pageSize: filtered.length,
          pageCount: 1,
          rows: filtered.map((row) => {
            const dataBase64 = typeof row.dataBase64 === 'string' ? row.dataBase64 : undefined;
            return {
              rowIndex: row.rowIndex,
              id: row.id,
              dataHash: row.dataHash,
              ...(dataBase64 !== undefined
                ? {
                    dataBase64,
                    dataHexPreview: Buffer.from(dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              ...(row.name ? { name: row.name } : {})
            };
          }),
          rowsTruncated: (doc.rowCount ?? allRows.length) > allRows.length,
          ...(doc.authority ? { authority: doc.authority } : {}),
          // 问题 5-C 的核对锚：用户真实工作区里第二次点同一张表，诊断应出现
          // PARAM_DOC_CACHE_HIT（本会话未重跑 read-param-document）；第一次是
          // PARAM_DOC_CACHE_MISS。分页路径不加这条。
          diagnostics: [
            ...unpacked.diagnostics,
            {
              severity: 'info' as const,
              code: docReused ? 'PARAM_DOC_CACHE_HIT' : 'PARAM_DOC_CACHE_MISS',
              message: docReused
                ? `复用已解析的 ${unpacked.child.name} 全量文档（本次未重跑 read-param-document）。`
                : `已解析 ${unpacked.child.name} 全量文档（${allRows.length} 行）。`,
              sourceUri: containerUri
            }
          ]
        };
      }

      const payloadSessionToken = documentSessionToken ?? '';
      const window = normalizePageWindow(
        filtered.length,
        requestedPage,
        requestedPageSize || PARAM_PAGE_SIZE
      );

      // ── 当页字节：与 readParamPage 同一策略，有搜索时不取（会对错行）──
      const pagePayloads = new Map<number, { base64: string; dataHash: string }>();
      const pageByteDiagnostics: Diagnostic[] = [];
      if (q.length === 0 && window.size > 0) {
        const bridgePage = Math.floor(window.offset / window.size);
        if (bridgePage * window.size === window.offset) {
          try {
            const pageRows = filtered.slice(window.offset, window.offset + window.size);
            const paged = await runBridge<{
              rows?: Array<{ rowIndex: number; id: number; dataBase64?: string | null; dataHash: string }>;
              payloadsIncluded?: boolean;
            }>({
              command: 'read-param-document',
              filePath: paramPath,
              allowedRoots,
              timeoutMs: 60_000,
              commandOptions: {
                documentSession: payloadSessionToken,
                includeRowPayloads: true,
                rowSelections: pageRows.map((row) => ({
                  rowIndex: row.rowIndex,
                  expectedId: row.id,
                  expectedDataHash: row.dataHash
                }))
              },
              ...bridgeSession,
              ...bridgeRuntime
            });
            for (const row of paged.data?.rows ?? []) {
              if (typeof row.dataBase64 === 'string') pagePayloads.set(row.rowIndex, { base64: row.dataBase64, dataHash: row.dataHash });
            }
            if (paged.data?.payloadsIncluded === false) {
              pageByteDiagnostics.push({
                severity: 'info',
                code: 'PARAM_PAGE_PAYLOAD_OMITTED',
                message: '本页行字节未随分页下发（页字节数超出 Bridge 载荷门限）；'
                  + '字段编辑对本页不可用，行列表不受影响。',
                sourceUri: containerUri
              });
            }
          } catch (error) {
            pageByteDiagnostics.push({
              severity: 'warning',
              code: 'PARAM_PAGE_PAYLOAD_READ_FAILED',
              message: `本页行字节读取失败：${error instanceof Error ? error.message : String(error)}`,
              sourceUri: containerUri
            });
          }
        }
      }

      return {
        ok: true,
        containerUri,
        entryIndex: unpacked.child.entryIndex,
        paramName: unpacked.child.name,
        /**
         * 写回所需的两个哈希，原样回传给 applyContainerParamFieldMutation。
         *
         * containerHash 防「容器在读与写之间被改过」，childHash 防「同一条目被
         * 并发改过」。渲染器不自己算：它拿不到容器字节，算出来的只能是猜的。
         */
        containerHash: file.sha256 ?? '',
        childHash: unpacked.child.storedContentHash,
        sessionToken: payloadSessionToken,
        sourceHash: doc.sourceHash,
        typeName: doc.typeName,
        rowDataSize: doc.rowDataSize,
        // P1 裁定：字段定义与枚举随容器 PARAM 一起下发，映射与
        // resource.readParamDocument 完全一致（含 bitfield/enumRef/refs/min/max 的
        // 条件展开与 enum label 字段名）。渲染器据此渲染 FIELDS 栏，而不是空列。
        fieldDefs: containerRowWidthMatches && containerParamDef
          ? containerParamDef.fields.map((field) => ({
              id: field.id,
              name: field.name,
              type: field.type,
              offset: field.offset,
              size: field.size,
              ...(field.bitfield ? { bitfield: field.bitfield } : {}),
              ...(field.enumRef ? { enumRef: field.enumRef } : {}),
              ...(field.refs ? { refs: field.refs } : {}),
              ...(field.min !== undefined ? { min: field.min } : {}),
              ...(field.max !== undefined ? { max: field.max } : {}),
              ...(field.description ? { description: field.description } : {})
            }))
          : null,
        fieldEnums: containerRowWidthMatches && containerParamDef?.enums
          ? containerParamDef.enums.map((enumDef) => ({
              id: enumDef.id,
              name: enumDef.name,
              values: enumDef.values.map((value) => ({ value: value.value, label: value.label }))
            }))
          : null,
        fieldDefsDiagnostic: resolvedContainerDef.diagnostic,
        fieldDefsOrigin: containerParamDef?.origin ?? null,
        fieldDefsTrusted: resolvedContainerDef.trusted,
        rowCount: filtered.length,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        rows: filtered
          .slice(window.offset, window.offset + window.size)
          .map((row) => {
            const payload = pagePayloads.get(row.rowIndex);
            const dataBase64 = typeof row.dataBase64 === 'string'
              ? row.dataBase64
              : payload?.base64;
            const dataHash = typeof row.dataHash === 'string' && row.dataHash.length > 0
              ? row.dataHash
              : payload?.dataHash ?? '';
            return {
              rowIndex: row.rowIndex,
              id: row.id,
              dataHash,
              ...(typeof dataBase64 === 'string'
                ? {
                    dataBase64,
                    dataHexPreview: Buffer.from(dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              ...(row.name ? { name: row.name } : {})
            };
          }),
        rowsTruncated: (doc.rowCount ?? allRows.length) > allRows.length,
        ...(doc.authority ? { authority: doc.authority } : {}),
        diagnostics: [...unpacked.diagnostics, ...pageByteDiagnostics]
      };
    }
  );

  /**
   * 一次读出容器内某个 param 的**完整行索引**（物理 rowIndex + id/name/dataHash，
   * 不含行字节），并把建立索引的 native session token 交给 renderer 复用。
   *
   * ── 为什么加这条通道 ──
   *
   * 行表原先靠「滚到底就取下一页」累积，实测这个形态撑不住两件事：
   *
   *   ① **跨表引用跳转**。目标行可能在第 42 页。往累积列表里塞第 42 页会得到一段
   *      与前面不连续的行（第 k+1..41 页缺失），列表顺序变成假的；而靠行筛选跳转
   *      也不行 —— 后端的 id 筛选是**子串**匹配（实测精确匹配项最远排在筛选结果第
   *      36 位，页大小只有 20），且有筛选时刻意不下发行字节，跳过去字段栏是空的。
   *   ② **总量语义**。虚拟滚动要一条完整长列表才成立，累积页数只是「已取到多少」。
   *
   * 该通道明确使用 `includeRowPayloads:false + includeRowHashes:true` 建立 native
   * lazy index：不会进入 ParamNativeDocument.Read/VerifyRoundTrip，也不会把行字节
   * 序列化到 renderer。Bridge 当前仍会为物理身份读取源字节并计算 hash；这一项
   * 成本由 timing probe 单独报告，不能把「无 payload」夸大成「零 I/O」。
   *
   * 行字节仍按页取（载荷门限按页算，见 readContainerParamPage 的实测因果）：
   * 选中某行时只取包含它的那一页。
   */
  handle(
    'resource.readContainerParamRowIndex',
    async (_event, containerUri: string, entryIndex: number) => {
      const failure = (code: string, message: string, extra: Diagnostic[] = []) => ({
        ok: false as const,
        containerUri,
        entryIndex,
        paramName: null,
        typeName: null,
        rowDataSize: 0,
        rowCount: 0,
        rows: [],
        rowsTruncated: false,
        containerHash: '',
        childHash: '',
        diagnostics: [
          { severity: 'error' as const, code, message, sourceUri: containerUri },
          ...extra
        ]
      });
      const file = getFiles().find((item) => item.sourceUri === containerUri);
      if (!file) return failure('RESOURCE_NOT_INDEXED', '资源未索引，无法读取 PARAM 行索引。');
      if (!Number.isSafeInteger(entryIndex) || entryIndex < 0) {
        return failure('PARAM_ENTRY_INDEX_INVALID', '容器条目下标非法。');
      }

      const cacheContainerHash = file.sha256
        ?? createHash('sha256').update(file.absolutePath).digest('hex');
      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: cacheContainerHash,
        entry: { index: entryIndex }
      });
      if (!unpacked.ok) {
        return failure(
          'PARAM_CONTAINER_UNPACK_FAILED',
          '容器内 param 解包失败，无法读取行索引。',
          unpacked.diagnostics
        );
      }

      // ROOT-07：解包产物在 staging——先 mkdir/realpath/boundary 验证再注册。
      const stageRoots = getSession()
        ? await deps.verifiedStageRoots(
            getSession()!,
            deps.durableStoragePaths(getSession()!.meta.workspaceId),
            'PARAM_STAGING_PREPARE_FAILED'
          )
        : null;
      if (stageRoots && stageRoots.diagnostics.length > 0) {
        return failure(
          'PARAM_STAGING_PREPARE_FAILED',
          '无法准备安全暂存目录。',
          stageRoots.diagnostics
        );
      }
      const workspaceSessionId = deps.getActiveWorkspaceSessionId
        ? deps.getActiveWorkspaceSessionId()
        : deps.activeWorkspaceSessionId;
      const bridgeSession = workspaceSessionId ? { workspaceSessionId } : {};
      const bridgeRuntime = getSession()?.layers.baseRoot
        ? { oodleRuntimeRoot: getSession()!.layers.baseRoot as string }
        : {};
      const full = await runBridge<{
        sourceHash?: string;
        typeName?: string;
        rowCount?: number;
        rowDataSize?: number;
        rows?: Array<{ rowIndex: number; id: number; name?: string | null; dataHash?: string }>;
        authority?: string;
        sessionToken?: string;
      }>({
        command: 'read-param-document',
        filePath: unpacked.child.absolutePath,
        allowedRoots: stageRoots ? [...stageRoots.allowedRoots] : [dirname(unpacked.child.absolutePath)],
        timeoutMs: 60_000,
        commandOptions: { includeRowPayloads: false, includeRowHashes: true, rowPage: 0, rowPageSize: 0 },
        ...bridgeSession,
        ...bridgeRuntime
      });
      if (full.parseStatus === 'failed' || !full.data?.sourceHash) {
        return failure(
          'PARAM_DOCUMENT_READ_FAILED',
          `解包后的 ${unpacked.child.name} 无法解析为 PARAM。`,
          sanitizeDiagnostics(full.diagnostics)
        );
      }

      const sessionToken = typeof full.data.sessionToken === 'string'
        && full.data.sessionToken.trim().length > 0
        ? full.data.sessionToken
        : undefined;
      if (!sessionToken) {
        return failure(
          'PARAM_DOCUMENT_SESSION_MISSING',
          `解包后的 ${unpacked.child.name} 未返回可复用的 PARAM 会话。`,
          sanitizeDiagnostics(full.diagnostics)
        );
      }

      const allRows = full.data.rows ?? [];
      // 截断上限与分页读取一致：两条通道的下标必须落在同一个区间，
      // 否则按索引算出的页号会指向分页通道取不到的行。
      const rows = allRows.slice(0, MAX_PAGED_PARAM_ROWS);
      const declared = full.data.rowCount ?? allRows.length;
      const invalidIdentity = rows.find((row) =>
        !Number.isSafeInteger(row.rowIndex)
        || row.rowIndex < 0
        || !Number.isSafeInteger(row.id)
        || typeof row.dataHash !== 'string'
        || row.dataHash.length === 0
      );
      if (invalidIdentity) {
        return failure(
          'PARAM_ROW_IDENTITY_MISSING',
          'native PARAM 行索引缺少完整物理身份（rowIndex + id + dataHash）。',
          sanitizeDiagnostics(full.diagnostics)
        );
      }
      const indexedRows = rows as Array<{
        rowIndex: number;
        id: number;
        name?: string | null;
        dataHash: string;
      }>;
      // readContainerParamPage 紧接着会拿同一个 token 取选中行字节。把本次
      // 已验证的轻量文档随 token 留在 main，后续页请求不再重复发起一次
      // read-param-document；真实 payload 仍只通过 rowSelections 按页读取。
      const sessionCacheKey = `${containerUri}#${cacheContainerHash}#${entryIndex}#${unpacked.child.storedContentHash}`;
      putContainerParamSession(sessionCacheKey, {
        document: {
          sourceHash: full.data.sourceHash,
          typeName: full.data.typeName ?? 'UNKNOWN_PARAM',
          rowDataSize: full.data.rowDataSize ?? 0,
          rowCount: full.data.rowCount ?? indexedRows.length,
          rows: indexedRows.map((row) => ({
            rowIndex: row.rowIndex,
            id: row.id,
            dataHash: row.dataHash,
            ...(row.name ? { name: row.name } : {})
          })),
          ...(full.data.authority ? { authority: full.data.authority } : {})
        },
        sessionToken,
        workspaceSessionId: workspaceSessionId ?? '',
        absolutePath: unpacked.child.absolutePath
      });
      return {
        ok: true as const,
        containerUri,
        entryIndex: unpacked.child.entryIndex,
        paramName: unpacked.child.name,
        typeName: full.data.typeName ?? 'UNKNOWN_PARAM',
        rowDataSize: full.data.rowDataSize ?? 0,
        rowCount: rows.length,
        sessionToken,
        rows: indexedRows.map((row) => ({
          rowIndex: row.rowIndex,
          id: row.id,
          ...(row.name ? { name: row.name } : {}),
          dataHash: row.dataHash
        })),
        // 截断必须说出来：少给行而不声明，用户会以为这个 param 就这么大。
        rowsTruncated: declared > rows.length,
        containerHash: file.sha256 ?? '',
        childHash: unpacked.child.storedContentHash,
        ...(full.data.authority ? { authority: full.data.authority } : {}),
        diagnostics: [
          ...unpacked.diagnostics,
          ...(declared > rows.length
            ? [{
                severity: 'warning' as const,
                code: 'PARAM_ROW_INDEX_TRUNCATED',
                message: `行索引在 ${rows.length} 行处截断（实际 ${declared} 行）。`,
                sourceUri: containerUri
              }]
            : [])
        ]
      };
    }
  );

  // 在主进程注册完成后后台预热一次本机只读元数据。这样用户打开工作区、扫描
  // 资源时就能并行完成包校验；首次点表不再承担整包导入的全部等待。
  void loadParamMetadata().catch(() => undefined);

  // Renderer cutover must preserve value-search semantics without reintroducing loadAll; implement native/session-side value search before removing the legacy path.
}
