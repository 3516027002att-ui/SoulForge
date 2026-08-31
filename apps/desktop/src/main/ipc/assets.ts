import { existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import {
  applyNativeMutation,
  commitFlverMutationViaBridge,
  commitTpfTextureReplaceViaBridge,
  commitGparamMutationsViaBridge,
  commitMtdPropertySetViaBridge,
  commitEsdTransitionViaBridge,
  commitTaeEventViaBridge,
  commitVfxFieldSetViaBridge,
  isParamBackupPath,
  runBridge,
  type EsdTransitionMutation,
  type GparamFieldSetMutation,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type TaeEventUpsertMutation,
  type VfxFieldSetMutation,
  type WorkspaceSession,
  type WriteConfirmationPort
} from '@soulforge/core';
import type { Diagnostic, GparamDocument, IndexedFile } from '@soulforge/shared';
import { sanitizeRendererValue, type RendererSaveResult } from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { TrustedIpcHandle } from './registration.js';

export interface AssetIpcDeps {
  handle: TrustedIpcHandle;
  get indexedFiles(): readonly IndexedFile[];
  get activeSession(): WorkspaceSession | null;
  verifiedReadRoots(session: WorkspaceSession | null, fallback: string): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  verifiedStageRoots(session: WorkspaceSession, storage: { root: string }, code: string): Promise<{ allowedRoots: string[]; writableRoots: string[]; diagnostics: Diagnostic[] }>;
  durableStoragePaths(workspaceId: string): { root: string; backupBaseDir: string; recoveryDir: string; stagingRoot: string };
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  sessionCommitPort(session: WorkspaceSession, operationLog: OperationLogUtilityClient, storage: { backupBaseDir: string; recoveryDir: string }): RawReplaceCommitPort;
  electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort;
  toSaveResultFromOutcome(outcome: NativeMutationOutcome, files: readonly IndexedFile[]): RendererSaveResult;
  resolveFlverReadFile(sourceUri: string): { absolutePath: string; relativePath: string } | null;
}

/**
 * FLVER 本身通常不携带可直接显示的纹理像素。纹理候选只能由 main 根据
 * 已解析的真实路径派生，再经过 Bridge allowed roots 校验；renderer 不接触
 * 本机路径，也不按文件名在浏览器里猜纹理。
 */
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

export function registerAssetIpcHandlers(deps: AssetIpcDeps): void {
deps.handle('resource.readFlverDocument', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.readTpfDocument', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.readTpfTexturePreview', async (_event, sourceUri: string, textureIndex: number) => {
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
  });

  deps.handle('resource.readFlverMesh', async (_event, sourceUri: string, meshIndex: number) => {
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
  });

  deps.handle('resource.readFlverSkeleton', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.readFlverDummies', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.readFlverTextureSlots', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.readEsdDocument', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.readMtdDocument', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.readFxrDocument', async (_event, sourceUri: string, entryName?: string) => {
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
  });

  /**
   * S24：ffxbnd 效果库的 .fxr 子项清单。一条失败不再整包判死——左栏逐条列出，
   * 每条独立打开，失败只红那一条。
   */
  deps.handle('resource.listFxrEntries', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.readGparamDocument', async (_event, sourceUri: string) => {
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
          message: 'backup 文件只能在 History & Recovery 中以只读方式查看，不能作为 GPARAM 文档读取。',
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
  });

  deps.handle(
    'resource.applyFlverMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: {
        kind: 'material-slot-set';
        meshStableId: string;
        slotIndex: number;
        materialStableId: string;
      }
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FLVER_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 FLVER。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      // S38 开闸：write-flver material-slot-set 经 applyNativeMutation → Patch
      // Engine 提交（editorCapabilityContract flver 块已翻 releaseWriteEnabled）。
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'FLVER_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'flver',
        stagingFileName: `${basename(file.relativePath)}.mut.flver`,
        stageWrite: (context) => commitFlverMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation
        }),
        title: `FLVER mutation ${mutation.kind} ${mutation.meshStableId}`,
        confirmActionLabel: '提交 FLVER 变更'
      }, {
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    }
  );

  deps.handle('resource.saveTpfTextureReplace', async (
    event,
    sourceUri: string,
    expectedHash: string,
    textureIndex: number,
    newTextureBase64: string
  ): Promise<RendererSaveResult> => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file || !deps.activeSession) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'TPF_WRITE_NO_SESSION',
          message: '需要已打开的工作区才能写入 TPF。',
          sourceUri
        }]
      };
    }
    const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
    if (gameBlocked) return gameBlocked;
    const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
    // ROOT-07：stage 前 mkdir → realpath → boundary check；回调同步返回
    // 已验证集合（stageBridgeOutput 的 mkdir 幂等）。
    const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'TPF_STAGING_PREPARE_FAILED');
    if (stage.diagnostics.length > 0) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: stage.diagnostics
      };
    }
    const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
    const outcome = await applyNativeMutation({
      file,
      sourceUri,
      expectedHash,
      stagingRoot: storage.stagingRoot,
      allowedRoots: () => [...stage.allowedRoots],
      stagingPrefix: 'tpf',
      stagingFileName: `${basename(file.relativePath)}.mut.tpf`,
      stageWrite: (context) => commitTpfTextureReplaceViaBridge({
        sourcePath: file.absolutePath,
        outputPath: context.outputPath,
        expectedDocumentHash: expectedHash,
        allowedRoots: context.allowedRoots,
        writableRoots: context.writableRoots,
        replace: { textureIndex, newTextureBase64 }
      }),
      title: `TPF texture replace #${textureIndex}`,
      confirmActionLabel: '替换 TPF 纹理'
    }, {
      confirm: deps.electronConfirmationPort(event),
      commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
    });
    return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
  });

  deps.handle(
    'resource.commitGparamMutations',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      mutations: GparamFieldSetMutation[]
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'GPARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 GPARAM。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: 'backup 文件只能在 History & Recovery 中以只读方式查看，不能写入 GPARAM。',
            sourceUri
          }]
        };
      }
      if (!Array.isArray(mutations) || mutations.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'GPARAM_MUTATIONS_REQUIRED',
            message: 'GPARAM typed write 需要至少一条 mutation；没有 typed 定位就没有写入口。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'GPARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const gameRoot = deps.activeSession.layers.baseRoot;
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'gparam',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitGparamMutationsViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutations,
          ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
        }),
        title: `GPARAM field-set ${mutations.length} mutations`,
        confirmActionLabel: '提交 GPARAM 字段变更'
      }, {
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    }
  );

  deps.handle(
    'resource.commitMtdPropertySet',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      set: { paramId: string; newValue?: string }
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MTD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 MTD。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: 'backup 文件只能在 History & Recovery 中以只读方式查看，不能写入 MTD。',
            sourceUri
          }]
        };
      }
      if (!set || typeof set.paramId !== 'string' || set.paramId.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MTD_PROPERTY_SET_REQUIRED',
            message: 'MTD typed write 需要 paramId + newValue；没有 typed 定位就没有写入口。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'MTD_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const gameRoot = deps.activeSession.layers.baseRoot;
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'mtd',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitMtdPropertySetViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          set: { paramId: set.paramId, newValue: set.newValue ?? '' },
          ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
        }),
        title: `MTD property ${set.paramId}`,
        confirmActionLabel: '提交 MTD 材质属性变更'
      }, {
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    }
  );

  deps.handle(
    'resource.commitEsdTransition',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      mutations: EsdTransitionMutation[]
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'ESD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 ESD。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: 'backup 文件只能在 History & Recovery 中以只读方式查看，不能写入 ESD。',
            sourceUri
          }]
        };
      }
      if (!Array.isArray(mutations) || mutations.length === 0
        || !mutations.every((m) => m && typeof m.mutation === 'string')) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'ESD_TRANSITION_MUTATIONS_REQUIRED',
            message: 'ESD typed write 需要至少一条 transition mutation（behavior-transition-upsert）。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'ESD_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'esd',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitEsdTransitionViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutations
        }),
        title: `ESD transition upsert × ${mutations.length}`,
        confirmActionLabel: '提交 ESD 状态转移变更'
      }, {
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    }
  );

  deps.handle(
    'resource.commitTaeEvent',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      mutations: TaeEventUpsertMutation[]
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'TAE_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 TAE。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: 'backup 文件只能在 History & Recovery 中以只读方式查看，不能写入 TAE。',
            sourceUri
          }]
        };
      }
      if (!Array.isArray(mutations) || mutations.length === 0
        || !mutations.every((m) => m && typeof m.mutation === 'string')) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'TAE_EVENT_MUTATIONS_REQUIRED',
            message: 'TAE typed write 需要至少一条 event upsert mutation（tae-event-upsert）。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'TAE_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'tae',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitTaeEventViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutations
        }),
        title: `TAE event upsert × ${mutations.length}`,
        confirmActionLabel: '提交 TAE 事件变更'
      }, {
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    }
  );

  deps.handle(
    'resource.commitFxrFieldSet',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      mutations: VfxFieldSetMutation[]
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FXR_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 FXR。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: 'backup 文件只能在 History & Recovery 中以只读方式查看，不能写入 FXR。',
            sourceUri
          }]
        };
      }
      if (!Array.isArray(mutations) || mutations.length === 0
        || !mutations.every((m) => m && typeof m.mutation === 'string')) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FXR_FIELD_SET_MUTATIONS_REQUIRED',
            message: 'FXR typed write 需要至少一条 field set mutation（vfx-field-set）。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'FXR_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'fxr',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitVfxFieldSetViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutations
        }),
        title: `FXR field set × ${mutations.length}`,
        confirmActionLabel: '提交 FXR 字段变更'
      }, {
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    }
  );
}
