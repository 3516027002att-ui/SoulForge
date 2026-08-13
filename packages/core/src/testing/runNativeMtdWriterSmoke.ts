/**
 * Native MTD writer smoke（MATERIAL-53C）——typed material property set 与 roundtrip。
 *
 * 路径 A（真实语料）：registry 已登记 mtd-primary → 真实读 → 改一个已知 property →
 * write-mtd-document → reopen 断言 roundTrip + authority 与值命中。
 *
 * 路径 B（合成 fixture）：registry 未登记 → 微小、合法、显式 syntheticFixture
 * 标记的合成 MTD 文件 → 写回 → reopen，断言：
 *   - 目标 param 值命中、兄弟 param 原样、material 头原样、texture 引用原样；
 *   - **未知属性无损**：param id=2 带 unkA 未知属性，写回后 unknown 与
 *     unparsedGaps 逐项一致（字节外科替换的损失证明）；authority 保持 partial；
 *   - **字节外科证明**：同长替换时输出与源仅在目标值区间一个连续区域不同；
 *   - **block 语义**：目标 param 内容含子元素 → MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE
 *     结构化诊断且不落盘（未知字段无法无损保留时不得写坏）；
 *   - **失败注入**：hash 不匹配 / paramId 不存在 / paramId 不唯一 →
 *     MTD_STAGING_WRITE_FAILED 且不落盘；before image（源文件）字节不变。
 *
 * 缺语料处置：MTD 在真实 corpus 中未登记是合法状态，此时走路径 B 而非静默
 * skip——合成 fixture 仍真实经过 C# MtdNativeWriter 验证写回，不冒充 native
 * authority（syntheticFixture: true）。只有 registry 配置损坏等环境问题才失败关闭。
 *
 * 注意：write-mtd-document 已由主会话加入 BridgeCommand TS union 与
 * BRIDGE_STAGING_WRITE_VERIFIED_CODES.mtd（IPC 接线同步完成），本套件直接
 * 引用字面量，不再需要 cast。
 */
import { mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BridgeResult } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { nativeFixtureRoleRegistered, resolveNativeFixture } from './nativeFixtureRegistry.js';
import { classifyChildExtract, reportInfrastructureFailure } from './nativeFixtureExtract.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const MTD_WRITE_COMMAND = 'write-mtd-document' as const;

const MTD_STAGING_WRITE_VERIFIED = 'MTD_STAGING_WRITE_VERIFIED';
const MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE = 'MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE';
const MTD_STAGING_WRITE_FAILED = 'MTD_STAGING_WRITE_FAILED';

interface MtdEnvelope {
  sourceHash?: string;
  name?: string | null;
  version?: string | null;
  shaderPath?: string | null;
  materialCount?: number;
  properties?: Array<{
    id?: string | null;
    type?: string | null;
    name?: string | null;
    value?: string | null;
    unknown?: Record<string, string> | null;
  }>;
  textureRefs?: Array<{ path?: string | null; type?: string | null; name?: string | null }>;
  unparsedGaps?: string[];
  layoutWarnings?: string[];
  roundTrip?: { consistent?: boolean };
  authority?: string;
}

interface WriteEnvelope {
  paramId?: string;
  paramName?: string;
  paramType?: string;
  valueBefore?: string;
  valueAfter?: string;
  outputHash?: string;
  outputSize?: number;
  rereadVerified?: boolean;
  structurePreserved?: boolean;
  byteSurgical?: boolean;
  isDcx?: boolean;
  compressionFormat?: string | null;
}

interface ExtractEnvelope {
  contentSize?: number;
}

/** 干净合成语料：id=2 带未知属性 unkA，专门用于证明未知字段无损保留。 */
const SYNTHETIC_MTD_XML = `<?xml version="1.0" encoding="utf-8"?>
<material name="synthetic_mtd_writer_smoke" version="1.0">
  <header>Synthetic MTD writer smoke header</header>
  <param id="0" type="shader" name="ShaderPath">mtd/synthetic/smoke_shader.mtd</param>
  <param id="1" type="float" name="SpecularPower">320</param>
  <param id="2" type="float" name="CustomTint" unkA="42">1.0</param>
  <texture path="asset/textures/synthetic_smoke_a.dds" type="diffuse" name="Diffuse"/>
</material>
`;

/** block 用例：目标 param 内容含子元素（替换会摧毁未知结构 → 必须 fail-closed）。 */
const SYNTHETIC_MTD_BLOCKED_XML = `<?xml version="1.0" encoding="utf-8"?>
<material name="synthetic_mtd_writer_blocked" version="1.0">
  <param id="0" type="float" name="Specular"><nested flag="1">inner</nested></param>
  <param id="1" type="float" name="Other">1.0</param>
</material>
`;

/** 歧义用例：两个 param 同 id（写入必须 fail-closed，不能撞上第一个就算成功）。 */
const SYNTHETIC_MTD_DUP_ID_XML = `<?xml version="1.0" encoding="utf-8"?>
<material name="synthetic_mtd_writer_dup" version="1.0">
  <param id="7" type="float" name="A">1.0</param>
  <param id="7" type="float" name="B">2.0</param>
</material>
`;

async function readMtd(path: string, allowedRoots: string[]): Promise<MtdEnvelope> {
  const result = await runBridge<MtdEnvelope>({
    command: 'read-mtd-document',
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000
  });
  if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
    throw new Error(`read-mtd-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

async function writeMtd(
  sourcePath: string,
  allowedRoots: string[],
  writableRoots: string[],
  outputPath: string,
  expectedDocumentHash: string,
  paramId: string,
  newValue: string
): Promise<BridgeResult<WriteEnvelope>> {
  return runBridge<WriteEnvelope>({
    command: MTD_WRITE_COMMAND,
    filePath: sourcePath,
    allowedRoots,
    writableRoots,
    timeoutMs: 120_000,
    commandOptions: {
      outputPath,
      expectedDocumentHash,
      paramId,
      newValue
    }
  });
}

const fileSize = async (p: string): Promise<number> =>
  stat(p).then((s) => s.size).catch(() => 0);

/**
 * 找出 output 与 source 的全部差异连续区间。同长替换时期望恰好一个区间，
 * 且区间内容正是「旧值 → 新值」——字节外科「只改目标 span」的直接证明。
 */
function byteDiffRegions(source: Buffer, output: Buffer): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  let i = 0;
  const maxLen = Math.max(source.length, output.length);
  while (i < maxLen) {
    const s = i < source.length ? source[i] : -1;
    const o = i < output.length ? output[i] : -1;
    if (s === o) { i += 1; continue; }
    const start = i;
    while (i < maxLen) {
      const ss = i < source.length ? source[i] : -1;
      const oo = i < output.length ? output[i] : -1;
      if (ss !== oo) { i += 1; continue; }
      break;
    }
    regions.push({ start, end: i });
  }
  return regions;
}

async function syntheticLeg(): Promise<void> {
  await withSmokeWorkspace('native-mtd-writer', async (workspace) => {
    const root = workspace.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    // ---- 0. 干净语料：读取 + 断言 unkA 未知属性确实被登记（partial 前提）。 ----
    const srcPath = join(root, 'synthetic_writer_smoke.mtd');
    await writeFile(srcPath, SYNTHETIC_MTD_XML, 'utf8');
    const srcDoc = await readMtd(srcPath, [root]);
    const srcBytes = await readFile(srcPath);
    const srcHash = srcDoc.sourceHash!;
    const srcGaps = srcDoc.unparsedGaps ?? [];
    const srcProps = srcDoc.properties ?? [];
    const unkParam = srcProps.find((p) => p.id === '2');
    if (unkParam?.unknown?.unkA !== '42') {
      throw new Error(`合成语料 param id=2 应带 unknown 属性 unkA=42：${JSON.stringify(unkParam?.unknown)}`);
    }
    if (!srcGaps.includes('unexpected-attribute:param/unkA')) {
      throw new Error(`合成语料应登记 unkA 未知属性 gap：${JSON.stringify(srcGaps)}`);
    }
    if (srcDoc.authority !== 'partial') {
      throw new Error(`含未知属性的源 authority 应为 partial，实际 ${srcDoc.authority}`);
    }

    // ---- 1. 原位替换（同长，且新旧值每个字节都不同，diff 恰为单区间）：SpecularPower 320 → 965。 ----
    const outA = join(staging, 'out-a.mtd');
    const writeA = await writeMtd(srcPath, [root], [staging], outA, srcHash, '1', '965');
    if (writeA.parseStatus === 'failed' || !writeA.data?.rereadVerified) {
      throw new Error(`原位 write 未重读验证：${JSON.stringify(writeA.diagnostics)}`);
    }
    if (!writeA.diagnostics.some((d) => d.code === MTD_STAGING_WRITE_VERIFIED)) {
      throw new Error(`原位 write 未发 ${MTD_STAGING_WRITE_VERIFIED}：${JSON.stringify(writeA.diagnostics)}`);
    }
    if (writeA.data.valueBefore !== '320' || writeA.data.valueAfter !== '965') {
      throw new Error(`valueBefore/After 不符：${JSON.stringify(writeA.data)}`);
    }
    const outABytes = await readFile(outA);
    const diffRegions = byteDiffRegions(srcBytes, outABytes);
    if (diffRegions.length !== 1) {
      throw new Error(`同长替换应恰好一个差异区间，实际 ${JSON.stringify(diffRegions)}`);
    }
    const oldSpan = srcBytes.subarray(diffRegions[0]!.start, diffRegions[0]!.end).toString('utf8');
    const newSpan = outABytes.subarray(diffRegions[0]!.start, diffRegions[0]!.end).toString('utf8');
    if (oldSpan !== '320' || newSpan !== '965') {
      throw new Error(`差异区间内容应为 320→965，实际 ${oldSpan}→${newSpan}`);
    }

    // ---- 2. 重读 out-a：值命中、兄弟 param / unknown / gaps / authority 原样。 ----
    const outADoc = await readMtd(outA, [staging]);
    const outAProps = outADoc.properties ?? [];
    const target = outAProps.find((p) => p.id === '1');
    if (target?.value !== '965') throw new Error(`重读 target value=${target?.value}，期望 965`);
    for (const id of ['0', '2']) {
      const before = srcProps.find((p) => p.id === id);
      const after = outAProps.find((p) => p.id === id);
      if (!before || !after) throw new Error(`param ${id} 重读丢失`);
      if (after.value !== before.value) throw new Error(`param ${id} 值被改：${after.value} vs ${before.value}`);
      if (after.type !== before.type || after.name !== before.name) {
        throw new Error(`param ${id} type/name 被改`);
      }
    }
    const unkAfter = outAProps.find((p) => p.id === '2')?.unknown;
    if (unkAfter?.unkA !== '42') {
      throw new Error(`重读后未知属性 unkA 丢失：${JSON.stringify(unkAfter)}`);
    }
    if (JSON.stringify(outADoc.unparsedGaps ?? []) !== JSON.stringify(srcGaps)) {
      throw new Error(`重读后 unparsedGaps 变化：${JSON.stringify(outADoc.unparsedGaps)} vs ${JSON.stringify(srcGaps)}`);
    }
    if (outADoc.authority !== srcDoc.authority) {
      throw new Error(`重读后 authority 变化：${outADoc.authority} vs ${srcDoc.authority}`);
    }
    if (!outADoc.roundTrip?.consistent) {
      throw new Error('重读后的 read-mtd-document roundTrip.consistent 应为 true');
    }

    // ---- 3. 变长替换：CustomTint 1.0 → 0.750000（目标带未知属性 unkA，必须无损）。
    //        shaderPath 来自 id=0 的 shader param，未被触碰 → 必须保持原样。 ----
    const outB = join(staging, 'out-b.mtd');
    const writeB = await writeMtd(srcPath, [root], [staging], outB, srcHash, '2', '0.750000');
    if (writeB.parseStatus === 'failed' || !writeB.data?.rereadVerified) {
      throw new Error(`变长 write 未重读验证：${JSON.stringify(writeB.diagnostics)}`);
    }
    const outBDoc = await readMtd(outB, [staging]);
    const tintAfter = (outBDoc.properties ?? []).find((p) => p.id === '2');
    if (tintAfter?.value !== '0.750000') {
      throw new Error(`变长重读 CustomTint 未命中：${tintAfter?.value}`);
    }
    if (tintAfter?.unknown?.unkA !== '42') {
      throw new Error(`变长写回后目标 param 的未知属性 unkA 丢失：${JSON.stringify(tintAfter?.unknown)}`);
    }
    if (outBDoc.shaderPath !== 'mtd/synthetic/smoke_shader.mtd') {
      throw new Error(`未触碰的 shaderPath 被改动：${outBDoc.shaderPath}`);
    }

    // ---- 3b. shader param 写回：shaderPath 投影应随预期更新（约定式 best-effort）。 ----
    const outC = join(staging, 'out-c.mtd');
    const writeC = await writeMtd(srcPath, [root], [staging], outC, srcHash, '0', 'mtd/synthetic/replaced_shader.mtd');
    if (writeC.parseStatus === 'failed' || !writeC.data?.rereadVerified) {
      throw new Error(`shader write 未重读验证：${JSON.stringify(writeC.diagnostics)}`);
    }
    const outCDoc = await readMtd(outC, [staging]);
    const shaderAfter = (outCDoc.properties ?? []).find((p) => p.id === '0');
    if (shaderAfter?.value !== 'mtd/synthetic/replaced_shader.mtd') {
      throw new Error(`shader 重读值未命中：${shaderAfter?.value}`);
    }
    if (outCDoc.shaderPath !== 'mtd/synthetic/replaced_shader.mtd') {
      throw new Error(`shaderPath 投影未随 shader param 更新：${outCDoc.shaderPath}`);
    }

    // ---- 4. before image：源文件字节不变。 ----
    if (!(await readFile(srcPath)).equals(srcBytes)) {
      throw new Error('write 后源文件（before image）被改动');
    }

    // ---- 5. block 语义：目标 param 内容含子元素 → MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE 且不落盘。 ----
    const blockedSrc = join(root, 'synthetic_blocked.mtd');
    await writeFile(blockedSrc, SYNTHETIC_MTD_BLOCKED_XML, 'utf8');
    const blockedDoc = await readMtd(blockedSrc, [root]);
    const blockedOut = join(staging, 'blocked.mtd');
    const blocked = await writeMtd(blockedSrc, [root], [staging], blockedOut, blockedDoc.sourceHash!, '0', '99');
    if (blocked.parseStatus !== 'failed'
      || !blocked.diagnostics.some((d) => d.code === MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE)) {
      throw new Error(`block 用例未按 ${MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE} 失败关闭：${JSON.stringify(blocked.diagnostics)}`);
    }
    if ((await fileSize(blockedOut)) !== 0) {
      throw new Error('block 用例落盘了输出文件（fail-closed 必须不落盘）');
    }

    // ---- 6. 失败注入：hash 不匹配 / paramId 不存在 / paramId 不唯一 → MTD_STAGING_WRITE_FAILED 且不落盘。 ----
    const dupSrc = join(root, 'synthetic_dup.mtd');
    await writeFile(dupSrc, SYNTHETIC_MTD_DUP_ID_XML, 'utf8');
    const dupDoc = await readMtd(dupSrc, [root]);
    const badCases: Array<{ label: string; path: string; hash: string; paramId: string; value: string }> = [
      { label: 'hash不匹配', path: srcPath, hash: '0'.repeat(64), paramId: '1', value: '1.0' },
      { label: 'paramId不存在', path: srcPath, hash: srcHash, paramId: 'does-not-exist', value: '1.0' },
      { label: 'paramId不唯一', path: dupSrc, hash: dupDoc.sourceHash!, paramId: '7', value: '1.0' }
    ];
    for (const bad of badCases) {
      const badOut = join(staging, `bad-${bad.label}.mtd`);
      const attempt = await writeMtd(bad.path, [root], [staging], badOut, bad.hash, bad.paramId, bad.value);
      if (attempt.parseStatus !== 'failed'
        || !attempt.diagnostics.some((d) => d.code === MTD_STAGING_WRITE_FAILED)) {
        throw new Error(`${bad.label} 未按 ${MTD_STAGING_WRITE_FAILED} 失败关闭：${JSON.stringify(attempt.diagnostics)}`);
      }
      if ((await fileSize(badOut)) !== 0) {
        throw new Error(`${bad.label} 落盘了输出文件（fail-closed 必须不落盘）`);
      }
    }
    if (!(await readFile(srcPath)).equals(srcBytes)) {
      throw new Error('失败注入后源文件（before image）被改动');
    }

    // ---- 7. 绝对路径脱敏 + 输出。 ----
    const output = JSON.stringify({
      ok: true,
      status: 'synthetic-fixture',
      syntheticFixture: true,
      fixtureRole: 'mtd-primary',
      message: 'MTD material property set 写回/重读/未知属性无损/block/失败注入验证通过',
      authority: 'partial', // 源含 unkA 未知属性；写回后如实保持 partial，不冒充 candidate 以上。
      target: {
        paramId: '1',
        name: target?.name,
        from: writeA.data.valueBefore,
        to: writeA.data.valueAfter
      },
      writeA: {
        code: MTD_STAGING_WRITE_VERIFIED,
        rereadVerified: writeA.data.rereadVerified,
        byteDiffExactlyOneRegion: diffRegions.length === 1,
        changedSpan: `${oldSpan}→${newSpan}`
      },
      writeB: {
        code: MTD_STAGING_WRITE_VERIFIED,
        rereadVerified: writeB.data.rereadVerified,
        tintValueAfter: tintAfter?.value,
        targetUnknownAttributePreserved: tintAfter?.unknown?.unkA === '42',
        shaderPathUntouched: outBDoc.shaderPath
      },
      writeC: {
        code: MTD_STAGING_WRITE_VERIFIED,
        rereadVerified: writeC.data.rereadVerified,
        shaderPathAfter: outCDoc.shaderPath
      },
      unknownAttributePreserved: unkAfter?.unkA === '42',
      unparsedGapsPreserved: JSON.stringify(outADoc.unparsedGaps ?? []) === JSON.stringify(srcGaps),
      blocked: {
        code: MTD_WRITE_BLOCKED_UNKNOWN_STRUCTURE,
        noOutputLanded: (await fileSize(blockedOut)) === 0
      },
      invalidRejected: badCases.length,
      beforeImagePreserved: (await readFile(srcPath)).equals(srcBytes)
    }, null, 2);
    if (output.includes(root)) {
      throw new Error('smoke 输出泄漏了本机绝对路径（脱敏失败）');
    }
    console.log(output);
  });
}

async function corpusLeg(explicitPath: string | undefined): Promise<void> {
  await withSmokeWorkspace('native-mtd-writer-corpus', async (workspace) => {
    const root = workspace.root;
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });

    const source = await resolveNativeFixture(
      explicitPath,
      'mtd-primary',
      '../../mtd/m_a.mtd'
    );

    // MTD 可能在 mtdbnd.dcx 容器内；先提取子项再读（与 FXR/TPF smoke 同路径）。
    let mtdPath = source;
    if (source.endsWith('.dcx') || source.endsWith('.bnd')) {
      const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT;
      mtdPath = join(staging, 'extracted.mtd');
      const extract = await runBridge<ExtractEnvelope>({
        command: 'extract-bnd4-child',
        filePath: source,
        allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
        writableRoots: [staging],
        commandOptions: { entryIndex: 0, outputPath: mtdPath },
        timeoutMs: 180_000,
        ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
      });
      const verdict = classifyChildExtract(extract);
      if (verdict.kind === 'infrastructure-failure') {
        reportInfrastructureFailure('MTD', 'MTD_FIXTURE_EXTRACT_INFRASTRUCTURE_FAILURE', verdict);
        return;
      }
      if (verdict.kind === 'missing-child') {
        console.log(JSON.stringify({
          ok: true,
          status: 'skipped',
          message: 'MTD fixture not available in container (子项不存在).',
          diagnostics: verdict.codes
        }));
        return;
      }
    }

    // 源先拷进暂存工作区，再在 staging 内读写：daemon 的 writableRoots 必须落在
    // allowedRoots 内，而 registry 源（游戏 mtd/ 目录）与临时 staging 是两个根。
    const srcInStaging = join(staging, 'source.mtd');
    await copyFile(mtdPath, srcInStaging);
    const doc = await readMtd(srcInStaging, [staging]);
    const allowed = new Set(['candidate', 'partial', 'fixture-confirmed']);
    if (doc.authority === undefined || !allowed.has(doc.authority)) {
      throw new Error(`真实语料 authority 应属于 ${[...allowed].join('/')}，实际 ${doc.authority}`);
    }
    const target = (doc.properties ?? []).find((p) => p.id !== undefined && p.id !== null && p.id !== '');
    if (!target) {
      throw new Error('真实 MTD 语料没有可写回的有 id 的 param。');
    }
    // 写回合成值：真实语料只读，输出进暂存区；改动值是 synthetic smoke 标记。
    const newValue = `${target.value ?? ''} //SOULFORGE-SYNTHETIC-SMOKE`;
    const outPath = join(staging, 'out.mtd');
    const write = await writeMtd(srcInStaging, [staging], [staging], outPath, doc.sourceHash!, target.id!, newValue);
    if (write.parseStatus === 'failed' || !write.data?.rereadVerified) {
      throw new Error(`真实语料 write 未重读验证：${JSON.stringify(write.diagnostics)}`);
    }
    if (!write.diagnostics.some((d) => d.code === MTD_STAGING_WRITE_VERIFIED)) {
      throw new Error(`真实语料 write 未发 ${MTD_STAGING_WRITE_VERIFIED}：${JSON.stringify(write.diagnostics)}`);
    }
    const reopened = await readMtd(outPath, [staging]);
    const reopenedTarget = (reopened.properties ?? []).find((p) => p.id === target.id);
    if (reopenedTarget?.value !== newValue) {
      throw new Error(`真实语料重读 target value=${reopenedTarget?.value} 与写入 ${newValue} 不一致`);
    }
    if ((reopened.unparsedGaps ?? []).length !== (doc.unparsedGaps ?? []).length) {
      throw new Error(`真实语料重读 unparsedGaps 数量变化：${JSON.stringify(reopened.unparsedGaps)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      syntheticFixture: false,
      message: `MTD native 写回验证通过（${doc.properties?.length ?? 0} params）`,
      target: { paramId: target.id, name: target.name, valueBefore: write.data.valueBefore, valueAfter: write.data.valueAfter },
      authority: doc.authority,
      roundTrip: reopened.roundTrip,
      unparsedGaps: reopened.unparsedGaps,
      rereadVerified: write.data.rereadVerified,
      sourceFile: basename(source)
    }, null, 2));
  });
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const registered = await nativeFixtureRoleRegistered('mtd-primary');
  if (!explicitPath && !registered) {
    // 缺语料（未登记且未显式给路径）：合成 fixture leg。native leg 在此状态下
    // 诚实 skip——合成语料带 syntheticFixture 标记，不冒充 native authority。
    await syntheticLeg();
  } else {
    await corpusLeg(explicitPath);
  }
}

main()
  .then(async () => {
    await disposeBridgeDaemonPool();
  })
  .catch(async (error) => {
    await disposeBridgeDaemonPool();
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
