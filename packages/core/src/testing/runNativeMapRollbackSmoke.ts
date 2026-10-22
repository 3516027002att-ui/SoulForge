/**
 * Mission4 native MAP rollback smoke。
 *
 * 复制真实 .msb.dcx 到项目内临时 overlay，走真实 Bridge MSB writer、Patch
 * Engine backup/operation log，再用 operation-level inverse transaction 回滚。
 * 每个阶段都通过新的 native read 取证；不把 renderer 的旧状态当作权威。
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

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
  oodleRuntimeRoot: string | undefined,
  name: string,
  nativeOffset: number | undefined
): Promise<TransformSnapshot> {
  const read = await readMsbDocumentViaBridge({
    sourcePath,
    allowedRoots,
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
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
  const explicitSource = process.argv[2]?.trim();
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || process.env.SOULFORGE_GAME_ROOT?.trim();
  const registry = process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim();
  const fixtureRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  const unavailable = (code: string) => console.log(JSON.stringify({
    ok: false, status: 'skipped', executed: false, authority: 'unverified', code,
    scope: 'native MAP rollback',
    message: 'Native checks were not executed. Configure an explicit MSB path, SOULFORGE_SEKIRO_GAME_ROOT, or SOULFORGE_NATIVE_FIXTURE_REGISTRY with SOULFORGE_NATIVE_FIXTURE_ROOT.'
  }));
  if (!explicitSource && !gameRoot && !registry && !fixtureRoot) {
    unavailable('NATIVE_MAP_INPUT_REQUIRED');
    return;
  }
  if (!explicitSource && Boolean(registry) !== Boolean(fixtureRoot)) throw new Error('NATIVE_FIXTURE_CONFIG_INCOMPLETE');
  let sourcePath: string;
  try {
    sourcePath = await realpath(await resolveNativeFixture(
      explicitSource ?? (!registry && gameRoot ? join(gameRoot, DEFAULT_RELATIVE_MAP) : undefined),
      'msb-primary', '../../mods/map/mapstudio/m10_00_00_00.msb.dcx'
    ));
    if (!(await stat(sourcePath)).isFile()) throw new Error('NATIVE_MAP_SOURCE_NOT_FILE');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      unavailable('NATIVE_MAP_SOURCE_UNAVAILABLE');
      return;
    }
    throw error;
  }
  const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT?.trim() || gameRoot;
  await withSmokeWorkspace('native-map-rollback', async (workspace) => {
    const tempRoot = workspace.root;
    const mapRelativePath = 'map/mapstudio/m10_00_00_00.msb.dcx';
    const mapPath = join(tempRoot, mapRelativePath);
    const stagingRoot = join(tempRoot, '.staging');
    const backupBaseDir = join(tempRoot, '.backups');
    const recoveryDir = join(tempRoot, '.recovery');

    await mkdir(join(tempRoot, 'map/mapstudio'), { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    await mkdir(backupBaseDir, { recursive: true });
    await mkdir(recoveryDir, { recursive: true });
    await copyFile(sourcePath, mapPath);

    const session = await openWorkspaceSession({
      overlayRoot: tempRoot,
      ...(oodleRuntimeRoot ? { baseRoot: oodleRuntimeRoot } : {}),
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
      source: 'explicit native MSB copied to a test-owned temporary overlay',
      target: before,
      afterB,
      afterA,
      originalOpId: original.opId,
      inverseOpId: rolledBack.inverseOpId,
      verification: 'fresh Bridge reread after commit and rollback'
    }, null, 2));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNativeMapRollbackSmoke().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
