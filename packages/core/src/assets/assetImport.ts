/**
 * Open-format asset import planner and staging writer.
 * Converts glTF/GLB/PNG/TGA/DDS descriptors into staging artifacts that later
 * feed PatchIR / native container replace. Does not write Mod overlay directly.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

export type AssetImportFormat = 'gltf' | 'glb' | 'png' | 'tga' | 'dds';

export interface AssetImportRequest {
  sourcePath: string;
  sourceBytes?: Buffer;
  targetAssetUri: string;
  conversionRuleId: string;
  stagingRoot: string;
  expectedTargetHash?: string;
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
      message: '仅支持 glTF/GLB/PNG/TGA/DDS 导入。',
      targetUri: request.targetAssetUri,
      details: { sourcePath: basename(request.sourcePath) }
    }));
    return { ok: false, diagnostics };
  }
  if (!request.conversionRuleId.trim()) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'ASSET_CONVERSION_RULE_REQUIRED',
      message: '资产导入需要游戏适配包转换规则 ID。',
      targetUri: request.targetAssetUri
    }));
    return { ok: false, diagnostics };
  }
  if (!request.targetAssetUri.trim()) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'ASSET_TARGET_URI_REQUIRED',
      message: '资产导入需要目标原生资产 URI。'
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
    requiredValidators: ['asset_import_manifest', 'file_risk'],
    riskLevel: 'high',
    notes: [
      '开放格式仅写入暂存区',
      '原生转换与容器写回必须经 Patch Engine',
      `format=${format}`
    ]
  };
  return { ok: true, plan, diagnostics };
}

/**
 * Stage import bytes under stagingRoot. Never writes to Mod overlay or base game.
 */
export async function stageAssetImport(request: AssetImportRequest): Promise<AssetImportStagingResult> {
  const planned = planAssetImport(request);
  if (!planned.ok || !planned.plan) {
    return {
      ok: false,
      plan: planned.plan ?? {
        importId: 'none',
        format: 'png',
        sourcePath: request.sourcePath,
        targetAssetUri: request.targetAssetUri,
        conversionRuleId: request.conversionRuleId,
        stagingRelativePath: '',
        requiredValidators: [],
        riskLevel: 'high',
        notes: []
      },
      stagingPath: '',
      contentHash: '',
      byteLength: 0,
      diagnostics: planned.diagnostics,
      stagingManifest: {
        importId: 'none',
        format: 'png',
        targetAssetUri: request.targetAssetUri,
        conversionRuleId: request.conversionRuleId,
        contentHash: '',
        byteLength: 0,
        sourceFileName: basename(request.sourcePath)
      }
    };
  }

  const diagnostics = [...planned.diagnostics];
  let bytes: Buffer;
  try {
    bytes = request.sourceBytes ?? await readFile(request.sourcePath);
  } catch (error) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'ASSET_IMPORT_READ_FAILED',
      message: error instanceof Error ? error.message : '读取导入文件失败。',
      targetUri: request.targetAssetUri
    }));
    return emptyFail(planned.plan, diagnostics, request);
  }

  // Minimal format magic checks — reject obvious mismatches without re-implementing full parsers.
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

  const stagingPath = join(request.stagingRoot, planned.plan.stagingRelativePath);
  await mkdir(join(stagingPath, '..'), { recursive: true });
  await writeFile(stagingPath, bytes);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const stagingManifest = {
    importId: planned.plan.importId,
    format: planned.plan.format,
    targetAssetUri: request.targetAssetUri,
    conversionRuleId: request.conversionRuleId,
    contentHash,
    byteLength: bytes.length,
    sourceFileName: basename(request.sourcePath)
  };
  await writeFile(`${stagingPath}.manifest.json`, JSON.stringify(stagingManifest, null, 2), 'utf8');

  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'ASSET_IMPORT_STAGED',
    message: '开放格式资产已写入暂存区，待原生转换与 PatchIR 提交。',
    targetUri: request.targetAssetUri,
    details: { contentHash, format: planned.plan.format }
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
    return { code: 'ASSET_IMPORT_TOO_SMALL', message: '导入文件过小。' };
  }
  switch (format) {
    case 'png':
      if (bytes[0] !== 0x89 || bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
        return { code: 'ASSET_IMPORT_MAGIC_MISMATCH', message: 'PNG 文件头不匹配。' };
      }
      return null;
    case 'glb':
      if (bytes.subarray(0, 4).toString('ascii') !== 'glTF') {
        return { code: 'ASSET_IMPORT_MAGIC_MISMATCH', message: 'GLB 文件头不匹配。' };
      }
      return null;
    case 'gltf': {
      const head = bytes.subarray(0, Math.min(bytes.length, 64)).toString('utf8').trimStart();
      if (!head.startsWith('{')) {
        return { code: 'ASSET_IMPORT_MAGIC_MISMATCH', message: 'glTF JSON 必须以 { 开头。' };
      }
      return null;
    }
    case 'dds':
      if (bytes.subarray(0, 4).toString('ascii') !== 'DDS ') {
        return { code: 'ASSET_IMPORT_MAGIC_MISMATCH', message: 'DDS 文件头不匹配。' };
      }
      return null;
    case 'tga':
      // TGA has no strong universal magic; accept bounded size only.
      if (bytes.length < 18) {
        return { code: 'ASSET_IMPORT_TOO_SMALL', message: 'TGA 文件过小。' };
      }
      return null;
    default:
      return { code: 'ASSET_IMPORT_FORMAT_UNSUPPORTED', message: '不支持的导入格式。' };
  }
}
