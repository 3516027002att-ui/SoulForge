/**
 * SF-08 专项审计与冒烟测试 (runAuditSf08Smoke.ts)
 *
 * 依据：《SoulForge 全域审查与演进研究报告》与执行施工图 tasks/SF-08.md。
 * 验证核心：
 * 1. TextEntryHandle 合同约束：绑定 workspace, outer, childIndex+hash, language, category, slotIndex, expectedTextId, sourceVersion
 * 2. T19: FMG 同 ID 不同语言/表只修改指定目标，非目标表与非目标语言完全隔离
 * 3. T20: FMG null 指针 (offset == 0) vs 空字符串 ("" offset != 0 指向 \0\0) 绝不混淆、不做静默替换
 * 4. T20: Unicode 全面覆盖 (中文、日文假名与汉字、4字节代理对 Emoji 🗡️🛡️👑、CRLF/LF 换行)，保持无损，不改变换行、不 trim
 * 5. T20: 严格拒绝 U+0000 (\0) 与孤立代理项（FMG_ENCODING_UNSUPPORTED）
 * 6. 重复 textId 物理槽消歧义：缺 slotIndex 时明确拒绝 (FMG_ID_AMBIGUOUS)，指定 slotIndex 时精准命中目标槽并保留其他同 ID 槽
 * 7. 单批次同目标多次写入：最后状态生效 (last-wins)
 * 8. T21: 同一 msgbnd 容器内多张表 (item / menu) 原子批量写入，单一提交，非目标 sibling child 与表内 sibling entries 绝不丢失
 * 9. Native 真实资源 Sekiro item.msgbnd.dcx 多表原子修改、重读验证与事务回滚
 */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  type Diagnostic,
  type TextEntryHandle,
  validateTextEntryHandle,
  textEntryHandleKey
} from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import {
  commitFmgMutationsViaBridge,
  commitFmgMultiTableViaBridge,
  readFmgDocumentViaBridge
} from '../editing/fmgBridgeCommit.js';
import {
  readFmgEntries,
  setFmgEntries,
  groupFmgEdits,
  type FmgEntryEdit,
  type FmgEntrySnapshot
} from '../editing/fmgEdit.js';
import { openNativeEditSession } from '../editing/nativeEditSession.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { rollbackOperation } from '../patch/rollback.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function beU32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

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

/**
 * 构造合法的 Sekiro FMG v2 二进制 Buffer（小端字节序，魔数 0x00020000）。
 * offset == 0 表示 null 指针；
 * offset != 0 指向 \0\0 表示空字符串 ""；
 * 非空文本存储为以 \0 结尾的 UTF-16LE 字节序列。
 */
function buildFmgV2Buffer(entries: Array<{ id: number; text: string | null }>): Buffer {
  const groups: Array<{ offsetIndex: number; firstId: number; lastId: number }> = [];
  if (entries.length > 0) {
    let start = 0;
    while (start < entries.length) {
      let end = start;
      while (end + 1 < entries.length && entries[end + 1]!.id === entries[end]!.id + 1) {
        end++;
      }
      groups.push({
        offsetIndex: start,
        firstId: entries[start]!.id,
        lastId: entries[end]!.id
      });
      start = end + 1;
    }
  }

  const headerSize = 0x28;
  const groupSize = 0x10;
  const groupsEnd = headerSize + groups.length * groupSize;
  const stringOffsetsOffset = groupsEnd;
  const headerAndTables = stringOffsetsOffset + entries.length * 4;
  const stringPoolStart = (headerAndTables & 1) !== 0 ? headerAndTables + 1 : headerAndTables;

  const stringBytes: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = stringPoolStart;

  for (const entry of entries) {
    if (entry.text === null) {
      offsets.push(0);
      stringBytes.push(Buffer.alloc(0));
    } else {
      const encoded = Buffer.from(entry.text + '\0', 'utf16le');
      offsets.push(cursor);
      stringBytes.push(encoded);
      cursor += encoded.length;
    }
  }

  const fileSize = cursor;
  const buf = Buffer.alloc(fileSize);

  buf.writeInt32LE(0x00020000, 0); // version marker
  buf.writeInt32LE(fileSize, 4);   // declared size
  buf.writeInt32LE(0, 8);          // unk1
  buf.writeInt32LE(groups.length, 12);
  buf.writeInt32LE(entries.length, 16);
  buf.writeInt32LE(0, 20);         // unk2
  buf.writeInt32LE(stringOffsetsOffset, 24);
  buf.writeInt32LE(0, 28);
  buf.writeInt32LE(0, 32);
  buf.writeInt32LE(0, 36);

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const o = headerSize + i * groupSize;
    buf.writeInt32LE(g.offsetIndex, o);
    buf.writeInt32LE(g.firstId, o + 4);
    buf.writeInt32LE(g.lastId, o + 8);
    buf.writeInt32LE(0, o + 12);
  }

  for (let i = 0; i < entries.length; i++) {
    buf.writeInt32LE(offsets[i]!, stringOffsetsOffset + i * 4);
  }

  for (let i = 0; i < entries.length; i++) {
    if (offsets[i]! !== 0) {
      stringBytes[i]!.copy(buf, offsets[i]!);
    }
  }

  return buf;
}

/**
 * 构造包含若干 child 的未压缩 BND4 文件（魔数 "BND4"）。
 */
function buildSimpleBnd4(children: Array<{ id: number; name: string; bytes: Buffer }>): Buffer {
  const headerSize = 0x40;
  const entryHeaderSize = 0x24; // flags 0x40, id 4, offset 8, compressedSize 8, uncompressedSize 8
  const entriesCount = children.length;

  let namesOffset = headerSize + entriesCount * entryHeaderSize;
  const nameOffsets: number[] = [];
  const nameBuffers: Buffer[] = [];
  let namesLength = 0;

  for (const c of children) {
    const nameBuf = Buffer.from(c.name + '\0', 'utf8');
    nameOffsets.push(namesOffset + namesLength);
    nameBuffers.push(nameBuf);
    namesLength += nameBuf.length;
  }

  let dataOffset = namesOffset + namesLength;
  if ((dataOffset % 0x10) !== 0) {
    dataOffset += 0x10 - (dataOffset % 0x10);
  }

  const childOffsets: number[] = [];
  let currentDataCursor = dataOffset;
  for (const c of children) {
    childOffsets.push(currentDataCursor);
    currentDataCursor += c.bytes.length;
    if ((currentDataCursor % 0x10) !== 0) {
      currentDataCursor += 0x10 - (currentDataCursor % 0x10);
    }
  }

  const totalSize = currentDataCursor;
  const buf = Buffer.alloc(totalSize);

  // BND4 header
  buf.write('BND4', 0, 4, 'ascii');
  buf.writeUInt8(0, 4); // unk04
  buf.writeUInt8(0, 5); // unk05
  buf.writeUInt8(0, 6); // unk06
  buf.writeUInt8(0, 7); // unk07
  buf.writeUInt8(0, 8); // unk08
  buf.writeUInt8(1, 9); // bigEndian = false
  buf.writeUInt8(0, 10); // bitBigEndian = false
  buf.writeUInt8(0, 11); // unk0b
  buf.writeInt32LE(entriesCount, 12);
  buf.writeBigInt64LE(BigInt(headerSize), 16);
  buf.write('0000001\0', 24, 8, 'ascii');
  buf.writeBigInt64LE(BigInt(entryHeaderSize), 32);
  buf.writeBigInt64LE(BigInt(dataOffset), 40);
  buf.writeUInt8(0x40, 48); // unicode
  buf.writeUInt8(0x40, 49); // format (names)
  buf.writeUInt8(0, 50); // extended
  buf.writeUInt8(0, 51); // unk33
  buf.writeInt32LE(0, 52); // unk34
  buf.writeBigInt64LE(0n, 56); // unk38

  // Entry headers
  for (let i = 0; i < entriesCount; i++) {
    const c = children[i]!;
    const ehOffset = headerSize + i * entryHeaderSize;
    buf.writeUInt8(0x40, ehOffset); // flags
    buf.writeUInt8(0, ehOffset + 1);
    buf.writeUInt8(0, ehOffset + 2);
    buf.writeUInt8(0, ehOffset + 3);
    buf.writeInt32LE(-1, ehOffset + 4); // unk04
    buf.writeBigInt64LE(BigInt(c.bytes.length), ehOffset + 8); // compressedSize
    buf.writeBigInt64LE(BigInt(c.bytes.length), ehOffset + 16); // uncompressedSize
    buf.writeBigInt64LE(BigInt(childOffsets[i]!), ehOffset + 24); // dataOffset
    buf.writeInt32LE(c.id, ehOffset + 32); // id
    buf.writeInt32LE(nameOffsets[i]!, ehOffset + 36); // nameOffset
  }

  // Names
  for (let i = 0; i < entriesCount; i++) {
    nameBuffers[i]!.copy(buf, nameOffsets[i]!);
  }

  // Data
  for (let i = 0; i < entriesCount; i++) {
    children[i]!.bytes.copy(buf, childOffsets[i]!);
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Unit Suite
// ---------------------------------------------------------------------------

async function runUnitSuite(): Promise<{ name: string; ok: boolean }[]> {
  const results: { name: string; ok: boolean }[] = [];

  const runTest = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  [PASS] ${name}`);
    } catch (error) {
      results.push({ name, ok: false });
      console.error(`  [FAIL] ${name}:`, error instanceof Error ? error.message : error);
      throw error;
    }
  };

  await withSmokeWorkspace('audit-sf-08-unit', async (workspace) => {
    const root = workspace.root;
    const allowedRoots = [root];

    // Case 1: TextEntryHandle 合同约束
    await runTest('Case 1: TextEntryHandle 结构化约束与哈希键检验', async () => {
      const validHandle: TextEntryHandle = {
        workspaceId: 'ws_unit_test',
        outerId: 'msg/zhocn/item.msgbnd.dcx',
        childIndex: 0,
        expectedChildHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        language: 'zhocn',
        category: 'item_names',
        slotIndex: 5,
        expectedTextId: 1000,
        sourceVersion: 1
      };

      validateTextEntryHandle(validHandle);
      const key = textEntryHandleKey(validHandle);
      assert.equal(
        key,
        'ws_unit_test::msg/zhocn/item.msgbnd.dcx::0::zhocn::item_names::5::1000',
        'Key must deterministically capture the structural namespace.'
      );

      // Negative assertions
      assert.throws(() => validateTextEntryHandle({ ...validHandle, workspaceId: '' }));
      assert.throws(() => validateTextEntryHandle({ ...validHandle, outerId: '' }));
      assert.throws(() => validateTextEntryHandle({ ...validHandle, childIndex: -1 }));
      assert.throws(() => validateTextEntryHandle({ ...validHandle, slotIndex: -1 }));
      assert.throws(() => validateTextEntryHandle({ ...validHandle, language: '' }));
      assert.throws(() => validateTextEntryHandle({ ...validHandle, category: '' }));
    });

    // Case 2 (T19): 同 ID 不同语言/表修改只触及目标
    await runTest('Case 2 (T19): 相同 textId 在不同表/语言，修改只触及指定目标', async () => {
      // 创建表 A (Item Names) 和 表 B (Goods Names)，均包含 ID 1000
      const tableA = buildFmgV2Buffer([
        { id: 1000, text: 'Original Sword 1000' },
        { id: 1001, text: 'Original Sword 1001' }
      ]);
      const tableB = buildFmgV2Buffer([
        { id: 1000, text: 'Original Good 1000' },
        { id: 1001, text: 'Original Good 1001' }
      ]);

      const tableAPath = join(root, 'tableA.fmg');
      const tableBPath = join(root, 'tableB.fmg');
      await writeFile(tableAPath, tableA);
      await writeFile(tableBPath, tableB);

      const tableAHash = sha256(tableA);
      const tableBHash = sha256(tableB);

      // 修改 Table A 的 ID 1000 为 "Modified Sword 1000"
      const outAPath = join(root, 'tableA_mut.fmg');
      const writeResult = await commitFmgMutationsViaBridge({
        sourcePath: tableAPath,
        outputPath: outAPath,
        expectedDocumentHash: tableAHash,
        allowedRoots,
        writableRoots: allowedRoots,
        mutations: [{ kind: 'upsert', id: 1000, text: 'Modified Sword 1000' }]
      });
      assert(writeResult.ok, 'Table A mutation should succeed.');

      // 重读 Table A 输出
      const readA = await readFmgDocumentViaBridge({ sourcePath: outAPath, allowedRoots });
      assert(readA.ok, 'Read A should succeed.');
      const entryA1000 = readA.data?.entries.find((e) => e.id === 1000);
      assert.equal(entryA1000?.text, 'Modified Sword 1000', 'Table A ID 1000 should be modified.');
      const entryA1001 = readA.data?.entries.find((e) => e.id === 1001);
      assert.equal(entryA1001?.text, 'Original Sword 1001', 'Table A ID 1001 sibling must be preserved.');

      // 验证 Table B 完全未被触及
      const readB = await readFmgDocumentViaBridge({ sourcePath: tableBPath, allowedRoots });
      assert(readB.ok, 'Read B should succeed.');
      assert.equal(readB.data?.sourceHash, tableBHash, 'Table B hash must remain untouched.');
      const entryB1000 = readB.data?.entries.find((e) => e.id === 1000);
      assert.equal(entryB1000?.text, 'Original Good 1000', 'Table B ID 1000 must NOT be modified.');
    });

    // Case 3 (T20): null 指针 (offset == 0) vs 空字符串 ("" offset != 0)
    await runTest('Case 3 (T20): FMG null vs 空字符串不混淆，不做静默替换', async () => {
      // 构造包含 null (offset 0), 空串 "" (offset != 0 指向 \0\0), 和正常字符串
      const fmgRaw = buildFmgV2Buffer([
        { id: 100, text: null },
        { id: 200, text: '' },
        { id: 300, text: 'Filled' }
      ]);
      const fmgPath = join(root, 'null_vs_empty.fmg');
      await writeFile(fmgPath, fmgRaw);

      // 读取并通过 Bridge 验证
      const readResult = await readFmgDocumentViaBridge({ sourcePath: fmgPath, allowedRoots });
      assert(readResult.ok, 'read-fmg-document should succeed on null_vs_empty.');

      // 通过 Bridge write-fmg 写回，验证 null 与 "" 保持各自状态
      const outPath = join(root, 'null_vs_empty_out.fmg');
      const writeResult = await commitFmgMutationsViaBridge({
        sourcePath: fmgPath,
        outputPath: outPath,
        expectedDocumentHash: sha256(fmgRaw),
        allowedRoots,
        writableRoots: allowedRoots,
        mutations: [
          { kind: 'upsert', id: 100, text: null },
          { kind: 'upsert', id: 200, text: '' }
        ]
      });
      assert(writeResult.ok, 'Write keeping null and empty must succeed.');

      // 直接检查生成的输出二进制偏移表：
      // id 100 (slot 0) 偏移必须为 0 (null)
      // id 200 (slot 1) 偏移必须 > 0 且指向 \0\0 (空字符串)
      const outBytes = await readFile(outPath);
      const stringOffsetsOffset = outBytes.readInt32LE(24);
      const offsetSlot0 = outBytes.readInt32LE(stringOffsetsOffset);
      const offsetSlot1 = outBytes.readInt32LE(stringOffsetsOffset + 4);

      assert.equal(offsetSlot0, 0, 'Null slot (ID 100) must have offset == 0 in FMG v2.');
      assert(offsetSlot1 > 0, 'Empty string slot (ID 200) must have non-zero offset.');
      assert.equal(outBytes.readUInt16LE(offsetSlot1), 0, 'Empty string slot must point to UTF-16 null terminator.');
    });

    // Case 4 (T20): Unicode 全面覆盖 (中文、日文、Emoji 代理对、换行保持)
    await runTest('Case 4 (T20): Unicode (中日文、Emoji 🗡️🛡️👑、换行) 完整无损且不被改动', async () => {
      const complexText = '苇名一心・剣聖\r\n奥义·不死斩\n⚔️ 盾 🛡️ 皇子 👑 🏯';
      const fmgRaw = buildFmgV2Buffer([
        { id: 50, text: 'placeholder' }
      ]);
      const fmgPath = join(root, 'unicode_test.fmg');
      await writeFile(fmgPath, fmgRaw);

      const outPath = join(root, 'unicode_test_out.fmg');
      const writeResult = await commitFmgMutationsViaBridge({
        sourcePath: fmgPath,
        outputPath: outPath,
        expectedDocumentHash: sha256(fmgRaw),
        allowedRoots,
        writableRoots: allowedRoots,
        mutations: [{ kind: 'upsert', id: 50, text: complexText }]
      });
      assert(writeResult.ok, 'Unicode mutation write must succeed.');

      const reread = await readFmgDocumentViaBridge({ sourcePath: outPath, allowedRoots });
      assert(reread.ok, 'Reread should succeed.');
      const entry50 = reread.data?.entries.find((e) => e.id === 50);
      assert.equal(entry50?.text, complexText, 'Unicode string with Emoji, Japanese, and mixed newlines must match byte-for-byte.');
    });

    // Case 5 (T20): 严格拒绝 U+0000 与孤立 UTF-16 代理项
    await runTest('Case 5 (T20): 拒绝含 U+0000 与孤立代理项的文本 (FMG_ENCODING_UNSUPPORTED)', async () => {
      const fmgRaw = buildFmgV2Buffer([{ id: 1, text: 'clean' }]);
      const fmgPath = join(root, 'bad_encoding.fmg');
      await writeFile(fmgPath, fmgRaw);
      const hash = sha256(fmgRaw);

      // 尝试写入包含 U+0000 的字符串
      const badZeroOut = join(root, 'bad_zero.fmg');
      const zeroResult = await commitFmgMutationsViaBridge({
        sourcePath: fmgPath,
        outputPath: badZeroOut,
        expectedDocumentHash: hash,
        allowedRoots,
        writableRoots: allowedRoots,
        mutations: [{ kind: 'upsert', id: 1, text: 'hello\0world' }]
      });
      assert(!zeroResult.ok, 'U+0000 mutation must be rejected.');
      assert(
        zeroResult.diagnostics.some((d) => d.message.includes('FMG_ENCODING_UNSUPPORTED') || d.message.includes('U+0000')),
        'Diagnostic must mention FMG_ENCODING_UNSUPPORTED or U+0000.'
      );
      assert(!existsSync(badZeroOut), 'No staging file should be produced on encoding failure.');

      // 尝试写入包含孤立高代理项的字符串 (e.g. \uD800 没有配对低代理项)
      const badSurrogateOut = join(root, 'bad_surrogate.fmg');
      const surrogateResult = await commitFmgMutationsViaBridge({
        sourcePath: fmgPath,
        outputPath: badSurrogateOut,
        expectedDocumentHash: hash,
        allowedRoots,
        writableRoots: allowedRoots,
        mutations: [{ kind: 'upsert', id: 1, text: 'lone\uD800surrogate' }]
      });
      assert(!surrogateResult.ok, 'Lone surrogate mutation must be rejected.');
      assert(
        surrogateResult.diagnostics.some((d) => d.message.includes('FMG_ENCODING_UNSUPPORTED') || d.message.includes('代理项')),
        'Diagnostic must mention FMG_ENCODING_UNSUPPORTED.'
      );
      assert(!existsSync(badSurrogateOut), 'No staging file should be produced on encoding failure.');
    });

    // Case 6: 重复 textId 槽消歧义与 FMG_ID_AMBIGUOUS 拒绝
    await runTest('Case 6: 重复 textId 槽消歧义：无 slotIndex 时拒绝 FMG_ID_AMBIGUOUS，有 slotIndex 时精准定位', async () => {
      // 在 FMG 中构造两个具有相同 ID (ID 500) 的物理槽（Sekiro 中常见：比如一个空槽，一个有字槽）
      const fmgRaw = buildFmgV2Buffer([
        { id: 500, text: 'Slot 0 duplicate 500' },
        { id: 500, text: 'Slot 1 duplicate 500' },
        { id: 501, text: 'Slot 2 normal 501' }
      ]);
      const fmgPath = join(root, 'duplicate_id.fmg');
      await writeFile(fmgPath, fmgRaw);
      const hash = sha256(fmgRaw);

      // 无 slotIndex 时写入 ID 500 -> 必须拒绝并报错 FMG_ID_AMBIGUOUS
      const ambigOut = join(root, 'duplicate_ambig.fmg');
      const ambigResult = await commitFmgMutationsViaBridge({
        sourcePath: fmgPath,
        outputPath: ambigOut,
        expectedDocumentHash: hash,
        allowedRoots,
        writableRoots: allowedRoots,
        disallowAmbiguous: true,
        mutations: [{ kind: 'upsert', id: 500, text: 'Ambiguous change' }]
      });
      assert(!ambigResult.ok, 'Ambiguous ID update without slotIndex must fail.');
      assert(
        ambigResult.diagnostics.some((d) => d.message.includes('FMG_ID_AMBIGUOUS')),
        'Diagnostic must be FMG_ID_AMBIGUOUS.'
      );
      assert(!existsSync(ambigOut), 'No output produced on ambiguity.');

      // 指定 slotIndex = 1 写入 ID 500 -> 成功，且 slot 0 与 slot 2 完好保留
      const slotOut = join(root, 'duplicate_slot1.fmg');
      const slotResult = await commitFmgMutationsViaBridge({
        sourcePath: fmgPath,
        outputPath: slotOut,
        expectedDocumentHash: hash,
        allowedRoots,
        writableRoots: allowedRoots,
        mutations: [{ kind: 'upsert', id: 500, text: 'Targeted Slot 1 Updated', slotIndex: 1 }]
      });
      assert(slotResult.ok, 'Targeted slotIndex update must succeed.');

      // 重读验证：slot 0 是 'Slot 0 duplicate 500', slot 1 是 'Targeted Slot 1 Updated', slot 2 是 'Slot 2 normal 501'
      const reread = await readFmgDocumentViaBridge({ sourcePath: slotOut, allowedRoots });
      assert(reread.ok, 'Reread must succeed.');
      assert.equal(reread.data?.entries[0]?.text, 'Slot 0 duplicate 500', 'Slot 0 sibling preserved.');
      assert.equal(reread.data?.entries[1]?.text, 'Targeted Slot 1 Updated', 'Slot 1 targeted and updated.');
      assert.equal(reread.data?.entries[2]?.text, 'Slot 2 normal 501', 'Slot 2 sibling preserved.');
    });

    // Case 7: 单批次同目标多次写入 (last-wins)
    await runTest('Case 7: 单批次对同一目标多次写入，最后状态生效 (last-wins)', async () => {
      const fmgRaw = buildFmgV2Buffer([{ id: 10, text: 'initial' }]);
      const fmgPath = join(root, 'sequential_write.fmg');
      await writeFile(fmgPath, fmgRaw);

      const outPath = join(root, 'sequential_out.fmg');
      const writeResult = await commitFmgMutationsViaBridge({
        sourcePath: fmgPath,
        outputPath: outPath,
        expectedDocumentHash: sha256(fmgRaw),
        allowedRoots,
        writableRoots: allowedRoots,
        mutations: [
          { kind: 'upsert', id: 10, text: 'state_v1' },
          { kind: 'upsert', id: 10, text: 'state_v2' },
          { kind: 'upsert', id: 10, text: 'state_final' }
        ]
      });
      assert(writeResult.ok, 'Batch multiple mutations on same target must succeed.');

      const reread = await readFmgDocumentViaBridge({ sourcePath: outPath, allowedRoots });
      assert(reread.ok, 'Reread must succeed.');
      assert.equal(reread.data?.entries[0]?.text, 'state_final', 'Last mutation state must win.');
    });

    // Case 8 (T21): 同一 msgbnd 容器多表编辑且 sibling 不丢失
    await runTest('Case 8 (T21): 同一容器内多表编辑单一提交，全部 sibling 完整保留', async () => {
      // 构造包含 3 个 FMG child 的 BND4 容器
      const child0 = buildFmgV2Buffer([
        { id: 1, text: 'Child0 Entry 1' },
        { id: 2, text: 'Child0 Entry 2' }
      ]);
      const child1 = buildFmgV2Buffer([
        { id: 10, text: 'Child1 Entry 10' },
        { id: 20, text: 'Child1 Entry 20' }
      ]);
      const child2 = buildFmgV2Buffer([
        { id: 100, text: 'Sibling Child2 Entry 100' },
        { id: 200, text: 'Sibling Child2 Entry 200' }
      ]);

      const bnd4Bytes = buildSimpleBnd4([
        { id: 1, name: 'table0.fmg', bytes: child0 },
        { id: 2, name: 'table1.fmg', bytes: child1 },
        { id: 3, name: 'table2_sibling.fmg', bytes: child2 }
      ]);
      const dcxBytes = buildDfltDcx(bnd4Bytes);

      const containerPath = join(root, 'multi_table_container.msgbnd.dcx');
      await writeFile(containerPath, dcxBytes);
      const containerHash = sha256(dcxBytes);

      // 单次 Bridge 提交：同时修改 child 0 和 child 1
      const outContainerPath = join(root, 'multi_table_container_out.msgbnd.dcx');
      const multiResult = await commitFmgMultiTableViaBridge({
        sourcePath: containerPath,
        outputPath: outContainerPath,
        expectedDocumentHash: containerHash,
        allowedRoots,
        writableRoots: allowedRoots,
        tables: [
          {
            entryIndex: 0,
            mutations: [{ kind: 'upsert', id: 1, text: 'Child0 Modified 1' }]
          },
          {
            entryIndex: 1,
            mutations: [{ kind: 'upsert', id: 10, text: 'Child1 Modified 10' }]
          }
        ]
      });

      assert(multiResult.ok, 'Multi-table atomic commit must succeed.');
      assert.equal(multiResult.tableCount, 2, '2 tables modified.');

      // 验证输出容器中的内容：
      const rereadCatalog = await runBridge<{
        tables?: Array<{ entryIndex: number; entryName: string; entryCount: number }>;
        entries?: Array<{ id: number; text: string }>;
      }>({
        command: 'read-text-catalog',
        filePath: outContainerPath,
        allowedRoots,
        commandOptions: { tableEntryIndex: 0 }
      });
      assert(rereadCatalog.parseStatus !== 'failed', 'Catalog read on out container must succeed.');
      assert.equal(rereadCatalog.data?.tables?.length, 3, 'Container must preserve all 3 child tables.');

      // 验证 child 0 包含修改后的内容与未修改的 sibling
      const entries0 = rereadCatalog.data?.entries ?? [];
      assert.equal(entries0.find((e) => e.id === 1)?.text, 'Child0 Modified 1', 'Table 0 entry 1 modified.');
      assert.equal(entries0.find((e) => e.id === 2)?.text, 'Child0 Entry 2', 'Table 0 entry 2 sibling preserved.');

      // 验证 child 1 包含修改后的内容与未修改的 sibling
      const rereadChild1 = await runBridge<{
        entries?: Array<{ id: number; text: string }>;
      }>({
        command: 'read-text-catalog',
        filePath: outContainerPath,
        allowedRoots,
        commandOptions: { tableEntryIndex: 1 }
      });
      const entries1 = rereadChild1.data?.entries ?? [];
      assert.equal(entries1.find((e) => e.id === 10)?.text, 'Child1 Modified 10', 'Table 1 entry 10 modified.');
      assert.equal(entries1.find((e) => e.id === 20)?.text, 'Child1 Entry 20', 'Table 1 entry 20 sibling preserved.');

      // 验证未触及的 sibling 表 (child 2) 完好无损
      const rereadChild2 = await runBridge<{
        entries?: Array<{ id: number; text: string }>;
      }>({
        command: 'read-text-catalog',
        filePath: outContainerPath,
        allowedRoots,
        commandOptions: { tableEntryIndex: 2 }
      });
      const entries2 = rereadChild2.data?.entries ?? [];
      assert.equal(entries2.find((e) => e.id === 100)?.text, 'Sibling Child2 Entry 100', 'Sibling table 2 entry 100 preserved.');
      assert.equal(entries2.find((e) => e.id === 200)?.text, 'Sibling Child2 Entry 200', 'Sibling table 2 entry 200 preserved.');
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Native Suite
// ---------------------------------------------------------------------------

async function runNativeSuite(fixturePath?: string): Promise<{ name: string; ok: boolean }[]> {
  const results: { name: string; ok: boolean }[] = [];

  const runTest = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  [PASS] ${name}`);
    } catch (error) {
      results.push({ name, ok: false });
      console.error(`  [FAIL] ${name}:`, error instanceof Error ? error.message : error);
      throw error;
    }
  };

  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    || process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() || '';
  const oodle = gameRoot ? { oodleRuntimeRoot: gameRoot } : {};

  const sourceMsgbnd = await resolveNativeFixture(
    fixturePath,
    'fmg-primary',
    '../../mods/msg/zhocn/item.msgbnd.dcx'
  );

  await withSmokeWorkspace('audit-sf-08-native', async (workspace) => {
    const root = workspace.root;
    const modRoot = join(root, 'mod');
    const stagingRoot = join(root, 'staging');
    await mkdir(join(modRoot, 'msg', 'zhocn'), { recursive: true });
    await mkdir(stagingRoot, { recursive: true });

    // 复制真实 item.msgbnd.dcx 到 mod 目录
    const targetMsgbnd = join(modRoot, 'msg', 'zhocn', 'item.msgbnd.dcx');
    await copyFile(sourceMsgbnd, targetMsgbnd);
    const initialHash = sha256(await readFile(targetMsgbnd));

    const editSession = await openNativeEditSession({
      overlayRoot: modRoot,
      ...(gameRoot ? { baseRoot: gameRoot } : {})
    });

    let committedOpId = '';

    // Case 1 (T21): 原生 item.msgbnd.dcx 同容器多表修改 (武器名 + 武器説明)
    await runTest('Native Case 1 (T21): 原生 item.msgbnd.dcx 多表原子写入，sibling 表与 sibling 槽完整保留', async () => {
      // 选定只狼经典流派招式：寄鹰斩 (ID 5300)
      const readBefore = await readFmgEntries({
        edit: editSession,
        table: '武器名',
        ids: [5300]
      });
      assert(readBefore.ok, 'Read before 武器名 must succeed.');
      const originalTitle = readBefore.entries[0]?.text;
      assert(originalTitle, 'Original title for 5300 must exist.');

      const readDescBefore = await readFmgEntries({
        edit: editSession,
        table: '武器説明',
        ids: [5300]
      });
      assert(readDescBefore.ok, 'Read before 武器説明 must succeed.');
      const originalDesc = readDescBefore.entries[0]?.text;
      assert(originalDesc, 'Original description for 5300 must exist.');

      // 同时对「武器名」与「武器説明」发起多表修改
      const newTitle = 'SoulForge · 龙胤寄鹰斩';
      const newDesc = 'SoulForge SF-08 测试所注入之龙胤寄鹰斩。多表原子写入验证。';

      const setResult = await setFmgEntries({
        edit: editSession,
        edits: [
          { table: '武器名', id: 5300, text: newTitle },
          { table: '武器説明', id: 5300, text: newDesc }
        ]
      });

      assert(setResult.ok, 'Multi-table setFmgEntries must succeed.');
      assert.equal(setResult.after.length, 2, 'Two entries after image.');
      if (setResult.opId) {
        committedOpId = setResult.opId;
      }

      // 重读验证：武器名 与 武器説明 均被修改
      const readTitleAfter = await readFmgEntries({
        edit: editSession,
        table: '武器名',
        ids: [5300]
      });
      assert(readTitleAfter.ok);
      assert.equal(readTitleAfter.entries[0]?.text, newTitle, 'Title must match new text.');

      const readDescAfter = await readFmgEntries({
        edit: editSession,
        table: '武器説明',
        ids: [5300]
      });
      assert(readDescAfter.ok);
      assert.equal(readDescAfter.entries[0]?.text, newDesc, 'Description must match new text.');

      // 验证未修改的条目 (一字斩 ID 5600) 作为 sibling 完好无损
      const readSibling = await readFmgEntries({
        edit: editSession,
        table: '武器名',
        ids: [5600]
      });
      assert(readSibling.ok);
      assert.equal(readSibling.entries[0]?.text, '一字斩', 'Sibling entry 5600 must exist and be intact.');

      // 验证未修改的其他表（如 地名）完好无损
      const readPlace = await readFmgEntries({
        edit: editSession,
        table: '地名',
        ids: [1000]
      });
      assert(readPlace.ok, 'Place table must remain readable and intact.');
      assert.equal(readPlace.entries[0]?.text, '龙泉河畔 平田宅邸', 'Place entry 1000 must remain intact.');
    });

    // Case 2: 事务回滚 (rollback)
    await runTest('Native Case 2: 多表写入后通过事务回滚恢复，文件哈希与词条完全还原', async () => {
      assert(committedOpId, 'Must have opId from Case 1.');
      const rollbackResult = await rollbackOperation({
        opId: committedOpId,
        store: editSession.operationLog,
        session: editSession.session,
        confirmation: createConfirmationReceipt({
          subjects: [`ROLLBACK_OPERATION:${committedOpId}`],
          riskLevel: 'high',
          note: 'fmg sf08 native rollback'
        }),
        backupBaseDir: editSession.backupBaseDir
      });
      assert(rollbackResult.ok, 'Rollback must succeed.');

      // 验证文件哈希已完全还原到初始哈希
      const restoredHash = sha256(await readFile(targetMsgbnd));
      assert.equal(restoredHash, initialHash, 'Container hash must be restored to initial untouched hash.');

      // 验证 ID 5300 文本已还原为原始标题
      const readRestored = await readFmgEntries({
        edit: editSession,
        table: '武器名',
        ids: [5300]
      });
      assert(readRestored.ok);
      assert.equal(readRestored.entries[0]?.text, '寄鹰斩', 'Title must be restored to original.');
    });

    // Case 3 (T20): 原生写链拒绝非法编码，不破坏原生容器
    await runTest('Native Case 3 (T20): 原生写链在非法编码 (U+0000) 下安全拒绝，容器保持原样', async () => {
      const badResult = await setFmgEntries({
        edit: editSession,
        edits: [{ table: '武器名', id: 5300, text: 'Bad\0NullChar' }]
      });

      assert(!badResult.ok, 'setFmgEntries with U+0000 must fail.');
      assert(
        badResult.diagnostics.some((d) => d.message.includes('FMG_ENCODING_UNSUPPORTED') || d.message.includes('U+0000')),
        'Diagnostic must indicate encoding failure.'
      );

      // 验证容器未损坏
      const containerHash = sha256(await readFile(targetMsgbnd));
      assert.equal(containerHash, initialHash, 'Container must remain intact after rejected write.');
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Main CLI
// ---------------------------------------------------------------------------

function parseArgs(): { layer: string | undefined; fixturePath: string | undefined } {
  const args = process.argv.slice(2);
  let layer: string | undefined;
  let fixturePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--layer' && i + 1 < args.length) {
      layer = args[i + 1];
      i++;
    } else if (!args[i]?.startsWith('--')) {
      fixturePath = args[i];
    }
  }
  return { layer, fixturePath };
}

async function main(): Promise<void> {
  const { layer, fixturePath } = parseArgs();
  if (!layer || (layer !== 'unit' && layer !== 'native')) {
    console.error('用法: node runAuditSf08Smoke.js --layer unit|native [fixturePath]');
    process.exit(1);
  }

  console.log(`=== SF-08 Smoke Suite [layer: ${layer}] ===`);
  try {
    let results: { name: string; ok: boolean }[];
    if (layer === 'unit') {
      results = await runUnitSuite();
    } else {
      results = await runNativeSuite(fixturePath);
    }

    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nSF-08 ${layer} 完成: 共 ${results.length} 项，通过 ${passed} 项，失败 ${failed} 项。`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`SF-08 ${layer} 执行异常:`, error);
    process.exit(1);
  } finally {
    await disposeBridgeDaemonPool();
  }
}

main().catch((err) => {
  console.error('未捕获的根错误:', err);
  process.exit(1);
});
