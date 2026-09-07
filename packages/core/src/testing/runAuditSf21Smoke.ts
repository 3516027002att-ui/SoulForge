import { strict as assert } from 'node:assert';
import { effectForTool, runScheduledTools } from '../model-services/toolScheduler.js';

async function main(): Promise<void> {
  const ended: string[] = [];
  const result = await runScheduledTools([
    { id: 'slow', effect: effectForTool('read_resource', { sourceUri: 'a' }), run: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: true, value: 1 }; } },
    { id: 'fast', effect: effectForTool('read_resource', { sourceUri: 'b' }), run: () => ({ ok: true, value: 2 }) },
    { id: 'fail', effect: effectForTool('read_resource', { sourceUri: 'c' }), run: () => { throw Object.assign(new Error('boom'), { code: 'EXPECTED_THROW' }); } },
    { id: 'dependent', dependsOn: ['fail'], effect: effectForTool('read_resource', { sourceUri: 'd' }), run: () => ({ ok: true, value: 4 }) }
  ], { concurrency: 2, onEnd: ({ id }) => { ended.push(id); if (id === 'fast') throw new Error('observer failure'); } });
  assert.equal(result.results.length, 4);
  assert.equal(result.results[2]!.ok, false);
  assert.equal(result.results[3]!.ok, false);
  assert(result.notificationErrors.length === 1);
  assert(result.maxActive <= 2);
  assert(ended.includes('fast'));

  const cancelled = await runScheduledTools([
    { id: 'a', effect: { reads: [], writes: ['x'] }, run: () => ({ ok: true }) },
    { id: 'b', dependsOn: ['a'], effect: { reads: ['x'], writes: [] }, run: () => ({ ok: true }) }
  ], { signal: AbortSignal.abort() });
  assert.deepEqual(cancelled.results.map((result) => result?.ok ? 'ok' : result?.code), [
    'CANCELLED_BEFORE_START',
    'CANCELLED_BEFORE_START'
  ]);

  await assert.rejects(() => runScheduledTools([
    { id: 'a', dependsOn: ['b'], effect: { reads: [], writes: [] }, run: () => ({ ok: true }) },
    { id: 'b', dependsOn: ['a'], effect: { reads: [], writes: [] }, run: () => ({ ok: true }) }
  ]), /DEPENDENCY_CYCLE/);
  await assert.rejects(() => runScheduledTools(new Array(33).fill(null).map((_, index) => ({ id: String(index), effect: { reads: [], writes: [] }, run: () => ({ ok: true }) }))));
  console.log(JSON.stringify({ ok: true, taskId: 'SF-21', layer: process.argv.includes('--layer') ? process.argv[process.argv.indexOf('--layer') + 1] : 'unit', executedCases: 9, production: ['runScheduledTools', 'effectForTool'], message: '工具冲突DAG、结果结算、取消、依赖失败与observer异常通过' }));
}

void main();
