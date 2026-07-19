import { app } from 'electron';
import { access, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationLogRecord } from '@soulforge/shared';
import { OperationLogUtilityClient } from './operationLogUtilityClient.js';
import { executeRecoveryCleanup } from './recoveryCleanup.js';
import {
  createPatchIr,
  executePatchIrThroughTransaction,
  openWorkspaceSession
} from '@soulforge/core';

const here = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-electron-sqlite-'));
  const overlayRoot = join(root, 'mod');
  const workspaceId = 'electron-utility-smoke';
  await mkdir(overlayRoot, { recursive: true });
  const legacyPath = join(root, 'legacy.json');
  const legacyRecord = makeRecord(workspaceId, 'legacy-op');
  await writeFile(
    legacyPath,
    `${JSON.stringify({ version: 1, entries: [legacyRecord] }, null, 2)}\n`,
    'utf8'
  );

  const client = new OperationLogUtilityClient(
    join(here, 'databaseUtility.js'),
    30_000,
    resolve(here, '../../.native/better_sqlite3.node')
  );
  try {
    await client.openApp(join(root, 'app.db'));
    const appOnlyHealth = await client.health();
    if (!appOnlyHealth.appReady || appOnlyHealth.ready || appOnlyHealth.workspaceId) {
      throw new Error('Database utility app-only handshake failed.');
    }
    await client.openWorkspace({
      appDatabasePath: join(root, 'app.db'),
      databasePath: join(root, 'workspace.db'),
      workspaceId,
      rootPath: overlayRoot,
      game: 'sekiro',
      legacyOperationLogPath: legacyPath,
      legacyBackupDirectory: join(root, 'legacy-backups'),
      legacySemanticSnapshotPath: join(root, 'semantic-snapshot.json'),
      legacySemanticBackupDirectory: join(root, 'semantic-backups')
    });
    const health = await client.health();
    await access(join(root, 'app.db'));
    const direct = makeRecord(workspaceId, 'direct-op');
    await client.record(direct);
    const records = await client.list(workspaceId);
    const reopened = await client.get(direct.opId);
    if (!health.ready || !health.appReady || health.workspaceId !== workspaceId) {
      throw new Error('Database utility health handshake failed.');
    }
    const appService = await client.upsertModelService({
      id: 'utility-model-service', displayName: 'Utility model service',
      protocol: 'openai-compatible', baseUrl: 'https://model.invalid', model: 'utility-model',
      hasCredential: true, credentialCiphertext: Buffer.from('ciphertext').toString('base64'),
      createdAt: nowForUtility(), updatedAt: nowForUtility()
    });
    const planGrant = await client.replacePermissionGrant({
      grantId: 'utility-plan-grant', serviceId: appService.id, policyVersion: '1',
      permissionMode: 'plan', scope: { tools: ['read', 'analyze', 'propose'] },
      grantedAt: nowForUtility()
    });
    if ((await client.listModelServices()).length !== 1
      || (await client.getActivePermissionGrant(appService.id, 'plan', '1'))?.grantId !== planGrant.grantId
      || await client.getActivePermissionGrant(appService.id, 'plan', 'future')) {
      throw new Error('Database utility app repository round trip failed.');
    }
    if (records.length !== 2 || !records.some((entry) => entry.opId === legacyRecord.opId)) {
      throw new Error('Database utility did not import and persist both operations.');
    }
    if (reopened?.status !== 'committed') {
      throw new Error('Database utility get did not return the committed operation.');
    }
    const targetPath = join(overlayRoot, 'journaled.txt');
    await writeFile(targetPath, 'before\n', 'utf8');
    const session = await openWorkspaceSession({ overlayRoot, game: 'sekiro' });
    const committed = await executePatchIrThroughTransaction(createPatchIr({
      workspaceId,
      title: 'utility journal commit',
      author: 'user',
      operations: [{
        id: 'utility-journal-edit', kind: 'text_edit', targetUri: 'file://journaled.txt',
        targetPath, newText: 'after\n', preconditions: [],
        validatorRequirements: [{ validatorId: 'text_file', scope: 'staged_output', required: true }],
        riskLevel: 'low'
      }]
    }), { session, operationLog: client });
    if (!committed.operation) throw new Error(`Journaled commit failed: ${JSON.stringify(committed.diagnostics)}`);
    const now = new Date().toISOString();
    await client.createTransaction({
      transactionId: 'utility-tx', opId: direct.opId, phase: 'pending',
      state: { checkpoint: 0 }, createdAt: now, updatedAt: now
    });
    await client.transitionTransaction({
      transactionId: 'utility-tx', expectedPhase: 'pending', nextPhase: 'staging',
      state: { checkpoint: 1 }
    });
    await client.recordRecoveryPoint({
      recoveryId: 'utility-recovery', opId: direct.opId, rootPath: join(root, 'recovery'),
      sizeBytes: 0, state: 'active', createdAt: now, metadata: { reason: 'smoke' }
    });
    await client.appendAuditEvent({
      eventId: 'utility-audit', eventKind: 'transaction.phase_changed', opId: direct.opId,
      transactionId: 'utility-tx', payload: { to: 'staging' }, createdAt: now
    });
    const incomplete = await client.listIncompleteTransactions();
    const recoveries = await client.listRecoveryPoints();
    const audits = await client.listAuditEvents();
    if (!incomplete.some((item) => item.transactionId === 'utility-tx')
      || !recoveries.some((item) => item.recoveryId === 'utility-recovery')
      || !recoveries.some((item) => item.recoveryId === committed.operation?.transactionId)
      || !audits.some((item) => item.eventId === 'utility-audit')
      || !audits.some((item) => item.transactionId === committed.operation?.transactionId)) {
      throw new Error('Database utility durable repository round trip failed.');
    }
    const cleanupPlan = await client.planRecoveryCleanup({
      now: '2026-07-11T00:00:00.000Z', maxAgeDays: 30, maxBytes: 10 * 1024 * 1024 * 1024
    });
    if (!cleanupPlan.protectedRecoveryIds.includes('utility-recovery')) {
      throw new Error('Recovery cleanup plan did not protect an incomplete transaction.');
    }
    const backupRoot = join(root, 'backups');
    const oldRecoveryRoot = join(backupRoot, 'old-recovery');
    const outsideRoot = join(root, 'outside-recovery');
    const escapeRoot = join(backupRoot, 'escape-recovery');
    await mkdir(oldRecoveryRoot, { recursive: true });
    await writeFile(join(oldRecoveryRoot, 'restore-point.json'), '{}');
    await mkdir(outsideRoot, { recursive: true });
    await mkdir(backupRoot, { recursive: true });
    await symlink(outsideRoot, escapeRoot, process.platform === 'win32' ? 'junction' : 'dir');
    for (const [recoveryId, rootPath] of [
      ['utility-old-recovery', oldRecoveryRoot],
      ['utility-escape-recovery', escapeRoot]
    ] as const) {
      await client.recordRecoveryPoint({
        recoveryId, opId: legacyRecord.opId, rootPath, sizeBytes: 1, state: 'active',
        createdAt: '2020-01-01T00:00:00.000Z', metadata: {}
      });
    }
    const deletionPlan = await client.planRecoveryCleanup({
      now: '2026-07-11T00:00:00.000Z', maxAgeDays: 30, maxBytes: 1024
    });
    const cleanupResult = await executeRecoveryCleanup({
      plan: deletionPlan,
      allowedRoots: [backupRoot, join(root, 'recovery')],
      store: client
    });
    if (!cleanupResult.deletedRecoveryIds.includes('utility-old-recovery')
      || !cleanupResult.rejected.some((item) => item.recoveryId === 'utility-escape-recovery')
      || await exists(oldRecoveryRoot)) {
      throw new Error('Recovery cleanup boundary or deletion result failed.');
    }
    await client.replaceFiles([{
      id: 'utility-file', workspaceId, sourceUri: 'file://event/test.emevd.dcx',
      sourcePath: join(overlayRoot, 'event', 'test.emevd.dcx'),
      absolutePath: join(overlayRoot, 'event', 'test.emevd.dcx'),
      relativePath: 'event/test.emevd.dcx', game: 'sekiro', resourceKind: 'event',
      extension: '.dcx', compoundExtension: '.emevd.dcx', formatKind: 'emevd',
      formatLabel: 'EMEVD', size: 16, mtimeMs: 1, parseStatus: 'partial', diagnostics: []
    }]);
    await client.replaceDiagnostics([{
      id: 'utility-diagnostic', severity: 'warning', code: 'PARSE_PARTIAL',
      message: '部分解析', createdAt: now, suppressed: false
    }]);
    await client.upsertJob({
      jobId: 'utility-job', title: '索引工作区', jobKind: 'workspace_index', status: 'completed',
      progress: { current: 1, total: 1 }, payload: {}, result: { indexed: 1 },
      createdAt: now, startedAt: now, completedAt: now, updatedAt: now
    });
    if ((await client.searchFiles('test EMEVD')).length !== 1
      || (await client.listDiagnostics())[0]?.code !== 'PARSE_PARTIAL'
      || (await client.listJobs())[0]?.status !== 'completed') {
      throw new Error('Database utility file/diagnostic/job repository round trip failed.');
    }
    await client.restart();
    const restartedHealth = await client.health();
    if (!restartedHealth.ready
      || !(await client.listAuditEvents()).some((item) => item.transactionId === committed.operation?.transactionId)
      || (await client.searchFiles('test')).length !== 1
      || (await client.listJobs()).length !== 1
      || (await client.listModelServices())[0]?.id !== appService.id
      || (await client.getActivePermissionGrant(appService.id, 'plan', '1'))?.grantId !== planGrant.grantId) {
      throw new Error('Database utility restart did not reopen durable state.');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      message: 'Electron utility process SQLite smoke passed',
      records: records.map((entry) => entry.opId),
      health,
      durableRepositories: true,
      indexRepositories: true,
      appRepositories: true,
      forcedRestart: true
    }, null, 2)}\n`);
    await client.dispose();
    app.exit(0);
  } catch (error) {
    await client.dispose();
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    app.exit(1);
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});

function nowForUtility(): string {
  return '2026-07-15T00:00:00.000Z';
}

function makeRecord(workspaceId: string, opId: string): OperationLogRecord {
  const now = new Date().toISOString();
  return {
    opId,
    workspaceId,
    title: opId,
    author: 'user',
    mode: 'normal',
    status: 'committed',
    createdAt: now,
    committedAt: now,
    backupRoot: `backup://${opId}`,
    files: [],
    diagnostics: []
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
