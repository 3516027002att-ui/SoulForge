/**
 * Workbench projections: jobs / history / patch impact / diagnostics.
 */
import { TaskQueue } from '../jobs/taskQueue.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';
import {
  projectDiagnostics,
  projectHistory,
  projectJobs,
  projectPatchImpact
} from '../editing/workbenchProjections.js';
import { PATCH_IR_SCHEMA_VERSION } from '@soulforge/shared';
import type { PatchHistoryEntry, PatchIR, StructuredDiagnostic } from '@soulforge/shared';

async function main(): Promise<void> {
  const queue = new TaskQueue({ concurrency: 1 });
  const job = queue.enqueue('索引工作区', async (ctx) => {
    ctx.reportProgress({ current: 1, total: 2, message: '扫描' });
    return 'ok';
  });
  await job.promise;
  const jobs = projectJobs(queue.list());
  if (jobs.length !== 1 || jobs[0]!.status !== 'completed') {
    throw new Error('job projection failed');
  }

  const history: PatchHistoryEntry[] = [{
    opId: 'op-1',
    workspaceId: 'ws-demo',
    title: '替换 FMG 条目',
    author: 'user',
    mode: 'normal',
    status: 'committed',
    createdAt: new Date().toISOString(),
    fileCount: 1,
    changedPaths: ['msg/item.fmg']
  }];
  const hist = projectHistory(history);
  if (hist[0]?.canRollback !== true || hist[0].fileCount !== 1) {
    throw new Error('history projection failed');
  }

  const graph = new MemoryResourceGraph('ws-demo');
  const fmg = graph.addNode({
    id: 'n-fmg',
    uri: 'file://msg/item.fmg',
    kind: 'resource',
    label: 'item.fmg',
    resourceKind: 'msg'
  });
  const event = graph.addNode({
    id: 'n-event',
    uri: 'file://event/common.emevd',
    kind: 'resource',
    label: 'common.emevd',
    resourceKind: 'event'
  });
  graph.addEdge({
    id: 'e-1',
    fromId: event.id,
    toId: fmg.id,
    kind: 'references',
    confidence: {
      level: 'high',
      score: 0.9,
      reasons: [{ code: 'parser_confirmed', message: 'synthetic edge' }]
    }
  });

  const patch: PatchIR = {
    schemaVersion: PATCH_IR_SCHEMA_VERSION,
    patchId: 'patch-1',
    workspaceId: 'ws-demo',
    title: 'demo',
    author: 'user',
    createdAt: new Date().toISOString(),
    riskLevel: 'medium',
    affectedResources: ['file://msg/item.fmg'],
    operations: [{
      id: 'o1',
      kind: 'file_replace',
      targetUri: 'file://msg/item.fmg',
      preconditions: [],
      validatorRequirements: [{
        validatorId: 'fmg-roundtrip',
        scope: 'after_commit',
        required: true
      }],
      riskLevel: 'medium'
    }]
  };
  const impact = projectPatchImpact(patch, graph);
  if (!impact.changedResources.includes('file://msg/item.fmg')) {
    throw new Error('impact missing changed resource');
  }
  if (impact.validatorsToRun.length === 0) {
    throw new Error('impact missing validators');
  }

  const diags: StructuredDiagnostic[] = [{
    severity: 'warning',
    code: 'DEMO_WARN',
    message: '示例诊断',
    targetUri: 'file://msg/item.fmg'
  }];
  const projected = projectDiagnostics(diags);
  if (projected[0]?.code !== 'DEMO_WARN') {
    throw new Error('diagnostics projection failed');
  }

  const store = new MemoryOperationLogStore();
  if (typeof store.history !== 'function') {
    throw new Error('operation log missing history');
  }

  console.log(JSON.stringify({
    ok: true,
    message: '工作台 jobs/history/patch-impact/diagnostics 投影验证通过',
    jobs: jobs.length,
    history: hist.length,
    impactResources: impact.changedResources.length,
    reverseRefs: impact.reverseReferenceImpact.length,
    confirmedEdges: impact.confirmedEdgeCount
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
