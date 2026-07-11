/**
 * Real path: PARAM row duplicate via Bridge upsert with a new id + full data payload.
 * Exercises shipped write-param path (not a reimplementation).
 */
import { copyFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

async function main(): Promise<void> {
  const sourceBnd = resolve(process.argv[2] ?? '../../mods/param/gameparam/gameparam.parambnd.dcx');
  const root = await mkdtemp(join(tmpdir(), 'soulforge-param-dup-'));
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
    timeoutMs: 60_000
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
    timeoutMs: 60_000
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
