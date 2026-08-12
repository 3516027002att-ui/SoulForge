/**
 * NATIVE-03 smoke（front-end.md §18.7）：Bridge 确认格式栈 + main-only locator。
 *
 * 覆盖（全部 synthetic、无条件执行）：
 *   - DFLT→BND4→PARAM confirmed 栈；
 *   - KRAK 且无 Oodle runtime → LOCATOR_RUNTIME_BLOCKED（可重试的运行时缺失，
 *     不是格式失败）；
 *   - loose PARAM（非容器）confirmed；
 *   - BND4 内重复 child 名：同名但 leaf 相同 → 不冲突，全部 confirmed；
 *   - BND4 内同名 child 出现不兼容 leaf（PARA vs FMG）→ conflict，禁止静默单选；
 *   - 路径脱敏：响应 JSON 不含工作区绝对路径。
 *
 * 本 smoke 不声明任何 native parser/writer authority（authority 由能力格
 * 裁定）；它只证明「Bridge 真实读外层后确认的层」能组装成 locator。
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { buildNativeDocumentLocator } from '../editing/nativeDocumentLocator.js';
import type { BridgeDocumentLocatorValue } from '@soulforge/shared';

let failures = 0;

function check(condition: boolean, message: string): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

function beU32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/** 构造 DFLT DCX 包装（复用 runNativeCorpusWriteBackSmoke 已验证的布局）。 */
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

/** 构造声明 KRAK 压缩的 DCX 头（无真实压缩载荷；Oodle runtime 缺失时只读头即可触发 blocked）。 */
function buildKrakDcx(payloadLength: number): Buffer {
  const headerLength = 0x4c + 8;
  return Buffer.concat([
    Buffer.from([0x44, 0x43, 0x58, 0x00]),
    beU32(0x00010000),
    beU32(0x18), beU32(0x24), beU32(0x44), beU32(0x4c),
    Buffer.from('DCS\0', 'ascii'),
    beU32(payloadLength),
    beU32(64),
    Buffer.from('DCP\0', 'ascii'),
    Buffer.from('KRAK', 'ascii'),
    beU32(0x20),
    Buffer.alloc(16, 0),
    Buffer.from([0x00, 0x06, 0x00, 0x00]),
    Buffer.from('DCA\0', 'ascii'),
    beU32(8),
    Buffer.alloc(64, 0xAB)
  ]).subarray(0, headerLength + 64);
}

/** 构造 BND4（复用 runNativeCorpusWriteBackSmoke 已验证的布局）。 */
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

interface ProbeResult {
  value: BridgeDocumentLocatorValue | null;
  code: string | null;
  rawText: string;
}

async function probe(filePath: string, oodleRuntimeRoot?: string): Promise<ProbeResult> {
  const result = await runBridge<BridgeDocumentLocatorValue>({
    command: 'probe-document-locator',
    filePath,
    ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
    timeoutMs: 30_000
  });
  const rawText = JSON.stringify(result);
  if (result.data !== undefined) {
    return { value: result.data, code: null, rawText };
  }
  const code = result.diagnostics.find((d) => d.code)?.code ?? 'UNKNOWN';
  return { value: null, code, rawText };
}

async function main(): Promise<void> {
  await withSmokeWorkspace('native-document-locator', async (workspace) => {
    const root = workspace.root;

    // 1. DFLT→BND4→PARAM confirmed 栈（a.param 是 PARA magic，b.bin 未知）
    const paramBytes = Buffer.concat([Buffer.from('PARA', 'ascii'), Buffer.alloc(64, 0x11)]);
    const unknownBytes = Buffer.from('soulforge-synthetic-payload-b');
    const bnd4 = buildBnd4(
      ['a.param', 'b.bin'],
      [paramBytes, unknownBytes]
    );
    const dcx = buildDfltDcx(bnd4);
    const dir = join(root, 'param-sample');
    await mkdir(dir, { recursive: true });
    const gameparamPath = join(dir, 'gameparam.parambnd.dcx');
    await writeFile(gameparamPath, dcx);

    const p1 = await probe(gameparamPath);
    check(p1.value !== null, 'DFLT→BND4→PARAM probe 返回 confirmed');
    if (p1.value) {
      check(p1.value.probeStatus === 'confirmed', `probeStatus=confirmed (got ${p1.value.probeStatus})`);
      const formatIds = p1.value.layers.map((l) => l.formatId);
      check(formatIds.includes('dcx-dflt'), '层包含 dcx-dflt');
      check(formatIds.includes('bnd4'), '层包含 bnd4');
      check(formatIds.includes('param'), '层包含 confirmed param child');
      check(p1.value.containerRole === 'gameparam-binder', `containerRole=gameparam-binder (got ${p1.value.containerRole})`);
      const paramLayer = p1.value.layers.find((l) => l.formatId === 'param');
      check(paramLayer?.entry?.expectedEntryHash !== undefined, 'param child 携带 expectedEntryHash');
      check(paramLayer?.entry?.stableEntryId.startsWith('bnd4:') ?? false, 'param child 携带 stableEntryId');
      const bndLayer = p1.value.layers.find((l) => l.formatId === 'bnd4');
      check(bndLayer !== undefined, 'bnd4 容器层存在');
      const outcome = buildNativeDocumentLocator({
        outerResourceId: p1.value.outerResourceId,
        outerSourceUri: `file://${gameparamPath.replace(/\\/g, '/')}`,
        sourceVariant: 'overlay',
        expectedOuterRevision: 'rev-1',
        bridgeValue: p1.value
      });
      check(outcome.kind === 'confirmed', 'buildNativeDocumentLocator 组装 confirmed locator');
      if (outcome.kind === 'confirmed') {
        check(outcome.locator.layers.length >= 3, `locator 层数 >= 3 (got ${outcome.locator.layers.length})`);
        check(outcome.locator.containerRole === 'gameparam-binder', 'locator containerRole 正确');
        check(outcome.locator.expectedOuterHash.length === 64, 'locator 携带 outer hash');
        const entryLayer = outcome.locator.layers.find((l) => l.entry !== null);
        check(entryLayer?.entry?.parentLayerIndex !== undefined, 'child 层有 parentLayerIndex');
      }
    }
    // 脱敏范围是 probe 响应体 value（renderer 只消费 opaque locator）；
    // BridgeResult 信封的 sourceUri/sourcePath 是框架强制字段，不在脱敏范围。
    const valueText = JSON.stringify(p1.value ?? null);
    check(
      !valueText.includes(join(root, '').replace(/\\/g, '/')) && !valueText.includes('\\'),
      `路径脱敏：value 不含工作区绝对路径 (value=${valueText.slice(0, 80)}...)`
    );

    // 2. KRAK 且无 Oodle runtime → blocked（可重试）
    const krakPath = join(dir, 'krak.dcx');
    await writeFile(krakPath, buildKrakDcx(64));
    const p2 = await probe(krakPath);
    check(p2.code === 'LOCATOR_RUNTIME_BLOCKED', `KRAK 无 runtime → LOCATOR_RUNTIME_BLOCKED (got ${p2.code})`);

    // 3. loose PARAM（非容器）confirmed
    const loosePath = join(dir, 'loose.param');
    await writeFile(loosePath, paramBytes);
    const p3 = await probe(loosePath);
    check(p3.value?.probeStatus === 'confirmed' && p3.value.leafFormatId === 'param', 'loose param confirmed');
    check(p3.value?.containerRole === 'none', 'loose 无容器角色');
    const outcome3 = p3.value ? buildNativeDocumentLocator({
      outerResourceId: p3.value.outerResourceId,
      outerSourceUri: `file://${loosePath.replace(/\\/g, '/')}`,
      sourceVariant: 'overlay',
      expectedOuterRevision: 'rev-1',
      bridgeValue: p3.value
    }) : null;
    if (outcome3?.kind === 'confirmed') {
      check(outcome3.locator.leafDocumentStableId.startsWith('loose:'), 'loose locator leafDocumentStableId 为 loose 形态');
    } else {
      check(false, 'loose locator 组装失败');
    }

    // 4. 重复 child 名（同名 leaf 相同 → 不冲突）
    const dupBnd4 = buildBnd4(
      ['dup.param', 'dup.param'],
      [paramBytes, paramBytes]
    );
    const dupPath = join(dir, 'dup.dcx');
    await writeFile(dupPath, buildDfltDcx(dupBnd4));
    const p4 = await probe(dupPath);
    check(p4.value?.probeStatus === 'confirmed', `重复名同 leaf → confirmed (got ${p4.value?.probeStatus})`);
    const dupParamLayers = p4.value?.layers.filter((l) => l.formatId === 'param') ?? [];
    check(dupParamLayers.length === 2, `重复名两个 child 都 confirmed (got ${dupParamLayers.length})`);
    check(new Set(dupParamLayers.map((l) => l.entry?.stableEntryId)).size === 2, '重复名 child 的 stableEntryId 互不相同');

    // 5. 同名 child 出现不兼容 leaf → conflict
    const fmgBytes = Buffer.concat([Buffer.from('FMG\0', 'ascii'), Buffer.alloc(32, 0x22)]);
    const conflictBnd4 = buildBnd4(
      ['dup.param', 'dup.param'],
      [paramBytes, fmgBytes]
    );
    const conflictPath = join(dir, 'conflict.dcx');
    await writeFile(conflictPath, buildDfltDcx(conflictBnd4));
    const p5 = await probe(conflictPath);
    check(p5.value?.probeStatus === 'conflict', `同名 child 不兼容 leaf → conflict (got ${p5.value?.probeStatus})`);
    check((p5.value?.confirmedStackIds.length ?? 0) >= 2, 'conflict 报告两个 stack id');
    if (p5.value?.probeStatus === 'conflict') {
      const outcome5 = buildNativeDocumentLocator({
        outerResourceId: p5.value.outerResourceId,
        outerSourceUri: `file://${conflictPath.replace(/\\/g, '/')}`,
        sourceVariant: 'overlay',
        expectedOuterRevision: 'rev-1',
        bridgeValue: p5.value
      });
      check(outcome5.kind === 'conflict', 'conflict 不组装 locator');
    }

    // 6. suffix-only 文件不能确认（无 magic → LOCATOR_FORMAT_UNCONFIRMED）
    const suffixPath = join(dir, 'only.param');
    await writeFile(suffixPath, Buffer.from('not-a-real-param-content', 'utf8'));
    const p6 = await probe(suffixPath);
    check(p6.code === 'LOCATOR_FORMAT_UNCONFIRMED', `suffix-only → 不确认 (got ${p6.code})`);
  });

  await disposeBridgeDaemonPool();
  if (failures > 0) {
    console.error(`runNativeDocumentLocatorSmoke: ${failures} 项断言失败`);
    process.exit(1);
  }
  console.log('runNativeDocumentLocatorSmoke: 全部通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
