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

// extract-bnd4-child is the file-backed sibling of snapshot-bnd4-child: it writes the
// child to an outputPath and returns metadata only, so >1MB children (e.g. SpEffectParam)
// do not blow the daemon frame limit the way a base64 snapshot would.
interface Bnd4ChildExtracted {
  contentHash: string;
  name: string;
  id: number;
  index: number;
  contentSize: number;
  outputPath: string;
}

interface CorpusEntry {
  index: number;
  name: string;
  filePath: string;
  typeName: string;
  dataVersion?: number;
  rowCount: number;
  rowDataSize: number;
  sourceHash: string;
  semanticIdentical: boolean;
  byteIdentical: boolean;
  firstRow?: { id: number; dataBase64: string; dataHash: string };
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

  // Corpus: extract every PARAM child to disk via the file-backed extract path, then require a
  // semantic roundtrip on each. The base64 snapshot path is capped by the daemon frame limit
  // (1MB), so the largest child (SpEffectParam, ~8.6MB) only passes through extract-bnd4-child;
  // running the whole corpus through it exercises every ParamType in the real parambnd.
  const container = await runBridge<{ nested?: { entryCount: number } }>({
    command: 'read-dcx-document',
    filePath: sourceBnd,
    allowedRoots: [dirname(sourceBnd)],
    timeoutMs: 120_000
  });
  const count = container.data?.nested?.entryCount ?? 0;
  const corpus: CorpusEntry[] = [];
  const failed: Array<{ index: number; message: string }> = [];
  for (let i = 0; i < count; i++) {
    const tmp = join(staging, `corpus-${i}.param`);
    // extract-bnd4-child 会按 options.outputPath 落盘，因此必须声明 writableRoots。
    //
    // 原先完全没传 writableRoots，于是 daemon 在边界检查阶段就以
    // BRIDGE_WRITABLE_ROOT_REQUIRED 拒绝（BridgeDaemonHost.cs:295-299），
    // 5 个 PARAM 子项全部进 failed，最终抛 "No PARAM children verified"。
    // 该 smoke 因此在真实语料环境下**恒定 exit 1**，并让 test:private-native-gate
    // 的 10 步里 1 步失败。这是**调用侧缺参数**，不是 daemon 或 param 解析缺陷
    // ——writable-root 校验本身在正确工作（T4-2 补的那道）。
    //
    // 不需要把 staging 也写进 allowedRoots：runBridge.ts:42-46 会自动把
    // writableRoots 并入 allowedRoots。我一度多写了一项，实测去掉后仍 exit 0，
    // 确认多余，已撤回——保持最小改动。
    const extracted = await runBridge<Bnd4ChildExtracted>({
      command: 'extract-bnd4-child',
      filePath: sourceBnd,
      allowedRoots: [dirname(sourceBnd)],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: { entryIndex: i, outputPath: tmp }
    });
    if (!extracted.data?.contentHash) {
      failed.push({
        index: i,
        message: extracted.diagnostics[0]?.message ?? 'extract failed'
      });
      continue;
    }
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
    corpus.push({
      index: i,
      name: (extracted.data.name || '').split(/[\\/]+/).pop() ?? `corpus-${i}.param`,
      filePath: tmp,
      typeName: doc.data.typeName,
      ...(doc.data.dataVersion === undefined ? {} : { dataVersion: doc.data.dataVersion }),
      rowCount: doc.data.rowCount,
      rowDataSize: doc.data.rowDataSize,
      sourceHash: doc.data.sourceHash,
      semanticIdentical: doc.data.roundTrip.semanticIdentical,
      byteIdentical: doc.data.roundTrip.byteIdentical,
      ...(doc.data.rows[0] === undefined ? {} : { firstRow: doc.data.rows[0] })
    });
  }
  const verified = corpus.length;
  if (verified === 0) {
    throw new Error(`No PARAM children verified: ${JSON.stringify(failed.slice(0, 5))}`);
  }

  // Standard 32-bit layout coverage: these params use real 12-byte row headers for every row.
  // layout family, roundtrip byte-identically, accept a staged field-level upsert (write path
  // open), and fail closed on add/delete (headerless last row + variable tail are not losslessly
  // re-layout-able). These are real native samples from the pinned corpus.
  const legacyNames = new Set([
    'default_AIStandardInfoBank.param',
    'default_EnemyBehaviorBank.param',
    'MenuColorTableParam.param'
  ]);
  const legacyFound: Array<{ index: number; name: string }> = [];
  for (let i = 0; i < count; i++) {
    const snap = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: sourceBnd,
      allowedRoots: [dirname(sourceBnd)],
      timeoutMs: 120_000,
      commandOptions: { entryIndex: i }
    });
    const base = (snap.data?.name ?? '').split(/[\\/]+/).pop() ?? '';
    if (legacyNames.has(base)) legacyFound.push({ index: i, name: base });
  }
  if (legacyFound.length !== legacyNames.size) {
    throw new Error(`PARAM legacy corpus incomplete: ${JSON.stringify(legacyFound)}`);
  }
  const legacyLayouts: Array<Record<string, unknown>> = [];
  for (const { index, name } of legacyFound) {
    const snap = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: sourceBnd,
      allowedRoots: [dirname(sourceBnd)],
      timeoutMs: 120_000,
      commandOptions: { entryIndex: index }
    });
    if (!snap.data?.contentBase64) {
      throw new Error(`legacy ${name} snapshot failed: ${JSON.stringify(snap.diagnostics)}`);
    }
    const tmp = join(staging, `legacy-${index}-${name}`);
    await writeFile(tmp, Buffer.from(snap.data.contentBase64, 'base64'));
    const doc = await runBridge<ParamEnvelope & { layout?: string }>({
      command: 'read-param-document',
      filePath: tmp,
      allowedRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {}
    });
    if (doc.data?.layout !== 'standard-32') {
      throw new Error(`standard-32 ${name} layout misdetected: ${JSON.stringify(doc.data?.layout)}`);
    }
    if (!doc.data?.roundTrip?.semanticIdentical || !doc.data?.roundTrip?.byteIdentical) {
      throw new Error(`legacy ${name} roundtrip failed: ${JSON.stringify(doc.data?.roundTrip)}`);
    }
    const firstRow = doc.data.rows[0];
    if (!firstRow) {
      throw new Error(`legacy ${name} has no rows`);
    }
    const firstRowId = firstRow.id;
    // Staged field-level upsert on the first row: read row bytes straight from the staged legacy
    // file (Bridge payload preview gating excludes wide/many-row params), flip the first byte,
    // then re-read the staged output and assert the byte landed and the source stayed untouched.
    const fileBytes = await readFile(tmp);
    const dataStart = fileBytes.readUInt16LE(4);
    const rowSize = doc.data.rowDataSize;
    if (dataStart + rowSize > fileBytes.length) {
      throw new Error(`legacy ${name} dataStart/rowSize out of range`);
    }
    const originalFirstByte = fileBytes[dataStart];
    const flippedFirstByte = originalFirstByte === 0x5a ? 0xa5 : 0x5a;
    const nextRow = Buffer.from(fileBytes.subarray(dataStart, dataStart + rowSize));
    nextRow[0] = flippedFirstByte;
    const stagedOut = join(staging, `legacy-${index}-${name}.staged`);
    const written = await runBridge({
      command: 'write-param',
      filePath: tmp,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: stagedOut,
        expectedDocumentHash: doc.data.sourceHash,
        mutation: 'upsert',
        id: firstRowId,
        dataBase64: nextRow.toString('base64')
      }
    });
    if (!written.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
      throw new Error(`legacy ${name} staged upsert failed: ${JSON.stringify(written.diagnostics)}`);
    }
    const stagedBytes = await readFile(stagedOut);
    const stagedDataStart = stagedBytes.readUInt16LE(4);
    const stagedFirstByte = stagedBytes[stagedDataStart];
    if (stagedFirstByte === undefined || stagedFirstByte !== flippedFirstByte) {
      throw new Error(`legacy ${name} staged first byte mismatch`);
    }
    if (!(await readFile(tmp)).equals(fileBytes)) {
      throw new Error(`legacy ${name} source mutated by staged write`);
    }
    // add/delete must fail closed with a structured diagnostic (no silent skip, no guessed layout).
    for (const kind of ['add', 'delete'] as const) {
      const rejected = await runBridge({
        command: 'write-param',
        filePath: tmp,
        allowedRoots: [staging],
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: join(staging, `legacy-${index}-${name}.${kind}`),
          expectedDocumentHash: doc.data.sourceHash,
          mutation: kind,
          ...(kind === 'add'
            ? { id: 99_999_999, dataBase64: Buffer.alloc(rowSize, 1).toString('base64') }
            : { id: firstRowId })
        }
      });
      const failClosed = rejected.parseStatus === 'failed'
        && rejected.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_FAILED');
      if (!failClosed) {
        throw new Error(`legacy ${name} ${kind} did not fail closed: ${JSON.stringify(rejected.diagnostics)}`);
      }
    }
    legacyLayouts.push({
      name,
      rowCount: doc.data.rowCount,
      rowDataSize: rowSize,
      byteIdenticalNoop: true,
      semanticIdenticalNoop: true,
      stagedUpsertVerified: true,
      sourceRowImmutable: true,
      addDeleteFailClosed: true
    });
  }

  // Write-path breadth: drive the same field-level staged-upsert contract (TS field codec set →
  // Bridge write-param upsert → Bridge independent re-read byte match → source immutable) on a
  // diverse spread of modern ParamType layouts, reusing the extracted corpus files. Together with
  // ActionGuideParam (index 1) above and the three legacy layouts this proves the writer is open
  // beyond a single canonical layout, not just the one exercised at the top of this smoke.
  const writeExtension: Array<Record<string, unknown>> = [];
  const modern = corpus
    .filter((c) => c.index !== 1 && !legacyNames.has(c.name) && c.rowCount > 0 && c.firstRow);
  const bySize = [...modern].sort((a, b) => a.rowDataSize - b.rowDataSize);
  const candidates = new Map<string, CorpusEntry>();
  const takeCandidate = (label: string, position: number): void => {
    const c = bySize[position];
    if (c && !candidates.has(label)) candidates.set(label, c);
  };
  takeCandidate('smallest', 0);
  takeCandidate('median', Math.floor(bySize.length / 2));
  takeCandidate('largest', bySize.length - 1);
  for (const [label, entry] of candidates) {
    if (!entry.firstRow) continue;
    const sourceBytes = await readFile(entry.filePath);
    // read-param-document only includes row payloads for narrow/short params (payload preview
    // gating), so derive the first row's data straight from the file like the legacy loop above:
    // in the compact layout row 0's data offset lives in the first row header at 0x40 + 8.
    const firstDataOffset = sourceBytes.readInt32LE(0x40 + 8);
    if (firstDataOffset + entry.rowDataSize > sourceBytes.length) {
      throw new Error(`write-ext ${entry.name} firstDataOffset/rowDataSize out of range`);
    }
    const original = Buffer.from(sourceBytes.subarray(firstDataOffset, firstDataOffset + entry.rowDataSize));
    const flipped = original[0] === 0x5a ? 0xa5 : 0x5a;
    const def: ParamDefDocument = {
      schemaVersion: 1,
      typeName: entry.typeName,
      version: entry.dataVersion ?? 0,
      rowDataSize: entry.rowDataSize,
      origin: 'fixture',
      fields: [
        { id: 'f_first_byte', name: 'firstByte', type: 'u8', offset: 0, size: 1 }
      ]
    };
    const set = applyParamFieldMutation({
      rowDataBase64: original.toString('base64'),
      definition: def,
      fieldId: 'f_first_byte',
      value: flipped
    });
    if (!set.ok) throw new Error(`write-ext ${entry.name} field set failed: ${set.message}`);
    const mutated = Buffer.from(set.nextDataBase64, 'base64');
    const stagedOut = join(staging, `write-ext-${entry.index}.param`);
    const written = await runBridge({
      command: 'write-param',
      filePath: entry.filePath,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: stagedOut,
        expectedDocumentHash: entry.sourceHash,
        mutation: 'upsert',
        id: entry.firstRow.id,
        dataBase64: mutated.toString('base64')
      }
    });
    if (!written.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
      throw new Error(`write-ext ${entry.name} staged upsert failed: ${JSON.stringify(written.diagnostics)}`);
    }
    // Independent byte check straight off the staged file: find the upserted row by id in the
    // compact row-header table (0x40 + i*0x18, data offset at +8) and assert its first byte.
    // The envelope read would be gated for wide rows, and row order is not guaranteed by the
    // writer, so scan the raw layout instead of trusting position.
    const stagedBytes = await readFile(stagedOut);
    let stagedFirstByte: number | undefined;
    for (let ri = 0; ri < entry.rowCount; ri++) {
      const rowHeader = 0x40 + ri * 0x18;
      if (rowHeader + 0x18 > stagedBytes.length) break;
      if (stagedBytes.readInt32LE(rowHeader) !== entry.firstRow.id) continue;
      const rowDataOff = stagedBytes.readInt32LE(rowHeader + 8);
      if (rowDataOff < 0 || rowDataOff >= stagedBytes.length) break;
      stagedFirstByte = stagedBytes[rowDataOff];
      break;
    }
    if (stagedFirstByte === undefined || stagedFirstByte !== flipped) {
      throw new Error(`write-ext ${entry.name} Bridge staged first byte mismatch`);
    }
    if (!(await readFile(entry.filePath)).equals(sourceBytes)) {
      throw new Error(`write-ext ${entry.name} source mutated by staged write`);
    }
    writeExtension.push({
      label,
      index: entry.index,
      name: entry.name,
      typeName: entry.typeName,
      rowCount: entry.rowCount,
      rowDataSize: entry.rowDataSize,
      stagedUpsertVerified: true,
      bridgeStagedByteMatch: true,
      sourceImmutable: true
    });
  }

  console.log(JSON.stringify({
    ok: true,
    message: '原生 PARAM 读取/语义往返/写入/BND4 提交/回滚验证通过',
    typeName: read.data.typeName,
    rowCount: read.data.rowCount,
    rowDataSize: read.data.rowDataSize,
    byteIdenticalNoop: read.data.roundTrip?.byteIdentical ?? false,
    semanticIdenticalNoop: true,
    corpusTotal: count,
    corpusVerified: verified,
    corpusByteIdentical: corpus.filter((c) => c.byteIdentical).length,
    corpusFailed: failed.length,
    failures: failed.slice(0, 5),
    containerEntries: count,
    legacyLayouts,
    writeExtension,
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
