/**
 * FMG Bridge stage helpers — writers only touch staging; callers commit via Patch Engine.
 */

import { runBridge } from '../bridge/runBridge.js';

export type FmgBridgeMutation =
  | { kind: 'set_text'; id: number; stringIndex: number; text: string }
  | { kind: 'upsert'; id: number; text: string }
  | { kind: 'delete'; id: number; stringIndex?: number }
  | { kind: 'insert'; id: number; stringIndex: number; text: string }
  | {
      kind: 'reorder';
      id: number;
      stringIndex: number;
      beforeId?: number;
      beforeStringIndex?: number;
    }
  | { kind: 'add'; id: number; text: string };

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

export interface FmgBridgeDocument {
  sourceHash: string;
  documentHash: string;
  documentRevision: string;
  schemaId: string;
  schemaVersion: string;
  layoutFingerprint: string;
  entryCount: number;
  entries: Array<{ id: number; text: string; stringIndex: number }>;
  authority?: string;
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
  if (request.mutation.kind === 'upsert' || request.mutation.kind === 'add') {
    commandOptions.text = request.mutation.text;
  } else if (request.mutation.kind === 'set_text' || request.mutation.kind === 'insert') {
    commandOptions.stringIndex = request.mutation.stringIndex;
    commandOptions.text = request.mutation.text;
  } else if (request.mutation.kind === 'reorder') {
    commandOptions.stringIndex = request.mutation.stringIndex;
    if (request.mutation.beforeStringIndex !== undefined) {
      commandOptions.beforeStringIndex = request.mutation.beforeStringIndex;
      commandOptions.beforeId = request.mutation.beforeId;
    }
  } else if (request.mutation.kind === 'delete' && request.mutation.stringIndex !== undefined) {
    commandOptions.stringIndex = request.mutation.stringIndex;
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
  const ok = result.parseStatus !== 'failed'
    && typeof result.data?.outputHash === 'string'
    && result.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_VERIFIED');
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
  data?: FmgBridgeDocument;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}> {
  const result = await runBridge<{
    sourceHash?: string;
    documentHash?: string;
    documentRevision?: string;
    schemaId?: string;
    schemaVersion?: string;
    layoutFingerprint?: string;
    entryCount?: number;
    entries?: Array<{ id: number; text: string; stringIndex: number }>;
    authority?: string;
  }>({
    command: 'read-fmg-document',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: input.timeoutMs ?? 60_000
  });
  const entries = result.data?.entries;
  const invalidEntries = !Array.isArray(entries)
    || entries.some((entry, index) => (
      !Number.isSafeInteger(entry.id)
      || typeof entry.text !== 'string'
      || !Number.isSafeInteger(entry.stringIndex)
      || entry.stringIndex !== index
    ));
  const envelopeInvalid = !result.data?.sourceHash
    || !result.data.documentHash
    || !result.data.documentRevision
    || !result.data.schemaId
    || !result.data.schemaVersion
    || !result.data.layoutFingerprint
    || invalidEntries
    || (result.data.entryCount !== undefined && result.data.entryCount !== entries?.length);
  if (result.parseStatus === 'failed' || envelopeInvalid) {
    return {
      ok: false,
      diagnostics: [...result.diagnostics.map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message
      })), ...(
        result.parseStatus !== 'failed' && envelopeInvalid
          ? [{
              severity: 'error',
              code: 'FMG_DOCUMENT_ENVELOPE_INVALID',
              message: 'FMG Bridge envelope 的文档绑定或条目槽位身份无效。'
            }]
          : []
      )]
    };
  }
  const data = result.data!;
  return {
    ok: true,
    data: {
      sourceHash: data.sourceHash!,
      documentHash: data.documentHash!,
      documentRevision: data.documentRevision!,
      schemaId: data.schemaId!,
      schemaVersion: data.schemaVersion!,
      layoutFingerprint: data.layoutFingerprint!,
      entryCount: data.entryCount ?? entries!.length,
      entries: entries!.map((e) => ({
        id: e.id,
        text: e.text,
        stringIndex: e.stringIndex
      })),
      ...(data.authority ? { authority: data.authority } : {})
    },
    diagnostics: result.diagnostics.map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message
    }))
  };
}
