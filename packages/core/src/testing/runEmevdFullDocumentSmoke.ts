/**
 * Full EMEVD editor-document pagination/assembly smoke:
 * 1) Synthetic EMEVD (always): paginated Bridge reads assemble a complete
 *    document with validated continuity, totals, event slices and unknown
 *    instruction classification via the fixture EMEDF registry. Also asserts
 *    the bounded outline DTO and the bounded DSL projection (partial
 *    projection + unknown-as-read-only + absolute-path desensitization).
 * 2) Real corpus (env-injected): common.emevd.dcx opened as the outer resource
 *    — Bridge unwraps DCX natively (sourceFormat=dcx, outerFileHash = the .dcx
 *    file hash, sourceHash = the decompressed payload hash, cross-checked
 *    against the TypeScript decompressor) — with a small page size it must
 *    assemble to the exact native instruction count and cover partial
 *    projection / unknown instruction / bounded outline / 绝对路径脱敏.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { createSekiroFixtureEmedf } from '../emevd/emedfSchema.js';
import { renderEmevdPatchDslBounded } from '../emevd/dslRenderer.js';
import {
  buildEmevdDocumentOutline,
  expectedInstructionTotal,
  readFullEmevdDocumentViaBridge,
  sanitizeResourceUri
} from '../editing/emevdFullDocument.js';
import { standardSyntheticEmevd } from './syntheticEmevdBytes.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 绝对路径脱敏：文本不得含本地绝对路径（盘符路径段或全路径前缀）。 */
function assertDesensitized(text: string, absolutePath: string, label: string): void {
  assert(!text.includes(absolutePath), `${label} 泄漏了本地绝对路径`);
  // 盘符路径：单字母盘符紧跟 :/ 或 :\，且盘符前不是 URI scheme 的字母
  // （file:// 里的 e:// 是 scheme，不是盘符，不能误判）。
  assert(!/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/.test(text), `${label} 泄漏盘符路径`);
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
  assert(result.sourceFormat === 'emevd', `raw .emevd must read as sourceFormat=emevd, got ${result.sourceFormat}`);
  assert(result.document!.events.length === 2, 'synthetic events');
  const first = result.document!.events[0]!;
  assert(first.instructions.length === 3, `first event instructions ${first.instructions.length}`);
  assert(result.document!.events[1]!.instructions.length === 0, 'empty event must stay empty');
  assert(expectedInstructionTotal(result.document!.events) === 3, 'event slice total');
  const byBank = new Map(first.instructions.map((i) => [i.bank, i]));
  assert(byBank.get(1000)?.unknown === false, 'WaitFor must be typed under fixture registry');
  assert(byBank.get(2000)?.unknown === false, 'IfConditionGroup must be typed under fixture registry');
  assert(byBank.get(9999)?.unknown === true, 'unknown bank 9999 must be classified unknown');

  // Bounded outline: summary rows only, never instruction bodies.
  const outline = result.outline;
  assert(outline !== undefined, 'outline missing from read result');
  assert(outline.schemaVersion === 1, 'outline schemaVersion');
  assert(outline.resourceUri === 'file://event/common.emevd', 'outline resourceUri');
  assert(outline.eventCount === 2 && outline.events.length === 2, 'outline event rows');
  assert(outline.truncated === false, 'synthetic outline must not be truncated');
  assert(outline.instructionTotal === 3, 'outline instruction total');
  const outlineFirst = outline.events[0]!;
  assert(outlineFirst.eventUri === 'file://event/common.emevd#event/50', 'outline eventUri');
  assert(outlineFirst.eventId === 50, 'outline eventId');
  assert(outlineFirst.instructionCount === 3, 'outline instructionCount');
  assert(outlineFirst.unknownCount === 1, 'outline unknownCount (bank 9999)');
  assert(!('instructions' in outlineFirst), 'outline must not carry instruction bodies');
  assert(!('argsBase64' in outlineFirst), 'outline must not carry arg bytes');
  assert(outline.events[1]!.instructionCount === 0, 'empty event outline count');

  // Bounded projection: full (no limit) shows unknown as read-only comments.
  const fullProjection = renderEmevdPatchDslBounded(result.document!, registry, undefined);
  assert(fullProjection.truncated === false, 'synthetic full projection must not truncate');
  assert(fullProjection.text.includes('// read-only'), 'unknown instruction must render as read-only comment');
  assert(fullProjection.text.includes('bank=9999 id=1'), 'read-only comment must keep bank/id');
  assert(fullProjection.text.includes(`resource "file://event/common.emevd"`), 'projection resource line');
  assertDesensitized(fullProjection.text, emevdPath, 'full synthetic projection');

  // Partial projection: a small limit truncates at an event-block boundary.
  const partial = renderEmevdPatchDslBounded(result.document!, registry, 5);
  assert(partial.truncated === true, 'bounded projection must truncate under a small limit');
  const partialContent = partial.text
    .replace(/\/\/ EMEVD_DSL_TEMPLATE_TRUNCATED.*$/m, '')
    .replace(/\/\/ 模板仅作为.*$/m, '')
    .trimEnd();
  assert(partialContent.endsWith('}'), 'truncated projection must stop at an event-block boundary');
  assert(partial.text.includes('EMEVD_DSL_TEMPLATE_TRUNCATED'), 'truncation marker missing');
  assert(partial.shownLines < partial.totalLines, 'shownLines must be below totalLines');

  // sanitizeResourceUri: absolute local paths are reduced to desensitized form.
  const absoluteUri = `file:///${emevdPath.replace(/\\/g, '/')}`;
  const sanitized = sanitizeResourceUri(absoluteUri);
  assert(!/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/.test(sanitized), `sanitizeResourceUri leaked drive letter: ${sanitized}`);
  assert(sanitized.startsWith('file://'), `sanitizeResourceUri must keep file:// prefix: ${sanitized}`);

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 完整文档分页组装合成断言通过（含 outline + 投影脱敏）',
    pageCount: result.pageCount,
    instructionTotal: result.instructionTotal,
    eventSlices: result.document!.events.map((e) => e.instructions.length),
    outlineRows: outline.events.length,
    outlineUnknownCounts: outline.events.map((e) => e.unknownCount),
    projection: { truncated: partial.truncated, shownLines: partial.shownLines, totalLines: partial.totalLines }
  }));
}

async function realCorpusAssembly(root: string, sourceDcx: string): Promise<void> {
  const staging = join(root, 'native');
  await mkdir(staging, { recursive: true });
  const dcxBytes = await readFile(sourceDcx);
  const payload = decompressDfltDcx(dcxBytes);

  const registry = createSekiroFixtureEmedf();
  // Production path: pass the .dcx outer resource directly; Bridge unwraps DFLT
  // natively (negative architecture — no TS DCX parser, no temp .emevd target).
  const dcxResult = await readFullEmevdDocumentViaBridge({
    filePath: sourceDcx,
    allowedRoots: [staging, dirname(sourceDcx)],
    resourceUri: 'file://event/common.emevd',
    registry,
    documentInstanceId: 'emevd-full-document-native',
    pageSize: 1000
  });
  assert(dcxResult.ok, `dcx direct assembly failed: ${JSON.stringify(dcxResult.diagnostics)}`);
  assert(dcxResult.sourceFormat === 'dcx', `dcx input must read as sourceFormat=dcx, got ${dcxResult.sourceFormat}`);
  assert(dcxResult.outerFileHash === hashOf(dcxBytes), 'outerFileHash must hash the .dcx file bytes as opened');
  assert(dcxResult.sourceHash === hashOf(payload), 'Bridge native payload hash must equal TypeScript decompressed payload hash');
  assert(dcxResult.instructionTotal === 33_266, `dcx instruction total ${dcxResult.instructionTotal}`);
  const dcxDocument = dcxResult.document!;
  assert(expectedInstructionTotal(dcxDocument.events) === 33_266, 'dcx event slice total mismatch');

  // Bounded outline over the real corpus.
  const outline = dcxResult.outline;
  assert(outline !== undefined, 'dcx outline missing');
  assert(outline.eventCount === 1730, 'outline eventCount');
  assert(outline.instructionTotal === 33_266, 'outline instructionTotal');
  assert(outline.truncated === false, `outline must fit under limit ${outline.limit} for 1730 events`);
  assert(outline.events.length === 1730, 'outline row count');
  const firstOutline = outline.events[0]!;
  assert(firstOutline.eventUri.startsWith('file://event/common.emevd#event/'), 'outline eventUri must be resource-relative');
  assert(firstOutline.instructionCount >= 0, 'outline instructionCount');
  assert(firstOutline.unknownCount >= 0, 'outline unknownCount');
  assert(!('instructions' in firstOutline) && !('argsBase64' in firstOutline), 'outline rows must be summary-only');
  // Explicit small limit truncates the outline.
  const capped = buildEmevdDocumentOutline(dcxDocument, { limit: 5 });
  assert(capped.truncated === true && capped.events.length === 5, 'capped outline must truncate to limit');

  // Unknown instructions survive classification under the fixture registry.
  const unknownCount = dcxDocument.events.reduce(
    (sum, e) => sum + e.instructions.filter((i) => i.unknown).length,
    0
  );
  assert(unknownCount > 0, 'real corpus must contain unknown instructions under the fixture registry');

  // Partial projection: bounded DSL over the real corpus truncates at an
  // event-block boundary and keeps unknown instructions as read-only comments.
  const bounded = renderEmevdPatchDslBounded(dcxDocument, registry, 2000);
  assert(bounded.truncated === true, 'real corpus projection must truncate under a 2000-line limit');
  assert(bounded.totalLines > bounded.shownLines, 'real corpus projection must show only a bounded prefix');
  const boundedContent = bounded.text
    .replace(/\/\/ EMEVD_DSL_TEMPLATE_TRUNCATED.*$/m, '')
    .replace(/\/\/ 模板仅作为.*$/m, '')
    .trimEnd();
  assert(boundedContent.endsWith('}'), 'real corpus truncated projection must stop at event-block boundary');
  assert(bounded.text.includes('EMEVD_DSL_TEMPLATE_TRUNCATED'), 'real corpus truncation marker missing');
  assert(bounded.text.includes('// read-only'), 'real corpus projection must keep unknown instructions read-only');

  // 绝对路径脱敏: the absolute local .dcx path must never leak into the
  // projection or the outline.
  assertDesensitized(bounded.text, sourceDcx, 'real corpus DSL projection');
  assertDesensitized(JSON.stringify(outline), sourceDcx, 'real corpus outline');

  // Raw .emevd read path still works.
  const emevdPath = join(staging, 'common.emevd');
  await writeFile(emevdPath, payload);
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

  console.log(JSON.stringify({
    ok: true,
    message: 'EMEVD 真实 corpus 完整文档原生 DCX 打开 + 分页组装 + 有界投影/outline 通过',
    events: result.document!.events.length,
    instructionTotal: result.instructionTotal,
    pageCount: result.pageCount,
    sourceFormat: dcxResult.sourceFormat,
    outerFileHashMatchesDcx: dcxResult.outerFileHash === hashOf(dcxBytes),
    bridgePayloadHashMatchesTsDecompress: dcxResult.sourceHash === hashOf(payload),
    unknownUnderFixtureRegistry: unknownCount,
    outline: { rows: outline.events.length, capped: capped.events.length },
    projection: { truncated: bounded.truncated, shownLines: bounded.shownLines, totalLines: bounded.totalLines }
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
