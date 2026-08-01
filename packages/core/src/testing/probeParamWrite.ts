import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParamDefDocument } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { applyParamFieldMutation } from '../param/paramFieldMutation.js';

async function main(): Promise<void> {
  const sourceBnd = await resolveNativeFixture(process.argv[2], 'param-primary', '../../mods/param/gameparam/gameparam.parambnd.dcx');
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-param-write-probe-'));
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });
  try {
    const extract = await runBridge<{ contentSize?: number }>({
      command: 'extract-bnd4-child',
      filePath: sourceBnd,
      allowedRoots: [dirname(sourceBnd)],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: { entryIndex: 1, outputPath: join(staging, 'probe.param') }
    });
    console.log('extract ok', extract.data?.contentSize);
    const read = await runBridge<{ sourceHash: string; rowDataSize: number; rows: Array<{ id: number; dataBase64: string }> }>({
      command: 'read-param-document',
      filePath: join(staging, 'probe.param'),
      allowedRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: { rowPage: 0, rowPageSize: 2 }
    });
    console.log('read ok', read.data?.sourceHash, read.data?.rowDataSize, read.data?.rows.length);
    const row = read.data!.rows[0]!;
    const def: ParamDefDocument = {
      schemaVersion: 1, typeName: 'X', version: 1, rowDataSize: read.data!.rowDataSize, origin: 'fixture',
      fields: [{ id: 'f0', name: 'u8', type: 'u8', offset: 0, size: 1 }]
    };
    const mutated = applyParamFieldMutation({ rowDataBase64: row.dataBase64, definition: def, fieldId: 'f0', value: 0xa5 });
    if (!mutated.ok) throw new Error(mutated.message);
    const t0 = Date.now();
    const written = await runBridge<{ outputHash?: string }>({
      command: 'write-param',
      filePath: join(staging, 'probe.param'),
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: { outputPath: join(staging, 'out.param'), expectedDocumentHash: read.data!.sourceHash, mutation: 'upsert', id: row.id, dataBase64: mutated.nextDataBase64 }
    });
    const t1 = Date.now();
    console.log('write-param', t1 - t0, 'ms', written.diagnostics.map((d) => d.code).join(','));
    const t2 = Date.now();
    const reread = await runBridge<{ rows?: Array<{ id: number; dataBase64: string | null }> }>({
      command: 'read-param-document',
      filePath: join(staging, 'out.param'),
      allowedRoots: [staging],
      timeoutMs: 120_000,
      commandOptions: { rowPage: 0, rowPageSize: 32 }
    });
    const t3 = Date.now();
    console.log('reread-param', t3 - t2, 'ms', reread.data?.rows?.length, reread.data?.rows?.map((r) => r.dataBase64 !== null));
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
