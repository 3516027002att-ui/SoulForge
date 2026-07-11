import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  const root = await mkdtemp(join(tmpdir(), 'soulforge-v05-'));
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
  const committed = await commitValidatedStagingArea(staging, { session, operationLog: store });
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
    confirmation: rollbackConfirmation(committed.opId)
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
