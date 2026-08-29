import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  ingestBridgeResult,
  readTaeEventTemplateFile,
  remapCharacterBundleToLeader,
  runBridge,
  type TaeEventTemplateInfo,
  type WorkspaceIndex,
  type WorkspaceSession
} from '@soulforge/core';
import {
  isCharacterPreviewBundle,
  type CharacterPreviewBundle,
  type Diagnostic,
  type FlverPreviewModel,
  type IndexedFile
} from '@soulforge/shared';
import { sanitizeRendererValue } from '../rendererDto.js';
import {
  decodeTaeParamFields,
  getTaeTemplateCatalog
} from '../taeTemplateCatalog.js';
import {
  C0000_COMPATIBILITY_PART_SLOTS,
  canonicalCharacterStemForActionPath,
  planC0000CompatibilityCandidates,
  type C0000CompatibilityCandidateOrigin
} from './actionPreviewCompatibility.js';
import type { TrustedIpcHandle } from './registration.js';
// Forensics counters (V1, pure diagnostic — no business logic change).
const _forensicsActionCounters = new Map<string, number>();
function _forensicsActionInc(key: string, delta = 1): void { _forensicsActionCounters.set(key, (_forensicsActionCounters.get(key) ?? 0) + delta); }
export function getActionForensicsCounters(): Record<string, number> { return Object.fromEntries(_forensicsActionCounters); }

/* ------------------------------------------------------------------ */
/*  本机 DSAnimStudio TAE 词条只读导入（S17 动作域）                    */
/*                                                                    */
/*  DSAnimStudio 的 Res\TAE.Template.SDT.xml 是 Sekiro 事件类型词条表： */
/*  `0 JumpTable` 这类事件行「类型名」的来源，也带每类事件参数体的      */
/*  字段布局（name/kind/slotSize），随 read-tae-document 的             */
/*  templateLayouts 选项传给 Bridge 解码参数体。                        */
/*                                                                    */
/*  同 Yapped：本机第三方工具安装目录，只读、不入库、失败降级 ——        */
/*  拿不到就事件行显示裸 `{typeId}`、参数体不解码，绝不把「词条不可用」 */
/*  升级成「TAE 不可用」。                                              */
/* ------------------------------------------------------------------ */

/** S17 固定候选：本机 DSAnimStudio 发布包真实落地（grok 已求证存在）。 */
const TAE_TEMPLATE_FIXED_CANDIDATES = [
  'D:\\mystream\\Sekiro Shadows Die Twice\\tools\\DSAnimStudio-4.9.9[Build 4999]'
    + '\\Res\\TAE.Template.SDT.xml'
];

/** TAE 模板在 tools/<一层子目录> 下的相对候选（DSAS 装在 Res/ 下）。 */
const TAE_TEMPLATE_RELATIVE_CANDIDATES = [
  'Res\\TAE.Template.SDT.xml',
  'TAE.Template.SDT.xml',
  'Res\\TAE.Template.xml'
];

let taeTemplateCache: {
  loaded: true;
  /** eventTypeId → 词条；null 表示本机无模板或读不到。 */
  byEventTypeId: ReadonlyMap<number, TaeEventTemplateInfo> | null;
} | null = null;

/**
 * 定位本机 DSAnimStudio 的 `TAE.Template.SDT.xml`。
 *
 * 候选顺序：SOULFORGE_TAE_TEMPLATE_PATH 显式环境变量 → 固定候选 → 已挂载
 * 会话兄弟 tools/<一层子目录>/Res/。找不到返回 null，由调用方降级到裸
 * typeId —— 这是可选增强，绝不能把「词条不可用」升级成「TAE 不可用」。
 */
function makeLocateTaeTemplatePathSync(deps: ActionIpcDeps): () => string | null {
  return (): string | null => {
    const probe = (candidate: string): boolean => {
      try {
        return existsSync(candidate);
      } catch {
        return false;
      }
    };
    const explicit = process.env.SOULFORGE_TAE_TEMPLATE_PATH?.trim();
    if (explicit) {
      const candidate = resolve(explicit);
      if (probe(candidate)) return candidate;
    }
    for (const candidate of TAE_TEMPLATE_FIXED_CANDIDATES) {
      if (probe(candidate)) return candidate;
    }
    const roots: string[] = [];
    deps.pushToolsSubdirs(roots, deps.activeSession?.layers.baseRoot);
    const overlay = deps.activeSession?.layers.overlayRoot?.trim();
    if (overlay) deps.pushToolsSubdirs(roots, dirname(dirname(overlay)));
    const gameRootEnv = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
    if (gameRootEnv) deps.pushToolsSubdirs(roots, gameRootEnv);
    for (const root of roots) {
      for (const relative of TAE_TEMPLATE_RELATIVE_CANDIDATES) {
        const candidate = join(root, relative);
        if (probe(candidate)) return candidate;
      }
    }
    return null;
  };
}

/**
 * 惰性读本机 TAE 模板索引并缓存。只读一次（73KB 单文件），每次读 TAE
 * 都重跑会让打开卡顿。空/缺失回 null，不抛 —— 失败降级到裸 typeId。
 */
function makeLoadTaeEventTemplate(
  locateTaeTemplatePathSync: () => string | null
): () => Promise<ReadonlyMap<number, TaeEventTemplateInfo> | null> {
  return async (): Promise<ReadonlyMap<number, TaeEventTemplateInfo> | null> => {
    if (taeTemplateCache) return taeTemplateCache.byEventTypeId;
    const templatePath = locateTaeTemplatePathSync();
    const result = templatePath ? await readTaeEventTemplateFile(templatePath) : null;
    taeTemplateCache = {
      loaded: true,
      byEventTypeId: result?.ok ? result.byEventTypeId : null
    };
    return taeTemplateCache.byEventTypeId;
  };
}

/** read-tae-document 的 bridge options：templateLayouts（无模板时省略）。 */
function taeTemplateLayoutsOption(byEventTypeId: ReadonlyMap<number, TaeEventTemplateInfo> | null) {
  return byEventTypeId
    ? {
        templateLayouts: Object.fromEntries(
          [...byEventTypeId.entries()].map(([id, info]) => [
            String(id),
            info.fields.map((field) => ({ name: field.name, kind: field.kind, slotSize: field.slotSize }))
          ])
        )
      }
    : {};
}

export interface ActionIpcDeps {
  handle: TrustedIpcHandle;
  readonly indexedFiles: readonly IndexedFile[];
  readonly activeSession: WorkspaceSession | null;
  readonly activeIndex: WorkspaceIndex | null;
  safeExists(path: string): boolean;
  pushToolsSubdirs(roots: string[], gameRoot: string | undefined): void;
  asBasicDiagnostics(
    items: Array<{ severity: string; code: string; message: string; sourceUri?: string }>
  ): Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string; sourceUri?: string }>;
  verifiedReadRoots(
    session: WorkspaceSession | null,
    fallback: string
  ): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
}

interface CompatibilityPartCandidate {
  origin: C0000CompatibilityCandidateOrigin;
  name: string;
  absolutePath: string;
}

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

async function assembleC0000CompatibilityPreview(input: {
  leaderBundle: CharacterPreviewBundle;
  overlayPartsDirectory: string;
  basePartsDirectory: string | null;
  allowedRoots: string[];
  oodleRuntimeRoot: string | null;
}): Promise<{ bundle: CharacterPreviewBundle | null; diagnostics: Diagnostic[] }> {
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
      attemptedCandidates += 1;
      try {
        const partResult = await runBridge<unknown>({
          command: 'read-chrbnd-flver-preview',
          filePath: candidate.absolutePath,
          allowedRoots: input.allowedRoots,
          timeoutMs: 120_000,
          ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
          commandOptions: { maxVertices: 1_000_000, maxIndices: 3_000_000 }
        });
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
      } catch {
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
        message: 'c0000 本体只含骨骼；在有界的 bd/am/lg 候选中没有找到可通过骨骼映射的身体部件。当前只能显示骨架，这不代表存档装备。',
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
      message: `c0000 本体只含骨骼；当前按 overlay 优先、文件名字典序从 bd/am/lg 的有界候选中装配兼容预览（${selectedParts.join('、')}）。这不是存档当前装备。`,
      details: { attemptedCandidates, rejectedCandidates, selectedParts, missingSlots }
    }]
  };
}

export function registerActionIpcHandlers(deps: ActionIpcDeps): void {
  const locateTaeTemplatePathSync = makeLocateTaeTemplatePathSync(deps);
  const loadTaeEventTemplate = makeLoadTaeEventTemplate(locateTaeTemplatePathSync);

  deps.handle('resource.readTaeDocument', async (_event, sourceUri: string, options?: { animationPage?: number; animationPageSize?: number }) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TAE。', sourceUri }] };
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    // S17：DSAS 模板（本机只读，可选增强）→ templateLayouts 给 Bridge 解码参数体。
    const byEventTypeId = await loadTaeEventTemplate();
    const paginationOptions: Record<string, unknown> = {};
    if (typeof options?.animationPage === 'number' && Number.isFinite(options.animationPage) && options.animationPage >= 0) {
      paginationOptions.animationPage = Math.floor(options.animationPage);
    }
    if (typeof options?.animationPageSize === 'number' && Number.isFinite(options.animationPageSize) && options.animationPageSize > 0) {
      paginationOptions.animationPageSize = Math.floor(options.animationPageSize);
    }
    const templateLayoutsCommandOptions = taeTemplateLayoutsOption(byEventTypeId) as Record<string, unknown> | null;
    const mergedCommandOptions = {
      ...(templateLayoutsCommandOptions ? { templateLayouts: (templateLayoutsCommandOptions as { templateLayouts: unknown }).templateLayouts } : {}),
      ...paginationOptions
    } as Record<string, unknown>;
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-tae-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(Object.keys(mergedCommandOptions).length ? { commandOptions: mergedCommandOptions } : {}),
      ...(deps.activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
        : {})
    });
    // 问题 6-C：打开 anibnd 成功读到 TAE 信封时 ingest 一次（最小 hunk，renderer
    // 不建索引）。envelope 采样截断（animationsTruncated / eventsTruncated）时
    // ingestBridgeResult 会按缺口 4 fail-closed 拒绝，不把残缺当完整；这里不因
    // 索引结果改变 IPC 返回。
    if (result.parseStatus !== 'failed' && result.data && deps.activeIndex) {
      ingestBridgeResult(deps.activeIndex, {
        sourceUri,
        sourcePath: file.relativePath,
        game: file.game,
        resourceKind: 'action',
        parseStatus: 'parsed',
        diagnostics: deps.asBasicDiagnostics(result.diagnostics),
        data: result.data
      });
    }
    // 事件类型名表（`0 JumpTable` 的「类型名」）：只投影文档实际出现过的
    // eventTypeId，模板缺的 id 不出现，渲染器回退裸 `{typeId}`。
    let eventTypeNames: Record<string, string> | undefined;
    if (result.parseStatus !== 'failed' && result.data && byEventTypeId) {
      const data = result.data as { eventTypes?: number[] };
      const present = (data.eventTypes ?? []).filter(
        (id): id is number => byEventTypeId.has(id)
      );
      if (present.length > 0) {
        eventTypeNames = Object.fromEntries(
          present.map((id) => [String(id), byEventTypeId.get(id)!.name])
        );
      }
    }
    return sanitizeRendererValue({
      ok: result.parseStatus !== 'failed',
      sourceUri,
      relativePath: file.relativePath,
      data: result.data,
      ...(eventTypeNames ? { eventTypeNames } : {}),
      diagnostics: result.diagnostics
    });
  });

  /**
   * S17：词条名目录。main 从本机 TAE.Template.SDT.xml 解析 eventTypeId → 名称；
   */
  deps.handle('resource.readTaeTemplateCatalog', async (): Promise<{
    ok: boolean;
    origin: 'imported' | 'unavailable';
    events: Array<{ eventTypeId: number; name: string }>;
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }> => {
    const catalog = getTaeTemplateCatalog();
    // handle() 包装器统一 sanitize；这里只组装结构化结果。
    return {
      ok: catalog.origin === 'imported',
      origin: catalog.origin,
      events: [...catalog.events.entries()].map(([eventTypeId, def]) => ({ eventTypeId, name: def.name })),
      diagnostics: [...catalog.diagnostics]
    };
  });

  /**
   * S17：单个词条事件的参数体。main 按本机模板布局给 Bridge 参数长度，Bridge
   * 原生截取参数体字节（越界失败关闭），main 再按布局解码字段（little-endian）。
   * 无模板类型：返回未解码 + 原始 hex，不编造字段含义。
   */
  deps.handle(
    'resource.readTaeEventParams',
    async (
      _event,
      sourceUri: string,
      animId: number,
      eventIndex: number
    ): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: {
        eventTypeId: number;
        templateName: string | null;
        fields: Array<{ name: string; type: string; value: string }>;
        tailHex: string | null;
        undecodedHex: string | null;
      };
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TAE 事件参数。', sourceUri }] };
      }
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      const catalog = getTaeTemplateCatalog();
      // 第一读：paramSize 缺省 → Bridge 给前 16 字节，拿到 eventTypeId。
      const result = await runBridge<{
        eventTypeId?: number;
        paramHex?: string;
        paramSize?: number;
      }>({
        command: 'read-tae-event-params',
        filePath: file.absolutePath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(deps.activeSession?.layers.baseRoot
          ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
          : {}),
        commandOptions: { animId, eventIndex }
      });
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, diagnostics: result.diagnostics };
      }
      const eventTypeId = result.data.eventTypeId ?? -1;
      const def = catalog.events.get(eventTypeId);
      // 有模板且模板大小 ≠ 16：按模板长度重读参数体（16 字节时第一读已够）。
      const paramSize = def?.paramSize ?? 0;
      const needsExactRead = paramSize > 0 && paramSize !== 16;
      const exact = needsExactRead
        ? await runBridge<{ paramHex?: string }>({
            command: 'read-tae-event-params',
            filePath: file.absolutePath,
            allowedRoots: roots.allowedRoots,
            timeoutMs: 120_000,
            ...(deps.activeSession?.layers.baseRoot
              ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
              : {}),
            commandOptions: { animId, eventIndex, paramSize }
          })
        : null;
      if (exact && (exact.parseStatus === 'failed' || !exact.data?.paramHex)) {
        return { ok: false, diagnostics: exact.diagnostics };
      }
      const paramHex = exact?.data?.paramHex ?? result.data.paramHex ?? '';
      const decoded = decodeTaeParamFields(def, paramHex);
      // handle() 包装器统一 sanitize；这里只组装结构化结果。
      return {
        ok: true,
        sourceUri,
        relativePath: file.relativePath,
        data: {
          eventTypeId,
          templateName: def?.name ?? null,
          fields: decoded ?? [],
          // 模板字段之外的尾部字节（模板大小与实测参数体不一致时可见，不丢弃）。
          tailHex: decoded ? (paramHex.slice(decoded.length * 2) || null) : null,
          undecodedHex: def && def.paramSize > 0 ? null : (paramHex || null)
        },
        diagnostics: [...result.diagnostics, ...(exact?.diagnostics ?? [])]
      };
    }
  );

  /**
   * S17：动作预览挂模型。按 anibnd 推断伴生 chrbnd（overlay 同目录 → 已挂原版
   * 同相对路径），Bridge 解 DCX→BND4→首个 .flver 条目并提取网格/骨骼/挂点。
   * renderer 只拿投影数据，绝对路径不出 main。
   */
  deps.handle(
    'resource.readTaeChrbndPreview',
    async (
      _event,
      sourceUri: string
    ): Promise<{
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
      const result = await runBridge<Record<string, unknown>>({
        command: 'read-chrbnd-flver-preview',
        filePath: chrbndPath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
        commandOptions: { maxVertices: 1_000_000, maxIndices: 3_000_000 }
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

      return {
        ok: true,
        sourceUri,
        relativePath: file.relativePath,
        data: previewBundle,
        diagnostics: [...result.diagnostics, ...compatibilityDiagnostics]
      };
    }
  );

  deps.handle(
    'resource.readTaeAnimationClip',
    async (
      _event,
      sourceUri: string,
      animId: number,
      flverBoneNames?: string[]
    ): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: Record<string, unknown>;
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引或工作区未打开，无法读取 TAE 动画。', sourceUri }] };
      }
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      const overlayParent = dirname(deps.activeSession.layers.overlayRoot);
      const effectiveBase = deps.activeSession.layers.baseRoot?.trim()
        ?? (existsSync(join(overlayParent, 'sekiro.exe')) || existsSync(join(overlayParent, 'parts')) ? overlayParent : null);
      if (effectiveBase && !roots.allowedRoots.includes(effectiveBase)) roots.allowedRoots.push(effectiveBase);

      const result = await runBridge<Record<string, unknown>>({
        command: 'read-tae-animation-clip',
        filePath: file.absolutePath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
        commandOptions: { animId, ...(flverBoneNames?.length ? { flverBoneNames } : {}) }
      });
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, sourceUri, diagnostics: result.diagnostics };
      }

      return {
        ok: true,
        sourceUri,
        relativePath: file.relativePath,
        data: result.data,
        diagnostics: result.diagnostics
      };
    }
  );

  deps.handle(
    'resource.sampleTaeAnimationPose',
    async (
      _event,
      sourceUri: string,
      animId: number,
      timeSeconds: number,
      flverBoneNames?: string[],
      loop?: boolean
    ): Promise<{
      ok: boolean;
      sourceUri?: string;
      relativePath?: string;
      data?: Record<string, unknown>;
      diagnostics: Array<{ severity: string; code: string; message: string; sourceUri?: string }>;
    }> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引或工作区未打开，无法采样 TAE 动画位姿。', sourceUri }] };
      }
      const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
      if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
      const overlayParent = dirname(deps.activeSession.layers.overlayRoot);
      const effectiveBase = deps.activeSession.layers.baseRoot?.trim()
        ?? (existsSync(join(overlayParent, 'sekiro.exe')) || existsSync(join(overlayParent, 'parts')) ? overlayParent : null);
      if (effectiveBase && !roots.allowedRoots.includes(effectiveBase)) roots.allowedRoots.push(effectiveBase);

      const result = await runBridge<Record<string, unknown>>({
        command: 'sample-tae-animation-pose',
        filePath: file.absolutePath,
        allowedRoots: roots.allowedRoots,
        timeoutMs: 120_000,
        ...(effectiveBase ? { oodleRuntimeRoot: effectiveBase } : {}),
        commandOptions: { animId, timeSeconds, loop: loop ?? true, ...(flverBoneNames?.length ? { flverBoneNames } : {}) }
      });
      if (result.parseStatus === 'failed' || !result.data) {
        return { ok: false, sourceUri, diagnostics: result.diagnostics };
      }

      return {
        ok: true,
        sourceUri,
        relativePath: file.relativePath,
        data: result.data,
        diagnostics: result.diagnostics
      };
    }
  );

  /**
   * S17：动作域 TAE 的伴生 chrbnd 解析（overlay → 已挂载原版）。
   * renderer 传动作文件 sourceUri；main 按同相对路径推 `chr/<id>.chrbnd.dcx`
   * 并探存在性，返回虚拟 sourceUri（`chrbnd:<relative>`）供 FLVER 读通道用。
   * 两边都没有时给空态文案：未挂原版时指引去「开始」页挂载。
   */
  deps.handle('resource.resolveChrbndPreview', async (_event, animSourceUri: string) => {
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
  });
}
