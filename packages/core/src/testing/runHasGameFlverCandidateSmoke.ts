/**
 * Has-game FLVER candidate probe.
 * Reads a real chrbnd.dcx from private registry, extracts nested children into temp staging,
 * and probes FLVER headers. No writer claim. Game root remains read-only.
 *
 * Also emits layout-offset evidence for the real c1020 sample so header-table
 * placement can be corrected without claiming geometry decode authority.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';
import { probeFlverCandidate } from '../scene/flverCandidate.js';
import {
  NativeFixtureResolutionError,
  resolveNativeFixturePath
} from './nativeFixturePaths.js';

interface NestedEntry {
  index: number;
  name: string;
  contentHash: string;
}

interface DcxEnvelope {
  sourceHash: string;
  nested?: {
    entryCount: number;
    entries: NestedEntry[];
  };
}

interface MeshRowCandidate {
  dynamic: number;
  materialIndex: number;
  defaultBoneIndex: number;
  boneCount: number;
  boundingBoxOffset: number;
  boneIndicesOffset: number;
  faceSetCount: number;
  faceSetOffset: number;
  vertexBufferCount: number;
  vertexBufferOffset: number;
}

interface FaceSetHdr {
  flags: number;
  topology: number;
  indexCount: number;
  indicesOffset: number;
}

interface VbHdr {
  bufferIndex: number;
  layoutIndex: number;
  vertexSize: number;
  vertexCount: number;
  bufferLength: number;
  bufferOffset: number;
}

interface BruteTableHit {
  meshTableOffset: number;
  meshStride: number;
  rowScoreSum: number;
  secondaryScore: number;
  totalScore: number;
  mesh0: MeshRowCandidate;
  faceSet0: FaceSetHdr | null;
  vertexBuffer0: VbHdr | null;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function looksFlverName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.flver') || lower.includes('.flver');
}

function readMeshRowAt(view: DataView, off: number, byteLength: number): MeshRowCandidate | null {
  if (off < 0 || off + 0x28 > byteLength) return null;
  return {
    dynamic: view.getInt32(off + 0x00, true),
    materialIndex: view.getInt32(off + 0x04, true),
    defaultBoneIndex: view.getInt32(off + 0x08, true),
    boneCount: view.getInt32(off + 0x0c, true),
    boundingBoxOffset: view.getInt32(off + 0x10, true),
    boneIndicesOffset: view.getInt32(off + 0x14, true),
    faceSetCount: view.getInt32(off + 0x18, true),
    faceSetOffset: view.getInt32(off + 0x1c, true),
    vertexBufferCount: view.getInt32(off + 0x20, true),
    vertexBufferOffset: view.getInt32(off + 0x24, true)
  };
}

function scoreMeshRow(
  row: MeshRowCandidate | null,
  materialCount: number,
  boneCountHdr: number,
  byteLength: number
): number {
  if (!row) return -100;
  let s = 0;
  if (row.dynamic === 0 || row.dynamic === 1) s += 2;
  if (row.materialIndex >= 0 && row.materialIndex < materialCount) s += 3;
  else return -50;
  if (row.boneCount >= 0 && row.boneCount <= 512) s += 2;
  else return -50;
  if (row.faceSetCount >= 1 && row.faceSetCount <= 64) s += 2;
  else return -50;
  if (row.vertexBufferCount >= 1 && row.vertexBufferCount <= 16) s += 2;
  else return -50;
  if (row.faceSetOffset > 0x40 && row.faceSetOffset < byteLength) s += 2;
  else return -50;
  if (row.vertexBufferOffset > 0x40 && row.vertexBufferOffset < byteLength) s += 2;
  else return -50;
  if (
    row.boneIndicesOffset === 0 ||
    (row.boneIndicesOffset > 0x40 && row.boneIndicesOffset < byteLength)
  ) {
    s += 1;
  }
  if (row.defaultBoneIndex >= -1 && row.defaultBoneIndex < Math.max(boneCountHdr, 1) + 8) s += 1;
  return s;
}

function readFaceSetHdr(view: DataView, off: number, byteLength: number): FaceSetHdr | null {
  if (off <= 0 || off + 0x10 > byteLength) return null;
  return {
    flags: view.getInt32(off + 0x00, true),
    topology: view.getInt32(off + 0x04, true),
    indexCount: view.getInt32(off + 0x08, true),
    indicesOffset: view.getInt32(off + 0x0c, true)
  };
}

function readVbHdr(view: DataView, off: number, byteLength: number): VbHdr | null {
  if (off <= 0 || off + 0x18 > byteLength) return null;
  return {
    bufferIndex: view.getInt32(off + 0x00, true),
    layoutIndex: view.getInt32(off + 0x04, true),
    vertexSize: view.getInt32(off + 0x08, true),
    vertexCount: view.getInt32(off + 0x0c, true),
    bufferLength: view.getInt32(off + 0x10, true),
    bufferOffset: view.getInt32(off + 0x14, true)
  };
}

function scoreFaceSet(fs: FaceSetHdr | null, byteLength: number): number {
  if (!fs) return 0;
  let s = 0;
  if (fs.indexCount > 0 && fs.indexCount < 5_000_000) s += 2;
  if (fs.indicesOffset > 0 && fs.indicesOffset < byteLength) s += 2;
  if (fs.topology >= 0 && fs.topology <= 8) s += 1;
  return s;
}

function scoreVb(vb: VbHdr | null, layoutCountHint: number): number {
  if (!vb) return 0;
  let s = 0;
  if (vb.vertexSize >= 4 && vb.vertexSize <= 256) s += 2;
  if (vb.vertexCount > 0 && vb.vertexCount < 5_000_000) s += 2;
  if (vb.layoutIndex >= 0 && vb.layoutIndex < Math.max(layoutCountHint, 1) + 8) s += 2;
  if (vb.bufferIndex >= 0 && vb.bufferIndex < 64) s += 1;
  return s;
}

function collectLayoutOffsetEvidence(bytes: Buffer, report: ReturnType<typeof probeFlverCandidate>) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerFieldsLe: Record<string, number> = {};
  for (let off = 0x08; off < 0x40; off += 4) {
    headerFieldsLe[`0x${off.toString(16)}`] = view.getInt32(off, true);
  }

  const materialCount = report.materialCount;
  const boneCountHdr = report.boneCount;
  const meshCountHdr = report.meshCount;
  const layoutCountHint = view.getInt32(0x28, true);
  const dataOffset = report.dataOffset;
  const byteLength = bytes.length;
  const scanLimit = Math.min(dataOffset > 0 ? dataOffset : byteLength, byteLength);

  const meshStrideCandidates = [0x40, 0x28, 0x30, 0x48];
  const bruteTables: BruteTableHit[] = [];

  for (const stride of meshStrideCandidates) {
    if (meshCountHdr <= 0 || meshCountHdr > 256) continue;
    const need = meshCountHdr * stride;
    if (need <= 0 || need >= scanLimit) continue;
    for (let off = 0x40; off + need <= scanLimit; off += 4) {
      const first = readMeshRowAt(view, off, byteLength);
      if (scoreMeshRow(first, materialCount, boneCountHdr, byteLength) < 8) continue;
      let total = 0;
      let ok = true;
      for (let i = 0; i < meshCountHdr; i += 1) {
        const row = readMeshRowAt(view, off + i * stride, byteLength);
        const sc = scoreMeshRow(row, materialCount, boneCountHdr, byteLength);
        if (sc < 8) {
          ok = false;
          break;
        }
        total += sc;
      }
      if (!ok || !first) continue;

      const fs0 = readFaceSetHdr(view, first.faceSetOffset, byteLength);
      const vb0 = readVbHdr(view, first.vertexBufferOffset, byteLength);
      const secondary = scoreFaceSet(fs0, byteLength) + scoreVb(vb0, layoutCountHint);
      bruteTables.push({
        meshTableOffset: off,
        meshStride: stride,
        rowScoreSum: total,
        secondaryScore: secondary,
        totalScore: total + secondary * meshCountHdr,
        mesh0: first,
        faceSet0: fs0,
        vertexBuffer0: vb0
      });
      // Coarse skip; nearby alignments still sampled via +4 outer step on next loops.
      off += Math.max(4, stride) - 4;
      if (bruteTables.length >= 32) break;
    }
    if (bruteTables.length >= 32) break;
  }

  bruteTables.sort((a, b) => b.totalScore - a.totalScore);
  const bestTable = bruteTables[0] ?? null;

  // Sequential section scoreboard with variable material/bone strides.
  const seqCandidates: Array<Record<string, unknown>> = [];
  for (const headerSize of [0x40, 0x50, 0x60, 0x80]) {
    for (const dummyStride of [0x40]) {
      for (const materialStride of [0x20, 0x40, 0x48]) {
        for (const boneStride of [0x40, 0x80]) {
          for (const meshStride of [0x40, 0x28, 0x30]) {
            let cursor = headerSize;
            cursor += Math.max(0, report.dummyCount) * dummyStride;
            cursor += Math.max(0, materialCount) * materialStride;
            cursor += Math.max(0, boneCountHdr) * boneStride;
            const meshOff = cursor;
            if (meshOff + meshCountHdr * meshStride > scanLimit) continue;
            const m0 = readMeshRowAt(view, meshOff, byteLength);
            const sc = scoreMeshRow(m0, materialCount, boneCountHdr, byteLength);
            if (sc < 8 || !m0) continue;
            const fs0 = readFaceSetHdr(view, m0.faceSetOffset, byteLength);
            const vb0 = readVbHdr(view, m0.vertexBufferOffset, byteLength);
            seqCandidates.push({
              headerSize,
              dummyStride,
              materialStride,
              boneStride,
              meshStride,
              meshOff,
              score: sc + scoreFaceSet(fs0, byteLength) + scoreVb(vb0, layoutCountHint),
              mesh0: m0,
              faceSet0: fs0,
              vertexBuffer0: vb0
            });
          }
        }
      }
    }
  }
  seqCandidates.sort((a, b) => (b.score as number) - (a.score as number));

  // Layout member-table scan near best mesh table end (or whole pre-data region).
  const layoutScan: Array<Record<string, unknown>> = [];
  const scanFrom = bestTable
    ? bestTable.meshTableOffset + meshCountHdr * bestTable.meshStride
    : 0x40;
  const scanTo = Math.min(dataOffset > 0 ? dataOffset : byteLength, byteLength - 4);
  for (let off = scanFrom; off + 4 + 0x0c <= scanTo; off += 4) {
    const memberCount = view.getInt32(off, true);
    if (memberCount < 1 || memberCount > 32) continue;
    if (off + 4 + memberCount * 0x0c > byteLength) continue;
    const m0type = bytes[off + 4 + 0x06] ?? 0xff;
    const m0sem = bytes[off + 4 + 0x07] ?? 0xff;
    const m0struct = view.getUint16(off + 4 + 0x04, true);
    if (!(m0sem === 0 && m0struct <= 64 && m0type <= 32)) continue;
    const members: Array<{
      structOffset: number;
      type: number;
      semantic: number;
      semanticIndex: number;
    }> = [];
    for (let mi = 0; mi < Math.min(memberCount, 4); mi += 1) {
      const base = off + 4 + mi * 0x0c;
      members.push({
        structOffset: view.getUint16(base + 0x04, true),
        type: bytes[base + 0x06] ?? 0,
        semantic: bytes[base + 0x07] ?? 0,
        semanticIndex: bytes[base + 0x08] ?? 0
      });
    }
    let mono = true;
    for (let i = 1; i < members.length; i += 1) {
      const prev = members[i - 1];
      const cur = members[i];
      if (prev === undefined || cur === undefined || cur.structOffset < prev.structOffset) {
        mono = false;
        break;
      }
    }
    layoutScan.push({ offset: off, memberCount, members, mono });
    if (layoutScan.length >= 8) break;
  }

  // Deep dump around best mesh0 secondaries for layout/faceSet/vb field recovery.
  let secondaryDump: Record<string, unknown> | null = null;
  if (bestTable) {
    const m0 = bestTable.mesh0;
    const dumpAt = (label: string, off: number, words: number) => {
      const out: number[] = [];
      for (let i = 0; i < words; i += 1) {
        const p = off + i * 4;
        if (p + 4 > byteLength) break;
        out.push(view.getInt32(p, true));
      }
      return { label, off, words: out };
    };
    const alts = (start: number) => {
      const out: Array<Record<string, unknown>> = [];
      for (const base of [start, start + 4, start + 8, start + 12, start + 16]) {
        if (base + 0x20 > byteLength) continue;
        out.push({
          base,
          w: [
            view.getInt32(base + 0x00, true),
            view.getInt32(base + 0x04, true),
            view.getInt32(base + 0x08, true),
            view.getInt32(base + 0x0c, true),
            view.getInt32(base + 0x10, true),
            view.getInt32(base + 0x14, true),
            view.getInt32(base + 0x18, true),
            view.getInt32(base + 0x1c, true)
          ]
        });
      }
      return out;
    };
    const mesh0RowHex: number[] = [];
    for (let i = 0; i < bestTable.meshStride / 4; i += 1) {
      mesh0RowHex.push(view.getInt32(bestTable.meshTableOffset + i * 4, true));
    }
    secondaryDump = {
      mesh0RowHex,
      faceSetRegion: dumpAt('faceSet', m0.faceSetOffset, 48),
      vbRegion: dumpAt('vb', m0.vertexBufferOffset, 32),
      afterMeshTable: dumpAt(
        'afterMeshTable',
        bestTable.meshTableOffset + meshCountHdr * bestTable.meshStride,
        64
      ),
      faceSetAlt: alts(m0.faceSetOffset),
      vbAlt: alts(m0.vertexBufferOffset)
    };
  }

  return {
    headerFieldsLe,
    layoutCountHint,
    dataOffset,
    currentProbeMesh0: report.meshes[0]
      ? {
          dynamic: report.meshes[0].dynamic,
          materialIndex: report.meshes[0].materialIndex,
          boneCount: report.meshes[0].boneCount,
          layoutSane: report.meshes[0].layoutSane
        }
      : null,
    currentProbeLayout0: report.layouts[0]
      ? {
          memberCount: report.layouts[0].memberCount,
          layoutSane: report.layouts[0].layoutSane
        }
      : null,
    bestMeshTable: bestTable,
    topMeshTables: bruteTables.slice(0, 5).map((t) => ({
      meshTableOffset: t.meshTableOffset,
      meshStride: t.meshStride,
      totalScore: t.totalScore,
      secondaryScore: t.secondaryScore,
      mesh0: t.mesh0,
      faceSet0: t.faceSet0,
      vertexBuffer0: t.vertexBuffer0
    })),
    topSequential: seqCandidates.slice(0, 5),
    layoutScanTop: layoutScan.slice(0, 5),
    secondaryDump
  };
}

async function main(): Promise<void> {
  const allowSkip = process.argv.includes('--allow-skip') || process.env.SOULFORGE_ALLOW_SKIP === '1';
  let source: string;
  try {
    source = await resolveNativeFixturePath(
      'chr/c1020.chrbnd.dcx',
      2,
      'SOULFORGE_NATIVE_FIXTURE_CHRBND'
    );
  } catch (error) {
    if (error instanceof NativeFixtureResolutionError && allowSkip) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            skipped: true,
            code: error.code,
            message: error.message,
            noWriter: true,
            gameRootReadOnly: true
          },
          null,
          2
        )
      );
      return;
    }
    throw error;
  }

  const sourceRoot = resolve(source, '..');
  const writableRoot = await mkdtemp(join(tmpdir(), 'soulforge-has-game-flver-'));
  const beforeHash = sha256(await readFile(source));
  const beforeStat = await stat(source);

  try {
    const inspected = await runBridge<DcxEnvelope>({
      command: 'read-dcx-document',
      filePath: source,
      allowedRoots: [sourceRoot, writableRoot],
      writableRoots: [writableRoot],
      workspaceSessionId: 'has-game-flver-candidate-smoke',
      timeoutMs: 60_000
    });
    if (inspected.parseStatus === 'failed' || !inspected.data?.nested?.entries?.length) {
      throw new Error(`read-dcx-document failed: ${JSON.stringify(inspected.diagnostics)}`);
    }
    const envelope = inspected.data;
    const hits: Array<Record<string, unknown>> = [];
    const attemptLog: Array<Record<string, unknown>> = [];
    const entryNames = envelope.nested!.entries.map((e) => e.name || `child-${e.index}`);
    const flverNamed = envelope.nested!.entries.filter((e) => looksFlverName(e.name || ''));

    // Prefer named .flver children; if registry/name table has none, sample early entries.
    const candidates =
      flverNamed.length > 0
        ? flverNamed
        : envelope.nested!.entries.slice(0, Math.min(8, envelope.nested!.entries.length));

    for (const entry of candidates) {
      const base = (entry.name || `child-${entry.index}`).replace(/[\\/]/g, '_');
      const shortName = base.includes('.flver')
        ? `child-${entry.index}.flver`
        : `child-${entry.index}.bin`;
      const outPath = join(writableRoot, shortName);
      const extracted = await runBridge({
        command: 'extract-bnd4-child',
        filePath: source,
        allowedRoots: [sourceRoot, writableRoot],
        writableRoots: [writableRoot],
        workspaceSessionId: 'has-game-flver-candidate-smoke',
        timeoutMs: 60_000,
        commandOptions: {
          entryIndex: entry.index,
          expectedContainerHash: envelope.sourceHash,
          expectedChildHash: entry.contentHash,
          outputPath: outPath
        }
      });
      if (extracted.parseStatus === 'failed') {
        attemptLog.push({
          name: shortName,
          originalName: entry.name,
          entryIndex: entry.index,
          stage: 'extract',
          parseStatus: extracted.parseStatus,
          diagnostics: extracted.diagnostics?.slice(0, 3) ?? []
        });
        continue;
      }

      const bytes = await readFile(outPath);
      const report = probeFlverCandidate(bytes);
      const evidence = collectLayoutOffsetEvidence(bytes, report);
      const layout0 = report.layouts[0];
      hits.push({
        name: base,
        authority: report.authority,
        version: report.version,
        dataOffset: report.dataOffset,
        dataLength: report.dataLength,
        meshCount: report.meshCount,
        meshRows: report.meshes.length,
        layoutRows: report.layouts.length,
        materialCount: report.materialCount,
        boneCount: report.boneCount,
        layoutOffsetEvidence: evidence,
        mesh0: report.meshes[0]
          ? {
              dynamic: report.meshes[0].dynamic,
              materialIndex: report.meshes[0].materialIndex,
              boneCount: report.meshes[0].boneCount,
              boneIndicesSample: report.meshes[0].boneIndicesSample ?? null,
              faceSetCount: report.meshes[0].faceSetCount,
              vertexBufferCount: report.meshes[0].vertexBufferCount,
              layoutSane: report.meshes[0].layoutSane,
              faceSet0: report.meshes[0].faceSet0
                ? {
                    flags: report.meshes[0].faceSet0.flags,
                    topology: report.meshes[0].faceSet0.topology,
                    indexCount: report.meshes[0].faceSet0.indexCount,
                    layoutSane: report.meshes[0].faceSet0.layoutSane
                  }
                : null,
              vertexBuffer0: report.meshes[0].vertexBuffer0
                ? {
                    layoutIndex: report.meshes[0].vertexBuffer0.layoutIndex,
                    vertexSize: report.meshes[0].vertexBuffer0.vertexSize,
                    vertexCount: report.meshes[0].vertexBuffer0.vertexCount,
                    layoutSane: report.meshes[0].vertexBuffer0.layoutSane
                  }
                : null
            }
          : null,
        layout0: layout0
          ? {
              memberCount: layout0.memberCount,
              layoutSane: layout0.layoutSane,
              member0: layout0.members[0]
                ? {
                    type: layout0.members[0].type,
                    semantic: layout0.members[0].semantic,
                    semanticIndex: layout0.members[0].semanticIndex,
                    structOffset: layout0.members[0].structOffset
                  }
                : null
            }
          : null
      });
      if (hits.length >= 3) break;
    }

    if (hits.length === 0) {
      const detail = {
        code: 'HAS_GAME_FLVER_CANDIDATE_NONE',
        message: 'no FLVER candidate extracted from chrbnd children',
        nestedEntryCount: envelope.nested?.entryCount ?? 0,
        flverNamedCount: flverNamed.length,
        entryNameSample: entryNames.slice(0, 24),
        entryFieldSample: (envelope.nested?.entries ?? []).slice(0, 3).map((e) => ({
          keys: Object.keys(e as object),
          entryIndex: (e as { entryIndex?: unknown }).entryIndex ?? null,
          index: (e as { index?: unknown }).index ?? null,
          name: (e as { name?: unknown }).name ?? null,
          contentHash: (e as { contentHash?: unknown }).contentHash ?? null,
          path: (e as { path?: unknown }).path ?? null,
          childPath: (e as { childPath?: unknown }).childPath ?? null
        })),
        attemptLog
      };
      // Write a durable local log for diagnosis (temp only; never game root).
      await writeFile(join(writableRoot, 'attempt-log.json'), JSON.stringify(detail, null, 2), 'utf8');
      throw new Error(JSON.stringify(detail));
    }

    // Require at least one candidate authority hit.
    if (!hits.some((h) => h.authority === 'candidate')) {
      throw new Error(
        `FLVER children present but none candidate-authority: ${JSON.stringify(hits)}`
      );
    }

    const afterHash = sha256(await readFile(source));
    const afterStat = await stat(source);
    if (afterHash !== beforeHash || afterStat.mtimeMs !== beforeStat.mtimeMs) {
      throw new Error('game fixture was modified — game root must remain read-only');
    }

    const payload = {
          ok: true,
          message:
            'has-game FLVER candidate probe passed (header+mesh/faceSet/vb/boneIndices/layout; no geometry decode; no writer)',
          sourceFixture: source,
          nestedEntryCount: envelope.nested?.entryCount ?? 0,
          flverHits: hits.length,
          sample: hits,
          originalFixtureUntouched: true,
          noGeometryDecode: true,
          noIndexPayloadDecode: true,
          noBoneHierarchy: true,
          noVertexStreamDecode: true,
          noWriter: true,
          gameRootReadOnly: true
        };
        const evidenceOut = process.env.SOULFORGE_FLVER_EVIDENCE_OUT?.trim();
        if (evidenceOut) {
          await writeFile(evidenceOut, JSON.stringify(payload, null, 2), 'utf8');
          console.error(`wroteEvidence=${evidenceOut}`);
        }
        console.log(JSON.stringify(payload, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
    await rm(writableRoot, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
