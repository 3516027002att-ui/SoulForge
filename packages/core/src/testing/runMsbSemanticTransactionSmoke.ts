/**
 * MSB part position typed PatchIR commit + resource-entry rollback on real m10 sample.
 * Uses DFLT-decompressed raw MSB (same as native MSB smoke); not a full DCX wrapper claim.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { IndexedFile } from '@soulforge/shared';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import {
  commitMsbPartPositionThroughPatchIr,
  commitMsbRegionPositionThroughPatchIr
} from '../editing/msbSemanticCommit.js';
import { readMsbDocumentViaBridge } from '../editing/msbBridgeRead.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackResourceEntry } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

function decompressDfltDcx(source: Buffer): Buffer {
  let dca = -1;
  for (let i = 0x30; i < 0x100; i++) {
    if (source[i] === 0x44 && source[i + 1] === 0x43 && source[i + 2] === 0x41 && source[i + 3] === 0) {
      dca = i;
      break;
    }
  }
  if (dca < 0) throw new Error('DCA missing');
  const dcaLen = source.readUInt32BE(dca + 4);
  const payloadOff = dca + dcaLen;
  const compressedSize = source.readUInt32BE(0x20);
  const format = source.subarray(0x28, 0x2c).toString('ascii');
  if (format !== 'DFLT') throw new Error(`expected DFLT, got ${format}`);
  return inflateSync(source.subarray(payloadOff, payloadOff + compressedSize));
}

async function main(): Promise<void> {
  const sourceDcx = await resolveNativeFixturePath(
    'map/mapstudio/m10_00_00_00.msb.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_MSB'
  );
  const sourceDcxBytes = await readFile(sourceDcx);
  const payload = decompressDfltDcx(sourceDcxBytes);
  const root = await mkdtemp(join(tmpdir(), 'soulforge-msb-semantic-'));
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'map', 'mapstudio'), { recursive: true });
  const target = join(overlay, 'map', 'mapstudio', 'm10_00_00_00.msb');
  await writeFile(target, payload);
  const sourceBytes = payload;

  try {
    const before = await readMsbDocumentViaBridge({
      sourcePath: target,
      allowedRoots: [overlay],
      maxParts: 64
    });
    if (!before.ok || !before.data?.parts[0]) {
      throw new Error(`MSB semantic baseline failed: ${JSON.stringify(before.diagnostics)}`);
    }
    const part = before.data.parts[0]!;
    const region = before.data.regions[0];
    if (!region) {
      throw new Error('MSB semantic baseline did not expose a region');
    }
    const next = {
      posX: part.posX + 1,
      posY: part.posY,
      posZ: part.posZ
    };
    const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
    const store = new MemoryOperationLogStore();
    const sourceUri = 'file://map/mapstudio/m10_00_00_00.msb';
    const file: IndexedFile = {
      id: sourceUri,
      workspaceId: session.meta.workspaceId,
      absolutePath: target,
      relativePath: 'map/mapstudio/m10_00_00_00.msb',
      sourceUri,
      sourcePath: target,
      game: 'sekiro',
      resourceKind: 'map',
      parseStatus: 'parsed',
      diagnostics: [],
      extension: '.msb',
      compoundExtension: '.msb',
      formatKind: 'msb',
      formatLabel: 'MSB',
      size: sourceBytes.length,
      mtimeMs: Date.now()
    };

    const denied = await commitMsbPartPositionThroughPatchIr({
      file,
      expectedHash: before.data.sourceHash,
      partName: part.name,
      ...next,
      session,
      operationLog: store
    });
    if (denied.ok || !denied.requiresConfirmation) {
      throw new Error('MSB semantic confirmation gate did not fail closed');
    }

    const committed = await commitMsbPartPositionThroughPatchIr({
      file,
      expectedHash: before.data.sourceHash,
      partName: part.name,
      ...next,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'MSB_SEMANTIC_PART_POSITION'],
        riskLevel: 'high',
        sourceUri,
        note: 'MSB semantic position smoke'
      }),
      session,
      operationLog: store,
      title: 'MSB part position typed semantic transaction'
    });
    if (!committed.ok || !committed.opId) {
      throw new Error(`MSB semantic commit failed: ${JSON.stringify(committed.diagnostics)}`);
    }
    const changes = await store.listResourceEntryChanges(committed.opId);
    if (changes.length !== 1 || changes[0]?.changeKind !== 'field_update') {
      throw new Error(`MSB semantic inverse persistence failed: ${JSON.stringify(changes)}`);
    }
    const after = await readMsbDocumentViaBridge({
      sourcePath: target,
      allowedRoots: [overlay],
      maxParts: 64
    });
    const afterPart = after.data?.parts.find((item) => item.name === part.name);
    if (!after.ok || !afterPart
      || Math.abs(afterPart.posX - next.posX) >= 1e-4
      || Math.abs(afterPart.posY - next.posY) >= 1e-4
      || Math.abs(afterPart.posZ - next.posZ) >= 1e-4) {
      throw new Error('MSB typed position commit did not survive reread');
    }

    const rolled = await rollbackResourceEntry({
      opId: committed.opId,
      entryUri: changes[0]!.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${committed.opId}:${changes[0]!.entryUri}`],
        riskLevel: 'high',
        note: 'MSB semantic entry rollback smoke'
      })
    });
    const restored = await readMsbDocumentViaBridge({
      sourcePath: target,
      allowedRoots: [overlay],
      maxParts: 64
    });
    const restoredPart = restored.data?.parts.find((item) => item.name === part.name);
    if (!rolled.ok || !restored.ok || !restoredPart
      || Math.abs(restoredPart.posX - part.posX) >= 1e-4
      || Math.abs(restoredPart.posY - part.posY) >= 1e-4
      || Math.abs(restoredPart.posZ - part.posZ) >= 1e-4
      || !(await readFile(target)).equals(sourceBytes)
      || !(await readFile(sourceDcx)).equals(sourceDcxBytes)) {
      throw new Error(`MSB resource-entry rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
    }

    const regionNext = {
      posX: region.posX,
      posY: region.posY + 2,
      posZ: region.posZ
    };
    const regionCommitted = await commitMsbRegionPositionThroughPatchIr({
      file,
      expectedHash: restored.data!.sourceHash,
      regionName: region.name,
      ...regionNext,
      confirmation: createConfirmationReceipt({
        subjects: [sourceUri, 'MSB_SEMANTIC_REGION_POSITION'],
        riskLevel: 'high',
        sourceUri,
        note: 'MSB semantic region position smoke'
      }),
      session,
      operationLog: store,
      title: 'MSB region position typed semantic transaction'
    });
    if (!regionCommitted.ok || !regionCommitted.opId) {
      throw new Error(`MSB region semantic commit failed: ${JSON.stringify(regionCommitted.diagnostics)}`);
    }
    const regionChanges = await store.listResourceEntryChanges(regionCommitted.opId);
    const regionAfter = await readMsbDocumentViaBridge({
      sourcePath: target,
      allowedRoots: [overlay],
      maxParts: 64,
      maxRegions: 10_000
    });
    const afterRegion = regionAfter.data?.regions.find((item) => item.name === region.name);
    if (regionChanges.length !== 1
      || regionChanges[0]?.changeKind !== 'field_update'
      || !regionAfter.ok
      || !afterRegion
      || Math.abs(afterRegion.posX - regionNext.posX) >= 1e-4
      || Math.abs(afterRegion.posY - regionNext.posY) >= 1e-4
      || Math.abs(afterRegion.posZ - regionNext.posZ) >= 1e-4) {
      throw new Error('MSB typed region position commit did not survive reread');
    }
    const regionRolled = await rollbackResourceEntry({
      opId: regionCommitted.opId,
      entryUri: regionChanges[0]!.entryUri,
      store,
      session,
      confirmation: createConfirmationReceipt({
        subjects: [`ROLLBACK_RESOURCE_ENTRY:${regionCommitted.opId}:${regionChanges[0]!.entryUri}`],
        riskLevel: 'high',
        note: 'MSB region semantic entry rollback smoke'
      })
    });
    const regionRestored = await readMsbDocumentViaBridge({
      sourcePath: target,
      allowedRoots: [overlay],
      maxParts: 64,
      maxRegions: 10_000
    });
    const restoredRegion = regionRestored.data?.regions.find((item) => item.name === region.name);
    if (!regionRolled.ok || !regionRestored.ok || !restoredRegion
      || Math.abs(restoredRegion.posX - region.posX) >= 1e-4
      || Math.abs(restoredRegion.posY - region.posY) >= 1e-4
      || Math.abs(restoredRegion.posZ - region.posZ) >= 1e-4
      || !(await readFile(target)).equals(sourceBytes)
      || !(await readFile(sourceDcx)).equals(sourceDcxBytes)) {
      throw new Error(`MSB region resource-entry rollback failed: ${JSON.stringify(regionRolled.diagnostics)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      status: 'passed',
      message: 'MSB part/region 位置 typed PatchIR 提交与 resource-entry 回滚验证通过',
      partName: part.name,
      regionName: region.name,
      authorityStillCandidate: before.data.authority === 'candidate',
      semanticPatchIrFieldCommitVerified: true,
      partPositionResourceEntryRollbackVerified: true,
      regionPositionResourceEntryRollbackVerified: true,
      originalDcxFixtureUntouched: true,
      fullEntityCrudClaimed: false,
      note: 'raw DFLT-decompressed MSB path; not DCX-wrapper or full native-verified authority'
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
