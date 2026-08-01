/**
 * Native KRAK-inner-BND4 combined mutation / repack matrix against the
 * registered local Sekiro corpus (talkesdbnd m00/m11, mapbnd m10).
 *
 * For every sample every combination case goes through the real production
 * chain:
 *   read-dcx-document (baseline) -> write-bnd4 with a MUTATIONS ARRAY (one
 *   repack + one KRAK re-compression) -> Bridge independent reread of the
 *   staged output -> entry-count/content assertion -> restore of the source
 *   overlay copy (rollback) byte-identical to the real game file.
 *
 * Unknown-field preservation is asserted at two levels:
 *   - no-op roundtrip: header unknown bytes (0x18, 0x30-0x3F), entry
 *     flags/unknown, stored payload bytes and names stay byte-for-byte equal;
 *   - after mutation: every untouched entry keeps flags/unknown and stored
 *     bytes byte-for-byte identical to the source container.
 *
 * The original Sekiro game directory is never written; all writes go to a
 * temporary overlay and are cleaned up.
 */
import { createHash } from 'node:crypto';
import { access, copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';

interface FieldPreservation {
  noOpPayloadByteIdentical: boolean;
  headerUnknownBytesPreserved: boolean;
  entryHeaderFieldsPreserved: boolean;
  storedBytesPreserved: boolean;
  namesPreserved: boolean;
  byteDiffOffsets?: number[];
}

interface Bnd4Envelope {
  sourceHash: string;
  compressionFormat: string;
  payloadHash?: string;
  nested?: {
    format: string;
    entryCount: number;
    entries: Array<{
      index: number;
      id: number;
      name: string;
      flags: number;
      unknown: number;
      contentHash: string;
      compressedSize: number;
    }>;
    fieldPreservation?: FieldPreservation;
  };
}

interface WriteBnd4Result {
  mutations: string[];
  affectedIndexes: number[];
  outputHash: string;
  entryCount: number;
  rereadVerified: boolean;
  preservation?: {
    matchedEntryCount: number;
    headerFieldsPreservedCount: number;
    storedBytesCheckedCount: number;
    storedBytesPreservedCount: number;
    allPreserved: boolean;
  };
  fieldPreservation?: FieldPreservation;
}

interface Sample {
  id: string;
  rel: string;
  entries: number;
}

const SAMPLES: Sample[] = [
  { id: 'm00.talkesdbnd', rel: 'mods/script/talk/m00_00_00_00.talkesdbnd.dcx', entries: 6 },
  { id: 'm11.talkesdbnd', rel: 'mods/script/talk/m11_02_00_00.talkesdbnd.dcx', entries: 17 },
  { id: 'm10.mapbnd', rel: 'mods/map/m10_00_00_00/m10_00_00_00_600050.mapbnd.dcx', entries: 2 }
];

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function marker(label: string, length: number): Buffer {
  const raw = Buffer.from(`SoulForge-KRAK-combined-${label}`);
  const out = Buffer.alloc(length);
  raw.copy(out, 0, 0, Math.min(raw.length, out.length));
  return out;
}

async function resolveSample(rel: string): Promise<string> {
  const root = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (!root) {
    throw new Error('KRAK 组合 smoke 需要 SOULFORGE_NATIVE_FIXTURE_ROOT 或 SOULFORGE_SEKIRO_GAME_ROOT（只读游戏目录）。');
  }
  const candidate = resolve(root, rel);
  try { await access(candidate); } catch {
    throw new Error(`KRAK 登记样本不存在：${candidate}`);
  }
  return candidate;
}

async function main(): Promise<void> {
  const gameRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (!gameRoot) throw new Error('缺少 SOULFORGE_SEKIRO_GAME_ROOT / SOULFORGE_NATIVE_FIXTURE_ROOT。');

  const root = await mkdtemp(join(tmpdir(), 'soulforge-krak-combined-mutation-'));
  const overlay = join(root, 'mod');
  await mkdir(join(overlay, 'script', 'talk'), { recursive: true });
  await mkdir(join(overlay, 'map', 'm10_00_00_00'), { recursive: true });
  const allowedRoots = [overlay, gameRoot];
  const sampleResults: Record<string, Array<Record<string, unknown>>> = {};
  let totalCases = 0;

  try {
    for (const sample of SAMPLES) {
      const source = await resolveSample(sample.rel);
      const sourceBytes = await readFile(source);
      const sourceHash = sha256(sourceBytes);
      const target = join(overlay, sample.rel.replaceAll('\\', '/').replace(/^mods\//, ''));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      const output = `${target}.combined.out.dcx`;

      const baseline = await runBridge<Bnd4Envelope>({
        command: 'read-dcx-document',
        filePath: target,
        allowedRoots,
        oodleRuntimeRoot: gameRoot,
        timeoutMs: 120_000
      });
      const nested = baseline.data?.nested;
      if (!nested || nested.format !== 'BND4' || nested.entryCount < 2) {
        throw new Error(`${sample.id} 不是可用的 KRAK 内 BND4 容器：${JSON.stringify(baseline.diagnostics)}`);
      }
      if (baseline.data?.compressionFormat !== 'KRAK') {
        throw new Error(`${sample.id} 外层不是 KRAK：${baseline.data?.compressionFormat}`);
      }
      // no-op roundtrip 未知字段保持：header 未知区 + 条目 flags/unknown + stored bytes + 名称
      const fp = nested.fieldPreservation;
      if (!fp || !fp.headerUnknownBytesPreserved || !fp.entryHeaderFieldsPreserved
        || !fp.storedBytesPreserved || !fp.namesPreserved) {
        throw new Error(`${sample.id} no-op roundtrip 未知字段未逐字节保持：${JSON.stringify(fp)}`);
      }
      if (baseline.data?.payloadHash !== baseline.data.payloadHash) {
        throw new Error(`${sample.id} baseline payload hash 异常。`);
      }

      const entries = nested.entries;
      const h = (i: number): string => entries[i]!.contentHash;
      const addName = `N:\\SoulForge\\verification\\${sample.id}-combined.bin`;
      const addBytes = Buffer.from(`SoulForge-KRAK-combined-add-${sample.id}`);

      const cases: Array<{ id: string; expectedDelta: number; mutations: Array<Record<string, unknown>>; verify: (after: Bnd4Envelope) => string[] }> = [
        {
          // rename + replace：条目数不变
          id: 'krak-rename-replace',
          expectedDelta: 0,
          mutations: [
            { mutation: 'rename', entryIndex: 0, expectedChildHash: h(0), newName: `${entries[0]!.name}.soulforge-renamed` },
            { mutation: 'replace', entryIndex: 1, expectedChildHash: h(1), contentBase64: marker('replace-1', entries[1]!.compressedSize).toString('base64') }
          ],
          verify: (after) => {
            const out = after.nested;
            if (!out) return ['missing-nested'];
            const problems: string[] = [];
            if (out.entryCount !== sample.entries) problems.push(`entryCount=${out.entryCount} != ${sample.entries}`);
            if (out.entries[0]?.name !== `${entries[0]!.name}.soulforge-renamed`) problems.push('rename did not survive');
            if (out.entries[1]?.contentHash === h(1)) problems.push('replace did not survive');
            return problems;
          }
        },
        {
          // replace + add（add 内层条目，显式 flags/unknown）
          id: 'krak-replace-add',
          expectedDelta: 1,
          mutations: [
            { mutation: 'replace', entryIndex: 0, expectedChildHash: h(0), contentBase64: marker('replace-0', entries[0]!.compressedSize).toString('base64') },
            { mutation: 'add', id: 9_000_001, name: addName, flags: 0x60, unknown: 5, contentBase64: addBytes.toString('base64') }
          ],
          verify: (after) => {
            const out = after.nested;
            if (!out) return ['missing-nested'];
            const problems: string[] = [];
            if (out.entryCount !== sample.entries + 1) problems.push(`entryCount=${out.entryCount} != ${sample.entries + 1}`);
            const added = out.entries[out.entryCount - 1];
            if (!added || added.name !== addName || added.flags !== 0x60 || added.unknown !== 5) problems.push('add entry flags/unknown/name not preserved');
            return problems;
          }
        },
        {
          // rename + delete + add：条目数净不变
          id: 'krak-rename-delete-add',
          expectedDelta: 0,
          mutations: [
            { mutation: 'rename', entryIndex: 0, expectedChildHash: h(0), newName: `${entries[0]!.name}.soulforge-rd` },
            { mutation: 'delete', entryIndex: 1, expectedChildHash: h(1) },
            { mutation: 'add', id: 9_000_002, name: addName, contentBase64: addBytes.toString('base64') }
          ],
          verify: (after) => {
            const out = after.nested;
            if (!out) return ['missing-nested'];
            const problems: string[] = [];
            if (out.entryCount !== sample.entries) problems.push(`entryCount=${out.entryCount} != ${sample.entries}`);
            if (out.entries.some((e) => e.name === entries[1]!.name)) problems.push('deleted entry still present');
            if (!out.entries.some((e) => e.name === addName)) problems.push('added entry missing');
            return problems;
          }
        },
        {
          // move + replace：条目数不变；move 后 replace 用新列表索引 0（原 entry1）
          id: 'krak-move-replace',
          expectedDelta: 0,
          mutations: [
            { mutation: 'move', entryIndex: 0, toIndex: entries.length - 1 },
            { mutation: 'replace', entryIndex: 0, expectedChildHash: h(1), contentBase64: marker('replace-1b', entries[1]!.compressedSize).toString('base64') }
          ],
          verify: (after) => {
            const out = after.nested;
            if (!out) return ['missing-nested'];
            const problems: string[] = [];
            if (out.entryCount !== sample.entries) problems.push(`entryCount=${out.entryCount} != ${sample.entries}`);
            if (out.entries[out.entryCount - 1]?.id !== entries[0]!.id) problems.push('move did not survive');
            if (out.entries[0]?.contentHash === h(1)) problems.push('replace did not survive');
            return problems;
          }
        },
        {
          // add + rename 新条目（组合内链式引用 add 结果）
          id: 'krak-add-rename',
          expectedDelta: 1,
          mutations: [
            { mutation: 'add', id: 9_000_003, name: addName, contentBase64: addBytes.toString('base64') },
            { mutation: 'rename', entryIndex: entries.length, expectedChildHash: sha256(addBytes), newName: `${addName}.renamed` }
          ],
          verify: (after) => {
            const out = after.nested;
            if (!out) return ['missing-nested'];
            const problems: string[] = [];
            if (out.entryCount !== sample.entries + 1) problems.push(`entryCount=${out.entryCount} != ${sample.entries + 1}`);
            if (!out.entries.some((e) => e.name === `${addName}.renamed`)) problems.push('chained add->rename did not survive');
            return problems;
          }
        },
        {
          // add + replace 新条目内容
          id: 'krak-add-replace',
          expectedDelta: 1,
          mutations: [
            { mutation: 'add', id: 9_000_004, name: addName, contentBase64: addBytes.toString('base64') },
            { mutation: 'replace', entryIndex: entries.length, expectedChildHash: sha256(addBytes), contentBase64: marker('chained-replace', 64).toString('base64') }
          ],
          verify: (after) => {
            const out = after.nested;
            if (!out) return ['missing-nested'];
            const problems: string[] = [];
            if (out.entryCount !== sample.entries + 1) problems.push(`entryCount=${out.entryCount} != ${sample.entries + 1}`);
            const added = out.entries.find((e) => e.name === addName);
            if (!added) problems.push('added entry missing');
            else if (added.contentHash === sha256(addBytes)) problems.push('chained add->replace did not survive');
            return problems;
          }
        }
      ];

      const sampleOutcome: Array<Record<string, unknown>> = [];
      for (const test of cases) {
        await copyFile(source, target); // fresh rollback baseline per case
        const written = await runBridge<WriteBnd4Result>({
          command: 'write-bnd4',
          filePath: target,
          allowedRoots,
          writableRoots: [overlay],
          oodleRuntimeRoot: gameRoot,
          workspaceSessionId: `krak-combined-${sample.id}`,
          timeoutMs: 120_000,
          commandOptions: {
            outputPath: output,
            mutations: test.mutations,
            expectedContainerHash: sourceHash
          }
        });
        if (written.parseStatus === 'failed'
          || !written.diagnostics.some((d) => d.code === 'BND4_STAGING_WRITE_VERIFIED')) {
          throw new Error(`${sample.id}/${test.id} write-bnd4 failed: ${JSON.stringify(written.diagnostics)}`);
        }
        const data = written.data as WriteBnd4Result | undefined;
        if (!data || data.rereadVerified !== true) {
          throw new Error(`${sample.id}/${test.id} missing reread verification: ${JSON.stringify(written)}`);
        }
        if (data.entryCount !== sample.entries + test.expectedDelta) {
          throw new Error(`${sample.id}/${test.id} entryCount ${data.entryCount} != expected ${sample.entries + test.expectedDelta}`);
        }
        if (JSON.stringify(data.mutations) !== JSON.stringify(test.mutations.map((m) => m.mutation))) {
          throw new Error(`${sample.id}/${test.id} mutation plan mismatch in report.`);
        }

        // Bridge 独立重读 staged 输出
        const reread = await runBridge<Bnd4Envelope>({
          command: 'read-dcx-document',
          filePath: output,
          allowedRoots,
          oodleRuntimeRoot: gameRoot,
          timeoutMs: 120_000
        });
        const verifyProblems = test.verify(reread.data as Bnd4Envelope);
        if (verifyProblems.length > 0) {
          throw new Error(`${sample.id}/${test.id} reread assertion failed: ${verifyProblems.join('; ')}`);
        }

        // 未知字段保持：mutation 后未触条目 flags/unknown + stored bytes 逐字节一致
        const preservation = data.preservation;
        if (!preservation || !preservation.allPreserved
          || preservation.headerFieldsPreservedCount !== preservation.matchedEntryCount
          || preservation.storedBytesPreservedCount !== preservation.storedBytesCheckedCount) {
          throw new Error(`${sample.id}/${test.id} preserved-entry fields not byte-identical: ${JSON.stringify(preservation)}`);
        }
        const outFp = reread.data?.nested?.fieldPreservation;
        if (!outFp || !outFp.headerUnknownBytesPreserved || !outFp.entryHeaderFieldsPreserved || !outFp.storedBytesPreserved) {
          throw new Error(`${sample.id}/${test.id} staged output unknown fields not preserved: ${JSON.stringify(outFp)}`);
        }

        // 回滚：恢复源副本，验证与真实游戏文件字节一致
        await copyFile(source, target);
        if (sha256(await readFile(target)) !== sourceHash) {
          throw new Error(`${sample.id}/${test.id} rollback did not restore original bytes.`);
        }
        if (sha256(await readFile(source)) !== sourceHash) {
          throw new Error(`${sample.id}/${test.id} real game file was modified.`);
        }
        await rm(output, { force: true });

        sampleOutcome.push({
          case: test.id,
          mutations: test.mutations.map((m) => m.mutation),
          entryCountAfter: data.entryCount,
          preservedEntryCount: preservation.matchedEntryCount,
          headerFieldsPreserved: preservation.headerFieldsPreservedCount,
          storedBytesPreserved: preservation.storedBytesPreservedCount,
          rereadVerified: true,
          rollbackByteIdentical: true
        });
        totalCases += 1;
      }
      sampleResults[sample.id] = sampleOutcome;
    }

    console.log(JSON.stringify({
      ok: true,
      message: `真实 KRAK 内 BND4 组合 mutation/repack 矩阵、未知字段保持与回滚验证通过（${totalCases} 个组合 case）`,
      gameRootProvided: true,
      samples: Object.keys(sampleResults),
      totalCases,
      unknownFieldPreservation: {
        noOpRoundtrip: 'header 未知区(0x18/0x30-0x3F)、条目 flags/unknown、stored bytes、名称逐字节保持',
        afterMutation: '未触条目 flags/unknown 与 stored bytes 与源容器逐字节一致'
      },
      results: sampleResults
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
