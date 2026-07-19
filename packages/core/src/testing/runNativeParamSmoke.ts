/**
 * Native PARAM smoke against real gameparam.parambnd.dcx children.
 * Verifies semantic roundtrip, row upsert/delete via write-param, and BND4 commit/rollback.
 */
import type { ParamDefDocument } from '@soulforge/shared';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { commitParamFieldMutationViaBridge } from '../editing/paramBridgeCommit.js';
import { createPatchIr } from '../patch-engine/patchIr.js';
import { executePatchIrThroughTransaction } from '../patch/durablePatchCommit.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { resolveNativeFixturePath } from './nativeFixturePaths.js';

interface ParamEnvelope {
  sourceHash: string;
  typeName: string;
  layout?: string;
  rowCount: number;
  rowDataSize: number;
  rows: Array<{ id: number; dataBase64?: string; dataHash: string }>;
  roundTrip?: {
    semanticIdentical: boolean;
    byteIdentical: boolean;
    firstDifferenceOffset?: number;
    sourceSize?: number;
    rebuiltSize?: number;
  };
}

interface Bnd4ChildSnapshot {
  contentBase64: string;
  contentHash: string;
  name: string;
  id: number;
  index: number;
}

async function main(): Promise<void> {
  const sourceBnd = await resolveNativeFixturePath(
    'param/gameparam/gameparam.parambnd.dcx',
    2,
    'SOULFORGE_NATIVE_FIXTURE_PARAM'
  );
  const sourceRoot = dirname(sourceBnd);
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-param-'));
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
    timeoutMs: 60_000
  });
  if (!read.data?.roundTrip?.semanticIdentical) {
    throw new Error(`PARAM read/roundtrip failed: ${JSON.stringify(read.diagnostics)} ${JSON.stringify(read.data?.roundTrip)}`);
  }
  const first = read.data.rows[0];
  if (!first?.dataBase64) throw new Error('PARAM has no bounded row payload.');

  // Use a deliberately fixture-scoped user definition. This proves the typed
  // field pipeline without claiming that byte 0 has an official ParamDef name.
  const originalData = Buffer.from(first.dataBase64, 'base64');
  const fixtureValue = (originalData[0]! ^ 0xff) & 0xff;
  const fixtureDefinition: ParamDefDocument = {
    schemaVersion: 1,
    typeName: read.data.typeName,
    version: 1,
    rowDataSize: read.data.rowDataSize,
    origin: 'fixture',
    fields: [{
      id: 'fixture_byte_0',
      name: 'fixtureByte0',
      type: 'u8',
      offset: 0,
      size: 1,
      min: 0,
      max: 255,
      description: 'Fixture-only field; not an official ParamDef semantic claim.'
    }]
  };
  const stagedParam = join(staging, 'ActionGuideParam.param');
  const fieldWritten = await commitParamFieldMutationViaBridge({
    sourcePath: paramPath,
    outputPath: stagedParam,
    expectedDocumentHash: read.data.sourceHash,
    rowId: first.id,
    expectedRowHash: first.dataHash,
    definition: fixtureDefinition,
    fieldId: 'fixture_byte_0',
    value: fixtureValue,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000
  });
  if (!fieldWritten.ok
    || fieldWritten.fieldMutation?.afterValue !== fixtureValue
    || fieldWritten.fieldMutation.changedByteOffsets.some((offset) => offset !== 0)) {
    throw new Error(`PARAM field write failed: ${JSON.stringify(fieldWritten)}`);
  }
  const stagedRead = await runBridge<ParamEnvelope>({
    command: 'read-param-document',
    filePath: stagedParam,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  const stagedRow = stagedRead.data?.rows.find((r) => r.id === first.id);
  if (!stagedRow
    || stagedRow.dataHash === first.dataHash
    || stagedRow.dataHash !== fieldWritten.fieldMutation.outputRowHash) {
    throw new Error('PARAM staged upsert did not change row hash.');
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
  const committed = await executePatchIrThroughTransaction(patch, { session, operationLog: store });
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
    })
  });
  if (!rolled.ok || !(await readFile(bndPath)).equals(await readFile(sourceBnd))) {
    throw new Error(`PARAM container rollback failed: ${JSON.stringify(rolled.diagnostics)}`);
  }

  // Corpus: every PARAM child in the selected gameparam binder.
  const container = await runBridge<{
    sourceHash: string;
    nested?: { entryCount: number; entries: Array<{ contentHash: string }> };
  }>({
    command: 'read-dcx-document',
    filePath: sourceBnd,
    allowedRoots: [sourceRoot],
    timeoutMs: 120_000
  });
  const count = container.data?.nested?.entryCount ?? 0;
  let verified = 0;
  let failed: Array<{ index: number; message: string }> = [];
  if (count <= 0 || count > 10_000) {
    throw new Error(`PARAM corpus entry count out of bounds: ${count}`);
  }
  const limit = count;
  for (let i = 0; i < limit; i++) {
    const entry = container.data?.nested?.entries[i];
    if (!entry || !container.data?.sourceHash) {
      failed.push({ index: i, message: 'container entry metadata missing' });
      continue;
    }
    const tmp = join(staging, `corpus-${i}.param`);
    const extracted = await runBridge({
      command: 'extract-bnd4-child',
      filePath: sourceBnd,
      allowedRoots: [sourceRoot],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: tmp,
        entryIndex: i,
        expectedContainerHash: container.data.sourceHash,
        expectedChildHash: entry.contentHash
      }
    });
    if (!extracted.diagnostics.some((diagnostic) => diagnostic.code === 'BND4_CHILD_EXTRACTED_TO_STAGING')) {
      failed.push({
        index: i,
        message: extracted.diagnostics[0]?.message ?? 'file-backed extraction failed'
      });
      continue;
    }
    const doc = await runBridge<ParamEnvelope>({
      command: 'read-param-document',
      filePath: tmp,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    if (!doc.data?.roundTrip?.semanticIdentical || !doc.data.roundTrip.byteIdentical) {
      failed.push({
        index: i,
        message: JSON.stringify(doc.data?.roundTrip ?? doc.diagnostics[0]?.message ?? 'byte/semantic roundtrip failed')
      });
      continue;
    }
    verified += 1;
  }

  // Explicitly exercise the 0x100 embedded-type-name layout through the
  // production writer. Index 33 has 22 fixed-width rows, so payload previews
  // remain bounded and can be used for a targeted upsert assertion.
  const legacySnapshot = await runBridge<Bnd4ChildSnapshot>({
    command: 'snapshot-bnd4-child',
    filePath: sourceBnd,
    allowedRoots: [sourceRoot],
    timeoutMs: 60_000,
    commandOptions: { entryIndex: 33 }
  });
  if (!legacySnapshot.data?.contentBase64) {
    throw new Error(`legacy PARAM snapshot failed: ${JSON.stringify(legacySnapshot.diagnostics)}`);
  }
  const legacyPath = join(staging, 'legacy-embedded-type-name.param');
  await writeFile(legacyPath, Buffer.from(legacySnapshot.data.contentBase64, 'base64'));
  const legacyRead = await runBridge<ParamEnvelope>({
    command: 'read-param-document',
    filePath: legacyPath,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  const legacyFirst = legacyRead.data?.rows[0];
  if (legacyRead.data?.layout !== 'embedded-type-name-0x30-0x0c'
    || legacyRead.data.roundTrip?.byteIdentical !== true
    || legacyRead.data.roundTrip.semanticIdentical !== true
    || !legacyFirst?.dataBase64) {
    throw new Error(`legacy PARAM no-op roundtrip failed: ${JSON.stringify(legacyRead.data?.roundTrip)}`);
  }
  const legacyPayload = Buffer.from(legacyFirst.dataBase64, 'base64');
  const legacyMutated = Buffer.from(legacyPayload);
  legacyMutated[0] = (legacyMutated[0]! ^ 0x01) & 0xff;
  const legacyOutput = join(staging, 'legacy-embedded-type-name-mutated.param');
  const legacyWritten = await runBridge({
    command: 'write-param',
    filePath: legacyPath,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: legacyOutput,
      expectedDocumentHash: legacyRead.data.sourceHash,
      mutation: 'upsert',
      id: legacyFirst.id,
      dataBase64: legacyMutated.toString('base64')
    }
  });
  if (!legacyWritten.diagnostics.some((diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
    throw new Error(`legacy PARAM write failed: ${JSON.stringify(legacyWritten.diagnostics)}`);
  }
  const legacyReread = await runBridge<ParamEnvelope>({
    command: 'read-param-document',
    filePath: legacyOutput,
    allowedRoots: [staging],
    timeoutMs: 60_000
  });
  const legacyRereadFirst = legacyReread.data?.rows.find((row) => row.id === legacyFirst.id);
  if (legacyReread.data?.layout !== legacyRead.data.layout
    || legacyReread.data.rowCount !== legacyRead.data.rowCount
    || !legacyRereadFirst?.dataBase64
    || !Buffer.from(legacyRereadFirst.dataBase64, 'base64').equals(legacyMutated)) {
    throw new Error('legacy PARAM staged upsert did not survive reread.');
  }

  if (verified === 0) {
    throw new Error(`No PARAM children verified: ${JSON.stringify(failed.slice(0, 5))}`);
  }

  const corpusComplete = failed.length === 0 && verified === limit;
  console.log(JSON.stringify({
    ok: corpusComplete,
    status: corpusComplete ? 'passed' : 'partial',
    message: '原生 PARAM 读取/语义往返/写入/BND4 提交/回滚验证通过',
    typeName: read.data.typeName,
    rowCount: read.data.rowCount,
    rowDataSize: read.data.rowDataSize,
    byteIdenticalNoop: read.data.roundTrip?.byteIdentical ?? false,
    semanticIdenticalNoop: true,
    fieldMutation: {
      origin: fixtureDefinition.origin,
      fieldId: fieldWritten.fieldMutation.fieldId,
      beforeValue: fieldWritten.fieldMutation.beforeValue,
      afterValue: fieldWritten.fieldMutation.afterValue,
      changedByteOffsets: fieldWritten.fieldMutation.changedByteOffsets,
      stagingRereadVerified: true,
      nonClaim: 'fixture-only field; native .paramdef semantics remain unverified'
    },
    corpusSampled: limit,
    corpusVerified: verified,
    corpusFailed: failed.length,
    failures: failed.slice(0, 5),
    legacyLayout: legacyRead.data.layout,
    legacyByteIdenticalNoop: legacyRead.data.roundTrip.byteIdentical,
    legacyWriterRereadVerified: true,
    containerEntries: count
  }, null, 2));
  if (!corpusComplete) process.exitCode = 2;
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
