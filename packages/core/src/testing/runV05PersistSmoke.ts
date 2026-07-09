/**
 * Gating smoke: FileOperationLogStore survives reopen; commit/rollback use the real store;
 * baseRoot open + WRITE_TO_BASE_FORBIDDEN leave base bytes unchanged.
 * Also exercises the desktop path builder against a real file:// workspaceId on Windows.
 */
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPatchProposal, createStagingArea, commitValidatedStagingArea } from '../patch/patchEngine.js';
import { openFileOperationLogStore } from '../patch/fileOperationLogStore.js';
import {
  operationLogFileNameForWorkspace,
  resolveOperationLogStorePath
} from '../patch/operationLogPath.js';
import { rollbackOperation } from '../patch/rollback.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { makeWorkspaceId } from '../workspace/resourceUri.js';

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-v05-persist-'));
  const overlayRoot = join(root, 'mod');
  const baseRoot = join(root, 'game');
  const logsDirectory = join(root, 'operation-logs');

  await mkdir(join(overlayRoot, 'msg'), { recursive: true });
  await mkdir(join(baseRoot, 'msg'), { recursive: true });
  await mkdir(logsDirectory, { recursive: true });

  const overlayFile = join(overlayRoot, 'msg', 'note.txt');
  const baseFile = join(baseRoot, 'msg', 'note.txt');
  await writeFile(overlayFile, 'overlay-v1\n', 'utf8');
  await writeFile(baseFile, 'base-readonly\n', 'utf8');
  const baseBytesBefore = await readFile(baseFile);

  // --- baseRoot open + write gate ---
  const session = await openWorkspaceSession({ overlayRoot, baseRoot, game: 'unknown' });
  if (session.meta.baseMissing) {
    throw new Error('Expected baseMissing=false when baseRoot exists.');
  }
  if (!session.layers.baseRoot) {
    throw new Error('Expected session.layers.baseRoot to be set.');
  }

  // Workspace ids are file:// URLs — the same shape desktop main receives.
  const workspaceIdFromSession = session.meta.workspaceId;
  const workspaceIdFromPath = makeWorkspaceId(overlayRoot);
  if (workspaceIdFromSession !== workspaceIdFromPath) {
    throw new Error('Session workspaceId must match makeWorkspaceId(overlayRoot).');
  }
  if (!workspaceIdFromSession.startsWith('file:')) {
    throw new Error(`Expected file:// workspaceId, got: ${workspaceIdFromSession}`);
  }

  // Desktop path builder must not embed raw ":" / "//" path segments from the URI.
  const storePath = resolveOperationLogStorePath(logsDirectory, workspaceIdFromSession);
  const fileName = operationLogFileNameForWorkspace(workspaceIdFromSession);
  if (storePath.includes('file:') || /[/\\]file_?\/\//i.test(storePath)) {
    throw new Error(`Store path still contains raw file URL segments: ${storePath}`);
  }
  if (fileName.includes(':') || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error(`Operation log file name is not Windows-safe: ${fileName}`);
  }
  if (!storePath.startsWith(logsDirectory)) {
    throw new Error(`Store path escaped logs directory: ${storePath}`);
  }

  // Naive join of raw workspaceId (the old desktop bug) must not be what we use.
  const naiveBroken = join(logsDirectory, `${workspaceIdFromSession}.json`);
  if (storePath === naiveBroken) {
    throw new Error('resolveOperationLogStorePath must not join raw workspaceId into the file name.');
  }

  const baseWrite = session.resolveWritablePath(baseFile);
  if (baseWrite.ok) throw new Error('Base path must not be writable.');
  if (!baseWrite.diagnostics.some((item) => item.code === 'WRITE_TO_BASE_FORBIDDEN')) {
    throw new Error('Expected WRITE_TO_BASE_FORBIDDEN diagnostic.');
  }
  const baseBytesAfterGate = await readFile(baseFile);
  if (!baseBytesBefore.equals(baseBytesAfterGate)) {
    throw new Error('Base file bytes changed after write-gate check.');
  }

  // --- commit with file-backed store at the desktop-shaped path ---
  const store = openFileOperationLogStore(storePath);
  const proposal = createPatchProposal({
    workspaceId: session.meta.workspaceId,
    title: 'v0.5 persist text edit',
    author: 'user',
    mode: 'normal',
    changes: [{
      targetUri: 'file://msg/note.txt',
      targetPath: overlayFile,
      kind: 'text',
      layer: 'overlay',
      resourceKind: 'msg',
      structuredEdit: { newText: 'overlay-v2\n' }
    }]
  });

  const staging = await createStagingArea(proposal);
  const committed = await commitValidatedStagingArea(staging, { session, operationLog: store });
  if (committed.diagnostics.some((item) => item.code === 'OPERATION_LOG_RECORD_FAILED')) {
    throw new Error(`Operation log record failed at desktop-shaped path: ${storePath}`);
  }
  if (!committed.operation || committed.operation.status !== 'committed') {
    throw new Error('Commit did not produce a committed operation log entry.');
  }
  if ((await readFile(overlayFile, 'utf8')) !== 'overlay-v2\n') {
    throw new Error('Overlay file was not updated by Patch Engine commit.');
  }
  if ((await readFile(baseFile, 'utf8')) !== 'base-readonly\n') {
    throw new Error('Base file was mutated; overlay isolation failed.');
  }

  // Prove the store file actually landed on disk at the resolved path.
  await access(storePath);

  const opId = committed.opId;
  const listedBeforeReopen = store.list(session.meta.workspaceId);
  if (listedBeforeReopen.length !== 1 || listedBeforeReopen[0]?.opId !== opId) {
    throw new Error('Store list missing committed op before reopen.');
  }
  const historyBefore = store.history(session.meta.workspaceId);
  if (historyBefore[0]?.fileCount !== 1 || historyBefore[0]?.changedPaths.length !== 1) {
    throw new Error('History file metadata missing before reopen.');
  }

  // --- reopen same path: contract must return same opId + file metadata ---
  const reopened = openFileOperationLogStore(storePath);
  const listedAfter = reopened.list(session.meta.workspaceId);
  if (listedAfter.length !== 1 || listedAfter[0]?.opId !== opId) {
    throw new Error('Reopened store did not return the same opId.');
  }
  const reopenedRecord = reopened.get(opId);
  if (!reopenedRecord || reopenedRecord.status !== 'committed') {
    throw new Error('Reopened store missing committed record.');
  }
  if (reopenedRecord.files.length !== 1) {
    throw new Error('Reopened store lost file operation metadata.');
  }
  if (reopenedRecord.files[0]?.targetPath !== overlayFile) {
    throw new Error('Reopened store file targetPath mismatch.');
  }
  if (!reopenedRecord.files[0]?.backupPath) {
    throw new Error('Reopened store missing backupPath.');
  }
  const historyAfter = reopened.history(session.meta.workspaceId);
  if (historyAfter[0]?.opId !== opId || historyAfter[0]?.fileCount !== 1) {
    throw new Error('Reopened history metadata mismatch.');
  }

  // --- rollback via reopened store ---
  const rolled = await rollbackOperation({ opId, store: reopened, session });
  if (!rolled.ok) {
    throw new Error(`Rollback failed: ${rolled.diagnostics.map((d) => d.message).join('; ')}`);
  }
  if ((await readFile(overlayFile, 'utf8')) !== 'overlay-v1\n') {
    throw new Error('Rollback did not restore overlay file content.');
  }
  if (reopened.get(opId)?.status !== 'rolled_back') {
    throw new Error('Operation log status was not updated to rolled_back after rollback.');
  }
  if ((await readFile(baseFile, 'utf8')) !== 'base-readonly\n') {
    throw new Error('Base file was mutated during rollback.');
  }

  // Third open confirms rolled_back status persists
  const third = openFileOperationLogStore(storePath);
  if (third.get(opId)?.status !== 'rolled_back') {
    throw new Error('Rolled-back status did not survive third reopen.');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'v0.5 persist + baseRoot smoke: ok',
    storePath,
    fileName,
    workspaceId: session.meta.workspaceId,
    workspaceIdIsFileUrl: session.meta.workspaceId.startsWith('file:'),
    opId,
    baseMissing: session.meta.baseMissing,
    history: third.history(session.meta.workspaceId).map((entry) => ({
      opId: entry.opId,
      status: entry.status,
      fileCount: entry.fileCount
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
