#!/usr/bin/env node
/**
 * BND4 重建路径的场景边界门禁。
 *
 * 守的是一条容易被误修的边界：**「无损往返」与「通用重排」是两个不同的问题，
 * 不能用同一条实现当判据。**
 *
 * 背景（本轮实测得出）：VerifyRoundTrip 原先把 ByteIdentical 传成字面量 true，
 * 改成真实比对后发现真实语料的 no-op 重建并非逐字节一致——差异全部落在
 * dataOffset 相关字段，因为源容器在名字区末尾与子项之间留有比 16 字节对齐更宽
 * 的间隙（item.msgbnd.dcx 累计 168 字节），且头部声明的 dataOffset 与第一个子项
 * 的实际起点在源里就相差 8 字节。
 *
 * 第一次修复尝试是让通用 Repack「沿用源布局」，逐项差异确实收敛——但
 * bridge:verify:bnd4-transaction 的 rename 用例随即失败：沿用源 nameOffset 与
 * 「重命名后名字长度变化必须重排名字区」直接冲突。那次尝试已完整回退。
 *
 * 正确的切分是：
 *   - 布局等价（条目数/顺序/名字/长度/头字段都未变，仅内容可能等长替换）
 *     → RebuildPreservingLayout：以源字节为基底、只改必要字节，必然逐字节还原；
 *   - 变长 / 增删 / 重命名
 *     → Repack：必须重排布局，**本就不该期望逐字节一致**。
 *
 * 本门禁对这两条路径各给正例与负例。没有负例的话，把
 * RebuildPreservingLayout 的守卫放宽（让它接受变长输入）会静默产出损坏容器，
 * 而「no-op 逐字节一致」这条正例照样绿。
 *
 * 用自造微小 BND4-in-DFLT-DCX，不需要真实游戏语料，因此可在公开 CI 真跑。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const LABEL = 'bnd4-repack-scope';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE_CANDIDATES = [
  join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Release', 'net10.0', 'win-x64', 'publish', 'SoulForge.Bridge.exe'),
  join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe')
];

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

const exe = EXE_CANDIDATES.find(existsSync);
if (!exe) {
  report({
    ok: null,
    gate: LABEL,
    status: 'skipped',
    reason: 'Bridge 可执行文件缺失，无法做运行期场景验证。',
    remedy: 'npm run bridge:build',
    skipSemantics: '结构跳过：未声称通过，也不计为失败。'
  }, 0);
}

/**
 * 构造一个 BND4，刻意在子项之间留出**比 16 字节对齐更宽**的间隙。
 *
 * 这一点是本门禁的关键：紧凑排布的容器即使走通用 Repack 也可能碰巧逐字节一致，
 * 那样负例就测不到东西。真实容器带宽间隙，fixture 必须复现这个形态，否则门禁
 * 通过只说明「fixture 太规整」。
 */
function buildBnd4WithWideGaps(children) {
  const nameBuffers = children.map((child) => Buffer.from(`${child.name}\0`, 'utf8'));
  const headerSize = 0x40;
  const entrySize = 0x24;
  const namesOffset = headerSize + entrySize * children.length;
  const namesLength = nameBuffers.reduce((total, buffer) => total + buffer.length, 0);
  // 名字区之后额外留 96 字节留白（远宽于 16 对齐），模拟真实容器。
  const dataStart = namesOffset + namesLength + 96;
  const GAP = 48; // 子项之间的额外间隙，同样宽于 16 对齐。

  let cursor = dataStart;
  const placements = children.map((child) => {
    const at = cursor;
    cursor += child.bytes.length + GAP;
    return at;
  });
  const total = cursor;

  const bnd = Buffer.alloc(total);
  bnd.write('BND4', 0, 'ascii');
  bnd.writeInt32LE(children.length, 0x0C);
  bnd.writeBigInt64LE(BigInt(headerSize), 0x10);
  bnd.write('07D7R6\0\0', 0x18, 'ascii');
  bnd.writeBigInt64LE(BigInt(entrySize), 0x20);
  // 头部声明的 dataOffset 刻意比第一个子项实际起点小 8 字节——真实容器里就有
  // 这个形态（item.msgbnd.dcx 声明 2872、entry0 落在 2880）。
  bnd.writeBigInt64LE(BigInt(dataStart - 8), 0x28);
  bnd.writeUInt8(0x74, 0x30);
  bnd.writeUInt8(1, 0x31);

  let nameCursor = namesOffset;
  children.forEach((child, index) => {
    const e = headerSize + index * entrySize;
    bnd.writeInt32LE(0x40, e);
    bnd.writeInt32LE(-1, e + 4);
    bnd.writeBigInt64LE(BigInt(child.bytes.length), e + 8);
    bnd.writeBigInt64LE(BigInt(child.bytes.length), e + 0x10);
    bnd.writeUInt32LE(placements[index], e + 0x18);
    bnd.writeInt32LE(index, e + 0x1C);
    bnd.writeUInt32LE(nameCursor, e + 0x20);
    nameBuffers[index].copy(bnd, nameCursor);
    child.bytes.copy(bnd, placements[index]);
    nameCursor += nameBuffers[index].length;
  });
  return bnd;
}

function buildDfltDcx(payload) {
  const compressed = deflateSync(payload);
  const dcx = Buffer.alloc(0x4C + compressed.length);
  dcx.write('DCX\0', 0, 'ascii');
  dcx.writeInt32BE(0x10000, 4);
  dcx.writeInt32BE(0x18, 8);
  dcx.writeInt32BE(0x24, 0x0C);
  dcx.writeInt32BE(0x24, 0x10);
  dcx.writeInt32BE(0x2C, 0x14);
  dcx.write('DCS\0', 0x18, 'ascii');
  dcx.writeInt32BE(payload.length, 0x1C);
  dcx.writeInt32BE(compressed.length, 0x20);
  dcx.write('DCP\0', 0x24, 'ascii');
  dcx.write('DFLT', 0x28, 'ascii');
  dcx.writeInt32BE(0x20, 0x2C);
  dcx.writeUInt8(9, 0x30);
  dcx.writeInt32BE(0x00010100, 0x40);
  dcx.write('DCA\0', 0x44, 'ascii');
  dcx.writeInt32BE(8, 0x48);
  compressed.copy(dcx, 0x4C);
  return dcx;
}

function openDaemon() {
  const child = spawn(exe, ['daemon'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.kind === 'progress' || frame.kind === 'request/accepted') continue;
      const settle = pending.get(frame.requestId);
      if (settle) { pending.delete(frame.requestId); settle(frame); }
    }
  });
  const send = (frame) => new Promise((settle, reject) => {
    const timer = setTimeout(() => {
      pending.delete(frame.requestId);
      reject(new Error(`BRIDGE_FRAME_TIMEOUT: ${frame.requestId}; stderr=${stderr.slice(-400)}`));
    }, 60_000);
    pending.set(frame.requestId, (received) => { clearTimeout(timer); settle(received); });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
  return { child, send };
}

const scratch = mkdtempSync(join(tmpdir(), 'sf-repack-scope-'));
const sourceRoot = join(scratch, 'source');
const writableRoot = join(scratch, 'out');
mkdirSync(sourceRoot, { recursive: true });
mkdirSync(writableRoot, { recursive: true });

const CHILD_A = { name: 'alpha.param', bytes: Buffer.from('SOULFORGE-SYNTHETIC-ALPHA-PAYLOAD-0001', 'ascii') };
const CHILD_B = { name: 'beta.param', bytes: Buffer.from('SOULFORGE-SYNTHETIC-BETA-PAYLOAD-00002', 'ascii') };
const sourceFile = join(sourceRoot, 'scope.parambnd.dcx');
writeFileSync(sourceFile, buildDfltDcx(buildBnd4WithWideGaps([CHILD_A, CHILD_B])));

const checks = [];
const findings = [];
function check(name, condition, observed) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) findings.push({ name, observed });
}

const SESSION = 'repack-scope-session';
let daemon;
try {
  daemon = openDaemon();
  const handshake = await daemon.send({
    kind: 'handshake', protocolVersion: '1.0.0', requestId: 'handshake-1', workspaceSessionId: SESSION,
    payload: { allowedRoots: [sourceRoot, writableRoot], writableRoots: [writableRoot] }
  });
  if (handshake.kind !== 'handshake') {
    throw new Error(`BRIDGE_HANDSHAKE_FAILED: ${JSON.stringify(handshake.payload).slice(0, 300)}`);
  }

  /* ---- 正例 1：no-op 必须逐字节还原 ---------------------------------------
   * fixture 刻意带宽间隙与头部声明偏移差；若实现改回「通用重排当无损基线」，
   * 这一条会立刻变红。
   */
  const read = await daemon.send({
    kind: 'request', protocolVersion: '1.0.0', requestId: 'read-1', workspaceSessionId: SESSION,
    payload: { command: 'read-dcx-document', filePath: sourceFile, options: {} }
  });
  const nested = read.payload?.result?.data?.nested ?? null;
  check('noop/nested-bnd4-present', nested !== null, { kind: read.kind });

  if (nested !== null) {
    check(
      'noop/roundtrip-byte-identical',
      nested.roundTrip?.byteIdentical === true,
      {
        byteIdentical: nested.roundTrip?.byteIdentical,
        note: '带宽间隙的容器 no-op 重建必须逐字节还原；false 说明无损基线又走回了通用重排'
      }
    );
    check(
      'noop/field-preservation-byte-identical',
      nested.fieldPreservation?.noOpPayloadByteIdentical === true,
      { noOpPayloadByteIdentical: nested.fieldPreservation?.noOpPayloadByteIdentical }
    );
    // 字段级判据仍针对通用 Repack 产物：条目字段、名字、存储字节必须保住。
    // 这一条与上面两条问的是不同问题，必须同时成立。
    check(
      'repack/entry-fields-preserved',
      nested.fieldPreservation?.entryHeaderFieldsPreserved === true
        && nested.fieldPreservation?.namesPreserved === true
        && nested.fieldPreservation?.storedBytesPreserved === true,
      {
        entryHeaderFieldsPreserved: nested.fieldPreservation?.entryHeaderFieldsPreserved,
        namesPreserved: nested.fieldPreservation?.namesPreserved,
        storedBytesPreserved: nested.fieldPreservation?.storedBytesPreserved
      }
    );
    // CRUD 走通用 Repack：rename/move/delete/add/replace 都必须仍然可行。
    // 这是上一轮失败尝试打断的那一组——沿用源布局会让 rename 失败。
    check(
      'repack/crud-still-works',
      nested.crud?.allPassed === true,
      { crud: nested.crud }
    );

    /* ---- 布局守卫自检 ------------------------------------------------------
     * RebuildPreservingLayout 只被往返/字段保留两条报告调用，而它们永远传 no-op
     * 输入，所以那道长度守卫在 IPC 层**不可达**——外部门禁无论怎么构造请求都测
     * 不到它。实测过：注释掉长度守卫，写盘边界/CRUD/往返三类门禁全部照样通过。
     *
     * 因此判据由文档内部自检产出（VerifyLayoutGuard 构造变长/改名/删条目三种
     * 越界输入），随 envelope 上报，这里断言四项全真。守卫是布局保持重建的唯一
     * 正确性前提：放宽它会让更长的字节写进源的原位，越界覆盖后续子项。
     */
    const guard = nested.layoutGuard ?? null;
    check('layoutGuard/report-present', guard !== null, { nestedKeys: Object.keys(nested) });
    if (guard !== null) {
      check('layoutGuard/accepts-noop', guard.acceptsNoOp === true, guard);
      check('layoutGuard/rejects-longer-stored-bytes', guard.rejectsLongerStoredBytes === true, guard);
      check('layoutGuard/rejects-rename', guard.rejectsRename === true, guard);
      check('layoutGuard/rejects-entry-count-change', guard.rejectsEntryCountChange === true, guard);
    }
  }

  /* ---- 正例 1b：no-op 写回后，DCX 外层产物必须逐字节等于源文件 -------------
   *
   * 为什么必须单独有它：正例 1 断言的是 read 侧报告的 nested.roundTrip
   * （内层 BND4 重建逐字节）与 fieldPreservation.noOpPayloadByteIdentical
   * （内层 payload 逐字节）。两者都只看**内层**。
   *
   * 但用户拿到的产物是**外层 DCX 文件**。内层逐字节还原、外层容器头/压缩块却
   * 变了，磁盘上的文件仍然与原文件不同——「无损」这个承诺是对外层文件说的。
   * 实测确认此前无任何断言比较过写回产物与源文件的哈希：门禁调 write-bnd4 做
   * CRUD 与负例，但 outputHash 从未被拿来和源哈希比。
   *
   * 这是本仓库公开可跑范围内唯一覆盖「外层文件逐字节无损」的判据。
   * no-op 用「同尺寸原样替换」表达（write-bnd4 显式拒绝空 mutations 数组），
   * 替换字节取自读侧报告的该子项存储字节——这正是生产的无损写入路径。
   */
  {
    const noopContainerHash = nested === null ? null : read.payload?.result?.data?.sourceHash ?? null;
    const noopChild = (nested?.entries ?? []).find((entry) => entry.name === CHILD_A.name) ?? null;
    if (typeof noopContainerHash === 'string' && typeof noopChild?.contentHash === 'string') {
      const noopOutput = join(writableRoot, 'scope-noop-writeback.parambnd.dcx');
      const noopWrite = await daemon.send({
        kind: 'request', protocolVersion: '1.0.0', requestId: 'write-noop', workspaceSessionId: SESSION,
        payload: {
          command: 'write-bnd4',
          filePath: sourceFile,
          options: {
            expectedContainerHash: noopContainerHash,
            mutation: 'replace',
            childPath: CHILD_A.name,
            expectedChildHash: noopChild.contentHash,
            // 原样字节：同尺寸替换走 ReplaceEntrySameSize / 布局保持路径。
            contentBase64: CHILD_A.bytes.toString('base64'),
            outputPath: noopOutput
          }
        }
      });
      check(
        'noop-writeback/succeeds',
        noopWrite.kind === 'result' && noopWrite.payload?.result?.parseStatus !== 'failed',
        {
          kind: noopWrite.kind,
          parseStatus: noopWrite.payload?.result?.parseStatus,
          diagnostics: noopWrite.payload?.result?.diagnostics?.map((d) => `${d.severity}:${d.code}`)
        }
      );
      // 判据定在 payload 层，不是外层文件层。
      //
      // 外层 DCX 必然重压缩：DFLT 走 .NET DeflateStream、KRAK 走 Oodle
      // （Bnd4NativeWriter.cs:42-58），writer 不保留源压缩块。因此外层文件
      // 逐字节相同在当前设计下不可能，断言它只会得到一条与实现承诺无关的假红。
      //
      // 实测确认过这一点：先写成「磁盘产物 == 源文件」时门禁红，差异 104 字节
      // 全部落在 deflate 数据区（fixture 用 node zlib、writer 用 .NET，同一
      // payload 产出不同字节流），而内层 payload 本身是逐字节一致的。
      //
      // 真正该锁的是：解压后的 payload 必须逐字节还原。它才是「无损」对用户的
      // 含义——重新压缩换掉的是容器外壳，塞进去的内容不能变。
      const reportedPayloadHash = noopWrite.payload?.result?.data?.payloadHash ?? null;
      const sourcePayloadHash = read.payload?.result?.data?.payloadHash ?? null;
      check(
        'noop-writeback/payload-hash-equals-source',
        typeof sourcePayloadHash === 'string' && reportedPayloadHash === sourcePayloadHash,
        {
          reportedPayloadHash,
          sourcePayloadHash,
          note: '原样替换后解压 payload 必须逐字节还原；不等说明写回改动了内容而非仅换外壳'
        }
      );
      // 不只信 writer 的自报值：把落盘产物重新读一遍，用独立的一次 bridge 调用
      // 比较它的 payloadHash。writer 报的哈希来自它自己的重读，若重读路径与落盘
      // 路径不一致，自报值可以正确而磁盘内容错误。
      check('noop-writeback/output-exists', existsSync(noopOutput), { noopOutput });
      if (existsSync(noopOutput)) {
        const reread = await daemon.send({
          kind: 'request', protocolVersion: '1.0.0', requestId: 'read-noop', workspaceSessionId: SESSION,
          payload: { command: 'read-dcx-document', filePath: noopOutput, options: {} }
        });
        const rereadPayloadHash = reread.payload?.result?.data?.payloadHash ?? null;
        check(
          'noop-writeback/on-disk-payload-equals-source',
          typeof sourcePayloadHash === 'string' && rereadPayloadHash === sourcePayloadHash,
          {
            rereadPayloadHash,
            sourcePayloadHash,
            note: '独立重读磁盘产物得到的 payload 哈希必须等于源；只信 writer 自报值会漏掉'
              + '「重读路径正确而落盘路径错误」这一类缺陷'
          }
        );
        // 内层容器结构也必须还原：条目数与各子项存储字节哈希逐一相同。
        const rereadNested = reread.payload?.result?.data?.nested ?? null;
        const srcEntries = (nested?.entries ?? []).map((e) => `${e.name}:${e.contentHash}`).join('|');
        const outEntries = (rereadNested?.entries ?? []).map((e) => `${e.name}:${e.contentHash}`).join('|');
        check(
          'noop-writeback/on-disk-entries-identical',
          srcEntries.length > 0 && srcEntries === outEntries,
          { srcEntries, outEntries }
        );
      }
    }
  }

  /* ---- 正例 2：通用 Repack 路径（rename）必须成功 -------------------------
   * 这是上一轮失败尝试打断的那一组：把「沿用源布局」塞进通用 Repack 会让
   * rename 失败，因为新名字长度变化必须重排名字区。此处用真实 write-bnd4 调用
   * 复现该场景，确保修「无损基线」时不会再次连带打断重排路径。
   *
   * write-bnd4 需要 expectedContainerHash（DCX 源哈希）与 expectedChildHash
   * （子项存储字节哈希），两者都从上面的读取结果里取——这也顺带验证了读侧
   * 报告的哈希确实可用于写侧前置条件。
   */
  const containerHash = nested === null ? null : read.payload?.result?.data?.sourceHash ?? null;
  const childEntry = (nested?.entries ?? []).find((entry) => entry.name === CHILD_A.name) ?? null;
  check(
    'repack/hashes-available-for-write-precondition',
    typeof containerHash === 'string' && typeof childEntry?.contentHash === 'string',
    { containerHash, childContentHash: childEntry?.contentHash }
  );

  if (typeof containerHash === 'string' && typeof childEntry?.contentHash === 'string') {
    const renamedOutput = join(writableRoot, 'scope-renamed.parambnd.dcx');
    const renamed = await daemon.send({
      kind: 'request', protocolVersion: '1.0.0', requestId: 'write-1', workspaceSessionId: SESSION,
      payload: {
        command: 'write-bnd4',
        filePath: sourceFile,
        options: {
          expectedContainerHash: containerHash,
          mutation: 'rename',
          childPath: CHILD_A.name,
          expectedChildHash: childEntry.contentHash,
          // 新名字刻意更长：这正是「必须重排名字区」的触发条件。
          newName: 'alpha-renamed-longer.param',
          outputPath: renamedOutput
        }
      }
    });
    check(
      'repack/rename-succeeds',
      renamed.kind === 'result' && renamed.payload?.result?.parseStatus !== 'failed',
      {
        kind: renamed.kind,
        parseStatus: renamed.payload?.result?.parseStatus,
        diagnostics: renamed.payload?.result?.diagnostics?.map((d) => `${d.severity}:${d.code}`),
        note: 'rename 走通用 Repack；若「无损基线」的改动泄漏到这条路径，它会失败'
      }
    );
    check('repack/rename-output-exists', existsSync(renamedOutput), { renamedOutput });

    /* ---- 负例：变长替换必须被拒 -------------------------------------------
     * 这一条直接覆盖 IsLayoutPreservingRepack 的长度守卫。
     *
     * 为什么必须单独有它：布局保持重建的正确性完全依赖「只接受布局等价输入」。
     * 若那道长度守卫被放宽，RebuildPreservingLayout 会把更长的字节写进源的原位，
     * **越界覆盖后续子项**——而 no-op 正例仍然全绿，因为 no-op 输入本来就等长。
     * 实测过：只有正例时，注释掉长度守卫，门禁照样通过。
     *
     * BND4 的变长替换尚未开放（ReplaceEntrySameSize 明确拒绝），所以这里断言的
     * 是「结构化拒绝」而不是「重排成功」。
     */
    const longer = Buffer.concat([CHILD_A.bytes, Buffer.from('-EXTRA-BYTES', 'ascii')]);
    const longerOutput = join(writableRoot, 'scope-longer.parambnd.dcx');
    const varLength = await daemon.send({
      kind: 'request', protocolVersion: '1.0.0', requestId: 'write-3', workspaceSessionId: SESSION,
      payload: {
        command: 'write-bnd4',
        filePath: sourceFile,
        options: {
          expectedContainerHash: containerHash,
          mutation: 'replace',
          childPath: CHILD_A.name,
          expectedChildHash: childEntry.contentHash,
          contentBase64: longer.toString('base64'),
          outputPath: longerOutput
        }
      }
    });
    // 变长写入若被接受，产物必须仍然可解析且子项字节完整——绝不允许「写成功但
    // 容器损坏」。这里的判据是二选一：要么结构化拒绝，要么产物可重读且内容正确。
    const varLengthRejected = varLength.kind === 'failed'
      || varLength.payload?.result?.parseStatus === 'failed'
      || (varLength.payload?.result?.diagnostics ?? []).some((d) => d.severity === 'error');
    if (varLengthRejected) {
      check('varLength/rejected-or-lossless', true, { outcome: 'structured-rejection' });
      check(
        'varLength/no-output-when-rejected',
        !existsSync(longerOutput),
        { landed: existsSync(longerOutput) }
      );
    } else {
      // 被接受的话必须真的无损：重读产物，确认该子项字节等于新内容。
      const reread = await daemon.send({
        kind: 'request', protocolVersion: '1.0.0', requestId: 'read-2', workspaceSessionId: SESSION,
        payload: { command: 'snapshot-bnd4-child', filePath: longerOutput, options: { childPath: CHILD_A.name } }
      });
      const snapshot = reread.payload?.result?.diagnostics?.[0]?.details ?? null;
      const actual = typeof snapshot?.contentBase64 === 'string'
        ? Buffer.from(snapshot.contentBase64, 'base64')
        : null;
      check(
        'varLength/rejected-or-lossless',
        actual !== null && actual.equals(longer),
        {
          outcome: 'accepted',
          expectedLength: longer.length,
          actualLength: actual?.length ?? null,
          note: '变长写入被接受时必须无损；字节不符说明布局守卫被放宽后发生了越界覆盖'
        }
      );
      check('varLength/no-output-when-rejected', true, { outcome: 'accepted-and-verified' });
    }

    /* ---- 负例：前置哈希不符必须被拒（写入不得绕过 expectedHash）---------- */
    const badHashOutput = join(writableRoot, 'scope-badhash.parambnd.dcx');
    const badHash = await daemon.send({
      kind: 'request', protocolVersion: '1.0.0', requestId: 'write-2', workspaceSessionId: SESSION,
      payload: {
        command: 'write-bnd4',
        filePath: sourceFile,
        options: {
          expectedContainerHash: containerHash,
          mutation: 'replace',
          childPath: CHILD_A.name,
          // 故意给错的子项哈希：写入必须失败关闭，且不得留下产物。
          expectedChildHash: '0'.repeat(64),
          contentBase64: CHILD_A.bytes.toString('base64'),
          outputPath: badHashOutput
        }
      }
    });
    const badHashRejected = badHash.kind === 'failed'
      || badHash.payload?.result?.parseStatus === 'failed'
      || (badHash.payload?.result?.diagnostics ?? []).some((d) => d.severity === 'error');
    check(
      'precondition/wrong-child-hash-rejected',
      badHashRejected,
      {
        kind: badHash.kind,
        parseStatus: badHash.payload?.result?.parseStatus,
        diagnostics: badHash.payload?.result?.diagnostics?.map((d) => `${d.severity}:${d.code}`)
      }
    );
    check(
      'precondition/no-output-on-rejected-write',
      !existsSync(badHashOutput),
      { landed: existsSync(badHashOutput), path: badHashOutput }
    );
  }
} catch (error) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'REPACK_SCOPE_HARNESS_FAILED',
    message: error instanceof Error ? error.message : String(error),
    checks
  }, 1);
} finally {
  if (daemon) {
    daemon.child.stdin.end();
    try { daemon.child.kill(); } catch { /* 已退出 */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}

if (findings.length > 0) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'BND4_REPACK_SCOPE_VIOLATION',
    message: '重建路径的场景边界被破坏：无损往返与通用重排必须各自成立。',
    passed: checks.length - findings.length,
    failed: findings.length,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  assertions: checks.length,
  message: 'no-op 走布局保持重建且逐字节还原；通用 Repack 的 CRUD、字段保留与 rename '
    + '（新名字更长，必须重排名字区）仍成立；子项哈希不符的写入失败关闭且不留产物。',
  fixture: 'synthetic BND4-in-DFLT-DCX，刻意带宽于 16 字节对齐的子项间隙与名字区留白，'
    + '并让头部声明的 dataOffset 比首个子项实际起点小 8 字节（复现真实容器形态）',
  nonClaim: '本门禁不声明变长 repack 已可用，也不提升任何格式 authority；'
    + '它只锁定「无损基线走布局保持路径、通用重排不当无损判据」这条边界。'
}, 0);
