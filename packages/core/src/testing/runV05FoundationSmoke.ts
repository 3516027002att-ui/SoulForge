import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { createPatchProposal, createStagingArea, commitValidatedStagingArea } from '../patch/patchEngine.js';
import { buildGraphPatchFromProposal } from '../patch/graphPatch.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { openFileOperationLogStore } from '../patch/fileOperationLogStore.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { getLatestSchemaVersion, SQLITE_MIGRATIONS } from '../storage/sqliteSchema.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { isAiToolPermissionAllowed, maxPermissionForMode } from '../ai/toolPermissions.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

async function main(): Promise<void> {
  // 经 harness 建临时工作区：无论成功还是抛错都保证删除。
  // 改造前这里直接 mkdtemp 且从不清理，每次运行泄漏一个目录。
  await withSmokeWorkspace('v05', (workspace) => runFoundationChecks(workspace.root));
}

async function runFoundationChecks(root: string): Promise<void> {
  const overlayRoot = join(root, 'mod');
  const baseRoot = join(root, 'game');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(baseRoot, { recursive: true });
  await mkdir(join(overlayRoot, 'msg'), { recursive: true });
  await mkdir(join(baseRoot, 'msg'), { recursive: true });

  const overlayFile = join(overlayRoot, 'msg', 'note.txt');
  const baseFile = join(baseRoot, 'msg', 'note.txt');
  await writeFile(overlayFile, 'overlay-v1\n', 'utf8');
  await writeFile(baseFile, 'base-readonly\n', 'utf8');

  const session = await openWorkspaceSession({ overlayRoot, baseRoot, game: 'unknown' });
  if (session.meta.baseMissing) throw new Error('Expected base to be present.');
  if (!session.isOverlayPath(overlayFile)) throw new Error('Overlay path check failed.');
  if (!session.isBasePath(baseFile)) throw new Error('Base path check failed.');

  const baseWrite = session.resolveWritablePath(baseFile);
  if (baseWrite.ok) throw new Error('Base path must not be writable.');
  if (!baseWrite.diagnostics.some((item) => item.code === 'WRITE_TO_BASE_FORBIDDEN')) {
    throw new Error('Expected WRITE_TO_BASE_FORBIDDEN diagnostic.');
  }

  const overlayWrite = session.resolveWritablePath(overlayFile);
  if (!overlayWrite.ok) throw new Error('Overlay path must be writable.');

  // Opened workspace nested inside a mounted game tree (Sekiro\\mods).
  // The old gate matched base first and rejected the opened mods folder.
  const nestedGame = join(root, 'sekiro-install');
  const nestedMods = join(nestedGame, 'mods');
  await mkdir(join(nestedMods, 'param'), { recursive: true });
  await mkdir(join(nestedGame, 'param'), { recursive: true });
  const nestedOverlayFile = join(nestedMods, 'param', 'gameparam.txt');
  const nestedVanillaFile = join(nestedGame, 'param', 'gameparam.txt');
  await writeFile(nestedOverlayFile, 'mod-v1\n', 'utf8');
  await writeFile(nestedVanillaFile, 'vanilla\n', 'utf8');
  const nestedSession = await openWorkspaceSession({
    overlayRoot: nestedMods,
    baseRoot: nestedGame,
    game: 'sekiro'
  });
  if (!nestedSession.isOverlayPath(nestedOverlayFile)) {
    throw new Error('Nested mods path must be classified as overlay.');
  }
  if (nestedSession.isBasePath(nestedOverlayFile)) {
    throw new Error('Nested mods path must not be classified as base.');
  }
  const nestedWrite = nestedSession.resolveWritablePath(nestedOverlayFile);
  if (!nestedWrite.ok) {
    throw new Error(`Opened nested workspace must be writable: ${JSON.stringify(nestedWrite.diagnostics)}`);
  }
  const nestedAsBaseLayer = nestedSession.resolveWritablePath(nestedOverlayFile, 'base');
  if (!nestedAsBaseLayer.ok) {
    throw new Error('Opened workspace path stays writable even if caller passes layer=base.');
  }
  const nestedVanillaWrite = nestedSession.resolveWritablePath(nestedVanillaFile);
  if (nestedVanillaWrite.ok) {
    throw new Error('Vanilla sibling outside the opened mods folder must stay unwritable.');
  }
  if (!nestedVanillaWrite.diagnostics.some((item) => item.code === 'WRITE_TO_BASE_FORBIDDEN')) {
    throw new Error('Expected WRITE_TO_BASE_FORBIDDEN for vanilla sibling outside opened workspace.');
  }

  // Keep memory store for foundation path; disk reopen is covered by runV05PersistSmoke.
  const store = new MemoryOperationLogStore();
  const fileStoreProbe = openFileOperationLogStore(join(root, 'probe-operation-log.json'));
  if ((await fileStoreProbe.list()).length !== 0) {
    throw new Error('Empty file operation log should start with zero entries.');
  }

  const proposal = createPatchProposal({
    workspaceId: session.meta.workspaceId,
    title: 'v0.5 foundation text edit',
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

  if (!proposal.graph || proposal.graph.summary.fileCount !== 1) {
    throw new Error('Expected graph patch attached to proposal.');
  }

  const graph = buildGraphPatchFromProposal(proposal);
  if (graph.nodes.length < 2 || graph.edges.length < 1) {
    throw new Error('Graph patch IR was under-populated.');
  }

  const staging = await createStagingArea(proposal);
  // backupRoot 指向工作区内：不指定时 createRestorePoint 默认落系统临时目录，
  // 备份是有意保留的（不该自动删），于是每次运行在 tmpdir 留下 soulforge-backup-*。
  // 生产路径由调用方显式指定（桌面用 LOCALAPPDATA），smoke 同样必须显式指定。
  const committed = await commitValidatedStagingArea(staging, {
    session,
    operationLog: store,
    backupRoot: join(root, 'backups')
  });
  if (!committed.operation || committed.operation.status !== 'committed') {
    throw new Error('Commit did not produce a committed operation log entry.');
  }
  if ((await readFile(overlayFile, 'utf8')) !== 'overlay-v2\n') {
    throw new Error('Overlay file was not updated by Patch Engine commit.');
  }
  if ((await readFile(baseFile, 'utf8')) !== 'base-readonly\n') {
    throw new Error('Base file was mutated; overlay isolation failed.');
  }

  const history = await store.history(session.meta.workspaceId);
  if (history.length !== 1 || history[0]?.fileCount !== 1) {
    throw new Error('Patch history entry missing after commit.');
  }

  const rolled = await rollbackOperation({
    opId: committed.opId,
    store,
    session,
    confirmation: rollbackConfirmation(committed.opId),
    // 回滚同样会建备份；不指定 backupBaseDir 时它落系统临时目录并有意保留。
    backupBaseDir: join(root, 'backups')
  });
  if (!rolled.ok) throw new Error(`Rollback failed: ${rolled.diagnostics.map((d) => d.message).join('; ')}`);
  if ((await readFile(overlayFile, 'utf8')) !== 'overlay-v1\n') {
    throw new Error('Rollback did not restore overlay file content.');
  }
  if ((await store.get(committed.opId))?.status !== 'committed') {
    throw new Error('Inverse rollback must not mutate the original operation status.');
  }
  if (!(await store.list(session.meta.workspaceId)).some((item) => {
    return item.inverseOfOpId === committed.opId && item.status === 'committed';
  })) {
    throw new Error('Committed inverse rollback operation was not recorded.');
  }

  if (getLatestSchemaVersion() < 2) {
    throw new Error('Expected SQLite schema version >= 2 for v0.5 tables.');
  }
  if (!SQLITE_MIGRATIONS.some((migration) => migration.id === 2 && migration.name.includes('v0_5'))) {
    throw new Error('Missing v0.5 SQLite migration.');
  }

  if (maxPermissionForMode('plan') !== 'validate') {
    throw new Error('Plan mode should cap at validate.');
  }
  if (!isAiToolPermissionAllowed('propose', 'plan')) {
    throw new Error('Plan mode should allow propose.');
  }
  if (isAiToolPermissionAllowed('commit', 'plan')) {
    throw new Error('Plan mode must not allow commit.');
  }
  if (!isAiToolPermissionAllowed('commit', 'normal')) {
    throw new Error('Normal / Edit mode should allow commit.');
  }
  if (isAiToolPermissionAllowed('rollback', 'normal')) {
    throw new Error('Normal / Edit mode must not allow rollback.');
  }
  if (!isAiToolPermissionAllowed('rollback', 'fullPermission')) {
    throw new Error('Full permission should allow rollback tools.');
  }

  const registry = createDefaultToolRegistry();
  const names = new Set(registry.list().map((tool) => tool.name));
  for (const required of ['build_patch_graph', 'list_operations', 'rollback_operation']) {
    if (!names.has(required)) throw new Error(`Missing AI tool: ${required}`);
  }

  const index = new WorkspaceIndex(session.meta.workspaceId);
  const graphTool = await registry.run('build_patch_graph', proposal, { workspaceIndex: index, mode: 'plan' });
  if (!graphTool.ok) throw new Error('build_patch_graph failed in plan mode.');

  const rollbackDenied = await registry.run(
    'rollback_operation',
    { opId: committed.opId },
    { workspaceIndex: index, mode: 'plan' }
  );
  if (rollbackDenied.ok || rollbackDenied.error?.code !== 'TOOL_PERMISSION_DENIED') {
    throw new Error('rollback_operation must be denied in plan mode.');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'v0.5 foundation smoke: ok',
    workspaceId: session.meta.workspaceId,
    schemaVersion: getLatestSchemaVersion(),
    graphNodes: graph.nodes.length,
    graphEdges: graph.edges.length,
    tools: registry.list().length,
    history: (await store.history(session.meta.workspaceId)).map((entry) => ({
      opId: entry.opId,
      status: entry.status,
      fileCount: entry.fileCount
    }))
  }, null, 2));
}

function rollbackConfirmation(opId: string) {
  return createConfirmationReceipt({
    subjects: [`ROLLBACK_OPERATION:${opId}`],
    riskLevel: 'high',
    note: 'foundation smoke'
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
