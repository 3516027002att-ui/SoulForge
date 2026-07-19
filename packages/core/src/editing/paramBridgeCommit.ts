/**
 * PARAM Bridge stage helpers — writers only touch staging; callers commit via Patch Engine.
 */

import type { ParamDefDocument } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';
import { prepareParamFieldMutation } from '../param/paramFieldMutation.js';

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

export interface ParamBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  rowCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export interface ParamFieldBridgeCommitRequest extends Omit<ParamBridgeCommitRequest, 'mutation'> {
  rowId: number;
  expectedRowHash: string;
  definition: ParamDefDocument;
  fieldId: string;
  value: number | string | boolean;
}

export interface ParamFieldBridgeCommitResult extends ParamBridgeCommitResult {
  fieldMutation?: {
    rowId: number;
    fieldId: string;
    beforeValue: number | string | boolean | null;
    afterValue: number | string | boolean | null;
    changedByteOffsets: number[];
    outputRowHash: string;
  };
}

export async function commitParamMutationViaBridge(
  request: ParamBridgeCommitRequest
): Promise<ParamBridgeCommitResult> {
  const commandOptions: Record<string, unknown> = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    mutation: request.mutation.kind,
    id: request.mutation.id
  };
  if (request.mutation.kind === 'upsert') {
    commandOptions.dataBase64 = request.mutation.dataBase64;
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
    commandOptions
  });
  const ok = result.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_VERIFIED');
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

export async function commitParamFieldMutationViaBridge(
  request: ParamFieldBridgeCommitRequest
): Promise<ParamFieldBridgeCommitResult> {
  const source = await readParamDocumentViaBridge({
    sourcePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    rowId: request.rowId,
    rowLimit: 1,
    includePayloads: true
  });
  if (!source.ok || !source.data) return { ok: false, diagnostics: source.diagnostics };
  if (source.data.sourceHash !== request.expectedDocumentHash) {
    return failure('PARAM_FIELD_DOCUMENT_HASH_MISMATCH', 'PARAM 文档已变化，请重新读取后再编辑。');
  }
  const row = source.data.rows[0];
  if (!row) return failure('PARAM_FIELD_ROW_NOT_FOUND', `PARAM row ${request.rowId} 不存在。`);
  if (!row.dataBase64) {
    return failure(
      'PARAM_FIELD_ROW_PAYLOAD_UNAVAILABLE',
      source.data.payloadOmissionReason ?? 'PARAM row payload 未在有界读取中返回。'
    );
  }
  const prepared = prepareParamFieldMutation({
    documentTypeName: source.data.typeName,
    rowDataSize: source.data.rowDataSize,
    rowId: request.rowId,
    rowDataBase64: row.dataBase64,
    rowDataHash: row.dataHash,
    expectedRowHash: request.expectedRowHash,
    definition: request.definition,
    fieldId: request.fieldId,
    value: request.value
  });
  if (!prepared.ok) return failure(prepared.code, prepared.message);

  const written = await commitParamMutationViaBridge({
    sourcePath: request.sourcePath,
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    mutation: { kind: 'upsert', id: request.rowId, dataBase64: prepared.dataBase64 }
  });
  if (!written.ok) return written;

  const reread = await readParamDocumentViaBridge({
    sourcePath: request.outputPath,
    allowedRoots: request.writableRoots,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    rowId: request.rowId,
    rowLimit: 1,
    includePayloads: false
  });
  const outputRow = reread.data?.rows[0];
  if (!reread.ok || !outputRow || outputRow.dataHash !== prepared.dataHash) {
    return failure('PARAM_FIELD_STAGING_REREAD_MISMATCH', '字段 mutation 暂存写入后的 row hash 不一致。');
  }
  return {
    ...written,
    diagnostics: [
      ...written.diagnostics,
      {
        severity: 'info',
        code: 'PARAM_FIELD_STAGING_WRITE_VERIFIED',
        message: '用户派生字段 mutation 已写入暂存区并按 row hash 重读验证。'
      }
    ],
    fieldMutation: {
      rowId: prepared.rowId,
      fieldId: prepared.fieldId,
      beforeValue: prepared.beforeValue,
      afterValue: prepared.afterValue,
      changedByteOffsets: prepared.changedByteOffsets,
      outputRowHash: prepared.dataHash
    }
  };
}

function failure(code: string, message: string): ParamFieldBridgeCommitResult {
  return { ok: false, diagnostics: [{ severity: 'error', code, message }] };
}

export async function readParamDocumentViaBridge(input: {
  sourcePath: string;
  allowedRoots: string[];
  timeoutMs?: number;
  rowOffset?: number;
  rowLimit?: number;
  rowId?: number;
  includePayloads?: boolean;
}): Promise<{
  ok: boolean;
  data?: {
    sourceHash: string;
    typeName: string;
    rowCount: number;
    rowDataSize: number;
    rows: Array<{ id: number; dataBase64?: string; dataHash: string; name?: string }>;
    rowOffset: number;
    rowLimit: number;
    rowsReturned: number;
    rowsTruncated: boolean;
    payloadsIncluded: boolean;
    payloadOmissionReason?: string;
    authority?: string;
  };
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}> {
  const result = await runBridge<{
    sourceHash?: string;
    typeName?: string;
    rowCount?: number;
    rowDataSize?: number;
    rows?: Array<{ id: number; dataBase64?: string; dataHash: string; name?: string }>;
    rowOffset?: number;
    rowLimit?: number;
    rowsReturned?: number;
    rowsTruncated?: boolean;
    payloadsIncluded?: boolean;
    payloadOmissionReason?: string;
    authority?: string;
  }>({
    command: 'read-param-document',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: input.timeoutMs ?? 60_000,
    commandOptions: {
      rowOffset: input.rowOffset ?? 0,
      rowLimit: input.rowLimit ?? 32,
      ...(input.rowId !== undefined ? { rowId: input.rowId } : {}),
      includePayloads: input.includePayloads ?? true
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
  const rows = (result.data.rows ?? []).map((r) => ({
    id: r.id,
    dataHash: r.dataHash,
    ...(r.dataBase64 ? { dataBase64: r.dataBase64 } : {}),
    ...(r.name ? { name: r.name } : {})
  }));
  return {
    ok: true,
    data: {
      sourceHash: result.data.sourceHash,
      typeName: result.data.typeName ?? 'UNKNOWN_PARAM',
      rowCount: result.data.rowCount ?? rows.length,
      rowDataSize: result.data.rowDataSize ?? 0,
      rows,
      rowOffset: result.data.rowOffset ?? input.rowOffset ?? 0,
      rowLimit: result.data.rowLimit ?? input.rowLimit ?? 32,
      rowsReturned: result.data.rowsReturned ?? rows.length,
      rowsTruncated: result.data.rowsTruncated ?? false,
      payloadsIncluded: result.data.payloadsIncluded ?? false,
      ...(result.data.payloadOmissionReason
        ? { payloadOmissionReason: result.data.payloadOmissionReason }
        : {}),
      ...(result.data.authority ? { authority: result.data.authority } : {})
    },
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
