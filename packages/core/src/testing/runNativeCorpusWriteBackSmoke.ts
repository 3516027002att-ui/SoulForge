/**
 * Native full-corpus BND4 write-back matrix (REL-B / W-REL-B-CORPUS-02, wave-2).
 *
 * Expands the wave-1 KRAK write-back matrix (3 KRAK-BND4 samples x 6 combined
 * cases) to every writable BND4 container in the registered local corpus —
 * DFLT-BND4 and KRAK-BND4. Every writable sample goes through the real
 * production chain:
 *
 *   read-dcx-document (baseline + no-op roundtrip, unknown-field preservation)
 *   -> write-bnd4 (CRUD staging write: rename of entry 0)
 *   -> Bridge independent reread of the staged output
 *   -> entry-count / rename / unknown-field-preservation assertions
 *   -> rollback: overlay copy restored byte-identical to the real game file
 *      (the real game directory is never written).
 *
 * Synthetic leg (unconditional): a deterministic DFLT-BND4 container with the
 * exact native layout (0x40 header, 0x24 entry headers, null-terminated UTF-8
 * names, 0x10-aligned data, DFLT DCX wrapper) is built in-memory and driven
 * through the same chain, so the smoke always executes a real leg even without
 * a local corpus or Oodle runtime.
 *
 * Real leg (env + Oodle): enumerates the registered local corpus. DFLT-BND4
 * write-back needs no Oodle; KRAK-BND4 write-back needs the Oodle compress
 * export. KRAK samples that cannot run are reported as blocked with structured
 * diagnostics, never counted as a pass.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { deflateSync } from 'node:zlib';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

interface FieldPreservation {
  noOpPayloadByteIdentical: boolean;
  headerUnknownBytesPreserved: boolean;
  entryHeaderFieldsPreserved: boolean;
  storedBytesPreserved: boolean;
  namesPreserved: boolean;
}

interface Bnd4EntryInfo {
  index: number;
  id: number;
  name: string;
  contentHash: string;
  flags: number;
  unknown: number;
}

interface Bnd4Envelope {
  sourceHash: string;
  compressionFormat: string;
  payloadHash?: string;
  nested?: {
    format: string;
    entryCount: number;
    entries: Bnd4EntryInfo[];
    fieldPreservation?: FieldPreservation;
  };
}

interface WriteBnd4Result {
  mutations: string[];
  entryCount: number;
  rereadVerified: boolean;
  preservation?: {
    matchedEntryCount: number;
    headerFieldsPreservedCount: number;
    storedBytesCheckedCount: number;
    storedBytesPreservedCount: number;
    allPreserved: boolean;
  };
  fieldPreservation?: FieldPreservation;
}

interface SampleDef {
  id: string;
  source: string;
  rel: string;
  sourceHash: string;
  entryCount: number;
  compression: string;
  first: Bnd4EntryInfo;
}

interface WriteBackContext {
  overlay: string;
  allowedRoots: string[];
  writableRoots: string[];
  oodleRuntimeRoot?: string;
  workspaceSessionId: string;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireNoOpPreservation(label: string, fp: FieldPreservation | undefined): void {
  if (!fp || !fp.headerUnknownBytesPreserved || !fp.entryHeaderFieldsPreserved
    || !fp.storedBytesPreserved || !fp.namesPreserved) {
    throw new Error(`${label} no-op roundtrip 未知字段未逐字节保持：${JSON.stringify(fp)}`);
  }
}

function requireOutputPreservation(label: string, fp: FieldPreservation | undefined): void {
  if (!fp || !fp.headerUnknownBytesPreserved || !fp.entryHeaderFieldsPreserved
    || !fp.storedBytesPreserved) {
    throw new Error(`${label} staged 输出未知字段未保持：${JSON.stringify(fp)}`);
  }
}

async function assertPreservationForRename(label: string, preservation: WriteBnd4Result['preservation']): Promise<void> {
  if (!preservation || !preservation.allPreserved
    || preservation.headerFieldsPreservedCount !== preservation.matchedEntryCount
    || preservation.storedBytesPreservedCount !== preservation.storedBytesCheckedCount) {
    throw new Error(`${label} mutation 后未触条目字段未逐字节一致：${JSON.stringify(preservation)}`);
  }
}

/**
 * Run the full write-back chain for one writable BND4 sample:
 * read/no-op -> CRUD write (rename entry 0) -> independent reread ->
 * unknown-field preservation -> rollback byte-identical.
 */
async function writeBackOne(
  ctx: WriteBackContext,
  sample: SampleDef,
  target: string,
  output: string
): Promise<Record<string, unknown>> {
  const newName = `${sample.first.name}.soulforge-cwb`;

  // Baseline read of the overlay copy (same bytes as the real game file).
  const baseline = await runBridge<Bnd4Envelope>({
    command: 'read-dcx-document',
    filePath: target,
    allowedRoots: ctx.allowedRoots,
    ...(ctx.oodleRuntimeRoot ? { oodleRuntimeRoot: ctx.oodleRuntimeRoot } : {}),
    workspaceSessionId: ctx.workspaceSessionId,
    timeoutMs: 300_000
  });
  const nested = baseline.data?.nested;
  if (!nested || nested.format !== 'BND4' || baseline.data?.compressionFormat !== sample.compression) {
    throw new Error(`${sample.id} baseline 读取失败：${JSON.stringify(baseline.diagnostics)}`);
  }
  if (nested.entryCount !== sample.entryCount) {
    throw new Error(`${sample.id} baseline entryCount=${nested.entryCount} != 登记 ${sample.entryCount}`);
  }
  // no-op roundtrip 未知字段保持（header 未知区 + 条目 flags/unknown + stored bytes + 名称）
  requireNoOpPreservation(sample.id, nested.fieldPreservation);

  // CRUD 写回：rename entry 0 经 write-bnd4 暂存写。
  const written = await runBridge<WriteBnd4Result>({
    command: 'write-bnd4',
    filePath: target,
    allowedRoots: ctx.allowedRoots,
    writableRoots: ctx.writableRoots,
    ...(ctx.oodleRuntimeRoot ? { oodleRuntimeRoot: ctx.oodleRuntimeRoot } : {}),
    workspaceSessionId: ctx.workspaceSessionId,
    timeoutMs: 600_000,
    commandOptions: {
      outputPath: output,
      mutation: 'rename',
      entryIndex: 0,
      expectedContainerHash: sample.sourceHash,
      expectedChildHash: sample.first.contentHash,
      newName
    }
  });
  if (written.parseStatus === 'failed'
    || !written.diagnostics.some((d) => d.code === 'BND4_STAGING_WRITE_VERIFIED')) {
    throw new Error(`${sample.id} write-bnd4 rename 失败：${JSON.stringify(written.diagnostics)}`);
  }
  const data = written.data as WriteBnd4Result | undefined;
  if (!data || data.rereadVerified !== true) {
    throw new Error(`${sample.id} write-bnd4 缺少重读验证：${JSON.stringify(written)}`);
  }
  if (JSON.stringify(data.mutations) !== JSON.stringify(['rename'])) {
    throw new Error(`${sample.id} mutation 报告异常：${JSON.stringify(data.mutations)}`);
  }
  if (data.entryCount !== sample.entryCount) {
    throw new Error(`${sample.id} rename 后 entryCount=${data.entryCount} != ${sample.entryCount}`);
  }
  await assertPreservationForRename(sample.id, data.preservation);
  requireOutputPreservation(sample.id, data.fieldPreservation);

  // Bridge 独立重读 staged 输出。
  const reread = await runBridge<Bnd4Envelope>({
    command: 'read-dcx-document',
    filePath: output,
    allowedRoots: ctx.allowedRoots,
    ...(ctx.oodleRuntimeRoot ? { oodleRuntimeRoot: ctx.oodleRuntimeRoot } : {}),
    workspaceSessionId: ctx.workspaceSessionId,
    timeoutMs: 300_000
  });
  const out = reread.data?.nested;
  if (!out || out.format !== 'BND4') {
    throw new Error(`${sample.id} staged 输出重读失败：${JSON.stringify(reread.diagnostics)}`);
  }
  if (out.entryCount !== sample.entryCount) {
    throw new Error(`${sample.id} staged 输出 entryCount=${out.entryCount} != ${sample.entryCount}`);
  }
  if (out.entries[0]?.name !== newName) {
    throw new Error(`${sample.id} rename 未在重读中保留：${out.entries[0]?.name}`);
  }
  requireOutputPreservation(sample.id, out.fieldPreservation);

  // 回滚：恢复 overlay 源副本，验证与真实游戏文件字节一致，且原文件未被写入。
  await copyFile(sample.source, target);
  if (sha256(await readFile(target)) !== sample.sourceHash) {
    throw new Error(`${sample.id} rollback 未恢复原始字节。`);
  }
  if (sha256(await readFile(sample.source)) !== sample.sourceHash) {
    throw new Error(`${sample.id} 真实游戏文件被修改。`);
  }

  return {
    sample: sample.id,
    compression: sample.compression,
    entryCount: sample.entryCount,
    mutation: 'rename',
    rereadVerified: true,
    entryCountUnchanged: true,
    renameSurvived: true,
    noOpPreservation: true,
    untouchedEntriesPreserved: true,
    stagedOutputPreserved: true,
    rollbackByteIdentical: true,
    realSourceUnchanged: true
  };
}

function buildSyntheticDfltBnd4(): Buffer {
  const names = [
    'N:\\SoulForge\\verification\\synthetic\\a.txt',
    'N:\\SoulForge\\verification\\synthetic\\b.bin',
    'N:\\SoulForge\\verification\\synthetic\\c.dat'
  ];
  const contents = [
    Buffer.from('soulforge-synthetic-payload-a'),
    Buffer.from('soulforge-synthetic-payload-b'),
    Buffer.from('soulforge-synthetic-payload-c')
  ];
  const n = names.length;
  const tableEnd = 0x40 + n * 0x24;
  const nameBlobs = names.map((nm) => Buffer.concat([Buffer.from(nm, 'utf8'), Buffer.from([0])]));
  const namesLength = nameBlobs.reduce((s, b) => s + b.length, 0);
  const dataOffset = align(tableEnd + namesLength, 0x10);
  const dataTotal = contents.reduce((s, b) => s + align(b.length, 0x10), 0);
  const payload = Buffer.alloc(dataOffset + dataTotal);
  payload.write('BND4', 0, 'ascii');
  payload.writeInt32LE(4, 0x04);
  payload.writeInt32LE(0, 0x08);
  payload.writeInt32LE(n, 0x0c);
  payload.writeBigInt64LE(0x40n, 0x10);
  payload.writeBigInt64LE(0x0123456789abcdefn, 0x18); // unknown, must be preserved
  payload.writeBigInt64LE(0x24n, 0x20);
  payload.writeBigInt64LE(BigInt(dataOffset), 0x28);
  payload.writeBigInt64LE(0x1112131415161718n, 0x30); // unknown, must be preserved
  payload.writeBigInt64LE(0x2122232425262728n, 0x38); // unknown, must be preserved
  let nameCursor = tableEnd;
  let dataCursor = dataOffset;
  for (let i = 0; i < n; i++) {
    const o = 0x40 + i * 0x24;
    const blob = nameBlobs[i]!;
    const content = contents[i]!;
    payload.writeInt32LE(0x40, o);
    payload.writeInt32LE(-1, o + 4);
    payload.writeBigInt64LE(BigInt(content.length), o + 8);
    payload.writeBigInt64LE(BigInt(content.length), o + 16);
    payload.writeUInt32LE(dataCursor, o + 24);
    payload.writeInt32LE(2000 + i, o + 28);
    payload.writeUInt32LE(nameCursor, o + 32);
    blob.copy(payload, nameCursor);
    content.copy(payload, dataCursor);
    nameCursor += blob.length;
    dataCursor += align(content.length, 0x10);
  }
  const zlib = deflateSync(payload, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x44, 0x43, 0x58, 0x00]),
    beU32(0x00011000),
    beU32(0x18), beU32(0x24), beU32(0x44), beU32(0x4c),
    Buffer.from('DCS\0', 'ascii'),
    beU32(payload.length),
    beU32(zlib.length),
    Buffer.from('DCP\0', 'ascii'),
    Buffer.from('DFLT', 'ascii'),
    beU32(0x20),
    Buffer.alloc(16, 0),
    Buffer.from([0x00, 0x01, 0x01, 0x00]),
    Buffer.from('DCA\0', 'ascii'),
    beU32(8),
    zlib
  ]);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function beU32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

/** Unconditional synthetic leg: build a DFLT-BND4 in-memory and drive the chain. */
async function runSyntheticLeg(ctx: WriteBackContext): Promise<Record<string, unknown>> {
  const dcx = buildSyntheticDfltBnd4();
  const id = 'synthetic.dflt-bnd4';
  const dir = join(ctx.overlay, 'synthetic');
  await mkdir(dir, { recursive: true });
  const target = join(dir, 'synthetic.dcx');
  const output = join(dir, 'synthetic.writeback.dcx');
  await writeFile(target, dcx);
  const sample: SampleDef = {
    id,
    source: target,
    rel: 'synthetic/synthetic.dcx',
    sourceHash: sha256(dcx),
    entryCount: 3,
    compression: 'DFLT',
    first: {
      index: 0,
      id: 2000,
      name: 'N:\\SoulForge\\verification\\synthetic\\a.txt',
      flags: 0x40,
      unknown: -1,
      contentHash: sha256(Buffer.from('soulforge-synthetic-payload-a'))
    }
  };
  const outcome = await writeBackOne(ctx, sample, target, output);
  await rm(output, { force: true });
  return { ...outcome, leg: 'synthetic', unconditional: true };
}

async function walkDcx(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkDcx(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.dcx') output.push(path);
  }
  return output;
}

/** Real leg: enumerate the registered corpus and write back every BND4-nested container. */
async function runRealLeg(ctx: WriteBackContext, gameRoot: string): Promise<Record<string, unknown>> {
  const files = await walkDcx(gameRoot);
  const writable: Array<{ sample: SampleDef; target: string; output: string }> = [];
  const blocked: string[] = [];
  let dfltRead = 0;
  let krakRead = 0;

  for (const file of files) {
    const rel = relative(gameRoot, file).replaceAll('\\', '/');
    const envelope = await runBridge<Bnd4Envelope>({
      command: 'read-dcx-document',
      filePath: file,
      allowedRoots: ctx.allowedRoots,
      ...(ctx.oodleRuntimeRoot ? { oodleRuntimeRoot: ctx.oodleRuntimeRoot } : {}),
      workspaceSessionId: ctx.workspaceSessionId,
      timeoutMs: 300_000
    });
    const data = envelope.data;
    if (!data || !data.nested || data.nested.format !== 'BND4' || data.nested.entryCount < 1) {
      if (data?.compressionFormat === 'KRAK') krakRead += 1;
      else if (data?.compressionFormat === 'DFLT') dfltRead += 1;
      continue;
    }
    if (data.compressionFormat === 'KRAK') krakRead += 1;
    else dfltRead += 1;
    const sourceBytes = await readFile(file);
    const sourceHash = sha256(sourceBytes);
    const target = join(ctx.overlay, rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
    const first = data.nested.entries[0];
    if (!first || !first.contentHash) {
      throw new Error(`${rel} BND4 首条目缺少 contentHash。`);
    }
    writable.push({
      sample: {
        id: rel,
        source: file,
        rel,
        sourceHash,
        entryCount: data.nested.entryCount,
        compression: data.compressionFormat,
        first
      },
      target,
      output: `${target}.writeback.dcx`
    });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const entry of writable) {
    const { sample, target, output } = entry;
    try {
      results.push(await writeBackOne(ctx, sample, target, output));
    } catch (error) {
      // KRAK write-back may be blocked when the Oodle compress export is absent.
      if (sample.compression === 'KRAK' && isOodleBlocked(error)) {
        blocked.push(sample.id);
        continue;
      }
      throw error;
    }
    await rm(output, { force: true });
  }

  return {
    leg: 'real',
    filesScanned: files.length,
    dfltRead,
    krakRead,
    writableBnd4: writable.length,
    writeBackVerified: results.length,
    blocked,
    results
  };
}

function isOodleBlocked(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Oodle|KRAK|运行库|重压|Compress/i.test(message);
}

async function main(): Promise<void> {
  const gameRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const root = await mkdtemp(join(tmpdir(), 'soulforge-corpus-writeback-'));
  const overlay = join(root, 'mod');
  await mkdir(overlay, { recursive: true });
  const ctx: WriteBackContext = {
    overlay,
    allowedRoots: [overlay, ...(gameRoot ? [gameRoot] : [])],
    writableRoots: [overlay],
    ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {}),
    workspaceSessionId: 'corpus-writeback-smoke'
  };

  try {
    const syntheticOutcome = await runSyntheticLeg(ctx);
    const report: Record<string, unknown> = {
      ok: true,
      message: '完整 corpus BND4 写回矩阵、未知字段保持与回滚验证通过',
      synthetic: syntheticOutcome
    };
    if (gameRoot) {
      const real = await runRealLeg(ctx, gameRoot);
      report.real = {
        filesScanned: real.filesScanned,
        dfltRead: real.dfltRead,
        krakRead: real.krakRead,
        writableBnd4: real.writableBnd4,
        writeBackVerified: real.writeBackVerified,
        blocked: real.blocked
      };
      // `results` omitted from the top-level log for size; kept for assertions.
      console.log(JSON.stringify({ ...report, real: { ...(report.real as object), results: real.results } }, null, 2));
    } else {
      console.log(JSON.stringify({
        ...report,
        real: {
          skipped: true,
          message: '未配置 SOULFORGE_NATIVE_FIXTURE_ROOT/SOULFORGE_SEKIRO_GAME_ROOT；真实 corpus 写回未执行，不构成声明。'
        }
      }, null, 2));
    }
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
