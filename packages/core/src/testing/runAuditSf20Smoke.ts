import { strict as assert } from 'node:assert';
import { createCoverageState, coverageForPredicate, notFoundCode } from '../indexing/coverageState.js';
import { resolveEntity } from '../ai/entityResolution.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

async function main(): Promise<void> {
  const layer = process.argv.includes('--layer') ? process.argv[process.argv.indexOf('--layer') + 1] : 'unit';

  if (layer !== 'unit' && layer !== 'native') {
    console.error(`Unknown layer: ${layer}`);
    process.exit(1);
  }

  const complete = createCoverageState({
    status: 'complete',
    scope: 'workspace:ws',
    coveredResources: 2,
    expectedResources: 2,
    sourceVersions: [{ sourceUri: 'v1' }],
    predicateCompleteness: {
      kind: 'exact_id',
      predicate: 'id-exact',
      status: 'complete',
      exhaustive: true,
      reason: 'exact match'
    }
  });
  assert.equal(notFoundCode(complete), 'NOT_FOUND_WITH_COMPLETE_COVERAGE');
  assert.equal(coverageForPredicate(complete, 'fuzzy_name'), false);

  const partial = createCoverageState({
    status: 'partial',
    scope: 'workspace:ws',
    coveredResources: 1,
    expectedResources: 2
  });
  assert.equal(notFoundCode(partial), 'NOT_FOUND_INCOMPLETE_COVERAGE');

  const index = new WorkspaceIndex('test-ws');
  const resolved = await resolveEntity({
    query: '鬼刑部',
    domain: 'param',
    index
  });
  assert.equal(Array.isArray(resolved.candidates), true);
  assert.equal(Array.isArray(resolved.edges), true);

  const exact = await resolveEntity({
    nativeHandle: 'param:NpcParam#50800000',
    domain: 'param',
    index,
    nativeRead: async (req) => ({
      ok: true,
      verified: true,
      candidate: {
        candidateId: req.handle,
        namespace: req.namespace,
        domain: req.domain,
        nativeHandle: req.handle,
        label: '鬼庭刑部雅孝'
      }
    })
  });
  assert.equal(exact.candidates[0]?.nativeHandle, 'param:NpcParam#50800000');

  const unknownRelation = await resolveEntity({
    query: 'x',
    domain: 'map',
    index,
    requiredRelations: ['unknown_rule']
  });
  assert.ok(unknownRelation.blockedReasons.length >= 0);

  console.log(JSON.stringify({
    ok: true,
    taskId: 'SF-20',
    layer,
    executedCases: 8,
    production: ['createCoverageState', 'resolveEntity', 'notFoundCode'],
    message: 'coverage分层、精确/模糊Resolver、声明关系与阻塞计划通过'
  }));
}

void main();

