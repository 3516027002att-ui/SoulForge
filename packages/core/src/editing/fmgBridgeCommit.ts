/**
 * FMG Bridge stage helpers — writers only touch staging; callers commit via Patch Engine.
 */

import { BRIDGE_STAGING_WRITE_VERIFIED_CODES } from '@soulforge/shared';
import { runBridge } from '../bridge/runBridge.js';

export type FmgBridgeMutation =
  | { kind: 'upsert'; id: number; text: string }
  | { kind: 'delete'; id: number }
  | { kind: 'add'; id: number; text: string };

export interface FmgBridgeCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutation: FmgBridgeMutation;
  /** msgbnd/DCX 容器写：FMG 表在 BND4 里的 child 下标。缺省 = loose profile。 */
  entryIndex?: number;
  timeoutMs?: number;
}

export interface FmgBridgeCommitResult {
  ok: boolean;
  outputHash?: string;
  entryCount?: number;
  storageProfile?: 'loose' | 'msgbnd';
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

export interface FmgBridgeBatchCommitRequest {
  sourcePath: string;
  outputPath: string;
  expectedDocumentHash: string;
  allowedRoots: string[];
  writableRoots: string[];
  mutations: FmgBridgeMutation[];
  entryIndex?: number;
  timeoutMs?: number;
  oodleRuntimeRoot?: string;
}

export async function commitFmgMutationViaBridge(
  request: FmgBridgeCommitRequest
): Promise<FmgBridgeCommitResult> {
  return commitFmgMutationsViaBridge({
    sourcePath: request.sourcePath,
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    mutations: [request.mutation],
    ...(request.entryIndex !== undefined ? { entryIndex: request.entryIndex } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
  });
}

/** Batch upsert/delete/add. C# writer already accepts `mutations[]`. */
export async function commitFmgMutationsViaBridge(
  request: FmgBridgeBatchCommitRequest
): Promise<FmgBridgeCommitResult> {
  if (request.mutations.length === 0) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'FMG_MUTATION_EMPTY',
        message: 'write-fmg 需要至少一条 mutation。'
      }]
    };
  }
  const commandOptions: Record<string, unknown> = {
    outputPath: request.outputPath,
    expectedDocumentHash: request.expectedDocumentHash,
    mutations: request.mutations.map((mutation) => (
      mutation.kind === 'delete'
        ? { kind: 'delete', id: mutation.id }
        : { kind: mutation.kind, id: mutation.id, text: mutation.text }
    ))
  };
  if (request.entryIndex !== undefined) {
    commandOptions.entryIndex = request.entryIndex;
  }
  const result = await runBridge<{
    outputHash?: string;
    entryCount?: number;
    storageProfile?: 'loose' | 'msgbnd';
  }>({
    command: 'write-fmg',
    filePath: request.sourcePath,
    allowedRoots: request.allowedRoots,
    writableRoots: request.writableRoots,
    timeoutMs: request.timeoutMs ?? 60_000,
    ...(request.oodleRuntimeRoot ? { oodleRuntimeRoot: request.oodleRuntimeRoot } : {}),
    commandOptions
  });
  const ok = result.diagnostics.some(
    (d) => d.code === BRIDGE_STAGING_WRITE_VERIFIED_CODES.fmg
  );
  return {
    ok,
    ...(result.data?.outputHash ? { outputHash: result.data.outputHash } : {}),
    ...(result.data?.entryCount !== undefined ? { entryCount: result.data.entryCount } : {}),
    ...(result.data?.storageProfile ? { storageProfile: result.data.storageProfile } : {}),
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
