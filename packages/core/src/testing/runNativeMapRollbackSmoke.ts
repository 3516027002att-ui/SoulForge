/**
 * Mission4 native MAP rollback smoke。
 *
 * 复制真实 .msb.dcx 到项目内临时 overlay，走真实 Bridge MSB writer、Patch
 * Engine backup/operation log，再用 operation-level inverse transaction 回滚。
 * 每个阶段都通过新的 native read 取证；不把 renderer 的旧状态当作权威。
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MapEditTransaction } from '@soulforge/shared';
import {
  createConfirmationReceipt,
  executeMapTransaction,
  loadMapDocument,
  MemoryOperationLogStore,
  nativeEditSessionFromContext,
  openWorkspaceSession,
  readMsbDocumentViaBridge,
  rollbackOperation
} from '../index.js';

const DEFAULT_GAME_ROOT = 'D:/mystream/Sekiro Shadows Die Twice/Sekiro';
const DEFAULT_RELATIVE_MAP = 'mods/map/mapstudio/m10_00_00_00.msb.dcx';

interface TransformSnapshot {
  name: string;
  nativeOffset?: number;
  position: [number, number, number];
}

function snapshotPart(part: {
  name: string;
  nativeOffset?: number;
  transform: { position: [number, number, number] };
}): TransformSnapshot {
  return {
    name: part.name,
    ...(part.nativeOffset === undefined ? {} : { nativeOffset: part.nativeOffset }),
    position: [...part.transform.position] as [number, number, number]
  };
}

async function readPartFromNative(
  sourcePath: string,
  allowedRoots: string[],
  oodleRuntimeRoot: string,
  name: string,
  nativeOffset: number | undefined
): Promise<TransformSnapshot> {
  const read = await readMsbDocumentViaBridge({
    sourcePath,
    allowedRoots,
    oodleRuntimeRoot,
    timeoutMs: 120_000
  });
  assert.equal(read.ok, true, `native MSB read failed: ${JSON.stringify(read.diagnostics)}`);
  const part = read.data?.parts.find((candidate) => (
    candidate.name === name
      && (nativeOffset === undefined || candidate.nativeOffset === nativeOffset)
  ));
  assert.ok(part, `native reread cannot find target part ${name}/${nativeOffset ?? 'no-offset'}`);
  return {
    name: part.name,
    ...(part.nativeOffset === undefined ? {} : { nativeOffset: part.nativeOffset }),
    position: [part.posX, part.posY, part.posZ]
  };
}

export async function runNativeMapRollbackSmoke(): Promise<void> {
  const gameRoot = resolve(process.env.SOULFORGE_GAME_ROOT ?? DEFAULT_GAME_ROOT);
  const sourcePath = await realpath(
    resolve(process.argv[2] ?? join(gameRoot, DEFAULT_RELATIVE_MAP))
  );
  const tempRoot = resolve(join(process.cwd(), `.tmp-mission4-map-rollback-${process.pid}`));
  const mapRelativePath = 'map/mapstudio/m10_00_00_00.msb.dcx';
  const mapPath = join(tempRoot, mapRelativePath);
  const stagingRoot = join(tempRoot, '.staging');
  const backupBaseDir = join(tempRoot, '.backups');
  const recoveryDir = join(tempRoot, '.recovery');

  await rm(tempRoot, { recursive: true, force: true });
  try {
    await mkdir(join(tempRoot, 'map/mapstudio'), { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(backupBaseDir, { recursive: true });
    await mkdir(recoveryDir, { recursive: true });
    await copyFile(sourcePath, mapPath);

    const session = await openWorkspaceSession({
      overlayRoot: tempRoot,
      baseRoot: gameRoot,
      game: 'sekiro'
    });
    const operationLog = new MemoryOperationLogStore();
    const edit = nativeEditSessionFromContext({
      session,
      operationLog,
      stagingRoot,
      backupBaseDir,
      recoveryDir
    });

    const initial = await loadMapDocument(edit, mapPath);
    assert.equal(initial.ok, true, 'real MSB A state must load through Bridge');
    if (!initial.ok) return;
    const target = initial.doc.parts[0];
    assert.ok(target, 'real MSB must contain at least one part');
    const before = snapshotPart(target);
    const afterPosition: [number, number, number] = [
      before.position[0] + 1.25,
      before.position[1] - 2.5,
      before.position[2] + 3.75
    ];
    const transaction: MapEditTransaction = {
      id: `mission4-map-${randomUUID()}`,
      mapId: initial.doc.mapId,
      baseRevision: initial.doc.revision,
      description: 'Mission4 real native overlay A→B→A rollback',
      author: 'agent',
      operations: [{
        kind: 'set_transform',
        target: target.stableKey,
        position: afterPosition
      }],
      timestamp: Date.now()
    };

    const committed = await executeMapTransaction(edit, mapPath, transaction);
    assert.equal(committed.ok, true, `A→B commit failed: ${JSON.stringify(committed.error)}`);
    assert.equal(committed.verification, 'passed', 'A→B must pass authoritative reread');
    const afterB = await readPartFromNative(
      mapPath,
      edit.allowedRoots(),
      edit.oodleRuntimeRoot!,
      target.name,
      target.nativeOffset
    );
    assert.deepEqual(afterB.position, afterPosition, 'fresh native read must observe B');

    const records = await operationLog.list(session.meta.workspaceId);
    const original = records.find((record) => (
      record.status === 'committed'
        && record.title.includes(`MSB transaction [${transaction.id}]`)
    ));
    assert.ok(original, 'A→B must leave a committed operation with backup metadata');
    assert.ok(original.backupRoot, 'committed operation must expose backup root');

    const confirmation = createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${original.opId}`, 'ALL_RISKS'],
      riskLevel: 'high',
      note: 'Mission4 real native MAP rollback smoke'
    });
    const rolledBack = await rollbackOperation({
      opId: original.opId,
      store: operationLog,
      session,
      backupBaseDir,
      recoveryDir,
      confirmation
    });
    assert.equal(rolledBack.ok, true, `A→A rollback failed: ${JSON.stringify(rolledBack.diagnostics)}`);
    assert.ok(rolledBack.inverseOpId, 'rollback must create a persisted inverse operation');

    const afterA = await readPartFromNative(
      mapPath,
      edit.allowedRoots(),
      edit.oodleRuntimeRoot!,
      before.name,
      before.nativeOffset
    );
    assert.deepEqual(afterA.position, before.position, 'fresh native read must restore A');

    const inverse = await operationLog.get(rolledBack.inverseOpId);
    assert.equal(inverse?.status, 'committed', 'inverse operation must be committed');
    assert.equal(inverse?.inverseOfOpId, original.opId, 'inverse operation must bind original op');
    assert.equal(inverse?.rollbackScope, 'operation', 'rollback must be operation scoped');

    console.log(JSON.stringify({
      ok: true,
      authority: 'native-verified',
      scope: 'real MSB overlay A→B→A',
      source: 'real game MSB copied to project-local temporary overlay',
      target: before,
      afterB,
      afterA,
      originalOpId: original.opId,
      inverseOpId: rolledBack.inverseOpId,
      verification: 'fresh Bridge reread after commit and rollback'
    }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runNativeMapRollbackSmoke.js')) {
  runNativeMapRollbackSmoke().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
