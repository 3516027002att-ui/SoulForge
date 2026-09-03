/**
 * Shared session for Agent / CLI native edits (PARAM, later FMG / EMEVD).
 *
 * Opens an overlay workspace, mints the same shape of confirmation receipt
 * the workbench uses, and exposes a RawReplaceCommitPort over saveRawReplace.
 * Callers must still stage bytes through Bridge writers; this module does
 * not parse native formats.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ConfirmationReceipt, IndexedFile, ResourceFormatKind, ResourceKind } from '@soulforge/shared';
import { MemoryOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import {
  openWorkspaceSession,
  type EmedfLocator,
  type WorkspaceSession
} from '../workspace/workspaceSession.js';
import { saveRawReplace } from './saveRawResource.js';
import type { RawReplaceCommitPort, WriteConfirmationPort } from './editorMutationService.js';

export interface NativeEditSession {
  session: WorkspaceSession;
  /** Resolved user-local EMEDF path inherited from the workspace session. */
  emedfPath?: string;
  operationLog: OperationLogStore;
  stagingRoot: string;
  backupBaseDir: string;
  recoveryDir: string;
  oodleRuntimeRoot?: string;
  confirmationPort?: WriteConfirmationPort;
  commitPort: RawReplaceCommitPort;
  allowedRoots(): string[];
  mintReceipt(sourceUri: string, title: string): ConfirmationReceipt;
  indexFile(absolutePath: string, kind?: ResourceKind): Promise<IndexedFile>;
}

export interface OpenNativeEditSessionOptions {
  overlayRoot: string;
  baseRoot?: string;
  game?: string;
  operationLog?: OperationLogStore;
  /** Explicit user-provided EMEDF path; it wins over the locator. */
  emedfPath?: string;
  /** Path-only locator forwarded to openWorkspaceSession. */
  emedfLocator?: EmedfLocator;
}

export function nativeEditSessionFromContext(input: {
  session: WorkspaceSession;
  operationLog: OperationLogStore;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot?: string;
  confirmation?: ConfirmationReceipt;
  confirmationPort?: WriteConfirmationPort;
}): NativeEditSession {
  const stagingRoot = input.stagingRoot ?? join(input.backupBaseDir, '..', 'staging');
  const commitPort: RawReplaceCommitPort = {
    commit: (request) => {
      const confirmation = request.confirmation
        ?? input.confirmation
        ?? mintNativeEditReceipt(request.file.sourceUri, request.title);
      return saveRawReplace({
        file: request.file,
        expectedHash: request.expectedHash,
        newContentBase64: request.newContentBase64,
        title: request.title,
        confirmation,
        session: input.session,
        operationLog: input.operationLog,
        backupBaseDir: input.backupBaseDir,
        recoveryDir: input.recoveryDir
      });
    }
  };
  const overlayParent = dirname(input.session.layers.overlayRoot);
  const probedOodleRoot = input.session.layers.baseRoot
    ?? (existsSync(join(overlayParent, 'oo2core_6_win64.dll')) || existsSync(join(overlayParent, 'sekiro.exe')) ? overlayParent : undefined);

  return {
    session: input.session,
    ...(input.session.emedfPath ? { emedfPath: input.session.emedfPath } : {}),
    operationLog: input.operationLog,
    stagingRoot,
    backupBaseDir: input.backupBaseDir,
    recoveryDir: input.recoveryDir,
    ...(probedOodleRoot ? { oodleRuntimeRoot: probedOodleRoot } : {}),
    ...(input.confirmationPort ? { confirmationPort: input.confirmationPort } : {}),
    commitPort,
    allowedRoots: () => [
      input.session.layers.overlayRoot,
      ...(input.session.layers.baseRoot ? [input.session.layers.baseRoot] : []),
      ...(probedOodleRoot ? [probedOodleRoot] : []),
      join(input.backupBaseDir, '..')
    ],
    mintReceipt: mintNativeEditReceipt,
    indexFile: (absolutePath, kind) => indexOverlayFile(input.session, absolutePath, kind)
  };
}

export async function openNativeEditSession(
  options: OpenNativeEditSessionOptions
): Promise<NativeEditSession> {
  const overlayRoot = resolve(options.overlayRoot);
  const session = await openWorkspaceSession({
    overlayRoot,
    ...(options.baseRoot ? { baseRoot: resolve(options.baseRoot) } : {}),
    game: options.game ?? 'sekiro',
    ...(options.emedfPath !== undefined ? { emedfPath: options.emedfPath } : {}),
    ...(options.emedfLocator ? { emedfLocator: options.emedfLocator } : {})
  });
  const storage = cliStoragePaths(session.meta.workspaceId);
  await mkdir(storage.stagingRoot, { recursive: true });
  await mkdir(storage.backupBaseDir, { recursive: true });
  await mkdir(storage.recoveryDir, { recursive: true });
  const operationLog = options.operationLog ?? new MemoryOperationLogStore();
  const oodleRuntimeRoot = session.layers.baseRoot;

  const commitPort: RawReplaceCommitPort = {
    commit: (input) => {
      const confirmation = input.confirmation ?? mintNativeEditReceipt(input.file.sourceUri, input.title);
      return saveRawReplace({
        file: input.file,
        expectedHash: input.expectedHash,
        newContentBase64: input.newContentBase64,
        title: input.title,
        confirmation,
        session,
        operationLog,
        backupBaseDir: storage.backupBaseDir,
        recoveryDir: storage.recoveryDir
      });
    }
  };

  return {
    session,
    ...(session.emedfPath ? { emedfPath: session.emedfPath } : {}),
    operationLog,
    stagingRoot: storage.stagingRoot,
    backupBaseDir: storage.backupBaseDir,
    recoveryDir: storage.recoveryDir,
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
    commitPort,
    allowedRoots: () => [
      overlayRoot,
      ...(session.layers.baseRoot ? [session.layers.baseRoot] : []),
      storage.root
    ],
    mintReceipt: mintNativeEditReceipt,
    indexFile: (absolutePath, kind) => indexOverlayFile(session, absolutePath, kind)
  };
}

export function mintNativeEditReceipt(sourceUri: string, title: string): ConfirmationReceipt {
  return createConfirmationReceipt({
    subjects: [
      'CLI_NATIVE_EDIT',
      sourceUri,
      'ALL_RISKS',
      `TITLE:${title}`,
      `NONCE:${randomUUID()}`
    ],
    riskLevel: 'high',
    sourceUri,
    note: '本机 CLI / Agent 门面显式调用，经 Patch Engine 提交'
  });
}

export async function indexOverlayFile(
  session: WorkspaceSession,
  absolutePath: string,
  kind: ResourceKind = 'param'
): Promise<IndexedFile> {
  const resolved = resolve(absolutePath);
  const writable = session.resolveWritablePath(resolved);
  if (!writable.ok || !writable.absolutePath) {
    throw Object.assign(new Error(writable.diagnostics[0]?.message ?? '路径不在打开的工作区内。'), {
      code: writable.diagnostics[0]?.code ?? 'WRITE_PATH_REJECTED',
      diagnostics: writable.diagnostics
    });
  }
  const info = await stat(resolved);
  const relativePath = relative(session.layers.overlayRoot, resolved).replaceAll('\\', '/');
  const compound = compoundExtensionOf(resolved);
  return {
    id: `file:${relativePath}`,
    workspaceId: session.meta.workspaceId,
    sourceUri: pathToFileURL(resolved).href,
    sourcePath: relativePath,
    game: session.meta.game,
    resourceKind: kind,
    parseStatus: 'parsed',
    diagnostics: [],
    absolutePath: resolved,
    relativePath,
    extension: extname(resolved),
    compoundExtension: compound,
    formatKind: formatKindOf(compound),
    formatLabel: formatLabelOf(compound),
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha256: await sha256File(resolved)
  };
}

function cliStoragePaths(workspaceId: string): {
  root: string;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
} {
  const key = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  const local = process.env.LOCALAPPDATA
    ?? join(homedir(), 'AppData', 'Local');
  const root = join(local, 'SoulForge', 'cli-workspaces', key);
  return {
    root,
    backupBaseDir: join(root, 'backups'),
    recoveryDir: join(root, 'recovery'),
    stagingRoot: join(root, 'staging')
  };
}

function compoundExtensionOf(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  const markers = ['.parambnd.dcx', '.msgbnd.dcx', '.emevd.dcx', '.dcx'];
  for (const marker of markers) {
    if (name.endsWith(marker)) return marker;
  }
  return extname(filePath).toLowerCase();
}

function formatKindOf(compound: string): ResourceFormatKind {
  if (compound.includes('param')) return 'param';
  if (compound.includes('emevd')) return 'emevd';
  if (compound.includes('fmg') || compound.includes('msgbnd')) return 'fmg';
  if (compound.endsWith('.dcx')) return 'dcx';
  if (compound.endsWith('.bnd')) return 'bnd';
  return 'unknown';
}

function formatLabelOf(compound: string): string {
  if (compound.includes('param')) return 'PARAM BND';
  if (compound.includes('emevd')) return 'EMEVD';
  if (compound.includes('msgbnd') || compound.includes('fmg')) return 'FMG';
  return compound.toUpperCase();
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
