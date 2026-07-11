/**
 * FMG Bridge stage helpers — writers only touch staging; callers commit via Patch Engine.
 */

import { runBridge } from '../bridge/runBridge.js';

export type FmgBridgeMutation =
  | { kind: 'upsert'; id: number; text: string }
  | { kind: 'delete'; id: number };

export interface FmgBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutation: FmgBridgeMutation;
  timeoutMs?: number;
}

export interface FmgBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  entryCount?: number;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export async function commitFmgMutationViaBridge(
  request: FmgBridgeCommitRequest
): Promise<FmgBridgeCommitResult> {
  const commandOptions: Record<string, unknown> = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    mutation: request.mutation.kind,
    id: request.mutation.id
  };
  if (request.mutation.kind === 'upsert') {
    commandOptions.text = request.mutation.text;
  }
  const result = await runBridge<{
    outputHash?: string;
    entryCount?: number;
  }>({
    command: 'write-fmg',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    timeoutMs: request.timeoutMs ?? 60_000,
    commandOptions
  });
  const ok = result.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED');
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.entryCount !== undefined ? { entryCount: result.data.entryCount } : {}),
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}

export async function readFmgDocumentViaBridge(input: {
  sourcePath: string;
  allowedRoots: string[];
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  data?: {
    sourceHash: string;
    entryCount: number;
    entries: Array<{ id: number; text: string }>;
    authority?: string;
  };
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}> {
  const result = await runBridge<{
    sourceHash?: string;
    entryCount?: number;
    entries?: Array<{ id: number; text: string }>;
    authority?: string;
  }>({
    command: 'read-fmg-document',
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
  return {
    ok: true,
    data: {
      sourceHash: result.data.sourceHash,
      entryCount: result.data.entryCount ?? result.data.entries?.length ?? 0,
      entries: (result.data.entries ?? []).map((e) => ({ id: e.id, text: e.text })),
      ...(result.data.authority ? { authority: result.data.authority } : {})
    },
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
