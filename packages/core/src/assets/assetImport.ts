/**
 * Open-format asset import planner and staging writer.
 * Converts glTF/GLB/PNG/TGA/DDS descriptors into staging artifacts that later
 * feed PatchIR / native container replace. Does not write Mod overlay directly.
 *
 * Status honesty:
 * - staging + structural probes are real backend contracts
 * - texture intermediate conversion lives in openFormatConvert*
 * - FLVER/native mesh conversion remains unclaimed
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { probeGltfStructure, type GltfStructureReport } from './gltfStructureProbe.js';
import {
  checkTextureImportRules,
  type OpenFormatAdapterPack
} from './openFormatAdapterRules.js';
import { isDdsBuffer } from './pngToDds.js';

export type AssetImportFormat = 'gltf' | 'glb' | 'png' | 'tga' | 'dds';

export interface AssetImportRequest {
  sourcePath: string;
  sourceBytes?: Buffer;
  targetAssetUri: string;
  conversionRuleId: string;
  stagingRoot: string;
  expectedTargetHash?: string;
  /**
   * Optional game adapter pack. When provided, texture size/format rules are
   * enforced fail-closed before staging. Material/collision mapping is separate.
   */
  adapterPack?: OpenFormatAdapterPack;
}

export interface AssetImportPlan {
  importId: string;
  format: AssetImportFormat;
  sourcePath: string;
  targetAssetUri: string;
  conversionRuleId: string;
  stagingRelativePath: string;
  requiredValidators: string[];
  riskLevel: 'high';
  notes: string[];
}

export interface AssetImportStagingResult {
  ok: boolean;
  plan: AssetImportPlan;
  stagingPath: string;
  contentHash: string;
  byteLength: number;
  diagnostics: StructuredDiagnostic[];
  /** Descriptor consumed by later native conversion / PatchIR steps. */
  stagingManifest: {
    importId: string;
    format: AssetImportFormat;
    targetAssetUri: string;
    conversionRuleId: string;
    contentHash: string;
    byteLength: number;
    sourceFileName: string;
    structure?: GltfStructureReport;
    textureMeta?: {
      width?: number;
      height?: number;
      bpp?: number;
      imageType?: number;
    };
  };
}

const FORMAT_BY_EXT: Record<string, AssetImportFormat> = {
  '.gltf': 'gltf',
  '.glb': 'glb',
  '.png': 'png',
  '.tga': 'tga',
  '.dds': 'dds'
};

export function detectAssetImportFormat(filePath: string): AssetImportFormat | null {
  const ext = extname(filePath).toLowerCase();
  return FORMAT_BY_EXT[ext] ?? null;
}

export function planAssetImport(request: AssetImportRequest): {
  ok: boolean;
  plan?: AssetImportPlan;
  diagnostics: StructuredDiagnostic[];
} {
  const diagnostics: StructuredDiagnostic[] = [];
  const format = detectAssetImportFormat(request.sourcePath);
  if (!format) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'ASSET_IMPORT_FORMAT_UNSUPPORTED',
      message: 'only glTF/GLB/PNG/TGA/DDS import is supported',
      targetUri: request.targetAssetUri,
      details: { sourcePath: basename(request.sourcePath) }
    }));
    return { ok: false, diagnostics };
  }
  if (!request.conversionRuleId.trim()) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'ASSET_CONVERSION_RULE_REQUIRED',
      message: 'asset import requires a conversion rule id from the game adapter pack',
      targetUri: request.targetAssetUri
    }));
    return { ok: false, diagnostics };
  }
  if (!request.targetAssetUri.trim()) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'ASSET_TARGET_URI_REQUIRED',
      message: 'asset import requires a target native asset URI'
    }));
    return { ok: false, diagnostics };
  }

  const importId = randomUUID();
  const stagingRelativePath = join(
    'imports',
    importId.slice(0, 8),
    `${basename(request.sourcePath)}.staging.bin`
  );
  const plan: AssetImportPlan = {
    importId,
    format,
    sourcePath: request.sourcePath,
    targetAssetUri: request.targetAssetUri,
    conversionRuleId: request.conversionRuleId,
    stagingRelativePath,
    // Must match registered ValidatorContract.validatorId values
    // (see createScaffoldValidators / writeback validatorRequirements).
    requiredValidators: ['whole_file_replace', 'file_risk'],
    riskLevel: 'high',
    notes: [
      'open-format bytes are written to staging only',
      'native conversion and container writeback must go through Patch Engine',
      'texture intermediate conversion may emit uncompressed A8R8G8B8 DDS',
      'glTF/GLB mesh → FLVER remains unclaimed (structure probe only)'
    ]
  };
  return { ok: true, plan, diagnostics };
}

/**
 * Stage open-format bytes under stagingRoot. Never touches Mod overlay.
 */
export async function stageAssetImport(request: AssetImportRequest): Promise<AssetImportStagingResult> {
  const planned = planAssetImport(request);
  if (!planned.ok || !planned.plan) {
    const fallbackPlan: AssetImportPlan = {
      importId: randomUUID(),
      format: 'png',
      sourcePath: request.sourcePath,
      targetAssetUri: request.targetAssetUri,
      conversionRuleId: request.conversionRuleId,
      stagingRelativePath: '',
      requiredValidators: [],
      riskLevel: 'high',
      notes: []
    };
    return emptyFail(fallbackPlan, planned.diagnostics, request);
  }

  const diagnostics = [...planned.diagnostics];
  let bytes: Buffer;
  try {
    bytes = request.sourceBytes ?? await readFile(request.sourcePath);
  } catch (error) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'ASSET_IMPORT_READ_FAILED',
      message: error instanceof Error ? error.message : String(error),
      targetUri: request.targetAssetUri
    }));
    return emptyFail(planned.plan, diagnostics, request);
  }

  const magicError = validateMagic(planned.plan.format, bytes);
  if (magicError) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: magicError.code,
      message: magicError.message,
      targetUri: request.targetAssetUri
    }));
    return emptyFail(planned.plan, diagnostics, request);
  }

  let structure: GltfStructureReport | undefined;
  let textureMeta: AssetImportStagingResult['stagingManifest']['textureMeta'];

  if (planned.plan.format === 'glb' || planned.plan.format === 'gltf') {
    structure = probeGltfStructure(bytes, planned.plan.format);
    diagnostics.push(...structure.diagnostics);
    if (!structure.ok) {
      return emptyFail(planned.plan, diagnostics, request);
    }
  } else if (planned.plan.format === 'png') {
    // Lightweight IHDR peek for staging metadata (full decode is conversion-path).
    if (bytes.length >= 25 && bytes.subarray(12, 16).toString('ascii') === 'IHDR') {
      const bitDepth = bytes[24];
      textureMeta = {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        ...(typeof bitDepth === 'number' ? { bpp: bitDepth } : {})
      };
    }
  } else if (planned.plan.format === 'tga' && bytes.length >= 18) {
    const bpp = bytes[16];
    const imageType = bytes[2];
    textureMeta = {
      width: bytes.readUInt16LE(12),
      height: bytes.readUInt16LE(14),
      ...(typeof bpp === 'number' ? { bpp } : {}),
      ...(typeof imageType === 'number' ? { imageType } : {})
    };
  } else if (planned.plan.format === 'dds' && bytes.length >= 20) {
    textureMeta = {
      height: bytes.readUInt32LE(12),
      width: bytes.readUInt32LE(16)
    };
  }

  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const stagingPath = join(request.stagingRoot, planned.plan.stagingRelativePath);
  await mkdir(join(stagingPath, '..'), { recursive: true });
  await writeFile(stagingPath, bytes);

  const stagingManifest: AssetImportStagingResult['stagingManifest'] = {
    importId: planned.plan.importId,
    format: planned.plan.format,
    targetAssetUri: request.targetAssetUri,
    conversionRuleId: request.conversionRuleId,
    contentHash,
    byteLength: bytes.length,
    sourceFileName: basename(request.sourcePath),
    ...(structure ? { structure } : {}),
    ...(textureMeta ? { textureMeta } : {})
  };
  await writeFile(`${stagingPath}.manifest.json`, JSON.stringify(stagingManifest, null, 2), 'utf8');

  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'ASSET_IMPORT_STAGED',
    message: 'open-format asset staged; awaiting conversion and PatchIR commit',
    targetUri: request.targetAssetUri,
    details: {
      contentHash,
      format: planned.plan.format,
      structureAuthority: structure?.authority,
      textureMeta
    }
  }));

  return {
    ok: true,
    plan: planned.plan,
    stagingPath,
    contentHash,
    byteLength: bytes.length,
    diagnostics,
    stagingManifest
  };
}

function emptyFail(
  plan: AssetImportPlan,
  diagnostics: StructuredDiagnostic[],
  request: AssetImportRequest
): AssetImportStagingResult {
  return {
    ok: false,
    plan,
    stagingPath: '',
    contentHash: '',
    byteLength: 0,
    diagnostics,
    stagingManifest: {
      importId: plan.importId,
      format: plan.format,
      targetAssetUri: request.targetAssetUri,
      conversionRuleId: request.conversionRuleId,
      contentHash: '',
      byteLength: 0,
      sourceFileName: basename(request.sourcePath)
    }
  };
}

function validateMagic(format: AssetImportFormat, bytes: Buffer): { code: string; message: string } | null {
  if (bytes.length < 4) {
    return { code: 'ASSET_IMPORT_TOO_SMALL', message: 'import file too small' };
  }
  switch (format) {
    case 'png':
      if (bytes[0] !== 0x89 || bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
        return { code: 'ASSET_IMPORT_MAGIC_MISMATCH', message: 'PNG magic mismatch' };
      }
      return null;
    case 'glb': {
      if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'glTF') {
        return { code: 'ASSET_IMPORT_MAGIC_MISMATCH', message: 'GLB magic mismatch' };
      }
      const version = bytes.readUInt32LE(4);
      const totalLength = bytes.readUInt32LE(8);
      if (version !== 2) {
        return { code: 'ASSET_IMPORT_GLB_VERSION_UNSUPPORTED', message: 'only GLB version 2 is accepted as candidate' };
      }
      if (totalLength !== bytes.length) {
        return { code: 'ASSET_IMPORT_GLB_LENGTH_MISMATCH', message: 'GLB total length does not match file size' };
      }
      return null;
    }
    case 'gltf': {
      const head = bytes.subarray(0, Math.min(bytes.length, 64)).toString('utf8').trimStart();
      if (!(head.startsWith('{') || head.startsWith('['))) {
        return { code: 'ASSET_IMPORT_MAGIC_MISMATCH', message: 'glTF JSON must start with object/array' };
      }
      return null;
    }
    case 'dds':
      if (bytes.subarray(0, 4).toString('ascii') !== 'DDS ') {
        return { code: 'ASSET_IMPORT_MAGIC_MISMATCH', message: 'DDS magic mismatch' };
      }
      if (bytes.length < 128) {
        return { code: 'ASSET_IMPORT_TOO_SMALL', message: 'DDS header incomplete' };
      }
      return null;
    case 'tga': {
      if (bytes.length < 18) {
        return { code: 'ASSET_IMPORT_TOO_SMALL', message: 'TGA header incomplete' };
      }
      const imageType = bytes[2] ?? 0;
      const bpp = bytes[16] ?? 0;
      const width = bytes.readUInt16LE(12);
      const height = bytes.readUInt16LE(14);
      if (![0, 1, 2, 3, 9, 10, 11].includes(imageType)) {
        return { code: 'ASSET_IMPORT_TGA_TYPE_UNSUPPORTED', message: 'TGA image type unsupported for candidate import' };
      }
      if (![8, 16, 24, 32].includes(bpp)) {
        return { code: 'ASSET_IMPORT_TGA_BPP_UNSUPPORTED', message: 'TGA bits-per-pixel unsupported' };
      }
      if (width === 0 || height === 0 || width > 16384 || height > 16384) {
        return { code: 'ASSET_IMPORT_TGA_DIMENSION_INVALID', message: 'TGA dimensions invalid' };
      }
      return null;
    }
    default:
      return { code: 'ASSET_IMPORT_FORMAT_UNSUPPORTED', message: 'unsupported import format' };
  }
}
