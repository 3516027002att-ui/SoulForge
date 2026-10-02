import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { isLeaderRemappedBundle, remapCharacterBundleToLeader, runBridge, type RunBridgeCancellationTerminalReceipt, type WorkspaceSession } from '@soulforge/core';
import { isCharacterPreviewBundle, type CharacterPreviewBundle, type Diagnostic, type FlverPreviewModel, type IndexedFile } from '@soulforge/shared';
import { C0000_COMPATIBILITY_PART_SLOTS, canonicalCharacterStemForActionPath, planC0000CompatibilityCandidates, type C0000CompatibilityCandidateOrigin } from '../ipc/actionPreviewCompatibility.js';
import { actionDiagnostic } from './actionDiagnostics.js';

export interface CharacterPreviewServiceDeps {
  readonly indexedFiles: readonly IndexedFile[];
  readonly activeSession: WorkspaceSession | null;
  safeExists(path: string): boolean;
  verifiedReadRoots(session: WorkspaceSession | null, fallback: string): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
}

// Forensics counters (V1, pure diagnostic — no business logic change).
const _forensicsActionCounters = new Map<string, number>();
function _forensicsActionInc(key: string, delta = 1): void { _forensicsActionCounters.set(key, (_forensicsActionCounters.get(key) ?? 0) + delta); }
export function getActionForensicsCounters(): Record<string, number> { return Object.fromEntries(_forensicsActionCounters); }

interface CompatibilityPartCandidate {
  origin: C0000CompatibilityCandidateOrigin;
  name: string;
  absolutePath: string;
}

// c0000 的兼容装配只负责把有界的原生 parts 合并到 leader 骨骼。
// 不在这里为 HD_M_9510 注入通用 FC 头部纹理：该材质仍按 native
// projected-decal 返回，但 generic Three renderer 没有原生 projector，
// 用普通 UV 把 FC 颜色贴到 HD 接收面会产生黑色断裂条带。Bridge 的通用
// compatibilityProjectionTextureName 选项仍保留给已有的、单独验证过的
// native material-local/测试路径；ACTION c0000 不得自动传入它。

async function readDirectoryNames(directory: string | null): Promise<string[]> {
  if (!directory) return [];
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}



/**
 * 角色 FLVER 的纹理不是 FLVER 内嵌资源：chrbnd 通常配套同名 texbnd，
 * partsbnd 还会共享 parts/common_body.tpf。只把真实存在且位于 Bridge
 * allowed roots 的候选传给 Bridge，避免 renderer 猜本机绝对路径。
 */
export function characterTexturePackagePaths(
  modelPath: string,
  additionalPartsDirectories: readonly string[] = []
): string[] {
  const candidates: string[] = [];
  const add = (candidate: string): void => {
    if (!existsSync(candidate)) return;
    if (!candidates.some((path) => path.toLowerCase() === candidate.toLowerCase())) {
      candidates.push(candidate);
    }
  };
  const lower = modelPath.toLowerCase();
  if (lower.endsWith('.chrbnd.dcx')) {
    const stem = modelPath.slice(0, -'.chrbnd.dcx'.length);
    add(`${stem}.texbnd.dcx`);
    add(`${stem}.texbnd`);
  } else if (lower.endsWith('.chrbnd')) {
    const stem = modelPath.slice(0, -'.chrbnd'.length);
    add(`${stem}.texbnd`);
    add(`${stem}.texbnd.dcx`);
  } else if (lower.endsWith('_l.partsbnd.dcx')) {
    const stem = modelPath.slice(0, -'_l.partsbnd.dcx'.length);
    add(`${stem}.partsbnd.dcx`);
    add(`${stem}.partsbnd`);
  } else if (lower.endsWith('_l.partsbnd')) {
    const stem = modelPath.slice(0, -'_l.partsbnd'.length);
    add(`${stem}.partsbnd`);
    add(`${stem}.partsbnd.dcx`);
  } else if (lower.endsWith('.partsbnd.dcx')) {
    const stem = modelPath.slice(0, -'.partsbnd.dcx'.length);
    add(`${stem}_l.partsbnd.dcx`);
    add(`${stem}_l.partsbnd`);
  } else if (lower.endsWith('.partsbnd')) {
    const stem = modelPath.slice(0, -'.partsbnd'.length);
    add(`${stem}_l.partsbnd`);
    add(`${stem}_l.partsbnd.dcx`);
  }
  const modelDirectory = dirname(modelPath);
  const partsDirectories = new Set<string>();
  if (basename(modelDirectory).toLowerCase() === 'parts') partsDirectories.add(modelDirectory);
  // Character files normally live in `chr/`, while common body textures live
  // in the game root's `parts/`. The old resolver only handled a model that
  // was itself inside `parts`, which made map characters render as clothing or
  // neutral gray when their face/body was in the shared package.
  partsDirectories.add(join(modelDirectory, '..', 'parts'));
  for (const directory of additionalPartsDirectories) {
    if (directory.trim()) partsDirectories.add(directory);
  }
  for (const directory of partsDirectories) {
    add(join(directory, 'common_body.tpf.dcx'));
    add(join(directory, 'common_body.tpf'));
  }
  return candidates;
}

export async function assembleC0000CompatibilityPreview(input: {
  leaderBundle: CharacterPreviewBundle;
  overlayPartsDirectory: string;
  basePartsDirectory: string | null;
  allowedRoots: string[];
  oodleRuntimeRoot: string | null;
  /** Optional caller-owned cancellation; no signal means legacy ACTION behavior. */
  signal?: AbortSignal;
  /** Native transport terminal receipt observer for the owning MAP request. */
  onCancellationTerminal?: (
    receipt: RunBridgeCancellationTerminalReceipt
  ) => void | Promise<void>;
}): Promise<{ bundle: CharacterPreviewBundle | null; diagnostics: Diagnostic[] }> {
  const throwIfCancelled = (): void => {
    if (input.signal?.aborted) throw new Error('MAP_REQUEST_CANCELLED');
  };
  throwIfCancelled();
  const leader = input.leaderBundle.models.find((model) => model.modelId === input.leaderBundle.leaderModelId)
    ?? input.leaderBundle.models[0];
  if (!leader || leader.bones.length === 0) {
    return {
      bundle: null,
      diagnostics: [{
        severity: 'warning',
        code: 'ACTION_COMPATIBILITY_PREVIEW_LEADER_MISSING',
        message: 'c0000 兼容预览缺少可用的 leader 骨骼，无法装配身体部件。'
      }]
    };
  }

  const [overlayNames, baseNames] = await Promise.all([
    readDirectoryNames(input.overlayPartsDirectory),
    readDirectoryNames(input.basePartsDirectory)
  ]);
  const selectedModels: FlverPreviewModel[] = [];
  const selectedParts: string[] = [];
  const missingSlots: string[] = [];
  let attemptedCandidates = 0;
  let rejectedCandidates = 0;

  for (const slot of C0000_COMPATIBILITY_PART_SLOTS) {
    throwIfCancelled();
    const candidates: CompatibilityPartCandidate[] = planC0000CompatibilityCandidates(
      slot,
      overlayNames,
      baseNames
    ).map((candidate) => ({
      ...candidate,
      absolutePath: join(
        candidate.origin === 'overlay' ? input.overlayPartsDirectory : input.basePartsDirectory!,
        candidate.name
      )
    }));
    let selected = false;
    for (const candidate of candidates) {
      throwIfCancelled();
      attemptedCandidates += 1;
      try {
        const partResult = await runBridge<unknown>({
          command: 'read-chrbnd-flver-preview',
          filePath: candidate.absolutePath,
          allowedRoots: input.allowedRoots,
          timeoutMs: 120_000,
          ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
          commandOptions: {
            maxVertices: 1_000_000,
            maxIndices: 3_000_000,
            texturePackagePaths: characterTexturePackagePaths(candidate.absolutePath)
          },
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onCancellationTerminal
            ? { onCancellationTerminal: input.onCancellationTerminal }
            : {})
        });
        throwIfCancelled();
        if (partResult.parseStatus === 'failed'
          || !isCharacterPreviewBundle(partResult.data)
          || partResult.data.meshCount === 0) {
          rejectedCandidates += 1;
          continue;
        }
        const trial = remapCharacterBundleToLeader(leader, partResult.data.models);
        if (!trial.ok || !trial.bundle || trial.bundle.meshCount <= leader.meshCount) {
          rejectedCandidates += 1;
          continue;
        }
        selectedModels.push(...partResult.data.models);
        selectedParts.push(`parts/${candidate.name}`);
        selected = true;
        break;
      } catch (error) {
        if (input.signal?.aborted) throw error;
        rejectedCandidates += 1;
      }
    }
    if (!selected) missingSlots.push(slot);
  }

  if (selectedModels.length === 0) {
    return {
      bundle: null,
      diagnostics: [{
        severity: 'warning',
        code: 'ACTION_COMPATIBILITY_PREVIEW_UNAVAILABLE',
         message: 'c0000 本体只含骨骼；在有界的 bd/am/lg/hd/fc 候选中没有找到可通过骨骼映射的身体部件。当前只能显示骨架，这不代表存档装备。',
        details: { attemptedCandidates, rejectedCandidates, missingSlots }
      }]
    };
  }

  const assembled = remapCharacterBundleToLeader(leader, selectedModels);
  if (!assembled.ok || !assembled.bundle) {
    return {
      bundle: null,
      diagnostics: assembled.diagnostics.length > 0
        ? assembled.diagnostics
        : [{
            severity: 'warning',
            code: 'ACTION_COMPATIBILITY_PREVIEW_REMAP_FAILED',
            message: 'c0000 兼容预览的身体部件无法安全映射到 leader 骨骼。'
          }]
    };
  }

  return {
    bundle: {
      ...assembled.bundle,
      assemblyMode: 'compatibility-preview',
      assemblyParts: selectedParts
    },
    diagnostics: [{
      severity: 'warning',
      code: 'ACTION_COMPATIBILITY_PREVIEW_ASSEMBLED',
      message: `c0000 本体只含骨骼；当前按原版 face/hair 组件优先、overlay 覆盖与确定性候选从 bd/am/lg/hd/fc 装配兼容预览（${selectedParts.join('、')}）。native projected-decal 保持只读，不注入通用 FC 纹理投影；这不是存档当前装备。`,
      details: { attemptedCandidates, rejectedCandidates, selectedParts, missingSlots }
    }]
  };
}
/** Character preview resolution/assembly; no IPC registration or sender capability.
 * Shared MAP helpers below preserve caller-owned signals and native receipts. */
export function createCharacterPreviewService(deps: CharacterPreviewServiceDeps) {
const readTaeChrbndPreview = async (sourceUri: string): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: CharacterPreviewBundle;
      diagnostics: Diagnostic[];
    }> => {
      _forensicsActionInc('action:main:readTaeChrbndPreview:count');
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引或工作区未打开，无法定位伴生 chrbnd。', sourceUri }] };
      }
      const stem = canonicalCharacterStemForActionPath(file.relativePath);
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      const overlayParent = dirname(deps.activeSession.layers.overlayRoot);
      const effectiveBase = deps.activeSession.layers.baseRoot?.trim()
        ?? (existsSync(join(overlayParent, 'sekiro.exe')) || existsSync(join(overlayParent, 'parts')) ? overlayParent : null);
      if (effectiveBase && !roots.allowedRoots.includes(effectiveBase)) roots.allowedRoots.push(effectiveBase);

      // 查找顺序：overlay 同目录 chr/<stem>.chrbnd.dcx → 已挂原版同样相对路径。
      const overlayCandidate = join(dirname(file.absolutePath), `${stem}.chrbnd.dcx`);
      const overlayExists = deps.safeExists(overlayCandidate);
      const vanillaCandidate = effectiveBase ? join(effectiveBase, 'chr', `${stem}.chrbnd.dcx`) : null;
      const vanillaExists = vanillaCandidate ? deps.safeExists(vanillaCandidate) : false;
      if (!overlayExists && !vanillaExists) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error' as const,
            code: 'CHRBND_NOT_FOUND',
            message: effectiveBase
              ? `没有找到 ${stem} 的模型（chr/${stem}.chrbnd.dcx）：overlay 与原版目录都没有该文件。`
              : `没有找到 ${stem} 的模型（chrbnd）：overlay 没有该文件，且尚未挂载原版目录——到「开始」页选择含 sekiro.exe 的原版目录后可尝试读取原版模型。`
          }]
        };
      }
      const chrbndPath = overlayExists ? overlayCandidate : vanillaCandidate!;
      const texturePackagePaths = [
        ...characterTexturePackagePaths(chrbndPath),
        ...(overlayExists && vanillaCandidate && vanillaExists
          ? characterTexturePackagePaths(vanillaCandidate)
          : [])
      ].filter((path, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === path.toLowerCase()) === index);
      const result = await runBridge<Record<string, unknown>>({
        command: 'read-chrbnd-flver-preview',
        filePath: chrbndPath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
        commandOptions: {
          maxVertices: 1_000_000,
          maxIndices: 3_000_000,
          texturePackagePaths
        }
      });
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, sourceUri, diagnostics: result.diagnostics };
      }

      if (!isCharacterPreviewBundle(result.data)) {
        return {
          ok: false,
          sourceUri,
          diagnostics: [{
            severity: 'error',
            code: 'CHRBND_PREVIEW_SCHEMA_INVALID',
            message: '伴生 chrbnd 返回的角色预览数据不符合协议。',
            sourceUri
          }]
        };
      }

      let previewBundle: CharacterPreviewBundle = result.data;
      let compatibilityDiagnostics: Diagnostic[] = [];
      if (stem === 'c0000' && previewBundle.meshCount === 0 && previewBundle.boneCount > 0) {
        const compatibility = await assembleC0000CompatibilityPreview({
          leaderBundle: previewBundle,
          overlayPartsDirectory: join(deps.activeSession.layers.overlayRoot, 'parts'),
          basePartsDirectory: effectiveBase ? join(effectiveBase, 'parts') : null,
          allowedRoots: roots.allowedRoots,
          oodleRuntimeRoot: effectiveBase
        });
        compatibilityDiagnostics = compatibility.diagnostics;
        if (compatibility.bundle) previewBundle = compatibility.bundle;
      }

      // A normal chrbnd/partsbnd can contain several FLVER-local skeletons.
      // The TAE clip is sampled in the leader skeleton's index space, so passing
      // the raw bundle to the renderer would leave body parts on independent,
      // unmoving skeletons (or make an unkeyed pose update the wrong skeleton).
      // Normalize every multi-model action preview at the main/core boundary:
      // the leader owns the sampled pose, while each part retains its native
      // bind skeleton through an explicit follower binding.
      if (previewBundle.models.length > 1 && !isLeaderRemappedBundle(previewBundle)) {
        const leader = previewBundle.models.find((model) => model.modelId === previewBundle.leaderModelId);
        if (!leader || leader.bones.length === 0) {
          return {
            ok: false,
            sourceUri,
            diagnostics: [
              ...result.diagnostics,
              ...compatibilityDiagnostics,
              actionDiagnostic(
                'ACTION_PREVIEW_LEADER_MISSING',
                '动作预览包含多个 FLVER，但没有可用的 leader 骨架，已拒绝在错误骨架上播放。',
                sourceUri,
                { leaderModelId: previewBundle.leaderModelId, modelCount: previewBundle.models.length }
              )
            ]
          };
        }
        const remapped = remapCharacterBundleToLeader(
          leader,
          previewBundle.models.filter((model) => model.modelId !== leader.modelId)
        );
        if (!remapped.ok || !remapped.bundle) {
          return {
            ok: false,
            sourceUri,
            diagnostics: [
              ...result.diagnostics,
              ...compatibilityDiagnostics,
              ...remapped.diagnostics,
              actionDiagnostic(
                'ACTION_PREVIEW_LEADER_REMAP_FAILED',
                '动作预览的身体部件无法安全映射到 leader 骨架，已关闭播放预览。',
                sourceUri,
                { leaderModelId: leader.modelId, modelCount: previewBundle.models.length }
              )
            ]
          };
        }
        previewBundle = remapped.bundle;
        compatibilityDiagnostics = [
          ...compatibilityDiagnostics,
          {
            severity: 'info',
            code: 'ACTION_PREVIEW_LEADER_REMAP_APPLIED',
            message: `动作预览已将 ${previewBundle.models.length} 个 FLVER 统一到 leader 骨架 ${leader.modelId}。`,
            sourceUri,
            details: { leaderModelId: leader.modelId, modelCount: previewBundle.models.length }
          }
        ];
      }

      return {
        ok: true,
        sourceUri,
        relativePath: file.relativePath,
        data: previewBundle,
        diagnostics: [...result.diagnostics, ...compatibilityDiagnostics]
      };
    };

const resolveChrbndPreview = async (animSourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === animSourceUri);
    if (!file) {
      return { ok: false, reason: 'no-anim' as const, message: '未找到该动作文件。' };
    }
    const relative = file.relativePath.replace(/\\/g, '/');
    const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    const stem = canonicalCharacterStemForActionPath(relative);
    const candidates = [`${stem}.chrbnd.dcx`, `${stem}.chrbnd`]
      .map((name) => (dir ? `${dir}/${name}` : name))
      .map((name) => name.replace(/\//g, sep));
    const overlay = deps.activeSession?.layers.overlayRoot?.trim();
    if (overlay) {
      for (const candidate of candidates) {
        try {
          if (existsSync(join(overlay, candidate))) {
            return { ok: true, origin: 'overlay' as const, chrbndSourceUri: `chrbnd:${candidate.replace(/\\/g, '/')}` };
          }
        } catch {
          // 继续下一个候选。
        }
      }
    }
    const base = deps.activeSession?.layers.baseRoot?.trim();
    if (base) {
      for (const candidate of candidates) {
        try {
          if (existsSync(join(base, candidate))) {
            return { ok: true, origin: 'base' as const, chrbndSourceUri: `chrbnd:${candidate.replace(/\\/g, '/')}` };
          }
        } catch {
          // 继续下一个候选。
        }
      }
    }
    if (!base) {
      return {
        ok: false,
        reason: 'base-not-mounted' as const,
        message: `没有找到 ${stem} 的模型（chrbnd），且未挂载原版游戏目录；到「开始」页选择含 sekiro.exe 的目录后再试。`
      };
    }
    return { ok: false, reason: 'none' as const, message: `没有找到 ${stem} 的模型（chrbnd）。` };
  };

return Object.freeze({ readTaeChrbndPreview, resolveChrbndPreview });
}
export type CharacterPreviewService = ReturnType<typeof createCharacterPreviewService>;
