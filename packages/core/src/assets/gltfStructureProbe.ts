/**
 * Structural probe for open-format glTF/GLB import staging.
 * Does not decode mesh geometry into a runtime scene graph and does not claim
 * native FLVER/MTD conversion authority.
 */

import { createHash } from 'node:crypto';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

export type GltfProbeAuthority = 'unsupported' | 'candidate';

export interface GltfStructureReport {
  /** true only when structure probe is candidate-usable (not a hard reject). */
  ok: boolean;
  authority: GltfProbeAuthority;
  container: 'gltf-json' | 'glb';
  version?: string;
  generator?: string;
  meshCount: number;
  materialCount: number;
  nodeCount: number;
  accessorCount: number;
  bufferViewCount: number;
  bufferCount: number;
  imageCount: number;
  animationCount: number;
  sceneCount: number;
  hasBinaryChunk: boolean;
  binaryChunkByteLength: number;
  /**
   * Sampled material names from glTF JSON (capped). Empty string names omitted.
   * Structure-only — no MTD/FLVER claim.
   */
  materialNames: string[];
  /**
   * Sampled node names from glTF JSON (capped). Empty string names omitted.
   * Structure-only — no HKX claim.
   */
  nodeNames: string[];
  contentHash: string;
  byteLength: number;
  notes: string[];
  diagnostics: StructuredDiagnostic[];
}

interface GltfJsonDoc {
  asset?: { version?: unknown; generator?: unknown };
  meshes?: unknown;
  materials?: unknown;
  nodes?: unknown;
  accessors?: unknown;
  bufferViews?: unknown;
  buffers?: unknown;
  images?: unknown;
  animations?: unknown;
  scenes?: unknown;
  scene?: unknown;
}

/**
 * Probe glTF JSON or GLB container structure for import planning.
 */
export function probeGltfStructure(bytes: Buffer, hint?: 'gltf' | 'glb'): GltfStructureReport {
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const base = emptyCounts(contentHash, bytes.length);

  if (bytes.length < 4) {
    return unsupported(hint === 'glb' ? 'glb' : 'gltf-json', base, 'GLTF_PROBE_TOO_SMALL', 'open-format glTF/GLB probe input too small');
  }

  const looksGlb = bytes.subarray(0, 4).toString('ascii') === 'glTF';
  if (looksGlb || hint === 'glb') {
    return probeGlb(bytes, base);
  }
  return probeGltfJson(bytes, base);
}

function emptyCounts(contentHash: string, byteLength: number) {
  return {
    meshCount: 0,
    materialCount: 0,
    nodeCount: 0,
    accessorCount: 0,
    bufferViewCount: 0,
    bufferCount: 0,
    imageCount: 0,
    animationCount: 0,
    sceneCount: 0,
    hasBinaryChunk: false,
    binaryChunkByteLength: 0,
    materialNames: [] as string[],
    nodeNames: [] as string[],
    contentHash,
    byteLength,
    notes: [] as string[]
  };
}

function unsupported(
  container: 'gltf-json' | 'glb',
  base: ReturnType<typeof emptyCounts>,
  code: string,
  message: string
): GltfStructureReport {
  return {
    ok: false,
    authority: 'unsupported',
    container,
    ...base,
    diagnostics: [
      createDiagnostic({ severity: 'error', code, message })
    ]
  };
}

function probeGlb(bytes: Buffer, base: ReturnType<typeof emptyCounts>): GltfStructureReport {
  if (bytes.length < 20) {
    return unsupported('glb', base, 'GLTF_GLB_TOO_SMALL', 'GLB header incomplete');
  }
  if (bytes.subarray(0, 4).toString('ascii') !== 'glTF') {
    return unsupported('glb', base, 'GLTF_GLB_MAGIC', 'GLB magic mismatch');
  }
  const version = bytes.readUInt32LE(4);
  const declaredLength = bytes.readUInt32LE(8);
  if (version !== 2) {
    return unsupported('glb', base, 'GLTF_GLB_VERSION', `GLB version ${version} unsupported (need 2)`);
  }
  if (declaredLength !== bytes.length) {
    base.notes.push(`glb-declared-length=${declaredLength}`);
    // tolerate trailing padding only when declared length is smaller
    if (declaredLength > bytes.length || declaredLength < 20) {
      return unsupported('glb', base, 'GLTF_GLB_LENGTH', 'GLB declared length invalid');
    }
  }

  let offset = 12;
  let jsonText: string | null = null;
  let binaryLen = 0;
  let hasBin = false;
  while (offset + 8 <= Math.min(bytes.length, declaredLength)) {
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (chunkLength < 0 || offset + chunkLength > bytes.length) {
      return unsupported('glb', base, 'GLTF_GLB_CHUNK', 'GLB chunk bounds invalid');
    }
    const chunk = bytes.subarray(offset, offset + chunkLength);
    offset += chunkLength;
    // chunks are 4-byte aligned in file layout already via padded length
    if (chunkType === 0x4e4f534a) {
      // JSON
      jsonText = chunk.toString('utf8').replace(/\0+$/g, '');
    } else if (chunkType === 0x004e4942) {
      hasBin = true;
      binaryLen = chunkLength;
    } else {
      base.notes.push(`glb-unknown-chunk-type=0x${chunkType.toString(16)}`);
    }
  }

  if (!jsonText) {
    return unsupported('glb', base, 'GLTF_GLB_JSON_MISSING', 'GLB JSON chunk missing');
  }

  const parsed = parseJsonDoc(jsonText);
  if (!parsed.ok) {
    return unsupported('glb', base, parsed.code, parsed.message);
  }

  return buildCandidate('glb', base, parsed.doc, {
    hasBinaryChunk: hasBin,
    binaryChunkByteLength: binaryLen,
    notes: [`glb-version=${version}`, ...base.notes]
  });
}

function probeGltfJson(bytes: Buffer, base: ReturnType<typeof emptyCounts>): GltfStructureReport {
  const text = bytes.toString('utf8');
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) {
    return unsupported('gltf-json', base, 'GLTF_JSON_MAGIC', 'glTF JSON must start with {');
  }
  const parsed = parseJsonDoc(text);
  if (!parsed.ok) {
    return unsupported('gltf-json', base, parsed.code, parsed.message);
  }
  return buildCandidate('gltf-json', base, parsed.doc, {
    hasBinaryChunk: false,
    binaryChunkByteLength: 0,
    notes: base.notes
  });
}

function parseJsonDoc(text: string):
  | { ok: true; doc: GltfJsonDoc }
  | { ok: false; code: string; message: string } {
  try {
    const doc = JSON.parse(text) as GltfJsonDoc;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, code: 'GLTF_JSON_ROOT', message: 'glTF root must be object' };
    }
    if (!doc.asset || typeof doc.asset !== 'object') {
      return { ok: false, code: 'GLTF_ASSET_MISSING', message: 'glTF asset object missing' };
    }
    const version = doc.asset.version;
    if (typeof version !== 'string' || !version.startsWith('2.')) {
      return { ok: false, code: 'GLTF_VERSION_UNSUPPORTED', message: `glTF asset.version unsupported: ${String(version)}` };
    }
    return { ok: true, doc };
  } catch (error) {
    return {
      ok: false,
      code: 'GLTF_JSON_PARSE',
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildCandidate(
  container: 'gltf-json' | 'glb',
  base: ReturnType<typeof emptyCounts>,
  doc: GltfJsonDoc,
  extras: { hasBinaryChunk: boolean; binaryChunkByteLength: number; notes: string[] }
): GltfStructureReport {
  const version = typeof doc.asset?.version === 'string' ? doc.asset.version : undefined;
  if (!version) {
    return unsupported(
      container,
      base,
      'GLTF_ASSET_VERSION_MISSING',
      'glTF asset.version is required'
    );
  }

  const generator = typeof doc.asset?.generator === 'string' ? doc.asset.generator : undefined;
  const meshCount = Array.isArray(doc.meshes) ? doc.meshes.length : 0;
  const materialCount = Array.isArray(doc.materials) ? doc.materials.length : 0;
  const nodeCount = Array.isArray(doc.nodes) ? doc.nodes.length : 0;
  const accessorCount = Array.isArray(doc.accessors) ? doc.accessors.length : 0;
  const bufferViewCount = Array.isArray(doc.bufferViews) ? doc.bufferViews.length : 0;
  const bufferCount = Array.isArray(doc.buffers) ? doc.buffers.length : 0;
  const imageCount = Array.isArray(doc.images) ? doc.images.length : 0;
  const animationCount = Array.isArray(doc.animations) ? doc.animations.length : 0;
  const sceneCount = Array.isArray(doc.scenes) ? doc.scenes.length : 0;

  // Cap name samples — structure probe only, not a full graph walk.
  const NAME_CAP = 64;
  const materialNames: string[] = [];
  if (Array.isArray(doc.materials)) {
    for (let i = 0; i < doc.materials.length && materialNames.length < NAME_CAP; i += 1) {
      const m = doc.materials[i];
      if (m && typeof m === 'object' && typeof (m as { name?: unknown }).name === 'string') {
        const n = ((m as { name: string }).name).trim();
        if (n) materialNames.push(n);
      }
    }
  }
  const nodeNames: string[] = [];
  if (Array.isArray(doc.nodes)) {
    for (let i = 0; i < doc.nodes.length && nodeNames.length < NAME_CAP; i += 1) {
      const n = doc.nodes[i];
      if (n && typeof n === 'object' && typeof (n as { name?: unknown }).name === 'string') {
        const name = ((n as { name: string }).name).trim();
        if (name) nodeNames.push(name);
      }
    }
  }

  const notes = [
    ...extras.notes,
    'authority=candidate',
    'no-native-flver-conversion',
    'structure-probe-only'
  ];

  const diagnostics: StructuredDiagnostic[] = [
    createDiagnostic({
      severity: 'info',
      code: 'GLTF_STRUCTURE_CANDIDATE',
      message: 'glTF/GLB structure probe candidate only; mesh/material native write unsupported',
      details: { meshCount, materialCount, nodeCount, imageCount, container }
    })
  ];

  if (meshCount === 0) {
    diagnostics.push(createDiagnostic({
      severity: 'warning',
      code: 'GLTF_NO_MESHES',
      message: 'glTF document contains zero meshes'
    }));
  }

  const report: GltfStructureReport = {
    ok: true,
    authority: 'candidate',
    container,
    meshCount,
    materialCount,
    nodeCount,
    accessorCount,
    bufferViewCount,
    bufferCount,
    imageCount,
    animationCount,
    sceneCount,
    hasBinaryChunk: extras.hasBinaryChunk,
    binaryChunkByteLength: extras.binaryChunkByteLength,
    materialNames,
    nodeNames,
    contentHash: base.contentHash,
    byteLength: base.byteLength,
    notes,
    diagnostics
  };
  if (version !== undefined) report.version = version;
  if (generator !== undefined) report.generator = generator;
  return report;
}
