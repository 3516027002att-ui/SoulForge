import { existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { isParamBackupPath, runBridge, type WorkspaceSession } from '@soulforge/core';
import type { Diagnostic, GparamDocument, IndexedFile } from '@soulforge/shared';
import { sanitizeRendererValue } from '../rendererDto.js';

export interface AssetReadServiceDeps {
  readonly indexedFiles: readonly IndexedFile[];
  readonly activeSession: WorkspaceSession | null;
  verifiedReadRoots(session: WorkspaceSession | null, fallback: string): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  resolveFlverReadFile(sourceUri: string): { absolutePath: string; relativePath: string } | null;
}

function flverTexturePackagePaths(modelPath: string): string[] {
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    if (!existsSync(candidate)) return;
    if (!candidates.some((path) => path.toLowerCase() === candidate.toLowerCase())) {
      candidates.push(candidate);
    }
  };
  const lower = modelPath.toLowerCase();
  let stem: string | null = null;
  if (lower.endsWith('.flver.dcx')) stem = modelPath.slice(0, -'.flver.dcx'.length);
  else if (lower.endsWith('.flver')) stem = modelPath.slice(0, -'.flver'.length);
  if (stem) {
    add(`${stem}.texbnd.dcx`);
    add(`${stem}.texbnd`);
    add(`${stem}.tpf.dcx`);
    add(`${stem}.tpf`);
  }
  if (basename(dirname(modelPath)).toLowerCase() === 'parts') {
    add(join(dirname(modelPath), 'common_body.tpf.dcx'));
    add(join(dirname(modelPath), 'common_body.tpf'));
  }
  return candidates;
}

/** Native asset reads expose bounded logical projections; Bridge retains parsing authority. */
export function createAssetReadService(deps: AssetReadServiceDeps) {
  const readFlverDocument = async (
    sourceUri: string
  ) => {
    const file = deps.resolveFlverReadFile(sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readTpfDocument = async (
    sourceUri: string
  ) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TPF。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-tpf-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readTpfTexturePreview = async (
    sourceUri: string,
    textureIndex: number
  ) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TPF 纹理预览。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-tpf-texture-preview',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      commandOptions: { textureIndex }
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readFlverMesh = async (
    sourceUri: string,
    meshIndex: number
  ) => {
    const file = deps.resolveFlverReadFile(sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 网格。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-mesh',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      commandOptions: {
        meshIndex,
        maxVertices: 1_000_000,
        maxIndices: 3_000_000,
        texturePackagePaths: flverTexturePackagePaths(file.absolutePath)
      }
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readFlverSkeleton = async (
    sourceUri: string
  ) => {
    const file = deps.resolveFlverReadFile(sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 骨骼层级。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-skeleton',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readFlverDummies = async (
    sourceUri: string
  ) => {
    const file = deps.resolveFlverReadFile(sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 挂点。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-dummies',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readFlverTextureSlots = async (
    sourceUri: string
  ) => {
    const file = deps.resolveFlverReadFile(sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 纹理槽位。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-texture-slots',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readEsdDocument = async (
    sourceUri: string
  ) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 ESD。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-esd-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readMtdDocument = async (
    sourceUri: string
  ) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 MTD。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-mtd-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readFxrDocument = async (
    sourceUri: string,
    entryName?: string
  ) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FXR。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const selectedName = typeof entryName === 'string' && entryName.trim() ? entryName.trim() : undefined;
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-fxr-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      // S24：ffxbnd 效果库按子项名精确读取；缺省取容器内第一条 .fxr。
      ...(selectedName ? { commandOptions: { entryName: selectedName } } : {}),
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const listFxrEntries = async (
    sourceUri: string
  ) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法列出 FXR 条目。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<{ entries?: string[] }>({
      command: 'list-ffxbnd-entries',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  };

  const readGparamDocument = async (
    sourceUri: string
  ) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 GPARAM。',
          sourceUri
        }]
      };
    }
    if (isParamBackupPath(file.relativePath)) {
      return {
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        data: null,
        diagnostics: [{
          severity: 'error' as const,
          code: 'BACKUP_READ_FORBIDDEN',
          message: '备份文件只能在“历史与恢复”中只读查看，不能作为 GPARAM 文档读取。',
          sourceUri
        }]
      };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) {
      return sanitizeRendererValue({
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        data: null,
        diagnostics: roots.diagnostics
      });
    }
    const gameRoot = deps.activeSession?.layers.baseRoot;
    const result = await runBridge<GparamDocument>({
      command: 'read-gparam-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {}),
      timeoutMs: 120_000,
      // 显式空 options：与 readParamDocument 同一范式，规避缺省 JsonElement 的分页缺陷。
      commandOptions: {}
    });
    if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
      // P2 裁定：Oodle/KRAK 解压类失败必须给可行动的结构化诊断。Bridge 在这类
      // 失败下可能带出含本机绝对路径的消息（如 IOException 的路径），经过
      // sanitizeRendererValue 后会整条塌成「本机路径已隐藏」，GROUPS 栏就剩一句
      // 不可行动的话。这里在 sanitize 之前把命中 Oodle/KRAK/解压的诊断替换成
      // 不含路径、只讲下一步动作的文案。
      const isOodleOrKrakFailure = result.diagnostics.some((d) =>
        /^(GPARAM_GAME_UNSUPPORTED|OODLE_)/i.test(d.code)
        || /Oodle|KRAK|解压/i.test(d.code)
        || /Oodle|KRAK|解压/i.test(d.message)
      );
      const diagnostics = isOodleOrKrakFailure
        ? [{
            severity: 'error' as const,
            code: 'GPARAM_KRAK_OODLE_REQUIRED',
            message: 'GPARAM 读取失败：该 bank 为 KRAK 压缩，需要挂载只读原版游戏目录'
              + '（左侧「选择原版目录」指向含 sekiro.exe 的目录）后才能解压读取。',
            sourceUri
          }]
        : result.diagnostics;
      return sanitizeRendererValue({
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        data: null,
        diagnostics
      });
    }
    return sanitizeRendererValue({
      ok: true,
      sourceUri,
      relativePath: file.relativePath,
      data: {
        format: result.data.format,
        game: result.data.game,
        groupCount: result.data.groupCount,
        sourceHash: result.data.sourceHash,
        sourceSize: result.data.sourceSize,
        groups: result.data.groups,
        groupPage: result.data.groupPage,
        groupPageSize: result.data.groupPageSize,
        groupPageCount: result.data.groupPageCount,
        groupsTruncated: result.data.groupsTruncated,
        roundTrip: result.data.roundTrip,
        authority: result.data.authority
      },
      diagnostics: result.diagnostics
    });
  };

return Object.freeze({ readFlverDocument, readTpfDocument, readTpfTexturePreview, readFlverMesh, readFlverSkeleton, readFlverDummies, readFlverTextureSlots, readEsdDocument, readMtdDocument, readFxrDocument, listFxrEntries, readGparamDocument });
}
export type AssetReadService = ReturnType<typeof createAssetReadService>;
