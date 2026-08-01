import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

const PROBE_INDICES = [0, 1, 2, 3, 4, 10, 20, 30, 31, 32, 33, 81];

async function main(): Promise<void> {
  const sourceBnd = await resolveNativeFixture(process.argv[2], 'param-primary', '../../mods/param/gameparam/gameparam.parambnd.dcx');
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-param-probe-'));
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });
  try {
    for (const index of PROBE_INDICES) {
      const t0 = Date.now();
      const extract = await runBridge<{ contentSize?: number }>({
        command: 'extract-bnd4-child',
        filePath: sourceBnd,
        allowedRoots: [dirname(sourceBnd)],
        writableRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: { entryIndex: index, outputPath: join(staging, `probe-${index}.param`) }
      });
      const t1 = Date.now();
      if (extract.parseStatus === 'failed') {
        console.log(`index ${index}: extract failed (${t1 - t0}ms): ${extract.diagnostics[0]?.code} ${extract.diagnostics[0]?.message}`);
        continue;
      }
      const read = await runBridge<{ typeName?: string; rowCount?: number; rowDataSize?: number; payloadsIncluded?: boolean; rows?: Array<{ id: number; dataBase64: string | null }> }>({
        command: 'read-param-document',
        filePath: join(staging, `probe-${index}.param`),
        allowedRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: { rowPage: 0, rowPageSize: 2 }
      });
      const t2 = Date.now();
      const payload = read.data?.payloadsIncluded;
      console.log(`index ${index}: extract ${t1 - t0}ms, read ${t2 - t1}ms | ${read.data?.typeName} rows=${read.data?.rowCount} rds=${read.data?.rowDataSize} payloadsIncluded=${payload} readStatus=${read.parseStatus}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await disposeBridgeDaemonPool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
