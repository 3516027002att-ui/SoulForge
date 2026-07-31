/**
 * Full EMEVD editor-document pagination/assembly smoke:
 * 1) Synthetic EMEVD (always): paginated Bridge reads assemble a complete
 *    document with validated continuity, totals, event slices and unknown
 *    instruction classification via the fixture EMEDF registry.
 * 2) Real corpus (env-injected): common.emevd with a small page size must
 *    assemble to the exact native instruction count.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import {
  expectedInstructionTotal,
  readFullEmevdDocumentViaBridge
} from '../editing/emevdFullDocument.js';
import { standardSyntheticEmevd } from './syntheticEmevdBytes.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function syntheticAssembly(root: string): Promise<void> {
  const staging = join(root, 'synthetic');
  await mkdir(staging, { recursive: true });
  const emevdPath = join(staging, 'common.emevd');
  await writeFile(emevdPath, standardSyntheticEmevd());

  const registry = createSekiroFixtureEmedf();
  const result = await readFullEmevdDocumentViaBridge({
    filePath: emevdPath,
    allowedRoots: [staging],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: 'emevd-full-document-synthetic',
    pageSize: 2
  });
  assert(result.ok, `synthetic assembly failed: ${JSON.stringify(result.diagnostics)}`);
  assert(result.pageCount === 2, `expected 2 pages for 3 instructions at pageSize 2, got ${result.pageCount}`);
  assert(result.instructionTotal === 3, `instructionTotal ${result.instructionTotal}`);
  assert(result.document!.events.length === 2, 'synthetic events');
  const first = result.document!.events[0]!;
  assert(first.instructions.length === 3, `first event instructions ${first.instructions.length}`);
  assert(result.document!.events[1]!.instructions.length === 0, 'empty event must stay empty');
  assert(expectedInstructionTotal(result.document!.events) === 3, 'event slice total');
  const byBank = new Map(first.instructions.map((i) => [i.bank, i]));
  assert(byBank.get(1000)?.unknown === false, 'WaitFor must be typed under fixture registry');
  assert(byBank.get(2000)?.unknown === false, 'IfConditionGroup must be typed under fixture registry');
  assert(byBank.get(9999)?.unknown === true, 'unknown bank 9999 must be classified unknown');

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 完整文档分页组装合成断言通过',
    pageCount: result.pageCount,
    instructionTotal: result.instructionTotal,
    eventSlices: result.document!.events.map((e) => e.instructions.length)
  }));
}

async function realCorpusAssembly(root: string, sourceDcx: string): Promise<void> {
  const staging = join(root, 'native');
  await mkdir(staging, { recursive: true });
  const payload = decompressDfltDcx(await readFile(sourceDcx));
  const emevdPath = join(staging, 'common.emevd');
  await writeFile(emevdPath, payload);

  const registry = createSekiroFixtureEmedf();
  // Production path: pass the .dcx path directly; the reader must unwrap DFLT,
  // assemble all pages and hand back a reusable prepared source path.
  const dcxResult = await readFullEmevdDocumentViaBridge({
    filePath: sourceDcx,
    allowedRoots: [staging, dirname(sourceDcx)],
    tempDir: staging,
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: 'emevd-full-document-native',
    pageSize: 1000
  });
  assert(dcxResult.ok, `dcx direct assembly failed: ${JSON.stringify(dcxResult.diagnostics)}`);
  assert(dcxResult.preparedSourcePath !== undefined, 'dcx input must return preparedSourcePath');
  assert(dcxResult.instructionTotal === 33_266, `dcx instruction total ${dcxResult.instructionTotal}`);
  const dcxDocument = dcxResult.document!;
  assert(expectedInstructionTotal(dcxDocument.events) === 33_266, 'dcx event slice total mismatch');

  const result = await readFullEmevdDocumentViaBridge({
    filePath: emevdPath,
    allowedRoots: [staging],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: 'emevd-full-document-native',
    pageSize: 1000
  });
  assert(result.ok, `real assembly failed: ${JSON.stringify(result.diagnostics)}`);
  assert(result.instructionTotal === 33_266, `native instruction total ${result.instructionTotal}`);
  assert(result.pageCount === 34, `expected 34 pages at pageSize 1000, got ${result.pageCount}`);
  assert(result.document!.events.length === 1730, 'native events');
  assert(expectedInstructionTotal(result.document!.events) === 33_266, 'event slice total mismatch');
  const unknownCount = result.document!.events.reduce(
    (sum, e) => sum + e.instructions.filter((i) => i.unknown).length,
    0
  );

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 真实 corpus 完整文档分页组装通过',
    events: result.document!.events.length,
    instructionTotal: result.instructionTotal,
    pageCount: result.pageCount,
    unknownUnderFixtureRegistry: unknownCount
  }, null, 2));
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-emevd-full-document-'));
  const nativeFixtureArg = process.argv[2]?.trim() || undefined;
  const nativeEnvAvailable = Boolean(
    (process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim())
    || nativeFixtureArg
  );
  try {
    await syntheticAssembly(root);
    if (nativeEnvAvailable) {
      const sourceDcx = await resolveNativeFixture(nativeFixtureArg, 'emevd-primary', '../../mods/event/common.emevd.dcx');
      await realCorpusAssembly(root, sourceDcx);
    } else {
      console.log(JSON.stringify({
        ok: true,
        message: '真实 corpus 变体跳过：SOULFORGE_NATIVE_FIXTURE_REGISTRY/SOULFORGE_NATIVE_FIXTURE_ROOT 未设置；通过 node scripts/with-local-has-game-env.mjs 运行可注入本机 corpus 环境。'
      }));
    }
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
