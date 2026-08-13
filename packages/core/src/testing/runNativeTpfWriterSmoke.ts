/**
 * Native TPF writer smoke（TEXTURE-52C）——typed texture replace 与 roundtrip。
 *
 * 从真实 texbnd 容器提取裸 .tpf（与 read-tpf 同一语料），用**合成** DDS
 * （微小、合法构造、明确标记）替换其中一个纹理，验证：
 *
 *  - 原位路径：替换 DDS 与目标同尺寸同格式同 mipmap、blob 大小相同 →
 *    替换后目标 blob 字节级一致、未替换纹理 dataSize/名称不变。
 *  - 重排路径：替换 DDS blob 大小不同 → 数据区整体重排，其余纹理 dataOffset
 *    随之更新但 blob 内容不变（export 对比），reader 重读仍 native-verified。
 *  - reopen：替换后的文件 read-tpf-document 必须仍能读（authority
 *    native-verified），roundTrip 语义一致。
 *  - 失败注入：尺寸不符 / DXGI 格式与色彩空间不符 / mip 不符 / hash 不符 /
 *    索引越界 / 非法 DDS → TPF_STAGING_WRITE_FAILED 且不落盘；before image
 *    （源 tpf）字节不变（rollback 前提）。
 *  - 不提供 bytes replace fallback：没有 typed 定位就没有写入口。
 *
 * 校验基准是**目标纹理 DDS 头声明的 fourCC/DXGI**，不是 TPF 条目表 format 字段
 * （52A 实测条目表查表结果与真实格式系统性错配）。合成替换 DDS 的 dxgi 从
 * 目标纹理读出，保证与目标一致。
 *
 * 运行需要 SOULFORGE_NATIVE_FIXTURE_ROOT（或 argv[2]）指向游戏 mod 根。
 * texbnd 内 TPF 是未压缩裸 .tpf（52A 已确认），故本套件不覆盖 DCX 路径——
 * TpfNativeWriter 的 DCX 分支与 GparamNativeWriter 同构，由 gparam writer
 * smoke 的 DCX profile 通用验证。
 */
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';

interface TpfEnvelope {
  authority?: string;
  textureCount?: number;
  sourceHash?: string;
  textures?: Array<{
    index: number;
    name: string;
    format: string;
    mipCount: number;
    dataSize: number;
    dataOffset: number;
    width: number;
    height: number;
    ddsFourCC: string;
  }>;
}

interface WriteEnvelope {
  outputHash?: string;
  outputSize?: number;
  dataSizeBefore?: number;
  dataSizeAfter?: number;
  rereadVerified?: boolean;
}

interface ExtractEnvelope {
  contentHash?: string;
  contentSize?: number;
}

/** DXGI 数值 → 每块字节数（BC1/BC4 为 8，其余 BC 家族为 16）。 */
const BLOCK8_DXGI = new Set([71, 72, 80, 81]);
/** DdsCodec 支持解码的 DXGI 闭集（替换校验的合法闭集）。 */
const DECODABLE_DXGI = new Set([71, 72, 77, 80, 83, 98, 99]);

/**
 * 构造一个**合法、微小、明确合成**的 DDS 文件字节。
 *
 * 只写 reader（read-tpf-document / DdsCodec）会读的字段：魔数、尺寸、mip、
 * pixel-format fourCC、DX10 扩展头的 dxgi。payload 用固定字节填充——BC 压缩块
 * 可以是任意字节，这是合法纹理数据（不是真实资产）。
 */
function buildDds(
  width: number,
  height: number,
  mipCount: number,
  fourCc: string,
  dxgi: number | undefined,
  payload: Buffer
): Buffer {
  const isDx10 = fourCc === 'DX10';
  const headerSize = isDx10 ? 148 : 128;
  const header = Buffer.alloc(headerSize);
  header.write('DDS ', 0, 'ascii');
  header.writeUInt32LE(124, 4); // dwSize
  // flags: DDSD_CAPS|DDSD_HEIGHT|DDSD_WIDTH|DDSD_PIXELFORMAT|DDSD_LINEARSIZE|DDSD_MIPMAPCOUNT
  header.writeUInt32LE(0xA1007, 8);
  header.writeUInt32LE(height, 12);
  header.writeUInt32LE(width, 16);
  const blockBytes = isDx10 && dxgi !== undefined && BLOCK8_DXGI.has(dxgi) ? 8 : 16;
  const pitch = Math.max(1, Math.ceil(width / 4)) * blockBytes;
  header.writeUInt32LE(pitch, 20);
  header.writeUInt32LE(mipCount, 28);
  header.writeUInt32LE(32, 76); // pixel format size
  header.writeUInt32LE(0x4, 80); // DDPF_FOURCC
  header.write(fourCc, 84, 'ascii');
  header.writeUInt32LE(0x1000, 108); // DDSCAPS_TEXTURE
  if (isDx10 && dxgi !== undefined) {
    header.writeUInt32LE(dxgi, 128);
    header.writeUInt32LE(0, 132); // miscFlag
    header.writeUInt32LE(1, 136); // arraySize
    header.writeUInt32LE(0, 140); // miscFlags2
  }
  return Buffer.concat([header, payload]);
}

async function readTpf(path: string, allowedRoots: string[]): Promise<TpfEnvelope> {
  const result = await runBridge<TpfEnvelope>({
    command: 'read-tpf-document',
    filePath: path,
    allowedRoots,
    timeoutMs: 120_000
  });
  if (result.parseStatus === 'failed' || !result.data?.textures?.length) {
    throw new Error(`read-tpf-document ${path} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return result.data;
}

async function exportTexture(
  path: string,
  allowedRoots: string[],
  writableRoots: string[],
  outputPath: string,
  textureIndex: number
): Promise<Buffer> {
  const result = await runBridge<{ byteLength?: number }>({
    command: 'export-tpf-texture',
    filePath: path,
    allowedRoots,
    writableRoots,
    timeoutMs: 120_000,
    commandOptions: { textureIndex, format: 'dds', outputPath }
  });
  if (result.parseStatus === 'failed') {
    throw new Error(`export-tpf-texture #${textureIndex} 失败：${JSON.stringify(result.diagnostics)}`);
  }
  return readFile(outputPath);
}

function main(): Promise<void> {
  return withSmokeWorkspace('native-tpf-writer', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const fixtureRoot = process.argv[2]?.trim() || process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!fixtureRoot) {
    throw new Error('缺少 SOULFORGE_NATIVE_FIXTURE_ROOT（或 argv[2] 传 mod 根目录）。');
  }
  const chrDir = join(fixtureRoot, 'mods', 'chr');
  const containers = (await readdir(chrDir))
    .filter((name) => name.toLowerCase().endsWith('.texbnd.dcx'))
    .sort();
  if (containers.length === 0) {
    throw new Error(`chr 目录没有 texbnd 样本：${chrDir}`);
  }
  const container = join(chrDir, containers[0]!);
  const id = containers[0]!.replace(/\.texbnd\.dcx$/i, '');

  const staging = join(root, 'staging');
  const mod = join(root, 'mod');
  await mkdir(staging, { recursive: true });
  await mkdir(mod, { recursive: true });

  // ---- 0. 提取真实裸 TPF 作为写链输入（before image）。 ----
  const tpfPath = join(staging, `${id}.tpf`);
  const ex = await runBridge<ExtractEnvelope>({
    command: 'extract-bnd4-child',
    filePath: container,
    allowedRoots: [chrDir],
    writableRoots: [staging],
    oodleRuntimeRoot: fixtureRoot,
    commandOptions: { childPath: `${id}.tpf`, outputPath: tpfPath },
    timeoutMs: 180_000
  });
  if (ex.parseStatus === 'failed' || !ex.data?.contentSize) {
    throw new Error(`TPF extract failed：${JSON.stringify(ex.diagnostics)}`);
  }
  const sourceDoc = await readTpf(tpfPath, [staging]);
  const beforeBytes = await readFile(tpfPath);

  // 挑一个 DdsCodec 支持解码的 DX10 纹理作为替换靶标（dxgi 闭集内，格式/色彩
  // 空间明确）。没有就换下一个容器——语料是真实游戏目录，第一个不一定合适。
  let target: NonNullable<TpfEnvelope['textures']>[number] | undefined;
  let sourceDocForTarget = sourceDoc;
  let tpfPathForTarget = tpfPath;
  for (const c of [containers[0]!, ...containers.slice(1)]) {
    const tpf = join(staging, `${c.replace(/\.texbnd\.dcx$/i, '')}.tpf`);
    const extracted = await runBridge<ExtractEnvelope>({
      command: 'extract-bnd4-child',
      filePath: join(chrDir, c),
      allowedRoots: [chrDir],
      writableRoots: [staging],
      oodleRuntimeRoot: fixtureRoot,
      commandOptions: { childPath: `${c.replace(/\.texbnd\.dcx$/i, '')}.tpf`, outputPath: tpf },
      timeoutMs: 180_000
    });
    if (extracted.parseStatus === 'failed' || !extracted.data?.contentSize) continue;
    const doc = await readTpf(tpf, [staging]);
    const candidate = (doc.textures ?? []).find((tex) => tex.ddsFourCC === 'DX10' && tex.width > 0);
    if (candidate) {
      const targetDds = await exportTexture(tpf, [staging], [staging], join(staging, 'probe.dds'), candidate.index);
      const dxgi = targetDds.readUInt32LE(128);
      if (DECODABLE_DXGI.has(dxgi)) {
        target = candidate;
        sourceDocForTarget = doc;
        tpfPathForTarget = tpf;
        break;
      }
    }
  }
  if (!target) {
    throw new Error('语料里没有可解码 DX10 纹理可作替换靶标。');
  }
  const targetIndex = target.index;
  const targetDds = await exportTexture(tpfPathForTarget, [staging], [staging], join(staging, 'target.dds'), targetIndex);
  const headerSize = 148;
  const dxgi = targetDds.readUInt32LE(128);
  const blockBytes = BLOCK8_DXGI.has(dxgi) ? 8 : 16;
  const required = Math.max(1, Math.ceil(target.width / 4)) * Math.max(1, Math.ceil(target.height / 4)) * blockBytes;

  // 源里目标纹理的真实 dataSize（原位用例要保持一致）。
  const targetDataSize = target.dataSize;
  const readAfter = async (outPath: string): Promise<TpfEnvelope> => readTpf(outPath, [staging]);
  const beforeImagePreserved = (path: string): Promise<boolean> =>
    readFile(path).then((b) => b.equals(beforeBytes));

  // ---- 1. 原位路径：同尺寸同格式同 mip、blob 大小一致。 ----
  const inPlacePayload = Buffer.alloc(Math.max(required, targetDataSize - headerSize), 0xCD);
  const inPlaceDds = buildDds(target.width, target.height, target.mipCount, 'DX10', dxgi, inPlacePayload);
  const inPlaceOut = join(staging, 'in-place.tpf');
  const inPlaceWrite = await runBridge<WriteEnvelope>({
    command: 'write-tpf-texture-replace',
    filePath: tpfPathForTarget,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: inPlaceOut,
      expectedDocumentHash: sourceDocForTarget.sourceHash,
      textureIndex: targetIndex,
      newTextureBase64: inPlaceDds.toString('base64')
    }
  });
  if (!inPlaceWrite.data?.rereadVerified || !inPlaceWrite.data.outputHash) {
    throw new Error(`in-place write 未重读验证：${JSON.stringify(inPlaceWrite.diagnostics)}`);
  }
  if (inPlaceWrite.data.dataSizeAfter !== inPlaceDds.length) {
    throw new Error(`in-place dataSizeAfter ${inPlaceWrite.data.dataSizeAfter} 与写入 ${inPlaceDds.length} 不一致`);
  }
  const inPlaceDoc = await readAfter(inPlaceOut);
  if (inPlaceDoc.sourceHash === sourceDocForTarget.sourceHash) {
    throw new Error('in-place replace 后 sourceHash 未变化（替换未生效）');
  }
  // 目标 blob 字节级一致；未替换纹理 dataSize/名称不变。
  const inPlaceTarget = inPlaceDoc.textures!.find((t) => t.index === targetIndex)!;
  if (inPlaceTarget.dataSize !== inPlaceDds.length) throw new Error('in-place 目标 dataSize 重读不一致');
  const exported = await exportTexture(inPlaceOut, [staging], [staging], join(staging, 'out-target.dds'), targetIndex);
  if (!exported.equals(inPlaceDds)) throw new Error('in-place 重读目标 blob 与写入不一致');
  for (const tex of sourceDocForTarget.textures!) {
    if (tex.index === targetIndex) continue;
    const after = inPlaceDoc.textures!.find((t) => t.index === tex.index);
    if (!after || after.dataSize !== tex.dataSize) throw new Error(`未替换纹理 ${tex.index} dataSize 被改动`);
    if (after.name !== tex.name) throw new Error(`未替换纹理 ${tex.index} 名称被改动`);
    const beforeBlob = await exportTexture(tpfPathForTarget, [staging], [staging], join(staging, `before-${tex.index}.dds`), tex.index);
    const afterBlob = await exportTexture(inPlaceOut, [staging], [staging], join(staging, `after-${tex.index}.dds`), tex.index);
    if (!beforeBlob.equals(afterBlob)) throw new Error(`未替换纹理 ${tex.index} blob 内容被改动`);
  }

  // ---- 2. 重排路径：blob 大小不同（更大 payload）→ 数据区整体重排。 ----
  const reflowPayload = Buffer.alloc(required + 4096, 0xAB);
  const reflowDds = buildDds(target.width, target.height, target.mipCount, 'DX10', dxgi, reflowPayload);
  const reflowOut = join(staging, 'reflow.tpf');
  const reflowWrite = await runBridge<WriteEnvelope>({
    command: 'write-tpf-texture-replace',
    filePath: tpfPathForTarget,
    allowedRoots: [staging],
    writableRoots: [staging],
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: reflowOut,
      expectedDocumentHash: sourceDocForTarget.sourceHash,
      textureIndex: targetIndex,
      newTextureBase64: reflowDds.toString('base64')
    }
  });
  if (!reflowWrite.data?.rereadVerified) {
    throw new Error(`reflow write 未重读验证：${JSON.stringify(reflowWrite.diagnostics)}`);
  }
  const reflowDoc = await readAfter(reflowOut);
  if (reflowDoc.authority !== 'native-verified') {
    throw new Error(`reflow 重读 authority=${reflowDoc.authority}（期望 native-verified）`);
  }
  for (const tex of sourceDocForTarget.textures!) {
    const after = reflowDoc.textures!.find((t) => t.index === tex.index);
    if (!after) throw new Error(`reflow 后纹理 ${tex.index} 丢失`);
    if (tex.index === targetIndex) {
      if (after.dataSize !== reflowDds.length) throw new Error('reflow 目标 dataSize 重读不一致');
    } else {
      if (after.dataSize !== tex.dataSize) throw new Error(`reflow 未替换纹理 ${tex.index} dataSize 被改动`);
      const beforeBlob = await exportTexture(tpfPathForTarget, [staging], [staging], join(staging, `rb-${tex.index}.dds`), tex.index);
      const afterBlob = await exportTexture(reflowOut, [staging], [staging], join(staging, `ra-${tex.index}.dds`), tex.index);
      if (!beforeBlob.equals(afterBlob)) throw new Error(`reflow 未替换纹理 ${tex.index} blob 内容被改动`);
    }
  }

  // ---- 3. 失败注入：所有非法输入必须 TPF_STAGING_WRITE_FAILED 且不落盘。 ----
  const badCases: Array<{ label: string; options: Record<string, unknown> }> = [
    {
      label: '尺寸不匹配',
      options: { textureIndex: targetIndex, newTextureBase64: buildDds(target.width / 2, target.height, target.mipCount, 'DX10', dxgi, Buffer.alloc(required / 4, 0x11)).toString('base64') }
    },
    {
      label: '格式色彩空间不匹配',
      options: { textureIndex: targetIndex, newTextureBase64: buildDds(target.width, target.height, target.mipCount, 'DX10', dxgi === 71 ? 80 : 71, Buffer.alloc(required, 0x22)).toString('base64') }
    },
    {
      label: 'mip不匹配',
      options: { textureIndex: targetIndex, newTextureBase64: buildDds(target.width, target.height, Math.max(1, target.mipCount - 1), 'DX10', dxgi, Buffer.alloc(required, 0x33)).toString('base64') }
    },
    { label: '索引越界', options: { textureIndex: 9999, newTextureBase64: inPlaceDds.toString('base64') } },
    { label: '非法DDS', options: { textureIndex: targetIndex, newTextureBase64: Buffer.from('not a dds at all').toString('base64') } },
    { label: 'hash不匹配', options: { textureIndex: targetIndex, newTextureBase64: inPlaceDds.toString('base64'), expectedDocumentHash: '0'.repeat(64) } }
  ];
  for (const bad of badCases) {
    const outPath = join(staging, `bad-${bad.label}.tpf`);
    const attempt = await runBridge<WriteEnvelope>({
      command: 'write-tpf-texture-replace',
      filePath: tpfPathForTarget,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outPath,
        expectedDocumentHash: bad.options.expectedDocumentHash ?? sourceDocForTarget.sourceHash,
        textureIndex: bad.options.textureIndex as number,
        newTextureBase64: bad.options.newTextureBase64 as string
      }
    });
    if (attempt.parseStatus !== 'failed'
      || !attempt.diagnostics.some((d) => d.code === 'TPF_STAGING_WRITE_FAILED')) {
      throw new Error(`${bad.label} 未 fail-closed：${JSON.stringify(attempt.diagnostics)}`);
    }
    const size = await stat(outPath).then((s) => s.size).catch(() => 0);
    if (size !== 0) throw new Error(`${bad.label} 落盘了输出文件（fail-closed 必须不落盘）`);
  }
  const afterImage = await readFile(tpfPathForTarget);
  if (!afterImage.equals(beforeBytes)) {
    throw new Error('替换后源 TPF（before image）被改动');
  }

  // ---- 4. 绝对路径脱敏 + 输出。 ----
  const output = JSON.stringify({
    ok: true,
    message: 'TPF texture replace 原位/重排/失败注入验证通过',
    authority: 'native-verified',
    container: containers[0],
    textureIndex: targetIndex,
    textureName: target.name,
    target: {
      width: target.width,
      height: target.height,
      mipCount: target.mipCount,
      dxgi,
      dataSizeBefore: targetDataSize,
      inPlaceDataSizeAfter: inPlaceWrite.data.dataSizeAfter,
      reflowDataSizeAfter: reflowWrite.data.dataSizeAfter
    },
    inPlace: {
      blobVerified: true,
      siblingDataSizePreserved: true,
      sourceHashChanged: inPlaceDoc.sourceHash !== sourceDocForTarget.sourceHash
    },
    reflow: {
      blobVerified: true,
      siblingBlobPreserved: true,
      authority: reflowDoc.authority
    },
    reopen: 'read-tpf-document 重读 native-verified',
    beforeImagePreserved: afterImage.equals(beforeBytes),
    invalidRejected: badCases.length
  });
  if (output.includes(fixtureRoot) || output.includes(root)) {
    throw new Error('smoke 输出泄漏了本机绝对路径（脱敏失败）');
  }
  console.log(output);
  await disposeBridgeDaemonPool();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
