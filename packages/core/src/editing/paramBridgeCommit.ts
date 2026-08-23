/**
 * PARAM Bridge stage helpers — writers only touch staging; callers commit via Patch Engine.
 */

import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

/**
 * backup/previous 路径判定（ROUTE-06：`.bak/.prev` History-only）。
 *
 * 与 artifact matcher 的判定语义一致：大小写不敏感后缀。IPC 层读取 PARAM 前
 * 先拒绝，不依赖路由层单点防线——绕过路由直接 invoke readParamDocument 的
 * 路径（调试工具、遗留调用方）也要被同一把锁挡住。
 */
export function isParamBackupPath(relativePath: string): boolean {
  const lower = relativePath.replaceAll('\\', '/').toLowerCase();
  return lower.endsWith('.bak') || lower.endsWith('.prev');
}

export type ParamBridgeMutation =
  | { kind: 'upsert'; id: number; dataBase64: string }
  | { kind: 'delete'; id: number };

export interface ParamBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutation: ParamBridgeMutation;
  timeoutMs?: number;
}

export interface ParamBridgeBatchCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutations: ParamBridgeMutation[];
  timeoutMs?: number;
}

export interface ParamBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  rowCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export async function commitParamMutationViaBridge(
  request: ParamBridgeCommitRequest
): Promise<ParamBridgeCommitResult> {
  return commitParamMutationsViaBridge({
    sourcePath: request.sourcePath,
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    mutations: [request.mutation],
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
  });
}

/** Batch upsert/delete. Bridge already accepts `mutations[]`; this is the TS wrapper. */
export async function commitParamMutationsViaBridge(
  request: ParamBridgeBatchCommitRequest
): Promise<ParamBridgeCommitResult> {
  if (request.mutations.length === 0) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'PARAM_MUTATION_EMPTY',
        message: 'write-param 需要至少一条 mutation。'
      }]
    };
  }
  const result = await runBridge<{
    outputHash?: string;
    rowCount?: number;
  }>({
    command: 'write-param',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    timeoutMs: request.timeoutMs ?? 60_000,
    commandOptions: {
      outputPath: request.outputPath,
      expectedDocumentHash: request.expectedDocumentHash,
      mutations: request.mutations.map((mutation) => (
        mutation.kind === 'upsert'
          ? { kind: 'upsert', id: mutation.id, dataBase64: mutation.dataBase64 }
          : { kind: 'delete', id: mutation.id }
      ))
    }
  });
  const ok = result.diagnostics.some(
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.param
  );
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.rowCount !== undefined ? { rowCount: result.data.rowCount } : {}),
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}

export async function readParamDocumentViaBridge(input: {
  sourcePath: string;
  allowedRoots: string[];
  timeoutMs?: number;
  maxRows?: number;
  /** When set, Bridge returns only these rows with payloads. */
  rowIds?: number[];
  includeAllPayloads?: boolean;
  maxFrameBytes?: number;
}): Promise<{
  ok: boolean;
  data?: {
    sourceHash: string;
    typeName: string;
    /** Native PARAM data version, when supplied by the Bridge envelope. */
    dataVersion?: number;
    rowCount: number;
    rowDataSize: number;
    rows: Array<{ id: number; dataBase64: string; dataHash: string; name?: string }>;
    authority?: string;
  };
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}> {
  const result = await runBridge<{
    sourceHash?: string;
    typeName?: string;
    dataVersion?: number;
    rowCount?: number;
    rowDataSize?: number;
    rows?: Array<{ id: number; dataBase64: string; dataHash: string; name?: string }>;
    authority?: string;
  }>({
    command: 'read-param-document',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: input.timeoutMs ?? 60_000,
    ...(input.maxFrameBytes !== undefined ? { maxFrameBytes: input.maxFrameBytes } : {}),
    commandOptions: {
      ...(input.rowIds && input.rowIds.length > 0 ? { rowIds: input.rowIds } : {}),
      ...(input.includeAllPayloads ? { includeAllPayloads: true } : {})
    }
  });
  if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message
      }))
    };
  }
  const maxRows = input.maxRows ?? 500;
  const effectiveMaxRows = input.rowIds && input.rowIds.length > 0
    ? Math.max(input.rowIds.length, maxRows)
    : maxRows;
  const rawRows = result.data.rows ?? [];
  const boundedRows = effectiveMaxRows === maxRows
    ? rawRows.slice(0, maxRows)
    : rawRows.slice(0, maxRows).concat(rawRows.slice(maxRows, effectiveMaxRows));
  const rows = boundedRows.map((r) => ({
    id: r.id,
    dataBase64: r.dataBase64,
    dataHash: r.dataHash,
    ...(r.name ? { name: r.name } : {})
  }));
  return {
    ok: true,
    data: {
      sourceHash: result.data.sourceHash,
      typeName: result.data.typeName ?? 'UNKNOWN_PARAM',
      ...(result.data.dataVersion !== undefined
        ? { dataVersion: result.data.dataVersion }
        : {}),
      rowCount: result.data.rowCount ?? rows.length,
      rowDataSize: result.data.rowDataSize ?? 0,
      rows,
      ...(result.data.authority ? { authority: result.data.authority } : {})
    },
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
