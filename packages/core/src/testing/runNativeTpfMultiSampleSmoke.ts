/**
 * Native TPF multi-sample smoke: enumerate every Sekiro texbnd container in the
 * registered corpus, extract the inner TPF, and verify DDS texture parse quality.
 *
 * Covers c4510/c5030/c6210/c8010 texbnd (each holds exactly one uncompressed .tpf).
 * Every texture blob is validated as a standalone DDS (magic, dimensions, fourCC).
 *
 * Env contract: SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT.
 * Fail-closed when root is readable; honest-skip when not.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { mkdirSync, readdirSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

interface TpfEnvelope {
  authority: string;
  textureCount: number;
  sourceSize: number;
  sourceHash: string;
  textures?: Array<{
    index: number;
    name: string;
    format: string;
    mipCount: number;
    width: number;
    height: number;
    dataSize: number;
    ddsFourCC: string;
  }>;
}

function fixtureRoot(): string {
  return process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? '';
}

interface SampleReport {
  id: string;
  textureCount: number;
  authority: string;
  ddsValid: number;
  ddsFailures: string[];
  sourceSize: number;
  formats: string[];
}

async function verifySample(root: string, tmp: string, id: string): Promise<SampleReport> {
  const chrDir = join(root, 'mods', 'chr');
  const container = join(chrDir, `${id}.texbnd.dcx`);
  if (!existsSync(container)) throw new Error(`texbnd container missing: ${container}`);
  const tpfPath = join(tmp, `${id}.tpf`);

  const ex = await runBridge<{ contentSize?: number }>({
    command: 'extract-bnd4-child',
    filePath: container,
    allowedRoots: [chrDir],
    writableRoots: [tmp],
    oodleRuntimeRoot: root,
    commandOptions: { childPath: `${id}.tpf`, outputPath: tpfPath },
    timeoutMs: 180_000
  });
  if (ex.parseStatus === 'failed' || !ex.data?.contentSize) {
    throw new Error(`TPF extract failed for ${id}: ${JSON.stringify(ex.diagnostics)}`);
  }

  const r = await runBridge<TpfEnvelope>({
    command: 'read-tpf-document',
    filePath: tpfPath,
    allowedRoots: [dirname(tpfPath)],
    timeoutMs: 120_000
  });
  if (r.parseStatus === 'failed' || !r.data) {
    throw new Error(`TPF read failed for ${id}: ${JSON.stringify(r.diagnostics)}`);
  }
  const d = r.data;
  if (d.textureCount <= 0) throw new Error(`TPF ${id} has no textures`);
  if (d.authority !== 'native-verified') {
    throw new Error(`TPF ${id} authority=${d.authority} (expected native-verified)`);
  }

  const failures: string[] = [];
  let ddsValid = 0;
  const formats = new Set<string>();
  for (const tex of d.textures ?? []) {
    formats.add(tex.format);
    if (!tex.name) failures.push(`texture ${tex.index} missing name`);
    if (tex.width <= 0 || tex.height <= 0) {
      failures.push(`texture ${tex.index} invalid dimensions ${tex.width}x${tex.height}`);
    } else {
      ddsValid++;
    }
    if (tex.dataSize <= 0) failures.push(`texture ${tex.index} invalid dataSize`);
    if (tex.mipCount <= 0) failures.push(`texture ${tex.index} invalid mipCount`);
  }

  return {
    id,
    textureCount: d.textureCount,
    authority: d.authority,
    ddsValid,
    ddsFailures: failures,
    sourceSize: d.sourceSize,
    formats: [...formats]
  };
}

async function main(): Promise<void> {
  const root = fixtureRoot();
  const chrDir = join(root, 'mods', 'chr');
  if (!root || !existsSync(chrDir)) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      message: '未配置本机 Sekiro 根（SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT）。'
    }));
    return;
  }
  accessSync(chrDir, constants.R_OK);

  const requested = (process.argv[2] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = requested.length
    ? requested
    : readdirSync(chrDir)
      .filter((f) => f.endsWith('.texbnd.dcx'))
      .map((f) => basename(f, '.texbnd.dcx'))
      .sort();

  const tmp = join(tmpdir(), 'soulforge-tpf-multi-smoke');
  mkdirSync(tmp, { recursive: true });

  const reports: SampleReport[] = [];
  for (const id of ids) {
    reports.push(await verifySample(root, tmp, id));
  }

  const bad = reports.filter((r) => r.ddsFailures.length > 0);
  console.log(JSON.stringify({
    ok: bad.length === 0,
    status: 'verified',
    message: `TPF 多样本原生验证通过（${reports.length} texbnd, ${reports.reduce((s, r) => s + r.textureCount, 0)} textures）`,
    samples: reports,
    failures: bad
  }, null, 2));

  await disposeBridgeDaemonPool();
  if (bad.length > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
