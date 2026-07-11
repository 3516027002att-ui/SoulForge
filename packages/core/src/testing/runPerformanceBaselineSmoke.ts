/**
 * Lightweight performance baselines for V0.5 (not full product benchmarks).
 * Fails only on extreme regressions so CI stays deterministic.
 */
import { performance } from 'node:perf_hooks';
import { createEmevdEditorDocument, applyEmevdEditorMutation, buildFourViewState } from '../editing/emevdFourViewController.js';
import { encodeRawRgba8ToDds } from '../assets/pngToDds.js';
import { buildMsbSceneManifest } from '../scene/msbSceneManifest.js';
import { buildSceneAssetInventory } from '../scene/sceneAssetInventory.js';
import { TaskQueue } from '../jobs/taskQueue.js';

const LIMITS = {
  emevdMutationMs: 50,
  ddsEncodeMs: 200,
  sceneManifestMs: 300,
  inventoryMs: 300,
  taskQueueRoundtripMs: 500
};

async function main(): Promise<void> {
  const results: Array<{ name: string; ms: number; limit: number; ok: boolean }> = [];

  {
    const events = Array.from({ length: 200 }, (_, i) => ({
      eventId: i,
      restBehavior: 0,
      instructions: [
        { bank: 2000, id: 0, argsBase64: '', unknown: true },
        { bank: 1000, id: 1, argsBase64: 'AAAA', unknown: true }
      ]
    }));
    let doc = createEmevdEditorDocument({
      resourceUri: 'file://event/perf.emevd',
      events
    });
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) {
      const result = applyEmevdEditorMutation(doc, {
        kind: 'emevd_set_rest_behavior',
        eventUri: doc.events[i % doc.events.length]!.eventUri,
        restBehavior: i % 3,
        baseRevision: doc.revision
      });
      if (!result.ok) throw new Error(result.message);
      doc = result.document;
      buildFourViewState(doc, { view: 'table', eventUri: doc.events[0]!.eventUri });
    }
    const ms = performance.now() - t0;
    results.push({ name: 'emevd-four-view-mutations', ms, limit: LIMITS.emevdMutationMs, ok: ms < LIMITS.emevdMutationMs });
  }

  {
    const rgba = Buffer.alloc(64 * 64 * 4, 0x7f);
    const t0 = performance.now();
    const encoded = encodeRawRgba8ToDds({ width: 64, height: 64, rgba });
    if (!encoded.dds.subarray(0, 4).equals(Buffer.from('DDS '))) throw new Error('dds magic');
    const ms = performance.now() - t0;
    results.push({ name: 'dds-encode-64', ms, limit: LIMITS.ddsEncodeMs, ok: ms < LIMITS.ddsEncodeMs });
  }

  {
    const parts = Array.from({ length: 2000 }, (_, i) => ({
      name: `m000010_${i}`,
      posX: i * 0.1,
      posY: 0,
      posZ: i * -0.05
    }));
    const t0 = performance.now();
    const manifest = buildMsbSceneManifest({
      mapResourceUri: 'file://map/perf.msb',
      parts
    });
    const ms = performance.now() - t0;
    results.push({
      name: 'scene-manifest-2k',
      ms,
      limit: LIMITS.sceneManifestMs,
      ok: ms < LIMITS.sceneManifestMs && manifest.nodeCount === 2000
    });

    const t1 = performance.now();
    const inv = buildSceneAssetInventory(manifest);
    const invMs = performance.now() - t1;
    results.push({
      name: 'scene-inventory-2k',
      ms: invMs,
      limit: LIMITS.inventoryMs,
      ok: invMs < LIMITS.inventoryMs && inv.partCount === 2000
    });
  }

  {
    const queue = new TaskQueue({ concurrency: 2 });
    const t0 = performance.now();
    const tasks = Array.from({ length: 8 }, (_, i) =>
      queue.enqueue(`job-${i}`, async (ctx) => {
        ctx.reportProgress({ current: 1, total: 1 });
        return i;
      })
    );
    await Promise.all(tasks.map((t) => t.promise));
    const ms = performance.now() - t0;
    results.push({
      name: 'task-queue-8',
      ms,
      limit: LIMITS.taskQueueRoundtripMs,
      ok: ms < LIMITS.taskQueueRoundtripMs
    });
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(JSON.stringify({ ok: false, failed, results }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    message: '性能基线 smoke 通过（宽松阈值，非完整产品基准）',
    results: results.map((r) => ({
      name: r.name,
      ms: Number(r.ms.toFixed(2)),
      limit: r.limit
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
