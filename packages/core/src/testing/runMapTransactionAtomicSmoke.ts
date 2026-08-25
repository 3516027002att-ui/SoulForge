import assert from 'node:assert/strict';
import { dirname, join, basename } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  type MapEditTransaction,
  type IndexedFile
} from '@soulforge/shared';
import { executeMapTransaction, loadMapDocument } from '../editing/mapService.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { type NativeEditSession, mintNativeEditReceipt } from '../editing/nativeEditSession.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';

export async function runMapTransactionAtomicSmoke(): Promise<void> {
  console.log('[Smoke] Testing Atomic MapEditTransaction Invariants...');

  await withSmokeWorkspace('map-atomic-tx', async (workspace) => {
    const oodleRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT || 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
    const sourceOriginal = process.argv[2] || 'D:/mystream/Sekiro Shadows Die Twice/Sekiro/map/mapstudio/m10_00_00_00.msb.dcx';

    const stagingRoot = join(workspace.root, 'staging');
    await mkdir(stagingRoot, { recursive: true });

    // Copy to workspace for isolated writeback
    const mapFile = join(workspace.root, 'm10_00_00_00.msb.dcx');
    await copyFile(sourceOriginal, mapFile);

    let commitCount = 0;
    const editSession: NativeEditSession = {
      session: {
        workspaceId: 'smoke-ws',
        root: workspace.root,
        name: 'Smoke Workspace',
        layers: {
          overlayRoot: workspace.root,
          baseRoot: oodleRoot
        }
      } as any,
      operationLog: new MemoryOperationLogStore(),
      stagingRoot,
      backupBaseDir: join(workspace.root, 'backups'),
      recoveryDir: join(workspace.root, 'recovery'),
      oodleRuntimeRoot: oodleRoot,
      allowedRoots: () => [workspace.root, dirname(sourceOriginal), oodleRoot],
      mintReceipt: (uri, title) => mintNativeEditReceipt(uri, title),
      commitPort: {
        commit: async (req) => {
          commitCount++;
          // Real commit: write staging payload to target
          const buf = Buffer.from(req.newContentBase64, 'base64');
          const { writeFile } = await import('node:fs/promises');
          await writeFile(mapFile, buf);
          return {
            ok: true,
            receipt: mintNativeEditReceipt(req.file.sourceUri, req.title),
            writtenBytes: buf.length,
            file: req.file,
            changedFiles: [req.file.sourceUri],
            diagnostics: []
          };
        }
      },
      indexFile: async (path, kind): Promise<IndexedFile> => {
        const { readFile } = await import('node:fs/promises');
        const { createHash } = await import('node:crypto');
        const buf = await readFile(path);
        const hash = createHash('sha256').update(buf).digest('hex');
        return {
          id: 'file-1',
          workspaceId: 'smoke-ws',
          sourceUri: pathToFileURL(path).toString(),
          sourcePath: path,
          relativePath: basename(path),
          absolutePath: path,
          mtimeMs: Date.now(),
          resourceKind: kind ?? 'map',
          formatKind: 'native-msb' as any,
          formatLabel: 'MSB',
          extension: '.msb.dcx',
          compoundExtension: '.msb.dcx',
          parseStatus: 'parsed',
          size: buf.length,
          sha256: hash,
          game: 'sekiro',
          diagnostics: []
        };
      }
    };

    const loaded = await loadMapDocument(editSession, mapFile);
    assert.equal(loaded.ok, true, 'Must load map document');
    if (!loaded.ok) return;

    console.log('[Smoke] Case 1: Stale baseRevision rejected before commit...');
    const staleTx: MapEditTransaction = {
      id: 'tx-stale',
      mapId: 'm10_00_00_00',
      baseRevision: 'stale_hash_123',
      description: 'Stale revision test',
      author: 'agent',
      operations: [
        { kind: 'set_transform', target: 'm000010_1077', position: [0, 0, 0] }
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
      mapId: 'm10_00_00_00',
      baseRevision: loaded.doc.revision,
      description: 'Invalid model test',
      author: 'human',
      operations: [
        { kind: 'change_model', target: 'm000010_1077', newModelName: 'm_nonexistent_999999' }
      ],
      timestamp: Date.now()
    };
    const invalidModelResult = await executeMapTransaction(editSession, mapFile, invalidModelTx);
    assert.equal(invalidModelResult.ok, false, 'Unknown model must fail preflight validation');
    assert.equal(commitCount, 0, 'Zero commits on validation failure');

    console.log('[Smoke] Case 3: Unsupported property rejected in preflight...');
    const unsupportedPropTx: MapEditTransaction = {
      id: 'tx-unsupported-prop',
      mapId: 'm10_00_00_00',
      baseRevision: loaded.doc.revision,
      description: 'Unsupported property test',
      author: 'human',
      operations: [
        { kind: 'set_property', target: 'm000010_1077', property: 'unsupportedField', value: 123 }
      ],
      timestamp: Date.now()
    };
    const unsupportedPropResult = await executeMapTransaction(editSession, mapFile, unsupportedPropTx);
    assert.equal(unsupportedPropResult.ok, false, 'Unsupported property must fail preflight');
    assert.equal(commitCount, 0, 'Zero commits on unsupported property');

    console.log('[Smoke] Case 4: Sequential composition (delete target then use in subsequent op) fails preflight...');
    const invalidSeqTx: MapEditTransaction = {
      id: 'tx-invalid-seq',
      mapId: 'm10_00_00_00',
      baseRevision: loaded.doc.revision,
      description: 'Delete then transform',
      author: 'agent',
      operations: [
        { kind: 'delete', target: 'm000010_1077' },
        { kind: 'set_transform', target: 'm000010_1077', position: [10, 20, 30] }
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
      mapId: 'm10_00_00_00',
      baseRevision: reread1.doc.revision,
      description: 'Delete 2 parts in one transaction',
      author: 'human',
      operations: [
        { kind: 'delete', target: orderPart.stableKey },
        { kind: 'delete', target: reread1.doc.parts[1]!.stableKey }
      ],
      timestamp: Date.now()
    };
    const deleteResult = await executeMapTransaction(editSession, mapFile, deleteBatchTx);
    if (!deleteResult.ok) {
      console.error('[Smoke] Case 6 failed with error:', JSON.stringify(deleteResult.error, null, 2));
    }
    assert.equal(deleteResult.ok, true, 'Batch delete must succeed and rebuild param tables without corruption');
    assert.equal(commitCount, 3, 'Exact 3 commits after 3 successful transactions');

    console.log('[Smoke] All Atomic MapEditTransaction Invariants PASSED.');
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runMapTransactionAtomicSmoke.js')) {
  runMapTransactionAtomicSmoke().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
