/**
 * Agent / CLI EMEVD facade.
 *
 * Compile DSL (patch or DarkScript) through the existing four-view submit
 * path. Does not parse native EMEVD or call write-emevd directly.
 */
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import type { Diagnostic } from '@soulforge/shared';
import { fingerprintEmedfRegistry } from '../emevd/dslCompiler.js';
import { resolveEmevdRegistry } from '../emevd/emedfRegistryResolver.js';
import { searchRealEmedf } from '../testing/realEmedfLocator.js';
import { readFullEmevdDocumentViaBridge } from './emevdFullDocument.js';
import { submitEmevdDslPlanViaFourView } from './emevdFourViewController.js';
import type { NativeEditSession } from './nativeEditSession.js';

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
}): Promise<EmevdApplyResult> {
  if (input.dsl.trim().length === 0) {
    return { ok: false, error: { code: 'EMEVD_DSL_EMPTY', message: 'DSL 为空。' }, diagnostics: [] };
  }
  const resolved = await resolveEmevdFile(input.edit, input.file);
  if (!resolved.ok) return { ok: false, error: resolved.error, diagnostics: [] };
  const registry = await loadImportedRegistry(input.edit, input.emedfPath);
  if (!registry.ok) return { ok: false, error: registry.error, diagnostics: [] };

  const sourceUri = pathToFileURL(resolved.path).href;
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
  const result = await submitEmevdDslPlanViaFourView({
    compileRequest: {
      schemaVersion: 1,
      resourceUri: sourceUri,
      documentInstanceId: full.document.documentInstanceId ?? '',
      baseRevision: full.document.revision,
      emedfSchemaFingerprint: fingerprintEmedfRegistry(registry.registry),
      sourceText: input.dsl,
      mode: input.mode ?? 'patch'
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
    return {
      ok: false,
      error: {
        code: diagnostics[0]?.code ?? 'EMEVD_DSL_REJECTED',
        message: diagnostics[0]?.message ?? 'DSL 编译或提交失败。'
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
  if (baseRoot && !process.env.SOULFORGE_SEKIRO_GAME_ROOT) {
    process.env.SOULFORGE_SEKIRO_GAME_ROOT = baseRoot;
  }
  return searchRealEmedf();
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
