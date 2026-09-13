import { app } from 'electron';
import { access, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationLogRecord, RagChunk } from '@soulforge/shared';
import { OperationLogUtilityClient } from './operationLogUtilityClient.js';
import { executeRecoveryCleanup } from './recoveryCleanup.js';
import {
  createRagCorpus,
  createPatchIr,
  executePatchIrThroughTransaction,
  openWorkspaceSession,
  type RagChunkDeltaStats
} from '@soulforge/core';
import { persistRagCorpusBySourceDelta } from './ragPersistence.js';
import {
  createSemanticRefreshTelemetry,
  type SemanticRefreshTelemetrySnapshot
} from './semanticRefreshTelemetry.js';

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
    const appDatabasePath = join(root, 'app.db');
    await client.openAppDatabase(appDatabasePath);
    const appOnlyHealth = await client.health();
    if (appOnlyHealth.ready || !appOnlyHealth.appReady) {
      throw new Error('Database utility app-only health handshake failed.');
    }
    await client.recordProviderUsage({
      eventId: 'usage-session-1:1',
      sessionId: 'usage-session-1',
      serviceId: 'service-a',
      protocol: 'openai-responses',
      model: 'model-a',
      callIndex: 1,
      inputTokens: 120,
      outputTokens: 30,
      currentContextTokens: 120,
      contextSource: 'provider',
      providerReported: true,
      recordedAt: '2026-08-23T00:00:00.000Z'
    });
    await client.openWorkspace({
      appDatabasePath,
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
    await access(appDatabasePath);
    await client.recordProviderUsage({
      eventId: 'usage-session-1:2',
      sessionId: 'usage-session-1',
      serviceId: 'service-a',
      protocol: 'openai-responses',
      model: 'model-a',
      callIndex: 2,
      inputTokens: 180,
      outputTokens: 40,
      currentContextTokens: 180,
      contextSource: 'provider',
      providerReported: true,
      recordedAt: '2026-08-23T00:00:01.000Z'
    });
    // Idempotent replay must not double count the same provider request.
    await client.recordProviderUsage({
      eventId: 'usage-session-1:2',
      sessionId: 'usage-session-1',
      serviceId: 'service-a',
      protocol: 'openai-responses',
      model: 'model-a',
      callIndex: 2,
      inputTokens: 180,
      outputTokens: 40,
      currentContextTokens: 180,
      contextSource: 'provider',
      providerReported: true,
      recordedAt: '2026-08-23T00:00:01.000Z'
    });
    const usage = await client.providerUsageSummary();
    if (usage.calls !== 2 || usage.reportedCalls !== 2
      || usage.totalInputTokens !== 300 || usage.totalOutputTokens !== 70
      || usage.latestSession?.currentContextTokens !== 180
      || usage.byService[0]?.serviceId !== 'service-a') {
      throw new Error(`Database utility provider usage summary failed: ${JSON.stringify(usage)}`);
    }
    const direct = makeRecord(workspaceId, 'direct-op');
    await client.record(direct);
    const records = await client.list(workspaceId);
    const reopened = await client.get(direct.opId);
    if (!health.ready || !health.appReady || health.workspaceId !== workspaceId) {
      throw new Error('Database utility health handshake failed.');
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
        validatorRequirements: [{ validatorId: 'text_non_empty', scope: 'staged_output', required: true }],
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
    const utilityChunk: RagChunk = {
      chunkId: 'rag:file:utility',
      workspaceId,
      sourceUri: 'file://event/test.emevd.dcx',
      symbolUri: 'file://event/test.emevd.dcx',
      family: 'file',
      title: 'event/test.emevd.dcx',
      body: 'path event/test.emevd.dcx kind event',
      numericIds: [],
      contentHash: 'utility-rag',
      relativePath: 'event/test.emevd.dcx',
      resourceKind: 'event'
    };
    await client.replaceRagChunks([utilityChunk]);

    const metadataChunk = {
      ...utilityChunk,
      sourceRevision: 1,
      sourceHash: 'utility-source-v1',
      outerFileHash: 'utility-outer-v1'
    };
    const metadataStats = await client.mergeRagChunkDelta({
      sourceUri: utilityChunk.sourceUri,
      upserts: [metadataChunk],
      deletedChunkIds: []
    });
    assertRagChunkDeltaStats(metadataStats, {
      finalUpserts: 1,
      newUpserts: 0,
      bodyChangedUpserts: 0,
      metadataOnlyUpserts: 1,
      ftsRebuilds: 0,
      embeddingDeletes: 1
    });

    const bodyChunk = {
      ...metadataChunk,
      body: `${metadataChunk.body} utility-body-change`,
      contentHash: 'utility-rag-body'
    };
    const bodyStats = await client.mergeRagChunkDelta({
      sourceUri: utilityChunk.sourceUri,
      upserts: [bodyChunk],
      deletedChunkIds: []
    });
    assertRagChunkDeltaStats(bodyStats, {
      finalUpserts: 1,
      newUpserts: 0,
      bodyChangedUpserts: 1,
      metadataOnlyUpserts: 0,
      ftsRebuilds: 1,
      embeddingDeletes: 1
    });

    const seededChunk: RagChunk = {
      ...metadataChunk,
      chunkId: 'rag:file:utility-seeded',
      symbolUri: 'file://event/test.emevd.dcx#seeded',
      title: 'event/test.emevd.dcx seeded',
      body: 'seeded utility body',
      contentHash: 'utility-rag-seeded'
    };
    const seededStats = await client.mergeRagChunkDelta({
      sourceUri: utilityChunk.sourceUri,
      upserts: [seededChunk],
      deletedChunkIds: []
    });
    assertRagChunkDeltaStats(seededStats, {
      finalUpserts: 1,
      newUpserts: 1,
      bodyChangedUpserts: 0,
      metadataOnlyUpserts: 0,
      ftsRebuilds: 1,
      embeddingDeletes: 0
    });

    const refreshState: { snapshot: SemanticRefreshTelemetrySnapshot | null } = { snapshot: null };
    const refreshTelemetry = createSemanticRefreshTelemetry('postcommit', (snapshot) => {
      refreshState.snapshot = snapshot;
    });
    const aggregatePrevious = createRagCorpus({
      workspaceId,
      builtAt: now,
      chunks: [bodyChunk, seededChunk],
      references: []
    });
    const aggregateNext = createRagCorpus({
      workspaceId,
      builtAt: now,
      chunks: [
        {
          ...bodyChunk,
          body: `${bodyChunk.body} aggregate-body-change`,
          contentHash: 'utility-rag-body-v2'
        },
        {
          ...seededChunk,
          sourceRevision: 2,
          sourceHash: 'utility-source-v2',
          outerFileHash: 'utility-outer-v2'
        },
        {
          ...utilityChunk,
          chunkId: 'rag:file:utility-new',
          symbolUri: 'file://event/test.emevd.dcx#new',
          title: 'event/test.emevd.dcx new',
          body: 'new utility body',
          contentHash: 'utility-rag-new'
        }
      ],
      references: []
    });
    await persistRagCorpusBySourceDelta(
      client,
      aggregateNext,
      aggregatePrevious,
      undefined,
      refreshTelemetry
    );
    refreshTelemetry.finish('completed');
    const aggregateStats = refreshState.snapshot?.stages.persistBatch;
    assertRagChunkDeltaStats({
      finalUpserts: aggregateStats?.finalUpserts ?? Number.NaN,
      newUpserts: aggregateStats?.newUpserts ?? Number.NaN,
      bodyChangedUpserts: aggregateStats?.bodyChangedUpserts ?? Number.NaN,
      metadataOnlyUpserts: aggregateStats?.metadataOnlyUpserts ?? Number.NaN,
      ftsRebuilds: aggregateStats?.ftsRebuilds ?? Number.NaN,
      embeddingDeletes: aggregateStats?.embeddingDeletes ?? Number.NaN
    }, {
      finalUpserts: 3,
      newUpserts: 1,
      bodyChangedUpserts: 1,
      metadataOnlyUpserts: 1,
      ftsRebuilds: 2,
      embeddingDeletes: 2
    });
    const unavailableState: { snapshot: SemanticRefreshTelemetrySnapshot | null } = { snapshot: null };
    const unavailableTelemetry = createSemanticRefreshTelemetry('postcommit', (snapshot) => {
      unavailableState.snapshot = snapshot;
    });
    await persistRagCorpusBySourceDelta(
      {
        mergeRagChunkDelta: async () => null,
        replaceReferences: async () => undefined
      },
      aggregateNext,
      aggregatePrevious,
      undefined,
      unavailableTelemetry
    );
    unavailableTelemetry.finish('completed');
    const unavailableStats = unavailableState.snapshot?.stages.persistBatch;
    if (!unavailableStats?.ragStatsUnavailable || unavailableStats.finalUpserts !== undefined) {
      throw new Error('缺失 RAG delta stats 未显式标记 unavailable。');
    }
    await client.upsertSemanticFileCache({
      relativePath: 'event/test.emevd.dcx',
      fileSha256: 'sha-test-123',
      resourceKind: 'event',
      payload: {
        events: [
          {
            events: [
              {
                uri: 'event://file://event/test.emevd.dcx/100',
                sourceUri: 'file://event/test.emevd.dcx',
                eventId: 100,
                instructions: []
              }
            ]
          }
        ]
      },
      mtimeMs: 1
    });
    const cacheMap = await client.getAllSemanticFileCache();
    if (!cacheMap.has('event/test.emevd.dcx') || cacheMap.get('event/test.emevd.dcx')?.fileSha256 !== 'sha-test-123') {
      throw new Error('Database utility semantic file cache round trip failed.');
    }
    const singleCache = await client.getSemanticFileCache('event/test.emevd.dcx');
    if (!singleCache || singleCache.fileSha256 !== 'sha-test-123' || !singleCache.payload.events?.length) {
      throw new Error('Database utility single semantic file cache round trip failed.');
    }
    const missingCache = await client.getSemanticFileCache('non/existent/file.dcx');
    if (missingCache !== null) {
      throw new Error('Database utility missing semantic file cache should return null.');
    }
    if ((await client.searchFiles('test EMEVD')).length !== 1
      || (await client.searchRagChunks('seeded', 8)).length !== 1
      || (await client.listDiagnostics())[0]?.code !== 'PARSE_PARTIAL'
      || (await client.listJobs())[0]?.status !== 'completed') {
      throw new Error('Database utility file/diagnostic/job/rag repository round trip failed.');
    }
    await client.restart();
    const restartedHealth = await client.health();
    if (!restartedHealth.ready
      || !(await client.listAuditEvents()).some((item) => item.transactionId === committed.operation?.transactionId)
      || (await client.searchFiles('test')).length !== 1
      || (await client.listJobs()).length !== 1) {
      throw new Error('Database utility restart did not reopen durable state.');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      message: 'Electron utility process SQLite smoke passed',
      records: records.map((entry) => entry.opId),
      health,
      durableRepositories: true,
      indexRepositories: true,
      providerUsage: usage,
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

const RAG_DELTA_STAT_KEYS: readonly (keyof RagChunkDeltaStats)[] = [
  'finalUpserts',
  'newUpserts',
  'bodyChangedUpserts',
  'metadataOnlyUpserts',
  'ftsRebuilds',
  'embeddingDeletes'
];

function assertRagChunkDeltaStats(
  value: unknown,
  expected: Partial<RagChunkDeltaStats>
): asserts value is RagChunkDeltaStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Database utility RAG delta stats 缺失，不能把缺失结果归零。');
  }
  const stats = value as Record<string, unknown>;
  const actualKeys = Object.keys(stats).sort();
  const expectedKeys = [...RAG_DELTA_STAT_KEYS].sort();
  if (actualKeys.join(',') !== expectedKeys.join(',')) {
    throw new Error(`Database utility RAG delta stats keys 不完整或包含额外字段：${actualKeys.join(',')}`);
  }
  for (const key of RAG_DELTA_STAT_KEYS) {
    const stat = stats[key];
    if (typeof stat !== 'number' || !Number.isSafeInteger(stat) || stat < 0 || stat > 512) {
      throw new Error(`Database utility RAG delta stats ${key} 不是有限非负整数：${String(stat)}`);
    }
  }
  const finalUpserts = stats.finalUpserts as number;
  const metadataOnlyUpserts = stats.metadataOnlyUpserts as number;
  const ftsRebuilds = stats.ftsRebuilds as number;
  const newUpserts = stats.newUpserts as number;
  const bodyChangedUpserts = stats.bodyChangedUpserts as number;
  const embeddingDeletes = stats.embeddingDeletes as number;
  if (metadataOnlyUpserts + ftsRebuilds !== finalUpserts
    || newUpserts + embeddingDeletes !== finalUpserts
    || bodyChangedUpserts > ftsRebuilds - newUpserts) {
    throw new Error('Database utility RAG delta stats 分类不守恒。');
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (stats[key] !== expectedValue) {
      throw new Error(`Database utility RAG delta stats ${key} 不符合预期：${String(stats[key])} != ${String(expectedValue)}`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
