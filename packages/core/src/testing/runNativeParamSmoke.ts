/**
 * Native PARAM smoke against real gameparam.parambnd.dcx children.
 * Verifies semantic roundtrip, row upsert/delete via write-param, and BND4 commit/rollback.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { dirname, join } from 'node:path';
import type { ParamDefDocument } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { applyParamFieldMutation } from '../param/paramFieldMutation.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

interface ParamEnvelope {
  sourceHash: string;
  typeName: string;
  dataVersion?: number;
  rowCount: number;
  rowDataSize: number;
  rows: Array<{ id: number; dataBase64: string; dataHash: string }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

interface Bnd4ChildSnapshot {
  contentBase64: string;
  contentHash: string;
  name: string;
  id: number;
  index: number;
}

function main(): Promise<void> {
  return withSmokeWorkspace('native-param', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const sourceBnd = await resolveNativeFixture(
    process.argv[2],
    'param-primary',
    '../../mods/param/gameparam/gameparam.parambnd.dcx'
  );
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  await mkdir(join(overlay, 'param', 'gameparam'), { recursive: true });
  await mkdir(staging, { recursive: true });
  const bndPath = join(overlay, 'param', 'gameparam', 'gameparam.parambnd.dcx');
  await copyFile(sourceBnd, bndPath);

  // Use small ActionGuideParam (index 1)
  const child = await runBridge<Bnd4ChildSnapshot>({
    command: 'snapshot-bnd4-child',
    filePath: bndPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    commandOptions: { entryIndex: 1 }
  });
  if (!child.data?.contentBase64) throw new Error(`snapshot failed: ${JSON.stringify(child.diagnostics)}`);
  const paramPath = join(overlay, 'param', 'gameparam', 'ActionGuideParam.param');
  await writeFile(paramPath, Buffer.from(child.data.contentBase64, 'base64'));

  const read = await runBridge<ParamEnvelope>({
    command: 'read-param-document',
    filePath: paramPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    // 显式空 options：规避 Bridge 对 default JsonElement 调用 TryGetProperty 抛
    // InvalidOperationException 的缺陷（read-param-document 分页读取行无 ValueKind 防护）。
    commandOptions: {}
  });
  if (!read.data?.roundTrip?.semanticIdentical) {
    throw new Error(`PARAM read/roundtrip failed: ${JSON.stringify(read.diagnostics)} ${JSON.stringify(read.data?.roundTrip)}`);
  }
  const first = read.data.rows[0];
  if (!first) throw new Error('PARAM has no rows.');

  // Field-level set: encode the mutation through the TS field codec, then hand
  // the whole row to the Bridge as a staged upsert. The minimal user-derived
  // definition maps the row's first byte to a u8 field so the staged result can
  // be re-read and asserted byte-for-byte on the Bridge side.
  const originalData = Buffer.from(first.dataBase64, 'base64');
  const FIELD_SET_VALUE = originalData[0] === 0x5a ? 0xa5 : 0x5a;
  const FIELD_DEF: ParamDefDocument = {
    schemaVersion: 1,
    typeName: read.data.typeName,
    version: read.data.dataVersion ?? 0,
    rowDataSize: read.data.rowDataSize,
    origin: 'fixture',
    fields: [
      { id: 'f_first_byte', name: 'firstByte', type: 'u8', offset: 0, size: 1 }
    ]
  };
  const fieldSet = applyParamFieldMutation({
    rowDataBase64: first.dataBase64,
    definition: FIELD_DEF,
    fieldId: 'f_first_byte',
    value: FIELD_SET_VALUE
  });
  if (!fieldSet.ok) throw new Error(`field-level set failed: ${fieldSet.message}`);
  const mutated = Buffer.from(fieldSet.nextDataBase64, 'base64');
  if (mutated.readUInt8(0) !== FIELD_SET_VALUE) {
    throw new Error('field-level set did not land on the first byte');
  }
  if (!originalData.equals(Buffer.from(first.dataBase64, 'base64'))) {
    throw new Error('TS field codec mutated the source row');
  }
  const stagedParam = join(staging, 'ActionGuideParam.param');
  const written = await runBridge({
    command: 'write-param',
    filePath: paramPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: stagedParam,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'upsert',
      id: first.id,
      dataBase64: mutated.toString('base64')
    }
  });
  if (!written.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
    throw new Error(`PARAM write failed: ${JSON.stringify(written.diagnostics)}`);
  }
  const stagedRead = await runBridge<ParamEnvelope>({
    command: 'read-param-document',
    filePath: stagedParam,
    allowedRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {}
  });
  const stagedRow = stagedRead.data?.rows.find((r) => r.id === first.id);
  if (!stagedRow || stagedRow.dataHash === first.dataHash) {
    throw new Error('PARAM staged upsert did not change row hash.');
  }
  // Bridge 独立重读：staged 行首字节必须与字段级 set 的值逐字节一致。
  const stagedRowBytes = Buffer.from(stagedRow.dataBase64, 'base64');
  if (stagedRowBytes.readUInt8(0) !== FIELD_SET_VALUE) {
    throw new Error(`Bridge staged row first byte mismatch: 0x${stagedRowBytes.readUInt8(0).toString(16)}`);
  }

  // Commit into parambnd via BND4 replace
  const session = await openWorkspaceSession({ overlayRoot: overlay, game: 'sekiro' });
  const store = new MemoryOperationLogStore();
  const containerHash = sha256(await readFile(bndPath));
  const targetUri = 'file://param/gameparam/gameparam.parambnd.dcx';
  const stagedBytes = await readFile(stagedParam);
  const patch = createPatchIr({
    workspaceId: session.meta.workspaceId,
    title: 'PARAM 语义修改经 BND4 提交',
    author: 'user',
    operations: [{
      id: 'param-via-bnd4-replace',
      kind: 'container_child_replace',
      targetUri,
      targetPath: bndPath,
      resourceKind: 'param',
      containerUri: targetUri,
      childPath: child.data.name,
      childContentBase64: stagedBytes.toString('base64'),
      expectedContainerHash: containerHash,
      expectedHash: containerHash,
      expectedChildHash: child.data.contentHash,
      containerFormat: 'BND4_DFLT',
      preconditions: [{
        type: 'content_hash',
        description: 'parambnd hash',
        expectedHash: containerHash,
        targetUri
      }],
      validatorRequirements: [
        { validatorId: 'container_roundtrip', scope: 'staged_output', required: true },
        { validatorId: 'file_risk', scope: 'before_staging', required: true }
      ],
      riskLevel: 'high',
      metadata: {
        nativeFormatAuthority: true,
        nativeEntryIndex: child.data.index,
        nativeEntryId: child.data.id,
        requiresConfirmation: true,
        confirmationReceiptId: 'param-bnd4-smoke'
      }
    }]
  });
  const committed = await executePatchIrThroughTransaction(patch, { session, operationLog: store,
    backupBaseDir: join(root, 'backups')
  });
  if (!committed.operation) {
    throw new Error(`PARAM BND4 commit failed: ${JSON.stringify(committed.diagnostics)}`);
  }

  const rolled = await rollbackOperation({
    opId: committed.opId,
    store,
    session,
    confirmation: createConfirmationReceipt({
      subjects: [`ROLLBACK_OPERATION:${committed.opId}`],
      riskLevel: 'high',
      note: 'param native smoke'
    }),
    // 回滚会建还原点；不指定时落系统临时目录且有意保留，无人清理。
    backupBaseDir: join(root, 'backups')
  });
  if (!rolled.ok || !(await readFile(bndPath)).equals(await readFile(sourceBnd))) {
    throw new Error(`PARAM container rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  }

  // Corpus: sample first 20 PARAM children for semantic roundtrip
  const container = await runBridge<{ nested?: { entryCount: number } }>({
    command: 'read-dcx-document',
    filePath: sourceBnd,
    allowedRoots: [dirname(sourceBnd)],
    timeoutMs: 120_000
  });
  const count = container.data?.nested?.entryCount ?? 0;
  let verified = 0;
  let failed: Array<{ index: number; message: string }> = [];
  const limit = Math.min(count, 40);
  for (let i = 0; i < limit; i++) {
    const snap = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: sourceBnd,
      allowedRoots: [dirname(sourceBnd)],
      timeoutMs: 120_000,
      commandOptions: { entryIndex: i }
    });
    if (!snap.data?.contentBase64) {
      failed.push({
        index: i,
        message: snap.diagnostics[0]?.message ?? 'snapshot failed'
      });
      continue;
    }
    const tmp = join(staging, `corpus-${i}.param`);
    await writeFile(tmp, Buffer.from(snap.data.contentBase64, 'base64'));
    const doc = await runBridge<ParamEnvelope>({
      command: 'read-param-document',
      filePath: tmp,
      allowedRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {}
    });
    if (!doc.data?.roundTrip?.semanticIdentical) {
      failed.push({
        index: i,
        message: doc.diagnostics[0]?.message ?? 'semantic roundtrip failed'
      });
      continue;
    }
    verified += 1;
  }

  if (verified === 0) {
    throw new Error(`No PARAM children verified: ${JSON.stringify(failed.slice(0, 5))}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: '原生 PARAM 读取/语义往返/写入/BND4 提交/回滚验证通过',
    typeName: read.data.typeName,
    rowCount: read.data.rowCount,
    rowDataSize: read.data.rowDataSize,
    byteIdenticalNoop: read.data.roundTrip?.byteIdentical ?? false,
    semanticIdenticalNoop: true,
    corpusSampled: limit,
    corpusVerified: verified,
    corpusFailed: failed.length,
    failures: failed.slice(0, 5),
    containerEntries: count,
    fieldLevelSet: {
      fieldId: 'f_first_byte',
      value: FIELD_SET_VALUE,
      tsCodecLanded: true,
      bridgeStagedRereadByteMatch: true,
      sourceRowImmutable: true
    }
  }, null, 2));
  await disposeBridgeDaemonPool();
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
