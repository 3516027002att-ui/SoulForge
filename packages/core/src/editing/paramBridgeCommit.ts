/**
 * PARAM Bridge stage helpers — writers only touch staging; callers commit via Patch Engine.
 */

import { runBridge } from '../bridge/runBridge.js';

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

export async function readParamDocumentViaBridge(input: {
  sourcePath: string;
  allowedRoots: string[];
  timeoutMs?: number;
  maxRows?: number;
}): Promise<{
  ok: boolean;
  data?: {
    sourceHash: string;
    typeName: string;
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
    rowCount?: number;
    rowDataSize?: number;
    rows?: Array<{ id: number; dataBase64: string; dataHash: string; name?: string }>;
    authority?: string;
  }>({
    command: 'read-param-document',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: input.timeoutMs ?? 60_000
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
  const rows = (result.data.rows ?? []).slice(0, maxRows).map((r) => ({
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
