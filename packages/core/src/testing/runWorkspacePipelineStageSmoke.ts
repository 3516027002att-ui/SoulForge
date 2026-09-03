import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeWorkspace } from '../pipeline/workspacePipeline.js';

/**
 * Verifies the staged semantic publish contract without a native fixture:
 * PARAM must be published before the later EVENT/MAP candidates, and the
 * final result must still contain every parsed semantic family.
 */
const root = await mkdtemp(join(tmpdir(), 'soulforge-pipeline-stage-'));
try {
  await Promise.all([
    mkdir(join(root, 'param'), { recursive: true }),
    mkdir(join(root, 'event'), { recursive: true }),
    mkdir(join(root, 'map'), { recursive: true })
  ]);
  await writeFile(
    join(root, 'param', 'mockparam.json'),
    JSON.stringify({
      paramName: 'NpcParam',
      rows: [{ rowId: 50800000, rowName: '鬼刑部', fields: [{ id: 'npcType', value: 1 }] }]
    }),
    'utf8'
  );
  await writeFile(
    join(root, 'event', 'mockevent.json'),
    JSON.stringify({ mapId: 'm10_00_00_00', events: [{ eventId: 100, instructions: [] }] }),
    'utf8'
  );
  await writeFile(
    join(root, 'map', 'mockmap.json'),
    JSON.stringify({
      mapId: 'm10_00_00_00',
      entities: [{ id: 1, name: '鬼刑部', kind: 'part' }],
      regions: []
    }),
    'utf8'
  );

  const stages: Array<{ parsedFiles: number; total: number; stats: ReturnType<Awaited<ReturnType<typeof analyzeWorkspace>>['index']['getStats']> }> = [];
  const result = await analyzeWorkspace({
    workspaceRoot: root,
    inspectNativeResources: false,
    maxFilesToParse: 3,
    onSemanticIndexReady: ({ index, parsedFiles, total }) => {
      stages.push({ parsedFiles, total, stats: index.getStats() });
    }
  });

  assert.equal(stages.length, 1, 'semantic stage must be published exactly once');
  assert.equal(stages[0]?.parsedFiles, 1, 'PARAM must be the first accepted semantic file');
  assert.equal(stages[0]?.total, 3, 'all three JSON semantic candidates must remain scheduled');
  assert.equal(stages[0]?.stats.paramRows, 1, 'staged index must expose the PARAM row');
  assert.equal(stages[0]?.stats.events, 0, 'EVENT must not precede the PARAM stage');
  assert.equal(stages[0]?.stats.mapEntities, 0, 'MAP must not precede the PARAM stage');
  assert.equal(result.index.getStats().events, 1, 'final index must retain the EVENT export');
  assert.equal(result.index.getStats().mapEntities, 1, 'final index must retain the MAP export');
  assert.equal(result.index.getStats().paramRows, 1, 'final index must retain the PARAM export');
  console.log('[workspace-pipeline-stage-smoke] staged PARAM publish and final semantic convergence passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
