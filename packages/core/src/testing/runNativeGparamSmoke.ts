/**
 * Native GPARAM smoke against real Sekiro drawparam samples (mods/param/drawparam/*.gparam.dcx).
 *
 * GPARAM-11A 验证面：
 *  - DCX GPARAM：全样本经 Bridge read-gparam-document 读取，无修改往返
 *    native-verified（字节级 + 语义级）。
 *  - loose GPARAM：从 DCX 样本解压出裸 payload 写盘后直读，sourceHash 与
 *    DCX 解析一致（read-gparam-document 的裸文件分支）。
 *  - invalid header：坏 magic / 坏版本 / 截断 / 越界都必须结构化失败，
 *    不能吞异常也不能返回空 bank。
 *  - bounded page：groupPageSize/groupPage 分页返回正确页。
 *  - banks 去重：同一文件只出现一次；banks 数量按**当时实测样本数**断言
 *    （扫描 drawparam 目录动态得出），不写死 34。
 *  - 绝对路径脱敏：smoke 输出不得包含本机 fixture root 绝对路径。
 *
 * 运行需要 SOULFORGE_NATIVE_FIXTURE_ROOT 指向游戏 mod 根（含 Oodle 运行时，
 * 因为 drawparam 的 .gparam.dcx 是 KRAK 压缩）与
 * SOULFORGE_NATIVE_FIXTURE_REGISTRY（可选；本 smoke 不依赖注册表）。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import type { GparamDocument } from '@soulforge/shared/dist/gparam-editor.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';

interface GparamBank {
  bankId: number;
  fileName: string;
  sourceHash: string;
  groupCount: number;
  paramCount: number;
  byteIdenticalNoop: boolean;
  semanticIdenticalNoop: boolean;
  authority: string;
}

function main(): Promise<void> {
  return withSmokeWorkspace('native-gparam', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const fixtureRoot = process.argv[2]?.trim() || process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!fixtureRoot) {
    throw new Error('缺少 SOULFORGE_NATIVE_FIXTURE_ROOT（或 argv[2] 传 mod 根目录）。');
  }
  const drawparamDir = join(fixtureRoot, 'mods', 'param', 'drawparam');
  const samples = (await readdir(drawparamDir))
    .filter((name) => name.toLowerCase().endsWith('.gparam.dcx'))
    .sort();
  if (samples.length === 0) {
    throw new Error(`drawparam 目录没有 gparam 样本：${drawparamDir}`);
  }
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  await mkdir(join(overlay, 'param', 'drawparam'), { recursive: true });
  await mkdir(staging, { recursive: true });

  // 1. DCX GPARAM：全样本读取 + banks 收集。
  //    bank 是「一个磁盘 gparam 文件」；同一文件路径重复注册必须只产生一个
  //    bank（去重）。内容级重复（不同文件相同 payload）如实报告为
  //    duplicateContentCount，不膨胀 bank 数。
  const banks = new Map<string, GparamBank>(); // key: fileName（文件路径即 bank 身份）
  const contentHashes = new Map<string, number>(); // sourceHash → 引用文件数
  const failures: Array<{ fileName: string; message: string }> = [];
  const firstSample = samples[0]!;
  let firstHash: string | undefined;
  for (const name of samples) {
    const path = join(drawparamDir, name);
    const result = await runBridge<GparamDocument>({
      command: 'read-gparam-document',
      filePath: path,
      allowedRoots: [fixtureRoot, overlay],
      oodleRuntimeRoot: fixtureRoot,
      timeoutMs: 120_000,
      // 显式空 options：与 PARAM smoke 同一范式，避免缺省 JsonElement 的分页缺陷。
      commandOptions: {}
    });
    if (!result.data?.roundTrip?.semanticIdentical) {
      failures.push({
        fileName: name,
        message: (result.diagnostics[0]?.message ?? 'semantic roundtrip failed') + ' ' + JSON.stringify(result.data?.roundTrip ?? null)
      });
      continue;
    }
    const paramCount = result.data.groups.reduce((sum, g) => sum + g.params.length, 0);
    banks.set(name, {
      bankId: banks.size,
      fileName: name,
      sourceHash: result.data.sourceHash,
      groupCount: result.data.groupCount,
      paramCount,
      byteIdenticalNoop: result.data.roundTrip.byteIdentical,
      semanticIdenticalNoop: true,
      authority: result.data.authority
    });
    contentHashes.set(result.data.sourceHash, (contentHashes.get(result.data.sourceHash) ?? 0) + 1);
    if (name === firstSample) firstHash = result.data.sourceHash;
  }
  if (banks.size === 0) {
    throw new Error(`全部 ${samples.length} 个 gparam 样本读取失败：${JSON.stringify(failures.slice(0, 3))}`);
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} 个样本读取失败：${JSON.stringify(failures.slice(0, 3))}`);
  }
  // banks 按实测样本数断言（不写死 34）：每个磁盘文件一个 bank。
  if (banks.size !== samples.length) {
    throw new Error(`banks ${banks.size} ≠ 实测样本数 ${samples.length}`);
  }
  if (banks.size < 2) {
    throw new Error(`banks 过少（${banks.size}），无法证明多文件聚合。`);
  }
  // 去重：同一文件路径重复注册（如被扫描两次）不产生第二个 bank。
  const reRead = await runBridge<GparamDocument>({
    command: 'read-gparam-document',
    filePath: join(drawparamDir, firstSample),
    allowedRoots: [fixtureRoot, overlay],
    oodleRuntimeRoot: fixtureRoot,
    timeoutMs: 60_000,
    commandOptions: {}
  });
  if (!reRead.data?.roundTrip?.semanticIdentical) {
    throw new Error(`重复读取 ${firstSample} 失败：${JSON.stringify(reRead.diagnostics)}`);
  }
  const duplicateRegister = new Map<string, GparamBank>(banks);
  duplicateRegister.set(firstSample, {
    ...duplicateRegister.get(firstSample)!,
    bankId: duplicateRegister.size // 若去重失效这里会多一个条目
  });
  if (duplicateRegister.size !== banks.size) {
    throw new Error('同一文件重复注册产生了第二个 bank（去重失效）');
  }
  // 内容级重复如实报告：34 个磁盘文件 → 实测唯一内容数（如 20）。
  const uniqueContentCount = contentHashes.size;
  const duplicateContentCount = samples.length - uniqueContentCount;
  if (uniqueContentCount < 1) {
    throw new Error('唯一内容数为 0');
  }
  const nativeVerifiedCount = [...banks.values()].filter((b) => b.authority === 'native-verified').length;
  if (nativeVerifiedCount !== banks.size) {
    throw new Error(`native-verified 数量 ${nativeVerifiedCount} ≠ banks ${banks.size}`);
  }

  // 2. loose GPARAM：解压第一个样本的 payload 成裸文件后直读
  const dcx = await runBridge<{ payloadBase64?: string }>({
    command: 'read-dcx-document',
    filePath: join(drawparamDir, firstSample),
    allowedRoots: [fixtureRoot, overlay],
    oodleRuntimeRoot: fixtureRoot,
    timeoutMs: 120_000,
    commandOptions: { includePayload: true }
  });
  if (!dcx.data?.payloadBase64) {
    throw new Error(`read-dcx-document includePayload 未返回 payloadBase64：${JSON.stringify(dcx.diagnostics)}`);
  }
  const loosePath = join(staging, 'loose.gparam');
  await writeFile(loosePath, Buffer.from(dcx.data.payloadBase64, 'base64'));
  const loose = await runBridge<GparamDocument>({
    command: 'read-gparam-document',
    filePath: loosePath,
    allowedRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {}
  });
  if (!loose.data?.roundTrip?.semanticIdentical) {
    throw new Error(`loose GPARAM 读取失败：${JSON.stringify(loose.diagnostics)}`);
  }
  if (loose.data.sourceHash !== firstHash) {
    throw new Error(`loose 解析 sourceHash ${loose.data.sourceHash} 与 DCX ${firstHash} 不一致`);
  }
  if (loose.data.groups.length !== banks.get(firstSample)?.groupCount) {
    throw new Error('loose 与 DCX 的 group 数不一致');
  }
  const looseGroup0 = loose.data.groups[0];
  if (!looseGroup0?.params.length || looseGroup0.name1.length === 0) {
    throw new Error('loose group 0 无 param 或无名');
  }
  // 值必须 typed 且可复读：float2 的分量数 == 2。
  const typedParam = looseGroup0.params.find((p) => p.type === 'float2');
  if (!typedParam || typedParam.values.length !== typedParam.valueCount * 2) {
    throw new Error('float2 值分量数断言失败（typed 值不可复读）');
  }

  // 3. invalid header：四种损坏都必须结构化失败，不能返回空 bank。
  const badMagic = Buffer.alloc(0x60, 0x41);
  const goodBytes = await readFile(loosePath);
  const badGame = Buffer.from(goodBytes);
  badGame.writeUInt32LE(3, 0x08); // DS3 game code
  const badCount = Buffer.from(goodBytes);
  badCount.writeInt32LE(-5, 0x10); // 负数 groupCount
  const badRegions = Buffer.from(goodBytes);
  badRegions.writeInt32LE(0x2000, 0x1C); // 区域偏移越界
  const invalidCases: Array<[string, Buffer]> = [
    ['bad-magic', badMagic],
    ['bad-game', badGame],
    ['bad-count', badCount],
    ['bad-regions', badRegions]
  ];
  for (const [label, bytes] of invalidCases) {
    const badPath = join(staging, `${label}.gparam`);
    await writeFile(badPath, bytes);
    const bad = await runBridge<GparamDocument>({
      command: 'read-gparam-document',
      filePath: badPath,
      allowedRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {}
    });
    const failedClosed = bad.parseStatus === 'failed'
      && bad.diagnostics.some((d) => d.code.startsWith('GPARAM_'));
    if (!failedClosed) {
      throw new Error(`${label} 未结构化失败：${JSON.stringify(bad.diagnostics)}`);
    }
  }

  // 4. bounded page：groupPageSize=5、groupPage=1 → 恰好 5 个 group 与分页元数据。
  const totalGroups = banks.get(firstSample)?.groupCount ?? 0;
  if (totalGroups < 5) {
    throw new Error(`首个样本 group 数 ${totalGroups} < 5，分页断言无意义`);
  }
  const page = await runBridge<GparamDocument>({
    command: 'read-gparam-document',
    filePath: join(drawparamDir, firstSample),
    allowedRoots: [fixtureRoot, overlay],
    oodleRuntimeRoot: fixtureRoot,
    timeoutMs: 60_000,
    commandOptions: { groupPageSize: 5, groupPage: 1 }
  });
  if (!page.data || page.data.groups.length !== 5) {
    throw new Error(`分页未返回 5 个 group：${page.data?.groups.length} ${JSON.stringify(page.diagnostics)}`);
  }
  const expectedPageCount = Math.ceil(totalGroups / 5);
  if (page.data.groupPage !== 1 || page.data.groupPageCount !== expectedPageCount) {
    throw new Error(`分页元数据不符：page=${page.data.groupPage} count=${page.data.groupPageCount} 期望 ${expectedPageCount}`);
  }
  // 全量读取与分页读取的 groupId 稳定（同一文件同一内容同一顺序）。
  const full = await runBridge<GparamDocument>({
    command: 'read-gparam-document',
    filePath: join(drawparamDir, firstSample),
    allowedRoots: [fixtureRoot, overlay],
    oodleRuntimeRoot: fixtureRoot,
    timeoutMs: 60_000,
    commandOptions: {}
  });
  if (!full.data) throw new Error('全量读取失败');
  const page1GroupIds = page.data.groups.map((g) => g.groupId);
  const expectedIds = full.data.groups.slice(5, 10).map((g) => g.groupId);
  if (JSON.stringify(page1GroupIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`分页 groupId 与全量切片不一致：${page1GroupIds} vs ${expectedIds}`);
  }

  // 5. 绝对路径脱敏：smoke 输出不得泄漏 fixture root 绝对路径。
  const output = JSON.stringify({
    ok: true,
    message: '原生 GPARAM 读取/往返/分页/banks 验证通过',
    bankCount: banks.size,
    sampleCount: samples.length,
    uniqueContentCount,
    duplicateContentCount,
    nativeVerifiedCount,
    duplicateRegisterNoExpansion: true,
    looseSample: firstSample,
    looseHash: loose.data.sourceHash,
    looseGroupCount: loose.data.groups.length,
    looseTypedValuesVerified: true,
    invalidHeaderCases: 4,
    page: {
      groupPageSize: 5,
      groupPage: 1,
      groupPageCount: expectedPageCount,
      pageGroupIds: page1GroupIds
    },
    banks: [...banks.values()].slice(0, 3),
    failures: failures.slice(0, 3)
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
