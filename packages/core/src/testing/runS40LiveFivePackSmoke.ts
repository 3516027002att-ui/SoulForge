/**
 * S37 / S40 本机五件套：只读 mods 覆盖层，写入全部落临时暂存。
 * 不碰原版游戏目录，不提升 native-verified，不走 Electron UI。
 *
 * 环境：
 *   SOULFORGE_S40_MODS_ROOT   默认 <game>/mods
 *   SOULFORGE_SEKIRO_GAME_ROOT 默认本机 Sekiro 根（只给 Oodle / 定位工具）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { commitEmevdBatchViaBridge } from '../editing/emevdBridgeCommit.js';
import { encodeInstructionArgs } from '../emevd/emedfSchema.js';
import { resolveEmevdRegistry } from '../emevd/emedfRegistryResolver.js';
import { applyParamFieldMutation } from '../param/paramFieldMutation.js';
import { locateDsLuaDecompilerSync } from '../script/dsLuaDecompilerLocator.js';
import { searchRealEmedf } from './realEmedfLocator.js';
import type { ParamDefDocument } from '@soulforge/shared';

const DEFAULT_GAME = 'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro';

interface CaseResult {
  id: string;
  ok: boolean;
  detail: Record<string, unknown>;
}

function requireFile(path: string, label: string): string {
  if (!existsSync(path)) throw new Error(`${label} 不存在：${path}`);
  return path;
}

async function assertUnchanged(path: string, before: Buffer, label: string): Promise<void> {
  const after = await readFile(path);
  if (!after.equals(before)) {
    throw new Error(`${label} 源文件被改写了（只允许写暂存）`);
  }
}

function gameRoot(): string {
  return process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || DEFAULT_GAME;
}

function modsRoot(): string {
  return process.env.SOULFORGE_S40_MODS_ROOT?.trim() || join(gameRoot(), 'mods');
}

interface DcxEntry {
  name?: string;
  index?: number;
}

async function listEntries(
  filePath: string,
  allowedRoots: string[],
  oodle?: string
): Promise<DcxEntry[]> {
  const listed = await runBridge<{ nested?: { entries?: DcxEntry[] } }>({
    command: 'read-dcx-document',
    filePath,
    allowedRoots,
    ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
    timeoutMs: 180_000
  });
  return listed.data?.nested?.entries ?? [];
}

function pickEntry(entries: DcxEntry[], matcher: (name: string) => boolean, label: string): DcxEntry {
  const hits = entries.filter((entry) => matcher(entry.name ?? ''));
  const first = hits[0];
  if (!first || first.index === undefined) {
    throw new Error(`${label} 没有匹配子项`);
  }
  return first;
}

async function decompile(exePath: string, sourcePath: string): Promise<string> {
  const stageDir = await mkdtemp(join(tmpdir(), 'sf-s40-lua-'));
  const staged = join(stageDir, 'input.bin');
  await copyFile(sourcePath, staged);
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn(exePath, [staged, '--console'], {
        cwd: dirname(exePath),
        windowsHide: true,
        env: { ...process.env, DOTNET_ROLL_FORWARD: 'LatestMajor' }
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`DSLuaDecompiler 超时：${stderr || stdout}`));
      }, 60_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`DSLuaDecompiler exit ${code}: ${stderr || stdout.slice(0, 400)}`));
          return;
        }
        resolve(stdout);
      });
    });
    return text;
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const mods = modsRoot();
  const game = gameRoot();
  const oodle = existsSync(join(game, 'sekiro.exe')) ? game : undefined;
  const workspace = await mkdtemp(join(tmpdir(), 'soulforge-s40-'));
  const staging = join(workspace, 'staging');
  await mkdir(staging, { recursive: true });
  const results: CaseResult[] = [];

  const record = (id: string, detail: Record<string, unknown>): void => {
    results.push({ id, ok: true, detail });
    console.log(JSON.stringify({ id, ok: true, ...detail }));
  };

  try {
    // ---- S39 侧栏规则（纯函数，不依赖打开工作区）----
    const isScriptLibraryPath = (relativePath: string): boolean => {
      if (!/(?:^|[\\/])script[\\/]/i.test(relativePath)) return false;
      return /\.(luabnd|lua)(\.dcx)?$/i.test(relativePath);
    };
    const isBehaviorLibraryPath = (relativePath: string): boolean => {
      return /\.(tae|anibnd)(\.dcx)?$/i.test(relativePath)
        || (/(?:^|[\\/])action[\\/]/i.test(relativePath) && /\.hks(\.dcx)?$/i.test(relativePath));
    };
    if (isScriptLibraryPath('action/script/c0000_transition.hks')) {
      throw new Error('S39：action/script/*.hks 不得进脚本侧栏');
    }
    if (!isBehaviorLibraryPath('action/script/c0000_transition.hks')) {
      throw new Error('S39：action/script/*.hks 必须进动作侧栏');
    }
    if (!isScriptLibraryPath('script/aicommon.luabnd.dcx')) {
      throw new Error('S39：script/*.luabnd.dcx 必须进脚本侧栏');
    }
    if (isScriptLibraryPath('script/talk/m11_02_00_00.talkesdbnd.dcx')) {
      throw new Error('S39：talkesdbnd 不得进脚本侧栏');
    }
    record('s39-sidebar', {
      scriptExcludesHks: true,
      actionIncludesHks: true,
      talkesdStaysOut: true
    });

    // ---- S40-4 VFX 列目录（修注册表误登）----
    const vfxPath = requireFile(
      join(mods, 'sfx', 'sfxbnd_commoneffects.ffxbnd.dcx'),
      'VFX commoneffects'
    );
    const vfxBefore = await readFile(vfxPath);
    const listed = await runBridge<{ entries?: string[] }>({
      command: 'list-ffxbnd-entries',
      filePath: vfxPath,
      allowedRoots: [dirname(vfxPath), mods, ...(oodle ? [oodle] : [])],
      ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
      timeoutMs: 180_000
    });
    const vfxCodes = (listed.diagnostics ?? []).map((d) => d.code);
    if (vfxCodes.includes('BRIDGE_OUTPUT_PATH_REQUIRED')) {
      throw new Error(`VFX 列目录仍被当成写命令：${JSON.stringify(listed.diagnostics)}`);
    }
    if (listed.parseStatus === 'failed' || !listed.data?.entries?.length) {
      throw new Error(`VFX 列不出子项：${JSON.stringify(listed.diagnostics)}`);
    }
    await assertUnchanged(vfxPath, vfxBefore, 'VFX');
    record('s40-vfx-list', {
      entryCount: listed.data.entries.length,
      sample: listed.data.entries.slice(0, 3)
    });

    // ---- S37 / S40-3 TAE c1130 改时间 ----
    const anibnd = requireFile(join(mods, 'chr', 'c1130.anibnd.dcx'), 'c1130.anibnd');
    const anibndBefore = await readFile(anibnd);
    const taeLoose = join(staging, 'c1130.tae');
    const anibndEntries = await listEntries(anibnd, [dirname(anibnd), mods, ...(oodle ? [oodle] : [])], oodle);
    const taeChild = pickEntry(anibndEntries, (name) => /\.tae$/i.test(name), 'c1130.anibnd');
    const extracted = await runBridge<{ contentHash?: string }>({
      command: 'extract-bnd4-child',
      filePath: anibnd,
      allowedRoots: [dirname(anibnd), mods, ...(oodle ? [oodle] : [])],
      writableRoots: [staging],
      ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
      timeoutMs: 180_000,
      commandOptions: { entryIndex: taeChild.index, outputPath: taeLoose }
    });
    if (extracted.parseStatus === 'failed' || !existsSync(taeLoose)) {
      throw new Error(`提取 c1130 TAE 失败：${JSON.stringify(extracted.diagnostics)}`);
    }
    const taeSrc = join(staging, 'c1130.source.tae');
    await copyFile(taeLoose, taeSrc);
    const taeRead = await runBridge<{
      sourceHash?: string;
      animations?: Array<{
        animId?: number;
        eventCount?: number;
        events?: Array<{ startTime?: number; endTime?: number }>;
      }>;
    }>({
      command: 'read-tae-document',
      filePath: taeSrc,
      allowedRoots: [staging],
      timeoutMs: 120_000
    });
    if (!taeRead.data?.sourceHash) {
      throw new Error(`c1130 TAE 读失败：${JSON.stringify(taeRead.diagnostics)}`);
    }
    let applied: {
      animId: number;
      eventIndex: number;
      before: { startTime?: number; endTime?: number };
      after: { startTime?: number; endTime?: number };
    } | undefined;
    const taeOut = join(staging, 'c1130.mut.tae');
    for (const item of taeRead.data.animations ?? []) {
      if (!item.animId || !item.events?.length) continue;
      for (const [eventIndex, ev] of item.events.entries()) {
        const newStart = (ev.startTime ?? 0) + 0.05;
        const newEnd = Math.max(newStart + 0.01, (ev.endTime ?? 0) + 0.05);
        const taeWrite = await runBridge<{ rereadVerified?: boolean }>({
          command: 'write-tae-document',
          filePath: taeSrc,
          allowedRoots: [staging],
          writableRoots: [staging],
          timeoutMs: 120_000,
          commandOptions: {
            outputPath: taeOut,
            expectedDocumentHash: taeRead.data.sourceHash,
            mutations: [{
              mutation: 'update-event-times',
              animId: item.animId,
              eventIndex,
              startTime: newStart,
              endTime: newEnd
            }]
          }
        });
        if (taeWrite.diagnostics.some((d) => d.code === 'TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE')) {
          continue;
        }
        if (taeWrite.parseStatus === 'failed'
          || !taeWrite.diagnostics.some((d) => d.code === 'TAE_STAGING_WRITE_VERIFIED')) {
          throw new Error(`c1130 改时间失败：${JSON.stringify(taeWrite.diagnostics)}`);
        }
        const taeReread = await runBridge<{
          animations?: Array<{ animId?: number; events?: Array<{ startTime?: number; endTime?: number }> }>;
        }>({
          command: 'read-tae-document',
          filePath: taeOut,
          allowedRoots: [staging],
          timeoutMs: 120_000
        });
        const afterEv = taeReread.data?.animations
          ?.find((row) => row.animId === item.animId)?.events?.[eventIndex];
        if (!afterEv
          || Math.abs((afterEv.startTime ?? -1) - newStart) > 1e-3
          || Math.abs((afterEv.endTime ?? -1) - newEnd) > 1e-3) {
          throw new Error(`c1130 重读时间不符：${JSON.stringify(afterEv)}`);
        }
        applied = {
          animId: item.animId,
          eventIndex,
          before: ev,
          after: afterEv
        };
        break;
      }
      if (applied) break;
    }
    if (!applied) {
      throw new Error('c1130 全部事件时间槽都被兄弟共享，update-event-times 无法无损写入');
    }
    await assertUnchanged(anibnd, anibndBefore, 'c1130.anibnd');
    record('s37-tae-c1130', {
      ...applied,
      sourceUntouched: true,
      rollback: 'discard-staging'
    });

    const hasChr = existsSync(join(mods, 'chr', 'c1130.chrbnd.dcx'));
    record('s40-c1130-mesh', {
      overlayChrbnd: hasChr,
      note: hasChr
        ? 'overlay 有 chrbnd，UI 右栏可挂网格'
        : 'mods/chr 没有 c1130.chrbnd.dcx，不挂原版时右栏应显示「没有找到模型」'
    });

    // ---- S40-1 事件 common：读 + 增删 WaitFixedTimeFrames ----
    const commonPath = requireFile(join(mods, 'event', 'common.emevd.dcx'), 'common.emevd');
    const commonBefore = await readFile(commonPath);
    const t0 = Date.now();
    const emevdRead = await runBridge<{
      sourceHash?: string;
      eventCount?: number;
      instructionCount?: number;
      events?: Array<{ id?: number; instructionCount?: number }>;
    }>({
      command: 'read-emevd-document',
      filePath: commonPath,
      allowedRoots: [dirname(commonPath), mods, ...(oodle ? [oodle] : [])],
      ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
      timeoutMs: 180_000
    });
    const readMs = Date.now() - t0;
    if (emevdRead.parseStatus === 'failed' || !emevdRead.data?.sourceHash) {
      throw new Error(`common 读失败：${JSON.stringify(emevdRead.diagnostics)}`);
    }
    const targetEvent = (emevdRead.data.events ?? []).find((event) => (event.instructionCount ?? 0) >= 1 && event.id);
    if (!targetEvent?.id) throw new Error('common 没有可插入指令的事件');
    const emedfPath = await searchRealEmedf();
    const resolved = resolveEmevdRegistry(emedfPath);
    const waitDef = resolved.registry.instructions.find((item) =>
      item.bank === 2000 && item.id === 11
    ) ?? resolved.registry.instructions.find((item) =>
      item.name.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'waitfixedtimeframes'
    ) ?? resolved.registry.instructions.find((item) =>
      item.bank === 1001 && item.id === 1
    );
    if (!waitDef) {
      throw new Error(
        `EMEDF 没有 WaitFixedTimeFrames / 2000:11（origin=${resolved.origin} path=${emedfPath ?? 'none'} names=${
          resolved.registry.instructions.filter((item) => /wait/i.test(item.name)).map((item) => `${item.bank}:${item.id}:${item.name}`).slice(0, 12).join(',')
        })`
      );
    }
    const values: Record<string, number | boolean> = {};
    for (const [index, arg] of waitDef.args.entries()) {
      values[arg.name] = index === 0 ? 30 : 0;
    }
    const encoded = encodeInstructionArgs(resolved.registry, waitDef.bank, waitDef.id, values);
    if (!encoded.ok) throw new Error(`编码 WaitFixedTimeFrames 失败：${encoded.message}`);
    const commonSrc = join(staging, 'common.source.emevd.dcx');
    await copyFile(commonPath, commonSrc);
    const insertOut = join(staging, 'common.insert.emevd.dcx');
    const inserted = await commitEmevdBatchViaBridge({
      sourcePath: commonSrc,
      outputPath: insertOut,
      expectedDocumentHash: emevdRead.data.sourceHash,
      allowedRoots: [staging, dirname(commonPath)],
      writableRoots: [staging],
      mutations: [{
        kind: 'insert_instruction',
        eventId: targetEvent.id,
        instructionIndex: targetEvent.instructionCount ?? 0,
        bank: waitDef.bank,
        id: waitDef.id,
        argsBase64: encoded.args.toString('base64')
      }]
    });
    if (!inserted.ok) throw new Error(`插入 WaitFixedTimeFrames 失败：${JSON.stringify(inserted.diagnostics)}`);
    const afterInsert = await runBridge<{
      sourceHash?: string;
      instructionCount?: number;
      events?: Array<{ id?: number; instructionCount?: number }>;
    }>({
      command: 'read-emevd-document',
      filePath: insertOut,
      allowedRoots: [staging],
      timeoutMs: 180_000
    });
    const insertedEvent = afterInsert.data?.events?.find((event) => event.id === targetEvent.id);
    if ((insertedEvent?.instructionCount ?? 0) !== (targetEvent.instructionCount ?? 0) + 1) {
      throw new Error(`插入后指令数不对：${insertedEvent?.instructionCount} / ${targetEvent.instructionCount}`);
    }
    const deleteOut = join(staging, 'common.delete.emevd.dcx');
    const deleted = await commitEmevdBatchViaBridge({
      sourcePath: insertOut,
      outputPath: deleteOut,
      expectedDocumentHash: afterInsert.data?.sourceHash ?? '',
      allowedRoots: [staging],
      writableRoots: [staging],
      mutations: [{
        kind: 'delete_instruction',
        eventId: targetEvent.id,
        instructionIndex: (insertedEvent?.instructionCount ?? 1) - 1
      }]
    });
    if (!deleted.ok) throw new Error(`删除 WaitFixedTimeFrames 失败：${JSON.stringify(deleted.diagnostics)}`);
    const afterDelete = await runBridge<{
      events?: Array<{ id?: number; instructionCount?: number }>;
    }>({
      command: 'read-emevd-document',
      filePath: deleteOut,
      allowedRoots: [staging],
      timeoutMs: 180_000
    });
    const restored = afterDelete.data?.events?.find((event) => event.id === targetEvent.id);
    if ((restored?.instructionCount ?? -1) !== (targetEvent.instructionCount ?? 0)) {
      throw new Error(`删回后指令数不对：${restored?.instructionCount}`);
    }
    await assertUnchanged(commonPath, commonBefore, 'common.emevd');
    record('s40-emevd-common', {
      readMs,
      eventId: targetEvent.id,
      instructionCount: targetEvent.instructionCount,
      wait: `${waitDef.bank}:${waitDef.id}`,
      emedfOrigin: resolved.origin
    });

    // ---- S40-2 PARAM EquipParamGoods 改一个数 ----
    const paramBnd = requireFile(
      join(mods, 'param', 'gameparam', 'gameparam.parambnd.dcx'),
      'gameparam'
    );
    const paramBefore = await readFile(paramBnd);
    const dcx = await runBridge<{
      nested?: { entries?: Array<{ name?: string; index?: number }> };
    }>({
      command: 'read-dcx-document',
      filePath: paramBnd,
      allowedRoots: [dirname(paramBnd), mods, ...(oodle ? [oodle] : [])],
      ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
      timeoutMs: 180_000
    });
    const goods = (dcx.data?.nested?.entries ?? []).find((entry) =>
      /EquipParamGoods/i.test(entry.name ?? '')
    );
    if (!goods || goods.index === undefined) {
      throw new Error(`找不到 EquipParamGoods：${JSON.stringify(dcx.diagnostics)}`);
    }
    const goodsPath = join(staging, 'EquipParamGoods.param');
    const snap = await runBridge<{ contentHash?: string }>({
      command: 'extract-bnd4-child',
      filePath: paramBnd,
      allowedRoots: [dirname(paramBnd), mods, ...(oodle ? [oodle] : [])],
      writableRoots: [staging],
      ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
      timeoutMs: 180_000,
      commandOptions: { entryIndex: goods.index, outputPath: goodsPath }
    });
    if (snap.parseStatus === 'failed') {
      throw new Error(`提取 EquipParamGoods 失败：${JSON.stringify(snap.diagnostics)}`);
    }
    const paramDoc = await runBridge<{
      sourceHash?: string;
      typeName?: string;
      dataVersion?: number;
      rowDataSize?: number;
      rows?: Array<{ id: number; dataBase64: string; dataHash: string }>;
    }>({
      command: 'read-param-document',
      filePath: goodsPath,
      allowedRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: { rowPage: 0, rowPageSize: 2 }
    });
    const row = paramDoc.data?.rows?.[0];
    if (!paramDoc.data?.sourceHash || !row) {
      throw new Error(`EquipParamGoods 无行：${JSON.stringify(paramDoc.diagnostics)}`);
    }
    const original = Buffer.from(row.dataBase64, 'base64');
    const nextValue = original[0] === 0x5a ? 0xa5 : 0x5a;
    const def: ParamDefDocument = {
      schemaVersion: 1,
      typeName: paramDoc.data.typeName ?? 'EquipParamGoods',
      version: paramDoc.data.dataVersion ?? 0,
      rowDataSize: paramDoc.data.rowDataSize ?? original.length,
      origin: 'fixture',
      fields: [{ id: 'f_first_byte', name: 'firstByte', type: 'u8', offset: 0, size: 1 }]
    };
    const fieldSet = applyParamFieldMutation({
      rowDataBase64: row.dataBase64,
      definition: def,
      fieldId: 'f_first_byte',
      value: nextValue
    });
    if (!fieldSet.ok) throw new Error(`字段写入失败：${fieldSet.message}`);
    const paramOut = join(staging, 'EquipParamGoods.mut.param');
    const paramWrite = await runBridge({
      command: 'write-param',
      filePath: goodsPath,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: paramOut,
        expectedDocumentHash: paramDoc.data.sourceHash,
        mutation: 'upsert',
        id: row.id,
        dataBase64: fieldSet.nextDataBase64
      }
    });
    if (!paramWrite.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
      throw new Error(`EquipParamGoods 写失败：${JSON.stringify(paramWrite.diagnostics)}`);
    }
    const paramReread = await runBridge<{
      rows?: Array<{ id: number; dataBase64: string }>;
    }>({
      command: 'read-param-document',
      filePath: paramOut,
      allowedRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: { rowPage: 0, rowPageSize: 8 }
    });
    const rereadRow = paramReread.data?.rows?.find((item) => item.id === row.id);
    if (!rereadRow || Buffer.from(rereadRow.dataBase64, 'base64')[0] !== nextValue) {
      throw new Error('EquipParamGoods 重读首字节未变');
    }
    await assertUnchanged(paramBnd, paramBefore, 'gameparam');
    record('s40-param-goods', {
      rowId: row.id,
      firstByte: nextValue,
      note: '本脚本改的是首字节数字；bool 打勾已由 S29 UI 单测覆盖，不在这条 native 链'
    });

    // ---- S40-5 地图 m10 挪 part ----
    const msbPath = requireFile(join(mods, 'map', 'mapstudio', 'm10_00_00_00.msb.dcx'), 'm10 msb');
    const msbBefore = await readFile(msbPath);
    const msbRead = await runBridge<{
      sourceHash?: string;
      parts?: Array<{ name: string; offset: number; posX: number; posY: number; posZ: number }>;
    }>({
      command: 'read-msb-document',
      filePath: msbPath,
      allowedRoots: [dirname(msbPath), mods, ...(oodle ? [oodle] : [])],
      ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
      timeoutMs: 180_000
    });
    const part = msbRead.data?.parts?.find((item, index, all) =>
      item.name && all.filter((other) => other.name === item.name).length === 1
    );
    if (!msbRead.data?.sourceHash || !part) {
      throw new Error(`m10 读不出唯一名 part：${JSON.stringify(msbRead.diagnostics)}`);
    }
    const msbSrc = join(staging, 'm10.source.msb.dcx');
    await copyFile(msbPath, msbSrc);
    const moved = {
      posX: part.posX + 1.25,
      posY: part.posY - 0.5,
      posZ: part.posZ + 0.75
    };
    const msbOut = join(staging, 'm10.mut.msb.dcx');
    const msbWrite = await runBridge({
      command: 'write-msb',
      filePath: msbSrc,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 180_000,
      commandOptions: {
        outputPath: msbOut,
        expectedDocumentHash: msbRead.data.sourceHash,
        mutations: [{ kind: 'set_part_position', family: 'part', nativeOffset: part.offset, expectedName: part.name, ...moved }]
      }
    });
    if (!msbWrite.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
      throw new Error(`m10 挪 part 失败：${JSON.stringify(msbWrite.diagnostics)}`);
    }
    const msbReread = await runBridge<{
      parts?: Array<{ name: string; posX: number; posY: number; posZ: number }>;
    }>({
      command: 'read-msb-document',
      filePath: msbOut,
      allowedRoots: [staging],
      timeoutMs: 180_000
    });
    const movedPart = msbReread.data?.parts?.find((item) => item.name === part.name);
    if (!movedPart
      || Math.abs(movedPart.posX - moved.posX) > 0.01
      || Math.abs(movedPart.posY - moved.posY) > 0.01
      || Math.abs(movedPart.posZ - moved.posZ) > 0.01) {
      throw new Error(`m10 重读位置不符：${JSON.stringify(movedPart)}`);
    }
    await assertUnchanged(msbPath, msbBefore, 'm10 msb');
    record('s40-msb-m10', { part: part.name, before: part, after: movedPart });

    // ---- S40-7 FLVER 材质槽（mods 里 c1130 没有 chrbnd，用 c1220）----
    const chrbndName = ['c1220.chrbnd.dcx', 'c1020.chrbnd.dcx', 'c1400.chrbnd.dcx']
      .find((name) => existsSync(join(mods, 'chr', name)));
    if (!chrbndName) throw new Error('mods/chr 没有可写的 chrbnd');
    const chrId = chrbndName.replace(/\.chrbnd\.dcx$/i, '');
    const chrbndPath = join(mods, 'chr', chrbndName);
    const chrbndBefore = await readFile(chrbndPath);
    const flverLoose = join(staging, `${chrId}.flver`);
    const chrEntries = await listEntries(chrbndPath, [dirname(chrbndPath), mods, ...(oodle ? [oodle] : [])], oodle);
    const flverChild = pickEntry(chrEntries, (name) => /\.flver$/i.test(name), chrbndName);
    const flverEx = await runBridge<{ contentHash?: string }>({
      command: 'extract-bnd4-child',
      filePath: chrbndPath,
      allowedRoots: [dirname(chrbndPath), mods, ...(oodle ? [oodle] : [])],
      writableRoots: [staging],
      ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
      timeoutMs: 180_000,
      commandOptions: { entryIndex: flverChild.index, outputPath: flverLoose }
    });
    if (flverEx.parseStatus === 'failed') {
      throw new Error(`提取 ${chrId}.flver 失败：${JSON.stringify(flverEx.diagnostics)}`);
    }
    const flverDoc = await runBridge<{
      sourceHash?: string;
      materialCount?: number;
      meshCount?: number;
      meshes?: Array<{ index?: number; materialIndex?: number }>;
      layoutWarnings?: string[];
    }>({
      command: 'read-flver-document',
      filePath: flverLoose,
      allowedRoots: [staging],
      timeoutMs: 120_000
    });
    if ((flverDoc.data?.layoutWarnings ?? []).length > 0) {
      throw new Error(`FLVER layoutWarnings：${JSON.stringify(flverDoc.data?.layoutWarnings)}`);
    }
    const currentMat = flverDoc.data?.meshes?.[0]?.materialIndex ?? -1;
    const matCount = flverDoc.data?.materialCount ?? 0;
    let targetMat = -1;
    for (let i = 0; i < matCount; i++) {
      if (i !== currentMat) { targetMat = i; break; }
    }
    if (!flverDoc.data?.sourceHash || targetMat < 0) {
      throw new Error(`${chrId} 不够两个材质，无法改槽`);
    }
    const flverOut = join(staging, `${chrId}.mut.flver`);
    const flverWrite = await runBridge<{ rereadVerified?: boolean }>({
      command: 'write-flver',
      filePath: flverLoose,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: {
        outputPath: flverOut,
        expectedDocumentHash: flverDoc.data.sourceHash,
        mutations: [{
          kind: 'material-slot-set',
          meshStableId: 'mesh:0',
          slotIndex: 0,
          materialStableId: `material:${targetMat}`
        }]
      }
    });
    if (flverWrite.parseStatus === 'failed' || !flverWrite.data?.rereadVerified) {
      throw new Error(`FLVER 改槽失败：${JSON.stringify(flverWrite.diagnostics)}`);
    }
    const flverReread = await runBridge<{
      meshes?: Array<{ materialIndex?: number }>;
    }>({
      command: 'read-flver-document',
      filePath: flverOut,
      allowedRoots: [staging],
      timeoutMs: 120_000
    });
    if (flverReread.data?.meshes?.[0]?.materialIndex !== targetMat) {
      throw new Error(`FLVER 重读材质槽不符：${JSON.stringify(flverReread.data?.meshes?.[0])}`);
    }
    await assertUnchanged(chrbndPath, chrbndBefore, chrbndName);
    record('s40-flver-slot', {
      container: chrbndName,
      from: currentMat,
      to: targetMat
    });

    // ---- S40-6 脚本：hks 反编译 + luabnd LuaQ ----
    const hksPath = requireFile(
      join(mods, 'action', 'script', 'c0000_transition.hks'),
      'c0000_transition.hks'
    );
    const probe = locateDsLuaDecompilerSync({ gameRootEnv: game, overlayRoot: mods });
    if (!probe.exePath) throw new Error('本机找不到 DSLuaDecompiler.exe');
    const hksText = await decompile(probe.exePath, hksPath);
    if (!/function\s+\w+/i.test(hksText) && !/local\s+function/i.test(hksText) && hksText.length < 40) {
      throw new Error(`hks 反编译不像源码：${hksText.slice(0, 120)}`);
    }
    const luabnd = requireFile(join(mods, 'script', 'aicommon.luabnd.dcx'), 'aicommon.luabnd');
    const luaList = await runBridge<{
      nested?: { entries?: Array<{ name?: string; index?: number }> };
    }>({
      command: 'read-dcx-document',
      filePath: luabnd,
      allowedRoots: [dirname(luabnd), mods, ...(oodle ? [oodle] : [])],
      ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
      timeoutMs: 180_000
    });
    const luaEntries = (luaList.data?.nested?.entries ?? []).filter((entry) =>
      /\.lua$/i.test(entry.name ?? '') && entry.index !== undefined
    );
    if (luaEntries.length === 0) {
      throw new Error('aicommon.luabnd 没有 .lua 子项');
    }
    let luaEntry = luaEntries[0]!;
    let luaBytes = Buffer.alloc(0);
    let luaLoose = '';
    let isLuaQ = false;
    for (const candidate of luaEntries.slice(0, 24)) {
      const out = join(staging, `lua-${candidate.index}-${basename(candidate.name ?? 'entry.lua')}`);
      await runBridge({
        command: 'extract-bnd4-child',
        filePath: luabnd,
        allowedRoots: [dirname(luabnd), mods, ...(oodle ? [oodle] : [])],
        writableRoots: [staging],
        ...(oodle ? { oodleRuntimeRoot: oodle } : {}),
        timeoutMs: 180_000,
        commandOptions: { entryIndex: candidate.index, outputPath: out }
      });
      const bytes = await readFile(out);
      const magic = bytes.length >= 4 && bytes[0] === 0x1b && bytes.subarray(1, 4).toString('ascii') === 'Lua';
      luaEntry = candidate;
      luaBytes = bytes;
      luaLoose = out;
      isLuaQ = magic;
      if (magic) break;
    }
    let luaText = '';
    if (isLuaQ) {
      luaText = await decompile(probe.exePath, luaLoose);
      if (luaText.includes('\u0000') && luaText.length < 20) {
        throw new Error('LuaQ 反编译仍像 hex/二进制');
      }
    } else {
      luaText = luaBytes.toString('utf8');
    }
    record('s40-script', {
      decompiler: probe.exePath,
      hksChars: hksText.length,
      hksHead: hksText.trim().slice(0, 80),
      luaEntry: luaEntry.name,
      luaQ: isLuaQ,
      luaHead: luaText.trim().slice(0, 80)
    });

    const failed = results.filter((item) => !item.ok);
    if (failed.length) throw new Error(`未通过：${failed.map((item) => item.id).join(',')}`);
    console.log(JSON.stringify({
      ok: true,
      cases: results.map((item) => item.id),
      workspace,
      nonClaims: [
        '不提升 native-verified',
        '没开 Electron，UI 五件套是生产写链本机往返，不是点击验收',
        '原版目录与 mods 覆盖层字节未改，回滚=丢弃暂存'
      ]
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
