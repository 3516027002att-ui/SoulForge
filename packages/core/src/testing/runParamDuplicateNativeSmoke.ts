/**
 * Real path: PARAM row duplicate via Bridge upsert with a new id + full data payload.
 * Exercises shipped write-param path (not a reimplementation).
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';

interface ParamEnvelope {
  sourceHash: string;
  typeName: string;
  rowCount: number;
  rows: Array<{ id: number; dataBase64: string; dataHash: string }>;
}

interface Bnd4ChildSnapshot {
  contentBase64: string;
}

function main(): Promise<void> {
  return withSmokeWorkspace('param-dup', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  // 语料根解析：此前硬编码 `../../mods/param/...`，从仓库根跑时 resolve 落到
  // D:\Repository\SoulForge\mods\param\... —— 一个不存在的路径，于是 copyFile 直接
  // ENOENT 崩溃。而同目录的 runNativeInspectSmoke:27-35 早已修过同一个坑并留了
  // 注释，本文件是那次改造的漏改点（2026-08-08 native 全量跑实测 FAIL 才暴露）。
  //
  // 修法与 scripts/verify-native-dcx-documents.mjs:28-30 一致：环境变量给的根下
  // 若存在 mods/ 就下沉（registry 的 localPath 全部以 mods/ 开头，所以那个变量的
  // 语义是**游戏根**），显式传参时不下沉——那是调用方明确指定的目录。
  const explicitPath = process.argv[2]?.trim();
  const envRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() ?? '';
  const corpusRoot = envRoot === ''
    ? ''
    : (existsSync(join(envRoot, 'mods')) ? join(envRoot, 'mods') : envRoot);
  const sourceBnd = explicitPath !== undefined && explicitPath !== ''
    ? resolve(explicitPath)
    : (corpusRoot === '' ? '' : join(corpusRoot, 'param', 'gameparam', 'gameparam.parambnd.dcx'));

  // 缺语料是「没有可验证对象」，不是「验证失败」（硬约束 7：缺语料与真坏必须
  // 可区分）。此前直接 copyFile 崩溃，把环境问题报成了缺陷。
  if (sourceBnd === '' || !existsSync(sourceBnd)) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      testId: 'PARAM-DUPLICATE-NATIVE',
      reason: sourceBnd === ''
        ? '未配置本机语料根（SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT），PARAM 重复行 native 验证未执行。'
        : `语料不存在：${sourceBnd}；PARAM 重复行 native 验证未执行。`
    }, null, 2));
    return;
  }
  const overlay = join(root, 'mod');
  const staging = join(root, 'staging');
  await mkdir(join(overlay, 'param', 'gameparam'), { recursive: true });
  await mkdir(staging, { recursive: true });
  const bndPath = join(overlay, 'param', 'gameparam', 'gameparam.parambnd.dcx');
  await copyFile(sourceBnd, bndPath);

  const child = await runBridge<Bnd4ChildSnapshot>({
    command: 'snapshot-bnd4-child',
    filePath: bndPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    commandOptions: { entryIndex: 1 }
  });
  if (!child.data?.contentBase64) {
    throw new Error(`snapshot failed: ${JSON.stringify(child.diagnostics)}`);
  }
  const paramPath = join(overlay, 'param', 'gameparam', 'ActionGuideParam.param');
  await writeFile(paramPath, Buffer.from(child.data.contentBase64, 'base64'));

  const read = await runBridge<ParamEnvelope>({
    command: 'read-param-document',
    filePath: paramPath,
    allowedRoots: [overlay],
    timeoutMs: 60_000,
    // 显式空 options：规避 Bridge default-options 缺陷（read-param-document 分页读取行无 ValueKind 防护）。
    commandOptions: {}
  });
  if (!read.data?.rows?.length) {
    throw new Error(`PARAM read failed: ${JSON.stringify(read.diagnostics)}`);
  }
  const source = read.data.rows[0]!;
  const maxId = read.data.rows.reduce((m, r) => Math.max(m, r.id), 0);
  const nextId = maxId + 1;

  const staged = join(staging, 'ActionGuideParam.dup.param');
  const written = await runBridge({
    command: 'write-param',
    filePath: paramPath,
    allowedRoots: [overlay, staging],
    writableRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {
      outputPath: staged,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'upsert',
      id: nextId,
      dataBase64: source.dataBase64
    }
  });
  if (!written.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
    throw new Error(`PARAM duplicate upsert failed: ${JSON.stringify(written.diagnostics)}`);
  }

  const after = await runBridge<ParamEnvelope>({
    command: 'read-param-document',
    filePath: staged,
    allowedRoots: [staging],
    timeoutMs: 60_000,
    commandOptions: {}
  });
  const dup = after.data?.rows.find((r) => r.id === nextId);
  const original = after.data?.rows.find((r) => r.id === source.id);
  if (!dup) throw new Error(`duplicated id ${nextId} missing`);
  if (!original) throw new Error('source row missing after duplicate');
  if (dup.dataHash !== source.dataHash) {
    throw new Error('duplicated row payload hash mismatch');
  }
  if ((after.data?.rowCount ?? 0) !== read.data.rowCount + 1) {
    throw new Error(`rowCount expected ${read.data.rowCount + 1}, got ${after.data?.rowCount}`);
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'PARAM 复制行（新 id + 源 dataBase64 upsert）原生写路径验证通过',
    typeName: read.data.typeName,
    sourceId: source.id,
    duplicatedId: nextId,
    rowCountBefore: read.data.rowCount,
    rowCountAfter: after.data?.rowCount,
    payloadHash: dup.dataHash
  }, null, 2));

  await disposeBridgeDaemonPool();
}

main().catch(async (error) => {
  console.error(error);
  await disposeBridgeDaemonPool().catch(() => undefined);
  process.exitCode = 1;
});
