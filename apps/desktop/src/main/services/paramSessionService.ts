import { dirname } from 'node:path';
import { isParamBackupPath, type BridgeRunner, type WorkspaceSession } from '@soulforge/core';
import { PARAM_PAGE_SIZE, PARAM_ROW_PAYLOAD_BATCH_MAX, type IndexedFile, type Diagnostic, type ParamDefDocument, type ParamNativeTelemetry, type ParamSessionMetadata } from '@soulforge/shared';
import { sanitizeDiagnostics, sanitizeRendererValue } from '../rendererDto.js';

export interface ParamSessionBinding {
  sourceUri: string;
  workspaceSessionId: string;
  sourceHash: string;
  pathSourceGeneration: number;
  entryIdentity?: string;
}
interface TrustedDefinition { document: ParamDefDocument | null; trusted: boolean; diagnostic: { code: string; message: string } | null }
export interface ParamSessionServicePorts {
  getFiles(): readonly IndexedFile[];
  getSession(): WorkspaceSession | null;
  getWorkspaceSessionId(): string | null;
  verifiedReadRoots(session: WorkspaceSession | null, fallback: string): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  runBridge: BridgeRunner;
  sessionBindings: Map<string, ParamSessionBinding>;
  recordCounter(key: string, delta?: number): void;
  resolveTrustedParamDefinition(typeName: string, rowDataSize: number): Promise<TrustedDefinition>;
  projectParamSessionMetadata(typeName: string, rowDataSize: number, resolved: TrustedDefinition): ParamSessionMetadata;
  projectParamNativeTelemetry(value: unknown): ParamNativeTelemetry | null;
}

/** Bounded native PARAM session projections. No transport events, filesystem
 * writes or commit authority enter this service. Ports already carry the host's
 * captured workspace/read lifetime and native authority. */
export function createParamSessionService(ports: ParamSessionServicePorts) {
  const { getFiles, getSession, getWorkspaceSessionId, verifiedReadRoots, runBridge, sessionBindings,
    resolveTrustedParamDefinition, projectParamSessionMetadata, projectParamNativeTelemetry } = ports;
  const _forensicsInc = ports.recordCounter;

  // Renderer cutover must preserve value-search semantics without reintroducing loadAll; implement native/session-side value search before removing the legacy path.
  // Slim PARAM session — Parse once → Project many (B6). C# ParamDocumentSessionCache is native authority;
  // Electron only keeps opaque token + lightweight binding. Never touches paramAllCache / includeAllPayloads.
  const openParamSession = async (request: unknown) => {
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
    const roots = await verifiedReadRoots(session!, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) {
      return sanitizeRendererValue({ ok: false, diagnostics: roots.diagnostics });
    }
    const workspaceSessionId = getWorkspaceSessionId();
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
  };

  const readParamIndexPage = async (request: unknown) => {
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
    const roots = await verifiedReadRoots(session!, dirname(file.absolutePath));
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
  };

  // rowSelections — slim selected-row projection (B4.3)
  const readParamRows = async (request: unknown) => {
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
    const roots = await verifiedReadRoots(session!, dirname(file.absolutePath));
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
  };
  return Object.freeze({ openParamSession, readParamIndexPage, readParamRows });
}
