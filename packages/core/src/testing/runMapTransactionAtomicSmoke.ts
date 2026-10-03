import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, copyFile, realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { type MapEditTransaction } from '@soulforge/shared';
import { executeMapTransaction, loadMapDocument } from '../editing/mapService.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { nativeEditSessionFromContext } from '../editing/nativeEditSession.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

export async function runMapTransactionAtomicSmoke(): Promise<void> {
  const explicitSource = process.argv[2]?.trim();
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const registry = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  const unavailable = (code: string) => console.log(JSON.stringify({
    ok: false, status: 'skipped', executed: false, authority: 'unverified', code,
    scope: 'native MAP atomic transactions',
    message: 'Native checks were not executed. Configure an explicit MSB path, SOULFORGE_SEKIRO_GAME_ROOT, or SOULFORGE_NATIVE_FIXTURE_REGISTRY with SOULFORGE_NATIVE_FIXTURE_ROOT.'
  }));
  if (!explicitSource && !gameRoot && !registry && !fixtureRoot) {
    unavailable('NATIVE_MAP_INPUT_REQUIRED');
    return;
  }
  if (!explicitSource && Boolean(registry) !== Boolean(fixtureRoot)) throw new Error('NATIVE_FIXTURE_CONFIG_INCOMPLETE');
  let sourceOriginal: string;
  try {
    sourceOriginal = await realpath(await resolveNativeFixture(
      explicitSource ?? (!registry && gameRoot ? join(gameRoot, 'mods/map/mapstudio/m10_00_00_00.msb.dcx') : undefined),
      'msb-primary', '../../mods/map/mapstudio/m10_00_00_00.msb.dcx'
    ));
    if (!(await stat(sourceOriginal)).isFile()) throw new Error('NATIVE_MAP_SOURCE_NOT_FILE');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      unavailable('NATIVE_MAP_SOURCE_UNAVAILABLE');
      return;
    }
    throw error;
  }
  const oodleRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT?.trim() || gameRoot;
  console.log('[Smoke] Testing Atomic MapEditTransaction Invariants...');

  await withSmokeWorkspace('map-atomic-tx', async (workspace) => {
    const stagingRoot = join(workspace.root, 'staging');
    await mkdir(stagingRoot, { recursive: true });

    // Copy to workspace for isolated writeback
    const mapFile = join(workspace.root, 'm10_00_00_00.msb.dcx');
    await copyFile(sourceOriginal, mapFile);

    let commitCount = 0;
    const session = await openWorkspaceSession({
      overlayRoot: workspace.root, ...(oodleRoot ? { baseRoot: oodleRoot } : {}), game: 'sekiro'
    });
    const editSession = nativeEditSessionFromContext({
      session,
      operationLog: new MemoryOperationLogStore(),
      stagingRoot,
      backupBaseDir: join(workspace.root, 'backups'),
      recoveryDir: join(workspace.root, 'recovery')
    });
    const patchCommit = editSession.commitPort.commit.bind(editSession.commitPort);
    editSession.commitPort = {
      commit: async (request) => { commitCount++; return patchCommit(request); }
    };

    const loaded = await loadMapDocument(editSession, mapFile);
    assert.equal(loaded.ok, true, 'Must load map document');
    if (!loaded.ok) return;
    assert.ok(loaded.doc.parts.length >= 2, 'The explicit MSB must contain two parts for the atomic delete regression');
    const targetKey = loaded.doc.parts[0]!.stableKey;

    console.log('[Smoke] Case 1: Stale baseRevision rejected before commit...');
    const staleTx: MapEditTransaction = {
      id: 'tx-stale',
      mapId: loaded.doc.mapId,
      baseRevision: 'stale_hash_123',
      description: 'Stale revision test',
      author: 'agent',
      operations: [
        { kind: 'set_transform', target: targetKey, position: [0, 0, 0] }
      ],
      timestamp: Date.now()
    };

    const staleResult = await executeMapTransaction(editSession, mapFile, staleTx);
    assert.equal(staleResult.ok, false, 'Stale base revision must be rejected');
    assert.equal(staleResult.error?.code, 'MAP_TRANSACTION_VALIDATION_FAILED');
    assert.equal(commitCount, 0, 'Zero commits must occur on stale revision');

    console.log('[Smoke] Case 2: Unknown model rejected in preflight...');
    const invalidModelTx: MapEditTransaction = {
      id: 'tx-invalid-model',
      mapId: loaded.doc.mapId,
      baseRevision: loaded.doc.revision,
      description: 'Invalid model test',
      author: 'human',
      operations: [
        { kind: 'change_model', target: targetKey, newModelName: 'm_nonexistent_999999' }
      ],
      timestamp: Date.now()
    };
    const invalidModelResult = await executeMapTransaction(editSession, mapFile, invalidModelTx);
    assert.equal(invalidModelResult.ok, false, 'Unknown model must fail preflight validation');
    assert.equal(commitCount, 0, 'Zero commits on validation failure');

    console.log('[Smoke] Case 3: Unsupported property rejected in preflight...');
    const unsupportedPropTx: MapEditTransaction = {
      id: 'tx-unsupported-prop',
      mapId: loaded.doc.mapId,
      baseRevision: loaded.doc.revision,
      description: 'Unsupported property test',
      author: 'human',
      operations: [
        { kind: 'set_property', target: targetKey, property: 'unsupportedField', value: 123 }
      ],
      timestamp: Date.now()
    };
    const unsupportedPropResult = await executeMapTransaction(editSession, mapFile, unsupportedPropTx);
    assert.equal(unsupportedPropResult.ok, false, 'Unsupported property must fail preflight');
    assert.equal(commitCount, 0, 'Zero commits on unsupported property');

    console.log('[Smoke] Case 4: Sequential composition (delete target then use in subsequent op) fails preflight...');
    const invalidSeqTx: MapEditTransaction = {
      id: 'tx-invalid-seq',
      mapId: loaded.doc.mapId,
      baseRevision: loaded.doc.revision,
      description: 'Delete then transform',
      author: 'agent',
      operations: [
        { kind: 'delete', target: targetKey },
        { kind: 'set_transform', target: targetKey, position: [10, 20, 30] }
      ],
      timestamp: Date.now()
    };
    const invalidSeqResult = await executeMapTransaction(editSession, mapFile, invalidSeqTx);
    assert.equal(invalidSeqResult.ok, false, 'Transforming deleted target in same transaction must fail preflight');
    assert.equal(commitCount, 0, 'Zero commits on sequential violation');

    console.log('[Smoke] Case 5: Operation order (set_transform then batch delta) is applied sequentially...');
    const orderPart = loaded.doc.parts[0]!;
    const orderedTx: MapEditTransaction = {
      id: 'tx-ordered-transform',
      mapId: loaded.doc.mapId,
      baseRevision: loaded.doc.revision,
      description: 'Set then batch delta',
      author: 'agent',
      operations: [
        { kind: 'set_transform', target: orderPart.stableKey, position: [10, 20, 30] },
        { kind: 'batch_transform', targets: [orderPart.stableKey], positionDelta: [1, 0, 0] }
      ],
      timestamp: Date.now()
    };
    const orderedResult = await executeMapTransaction(editSession, mapFile, orderedTx);
    if (!orderedResult.ok) console.error('[Smoke] Case 5 failed with error:', JSON.stringify(orderedResult.error, null, 2));
    assert.equal(orderedResult.ok, true, 'set_transform followed by batch_transform must commit');
    assert.equal(commitCount, 1, 'Ordered transform must use one Patch Engine commit');
    const orderedReread = await loadMapDocument(editSession, mapFile);
    assert.equal(orderedReread.ok, true, 'Ordered transform must reread');
    if (!orderedReread.ok) return;
    const orderedPartAfter = orderedReread.sceneGraph.findEntity(orderPart.stableKey);
    assert.equal(orderedPartAfter?.kind, 'part');
    if (orderedPartAfter?.kind === 'part') {
      assert.deepEqual(orderedPartAfter.transform.position, [11, 20, 30], 'batch delta must observe the preceding set_transform result');
    }

    console.log('[Smoke] Case 6: Valid multi-op mixed transaction (batch transform + property update)...');
    const validMixedTx: MapEditTransaction = {
      id: 'tx-valid-mixed',
      mapId: orderedReread.doc.mapId,
      baseRevision: orderedReread.doc.revision,
      description: 'Batch transform + property update',
      author: 'agent',
      operations: [
        { kind: 'set_transform', target: orderPart.stableKey, position: [-25.0, -822.0, -18.0] },
        { kind: 'set_property', target: orderPart.stableKey, property: 'entityId', value: 1000999 }
      ],
      timestamp: Date.now()
    };
    const mixedResult = await executeMapTransaction(editSession, mapFile, validMixedTx);
    if (!mixedResult.ok) {
      console.error('[Smoke] Case 5 failed with error:', JSON.stringify(mixedResult.error, null, 2));
    }
    assert.equal(mixedResult.ok, true, 'Valid mixed transaction must succeed');
    assert.equal(commitCount, 2, 'Exact 2 commits must occur after the ordered and mixed transactions');

    console.log('[Smoke] Case 7: Multiple deletes in same family (testing batch offset table rebuild)...');
    const reread1 = await loadMapDocument(editSession, mapFile);
    assert.equal(reread1.ok, true);
    if (!reread1.ok) return;

    const deleteBatchTx: MapEditTransaction = {
      id: 'tx-delete-batch',
      mapId: reread1.doc.mapId,
      baseRevision: reread1.doc.revision,
      description: 'Delete 2 parts in one transaction',
      author: 'human',
      operations: [
        {
          kind: 'delete',
          target: orderPart.stableKey,
          certificate: {
            complete: true,
            scannedReferences: [],
            danglingReferences: [],
            timestamp: Date.now()
          }
        },
        {
          kind: 'delete',
          target: reread1.doc.parts[1]!.stableKey,
          certificate: {
            complete: true,
            scannedReferences: [],
            danglingReferences: [],
            timestamp: Date.now()
          }
        }
      ],
      timestamp: Date.now()
    };
    const deleteResult = await executeMapTransaction(editSession, mapFile, deleteBatchTx);
    if (!deleteResult.ok) {
      console.error('[Smoke] Case 6 failed with error:', JSON.stringify(deleteResult.error, null, 2));
    }
    assert.equal(deleteResult.ok, true, 'Batch delete must succeed and rebuild param tables without corruption');
    assert.equal(commitCount, 3, 'Exact 3 commits after 3 successful transactions');

    console.log(JSON.stringify({ ok: true, status: 'passed', executed: true,
      scope: 'native MAP atomic transactions on the explicit owned-copy MSB', cases: 7, patchCommits: commitCount }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMapTransactionAtomicSmoke().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
