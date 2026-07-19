/**
 * Open-format → intermediate native-ish conversion planner/executor.
 * Texture path: PNG/TGA → RGBA8 → uncompressed A8R8G8B8 DDS.
 * Mesh path: glTF/GLB structure probe only (no FLVER writer).
 * Never writes Mod overlay directly — callers feed PatchIR writeback.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { probeGltfStructure, type GltfStructureReport } from './gltfStructureProbe.js';
import {
  decodeOpenFormatImage
} from './openFormatDecoders.js';
import {
  checkCollisionNodeMapping,
  checkMaterialMapping,
  checkTextureImportRules,
  type OpenFormatAdapterPack
} from './openFormatAdapterRules.js';
import { encodeRawRgba8ToDds, isDdsBuffer, type DdsEncodeResult } from './pngToDds.js';

export type OpenFormatSourceKind = 'png' | 'tga' | 'dds' | 'gltf' | 'glb';

export type OpenFormatConversionKind =
  | 'texture-rgba-to-dds'
  | 'texture-dds-passthrough'
  | 'mesh-structure-probe-only'
  | 'unsupported';

export type OpenFormatConversionAuthority =
  | 'native-verified'
  | 'candidate'
  | 'partial'
  | 'unsupported';

export interface OpenFormatConvertRequest {
  sourcePath: string;
  sourceBytes?: Buffer;
  sourceKind?: OpenFormatSourceKind;
  targetAssetUri: string;
  conversionRuleId: string;
  stagingRoot: string;
  /**
   * Optional game adapter pack. When provided, texture size/format rules are
   * enforced fail-closed before DDS encode / passthrough staging.
   */
  adapterPack?: OpenFormatAdapterPack;
}

export interface OpenFormatConvertPlan {
  conversionId: string;
  sourceKind: OpenFormatSourceKind;
  conversionKind: OpenFormatConversionKind;
  authority: OpenFormatConversionAuthority;
  sourcePath: string;
  targetAssetUri: string;
  conversionRuleId: string;
  stagingRelativePath: string;
  requiredValidators: string[];
  riskLevel: 'high';
  notes: string[];
}

export interface OpenFormatConvertResult {
  ok: boolean;
  plan: OpenFormatConvertPlan;
  stagingPath: string;
  contentHash: string;
  byteLength: number;
  /** Present for texture conversion success. */
  dds?: {
    width: number;
    height: number;
    format: 'A8R8G8B8';
    contentHash: string;
  };
  /** Present for glTF/GLB structure probe path. */
  gltf?: Pick<
    GltfStructureReport,
    | 'authority'
    | 'container'
    | 'version'
    | 'generator'
    | 'meshCount'
    | 'materialCount'
    | 'nodeCount'
    | 'imageCount'
    | 'hasBinaryChunk'
    | 'binaryChunkByteLength'
    | 'notes'
  >;
  diagnostics: StructuredDiagnostic[];
}

/**
 * Convert an open-format source into a staged intermediate artifact.
 * Texture success path produces real DDS bytes. Mesh path stages structure report JSON only.
 */
export async function convertOpenFormatAsset(
  request: OpenFormatConvertRequest
): Promise<OpenFormatConvertResult> {
  const sourceKind = request.sourceKind ?? inferSourceKind(request.sourcePath);
  if (!sourceKind) {
    return failPlan(request, 'png', 'unsupported', 'unsupported', [
      diag('error', 'OPEN_FORMAT_SOURCE_KIND_UNKNOWN', 'unable to infer open-format source kind from path')
    ]);
  }

  let bytes: Buffer;
  try {
    bytes = request.sourceBytes ?? (await readFile(request.sourcePath));
  } catch (error) {
    return failPlan(request, sourceKind, 'unsupported', 'unsupported', [
      diag('error', 'OPEN_FORMAT_SOURCE_READ_FAILED', error instanceof Error ? error.message : String(error))
    ]);
  }

  if (sourceKind === 'png' || sourceKind === 'tga') {
    return convertTextureToDds(request, sourceKind, bytes);
  }
  if (sourceKind === 'dds') {
    return passthroughDds(request, bytes);
  }
  if (sourceKind === 'gltf' || sourceKind === 'glb') {
    return probeAndStageGltf(request, sourceKind, bytes);
  }

  return failPlan(request, sourceKind, 'unsupported', 'unsupported', [
    diag('error', 'OPEN_FORMAT_SOURCE_UNSUPPORTED', `source kind unsupported: ${sourceKind}`)
  ]);
}

async function convertTextureToDds(
  request: OpenFormatConvertRequest,
  sourceKind: 'png' | 'tga',
  bytes: Buffer
): Promise<OpenFormatConvertResult> {
  const decoded = decodeOpenFormatImage(sourceKind, bytes);
  if (!decoded.ok || !decoded.image) {
    return failPlan(request, sourceKind, 'texture-rgba-to-dds', 'unsupported', [
      diag(
        'error',
        decoded.code ?? 'OPEN_FORMAT_DECODE_FAILED',
        decoded.message ?? 'open-format image decode failed',
        { notes: decoded.notes }
      )
    ]);
  }

  // Optional adapter pack: fail-closed texture size/format gate before encode.
  const adapterDiagnostics: StructuredDiagnostic[] = [];
  let matchedTextureRuleId: string | undefined;
  if (request.adapterPack) {
    const gate = checkTextureImportRules(request.adapterPack, {
      sourceKind,
      width: decoded.image.width,
      height: decoded.image.height
    });
    adapterDiagnostics.push(...gate.diagnostics);
    if (!gate.ok) {
      return failPlan(request, sourceKind, 'texture-rgba-to-dds', 'unsupported', [
        ...adapterDiagnostics,
        diag(
          'error',
          'OPEN_FORMAT_ADAPTER_TEXTURE_REJECTED',
          'adapter pack rejected texture before DDS encode',
          {
            packId: gate.packId,
            width: decoded.image.width,
            height: decoded.image.height
          }
        )
      ]);
    }
    matchedTextureRuleId = gate.matchedRuleId;
  }

  let encoded: DdsEncodeResult;
  try {
    encoded = encodeRawRgba8ToDds(decoded.image);
  } catch (error) {
    return failPlan(request, sourceKind, 'texture-rgba-to-dds', 'unsupported', [
      diag('error', 'OPEN_FORMAT_DDS_ENCODE_FAILED', error instanceof Error ? error.message : String(error))
    ]);
  }

  const conversionId = randomUUID();
  const stagingRelativePath = join(
    'open-format-convert',
    conversionId,
    `${safeBase(request.sourcePath)}.dds`
  );
  const stagingPath = join(request.stagingRoot, stagingRelativePath);
  await mkdir(join(request.stagingRoot, 'open-format-convert', conversionId), { recursive: true });
  await writeFile(stagingPath, encoded.dds);

  const plan: OpenFormatConvertPlan = {
    conversionId,
    sourceKind,
    conversionKind: 'texture-rgba-to-dds',
    authority: 'candidate',
    sourcePath: request.sourcePath,
    targetAssetUri: request.targetAssetUri,
    conversionRuleId: request.conversionRuleId,
    stagingRelativePath: stagingRelativePath.replace(/\\/g, '/'),
    // Must match registered ValidatorContract.validatorId values used by writeback.
    requiredValidators: ['whole_file_replace', 'file_risk'],
    riskLevel: 'high',
    notes: [
      ...decoded.notes,
      'conversion=rgba8-to-a8r8g8b8-dds',
      'authority=candidate',
      'no-bc-compression',
      'no-mipmaps',
      'no-mod-overlay-write-in-convert',
      'writeback-validators=whole_file_replace+file_risk',
      ...(matchedTextureRuleId ? [`adapterTextureRule=${matchedTextureRuleId}`] : [])
    ]
  };

  await writeFile(
    `${stagingPath}.manifest.json`,
    JSON.stringify({
      conversionId,
      sourceKind,
      conversionKind: plan.conversionKind,
      authority: plan.authority,
      targetAssetUri: request.targetAssetUri,
      conversionRuleId: request.conversionRuleId,
      contentHash: encoded.contentHash,
      byteLength: encoded.dds.length,
      width: encoded.width,
      height: encoded.height,
      format: encoded.format,
      sourceFileName: basename(request.sourcePath),
      adapterPackId: request.adapterPack?.packId ?? null,
      matchedTextureRuleId: matchedTextureRuleId ?? null
    }, null, 2),
    'utf8'
  );

  return {
    ok: true,
    plan,
    stagingPath,
    contentHash: encoded.contentHash,
    byteLength: encoded.dds.length,
    dds: {
      width: encoded.width,
      height: encoded.height,
      format: encoded.format,
      contentHash: encoded.contentHash
    },
    diagnostics: [
      ...adapterDiagnostics,
      diag('info', 'OPEN_FORMAT_TEXTURE_CONVERTED', 'open-format texture decoded and encoded to uncompressed DDS', {
        width: encoded.width,
        height: encoded.height,
        format: encoded.format,
        matchedTextureRuleId: matchedTextureRuleId ?? null
      })
    ]
  };
}

async function passthroughDds(
  request: OpenFormatConvertRequest,
  bytes: Buffer
): Promise<OpenFormatConvertResult> {
  if (!isDdsBuffer(bytes)) {
    return failPlan(request, 'dds', 'texture-dds-passthrough', 'unsupported', [
      diag('error', 'OPEN_FORMAT_DDS_MAGIC', 'DDS magic/header invalid for passthrough')
    ]);
  }
  const height = bytes.readUInt32LE(12);
  const width = bytes.readUInt32LE(16);

  const adapterDiagnostics: StructuredDiagnostic[] = [];
  let matchedTextureRuleId: string | undefined;
  if (request.adapterPack) {
    const gate = checkTextureImportRules(request.adapterPack, {
      sourceKind: 'dds',
      width,
      height
    });
    adapterDiagnostics.push(...gate.diagnostics);
    if (!gate.ok) {
      return failPlan(request, 'dds', 'texture-dds-passthrough', 'unsupported', adapterDiagnostics);
    }
    matchedTextureRuleId = gate.matchedRuleId;
  }

  const conversionId = randomUUID();
  const stagingRelativePath = join(
    'open-format-convert',
    conversionId,
    `${safeBase(request.sourcePath)}.dds`
  );
  const stagingPath = join(request.stagingRoot, stagingRelativePath);
  await mkdir(join(request.stagingRoot, 'open-format-convert', conversionId), { recursive: true });
  await writeFile(stagingPath, bytes);
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  const plan: OpenFormatConvertPlan = {
    conversionId,
    sourceKind: 'dds',
    conversionKind: 'texture-dds-passthrough',
    authority: 'candidate',
    sourcePath: request.sourcePath,
    targetAssetUri: request.targetAssetUri,
    conversionRuleId: request.conversionRuleId,
    stagingRelativePath: stagingRelativePath.replace(/\\/g, '/'),
    // Must match registered ValidatorContract.validatorId values used by writeback.
    requiredValidators: ['whole_file_replace', 'file_risk'],
    riskLevel: 'high',
    notes: [
      'conversion=dds-passthrough',
      'authority=candidate',
      'no-reencode',
      'no-mod-overlay-write-in-convert',
      'writeback-validators=whole_file_replace+file_risk',
      ...(matchedTextureRuleId
        ? [`adapterPack=${request.adapterPack!.packId}`, `textureRule=${matchedTextureRuleId}`]
        : request.adapterPack
          ? [`adapterPack=${request.adapterPack.packId}`]
          : ['adapterPack=none'])
    ]
  };

  return {
    ok: true,
    plan,
    stagingPath,
    contentHash,
    byteLength: bytes.length,
    dds: {
      width,
      height,
      format: 'A8R8G8B8',
      contentHash
    },
    diagnostics: [
      ...adapterDiagnostics,
      diag('info', 'OPEN_FORMAT_DDS_PASSTHROUGH', 'DDS bytes staged without re-encode', {
        width,
        height,
        matchedTextureRuleId: matchedTextureRuleId ?? null
      })
    ]
  };
}

async function probeAndStageGltf(
  request: OpenFormatConvertRequest,
  sourceKind: 'gltf' | 'glb',
  bytes: Buffer
): Promise<OpenFormatConvertResult> {
  const report = probeGltfStructure(bytes, sourceKind);
  // structure.ok is the sole gate for candidate mesh probes (not authority alone).
  if (!report.ok) {
    return failPlan(
      request,
      sourceKind,
      'mesh-structure-probe-only',
      'unsupported',
      [
        ...report.diagnostics,
        diag(
          'error',
          'OPEN_FORMAT_GLTF_STRUCTURE_REJECTED',
          'glTF/GLB structure probe rejected source; mesh path stays structure-only and non-writable',
          {
            authority: report.authority,
            meshCount: report.meshCount,
            notes: report.notes
          }
        )
      ]
    );
  }

  // Optional adapter pack: material/collision name rules are fail-closed.
  // Structure remains non-writable even when every name maps.
  const adapterDiagnostics: StructuredDiagnostic[] = [];
  const adapterNotes: string[] = [];
  if (request.adapterPack) {
    const pack = request.adapterPack;
    adapterNotes.push(`adapterPack=${pack.packId}`);
    for (const materialName of report.materialNames) {
      const mat = checkMaterialMapping(pack, { materialName });
      adapterDiagnostics.push(...mat.diagnostics);
      if (!mat.ok) {
        return failPlan(
          request,
          sourceKind,
          'mesh-structure-probe-only',
          'unsupported',
          [
            ...report.diagnostics,
            ...adapterDiagnostics,
            diag(
              'error',
              'OPEN_FORMAT_ADAPTER_MATERIAL_GATE',
              `adapter pack rejected glTF material "${materialName}" (fail-closed)`,
              { packId: pack.packId, materialName }
            )
          ]
        );
      }
      if (mat.matchedRuleId) {
        adapterNotes.push(`materialRule=${mat.matchedRuleId}`);
      }
    }
    for (const nodeName of report.nodeNames) {
      // Only enforce collision mapping for nodes that look like collision markers.
      // Ordinary mesh nodes stay unmapped without failing the structure probe.
      const lower = nodeName.toLowerCase();
      const looksCollision =
        lower.startsWith('hkt_')
        || lower.startsWith('col_')
        || lower.startsWith('hk_')
        || lower.startsWith('n_col_')
        || lower.endsWith('_col')
        || lower.includes('collision')
        || lower.includes('collider')
        || lower.includes('hitbox');
      if (!looksCollision) continue;
      const col = checkCollisionNodeMapping(pack, { nodeName });
      adapterDiagnostics.push(...col.diagnostics);
      if (!col.ok) {
        return failPlan(
          request,
          sourceKind,
          'mesh-structure-probe-only',
          'unsupported',
          [
            ...report.diagnostics,
            ...adapterDiagnostics,
            diag(
              'error',
              'OPEN_FORMAT_ADAPTER_COLLISION_GATE',
              `adapter pack rejected collision node "${nodeName}" (fail-closed)`,
              { packId: pack.packId, nodeName }
            )
          ]
        );
      }
      if (col.matchedRuleId) {
        adapterNotes.push(`collisionRule=${col.matchedRuleId}`);
      }
    }
  }

  const conversionId = randomUUID();
  const stagingRelativePath = join(
    'open-format-convert',
    conversionId,
    `${safeBase(request.sourcePath)}.structure.json`
  );
  const stagingPath = join(request.stagingRoot, stagingRelativePath);
  await mkdir(join(request.stagingRoot, 'open-format-convert', conversionId), { recursive: true });

  const payload = {
    authority: report.authority,
    structureOk: report.ok,
    container: report.container,
    version: report.version,
    generator: report.generator,
    meshCount: report.meshCount,
    materialCount: report.materialCount,
    nodeCount: report.nodeCount,
    accessorCount: report.accessorCount,
    bufferViewCount: report.bufferViewCount,
    bufferCount: report.bufferCount,
    imageCount: report.imageCount,
    animationCount: report.animationCount,
    sceneCount: report.sceneCount,
    hasBinaryChunk: report.hasBinaryChunk,
    binaryChunkByteLength: report.binaryChunkByteLength,
    contentHash: report.contentHash,
    byteLength: report.byteLength,
    notes: report.notes,
    conversionKind: 'mesh-structure-probe-only',
    nativeFlverWriter: false
  };
  const json = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  await writeFile(stagingPath, json);
  const contentHash = createHash('sha256').update(json).digest('hex');

  const plan: OpenFormatConvertPlan = {
    conversionId,
    sourceKind,
    conversionKind: 'mesh-structure-probe-only',
    authority: 'candidate',
    sourcePath: request.sourcePath,
    targetAssetUri: request.targetAssetUri,
    conversionRuleId: request.conversionRuleId,
    stagingRelativePath: stagingRelativePath.replace(/\\/g, '/'),
    // Mesh path is structure-only and blocked from writeback; no write validators claimed.
    // Keep empty so plan ids never invent unregistered validator names.
    requiredValidators: [],
    riskLevel: 'high',
    notes: [
      ...report.notes,
      ...adapterNotes,
      'mesh-path=structure-probe-only',
      'structure.ok=true',
      'no-flver-writer',
      'no-mod-overlay-write-in-convert',
      'writeback-blocked=OPEN_FORMAT_WRITEBACK_STRUCTURE_ONLY'
    ]
  };

  const gltfSummary: NonNullable<OpenFormatConvertResult['gltf']> = {
    authority: report.authority,
    container: report.container,
    meshCount: report.meshCount,
    materialCount: report.materialCount,
    nodeCount: report.nodeCount,
    imageCount: report.imageCount,
    hasBinaryChunk: report.hasBinaryChunk,
    binaryChunkByteLength: report.binaryChunkByteLength,
    notes: report.notes
  };
  if (report.version !== undefined) gltfSummary.version = report.version;
  if (report.generator !== undefined) gltfSummary.generator = report.generator;

  return {
    ok: true,
    plan,
    stagingPath,
    contentHash,
    byteLength: json.length,
    gltf: gltfSummary,
    diagnostics: [...report.diagnostics, ...adapterDiagnostics]
  };
}

function failPlan(
  request: OpenFormatConvertRequest,
  sourceKind: OpenFormatSourceKind,
  conversionKind: OpenFormatConversionKind,
  authority: OpenFormatConversionAuthority,
  diagnostics: StructuredDiagnostic[]
): OpenFormatConvertResult {
  return {
    ok: false,
    plan: {
      conversionId: randomUUID(),
      sourceKind,
      conversionKind,
      authority,
      sourcePath: request.sourcePath,
      targetAssetUri: request.targetAssetUri,
      conversionRuleId: request.conversionRuleId,
      stagingRelativePath: '',
      requiredValidators: [],
      riskLevel: 'high',
      notes: ['conversion-failed']
    },
    stagingPath: '',
    contentHash: '',
    byteLength: 0,
    diagnostics
  };
}

function inferSourceKind(sourcePath: string): OpenFormatSourceKind | null {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.tga') return 'tga';
  if (ext === '.dds') return 'dds';
  if (ext === '.gltf') return 'gltf';
  if (ext === '.glb') return 'glb';
  return null;
}

function safeBase(sourcePath: string): string {
  return basename(sourcePath).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'source';
}

function diag(
  severity: StructuredDiagnostic['severity'],
  code: string,
  message: string,
  details?: unknown
): StructuredDiagnostic {
  return createDiagnostic({
    severity,
    code,
    message,
    ...(details !== undefined ? { details } : {})
  });
}
