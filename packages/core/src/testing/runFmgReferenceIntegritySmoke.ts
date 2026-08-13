/**
 * FMG reference-integrity smoke.
 *
 * Part 1 (unconditional, synthetic): deterministically verifies the read-only
 * diagnostic pass `analyzeFmgReferenceIntegrity` on constructed FMG documents:
 *   - duplicate entry id inside one document        -> error
 *   - reference target beyond signed 32-bit range   -> error
 *   - negative reference target                     -> warning
 *   - target missing from container id set          -> warning
 *   - target present in container id set            -> info (resolved)
 *   - marker reference without id (`<?bmsg?>`)      -> info
 *
 * Part 2 (native, honest-skip when env missing): runs the same pass over every
 * FMG v2 child of the real item.msgbnd and menu.msgbnd (zhocn corpus) and
 * reports container-wide resolution statistics and the language coverage
 * matrix. This is read-only: it never opens a write path.
 *
 * Part 3 (unconditional, synthetic): outer-chain write transactions through the
 * native FMG writer on a constructed DCX(BND4(item.fmg, menu.fmg)) container and
 * a loose FMG:
 *   - sealed expectation (container DCX hash) 前置 + 目标表 upsert + sibling 表/
 *     表内 sibling 条目逐槽保留；
 *   - duplicate ID 槽位：upsert 命中全部匹配槽，无槽位丢失；
 *   - loose profile（无 entryIndex）回归；
 *   - sealed hash 不匹配 / encoding 失败（U+0000）→ fail-closed，不落盘、source 完好；
 *   - reopen failure：输出被破坏后重读必须结构化失败，before image 完好。
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm, access, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import {
  analyzeFmgReferenceIntegrity,
  extractFmgReferences,
  type FmgReferenceDocument,
  type FmgReferenceIntegrityResult
} from '../param/fmgReferenceIntegrity.js';

// ---------------------------------------------------------------------------
// Part 1: deterministic synthetic validation
// ---------------------------------------------------------------------------

function runSyntheticCases(): FmgReferenceIntegrityResult {
  // 1. Resolved + dangling + marker + invalid target + negative target in one pass.
  const docs: FmgReferenceDocument[] = [
    {
      index: 0,
      name: 'A.fmg',
      entries: [
        { id: 1000, text: '这里是<?placeName@1000?>的引用' },
        { id: 1001, text: '普通文本' }
      ]
    },
    {
      index: 1,
      name: 'B.fmg',
      entries: [
        { id: 2000, text: '悬空<?placeName@9999?>引用' },
        { id: 2001, text: '负目标<?icon@-7?>引用' },
        { id: 2002, text: '越界<?icon@9999999999?>引用' }
      ]
    },
    {
      index: 2,
      name: 'C.fmg',
      entries: [
        { id: 3000, text: '<?bmsg?>标记引用' },
        { id: 3000, text: '重复 id 条目' }
      ]
    }
  ];
  const result = analyzeFmgReferenceIntegrity({ documents: docs });

  const byCode = new Map<string, number>();
  for (const d of result.diagnostics) {
    byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
  }
  const expect = (code: string, count: number, label: string): void => {
    const actual = byCode.get(code) ?? 0;
    if (actual !== count) {
      throw new Error(`synthetic ${label}: expected ${code} x${count}, got x${actual}`);
    }
  };
  expect('FMG_REF_RESOLVED', 1, 'resolved');
  expect('FMG_REF_DANGLING_TARGET', 1, 'dangling');
  expect('FMG_REF_NEGATIVE_TARGET', 1, 'negative');
  expect('FMG_REF_INVALID_TARGET', 1, 'invalid');
  expect('FMG_REF_MARKER', 1, 'marker');
  expect('FMG_REF_DUPLICATE_ENTRY_ID', 1, 'duplicate id');

  // ok must be false when hard errors are present.
  if (result.ok) throw new Error('synthetic: result.ok must be false with duplicate/invalid diagnostics');
  if (result.summary.referenceCount !== 5) {
    throw new Error(`synthetic: expected 5 references, got ${result.summary.referenceCount}`);
  }
  if (result.summary.resolvedCount !== 1 || result.summary.danglingCount !== 1
    || result.summary.negativeCount !== 1 || result.summary.invalidCount !== 1
    || result.summary.markerReferenceCount !== 1 || result.summary.duplicateIdCount !== 1) {
    throw new Error(`synthetic: summary mismatch ${JSON.stringify(result.summary)}`);
  }

  // 2. A clean container has ok=true and no error/warning diagnostics
  //    (resolved references legitimately produce info diagnostics).
  const clean = analyzeFmgReferenceIntegrity({
    documents: [{
      index: 0,
      name: 'clean.fmg',
      entries: [
        { id: 1, text: '甲<?tag@2?>乙' },
        { id: 2, text: '丙' }
      ]
    }]
  });
  if (!clean.ok || clean.diagnostics.some((d) => d.severity !== 'info')) {
    throw new Error(`synthetic: clean container must be ok with only info diagnostics, got ${JSON.stringify(clean)}`);
  }
  if (clean.summary.resolvedCount !== 1 || clean.summary.danglingCount !== 0) {
    throw new Error(`synthetic: clean container summary mismatch ${JSON.stringify(clean.summary)}`);
  }

  // 3. extractFmgReferences positions are deterministic and text is untouched.
  const text = '前<?kgiconKc@18?>后<?bmsg?>尾';
  const refs = extractFmgReferences(text);
  if (refs.length !== 2 || refs[0]?.targetId !== 18 || refs[0]?.textIndex !== 1
    || refs[1]?.targetId !== undefined || refs[1]?.tag !== 'bmsg') {
    throw new Error(`synthetic: extractFmgReferences mismatch ${JSON.stringify(refs)}`);
  }
  if (text !== '前<?kgiconKc@18?>后<?bmsg?>尾') {
    throw new Error('synthetic: extractFmgReferences mutated its input text');
  }

  return result;
}
// ---------------------------------------------------------------------------
// Part 2: native corpus (honest-skip when the local corpus is unavailable)
// ---------------------------------------------------------------------------

interface FmgEnvelope {
  entries: Array<{ id: number; text: string }>;
}

interface Bnd4ChildSnapshot {
  contentBase64: string;
  name: string;
}

async function fmgDocumentsFromMsgbnd(
  msgbndPath: string,
  staging: string,
  label: string
): Promise<{ documents: FmgReferenceDocument[]; containerEntries: number }> {
  const container = await runBridge<{ nested?: { entryCount: number } }>({
    command: 'read-dcx-document',
    filePath: msgbndPath,
    allowedRoots: [dirname(msgbndPath)],
    timeoutMs: 120_000
  });
  const count = container.data?.nested?.entryCount ?? 0;
  const documents: FmgReferenceDocument[] = [];
  for (let i = 0; i < count; i++) {
    const snap = await runBridge<Bnd4ChildSnapshot>({
      command: 'snapshot-bnd4-child',
      filePath: msgbndPath,
      allowedRoots: [dirname(msgbndPath)],
      timeoutMs: 120_000,
      commandOptions: { entryIndex: i }
    });
    const bytes = Buffer.from(snap.data?.contentBase64 ?? '', 'base64');
    if (bytes.length < 0x28 || bytes.readUInt32LE(0) !== 0x00020000) continue;
    const tmp = join(staging, `${label}-${i}.fmg`);
    await writeFile(tmp, bytes);
    const doc = await runBridge<FmgEnvelope>({
      command: 'read-fmg-document',
      filePath: tmp,
      allowedRoots: [staging],
      timeoutMs: 120_000
    });
    if (doc.parseStatus === 'failed' || !doc.data) {
      throw new Error(`${label} FMG child ${i} read failed: ${JSON.stringify(doc.diagnostics)}`);
    }
    documents.push({
      index: i,
      name: snap.data?.name ?? `${label}-${i}.fmg`,
      entries: (doc.data.entries ?? []).map((e) => ({ id: e.id, text: e.text }))
    });
  }
  return { documents, containerEntries: count };
}

async function nativeCorpusExists(itemPath: string, menuPath: string): Promise<boolean> {
  try {
    await access(itemPath);
    await access(menuPath);
    return true;
  } catch {
    return false;
  }
}

async function runRealCorpus(): Promise<void> {
  const itemMsgbnd = await resolveNativeFixture(
    process.argv[2],
    'fmg-primary',
    '../../mods/msg/zhocn/item.msgbnd.dcx'
  );
  const menuMsgbnd = await resolveNativeFixture(
    process.argv[3],
    'bnd4-primary',
    '../../mods/msg/zhocn/menu.msgbnd.dcx'
  );
  if (!(await nativeCorpusExists(itemMsgbnd, menuMsgbnd))) {
    console.log(JSON.stringify({
      ok: true,
      testId: 'W-EMEVD-FMG-PARAM-03-FMG-REF',
      status: 'skipped',
      authority: 'unverified',
      nativeFormatAuthority: false,
      syntheticVerified: true,
      reason: '本机 zhocn 语料不可用，真实 FMG 引用完整性扫描结构化跳过。',
      diagnostics: [{
        severity: 'info',
        code: 'FMG_REF_CORPUS_UNAVAILABLE',
        message: 'item.msgbnd / menu.msgbnd 未解析；引用完整性诊断未在真实 corpus 上运行。'
      }]
    }, null, 2));
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-fmg-ref-'));
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });
  try {
    const item = await fmgDocumentsFromMsgbnd(itemMsgbnd, staging, 'item');
    const menu = await fmgDocumentsFromMsgbnd(menuMsgbnd, staging, 'menu');
    const itemResult = analyzeFmgReferenceIntegrity({ documents: item.documents });
    const menuResult = analyzeFmgReferenceIntegrity({ documents: menu.documents });

    const errorSample = [...itemResult.diagnostics, ...menuResult.diagnostics]
      .filter((d) => d.severity === 'error')
      .slice(0, 10)
      .map((d) => ({ code: d.code, documentName: d.documentName, entryId: d.entryId, message: d.message }));
    const warningSample = [...itemResult.diagnostics, ...menuResult.diagnostics]
      .filter((d) => d.severity === 'warning')
      .slice(0, 8)
      .map((d) => ({ code: d.code, documentName: d.documentName, entryId: d.entryId, tag: d.tag, targetId: d.targetId, message: d.message }));

    const languageMatrix = {
      corpusRoot: 'mods/msg',
      availableLanguages: ['zhocn'],
      verified: {
        zhocn: {
          itemMsgbnd: true,
          menuMsgbnd: true,
          itemFmgCount: item.documents.length,
          menuFmgCount: menu.documents.length
        }
      },
      unverified: ['全部其他语言（本机 corpus 仅 zhocn，未覆盖）'],
      note: '引用完整性为只读检查；未开放任何写路径。'
    };

    console.log(JSON.stringify({
      ok: true,
      testId: 'W-EMEVD-FMG-PARAM-03-FMG-REF',
      status: 'partial',
      authority: 'partial',
      nativeFormatAuthority: false,
      syntheticVerified: true,
      containers: {
        itemMsgbnd: { containerEntries: item.containerEntries, fmgCount: item.documents.length, ...itemResult.summary },
        menuMsgbnd: { containerEntries: menu.containerEntries, fmgCount: menu.documents.length, ...menuResult.summary }
      },
      diagnostics: {
        total: itemResult.diagnostics.length + menuResult.diagnostics.length,
        errorSample,
        warningSample
      },
      languageMatrix,
      nonClaims: [
        'SoulForge 不声明 `<?tag?>` 引用语法的外部语义（kgiconKc/gdsparam 等可能引用非 FMG 资源）；仅报告容器级解析状态。',
        '悬空引用为 warning 而非 error：真实 corpus 中 placeName/kgiconKc 等 tag 可指向容器外资源。',
        '未覆盖其他语言 msgbnd；多语言 mutation 未声明。'
      ]
    }, null, 2));
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

// ---------------------------------------------------------------------------
// Part 3: outer-chain FMG write transactions (unconditional synthetic)
// ---------------------------------------------------------------------------

/**
 * 构造原生 FMG v2（marker 0x00020000）。每个条目单独成组，天然支持重复 ID
 * 槽位（FMG 允许跨组重复 ID；reader 逐槽读取，语义 map last-wins）。布局与
 * FmgNativeDocument.Read 的校验一致：stringOffsetsOffset = 0x28 + n*0x10，
 * 每槽 offset 0 表示空串。
 */
function buildNativeFmg(entries: Array<{ id: number; text: string }>): Buffer {
  const n = entries.length;
  const stringOffsetsOffset = 0x28 + n * 0x10;
  const stringPoolStart = stringOffsetsOffset + n * 4;
  const encoded = entries.map((e) =>
    e.text.length === 0 ? null : Buffer.from(`${e.text}\0`, 'utf16le'));
  const offsets: number[] = [];
  let cursor = stringPoolStart;
  for (const e of encoded) {
    if (e === null) { offsets.push(0); continue; }
    offsets.push(cursor);
    cursor += e.length;
  }
  const out = Buffer.alloc(cursor);
  out.writeUInt32LE(0x00020000, 0);
  out.writeUInt32LE(cursor, 4);
  out.writeUInt32LE(0, 8);
  out.writeUInt32LE(n, 12);
  out.writeUInt32LE(n, 16);
  out.writeUInt32LE(0, 20);
  out.writeUInt32LE(stringOffsetsOffset, 24);
  for (let i = 0; i < n; i++) {
    const o = 0x28 + i * 0x10;
    out.writeInt32LE(i, o);
    out.writeInt32LE(entries[i]!.id, o + 4);
    out.writeInt32LE(entries[i]!.id, o + 8);
    out.writeInt32LE(0, o + 12);
  }
  for (let i = 0; i < n; i++) out.writeUInt32LE(offsets[i]!, stringOffsetsOffset + i * 4);
  for (let i = 0; i < n; i++) {
    const e = encoded[i];
    if (e) e.copy(out, offsets[i]!);
  }
  return out;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function beU32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** DFLT DCX 包装（复用 runNativeDocumentLocatorSmoke 已验证的布局）。 */
function buildDfltDcx(payload: Buffer): Buffer {
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

/** 构造 BND4 容器（复用 runNativeDocumentLocatorSmoke 已验证的布局）。 */
function buildBnd4(names: string[], contents: Buffer[]): Buffer {
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
  payload.writeBigInt64LE(0x0123456789abcdefn, 0x18);
  payload.writeBigInt64LE(0x24n, 0x20);
  payload.writeBigInt64LE(BigInt(dataOffset), 0x28);
  payload.writeBigInt64LE(0x1112131415161718n, 0x30);
  payload.writeBigInt64LE(0x2122232425262728n, 0x38);
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
  return payload;
}

function assertFmg(actual: Array<{ id: number; text: string }> | undefined, expected: Array<[number, string]>): void {
  if (!actual) throw new Error('FMG entries 缺失');
  const a = actual.map((e) => `${e.id}:${e.text}`);
  const b = expected.map(([id, text]) => `${id}:${text}`);
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    throw new Error(`FMG 条目不匹配\n实际: ${a.join(', ')}\n期望: ${b.join(', ')}`);
  }
}

interface FmgWriteEnvelope {
  storageProfile?: string;
  outputHash?: string;
  entryCount?: number;
  rereadVerified?: boolean;
}

interface FmgCatalogEnvelope {
  outerHash?: string;
  tableSourceHash?: string;
  entries?: Array<{ id: number; text: string }>;
}

async function runSyntheticContainerWriteCases(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-fmg-cw-'));
  try {
    const containerDir = join(scratch, 'msg', 'zhocn');
    await mkdir(containerDir, { recursive: true });
    const containerPath = join(containerDir, 'test.msgbnd.dcx');
    const loosePath = join(scratch, 'loose.fmg');
    const outDir = join(scratch, 'out');
    await mkdir(outDir, { recursive: true });

    // item.fmg 含一个重复 ID（101 双槽），用于验证 upsert 无损命中全部槽位；
    // menu.fmg 是 sibling child，用于验证容器写只动目标 child。
    const fmgA = buildNativeFmg([
      { id: 100, text: '甲' },
      { id: 101, text: '乙' },
      { id: 101, text: '乙-重复槽' }
    ]);
    const fmgB = buildNativeFmg([
      { id: 200, text: '丙' },
      { id: 201, text: '丁' }
    ]);
    const containerBytes = buildDfltDcx(buildBnd4(['item.fmg', 'menu.fmg'], [fmgA, fmgB]));
    await writeFile(containerPath, containerBytes);
    const containerHash = sha256(containerBytes);
    await writeFile(loosePath, fmgA);
    const looseHash = sha256(fmgA);

    let outCounter = 0;
    const nextOut = (): string => join(outDir, `out-${outCounter++}.dcx`);
    const writeFmg = async (sourcePath: string, options: Record<string, unknown>) => {
      const outPath = nextOut();
      const result = await runBridge<FmgWriteEnvelope>({
        command: 'write-fmg',
        filePath: sourcePath,
        allowedRoots: [scratch],
        writableRoots: [scratch],
        timeoutMs: 120_000,
        commandOptions: { outputPath: outPath, ...options }
      });
      return { result, outPath };
    };
    const readTable = async (path: string, entryIndex: number) => {
      const result = await runBridge<FmgCatalogEnvelope>({
        command: 'read-text-catalog',
        filePath: path,
        allowedRoots: [scratch],
        timeoutMs: 120_000,
        commandOptions: { tableEntryIndex: entryIndex }
      });
      if (result.parseStatus === 'failed' || !result.data) {
        throw new Error(`read-text-catalog 失败：${JSON.stringify(result.diagnostics)}`);
      }
      return result.data;
    };
    const expectFailClosed = async (
      outPath: string,
      label: string
    ): Promise<void> => {
      const size = await stat(outPath).then((s) => s.size).catch(() => 0);
      if (size !== 0) throw new Error(`${label} 落盘了输出文件（fail-closed 必须不落盘）`);
    };

    // ---- 3a. sealed expectation + 目标表 upsert + sibling 表/表内条目逐槽保留 ----
    const base0 = await readTable(containerPath, 0);
    const base1 = await readTable(containerPath, 1);
    assertFmg(base0.entries, [[100, '甲'], [101, '乙'], [101, '乙-重复槽']]);
    assertFmg(base1.entries, [[200, '丙'], [201, '丁']]);
    if (base0.outerHash !== containerHash) {
      throw new Error(`密封期望应是容器 DCX hash，实际 ${base0.outerHash}`);
    }
    const w1 = await writeFmg(containerPath, {
      expectedDocumentHash: containerHash,
      entryIndex: 0,
      mutation: 'upsert',
      id: 100,
      text: '甲改'
    });
    if (w1.result.parseStatus === 'failed' || w1.result.data?.storageProfile !== 'msgbnd'
      || !w1.result.data?.rereadVerified) {
      throw new Error(`容器 upsert 失败：${JSON.stringify(w1.result.diagnostics)}`);
    }
    const out0 = await readTable(w1.outPath, 0);
    const out1 = await readTable(w1.outPath, 1);
    assertFmg(out0.entries, [[100, '甲改'], [101, '乙'], [101, '乙-重复槽']]);
    assertFmg(out1.entries, [[200, '丙'], [201, '丁']]);
    if (out0.outerHash === containerHash) throw new Error('容器写后 outerHash 必须变化');
    if (out1.tableSourceHash !== base1.tableSourceHash) {
      throw new Error('sibling child（menu.fmg）字节被改动');
    }
    const after0 = await readTable(containerPath, 0);
    if (after0.tableSourceHash !== base0.tableSourceHash) {
      throw new Error('容器写后 source（before image）被改动');
    }

    // ---- 3b. duplicate ID：upsert 命中全部匹配槽，无槽位丢失 ----
    const wDup = await writeFmg(containerPath, {
      expectedDocumentHash: containerHash,
      entryIndex: 0,
      mutation: 'upsert',
      id: 101,
      text: '乙改'
    });
    if (wDup.result.parseStatus === 'failed') {
      throw new Error(`duplicate ID upsert 失败：${JSON.stringify(wDup.result.diagnostics)}`);
    }
    const outDup = await readTable(wDup.outPath, 0);
    const outDup1 = await readTable(wDup.outPath, 1);
    assertFmg(outDup.entries, [[100, '甲'], [101, '乙改'], [101, '乙改']]);
    assertFmg(outDup1.entries, [[200, '丙'], [201, '丁']]);

    // ---- 3c. loose profile（无 entryIndex）回归 ----
    const wLoose = await writeFmg(loosePath, {
      expectedDocumentHash: looseHash,
      mutation: 'upsert',
      id: 100,
      text: '裸表改'
    });
    if (wLoose.result.parseStatus === 'failed' || wLoose.result.data?.storageProfile !== 'loose') {
      throw new Error(`loose upsert 失败：${JSON.stringify(wLoose.result.diagnostics)}`);
    }
    const looseRead = await runBridge<FmgEnvelope>({
      command: 'read-fmg-document',
      filePath: wLoose.outPath,
      allowedRoots: [scratch],
      timeoutMs: 120_000
    });
    if (looseRead.parseStatus === 'failed' || !looseRead.data) {
      throw new Error(`loose 输出重读失败：${JSON.stringify(looseRead.diagnostics)}`);
    }
    assertFmg(looseRead.data.entries, [[100, '裸表改'], [101, '乙'], [101, '乙-重复槽']]);

    // ---- 3d. sealed hash 不匹配 → fail-closed，不落盘 ----
    const wBad = await writeFmg(containerPath, {
      expectedDocumentHash: '0'.repeat(64),
      entryIndex: 0,
      mutation: 'upsert',
      id: 100,
      text: '不应写入'
    });
    if (wBad.result.parseStatus !== 'failed'
      || !wBad.result.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_FAILED')) {
      throw new Error(`hash 不匹配未 fail-closed：${JSON.stringify(wBad.result.diagnostics)}`);
    }
    await expectFailClosed(wBad.outPath, 'hash 不匹配');
    const afterBad = await readTable(containerPath, 0);
    if (afterBad.tableSourceHash !== base0.tableSourceHash) {
      throw new Error('hash 不匹配后 source 被改动');
    }

    // ---- 3e. encoding 失败（U+0000）→ FMG_ENCODING_UNSUPPORTED fail-closed ----
    const wEnc = await writeFmg(containerPath, {
      expectedDocumentHash: containerHash,
      entryIndex: 0,
      mutation: 'upsert',
      id: 100,
      text: '含\u0000空终止'
    });
    if (wEnc.result.parseStatus !== 'failed'
      || !wEnc.result.diagnostics.some((d) => d.code === 'FMG_STAGING_WRITE_FAILED')
      || !wEnc.result.diagnostics.some((d) => (d.message ?? '').includes('FMG_ENCODING_UNSUPPORTED'))) {
      throw new Error(`encoding 失败未结构化 fail-closed：${JSON.stringify(wEnc.result.diagnostics)}`);
    }
    await expectFailClosed(wEnc.outPath, 'encoding 失败');
    const afterEnc = await readTable(containerPath, 0);
    if (afterEnc.tableSourceHash !== base0.tableSourceHash) {
      throw new Error('encoding 失败后 source 被改动');
    }

    // ---- 3f. reopen failure：输出被破坏 → 重读结构化失败，before image 完好 ----
    const wOk = await writeFmg(containerPath, {
      expectedDocumentHash: containerHash,
      entryIndex: 1,
      mutation: 'upsert',
      id: 200,
      text: '丙改'
    });
    if (wOk.result.parseStatus === 'failed') {
      throw new Error(`成功写基线失败：${JSON.stringify(wOk.result.diagnostics)}`);
    }
    const okBytes = await readFile(wOk.outPath);
    const corrupt = join(outDir, 'corrupt.dcx');
    await writeFile(corrupt, okBytes.subarray(0, Math.floor(okBytes.length / 2)));
    const reopen = await runBridge<FmgCatalogEnvelope>({
      command: 'read-text-catalog',
      filePath: corrupt,
      allowedRoots: [scratch],
      timeoutMs: 120_000,
      commandOptions: { tableEntryIndex: 0 }
    });
    if (reopen.parseStatus !== 'failed'
      || !reopen.diagnostics.some((d) => d.code.startsWith('TEXT_CATALOG'))) {
      throw new Error(`corrupt 输出未结构化失败：${JSON.stringify(reopen.diagnostics)}`);
    }
    const beforeCheck = await readTable(containerPath, 0);
    if (beforeCheck.tableSourceHash !== base0.tableSourceHash) {
      throw new Error('reopen failure 后 before image 不可恢复（rollback 前提失败）');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  runSyntheticCases();
  await runSyntheticContainerWriteCases();
  await runRealCorpus();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
