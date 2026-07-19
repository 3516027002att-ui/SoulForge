/**
 * FLVER header + mesh-table candidate probe (read-only).
 * Does not claim mesh geometry decode, material binding, bone hierarchy, or writer authority.
 *
 * Mesh-row layout is a FLVER2-style candidate (0x40 stride):
 *   +0x00 dynamic
 *   +0x04 materialIndex
 *   +0x08 defaultBoneIndex
 *   +0x0c boneCount
 *   +0x10 boundingBoxOffset
 *   +0x14 boneIndicesOffset
 *   +0x18 faceSetCount
 *   +0x1c faceSetOffset
 *   +0x20 vertexBufferCount
 *   +0x24 vertexBufferOffset
 *
 * Face-set header candidate (first entry only, 0x20 stride sample):
 *   +0x00 flags
 *   +0x04 topology (candidate)
 *   +0x08 indexCount
 *   +0x0c indicesOffset
 *
 * Vertex-buffer header candidate (first entry only, 0x20 stride sample):
 *   +0x00 bufferIndex
 *   +0x04 layoutIndex
 *   +0x08 vertexSize
 *   +0x0c vertexCount
 *   +0x10 bufferLength
 *   +0x14 bufferOffset
 *
 * Bone-indices sample (candidate only):
 *   int16 LE array at boneIndicesOffset, length=boneCount, capped.
 *   No bone hierarchy / matrix / parent decode.
 *
 * Buffer-layout table candidate (after mesh secondaries, heuristic start):
 *   layout header: int32 memberCount
 *   member 0x0C: unk00, structOffset(u16), type(u8), semantic(u8), semanticIndex(u8), pad
 *   No vertex attribute stream decode. No writer.
 *
 * Remaining bytes are opaque. No index/vertex payload decode. No writer.
 */

import { createHash } from 'node:crypto';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

const MESH_STRIDE = 0x40;
const MESH_HEADER_MIN = 0x28;
const FACESET_HEADER_MIN = 0x10;
const VB_HEADER_MIN = 0x18;
const LAYOUT_MEMBER_STRIDE = 0x0c;
const MAX_MESH_ROWS = 256;
const MAX_LAYOUT_ROWS = 16;
const MAX_LAYOUT_MEMBERS = 16;
/** Cap bone-index samples so large skinned meshes stay cheap to probe. */
const BONE_INDEX_SAMPLE_CAP = 32;

export interface FlverFaceSetHeaderCandidate {
  headerOffset: number;
  flags: number;
  topology: number;
  indexCount: number;
  indicesOffset: number;
  layoutSane: boolean;
  notes: string[];
}

export interface FlverVertexBufferHeaderCandidate {
  headerOffset: number;
  bufferIndex: number;
  layoutIndex: number;
  vertexSize: number;
  vertexCount: number;
  bufferLength: number;
  bufferOffset: number;
  layoutSane: boolean;
  notes: string[];
}

/** One buffer-layout member row (SoulsFormats-style 0x0C candidate). */
export interface FlverLayoutMemberCandidate {
  index: number;
  unk00: number;
  structOffset: number;
  type: number;
  semantic: number;
  semanticIndex: number;
  layoutSane: boolean;
  notes: string[];
}

/** One buffer-layout table entry: memberCount + capped member samples. */
export interface FlverBufferLayoutCandidate {
  index: number;
  headerOffset: number;
  memberCount: number;
  members: FlverLayoutMemberCandidate[];
  layoutSane: boolean;
  notes: string[];
}

/** Candidate mesh header row. Offsets are absolute file positions unless noted. */
export interface FlverMeshTableEntry {
  index: number;
  /** Absolute offset of this mesh header row inside the file. */
  headerOffset: number;
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
  /** First face-set header sample when count/offset allow (candidate only). */
  faceSet0?: FlverFaceSetHeaderCandidate;
  /** First vertex-buffer header sample when count/offset allow (candidate only). */
  vertexBuffer0?: FlverVertexBufferHeaderCandidate;
  /** Sample of bone indices table (capped; candidate only, no hierarchy claim). */
  boneIndicesSample?: number[];
  /** True when all absolute offsets are in-file and counts are non-negative. */
  layoutSane: boolean;
  notes: string[];
}

export type FlverProbeAuthority = 'candidate' | 'unsupported';

export interface FlverCandidateReport {
  authority: FlverProbeAuthority;
  magic: string;
  /** Header integer endian used for candidate parse (LE preferred when both sane). */
  littleEndian: boolean;
  version: number;
  dataOffset: number;
  dataLength: number;
  dummyCount: number;
  materialCount: number;
  boneCount: number;
  meshCount: number;
  /** Candidate mesh header rows (capped). */
  meshes: FlverMeshTableEntry[];
  /**
   * Buffer-layout table samples (candidate). Heuristic start after mesh
   * secondaries; empty when layout region is absent/untrusted.
   */
  layouts: FlverBufferLayoutCandidate[];
  contentHash: string;
  byteLength: number;
  diagnostics: StructuredDiagnostic[];
}

function empty(partial: Partial<FlverCandidateReport> & {
  authority: FlverProbeAuthority;
  diagnostics: StructuredDiagnostic[];
}): FlverCandidateReport {
  return {
    authority: partial.authority,
    magic: partial.magic ?? '',
    littleEndian: partial.littleEndian ?? true,
    version: partial.version ?? 0,
    dataOffset: partial.dataOffset ?? 0,
    dataLength: partial.dataLength ?? 0,
    dummyCount: partial.dummyCount ?? 0,
    materialCount: partial.materialCount ?? 0,
    boneCount: partial.boneCount ?? 0,
    meshCount: partial.meshCount ?? 0,
    meshes: partial.meshes ?? [],
    layouts: partial.layouts ?? [],
    contentHash: partial.contentHash ?? '',
    byteLength: partial.byteLength ?? 0,
    diagnostics: partial.diagnostics
  };
}

/**
 * Probe FLVER-like bytes for header + mesh-table candidate fields.
 * Never mutates input. Never claims geometry or writer authority.
 */
export function probeFlverCandidate(bytes: Buffer): FlverCandidateReport {
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length < 0x40) {
    return empty({
      authority: 'unsupported',
      byteLength: bytes.length,
      contentHash,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'FLVER_TOO_SMALL',
        message: 'buffer too small for FLVER header'
      })]
    });
  }

  const magic = bytes.subarray(0, 6).toString('ascii');
  // Accept FLVER\0 or FLVER\x00le-style; require ASCII 'FLVER' prefix.
  if (!magic.startsWith('FLVER')) {
    return empty({
      magic,
      byteLength: bytes.length,
      contentHash,
      authority: 'unsupported',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'FLVER_MAGIC_MISMATCH',
        message: `expected FLVER magic, got ${JSON.stringify(magic)}`
      })]
    });
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // FLVER2-ish header: try LE first (synthetic + most PC titles), then BE.
  // Candidate only — does not claim full SoulsFormats parity.
  const header = pickFlverHeaderEndian(view, bytes.length);
  if (!header) {
    const le = readFlverHeaderFields(view, true);
    const be = readFlverHeaderFields(view, false);
    return empty({
      authority: 'unsupported',
      magic: 'FLVER',
      version: le.version,
      dataOffset: le.dataOffset,
      dataLength: le.dataLength,
      dummyCount: le.dummyCount,
      materialCount: le.materialCount,
      boneCount: le.boneCount,
      meshCount: le.meshCount,
      contentHash,
      byteLength: bytes.length,
      diagnostics: [createDiagnostic({
        severity: 'warning',
        code: 'FLVER_HEADER_UNTRUSTED',
        message: 'FLVER-like header fields look untrusted under LE/BE; keep unsupported.',
        details: { littleEndian: le, bigEndian: be }
      })]
    });
  }

  const {
    version,
    dataOffset,
    dataLength,
    dummyCount,
    materialCount,
    boneCount,
    meshCount,
    littleEndian
  } = header;

  const diagnostics: StructuredDiagnostic[] = [createDiagnostic({
    severity: 'info',
    code: 'FLVER_HEADER_CANDIDATE',
    message:
      'FLVER header candidate parsed; mesh/faceSet/vb/layout headers sampled only; no geometry decode; no writer.',
    details: {
      version,
      meshCount,
      materialCount,
      boneCount,
      bufferLength: bytes.length,
      headerEndian: littleEndian ? 'le' : 'be'
    }
  })];

  const meshes = readMeshTableCandidate(view, {
    dataOffset,
    meshCount,
    materialCount,
    boneCount,
    byteLength: bytes.length,
    littleEndian
  }, diagnostics);

  const layouts = (() => {
    // Heuristic start: after mesh headers + per-mesh secondary blocks (0x60).
    // Matches synthetic fixture; real files may place layouts elsewhere — fail soft.
    const perMeshSecondary = 0x60;
    const layoutStart =
      dataOffset + meshCount * MESH_STRIDE + meshCount * perMeshSecondary;
    // Count hint from max layoutIndex+1 across sampled VBs, default 1.
    let hint = 1;
    for (const m of meshes) {
      const li = m.vertexBuffer0?.layoutIndex;
      if (typeof li === 'number' && li >= 0 && li < 256) {
        hint = Math.max(hint, li + 1);
      }
    }
    return readBufferLayoutTableCandidate(
      view,
      layoutStart,
      hint,
      bytes.length,
      diagnostics
    );
  })();

  return {
    authority: 'candidate',
    magic: 'FLVER',
    littleEndian,
    version,
    dataOffset,
    dataLength,
    dummyCount,
    materialCount,
    boneCount,
    meshCount,
    meshes,
    layouts,
    contentHash,
    byteLength: bytes.length,
    diagnostics
  };
}

interface FlverHeaderFields {
  version: number;
  dataOffset: number;
  dataLength: number;
  dummyCount: number;
  materialCount: number;
  boneCount: number;
  meshCount: number;
}

function readFlverHeaderFields(view: DataView, littleEndian: boolean): FlverHeaderFields {
  return {
    version: view.getInt32(0x08, littleEndian),
    dataOffset: view.getInt32(0x0c, littleEndian),
    dataLength: view.getInt32(0x10, littleEndian),
    dummyCount: view.getInt32(0x14, littleEndian),
    materialCount: view.getInt32(0x18, littleEndian),
    boneCount: view.getInt32(0x1c, littleEndian),
    meshCount: view.getInt32(0x20, littleEndian)
  };
}

function flverHeaderCountsSane(fields: FlverHeaderFields, byteLength: number): boolean {
  return fields.dummyCount >= 0 && fields.dummyCount < 100_000
    && fields.materialCount >= 0 && fields.materialCount < 100_000
    && fields.boneCount >= 0 && fields.boneCount < 100_000
    && fields.meshCount >= 0 && fields.meshCount < 100_000
    && fields.dataOffset >= 0x40
    && fields.dataOffset < 50_000_000
    && fields.dataOffset <= byteLength
    && fields.dataLength >= 0
    && fields.dataLength < 200_000_000
    && fields.version !== 0;
}

function pickFlverHeaderEndian(
  view: DataView,
  byteLength: number
): (FlverHeaderFields & { littleEndian: boolean }) | null {
  const le = readFlverHeaderFields(view, true);
  if (flverHeaderCountsSane(le, byteLength)) {
    return { ...le, littleEndian: true };
  }
  const be = readFlverHeaderFields(view, false);
  if (flverHeaderCountsSane(be, byteLength)) {
    return { ...be, littleEndian: false };
  }
  return null;
}

function readMeshTableCandidate(
  view: DataView,
  ctx: {
    dataOffset: number;
    meshCount: number;
    materialCount: number;
    boneCount: number;
    byteLength: number;
    littleEndian: boolean;
  },
  diagnostics: StructuredDiagnostic[]
): FlverMeshTableEntry[] {
  const le = ctx.littleEndian;
  const out: FlverMeshTableEntry[] = [];
  if (ctx.meshCount <= 0) return out;

  const maxRows = Math.min(ctx.meshCount, MAX_MESH_ROWS);
  let truncated = false;
  let insaneRows = 0;

  const offsetOk = (off: number): boolean => off === 0 || (off > 0 && off < ctx.byteLength);

  for (let i = 0; i < maxRows; i += 1) {
    const headerOffset = ctx.dataOffset + i * MESH_STRIDE;
    if (headerOffset + MESH_HEADER_MIN > ctx.byteLength) {
      truncated = true;
      break;
    }

    const dynamic = view.getInt32(headerOffset + 0x00, le);
    const materialIndex = view.getInt32(headerOffset + 0x04, le);
    const defaultBoneIndex = view.getInt32(headerOffset + 0x08, le);
    const boneCount = view.getInt32(headerOffset + 0x0c, le);
    const boundingBoxOffset = view.getInt32(headerOffset + 0x10, le);
    const boneIndicesOffset = view.getInt32(headerOffset + 0x14, le);
    const faceSetCount = view.getInt32(headerOffset + 0x18, le);
    const faceSetOffset = view.getInt32(headerOffset + 0x1c, le);
    const vertexBufferCount = view.getInt32(headerOffset + 0x20, le);
    const vertexBufferOffset = view.getInt32(headerOffset + 0x24, le);

    const notes: string[] = [];
    if (materialIndex < 0 || (ctx.materialCount > 0 && materialIndex >= ctx.materialCount)) {
      notes.push('materialIndex-oob');
    }
    if (boneCount < 0 || boneCount > 4096) notes.push('boneCount-suspicious');
    if (faceSetCount < 0 || faceSetCount > 4096) notes.push('faceSetCount-suspicious');
    if (vertexBufferCount < 0 || vertexBufferCount > 64) notes.push('vertexBufferCount-suspicious');
    if (defaultBoneIndex < -1
      && !(defaultBoneIndex === 0xFFFF || defaultBoneIndex === -1)) {
      notes.push('defaultBoneIndex-suspicious');
    }
    if (!offsetOk(boundingBoxOffset)) notes.push('boundingBoxOffset-oob');
    if (!offsetOk(boneIndicesOffset)) notes.push('boneIndicesOffset-oob');
    if (!offsetOk(faceSetOffset)) notes.push('faceSetOffset-oob');
    if (!offsetOk(vertexBufferOffset)) notes.push('vertexBufferOffset-oob');

    const faceSet0 = faceSetCount > 0 && faceSetOffset > 0
      ? readFaceSetHeaderCandidate(view, faceSetOffset, ctx.byteLength, le)
      : undefined;
    const vertexBuffer0 = vertexBufferCount > 0 && vertexBufferOffset > 0
      ? readVertexBufferHeaderCandidate(view, vertexBufferOffset, ctx.byteLength, le)
      : undefined;
    const boneIndicesSample = boneCount > 0 && boneIndicesOffset > 0
      ? readBoneIndicesSample(view, boneIndicesOffset, boneCount, ctx.byteLength, le)
      : undefined;

    if (faceSet0 && !faceSet0.layoutSane) notes.push('faceSet0-layout-insane');
    if (vertexBuffer0 && !vertexBuffer0.layoutSane) notes.push('vertexBuffer0-layout-insane');
    if (boneCount > 0 && boneIndicesOffset > 0 && (!boneIndicesSample || boneIndicesSample.length === 0)) {
      notes.push('boneIndices-unreadable');
    }

    const layoutSane = notes.length === 0
      && (!faceSet0 || faceSet0.layoutSane)
      && (!vertexBuffer0 || vertexBuffer0.layoutSane);
    if (!layoutSane) insaneRows += 1;

    const entry: FlverMeshTableEntry = {
      index: i,
      headerOffset,
      dynamic,
      materialIndex,
      defaultBoneIndex,
      boneCount,
      boundingBoxOffset,
      boneIndicesOffset,
      faceSetCount,
      faceSetOffset,
      vertexBufferCount,
      vertexBufferOffset,
      layoutSane,
      notes
    };
    if (faceSet0) entry.faceSet0 = faceSet0;
    if (vertexBuffer0) entry.vertexBuffer0 = vertexBuffer0;
    if (boneIndicesSample && boneIndicesSample.length > 0) entry.boneIndicesSample = boneIndicesSample;
    out.push(entry);
  }

  if (truncated || ctx.meshCount > MAX_MESH_ROWS || insaneRows > 0) {
    diagnostics.push(createDiagnostic({
      severity: 'info',
      code: 'FLVER_MESH_TABLE_PARTIAL',
      message: 'mesh table candidate partial or capped; faceSet/vb headers sampled when in-bounds',
      details: {
        rowsRead: out.length,
        declaredMeshCount: ctx.meshCount,
        cappedAt: MAX_MESH_ROWS,
        truncated,
        insaneRows,
        sample: out[0]
          ? {
              materialIndex: out[0].materialIndex,
              faceSetCount: out[0].faceSetCount,
              vertexBufferCount: out[0].vertexBufferCount,
              faceSet0: out[0].faceSet0
                ? {
                    indexCount: out[0].faceSet0.indexCount,
                    layoutSane: out[0].faceSet0.layoutSane
                  }
                : null,
              vertexBuffer0: out[0].vertexBuffer0
                ? {
                    vertexSize: out[0].vertexBuffer0.vertexSize,
                    vertexCount: out[0].vertexBuffer0.vertexCount,
                    layoutSane: out[0].vertexBuffer0.layoutSane
                  }
                : null
            }
          : null
      }
    }));
  } else if (out.length > 0) {
    diagnostics.push(createDiagnostic({
      severity: 'info',
      code: 'FLVER_MESH_TABLE_CANDIDATE',
      message:
        'mesh table candidate rows + first faceSet/vb headers sampled (no geometry decode)',
      details: {
        rows: out.length,
        sample: out[0]
          ? {
              materialIndex: out[0].materialIndex,
              faceSetCount: out[0].faceSetCount,
              vertexBufferCount: out[0].vertexBufferCount,
              boneCount: out[0].boneCount,
              faceSet0IndexCount: out[0].faceSet0?.indexCount,
              vb0VertexCount: out[0].vertexBuffer0?.vertexCount
            }
          : null
      }
    }));
  }

  return out;
}

/**
 * Read a capped int16 bone-index sample. Candidate only — no hierarchy claim.
 * Returns undefined when the declared range is truncated or unreadable.
 */
function readBoneIndicesSample(
  view: DataView,
  offset: number,
  boneCount: number,
  byteLength: number,
  littleEndian: boolean
): number[] | undefined {
  if (offset <= 0 || boneCount <= 0 || boneCount > 4096) return undefined;
  const sampleCount = Math.min(boneCount, BONE_INDEX_SAMPLE_CAP);
  const end = offset + sampleCount * 2;
  if (end > byteLength) return undefined;
  const out: number[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    out.push(view.getInt16(offset + i * 2, littleEndian));
  }
  return out;
}

function readFaceSetHeaderCandidate(
  view: DataView,
  headerOffset: number,
  byteLength: number,
  littleEndian: boolean
): FlverFaceSetHeaderCandidate {
  const notes: string[] = [];
  if (headerOffset + FACESET_HEADER_MIN > byteLength) {
    return {
      headerOffset,
      flags: 0,
      topology: 0,
      indexCount: 0,
      indicesOffset: 0,
      layoutSane: false,
      notes: ['faceSet-header-truncated']
    };
  }
  const flags = view.getInt32(headerOffset + 0x00, littleEndian);
  const topology = view.getInt32(headerOffset + 0x04, littleEndian);
  const indexCount = view.getInt32(headerOffset + 0x08, littleEndian);
  const indicesOffset = view.getInt32(headerOffset + 0x0c, littleEndian);
  if (indexCount < 0 || indexCount > 50_000_000) notes.push('indexCount-suspicious');
  if (indicesOffset !== 0 && (indicesOffset < 0 || indicesOffset >= byteLength)) {
    notes.push('indicesOffset-oob');
  }
  return {
    headerOffset,
    flags,
    topology,
    indexCount,
    indicesOffset,
    layoutSane: notes.length === 0,
    notes
  };
}

function readVertexBufferHeaderCandidate(
  view: DataView,
  headerOffset: number,
  byteLength: number,
  littleEndian: boolean
): FlverVertexBufferHeaderCandidate {
  const notes: string[] = [];
  if (headerOffset + VB_HEADER_MIN > byteLength) {
    return {
      headerOffset,
      bufferIndex: 0,
      layoutIndex: 0,
      vertexSize: 0,
      vertexCount: 0,
      bufferLength: 0,
      bufferOffset: 0,
      layoutSane: false,
      notes: ['vb-header-truncated']
    };
  }
  const bufferIndex = view.getInt32(headerOffset + 0x00, littleEndian);
  const layoutIndex = view.getInt32(headerOffset + 0x04, littleEndian);
  const vertexSize = view.getInt32(headerOffset + 0x08, littleEndian);
  const vertexCount = view.getInt32(headerOffset + 0x0c, littleEndian);
  const bufferLength = view.getInt32(headerOffset + 0x10, littleEndian);
  const bufferOffset = view.getInt32(headerOffset + 0x14, littleEndian);
  if (vertexSize < 0 || vertexSize > 1024) notes.push('vertexSize-suspicious');
  if (vertexCount < 0 || vertexCount > 50_000_000) notes.push('vertexCount-suspicious');
  if (bufferLength < 0 || bufferLength > 200_000_000) notes.push('bufferLength-suspicious');
  if (bufferOffset !== 0 && (bufferOffset < 0 || bufferOffset >= byteLength)) {
    notes.push('bufferOffset-oob');
  }
  if (vertexSize > 0 && vertexCount > 0 && bufferLength > 0
    && bufferLength < vertexSize * Math.min(vertexCount, 1)) {
    notes.push('bufferLength-lt-one-vertex');
  }
  return {
    headerOffset,
    bufferIndex,
    layoutIndex,
    vertexSize,
    vertexCount,
    bufferLength,
    bufferOffset,
    layoutSane: notes.length === 0,
    notes
  };
}

/**
 * Buffer-layout table candidate.
 * Heuristic: layouts begin immediately after the last mesh secondary block.
 * Does not decode vertex attribute streams; members are header samples only.
 */
function readBufferLayoutTableCandidate(
  view: DataView,
  layoutTableOffset: number,
  layoutCountHint: number,
  byteLength: number,
  diagnostics: StructuredDiagnostic[]
): FlverBufferLayoutCandidate[] {
  const out: FlverBufferLayoutCandidate[] = [];
  if (layoutTableOffset <= 0 || layoutTableOffset >= byteLength || layoutCountHint <= 0) {
    return out;
  }

  let cursor = layoutTableOffset;
  const maxLayouts = Math.min(layoutCountHint, MAX_LAYOUT_ROWS);
  let truncated = false;
  let insane = 0;

  for (let i = 0; i < maxLayouts; i += 1) {
    if (cursor + 4 > byteLength) {
      truncated = true;
      break;
    }
    const memberCount = view.getInt32(cursor, true);
    const notes: string[] = [];
    if (memberCount < 0 || memberCount > 256) {
      notes.push('memberCount-suspicious');
      insane += 1;
      out.push({
        index: i,
        headerOffset: cursor,
        memberCount,
        members: [],
        layoutSane: false,
        notes
      });
      break;
    }

    const members: FlverLayoutMemberCandidate[] = [];
    let memberCursor = cursor + 4;
    const sampleCount = Math.min(memberCount, MAX_LAYOUT_MEMBERS);
    let membersOk = true;
    for (let m = 0; m < sampleCount; m += 1) {
      if (memberCursor + LAYOUT_MEMBER_STRIDE > byteLength) {
        truncated = true;
        membersOk = false;
        notes.push('member-truncated');
        break;
      }
      const unk00 = view.getInt32(memberCursor + 0x00, true);
      const structOffset = view.getUint16(memberCursor + 0x04, true);
      const type = view.getUint8(memberCursor + 0x06);
      const semantic = view.getUint8(memberCursor + 0x07);
      const semanticIndex = view.getUint8(memberCursor + 0x08);
      const memberNotes: string[] = [];
      if (structOffset > 4096) memberNotes.push('structOffset-suspicious');
      if (type > 64) memberNotes.push('type-suspicious');
      if (semantic > 64) memberNotes.push('semantic-suspicious');
      members.push({
        index: m,
        unk00,
        structOffset,
        type,
        semantic,
        semanticIndex,
        layoutSane: memberNotes.length === 0,
        notes: memberNotes
      });
      if (memberNotes.length > 0) membersOk = false;
      memberCursor += LAYOUT_MEMBER_STRIDE;
    }

    // Advance past all declared members even if we only sampled a cap.
    const fullMemberBytes = memberCount * LAYOUT_MEMBER_STRIDE;
    const next = cursor + 4 + fullMemberBytes;
    if (next > byteLength) {
      truncated = true;
      notes.push('layout-span-oob');
      membersOk = false;
    }

    out.push({
      index: i,
      headerOffset: cursor,
      memberCount,
      members,
      layoutSane: membersOk && notes.length === 0,
      notes
    });
    if (!membersOk) insane += 1;
    if (next > byteLength) break;
    cursor = next;
  }

  if (out.length > 0) {
    diagnostics.push(createDiagnostic({
      severity: 'info',
      code: truncated || insane > 0 ? 'FLVER_LAYOUT_TABLE_PARTIAL' : 'FLVER_LAYOUT_TABLE_CANDIDATE',
      message: truncated || insane > 0
        ? 'buffer layout table candidate partial/capped; no vertex stream decode'
        : 'buffer layout table candidate sampled (member headers only; no vertex stream decode)',
      details: {
        layoutTableOffset,
        rows: out.length,
        truncated,
        insane,
        sample: out[0]
          ? {
              memberCount: out[0].memberCount,
              firstSemantic: out[0].members[0]?.semantic,
              firstType: out[0].members[0]?.type,
              layoutSane: out[0].layoutSane
            }
          : null
      }
    }));
  }

  return out;
}

/** Build a minimal synthetic FLVER-like header + mesh/faceSet/vb/layout rows for unit smoke (not game asset). */
export function buildSyntheticFlverHeaderFixture(options?: {
  meshCount?: number;
  materialCount?: number;
  boneCount?: number;
  layoutCount?: number;
}): Buffer {
  const meshCount = options?.meshCount ?? 2;
  const layoutCount = options?.layoutCount ?? 1;
  const dataOffset = 0x80;
  // Per-mesh secondary tables: bones(0x20) + faceSet hdr(0x20) + vb hdr(0x20) + pad
  const perMeshSecondary = 0x60;
  // layout0: memberCount(4) + 3 members * 0x0C + pad
  const layoutBlock = 4 + 3 * LAYOUT_MEMBER_STRIDE + 0x10;
  const total =
    dataOffset
    + meshCount * MESH_STRIDE
    + meshCount * perMeshSecondary
    + layoutCount * layoutBlock
    + 0x40;
  const buf = Buffer.alloc(total, 0);
  buf.write('FLVER\0', 0, 6, 'ascii');
  // endian marker LE-ish
  buf.writeUInt8(0x4c, 6); // 'L'
  buf.writeUInt8(0x00, 7);
  buf.writeInt32LE(0x2001c, 0x08); // version candidate
  buf.writeInt32LE(dataOffset, 0x0c);
  buf.writeInt32LE(total - dataOffset, 0x10);
  buf.writeInt32LE(0, 0x14); // dummy
  buf.writeInt32LE(options?.materialCount ?? 3, 0x18);
  buf.writeInt32LE(options?.boneCount ?? 4, 0x1c);
  buf.writeInt32LE(meshCount, 0x20);

  for (let i = 0; i < meshCount; i += 1) {
    const o = dataOffset + i * MESH_STRIDE;
    const boneCount = 2 + i;
    const faceSetCount = 1 + i;
    const vertexBufferCount = 1;
    const secondaryBase = dataOffset + meshCount * MESH_STRIDE + i * perMeshSecondary;
    const boneIndicesOffset = secondaryBase;
    const faceSetOffset = secondaryBase + 0x20;
    const vertexBufferOffset = secondaryBase + 0x40;
    const boundingBoxOffset = secondaryBase + 0x10;

    buf.writeInt32LE(i, o + 0x00); // dynamic
    buf.writeInt32LE(i % (options?.materialCount ?? 3), o + 0x04);
    buf.writeInt32LE(0, o + 0x08); // defaultBoneIndex
    buf.writeInt32LE(boneCount, o + 0x0c);
    buf.writeInt32LE(boundingBoxOffset, o + 0x10);
    buf.writeInt32LE(boneIndicesOffset, o + 0x14);
    buf.writeInt32LE(faceSetCount, o + 0x18);
    buf.writeInt32LE(faceSetOffset, o + 0x1c);
    buf.writeInt32LE(vertexBufferCount, o + 0x20);
    buf.writeInt32LE(vertexBufferOffset, o + 0x24);

    // bone indices placeholder
    // bone indices sample (int16)
    for (let b = 0; b < boneCount; b += 1) {
      buf.writeInt16LE(b, boneIndicesOffset + b * 2);
    }

    // face-set header sample
    buf.writeInt32LE(0, faceSetOffset + 0x00); // flags
    buf.writeInt32LE(3, faceSetOffset + 0x04); // topology candidate (triangles)
    buf.writeInt32LE(3 * (i + 1), faceSetOffset + 0x08); // indexCount
    buf.writeInt32LE(faceSetOffset + 0x10, faceSetOffset + 0x0c); // indicesOffset (dummy)

    // vertex-buffer header sample
    buf.writeInt32LE(0, vertexBufferOffset + 0x00); // bufferIndex
    buf.writeInt32LE(0, vertexBufferOffset + 0x04); // layoutIndex
    buf.writeInt32LE(24, vertexBufferOffset + 0x08); // vertexSize
    buf.writeInt32LE(3 * (i + 1), vertexBufferOffset + 0x0c); // vertexCount
    buf.writeInt32LE(24 * 3 * (i + 1), vertexBufferOffset + 0x10); // bufferLength
    buf.writeInt32LE(vertexBufferOffset + 0x18, vertexBufferOffset + 0x14); // bufferOffset dummy

    buf.writeFloatLE(0, boundingBoxOffset);
  }

  // Buffer layout table after mesh secondaries (heuristic start matches reader).
  let layoutCursor = dataOffset + meshCount * MESH_STRIDE + meshCount * perMeshSecondary;
  for (let li = 0; li < layoutCount; li += 1) {
    const memberCount = 3;
    buf.writeInt32LE(memberCount, layoutCursor);
    // member0: Position Float3 @0
    const m0 = layoutCursor + 4;
    buf.writeInt32LE(0, m0 + 0x00);
    buf.writeUInt16LE(0, m0 + 0x04);
    buf.writeUInt8(0x02, m0 + 0x06); // type Float3 candidate
    buf.writeUInt8(0x00, m0 + 0x07); // semantic Position
    buf.writeUInt8(0, m0 + 0x08);
    // member1: Normal Float3 @12
    const m1 = m0 + LAYOUT_MEMBER_STRIDE;
    buf.writeInt32LE(0, m1 + 0x00);
    buf.writeUInt16LE(12, m1 + 0x04);
    buf.writeUInt8(0x02, m1 + 0x06);
    buf.writeUInt8(0x02, m1 + 0x07); // Normal
    buf.writeUInt8(0, m1 + 0x08);
    // member2: UV Float2 @24
    const m2 = m1 + LAYOUT_MEMBER_STRIDE;
    buf.writeInt32LE(0, m2 + 0x00);
    buf.writeUInt16LE(24, m2 + 0x04);
    buf.writeUInt8(0x01, m2 + 0x06); // Float2
    buf.writeUInt8(0x05, m2 + 0x07); // UV
    buf.writeUInt8(0, m2 + 0x08);
    layoutCursor += layoutBlock;
  }
  return buf;
}
