/**
 * FLVER header candidate probe (read-only).
 * Does not claim mesh decode or writer authority — only magic/version/envelope.
 */

import { createHash } from 'node:crypto';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

export interface FlverMeshTableEntry {
  index: number;
  /** Absolute offset of mesh header row inside the file (candidate layout). */
  headerOffset: number;
  /** Raw fields preserved for later FLVER decoder — not claimed as final schema. */
  field0: number;
  field1: number;
  field2: number;
  field3: number;
}

export interface FlverCandidateReport {
  authority: 'unsupported' | 'candidate';
  magic: string;
  version?: number;
  dataOffset?: number;
  dataLength?: number;
  dummyCount?: number;
  materialCount?: number;
  boneCount?: number;
  meshCount?: number;
  /** Candidate mesh table rows (bounded). */
  meshes?: FlverMeshTableEntry[];
  contentHash: string;
  byteLength: number;
  diagnostics: StructuredDiagnostic[];
}

/**
 * Probe FLVER / FLVER2-like headers without full mesh parse.
 */
export function probeFlverCandidate(bytes: Buffer): FlverCandidateReport {
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const diagnostics: StructuredDiagnostic[] = [];
  if (bytes.length < 0x40) {
    return {
      authority: 'unsupported',
      magic: '',
      contentHash,
      byteLength: bytes.length,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'FLVER_TOO_SMALL',
        message: '缓冲区过小，无法识别 FLVER。'
      })]
    };
  }

  const magicAscii = bytes.subarray(0, 6).toString('ascii');
  // Common: "FLVER\0" or "FLVER\0" with version
  const isFlver = magicAscii.startsWith('FLVER');
  if (!isFlver) {
    return {
      authority: 'unsupported',
      magic: magicAscii.replace(/\0/g, ''),
      contentHash,
      byteLength: bytes.length,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'FLVER_MAGIC_MISMATCH',
        message: `不是 FLVER（magic=${JSON.stringify(magicAscii)}）。`
      })]
    };
  }

  // FLVER2-style: after magic, endian marker / version fields vary by game.
  // Read common little-endian layout used by DS3/Sekiro family without claiming full decode.
  const version = bytes.readUInt32LE(8);
  const dataOffset = bytes.readUInt32LE(0x0c);
  const dataLength = bytes.readUInt32LE(0x10);
  const dummyCount = bytes.readInt32LE(0x14);
  const materialCount = bytes.readInt32LE(0x18);
  const boneCount = bytes.readInt32LE(0x1c);
  const meshCount = bytes.readInt32LE(0x20);

  const countsSane =
    dummyCount >= 0 && dummyCount < 100_000
    && materialCount >= 0 && materialCount < 100_000
    && boneCount >= 0 && boneCount < 100_000
    && meshCount >= 0 && meshCount < 100_000
    && dataOffset >= 0 && dataOffset <= bytes.length
    && dataLength >= 0
    && (dataLength === 0 || dataOffset + dataLength <= bytes.length + 0x1000);

  if (!countsSane) {
    diagnostics.push(createDiagnostic({
      severity: 'warning',
      code: 'FLVER_HEADER_UNTRUSTED',
      message: 'FLVER 头计数字段不可信；仅 magic 命中，保持 unsupported。',
      details: { version, dummyCount, materialCount, boneCount, meshCount, dataOffset, dataLength }
    }));
    return {
      authority: 'unsupported',
      magic: 'FLVER',
      version,
      contentHash,
      byteLength: bytes.length,
      diagnostics
    };
  }

  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'FLVER_CANDIDATE_HEADER',
    message: 'FLVER 头候选解析成功；网格/材质/骨骼数据未完整解码，无 writer。',
    details: { version, meshCount, materialCount, boneCount }
  }));

  const meshes = readMeshTableCandidate(bytes, {
    dataOffset,
    meshCount,
    maxMeshes: 64
  });
  if (meshes.length > 0) {
    diagnostics.push(createDiagnostic({
      severity: 'info',
      code: 'FLVER_MESH_TABLE_CANDIDATE',
      message: `已读取 ${meshes.length} 条 mesh 表候选行（非完整几何解码）。`,
      details: { meshRows: meshes.length, declaredMeshCount: meshCount }
    }));
  }

  return {
    authority: 'candidate',
    magic: 'FLVER',
    version,
    dataOffset,
    dataLength,
    dummyCount,
    materialCount,
    boneCount,
    meshCount,
    ...(meshes.length ? { meshes } : {}),
    contentHash,
    byteLength: bytes.length,
    diagnostics
  };
}

/**
 * Best-effort FLVER2 mesh header table probe.
 * Layout varies by game/version; rows are recorded as opaque int32 fields only.
 */
function readMeshTableCandidate(
  bytes: Buffer,
  input: { dataOffset: number; meshCount: number; maxMeshes: number }
): FlverMeshTableEntry[] {
  if (input.meshCount <= 0 || input.dataOffset <= 0 || input.dataOffset >= bytes.length) {
    return [];
  }
  // Many FLVER2 layouts place mesh headers starting near dataOffset.
  // Use 0x40-byte candidate stride (common family size) and stop on OOB.
  const stride = 0x40;
  const count = Math.min(input.meshCount, input.maxMeshes);
  const rows: FlverMeshTableEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const headerOffset = input.dataOffset + i * stride;
    if (headerOffset + 16 > bytes.length) break;
    rows.push({
      index: i,
      headerOffset,
      field0: bytes.readInt32LE(headerOffset),
      field1: bytes.readInt32LE(headerOffset + 4),
      field2: bytes.readInt32LE(headerOffset + 8),
      field3: bytes.readInt32LE(headerOffset + 12)
    });
  }
  return rows;
}

/** Minimal synthetic FLVER2-like header for fixture smoke (not game asset). */
export function buildSyntheticFlverHeaderFixture(options?: {
  meshCount?: number;
  materialCount?: number;
  boneCount?: number;
}): Buffer {
  const meshCount = options?.meshCount ?? 1;
  const dataOffset = 0x80;
  const buf = Buffer.alloc(dataOffset + meshCount * 0x40, 0);
  buf.write('FLVER\0', 0, 'ascii');
  buf.writeUInt32LE(0x20010, 8); // version-ish
  buf.writeUInt32LE(dataOffset, 0x0c); // data offset
  buf.writeUInt32LE(meshCount * 0x40, 0x10); // data length
  buf.writeInt32LE(0, 0x14); // dummy
  buf.writeInt32LE(options?.materialCount ?? 1, 0x18);
  buf.writeInt32LE(options?.boneCount ?? 1, 0x1c);
  buf.writeInt32LE(meshCount, 0x20);
  for (let i = 0; i < meshCount; i += 1) {
    const o = dataOffset + i * 0x40;
    buf.writeInt32LE(i + 1, o);
    buf.writeInt32LE(10 * (i + 1), o + 4);
    buf.writeInt32LE(100 * (i + 1), o + 8);
    buf.writeInt32LE(0, o + 12);
  }
  return buf;
}
