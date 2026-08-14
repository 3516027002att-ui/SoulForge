import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeWorkspace,
  buildAiSidebarDraft,
  buildTrustPolicyFromPackage,
  clearTrustDecision,
  readTrustDecision,
  trustCoversPackage,
  writeTrustDecision,
  type AppSettingsStore,
  createAgentToolBridge,
  createConfiguredModelServiceAdapter,
  createDefaultToolRegistry,
  createConfirmationReceipt,
  createContextBroker,
  createUnifiedDiff,
  importPinnedSmithboxSdtParamMetadata,
  applyYappedFieldOverlay,
  readYappedSdtDefsIndex,
  readYappedSdtRowNamesIndex,
  type YappedParamOverlay,
  type YappedSourceDiagnostic,
  listRolloutSessions,
  loadRolloutSession,
  runAgentSession,
  disposeBridgeDaemonPool,
  commitEmevdMutationViaBridge,
  fingerprintEmedfRegistry,
  readFullEmevdDocumentViaBridge,
  renderEmevdDarkScriptBounded,
  submitEmevdDslPlanViaFourView,
  resolveEmevdRegistry,
  listEmedfCompletionItems,
  type EmedfCompletionItem,
  buildScriptContainerEvidence,
  analyzePlaintextLineEndings,
  classifyPlaintextBytes,
  decodePlaintext,
  classifyScriptEntry,
  magicLabel,
  normalizePageWindow,
  sanitizeEntryName,
  applyParamFieldMutation,
  decodeRowFields,
  encodeFieldMutation,
  toCsvText,
  parseCsvText,
  commitFmgMutationViaBridge,
  commitFlverMutationViaBridge,
  commitGparamMutationsViaBridge,
  commitMtdPropertySetViaBridge,
  commitEsdTransitionViaBridge,
  type EsdTransitionMutation,
  commitTaeEventViaBridge,
  type TaeEventUpsertMutation,
  commitVfxFieldSetViaBridge,
  type VfxFieldSetMutation,
  commitTpfTextureReplaceViaBridge,
  type GparamFieldSetMutation,
  commitParamMutationViaBridge,
  commitMsbMutationViaBridge,
  readFmgDocumentViaBridge,
  readParamDocumentViaBridge,
  readMsbDocumentViaBridge,
  isParamBackupPath,
  openResourcePreview,
  openWorkspaceSession,
  inspectContainerTree,
  listContainerChildren,
  Me3RuntimeAdapter,
  probeContainerCapabilityOptions,
  readContainerChild,
  readRawResourceMetadata,
  readRawResourceRange,
  replaceContainerChild,
  resolveOperationLogStorePath,
  resolveResourceCapabilities,
  rollbackOperation,
  roundTripContainer,
  runBridge,
  saveRawReplace,
  saveTextResource,
  scanWorkspace,
  stageBridgeOutput,
  applyNativeMutation,
  validateContainer,
  isDeferredPreviewEditor,
  buildNativeDocumentLocator,
  EditorDocumentStore,
  type EditorDocumentDataSource,
  type EditorMutationApplyPort,
  type NativeDocumentLocator,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type WriteConfirmationPort,
  type AiSidebarDraft,
  type AiSidebarDraftRequest,
  type ResourceCapabilityMatrix,
  type ToolContext,
  type ToolDescriptor,
  type ToolResult,
  type WorkspaceIndex,
  type WorkspaceSession,
  type ScriptContainerEntryEvidence,
  type ScriptEntryClassification
} from '@soulforge/core';
import {
  CONTAINER_PAGE_SIZE,
  FMG_PAGE_SIZE,
  PARAM_PAGE_SIZE,
  SCRIPT_PAGE_SIZE,
  EDITOR_DOCUMENT_IPC_CHANNELS,
  agentReferenceExpiresAt,
  agentSelectionSummary,
  decodeDecideAgentApprovalRequest,
  decodeEditorSelectionContext,
  decodeOpenEditorDocumentRequest,
  decodePageEditorDocumentRequest,
  decodeReadEditorContentRequest,
  decodeApplyEditorMutationRequest,
  mintAgentReferenceToken,
  selectionRendererSafetyIssues,
  validateAgentReferenceScope,
  type AgentResourceReference,
  type DecideAgentApprovalRequest,
  type EditorSelectionContext,
  type FmgEntryPage,
  type ScriptEntryPlaintextView
} from '@soulforge/shared';
import { prepareBridgeRoots, type BridgeRootSession, type PrepareBridgeRootsResult } from './bridgeRoots.js';
import type {
  ApplyEditorMutationValue,
  BridgeDocumentLocatorValue,
  ConfirmationReceipt,
  Diagnostic,
  EditorContentValue,
  EditorDocumentErrorCode,
  EditorDocumentPageValue,
  EditorDocumentResult,
  EditorKind,
  EditorPageQuery,
  EditorContentQuery,
  EditorMutation,
  OpenEditorDocumentValue,
  ParamMetadataPackage,
  EmevdEditorDocument,
  IndexedFile,
  ParamDefDocument,
  GparamDocument,
  ReadOperationId,
  ResourceKind,
  StructuredDiagnostic
} from '@soulforge/shared';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalDiff,
  ChatMessage,
  ResumedRollout,
  RolloutSessionMeta
} from '@soulforge/core';
import {
  sanitizeDiagnostics,
  sanitizeRendererValue,
  toRendererEditorDocumentResult,
  toRendererHistoryEntry,
  toRendererIndexedFile,
  toRendererResourcePreview,
  toRendererSaveResult,
  type RendererIndexedFile,
  type RendererPatchHistoryEntry,
  type RendererResourcePreview,
  type RendererSaveResult
} from './rendererDto.js';
import { OperationLogUtilityClient } from './operationLogUtilityClient.js';
import { readRecentPath, writeRecentPath } from './recentPaths.js';
import { executeRecoveryCleanup } from './recoveryCleanup.js';
import { ModelServiceCredentialVault } from './modelServiceCredentials.js';
import { MainMe3RuntimeGateway } from './me3RuntimeGateway.js';

let indexedFiles: IndexedFile[] = [];
let activeIndex: WorkspaceIndex | null = null;
let activeSession: WorkspaceSession | null = null;
let activeOperationLog: OperationLogUtilityClient | null = null;
let activeWorkspaceSessionId: string | null = null;
/**
 * Authoritative full EMEVD editor documents keyed by sourceUri. Assembled in
 * main via paginated Bridge reads; the renderer only ever edits DSL text and
 * never holds these documents (hard constraint 18).
 */
const emevdFullDocuments = new Map<string, EmevdEditorDocument>();

/* ------------------------------------------------------------------ */
/*  Paginated editor access caches (hard constraint 17)                */
/*  Main holds the complete document; the renderer only ever receives  */
/*  bounded pages via resource.readFmgPage / resource.readParamPage /  */
/*  resource.listContainerChildrenPage. Each cache is invalidated on   */
/*  mutation commit so the next page fetch re-reads the fresh file.    */
/* ------------------------------------------------------------------ */

/*
 * 页大小来自 @soulforge/shared（唯一来源）。此前主进程、renderer 6 处面板与 e2e
 * harness 各写一遍字面量，任一侧改动都没有编译错误，症状是分页错位或末页重复。
 */
/** Upper bound for the paginated PARAM channel's complete-coverage read. */
const MAX_PAGED_PARAM_ROWS = 100_000;

interface CachedFmgDocument {
  sourceHash: string;
  maxId: number;
  entries: Array<{ id: number; text: string }>;
  authority?: string;
}
const fmgPageCache = new Map<string, CachedFmgDocument>();

/**
 * TEXT-20A：文本目录的表引用与表分页缓存。
 *
 * tableId 由 Bridge `read-text-catalog` 产出（stableId），携带语言/容器 typed
 * 上下文；renderer 只持有 tableId 与 sourceUri，从不自行解析 msg/ 路径。目录
 * 每次读取都重建 textTableRefs（幂等），表分页按 tableId 定位源文件与
 * entryIndex 后经 Bridge 读取，不经临时文件（容器内 FMG 直接走字节）。
 */
interface TextTableRef {
  tableId: string;
  languageId: string;
  containerId: string;
  containerKind: string;
  sourceUri: string;
  entryIndex: number;
  entryName: string;
}
const textTableRefs = new Map<string, TextTableRef>();

interface CachedFmgTableDocument extends CachedFmgDocument {
  tableId: string;
}
const fmgTableCache = new Map<string, CachedFmgTableDocument>();

interface CachedParamDocument {
  sourceHash: string;
  typeName: string;
  rowDataSize: number;
  rowCount: number;
  // 全表读取的行恒无 dataBase64：Bridge 的载荷门控按**页**算，全表等于
  // 「页大小 = 总行数」必然超限。当前页的字节由 readParamPage 单独取一次分页
  // 补齐（见该 handler 头部的实测记录）。此处保留 optional 是如实建模，
  // 不是「小 param 才有字节」——原注释那个 rowDataSize<=256 的说法已不准确。
  rows: Array<{ id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
  authority?: string;
}
const paramPageCache = new Map<string, CachedParamDocument>();

/**
 * 全量 PARAM 缓存（用户裁定 2026-08-14）：loadAll 请求下经
 * `includeAllPayloads` 一次拿回全表 + 全部行字节，供 renderer 打开表即全量。
 * 与 paramPageCache 分开：全量缓存带字节、内存明显更大，写回失效时两处都要清。
 */
const paramAllCache = new Map<string, CachedParamDocument>();

/**
 * 容器内 param 子项解包后的落盘路径缓存。
 *
 * ── 为什么需要它 ──
 *
 * `read-param-document` 不解 DCX、不解 BND4：它 File.ReadAllBytes 后直接按裸
 * PARAM 布局解析。把 parambnd 容器路径喂进去会硬失败（实测
 * `PARAM_DOCUMENT_READ_FAILED: PARAM 类型名偏移无效`）—— 这是「打开
 * gameparam.parambnd.dcx 显示 0 行」的根因之一。
 *
 * 正确链路是三步：read-dcx-document 枚举条目 → extract-bnd4-child 解包到暂存区
 * → read-param-document 读裸 param。第二步此前只在 smoke 里用过，没有 IPC 出口，
 * 于是 UI 能列出 138 个 param 名却拿不到其中任何一个的字节。
 *
 * ── 为什么缓存路径而不是每次重解 ──
 *
 * 分页浏览会对同一个 param 反复读取（翻页、搜索、选行取字节）。每次都重解一遍
 * 138 项容器意味着每翻一页都要跑一次 DCX 解压，交互不可用。这里缓存解包后的
 * 落盘路径，键含容器哈希：容器变了（被写回、被替换）键就变，旧解包不会被误用。
 *
 * 不用 stageBridgeOutput：它用完即删暂存目录，而这里要的正是「跨多次调用存活」。
 * 落点仍是会话 storage 的 stagingRoot（main 拥有的可写根），不写 Mod 工作区。
 */
interface UnpackedParamChild {
  /** 解包后的裸 param 绝对路径。 */
  absolutePath: string;
  /** 容器内条目索引。 */
  entryIndex: number;
  /** 条目名（basename）。 */
  name: string;
  /**
   * 容器内该条目的**存储字节**哈希（read-dcx-document 报告的 contentHash）。
   *
   * 写回时必须原样回传给 write-bnd4 的 expectedChildHash —— C# 侧拿它比对容器
   * 内当前条目字节，这是并发保护：两个改动都基于同一份旧字节时，后一个会被
   * 拒绝而不是静默覆盖前一个。
   *
   * 注意它不等于解包产物的哈希：条目在容器里可能是压缩存储的。
   */
  storedContentHash: string;
}
const unpackedParamCache = new Map<string, UnpackedParamChild>();

type CachedContainerChildren = Awaited<
  ReturnType<typeof listContainerChildren>
>['children'];
const containerChildrenCache = new Map<string, CachedContainerChildren>();

/**
 * Classified script-container entry table keyed by sourceUri. Materialized
 * once in main and served as bounded pages so the renderer never holds the
 * full table. Enumeration uses the Bridge `read-dcx-document` command, which
 * returns the COMPLETE inner BND4 entry table (e.g. 301 entries for the real
 * luabnd) — `inventory-asset-resources` only samples entries, so it cannot
 * back a full-coverage page channel.
 */
interface CachedScriptContainerEntries {
  containerFormat: string;
  entryCount: number;
  entries: ScriptContainerEntryEvidence[];
  classificationSummary: Record<ScriptEntryClassification, number>;
  entriesComplete: boolean;
  diagnostics: StructuredDiagnostic[];
}
const scriptContainerEntriesCache = new Map<string, CachedScriptContainerEntries>();

function emptyScriptClassificationSummary(): Record<ScriptEntryClassification, number> {
  return {
    'lua-bytecode': 0,
    'luagnl': 0,
    'luainfo': 0,
    'esd-bytecode': 0,
    'hkx-bytecode': 0,
    'unknown': 0
  };
}

function summarizeScriptClassifications(
  entries: readonly ScriptContainerEntryEvidence[]
): Record<ScriptEntryClassification, number> {
  const summary = emptyScriptClassificationSummary();
  for (const entry of entries) {
    summary[entry.classification] += 1;
  }
  return summary;
}

/** Native BND4 entry fields surfaced by the Bridge `read-dcx-document` envelope. */
interface NativeBnd4EntryLike {
  index?: number;
  id?: number;
  name?: string;
  flags?: number;
  unknown?: number;
  duplicateOrdinal?: number;
  nameOffset?: number;
  dataOffset?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  contentHash?: string;
}

interface NativeBnd4DocumentLike {
  format?: string;
  entryCount?: number;
  entries?: NativeBnd4EntryLike[];
  authority?: string;
}

interface NativeDcxEnvelopeLike {
  format?: string;
  compressionFormat?: string;
  nested?: NativeBnd4DocumentLike;
}

/**
 * True when the file is a real (non-SFBN) BND3/BND4 binder or a DCX wrapper
 * (whose payload may be BND4). The TS container tree cannot enumerate these;
 * the native Bridge read-dcx-document command is the full-enumeration fallback.
 */
async function isRealNativeBndContainer(absolutePath: string): Promise<boolean> {
  try {
    const header = await readFile(absolutePath);
    const magic = header.subarray(0, 4).toString('ascii');
    if (magic.startsWith('BND3') || magic.startsWith('BND4')) {
      // Synthetic SFBN binders are enumerated by the TS reader; real BND has no
      // SFBN marker.
      return !header.subarray(4, 8).equals(Buffer.from('SFBN', 'ascii'));
    }
    return magic.startsWith('DCX');
  } catch {
    return false;
  }
}

/**
 * Load the complete container-child table for a paginated channel. Uses the TS
 * container tree (works for synthetic SFBN binders); when it returns zero
 * children for a real (non-SFBN) BND/DCX container, falls back to the native
 * Bridge full BND4 entry-table enumeration so real containers get complete
 * bounded access instead of an empty table (hard constraint 17).
 */
async function loadContainerChildrenTable(
  file: IndexedFile,
  sourceUri: string,
  recursive: boolean
): Promise<{ ok: boolean; children: CachedContainerChildren; diagnostics: StructuredDiagnostic[] }> {
  const result = await listContainerChildren(file.absolutePath, {
    relativePath: file.relativePath,
    recursive
  });
  if (!result.ok) return { ok: false, children: [], diagnostics: result.diagnostics };
  let children = result.children;
  if (children.length === 0 && await isRealNativeBndContainer(file.absolutePath)) {
    // The read/replace chain for real BND children remains TS-synthetic-only and
    // fails closed with structured diagnostics; enumeration is still honest.
    // ROOT-07：只读枚举只传已存在并 verified 的 roots，不附加 staging。
    let allowedRoots: string[] | null = null;
    if (activeSession) {
      const roots = await prepareBridgeRoots(
        bridgeRootSession(activeSession, durableStoragePaths(activeSession.meta.workspaceId)),
        'read'
      );
      if (!roots.ok) {
        return { ok: false, children: [], diagnostics: [bridgeRootsDiagnostic('BRIDGE_ROOT_MISSING', roots)] };
      }
      allowedRoots = [...roots.allowedRoots];
    }
    const native = await enumerateNativeContainerEntries(
      file.absolutePath,
      sourceUri,
      allowedRoots ?? [dirname(file.absolutePath)]
    );
    if (!native.ok) return { ok: false, children: [], diagnostics: native.diagnostics };
    children = native.children;
  }
  return { ok: true, children, diagnostics: [] };
}

/**
 * Enumerate the complete inner BND4 entry table of a real (non-synthetic)
 * container via the Bridge `read-dcx-document` command — the same
 * full-enumeration source as `listScriptContainerEntriesPage`. Entries are
 * projected to the renderer-safe container-child DTO; inner names are sanitized
 * to their basename (Sekiro BND4 names are absolute build-machine paths).
 * `canReplace=false` keeps the real-BND replace chain fail-closed (it is
 * TS-synthetic-only today); `rawBytesAvailable=true` because
 * snapshot-bnd4-child can read real child bytes.
 */
async function enumerateNativeContainerEntries(
  absolutePath: string,
  sourceUri: string,
  allowedRoots: string[]
): Promise<{
  ok: boolean;
  children: CachedContainerChildren;
  diagnostics: StructuredDiagnostic[];
}> {
  const result = await runBridge<NativeDcxEnvelopeLike>({
    command: 'read-dcx-document',
    filePath: absolutePath,
    resourceUri: `file:///${absolutePath.replace(/\\/g, '/')}`,
    allowedRoots,
    timeoutMs: 60_000
  });
  if (result.parseStatus === 'failed') {
    return { ok: false, children: [], diagnostics: result.diagnostics };
  }
  const nested = result.data?.nested;
  const entries = nested?.entries ?? [];
  if (entries.length === 0) {
    return {
      ok: true,
      children: [],
      diagnostics: [{
        severity: 'info',
        code: 'BND_NATIVE_ENUMERATION_EMPTY',
        message: 'Bridge 未返回原生 BND4 条目表（payload 可能不是 BND4）。',
        sourceUri
      }]
    };
  }
  const seen = new Set<string>();
  const children = entries.map((entry) => {
    const rawName = entry.name ?? `entry_${entry.index ?? 0}`;
    const name = sanitizeEntryName(rawName, entry.index ?? 0, seen);
    const extension = name.split('.').pop()?.toLowerCase() ?? 'unknown';
    return {
      childId: String(entry.index ?? 0),
      name,
      offset: entry.dataOffset ?? 0,
      size: entry.uncompressedSize ?? 0,
      ...(entry.compressedSize !== undefined && entry.compressedSize !== entry.uncompressedSize
        ? { compressedSize: entry.compressedSize }
        : {}),
      hash: entry.contentHash ?? '',
      formatKind: extension,
      sourceContainerUri: sourceUri,
      childUri: `${sourceUri}#bnd/child/${encodeURIComponent(name)}`,
      rawBytesAvailable: true,
      canReplace: false,
      diagnostics: []
    } satisfies CachedContainerChildren[number];
  });
  return {
    ok: true,
    children,
    diagnostics: [{
      severity: 'info',
      code: 'BND_NATIVE_ENUMERATION_COMPLETE',
      message: `原生 BND4 完整条目表已枚举：${entries.length} 项（${result.data?.compressionFormat ?? ''} 解包）。`,
      sourceUri
    }]
  };
}

/**
 * 把容器内某个 param 条目解包成可读的裸 `.param` 文件，返回其绝对路径。
 *
 * 这是「容器 → 内部 param 文件」那一跳的实现（见 unpackedParamCache 的注释）。
 * 解包产物落会话 stagingRoot，绝不写 Mod 工作区或原版目录。
 *
 * oodleRuntimeRoot 必须传：game-side 的 parambnd 是 KRAK 压缩，缺 Oodle 运行时
 * 连条目表都读不出（实测 `DCX_DOCUMENT_READ_FAILED: 尚未挂载 Sekiro 原版游戏
 * 目录；KRAK 只能进行原始字节读取，不能解压`）。mod-side 是 DFLT 不需要它，
 * 但用户迟早会打开 game-side，两者必须都能工作。
 */
async function unpackContainerParamChild(input: {
  containerPath: string;
  containerUri: string;
  containerHash: string;
  /** 条目索引，或条目名（basename，如 `AtkParam_Npc.param`）。 */
  entry: { index: number } | { name: string };
}): Promise<
  | { ok: true; child: UnpackedParamChild; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const storage = activeSession ? durableStoragePaths(activeSession.meta.workspaceId) : null;
  if (!activeSession || !storage) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'PARAM_UNPACK_NO_SESSION',
        message: '没有活动工作区会话，无法解包容器内 param（解包产物需要会话暂存区）。',
        sourceUri: input.containerUri
      }]
    };
  }

  // ROOT-07：解包需要 staging——mkdir → realpath → boundary check 后注册。
  const roots = await prepareBridgeRoots(bridgeRootSession(activeSession, storage), 'stage');
  if (!roots.ok) {
    return {
      ok: false,
      diagnostics: [bridgeRootsDiagnostic('PARAM_UNPACK_STAGING_PREPARE_FAILED', roots)]
    };
  }
  const allowedRoots = [...roots.allowedRoots];
  const oodle = activeSession.layers.baseRoot
    ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
    : {};

  // ── 第一步：枚举条目，把「名字」解析成索引 ──
  const dcx = await runBridge<NativeDcxEnvelopeLike>({
    command: 'read-dcx-document',
    filePath: input.containerPath,
    resourceUri: input.containerUri,
    allowedRoots,
    timeoutMs: 120_000,
    ...oodle
  });
  if (dcx.parseStatus === 'failed') {
    return { ok: false, diagnostics: sanitizeDiagnostics(dcx.diagnostics) };
  }
  const entries = dcx.data?.nested?.entries ?? [];
  if (entries.length === 0) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'PARAM_UNPACK_CONTAINER_EMPTY',
        message: 'Bridge 未返回容器内 BND4 条目表；该资源可能不是 param 容器。',
        sourceUri: input.containerUri
      }]
    };
  }

  const seen = new Set<string>();
  const named = entries.map((entry, position) => ({
    index: entry.index ?? position,
    name: sanitizeEntryName(entry.name ?? `entry_${position}`, entry.index ?? position, seen),
    storedContentHash: entry.contentHash ?? ''
  }));
  // 先把联合类型解到局部常量再比较：直接在回调里访问 input.entry.index
  // 拿不到窄化后的类型（回调边界会丢失 `'index' in` 的判别结果）。
  const wanted = input.entry;
  const target = 'index' in wanted
    ? named.find((candidate) => candidate.index === wanted.index)
    : named.find((candidate) => candidate.name === wanted.name);
  if (!target) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'PARAM_UNPACK_ENTRY_NOT_FOUND',
        message: `容器内没有匹配的 param 条目：${JSON.stringify(input.entry)}。`,
        sourceUri: input.containerUri
      }]
    };
  }

  // 缓存键含容器哈希：容器被写回后哈希变化，旧解包不会被误用。
  const cacheKey = `${input.containerUri}#${input.containerHash}#${target.index}`;
  const cachedChild = unpackedParamCache.get(cacheKey);
  // 缓存命中还要求条目哈希未变：容器被写回后条目内容会变，沿用旧的
  // storedContentHash 会让 write-bnd4 的并发保护形同虚设（拿一个过期哈希去比对，
  // 要么误拒要么放过本该拒绝的覆盖）。哈希不符时重新解包。
  if (cachedChild
    && cachedChild.storedContentHash === target.storedContentHash
    && existsSync(cachedChild.absolutePath)) {
    return {
      ok: true,
      child: cachedChild,
      diagnostics: [{
        severity: 'info',
        code: 'PARAM_UNPACK_CACHE_HIT',
        message: `复用已解包的 ${cachedChild.name}。`,
        sourceUri: input.containerUri
      }]
    };
  }

  // ── 第二步：解包到会话暂存区 ──
  //
  // 不用 stageBridgeOutput：它用完即删，而解包产物要跨多次分页调用存活。
  // 目录名含容器哈希前缀与条目索引，避免不同容器/条目互相覆盖。
  const unpackDirectory = join(
    storage.stagingRoot,
    'param-unpack',
    `${input.containerHash.slice(0, 16)}-${target.index}`
  );
  const outputPath = join(unpackDirectory, target.name);
  try {
    await mkdir(unpackDirectory, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'PARAM_UNPACK_STAGING_PREPARE_FAILED',
        message: `解包暂存目录创建失败：${error instanceof Error ? error.message : String(error)}`,
        sourceUri: input.containerUri
      }]
    };
  }

  const extracted = await runBridge({
    command: 'extract-bnd4-child',
    filePath: input.containerPath,
    resourceUri: input.containerUri,
    allowedRoots,
    // 写命令必须显式声明 main 拥有的可写根，否则 Bridge 报
    // BRIDGE_WRITABLE_ROOT_REQUIRED（实测）。只给 stagingRoot —— 解包永远
    // 不该能写到原版目录或 Mod 工作区。
    writableRoots: [storage.stagingRoot],
    timeoutMs: 120_000,
    commandOptions: { entryIndex: target.index, outputPath },
    ...oodle
  });
  if (extracted.parseStatus === 'failed' || !existsSync(outputPath)) {
    return {
      ok: false,
      diagnostics: [
        ...sanitizeDiagnostics(extracted.diagnostics),
        {
          severity: 'error',
          code: 'PARAM_UNPACK_EXTRACT_FAILED',
          message: `解包 ${target.name} 失败，未产出可读文件。`,
          sourceUri: input.containerUri
        }
      ]
    };
  }

  const child: UnpackedParamChild = {
    absolutePath: outputPath,
    entryIndex: target.index,
    name: target.name,
    storedContentHash: target.storedContentHash
  };
  unpackedParamCache.set(cacheKey, child);
  return {
    ok: true,
    child,
    diagnostics: [{
      severity: 'info',
      code: 'PARAM_UNPACK_COMPLETE',
      message: `已解包 ${target.name}（条目 ${target.index}/${entries.length}）。`,
      sourceUri: input.containerUri
    }]
  };
}

/** Inner BND4 entry row from the Bridge `read-dcx-document` command. */
interface ScriptDcxEntryLike {
  index?: number;
  id?: number;
  name?: string;
  flags?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  contentHash?: string;
}

interface ScriptDcxDocumentLike {
  format?: string;
  nested?: {
    format?: string;
    entryCount?: number;
    entries?: ScriptDcxEntryLike[];
    authority?: string;
  };
}

/** Bounded sample fallback from the Bridge `inventory-asset-resources` command. */
interface ScriptInventoryEntryLike {
  name?: string;
  index?: number;
  uncompressedSize?: number;
  compressedSize?: number;
  flags?: number;
  id?: number;
}

interface ScriptInventoryDataLike {
  format?: string;
  containerType?: string;
  entryCount?: number;
  entries?: ScriptInventoryEntryLike[];
  sampleEntries?: ScriptInventoryEntryLike[];
  extensionDistribution?: Record<string, number>;
  resourceKindDistribution?: Record<string, number>;
}

function clearEditorPageCaches(): void {
  fmgPageCache.clear();
  paramPageCache.clear();
  paramAllCache.clear();
  containerChildrenCache.clear();
  scriptContainerEntriesCache.clear();
}

/**
 * EMEDF 自动定位（同步、只读、有界）。
 *
 * R3/P4 裁定：事件源码必须是 DarkScript3 式（EMEDF 函数名），没 EMEDF 失败关闭。
 * T4 查找顺序（grok 2026-08-15 拍死）：
 * 1. SOULFORGE_EMEDF_PATH（显式覆盖）；
 * 2. 固定候选：本机 DarkScript3 事件编辑器发布包的真实落地
 *    `<tools>/事件编辑器3.4.1/Resources/sekiro-common.emedf.json`；
 * 3. 已挂载 baseRoot 兄弟 `tools/<一层子目录>/Resources/`（DarkScript3 发布包
 *    常规落地形态）；
 * 4. 已挂载 overlay 根向上两级（workspace 层）的兄弟 `tools/<一层>/Resources/`；
 * 5. SOULFORGE_SEKIRO_GAME_ROOT 同样扫兄弟 tools；
 * 6. 有界用户目录（Desktop/Documents/Downloads）。
 * 绝不递归整盘；找不到返回 null，由 resolveEmevdRegistry 失败关闭到 fixture。
 */
const EMEDF_RELATIVE_CANDIDATES = [
  'sekiro-common.emedf.json',
  'Sekiro/sekiro-common.emedf.json',
  'sekiro.emedf.json',
  'Resources/sekiro-common.emedf.json'
];

/** T4 固定候选：本机 DarkScript3 事件编辑器发布包真实落地（grok 已求证存在）。 */
const EMEDF_FIXED_CANDIDATES = [
  'D:\\mystream\\Sekiro Shadows Die Twice\\tools\\事件编辑器3.4.1\\Resources\\sekiro-common.emedf.json'
];

/**
 * 往 roots 追加某 gameRoot 兄弟 `tools/` 目录及其中一层子目录，供后续逐候选探测。
 * 找不到 tools/ 或不可读时静默跳过，不阻断其他候选。
 */
function pushToolsSubdirs(roots: string[], gameRoot: string | undefined): void {
  if (!gameRoot) return;
  const toolsDir = join(dirname(gameRoot), 'tools');
  try {
    roots.push(toolsDir);
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(toolsDir, entry.name));
    }
  } catch {
    // tools 目录不存在/不可读：跳过，继续其他候选。
  }
}

function locateUserEmedfSync(): string | null {
  const roots: string[] = [];
  // 1) 显式环境变量优先。
  const explicit = process.env.SOULFORGE_EMEDF_PATH?.trim();
  if (explicit) roots.push(resolve(explicit));
  // 2) 固定候选：DarkScript3 事件编辑器发布包的本机真实落地（整路径直接判存在）。
  for (const candidate of EMEDF_FIXED_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 继续下一个候选。
    }
  }
  // 3) 已挂载 baseRoot 的兄弟 tools/<一层子目录>。
  pushToolsSubdirs(roots, activeSession?.layers.baseRoot);
  // 4) 已挂载 overlay 根向上两级（workspace 层）的兄弟 tools/<一层>/Resources/。
  const overlay = activeSession?.layers.overlayRoot?.trim();
  if (overlay) pushToolsSubdirs(roots, dirname(dirname(overlay)));
  // 5) SOULFORGE_SEKIRO_GAME_ROOT 同样扫兄弟 tools。
  const gameRootEnv = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (gameRootEnv) pushToolsSubdirs(roots, gameRootEnv);
  // 6) 有界用户目录。
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home) {
    roots.push(join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads'));
  }
  for (const root of roots) {
    for (const relative of EMEDF_RELATIVE_CANDIDATES) {
      try {
        const candidate = join(root, relative);
        if (existsSync(candidate)) return candidate;
      } catch {
        // 继续下一个候选。
      }
    }
  }
  return null;
}

let cachedEmevdRegistry: ReturnType<typeof resolveEmevdRegistry> | null = null;
function getEmevdRegistry(): ReturnType<typeof resolveEmevdRegistry> {
  if (!cachedEmevdRegistry) {
    cachedEmevdRegistry = resolveEmevdRegistry(locateUserEmedfSync());
  }
  return cachedEmevdRegistry;
}
let handlersRegistered = false;
const trustedRendererDocuments = new Map<number, string>();
const directorySelections = new Map<string, DirectorySelectionRecord>();

/* ------------------------------------------------------------------ */
/*  §14.4 DocumentStore IPC（DOCSTORE-04）                             */
/*  renderer 只发逻辑引用；ownerKey 由 main 从 trusted webContents 与 */
/*  workspace session 派生，renderer 永远不能传入；locator 由 main     */
/*  probe 组装（含 outerSourceUri），永不出 main。                     */
/* ------------------------------------------------------------------ */

let editorDocumentStore: EditorDocumentStore | null = null;

/**
 * 惰性创建文档仓库。分页数据源与写链是骨架：由后续卡（PARAM-10B、TEXT-20B
 * 等）接入真实实现；未接入的查询/写入如实返回 capability-blocked /
 * mutation-rejected，不假装成功。
 */
function ensureEditorDocumentStore(): EditorDocumentStore {
  if (editorDocumentStore) return editorDocumentStore;
  const skeletonDataSource: EditorDocumentDataSource = {
    loadPage: async () => ({ items: null, nextCursor: null, totalKnown: null }),
    readContent: async () => null
  };
  const skeletonApplyPort: EditorMutationApplyPort = {
    apply: async () => ({ kind: 'rejected', code: 'WRITE_CHAIN_NOT_CONNECTED' })
  };
  editorDocumentStore = new EditorDocumentStore({
    ttlMs: 30 * 60_000,
    dataSource: skeletonDataSource,
    applyPort: skeletonApplyPort
  });
  return editorDocumentStore;
}

/**
 * ownerKey 绑定「会话 + 窗口」：另一窗口（webContents）即使猜中 handle 也
 * 得到 owner-mismatch；重新扫描工作区（activeWorkspaceSessionId 更换）后
 * 旧 handle 全部失效——这正是 cross-sender rejection 的实现点。
 */
function deriveDocumentOwnerKey(event: IpcMainInvokeEvent): string {
  return createHash('sha256')
    .update(`${activeWorkspaceSessionId ?? 'no-session'}:${event.sender.id}`)
    .digest('hex');
}

/** §4.3 域 → 资源 kind 的粗粒度匹配（CAT-05 的 Catalog 校验落地后替换）。 */
const DOMAIN_RESOURCE_KINDS: Record<string, readonly string[]> = {
  param: ['param', 'container'],
  gparam: ['param', 'container'],
  container: ['container', 'param'],
  text: ['msg'],
  event: ['event'],
  script: ['script'],
  map: ['map'],
  model: ['model'],
  texture: ['texture'],
  material: ['material'],
  vfx: ['vfx'],
  behavior: ['behavior'],
  animation: ['animation']
};

function editorDocumentFailure(
  code: EditorDocumentErrorCode,
  retryable: boolean
): EditorDocumentResult<never> {
  return { ok: false, code, retryable };
}
const here = dirname(fileURLToPath(import.meta.url));
const sqliteNativeBindingPath = app.isPackaged
  ? join(process.resourcesPath, 'native', 'better_sqlite3.node')
  : resolve(here, '../../.native/better_sqlite3.node');
const operationLogUtility = new OperationLogUtilityClient(
  join(here, 'databaseUtility.js'),
  15_000,
  sqliteNativeBindingPath
);
const modelServiceVault = new ModelServiceCredentialVault(app.getPath('userData'));

const toolRegistry = createDefaultToolRegistry();
// P0 authority: renderer cannot elevate this value. Persistent per-model-service
// grants replace this constant in P6; until then the desktop is plan-only.
const activeAiMode: ToolContext['mode'] = 'plan';

export interface AnalyzeWorkspaceSummary {
  parsedFiles: number;
  inspectedFiles: number;
  referenceStats: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers: number;
  };
  diagnostics: Diagnostic[];
  events: Array<{ uri: string; eventId: number; name?: string }>;
  tools: ToolDescriptor[];
}

export interface RendererWorkspaceSession {
  workspaceSessionId: string;
  workspaceLabel: string;
  game: string;
  openedAt: string;
  baseMounted: boolean;
  baseLabel?: string;
}

export interface RendererWorkspaceScanResult {
  workspaceSessionId: string;
  workspaceLabel: string;
  files: RendererIndexedFile[];
  countsByKind: Record<ResourceKind, number>;
  diagnostics: Diagnostic[];
  session: RendererWorkspaceSession;
}

export interface RollbackOperationIpcResult {
  ok: boolean;
  opId: string;
  inverseOpId?: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
}

/* ------------------------------------------------------------------ */
/*  AI agent session IPC contract (Codex-derived kernel).             */
/*  Keys never cross the bridge; events are redacted by the host.     */
/* ------------------------------------------------------------------ */

export interface AiAgentRunRequest {
  configId: string;
  prompt: string;
  mode?: 'plan' | 'normal' | 'fullPermission';
  streaming?: boolean;
  /** Session-relative rollout path as returned by ai.agent.sessions. */
  resumeSessionPath?: string;
  /**
   * Per-model-call timeout. Before this was exposed, the loop ran with no
   * timeout at all: a provider that accepted the connection and then stalled
   * left the session running until the user cancelled it by hand.
   */
  timeoutMs?: number;
  /** Step ceiling. The loop's own default is 8 when unset. */
  maxSteps?: number;
  /** Total output token budget across all steps; the loop stops when exceeded. */
  maxTotalOutputTokens?: number;
  /**
   * Auto-compaction trigger in estimated context tokens. Compaction is
   * implemented but never fired in production, because reaching it requires
   * this value and nothing supplied one.
   */
  autoCompactTokenLimit?: number;
  /** Retry attempts for model calls; the loop defaults to 4 when unset. */
  retryMaxAttempts?: number;
  /** Assemble workspace evidence into bounded context before each model call. */
  useContextBroker?: boolean;
  /** Byte ceiling for Context Broker output; ignored unless useContextBroker. */
  contextMaxBytes?: number;
  /**
   * Permission levels that require user approval. Omit for the loop's default
   * (stage/commit/rollback/write). An explicit empty array disables approval,
   * which main refuses outside plan mode — see the handler.
   */
  approvalRequiredLevels?: string[];
  /**
   * main-issued opaque resource references (§12.11 SubmitAgentRunRequest)。
   *
   * AGENT-60D 提交期消费点：每个 token 必须已在 agentReferenceRegistry 签发，
   * 且 ownerId 与当前 sender 一致（跨 sender 拒绝）。未传或空数组 = 无引用。
   */
  resources?: readonly AgentResourceReference[];
}

/** Renderer's answer to one approval request (ai.agent.approval.respond). */
export interface AiAgentApprovalResponseRequest {
  sessionId: string;
  callId: string;
  decision: ApprovalDecision;
  note?: string;
}

export type AiAgentRunIpcResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: { code: string; message: string } };

export interface AiAgentSessionSummaryIpc {
  /** Path relative to the agent sessions dir; opaque to the renderer. */
  sessionPath: string;
  fileName: string;
  sessionId: string | null;
  startedAt: string | null;
  messageCount: number;
  parseErrors: number;
  interrupted: boolean;
  compactedWindows: number;
  sizeBytes: number;
  modifiedAt: string;
}

export type AiAgentSessionListIpcResult =
  | { ok: true; sessions: AiAgentSessionSummaryIpc[] }
  | { ok: false; error: { code: string; message: string } };

export type AiAgentSessionLoadIpcResult =
  | {
      ok: true;
      meta: RolloutSessionMeta | null;
      messageCount: number;
      parseErrors: number;
      interrupted: boolean;
      compactedWindows: number;
      /** Bounded tail page (hard constraint 17). */
      messagesPage: ChatMessage[];
    }
  | { ok: false; error: { code: string; message: string } };

export type AiAgentSessionLifecycleEvent =
  | { type: 'session-accepted'; mode: 'plan' | 'normal' | 'fullPermission' }
  | { type: 'session-done'; finishReason: string; steps: number; rolloutFileName: string }
  | { type: 'session-error'; code: string; message: string };

/** Envelope pushed on the 'ai:agent:event' channel. */
export interface AiAgentEventEnvelope {
  sessionId: string;
  /**
   * §12.11 严格递增 seq：同一 session 的推送必须严格递增。main 侧按 session 单调
   * 盖章，renderer 侧对重复 / 倒序 seq 丢弃并记诊断（见 shared agent-ui 的
   * applyAgentStreamSeq / reduceAgentStreamToMessages）。
   */
  seq: number;
  event: AgentEvent | AiAgentSessionLifecycleEvent;
}

/** §12.11 资源引用 token 校验结果（agent 通道专用；不是 param/format 读取）。 */
export type AgentResourceReferenceCreateIpcResult =
  | { ok: true; reference: AgentResourceReference }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        diagnostics?: readonly { code: string; path: string; message: string }[];
      };
    };

export interface DirectorySelection {
  selectionId: string;
  label: string;
}

export interface OpenWorkspaceScanOptions {
  overlaySelectionId: string;
  baseSelectionId?: string;
}

interface DirectorySelectionRecord extends DirectorySelection {
  absolutePath: string;
  kind: 'overlay' | 'base';
  ownerWebContentsId: number;
  expiresAt: number;
}

function legacyOperationLogPathForWorkspace(workspaceId: string): string {
  // workspaceId is a file:// URL from makeWorkspaceId; never join it raw into a Windows path.
  return resolveOperationLogStorePath(join(app.getPath('userData'), 'operation-logs'), workspaceId);
}

async function ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient> {
  const storage = workspaceStoragePaths(session.meta.workspaceId);
  await operationLogUtility.openWorkspace({
    appDatabasePath: join(app.getPath('userData'), 'app.db'),
    databasePath: join(storage.root, 'workspace.db'),
    workspaceId: session.meta.workspaceId,
    rootPath: session.layers.overlayRoot,
    game: session.meta.game,
    legacyOperationLogPath: legacyOperationLogPathForWorkspace(session.meta.workspaceId),
    legacyBackupDirectory: join(storage.root, 'legacy-operation-logs'),
    legacySemanticSnapshotPath: join(session.layers.overlayRoot, 'semantic-snapshot.json'),
    legacySemanticBackupDirectory: join(storage.root, 'legacy-semantic-snapshots')
  });
  const cleanupPlan = await operationLogUtility.planRecoveryCleanup();
  const cleanup = await executeRecoveryCleanup({
    plan: cleanupPlan,
    allowedRoots: [storage.backupBaseDir, storage.recoveryDir],
    store: operationLogUtility
  });
  if (cleanup.rejected.length > 0) {
    process.stderr.write(`[SoulForge recovery cleanup] ${JSON.stringify(cleanup.rejected)}\n`);
  }
  activeOperationLog = operationLogUtility;
  return operationLogUtility;
}

function workspaceStoragePaths(workspaceId: string): {
  root: string;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
} {
  const safeWorkspaceKey = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  const root = join(localApplicationDataRoot(), 'workspaces', safeWorkspaceKey);
  return {
    root,
    backupBaseDir: join(root, 'backups'),
    recoveryDir: join(root, 'recovery'),
    stagingRoot: join(root, 'staging')
  };
}

function localApplicationDataRoot(): string {
  if (process.platform === 'win32') {
    return join(dirname(app.getPath('appData')), 'Local', 'SoulForge');
  }
  return join(app.getPath('userData'), 'local-data');
}

function durableStoragePaths(workspaceId: string): {
  root: string;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
} {
  return workspaceStoragePaths(workspaceId);
}

/**
 * ROOT-07（front-end.md §13.2）：Bridge 调用的 allowed-root 生命周期入口。
 * 所有 Bridge production handler 复用；不得再向 Bridge 传递未经验证的路径。
 */
function bridgeRootSession(session: WorkspaceSession, storage: { root: string }): BridgeRootSession {
  return {
    overlayRoot: session.layers.overlayRoot,
    baseRoot: session.layers.baseRoot ?? null,
    storageRoot: storage.root
  };
}

/**
 * §13.3：Bridge 拒绝「Every allowed root must be an existing directory.」时，
 * 转换为可行动 Problems（操作提示），不得把原始技术消息当唯一输出。
 */
function bridgeRootsDiagnostic(code: string, result: Extract<PrepareBridgeRootsResult, { ok: false }>): Diagnostic {
  return {
    severity: 'error',
    code,
    message: `${result.message}。操作：重试 / 打开 Problems / 检查工作区存储权限。`,
    ...(result.details !== undefined ? { details: result.details } : {})
  };
}

/**
 * ROOT-07：只读调用入口。返回已验证存在的 overlay/base roots；无 session 时
 * 退回调用方 fallback（只读枚举的真实路径），不附加 staging、不创建目录。
 */
async function verifiedReadRoots(
  session: WorkspaceSession | null,
  fallback: string
): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }> {
  if (!session) return { allowedRoots: [fallback], diagnostics: [] };
  const roots = await prepareBridgeRoots(
    bridgeRootSession(session, durableStoragePaths(session.meta.workspaceId)),
    'read'
  );
  if (!roots.ok) return { allowedRoots: [], diagnostics: [bridgeRootsDiagnostic('BRIDGE_ROOT_MISSING', roots)] };
  return { allowedRoots: [...roots.allowedRoots], diagnostics: [] };
}

/**
 * TEXT-20A：`read-text-catalog` 的 Bridge envelope。语言/容器 typed ID 由 Bridge
 * 产出；renderer 只消费 catalog 层，不接触 msg/ 路径。
 */
interface TextCatalogEnvelope {
  format?: string;
  confirmedBy?: string;
  languageId: string;
  containerKind: string;
  containerId: string;
  containerRole?: string;
  outerCompression?: string;
  outerHash?: string;
  tableCount: number;
  tables: Array<{
    stableId: string;
    entryIndex: number;
    entryName: string;
    entryCount: number;
    formatVersion?: number;
  }>;
  entries?: Array<{ id: number; text: string }>;
  tableSourceHash?: string;
  authority?: string;
}

async function readTextCatalogViaBridge(input: {
  sourcePath: string;
  allowedRoots: string[];
  tableEntryIndex?: number;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  data?: TextCatalogEnvelope;
  diagnostics: Diagnostic[];
}> {
  const result = await runBridge<TextCatalogEnvelope>({
    command: 'read-text-catalog',
    filePath: input.sourcePath,
    allowedRoots: input.allowedRoots,
    timeoutMs: input.timeoutMs ?? 60_000,
    ...(input.tableEntryIndex !== undefined
      ? { commandOptions: { tableEntryIndex: input.tableEntryIndex } }
      : {})
  });
  return {
    ok: result.parseStatus !== 'failed' && Boolean(result.data?.languageId),
    ...(result.data ? { data: result.data } : {}),
    diagnostics: result.diagnostics
  };
}

/**
 * 目录层语言/容器 typed ID 的 fallback 推导。只在 Bridge 读取失败时使用——
 * 主路径始终以 Bridge `read-text-catalog` 的 metadata 为准；这里仅把失败容器
 * 安放进正确的语言/容器槽位，避免「读取失败」被静默吞掉或伪装成空表。
 * normalized key：ASCII lower-case + `-` 分隔（front-end.md §4.4）。
 */
function deriveTextContainerHint(relativePath: string): { languageId: string; containerKind: string } {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  const fileName = segments[segments.length - 1] ?? '';
  let containerKind = fileName.toLowerCase();
  for (const suffix of ['.msgbnd.dcx', '.msgbnd']) {
    if (containerKind.endsWith(suffix)) {
      containerKind = containerKind.slice(0, -suffix.length);
      break;
    }
  }
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '');
  return {
    languageId: segments.length >= 2 ? normalize(segments[segments.length - 2] ?? '') : '',
    containerKind: normalize(containerKind)
  };
}

interface TextContainerNode {
  containerId: string;
  containerKind: string;
  sourceUri: string;
  relativePath: string;
  parseStatus: 'confirmed' | 'failed';
  tableCount: number;
  tables: Array<{
    tableId: string;
    entryName: string;
    entryCount: number;
    sourceUri: string;
    entryIndex: number;
  }>;
  diagnostics: Diagnostic[];
}

export interface TextCatalogResponse {
  ok: boolean;
  libraryId: 'game-text';
  title: string;
  languages: Array<{
    languageId: string;
    containers: TextContainerNode[];
  }>;
  diagnostics: Diagnostic[];
}

/**
 * ROOT-07：staging 调用入口。mkdir → realpath → boundary check 后返回
 * allowed/writable roots；失败返回 §13.3 可行动结构化诊断。
 */
async function verifiedStageRoots(
  session: WorkspaceSession,
  storage: { root: string },
  code: string
): Promise<{ allowedRoots: string[]; writableRoots: string[]; diagnostics: Diagnostic[] }> {
  const roots = await prepareBridgeRoots(bridgeRootSession(session, storage), 'stage');
  if (!roots.ok) {
    return { allowedRoots: [], writableRoots: [], diagnostics: [bridgeRootsDiagnostic(code, roots)] };
  }
  return { allowedRoots: [...roots.allowedRoots], writableRoots: [...roots.writableRoots], diagnostics: [] };
}

function rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null {
  if (activeSession?.meta.game === 'sekiro' && file?.game === 'sekiro') return null;
  return {
    ok: false,
    changedFiles: [],
    diagnostics: [{
      severity: 'error',
      code: 'NATIVE_WRITE_GAME_UNSUPPORTED',
      message: '当前工作区不是 Sekiro 游戏适配包，已阻断原生语义写入。',
      sourceUri
    }]
  };
}

/**
 * 阻断已延期至 V0.6、仅保留标记只读预览的编辑器写入。
 * 门禁点放在 IPC 主进程而非 renderer：即使 UI 仍持有旧的提交入口，
 * 写路径也在进入 Patch Engine 之前失败关闭，并返回结构化诊断。
 */
function rejectDeferredPreviewEditorWrite(
  editorKind: EditorKind,
  sourceUri: string
): RendererSaveResult | null {
  if (!isDeferredPreviewEditor(editorKind)) return null;
  return {
    ok: false,
    changedFiles: [],
    diagnostics: [{
      severity: 'error',
      code: 'EDITOR_DEFERRED_TO_V06_READONLY',
      message: `${editorKind} 编辑器已延期至 V0.6，本版仅提供标记只读预览，写入已阻断。`,
      sourceUri
    }]
  };
}

export async function disposeOperationLogUtility(): Promise<void> {
  activeOperationLog = null;
  await operationLogUtility.dispose();
}

function handle<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel);
    const result = await listener(event, ...(args as Args));
    return sanitizeRendererValue(result);
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  const expectedDocument = trustedRendererDocuments.get(event.sender.id);
  const frame = event.senderFrame;
  const actualDocument = frame ? normalizeRendererDocumentUrl(frame.url) : null;
  if (!expectedDocument
    || !frame
    || frame !== event.sender.mainFrame
    || actualDocument !== expectedDocument) {
    throw new Error(`已拒绝不受信任的 IPC 调用：${channel}`);
  }
}

function normalizeRendererDocumentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

function createDirectorySelection(
  event: IpcMainInvokeEvent,
  absolutePath: string,
  kind: DirectorySelectionRecord['kind']
): DirectorySelection {
  const selection: DirectorySelectionRecord = {
    selectionId: randomUUID(),
    label: basename(absolutePath) || (kind === 'overlay' ? 'Mod 工作区' : '原版游戏目录'),
    absolutePath,
    kind,
    ownerWebContentsId: event.sender.id,
    expiresAt: Date.now() + 5 * 60_000
  };
  directorySelections.set(selection.selectionId, selection);
  return { selectionId: selection.selectionId, label: selection.label };
}

function consumeDirectorySelection(
  event: IpcMainInvokeEvent,
  selectionId: string,
  expectedKind: DirectorySelectionRecord['kind']
): DirectorySelectionRecord {
  const selection = directorySelections.get(selectionId);
  directorySelections.delete(selectionId);
  if (!selection
    || selection.kind !== expectedKind
    || selection.ownerWebContentsId !== event.sender.id
    || selection.expiresAt < Date.now()) {
    throw new Error('目录选择凭据无效、已过期或不属于当前窗口。');
  }
  return selection;
}

async function requestWriteConfirmation(input: {
  event: IpcMainInvokeEvent;
  resourceLabel: string;
  sourceUri: string;
  actionLabel: string;
  payloadHash: string;
  extraSubjects?: string[];
}): Promise<ConfirmationReceipt | null> {
  if (!activeWorkspaceSessionId) return null;
  const parent = BrowserWindow.fromWebContents(input.event.sender);
  const options = {
    type: 'warning' as const,
    title: '确认高风险写入',
    message: `确认${input.actionLabel}“${input.resourceLabel}”吗？`,
    detail: '操作将只通过补丁引擎写入 Mod 覆盖层，并执行验证、备份和可回滚检查。原生格式证据不足时仍会阻断。',
    buttons: ['取消', '继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const decision = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (decision.response !== 1) return null;
  return createConfirmationReceipt({
    subjects: [
      'MAIN_NATIVE_DIALOG_CONFIRMED',
      input.sourceUri,
      'ALL_RISKS',
      `WORKSPACE_SESSION:${activeWorkspaceSessionId}`,
      `PATCH_HASH:${input.payloadHash}`,
      `NONCE:${randomUUID()}`,
      ...(input.extraSubjects ?? [])
    ],
    riskLevel: 'high',
    sourceUri: input.sourceUri,
    note: '由 Electron main 原生确认对话框签发的一次写入确认'
  });
}

function cancelledWrite(sourceUri: string): RendererSaveResult {
  return {
    ok: false,
    changedFiles: [],
    requiresConfirmation: true,
    diagnostics: [{
      severity: 'warning',
      code: 'WRITE_CONFIRMATION_CANCELLED',
      message: '用户取消了高风险写入。',
      sourceUri
    }]
  };
}

/**
 * 把 Electron 原生确认对话框适配成 core 的 WriteConfirmationPort。
 *
 * core 不能依赖 electron（否则 core 单元测试要跑在 Electron 里），所以确认在
 * core 侧是能力而非实现，这里是它唯一的生产实现。
 */
function electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort {
  return {
    requestConfirmation: (input) => requestWriteConfirmation({ event, ...input })
  };
}

/**
 * 把 Patch Engine 的 saveRawReplace 适配成 core 的 RawReplaceCommitPort，
 * 绑定当前会话的持久化路径与操作日志。
 *
 * 会话与操作日志在这里绑定而不是由 core 传入，是因为它们是主进程生命周期
 * 状态；core 只需要「提交这段字节」的能力。所有 Mod 资源写入仍然只经由
 * saveRawReplace → PatchIR → WorkspaceTransaction，本适配器不绕过任何环节。
 */
function sessionCommitPort(
  session: WorkspaceSession,
  operationLog: OperationLogUtilityClient,
  storage: { backupBaseDir: string; recoveryDir: string }
): RawReplaceCommitPort {
  return {
    commit: (input) => saveRawReplace({
      file: input.file,
      expectedHash: input.expectedHash,
      newContentBase64: input.newContentBase64,
      title: input.title,
      ...(input.confirmation ? { confirmation: input.confirmation } : {}),
      session,
      operationLog,
      backupBaseDir: storage.backupBaseDir,
      recoveryDir: storage.recoveryDir
    })
  };
}

/**
 * 把 core 写链结果转成 renderer DTO。取消是正常结果，不能报成故障。
 */
function toSaveResultFromOutcome(
  outcome: NativeMutationOutcome,
  files: IndexedFile[]
): RendererSaveResult {
  if (outcome.status === 'cancelled') return cancelledWrite(outcome.sourceUri);
  if (outcome.status === 'failed') {
    return { ok: false, changedFiles: [], diagnostics: outcome.diagnostics };
  }
  return toRendererSaveResult(outcome.result, files);
}

export function registerIpcHandlers(webContents: WebContents, rendererDocumentUrl: string): void {
  const normalizedDocument = normalizeRendererDocumentUrl(rendererDocumentUrl);
  if (!normalizedDocument) {
    throw new Error('IPC_TRUSTED_RENDERER_URL_INVALID');
  }
  trustedRendererDocuments.set(webContents.id, normalizedDocument);
  webContents.once('destroyed', () => {
    trustedRendererDocuments.delete(webContents.id);
    for (const [selectionId, selection] of directorySelections) {
      if (selection.ownerWebContentsId === webContents.id) directorySelections.delete(selectionId);
    }
  });
  if (handlersRegistered) return;
  handlersRegistered = true;

  /**
   * §14.4 document.open：renderer 发送逻辑引用，main 从当前活动索引解析出
   * 资源 → Bridge probe 确认格式栈 → 组装 main-only locator → 打开
   * owner-bound 文档。open 是六通道中唯一做 native 探针的；page/readContent/
   * apply 只认 opaque handle。「引用与活动 Catalog 精确匹配」在 CAT-05 落地
   * 前用索引(sourceUri + 域)近似，如实标注。
   */
  handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.open,
    async (event, rawRequest: unknown): Promise<EditorDocumentResult<OpenEditorDocumentValue>> => {
      const request = decodeOpenEditorDocumentRequest(rawRequest);
      const ownerKey = deriveDocumentOwnerKey(event);
      if (!activeSession || !activeWorkspaceSessionId) {
        return editorDocumentFailure('runtime-blocked', true);
      }
      const file = indexedFiles.find((item) => item.sourceUri === request.document.resourceId);
      if (!file) return editorDocumentFailure('not-found', false);
      const allowedKinds = DOMAIN_RESOURCE_KINDS[request.document.domain] ?? [];
      if (!allowedKinds.includes(file.resourceKind)) return editorDocumentFailure('not-found', false);

      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      // ROOT-07：locator probe 可能解包 DCX 到 staging——先 mkdir/realpath/
      // boundary 验证再注册，绝不把不存在的目录交给 Bridge。
      const roots = await prepareBridgeRoots(bridgeRootSession(activeSession, storage), 'stage');
      if (!roots.ok) return editorDocumentFailure('runtime-blocked', true);
      const probe = await runBridge<BridgeDocumentLocatorValue>({
        command: 'probe-document-locator',
        filePath: file.absolutePath,
        resourceUri: file.sourceUri,
        allowedRoots: [...roots.allowedRoots],
        ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {}),
        timeoutMs: 60_000
      });
      if (probe.parseStatus === 'failed' || probe.data === undefined) {
        return editorDocumentFailure('native-open-failed', false);
      }
      const outcome = buildNativeDocumentLocator({
        outerResourceId: probe.data.outerResourceId,
        outerSourceUri: file.sourceUri,
        sourceVariant: 'overlay',
        expectedOuterRevision: file.sha256 ? `scan:${file.sha256.slice(0, 16)}` : 'scan:unknown',
        bridgeValue: probe.data
      });
      if (outcome.kind === 'blocked') return editorDocumentFailure('runtime-blocked', true);
      if (outcome.kind !== 'confirmed') return editorDocumentFailure('native-open-failed', false);
      return toRendererEditorDocumentResult(await ensureEditorDocumentStore().open(ownerKey, outcome.locator));
    }
  );

  handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.get,
    async (event, documentHandle: string): Promise<EditorDocumentResult<OpenEditorDocumentValue>> => {
      if (typeof documentHandle !== 'string' || documentHandle.length === 0) {
        return editorDocumentFailure('invalid-request', false);
      }
      return toRendererEditorDocumentResult(
        await ensureEditorDocumentStore().get(deriveDocumentOwnerKey(event), documentHandle)
      );
    }
  );

  handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.page,
    async (event, rawRequest: unknown): Promise<EditorDocumentResult<EditorDocumentPageValue>> => {
      const request = decodePageEditorDocumentRequest(rawRequest);
      return toRendererEditorDocumentResult(
        await ensureEditorDocumentStore().page(deriveDocumentOwnerKey(event), request)
      );
    }
  );

  handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.readContent,
    async (event, rawRequest: unknown): Promise<EditorDocumentResult<EditorContentValue>> => {
      const request = decodeReadEditorContentRequest(rawRequest);
      return toRendererEditorDocumentResult(
        await ensureEditorDocumentStore().readContent(deriveDocumentOwnerKey(event), request)
      );
    }
  );

  handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.apply,
    async (event, rawRequest: unknown): Promise<EditorDocumentResult<ApplyEditorMutationValue>> => {
      const request = decodeApplyEditorMutationRequest(rawRequest);
      return toRendererEditorDocumentResult(
        await ensureEditorDocumentStore().apply(deriveDocumentOwnerKey(event), request)
      );
    }
  );

  handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.close,
    async (event, documentHandle: string): Promise<EditorDocumentResult<{ closed: true }>> => {
      if (typeof documentHandle !== 'string' || documentHandle.length === 0) {
        return editorDocumentFailure('invalid-request', false);
      }
      return toRendererEditorDocumentResult(
        await ensureEditorDocumentStore().close(deriveDocumentOwnerKey(event), documentHandle)
      );
    }
  );

  handle('runtime.detectMe3', async () => {
    const adapter = new Me3RuntimeAdapter({
      gateway: new MainMe3RuntimeGateway({ localDataRoot: localApplicationDataRoot() }),
      versionPolicy: {
        policyId: 'soulforge.me3-v0_12_1',
        supportedVersions: ['0.12.1']
      }
    });
    return await adapter.detect({ timeoutMs: 5_000 });
  });

  // Shared runtime adapter instance for profile/launch/terminate lifecycle
  let runtimeAdapter: Me3RuntimeAdapter | null = null;
  let runtimeGateway: MainMe3RuntimeGateway | null = null;
  function ensureRuntimeAdapter(): Me3RuntimeAdapter {
    if (!runtimeAdapter) {
      runtimeGateway = new MainMe3RuntimeGateway({ localDataRoot: localApplicationDataRoot() });
      runtimeAdapter = new Me3RuntimeAdapter({
        gateway: runtimeGateway,
        versionPolicy: {
          policyId: 'soulforge.me3-v0_12_1',
          supportedVersions: ['0.12.1']
        }
      });
    }
    return runtimeAdapter;
  }

  handle('runtime.prepareMe3Profile', async () => {
    if (!activeSession || !activeWorkspaceSessionId) {
      return {
        ok: false,
        status: 'failed' as const,
        authority: 'unverified' as const,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RUNTIME_NO_WORKSPACE',
          message: '需要已打开的工作区才能准备 me3 配置文件。'
        }]
      };
    }
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.prepareProfile(
      { workspaceSessionId: activeWorkspaceSessionId, game: 'sekiro' },
      { timeoutMs: 30_000 }
    );
    return sanitizeRendererValue(result);
  });

  handle('runtime.launchMe3', async (_event, profileId: string) => {
    if (!activeWorkspaceSessionId) {
      return {
        ok: false,
        status: 'failed' as const,
        authority: 'unverified' as const,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RUNTIME_NO_WORKSPACE',
          message: '需要已打开的工作区才能启动 me3。'
        }]
      };
    }
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.launch(
      {
        profile: {
          profileId,
          workspaceSessionId: activeWorkspaceSessionId,
          game: 'sekiro',
          profileVersion: 'v1',
          contentSha256: ''
        }
      },
      { timeoutMs: 15_000 }
    );
    return sanitizeRendererValue(result);
  });

  handle('runtime.terminateMe3', async (_event, sessionId: string) => {
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.terminate(
      {
        sessionId,
        game: 'sekiro',
        state: 'running',
        startedAt: new Date().toISOString(),
        diagnostics: []
      },
      { timeoutMs: 10_000 }
    );
    return sanitizeRendererValue(result);
  });

  /*
   * 两个目录对话框都从「上次打开的位置」起步。
   *
   * 此前不传 defaultPath，每次都从系统默认位置开始 —— 而 Mod 工作区通常埋在
   * …\Sekiro\mods\<某个 mod> 这样的深路径里，每次要重新点进去。
   * Mod 工作区与原版目录分开记：两者是不同位置，且原版目录几乎不变而工作区
   * 常换，合并成一个「上次目录」会让选原版目录时跳到某个 mod 文件夹。
   *
   * 记住的只是对话框起始位置，不授予任何访问权限 —— 读写边界仍由会话的
   * allowedRoots / writableRoots 决定。
   */
  const recentPathsFile = join(app.getPath('userData'), 'recent-paths.json');

  /**
   * 上次工作区的目录选择凭据，供启动时自动挂载。
   *
   * ── 为什么要签发凭据而不是直接返回路径 ──
   *
   * workspace.scan 只接受 selectionId：那是一次性凭据（绑定窗口 id + 5 分钟过期），
   * 目的是让「渲染器能扫哪个目录」由主进程裁定而不是渲染器自报路径。
   * 自动挂载必须走同一条路 —— 让渲染器传路径去扫，等于把这道裁定作废。
   *
   * ── 只对用户选过的路径签发 ──
   *
   * recent-paths.json 里的值只在 openDialog / openBaseDialog 成功返回后写入，
   * 也就是**用户亲手在系统对话框里选过**。这里不接受任何入参，因此渲染器无法
   * 借它让主进程签发一个任意路径的凭据。
   *
   * 目录已不存在时 readRecentPath 返回 undefined（外置盘拔了、mod 被删），
   * 此处如实返回 null，界面回落到空工作区 —— 自动挂载是便利，不该在路径失效时
   * 变成启动失败。
   */
  handle('workspace.lastSelection', async (event): Promise<{
    overlay: DirectorySelection | null;
    base: DirectorySelection | null;
  }> => {
    const overlayPath = readRecentPath(recentPathsFile, 'overlay');
    const basePath = readRecentPath(recentPathsFile, 'base');
    return {
      overlay: overlayPath ? createDirectorySelection(event, overlayPath, 'overlay') : null,
      base: basePath ? createDirectorySelection(event, basePath, 'base') : null
    };
  });

  handle('workspace.openDialog', async (event): Promise<DirectorySelection | null> => {
    const remembered = readRecentPath(recentPathsFile, 'overlay');
    const result = await dialog.showOpenDialog({
      title: '打开 Mod 工作区',
      properties: ['openDirectory'],
      ...(remembered ? { defaultPath: remembered } : {})
    });

    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (selectedPath) writeRecentPath(recentPathsFile, 'overlay', selectedPath);
    return selectedPath ? createDirectorySelection(event, selectedPath, 'overlay') : null;
  });

  handle('workspace.openBaseDialog', async (event): Promise<DirectorySelection | null> => {
    const remembered = readRecentPath(recentPathsFile, 'base');
    const result = await dialog.showOpenDialog({
      title: '打开原版游戏目录（只读，可选）',
      properties: ['openDirectory'],
      ...(remembered ? { defaultPath: remembered } : {})
    });

    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (selectedPath) writeRecentPath(recentPathsFile, 'base', selectedPath);
    return selectedPath ? createDirectorySelection(event, selectedPath, 'base') : null;
  });

  handle(
    'workspace.scan',
    async (
      event,
      options: OpenWorkspaceScanOptions
    ): Promise<RendererWorkspaceScanResult> => {
      const overlaySelection = consumeDirectorySelection(event, options.overlaySelectionId, 'overlay');
      const baseSelection = options.baseSelectionId
        ? consumeDirectorySelection(event, options.baseSelectionId, 'base')
        : undefined;

      if (activeSession) await disposeBridgeDaemonPool();
      activeSession = await openWorkspaceSession({
        overlayRoot: overlaySelection.absolutePath,
        ...(baseSelection ? { baseRoot: baseSelection.absolutePath } : {}),
        game: 'sekiro'
      });
      clearEditorPageCaches();
      // 新会话 = 新 ownerKey 空间：旧文档 handle 全部作废，连同 store 一起丢弃。
      editorDocumentStore = null;
      activeWorkspaceSessionId = randomUUID();
      const database = await ensureActiveOperationLog(activeSession);
      const scanJobId = randomUUID();
      const scanStartedAt = new Date().toISOString();
      await database.upsertJob({
        jobId: scanJobId,
        title: '扫描工作区',
        jobKind: 'workspace_scan',
        status: 'running',
        progress: { current: 0, message: '正在扫描文件' },
        payload: { workspaceSessionId: activeWorkspaceSessionId },
        createdAt: scanStartedAt,
        startedAt: scanStartedAt,
        updatedAt: scanStartedAt
      });
      let result: Awaited<ReturnType<typeof scanWorkspace>>;
      try {
        result = await scanWorkspace({
          workspaceRoot: activeSession.layers.overlayRoot,
          game: activeSession.meta.game
        });
        await database.replaceFiles(result.files);
        const recordedAt = new Date().toISOString();
        await database.replaceDiagnostics([
          ...result.diagnostics,
          ...result.files.flatMap((file) => file.diagnostics)
        ].map((diagnostic) => ({
          id: randomUUID(),
          ...diagnostic,
          createdAt: recordedAt,
          suppressed: false
        })));
        await database.upsertJob({
          jobId: scanJobId,
          title: '扫描工作区',
          jobKind: 'workspace_scan',
          status: 'completed',
          progress: { current: result.files.length, total: result.files.length },
          payload: { workspaceSessionId: activeWorkspaceSessionId },
          result: { fileCount: result.files.length },
          createdAt: scanStartedAt,
          startedAt: scanStartedAt,
          completedAt: recordedAt,
          updatedAt: recordedAt
        });
      } catch (error) {
        const failedAt = new Date().toISOString();
        await database.upsertJob({
          jobId: scanJobId,
          title: '扫描工作区',
          jobKind: 'workspace_scan',
          status: 'failed',
          progress: { current: 0 },
          payload: { workspaceSessionId: activeWorkspaceSessionId },
          error: { message: error instanceof Error ? error.message : String(error) },
          createdAt: scanStartedAt,
          startedAt: scanStartedAt,
          completedAt: failedAt,
          updatedAt: failedAt
        });
        throw error;
      }
      indexedFiles = result.files;
      activeIndex = null;
      return {
        workspaceSessionId: activeWorkspaceSessionId,
        workspaceLabel: overlaySelection.label,
        files: result.files.map(toRendererIndexedFile),
        diagnostics: sanitizeDiagnostics(result.diagnostics),
        countsByKind: result.countsByKind,
        session: {
          workspaceSessionId: activeWorkspaceSessionId,
          workspaceLabel: overlaySelection.label,
          game: activeSession.meta.game,
          openedAt: activeSession.meta.openedAt,
          baseMounted: !activeSession.meta.baseMissing,
          ...(baseSelection ? { baseLabel: baseSelection.label } : {})
        }
      };
    }
  );

  handle('workspace.analyze', async (): Promise<AnalyzeWorkspaceSummary> => {
    if (!activeSession) throw new Error('请先打开工作区。');
    const result = await analyzeWorkspace({
      workspaceRoot: activeSession.layers.overlayRoot,
      ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
    });
    activeIndex = result.index;

    return {
      parsedFiles: result.parsedFiles,
      inspectedFiles: result.inspectedFiles,
      referenceStats: result.referenceStats,
      diagnostics: sanitizeDiagnostics(result.diagnostics),
      events: result.index.searchEvents('', 200).map(({ item }) => ({
        uri: item.uri,
        eventId: item.eventId,
        ...(item.name ? { name: item.name } : {})
      })),
      tools: toolRegistry.list()
    };
  });

  handle('resource.preview', async (_event, sourceUri: string): Promise<RendererResourcePreview | null> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    return toRendererResourcePreview(await openResourcePreview({
      file,
      inspectNative: true,
      parseStructured: true,
      ...(activeSession?.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
    }));
  });

  handle('resource.saveText', async (_event, sourceUri: string, newText: string): Promise<RendererSaveResult> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before it can be saved.',
            sourceUri
          }
        ]
      };
    }

    const operationLog = activeSession
      ? await ensureActiveOperationLog(activeSession)
      : undefined;
    const storage = activeSession ? durableStoragePaths(activeSession.meta.workspaceId) : undefined;

    let result = await saveTextResource({
      file,
      newText,
      ...(activeSession ? { session: activeSession } : {}),
      ...(operationLog ? { operationLog } : {}),
      ...(storage ?? {})
    });
    if (!result.ok && result.requiresConfirmation) {
      const confirmation = await requestWriteConfirmation({
        event: _event,
        resourceLabel: file.relativePath,
        sourceUri,
        actionLabel: '保存',
        payloadHash: createHash('sha256').update(newText).digest('hex')
      });
      if (!confirmation) return cancelledWrite(sourceUri);
      result = await saveTextResource({
        file,
        newText,
        confirmation,
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {}),
        ...(storage ?? {})
      });
    }
    if (result.ok) {
      const refreshed = await openResourcePreview({
        file,
        inspectNative: true,
        parseStructured: true,
        ...(activeSession?.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
      });
      const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
      if (index >= 0) indexedFiles[index] = refreshed.file;
    }
    return toRendererSaveResult(result, indexedFiles);
  });

  handle('resource.search', async (_event, query: string) => {
    const normalized = query.trim().toLowerCase();
    const items = normalized.length === 0
      ? indexedFiles
      : indexedFiles.filter((file) => {
          return file.relativePath.toLowerCase().includes(normalized) || file.resourceKind.includes(normalized);
        });

    return items.map(toRendererIndexedFile);
  });

  handle(
    'resource.readRawRange',
    async (_event, sourceUri: string, offset: number, length: number) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          sourceUri,
          offset,
          length,
          fileSize: 0,
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before raw range read.',
            sourceUri
          }]
        };
      }
      return readRawResourceRange(file, offset, length);
    }
  );

  handle('resource.readRawMetadata', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    const meta = await readRawResourceMetadata(file, { computeHash: file.size <= 32 * 1024 * 1024 });
    // 必须脱敏：RawResourceMetadata 含 absolutePath（rawRead.ts:16），而
    // verify-desktop-security-runtime.mjs 把 absolutePath 列为泄漏键。此前这里
    // 直接 return 原对象，等于把本机绝对路径送进 renderer——同文件其余 handler
    // （:675/:904/:933/:948）都走了 sanitizeRendererValue，只有这一条漏了。
    // 该 channel 此前 renderer 零引用，所以泄漏一直没被触发；接线前必须先补上。
    return sanitizeRendererValue(meta);
  });

  /** Renderer-safe EMEVD envelope (no absolute paths). */
  handle('resource.readEmevdDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 EMEVD。',
          sourceUri
        }]
      };
    }
    try {
      // ROOT-07：只读调用只传已存在并 verified 的 roots。
      const readRoots = activeSession
        ? await prepareBridgeRoots(
            bridgeRootSession(activeSession, durableStoragePaths(activeSession.meta.workspaceId)),
            'read'
          )
        : null;
      if (readRoots && !readRoots.ok) {
        return {
          ok: false,
          diagnostics: [bridgeRootsDiagnostic('BRIDGE_ROOT_MISSING', readRoots)]
        };
      }
      const result = await runBridge<{
        sourceHash?: string;
        eventCount?: number;
        instructionCount?: number;
        events?: unknown[];
        instructionsSample?: unknown[];
        authority?: string;
        supportsEventGc?: boolean;
      }>({
        command: 'read-emevd-document',
        filePath: file.absolutePath,
        allowedRoots: readRoots ? [...readRoots.allowedRoots] : [dirname(file.absolutePath)],
        timeoutMs: 120_000
      });
      return sanitizeRendererValue({
        ok: result.parseStatus !== 'failed',
        sourceUri,
        relativePath: file.relativePath,
        data: result.data
          ? {
              sourceHash: result.data.sourceHash,
              eventCount: result.data.eventCount,
              instructionCount: result.data.instructionCount,
              events: result.data.events,
              instructionsSample: result.data.instructionsSample,
              authority: result.data.authority,
              supportsEventGc: result.data.supportsEventGc === true
            }
          : null,
        diagnostics: sanitizeDiagnostics(result.diagnostics)
      });
    } catch (error) {
      return {
        ok: false,
        sourceUri,
        diagnostics: [{
          severity: 'error' as const,
          code: 'EMEVD_READ_FAILED',
          message: 'EMEVD 读取失败；底层路径与运行时详情已隐藏。',
          sourceUri
        }]
      };
    }
  });

  /**
   * Stage EMEVD mutation via Bridge, then whole-file replace through Patch Engine.
   * Mutation object is Bridge-native (set_rest_behavior / set_instruction_args / add_event / …).
   */
  handle(
    'resource.applyEmevdMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: Record<string, unknown>
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'EMEVD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 EMEVD。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      // ROOT-07：stage 前先 mkdir → realpath → boundary check 并注册 allowed
      // roots；回调同步返回已验证集合（stageBridgeOutput 的 mkdir 幂等）。
      const roots = await prepareBridgeRoots(bridgeRootSession(activeSession, storage), 'stage');
      if (!roots.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [bridgeRootsDiagnostic('EMEVD_STAGING_PREPARE_FAILED', roots)]
        };
      }
      const bridgeMutation = {
        kind: String(mutation.kind ?? mutation.mutation ?? ''),
        ...mutation
      } as Parameters<typeof commitEmevdMutationViaBridge>[0]['mutation'];
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...roots.allowedRoots],
        stagingPrefix: 'emevd',
        stagingFileName: `${basename(file.relativePath)}.mut.emevd`,
        stageWrite: (context) => commitEmevdMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation,
          ...(typeof mutation.instructionIndex === 'number'
            ? { instructionIndex: mutation.instructionIndex }
            : {}),
          timeoutMs: 120_000
        }),
        title: `EMEVD mutation ${String(mutation.kind ?? 'edit')}`,
        confirmActionLabel: '提交 EMEVD 变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) {
        const refreshed = await openResourcePreview({
          file,
          inspectNative: true,
          parseStructured: true,
          ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
        });
        const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
        if (index >= 0) indexedFiles[index] = refreshed.file;
      }
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * Assemble the authoritative full EMEVD editor document in main via
   * paginated Bridge reads. The Bridge opens the outer source resource as-is:
   * .dcx unwrap is native, so no decompressed temp file is materialized and the
   * write path always targets the outer resource (negative architecture). The
   * renderer only ever receives a DSL template string, a documentInstanceId and
   * the bounded outline, never the full document.
   */
  handle(
    'resource.readEmevdFullDocument',
    async (_event, sourceUri: string, documentInstanceId: string, loadFullDslTemplate?: boolean) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: '资源未索引，无法组装完整 EMEVD 文档。',
            sourceUri
          }]
        };
      }
      if (!activeSession) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error' as const,
            code: 'EMEVD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能组装完整 EMEVD 文档。',
            sourceUri
          }]
        };
      }
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      // ROOT-07：完整文档读取不需要落盘（Bridge 原生解 DCX），但 staging root
      // 仍注册以便后续 submit 复用。
      const roots = await prepareBridgeRoots(bridgeRootSession(activeSession, storage), 'stage');
      if (!roots.ok) {
        return {
          ok: false,
          sourceUri,
          diagnostics: [bridgeRootsDiagnostic('EMEVD_STAGING_PREPARE_FAILED', roots)]
        };
      }
      const full = await readFullEmevdDocumentViaBridge({
        filePath: file.absolutePath,
        allowedRoots: [...roots.allowedRoots],
        resourceUri: sourceUri,
        registry: getEmevdRegistry().registry,
        ...(documentInstanceId ? { documentInstanceId } : {}),
        pageSize: 512,
        timeoutMs: 120_000
      });
      if (!full.ok || !full.document) {
        return {
          ok: false,
          sourceUri,
          diagnostics: full.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      emevdFullDocuments.set(sourceUri, full.document);
      const registryResolution = getEmevdRegistry();
      // R3/P4 裁定：反汇编必须是 DarkScript3 式（EMEDF 函数名）；没 EMEDF 失败
      // 关闭——不再下发 hash 伪源码（旧 renderEmevdPatchDslBounded 输出已从
      // production 入口移除，底层 dslCompiler/typed 写链保留）。
      // T4：一次出完整 DarkScript 文本，不做 2000 行截断——事件源码不再有
      // 「加载完整源码」按钮与截断黄条；全量 IPC 下发 70K+ 行文本可行，
      // 渲染成本集中在打开时一次完成（loadFullDslTemplate 参数保留以兼容
      // 既有 IPC 契约与 core smoke，不再影响行为）。
      let dslTemplate: string | null = null;
      let dslTemplateTruncated = false;
      let dslTemplateTotalLines = 0;
      let sourceStyle: 'dark-script' | 'patch-dsl' | 'none' = 'none';
      const responseDiagnostics = full.diagnostics.map((d) => ({
        severity: d.severity as Diagnostic['severity'],
        code: d.code,
        message: d.message,
        sourceUri
      }));
      if (registryResolution.origin === 'imported') {
        const bounded = renderEmevdDarkScriptBounded(
          full.document,
          registryResolution.registry,
          undefined
        );
        dslTemplate = bounded.text;
        dslTemplateTruncated = bounded.truncated;
        dslTemplateTotalLines = bounded.totalLines;
        sourceStyle = 'dark-script';
      } else {
        responseDiagnostics.push({
          severity: 'error' as const,
          code: 'EMEDF_MISSING',
          message: '未找到用户本机 EMEDF（DarkScript3 的 sekiro-common.emedf.json）：'
            + '事件源码反汇编已失败关闭，不再提供伪解码。'
            + '请设置环境变量 SOULFORGE_EMEDF_PATH 指向该文件，'
            + '或在游戏根旁 tools/<工具目录>/Resources/ 放置该文件后重新打开。',
          sourceUri
        });
      }
      return {
        ok: true,
        sourceUri,
        documentInstanceId,
        revision: full.document.revision,
        eventCount: full.document.events.length,
        instructionCount: full.instructionTotal,
        dslTemplate,
        sourceStyle,
        dslTemplateTruncated,
        dslTemplateTotalLines,
        sourceHash: full.sourceHash ?? null,
        sourceFormat: full.sourceFormat ?? null,
        outerFileHash: full.outerFileHash ?? null,
        outline: full.outline ?? null,
        diagnostics: responseDiagnostics
      };
    }
  );

  /**
   * T4-3：暴露本机 EMEDF 指令名补全目录给 renderer（autocomplete/hover）。
   * 只读 EMEDF 公开字段（name/bank/id/args），EMEDF 数据本身留在本机不进仓库。
   * 无论 registry 来源（imported 或 fixture）都返回目录，由 renderer 决定何时展示。
   */
  handle('resource.readEmedfCompletionCatalog', async (): Promise<{
    ok: boolean;
    origin: 'imported' | 'fixture';
    items: EmedfCompletionItem[];
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }> => {
    const resolution = getEmevdRegistry();
    return {
      ok: true,
      origin: resolution.origin,
      items: listEmedfCompletionItems(resolution.registry)
    };
  });

  /**
   * Submit a DSL patch authored in the renderer's four-view panel. The full
   * document is held in main (loaded by readEmevdFullDocument); compile →
   * typed plan → Bridge batch staging → file_replace PatchIR →
   * WorkspaceTransaction. On success the authoritative document cache and the
   * resource preview are refreshed.
   */
  handle(
    'resource.submitEmevdDslPlan',
    async (event, sourceUri: string, sourceText: string): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'EMEVD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能提交 EMEVD DSL。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const document = emevdFullDocuments.get(sourceUri);
      if (!document) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'EMEVD_FULL_DOCUMENT_MISSING',
            message: '请先加载完整 EMEVD 文档（readEmevdFullDocument）再提交 DSL。',
            sourceUri
          }]
        };
      }
      // The outer source resource (file.absolutePath) is both the Bridge staging
      // read source and the PatchIR file_replace target — never a decompressed
      // temp path (negative architecture: 不以 prepared temp path 作为 Patch target)。
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      // ROOT-07：DSL 提交链需要 staging（Bridge 暂存写）——先验证再注册。
      const roots = await prepareBridgeRoots(bridgeRootSession(activeSession, storage), 'stage');
      if (!roots.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [bridgeRootsDiagnostic('EMEVD_STAGING_PREPARE_FAILED', roots)]
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
      const registry = getEmevdRegistry().registry;
      const full = await readFullEmevdDocumentViaBridge({
        filePath: file.absolutePath,
        allowedRoots: [...roots.allowedRoots],
        resourceUri: sourceUri,
        registry,
        ...(document.documentInstanceId !== undefined ? { documentInstanceId: document.documentInstanceId } : {}),
        pageSize: 512,
        timeoutMs: 120_000
      });
      if (!full.ok || !full.document) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: full.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      const fresh = full.document;
      const targetPath = file.absolutePath;
      const schemaFingerprint = fingerprintEmedfRegistry(registry);
      const result = await submitEmevdDslPlanViaFourView({
        compileRequest: {
          schemaVersion: 1,
          resourceUri: sourceUri,
          documentInstanceId: fresh.documentInstanceId ?? '',
          baseRevision: fresh.revision,
          emedfSchemaFingerprint: schemaFingerprint,
          sourceText,
          mode: 'patch'
        },
        document: fresh,
        registry,
        sourcePath: targetPath,
        expectedDocumentHash: full.sourceHash ?? '',
        // 修改目标始终是 outer source resource：.dcx 时 file_replace 前置按 outer 字节比对。
        ...(full.outerFileHash !== undefined ? { expectedOuterFileHash: full.outerFileHash } : {}),
        allowedRoots: [...roots.allowedRoots],
        workspaceId: activeSession.meta.workspaceId,
        workspaceRoot: activeSession.layers.overlayRoot,
        stagingRoot: storage.stagingRoot,
        ...(activeSession ? { session: activeSession } : {}),
        operationLog,
        backupBaseDir: storage.backupBaseDir,
        recoveryDir: storage.recoveryDir,
        timeoutMs: 120_000
      });
      if (!result.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: result.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      // Refresh authoritative cache + indexed preview from the committed file.
      // 复用上面已验证的 roots（staging 已注册）。
      const refreshed = await readFullEmevdDocumentViaBridge({
        filePath: file.absolutePath,
        allowedRoots: [...roots.allowedRoots],
        resourceUri: sourceUri,
        registry,
        ...(document.documentInstanceId !== undefined ? { documentInstanceId: document.documentInstanceId } : {}),
        pageSize: 512,
        timeoutMs: 120_000
      });
      if (refreshed.ok && refreshed.document) {
        emevdFullDocuments.set(sourceUri, refreshed.document);
      }
      const preview = await openResourcePreview({
        file,
        inspectNative: true,
        parseStructured: true,
        ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
      });
      const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
      if (index >= 0) indexedFiles[index] = preview.file;
      return {
        ok: true,
        changedFiles: [sourceUri],
        diagnostics: [
          ...result.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          })),
          {
            severity: 'info',
            code: 'EMEVD_DSL_PLAN_COMMITTED',
            message: `DSL 计划已提交（revision ${fresh.revision} → ${refreshed.document?.revision ?? fresh.revision + 1}）。`,
            sourceUri
          }
        ]
      };
    }
  );

  handle('resource.readFmgDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 FMG。',
          sourceUri
        }]
      };
    }
    // ROOT-07：只读调用只传已存在并 verified 的 roots。
    const readRoots = activeSession
      ? await prepareBridgeRoots(
          bridgeRootSession(activeSession, durableStoragePaths(activeSession.meta.workspaceId)),
          'read'
        )
      : null;
    if (readRoots && !readRoots.ok) {
      return {
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        data: null,
        diagnostics: [bridgeRootsDiagnostic('BRIDGE_ROOT_MISSING', readRoots)]
      };
    }
    const allowedRoots = readRoots ? [...readRoots.allowedRoots] : [dirname(file.absolutePath)];
    // TEXT-20C：msgbnd/DCX 容器走目录链读。read-fmg-document 只认裸 FMG v2
    // 文件（marker 0x00020000），喂 DCX magic 会硬失败（真实游戏里 loadFmg
    // 恒不 live —— 正是 fixture 掩盖掉的缺口）。目录读返回整容器 outerHash
    // （= 写链密封期望，后续 applyFmgMutation 用同一 hash 做并发保护）与首表
    // 条目；loose `.fmg` 仍走原有 read-fmg-document。
    if (file.compoundExtension === '.msgbnd.dcx') {
      const catalog = await readTextCatalogViaBridge({
        sourcePath: file.absolutePath,
        allowedRoots,
        tableEntryIndex: 0
      });
      return sanitizeRendererValue({
        ok: Boolean(catalog.ok && catalog.data?.outerHash),
        sourceUri,
        relativePath: file.relativePath,
        data: catalog.ok && catalog.data
          ? {
              sourceHash: catalog.data.outerHash as string,
              entryCount: catalog.data.entries?.length ?? 0,
              entries: (catalog.data.entries ?? []).slice(0, 500).map((e) => ({
                id: e.id,
                text: e.text
              })),
              entriesTruncated: (catalog.data.entries?.length ?? 0) > 500,
              ...(catalog.data.authority ? { authority: catalog.data.authority } : {})
            }
          : null,
        diagnostics: catalog.diagnostics
      });
    }
    const result = await readFmgDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots
    });
    return sanitizeRendererValue({
      ok: result.ok,
      sourceUri,
      relativePath: file.relativePath,
      data: result.data
        ? {
            sourceHash: result.data.sourceHash,
            entryCount: result.data.entryCount,
            // Cap rows for renderer safety
            entries: result.data.entries.slice(0, 500).map((e) => ({
              id: e.id,
              text: e.text
            })),
            entriesTruncated: result.data.entries.length > 500,
            authority: result.data.authority
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  /**
   * Paginated FMG entry access (hard constraint 17). Main assembles/caches the
   * complete entry list once and serves bounded pages; the renderer never
   * receives the full document. `query` filters the complete list in main, so
   * search still covers every page.
   */
  handle(
    'resource.readFmgPage',
    async (
      _event,
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      query?: string
    ) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (message: string) => ({
        ok: false,
        sourceUri,
        sourceHash: null,
        entryCount: 0,
        maxId: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        entries: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('资源未索引，无法分页读取 FMG。');
      }
      let cached = fmgPageCache.get(sourceUri);
      if (!cached) {
        const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
        if (roots.diagnostics.length > 0) {
          return {
            ok: false,
            sourceUri,
            sourceHash: null,
            entryCount: 0,
            maxId: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            entries: [],
            diagnostics: roots.diagnostics
          };
        }
        const result = await readFmgDocumentViaBridge({
          sourcePath: file.absolutePath,
          allowedRoots: roots.allowedRoots
        });
        if (!result.ok || !result.data) {
          return {
            ok: false,
            sourceUri,
            sourceHash: null,
            entryCount: 0,
            maxId: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            entries: [],
            diagnostics: result.diagnostics
          };
        }
        cached = {
          sourceHash: result.data.sourceHash,
          maxId: result.data.entries.reduce((max, entry) => Math.max(max, entry.id), 0),
          entries: result.data.entries,
          ...(result.data.authority ? { authority: result.data.authority } : {})
        };
        fmgPageCache.set(sourceUri, cached);
      }
      const q = (query ?? '').trim().toLowerCase();
      const filtered = q.length === 0
        ? cached.entries
        : cached.entries.filter((entry) =>
            String(entry.id).includes(q) || entry.text.toLowerCase().includes(q)
          );
      const window = normalizePageWindow(
        filtered.length,
        requestedPage,
        requestedPageSize || FMG_PAGE_SIZE
      );
      return {
        ok: true,
        sourceUri,
        sourceHash: cached.sourceHash,
        entryCount: filtered.length,
        maxId: cached.maxId,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        entries: filtered
          .slice(window.offset, window.offset + window.size)
          .map((entry) => ({ id: entry.id, text: entry.text })),
        ...(cached.authority ? { authority: cached.authority } : {}),
        diagnostics: []
      };
    }
  );

  /**
   * TEXT-20A：读取 Text 语言/容器目录（FMG 只读选择链）。
   *
   * 每个 indexed msgbnd 容器经 Bridge `read-text-catalog` 确认格式并取得 typed
   * 语言/容器/表 ID；读取失败的容器保留 typed 节点并标记 failed，绝不静默消失，
   * 也不伪装成 0 个表（"失败不返回 0 entries"）。TPF/texbnd 等资源不在此过滤内，
   * 天然不进 Text 目录。
   */
  handle('resource.readTextCatalog', async (): Promise<TextCatalogResponse> => {
    const fail = (diagnostics: Diagnostic[]): TextCatalogResponse => ({
      ok: false,
      libraryId: 'game-text',
      title: 'Text',
      languages: [],
      diagnostics
    });
    if (!activeSession) {
      return fail([{
        severity: 'error',
        code: 'WORKSPACE_SESSION_REQUIRED',
        message: '请先打开工作区，再读取文本目录。'
      }]);
    }
    const roots = await verifiedReadRoots(activeSession, activeSession.layers.overlayRoot);
    if (roots.diagnostics.length > 0) return fail(roots.diagnostics);

    // R2 裁定：文本目录默认只列出简体中文（zhocn），英语/日语整包延期至 V0.6。
    // 过滤时需要同时接纳 `/zhocn/` 与 Windows 分隔符 `\zhocn\`，且大小写不敏感
    // （真实索引路径由主进程生成，分隔符随平台，段名大小写不随平台）。
    const isZhocnPath = (relativePath: string): boolean =>
      /[\\/]zhocn[\\/]/i.test(relativePath);
    const allMsgFiles = indexedFiles.filter(
      (file) => file.compoundExtension === '.msgbnd.dcx'
    );
    const msgFiles = allMsgFiles.filter((file) => isZhocnPath(file.relativePath));
    const filteredOutOfZhocn = allMsgFiles.length > msgFiles.length;
    // 目录读取幂等：每次重建表引用映射，避免上一次扫描的 entryIndex 残留。
    textTableRefs.clear();

    const languages = new Map<string, TextContainerNode[]>();
    const diagnostics: Diagnostic[] = [];
    let totalTables = 0;
    for (const file of msgFiles) {
      const hint = deriveTextContainerHint(file.relativePath);
      const result = await readTextCatalogViaBridge({
        sourcePath: file.absolutePath,
        allowedRoots: roots.allowedRoots
      });
      if (!result.ok || !result.data) {
        const languageId = hint.languageId || 'unknown';
        const containerId = `text:${languageId}:${hint.containerKind || 'unknown'}`;
        const node: TextContainerNode = {
          containerId,
          containerKind: hint.containerKind || 'unknown',
          sourceUri: file.sourceUri,
          relativePath: file.relativePath,
          parseStatus: 'failed',
          tableCount: 0,
          tables: [],
          diagnostics: result.diagnostics
        };
        diagnostics.push(...result.diagnostics);
        languages.set(languageId, [...(languages.get(languageId) ?? []), node]);
        continue;
      }

      const catalog = result.data;
      const languageId = catalog.languageId || hint.languageId || 'unknown';
      const containerKind = catalog.containerKind || hint.containerKind || 'unknown';
      const containerId = catalog.containerId || `text:${languageId}:${containerKind}`;
      const tables = catalog.tables.map((table) => {
        const ref: TextTableRef = {
          tableId: table.stableId,
          languageId,
          containerId,
          containerKind,
          sourceUri: file.sourceUri,
          entryIndex: table.entryIndex,
          entryName: table.entryName
        };
        textTableRefs.set(ref.tableId, ref);
        return {
          tableId: table.stableId,
          entryName: table.entryName,
          entryCount: table.entryCount,
          sourceUri: file.sourceUri,
          entryIndex: table.entryIndex
        };
      });
      totalTables += tables.length;
      const node: TextContainerNode = {
        containerId,
        containerKind,
        sourceUri: file.sourceUri,
        relativePath: file.relativePath,
        parseStatus: 'confirmed',
        tableCount: tables.length,
        tables,
        diagnostics: []
      };
      languages.set(languageId, [...(languages.get(languageId) ?? []), node]);
    }

    const languageList = [...languages.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([languageId, containers]) => ({
        languageId,
        containers: containers.sort((a, b) => a.containerKind.localeCompare(b.containerKind))
      }));

    // 只在确实过滤掉了非 zhocn 文件时追加这条 info 诊断：它解释的是「侧栏为什么
    // 没有英语/日语」，而不是万能口号。
    if (filteredOutOfZhocn) {
      diagnostics.push({
        severity: 'info',
        code: 'TEXT_CATALOG_ZHOCN_ONLY',
        message: '文本目录当前只列出简体中文（zhocn）；英语/日语延期至 V0.6。'
      });
    }

    return {
      ok: true,
      libraryId: 'game-text',
      title: `Text · ${languageList.length} languages · ${totalTables} tables`,
      languages: languageList,
      diagnostics
    };
  });

  /**
   * TEXT-20A：按 typed tableId 分页读取 FMG 表条目（硬约束 17）。主进程定位源
   * 文件与 entryIndex，经 Bridge 读整表后缓存并分页；query 作用于完整表，覆盖
   * 所有页。失败返回结构化诊断，不返回 `0 entries` 伪空表。
   */
  handle(
    'resource.readFmgTablePage',
    async (
      _event,
      tableId: string,
      requestedPage: number,
      requestedPageSize: number,
      query?: string
    ): Promise<FmgEntryPage> => {
      const ref = textTableRefs.get(tableId);
      const failure = (code: string, message: string, extraDiagnostics?: Diagnostic[]): FmgEntryPage => ({
        ok: false,
        sourceUri: ref?.sourceUri ?? tableId,
        sourceHash: null,
        entryCount: 0,
        maxId: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        entries: [],
        diagnostics: extraDiagnostics ?? [{
          severity: 'error',
          code,
          message,
          ...(ref?.sourceUri ? { sourceUri: ref.sourceUri } : {})
        }]
      });
      if (!ref) {
        return failure('TEXT_TABLE_NOT_RESOLVED', `文本表 ${tableId} 未解析；请先读取文本目录（readTextCatalog）。`);
      }
      const file = indexedFiles.find((item) => item.sourceUri === ref.sourceUri);
      if (!file) {
        return failure('TEXT_TABLE_SOURCE_MISSING', `文本表 ${ref.entryName} 的源资源未索引。`);
      }
      let cached = fmgTableCache.get(tableId);
      if (!cached) {
        const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
        if (roots.diagnostics.length > 0) {
          return failure('BRIDGE_ROOT_MISSING', '读取文本表所需 Bridge roots 不可用。', roots.diagnostics);
        }
        const result = await readTextCatalogViaBridge({
          sourcePath: file.absolutePath,
          allowedRoots: roots.allowedRoots,
          tableEntryIndex: ref.entryIndex
        });
        if (!result.ok || !result.data?.entries || !result.data.tableSourceHash) {
          return failure('TEXT_TABLE_READ_FAILED', `文本表 ${ref.entryName} 读取失败。`, result.diagnostics);
        }
        cached = {
          tableId,
          sourceHash: result.data.tableSourceHash,
          maxId: result.data.entries.reduce((max, entry) => Math.max(max, entry.id), 0),
          entries: result.data.entries,
          ...(result.data.authority ? { authority: result.data.authority } : {})
        };
        fmgTableCache.set(tableId, cached);
      }
      const q = (query ?? '').trim().toLowerCase();
      const filtered = q.length === 0
        ? cached.entries
        : cached.entries.filter((entry) =>
            String(entry.id).includes(q) || entry.text.toLowerCase().includes(q)
          );
      const window = normalizePageWindow(
        filtered.length,
        requestedPage,
        requestedPageSize || FMG_PAGE_SIZE
      );
      return {
        ok: true,
        sourceUri: ref.sourceUri,
        sourceHash: cached.sourceHash,
        entryCount: filtered.length,
        maxId: cached.maxId,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        entries: filtered
          .slice(window.offset, window.offset + window.size)
          .map((entry) => ({ id: entry.id, text: entry.text })),
        ...(cached.authority ? { authority: cached.authority } : {}),
        diagnostics: []
      };
    }
  );

  handle(
    'resource.applyFmgMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: { kind: 'upsert' | 'delete' | 'add'; id: number; text?: string },
      tableId?: string
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FMG_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 FMG。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      // TEXT-20C storage-profile 门控：容器写必须带 tableId，且该表必须是
      // readTextCatalog 确认过的（textTableRefs 只填 CONFIRMED 容器）。表不在
      // refs 里 = 该 language/container profile 未确认 → 拒绝写，绝不静默退化成
      // loose 写（loose 对 msgbnd 容器会硬失败）或放行未知 profile。
      let entryIndex: number | undefined;
      if (tableId !== undefined) {
        const ref = textTableRefs.get(tableId);
        if (!ref || ref.sourceUri !== sourceUri) {
          return {
            ok: false,
            changedFiles: [],
            diagnostics: [{
              severity: 'error',
              code: 'FMG_WRITE_PROFILE_UNSUPPORTED',
              message: `文本表 ${tableId} 不是已确认的 storage profile，拒绝写回。`,
              sourceUri
            }]
          };
        }
        entryIndex = ref.entryIndex;
      }
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      // ROOT-07：stage 前 mkdir → realpath → boundary check；回调同步返回
      // 已验证集合（stageBridgeOutput 的 mkdir 幂等）。
      const stage = await verifiedStageRoots(activeSession, storage, 'FMG_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const bridgeMutation =
        mutation.kind === 'delete'
          ? { kind: 'delete' as const, id: mutation.id }
          : mutation.kind === 'add'
            ? { kind: 'add' as const, id: mutation.id, text: mutation.text ?? '' }
            : { kind: 'upsert' as const, id: mutation.id, text: mutation.text ?? '' };
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'fmg',
        stagingFileName: `${basename(file.relativePath)}.mut.fmg`,
        stageWrite: (context) => commitFmgMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation,
          ...(entryIndex !== undefined ? { entryIndex } : {})
        }),
        title: `FMG mutation ${mutation.kind} ${mutation.id}`,
        confirmActionLabel: '提交 FMG 变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) {
        // 容器写会更新整容器 DCX hash → 同容器内所有表缓存都失效，逐表清；
        // 裸 fmg 的页缓存照旧清。
        fmgPageCache.delete(sourceUri);
        for (const [cachedTableId, ref] of textTableRefs) {
          if (ref.sourceUri === sourceUri) fmgTableCache.delete(cachedTableId);
        }
      }
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  handle('resource.readMsbDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 MSB。',
          sourceUri
        }]
      };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await readMsbDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      maxParts: 256,
      maxRegions: 128,
      maxModels: 128,
      maxEvents: 128,
      // P5 裁定：真实游戏 .msb.dcx 是 KRAK 压缩，缺 Oodle 运行时读不出实体表
      // （表现为 3D 代理场景 0 节点 / 0 实体）。
      ...(activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({
      ok: result.ok,
      sourceUri,
      relativePath: file.relativePath,
      data: result.data
        ? {
            sourceHash: result.data.sourceHash,
            version: result.data.version,
            modelCount: result.data.modelCount,
            partCount: result.data.partCount,
            regionCount: result.data.regionCount,
            eventCount: result.data.eventCount,
            models: result.data.models,
            parts: result.data.parts,
            regions: result.data.regions,
            events: result.data.events,
            authority: result.data.authority,
            entityEdit: result.data.entityEdit
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  handle('resource.readTaeDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TAE。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-tae-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readEsdDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 ESD。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-esd-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readMtdDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 MTD。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-mtd-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFxrDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FXR。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-fxr-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFlverDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readTpfDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TPF。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-tpf-document',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      ...(activeSession?.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {})
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readTpfTexturePreview', async (_event, sourceUri: string, textureIndex: number) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TPF 纹理预览。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
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

  handle('resource.saveTpfTextureReplace', async (
    event,
    sourceUri: string,
    expectedHash: string,
    textureIndex: number,
    newTextureBase64: string
  ): Promise<RendererSaveResult> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file || !activeSession) {
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
    const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
    if (gameBlocked) return gameBlocked;
    const storage = durableStoragePaths(activeSession.meta.workspaceId);
    // ROOT-07：stage 前 mkdir → realpath → boundary check；回调同步返回
    // 已验证集合（stageBridgeOutput 的 mkdir 幂等）。
    const stage = await verifiedStageRoots(activeSession, storage, 'TPF_STAGING_PREPARE_FAILED');
    if (stage.diagnostics.length > 0) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: stage.diagnostics
      };
    }
    const operationLog = await ensureActiveOperationLog(activeSession);
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
      confirm: electronConfirmationPort(event),
      commit: sessionCommitPort(activeSession, operationLog, storage)
    });
    return toSaveResultFromOutcome(outcome, indexedFiles);
  });

  handle('resource.readFlverMesh', async (_event, sourceUri: string, meshIndex: number) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 网格。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-mesh',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      commandOptions: { meshIndex }
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFlverSkeleton', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 骨骼层级。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-skeleton',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFlverDummies', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 挂点。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-dummies',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFlverTextureSlots', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 纹理槽位。', sourceUri }] };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) return { ok: false, diagnostics: roots.diagnostics };
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-texture-slots',
      filePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle(
    'resource.applyMsbMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: {
        kind: 'set_part_position' | 'set_part_transform' | 'set_region_position'
          | 'delete_part' | 'delete_region' | 'delete_event';
        partName: string;
        posX?: number;
        posY?: number;
        posZ?: number;
        rotX?: number;
        scaleX?: number;
        scaleY?: number;
        scaleZ?: number;
      }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MSB_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 MSB。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const deferredBlocked = rejectDeferredPreviewEditorWrite('msb', sourceUri);
      if (deferredBlocked) return deferredBlocked;
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'MSB_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'msb',
        stagingFileName: `${basename(file.relativePath)}.mut.msb`,
        stageWrite: (context) => commitMsbMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation
        }),
        title: `MSB mutation ${mutation.kind} ${mutation.partName}`,
        confirmActionLabel: '提交 MSB 变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  handle(
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
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
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
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      // MODEL-51C 只交付 native 写基础设施，不改变编辑器延期裁定：FLVER 仍是
      // V0.6 延期的只读预览（editorCapabilityContract flver 块不动）。此 handler
      // 是 main-only 预埋（不加 preload 暴露，renderer 不可达）；万一将来被误接，
      // 这里也失败关闭，不会静默放行写回。
      const deferredBlocked = rejectDeferredPreviewEditorWrite('flver', sourceUri);
      if (deferredBlocked) return deferredBlocked;
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'FLVER_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
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
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * PARAM 元数据包（Smithbox SDT 2.2.4）的惰性缓存。
   *
   * 为什么缓存：导入要校验 291 MB 归档的 sha256、932 个文件的源树摘要与许可证
   * 摘要，实测一次数秒级。每读一个 param 都跑一遍会让界面卡住。
   *
   * 为什么允许缺失：元数据是**可选增强**。没有它时 PARAM 仍能读出行 ID、名字与
   * 原始字节（那部分是 native 权威），只是没有字段名/值分解。把它做成硬依赖会
   * 让「没装 Smithbox」变成「PARAM 完全不可用」，那是把增强降级成前提。
   *
   * 失败原因必须留下：缓存 null 时同时记下诊断，界面据此说明「为什么没有字段列」
   * 而不是显示一个空的第三列。
   */
  let paramMetadataCache: {
    loaded: true;
    package: ParamMetadataPackage | null;
    diagnostic: { code: string; message: string } | null;
  } | null = null;

  const loadParamMetadata = async (): Promise<{
    package: ParamMetadataPackage | null;
    diagnostic: { code: string; message: string } | null;
  }> => {
    if (paramMetadataCache) return paramMetadataCache;
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      paramMetadataCache = {
        loaded: true,
        package: null,
        diagnostic: {
          code: 'PARAM_METADATA_NO_LOCALAPPDATA',
          message: '无法定位 LOCALAPPDATA，未加载 PARAM 字段定义。'
        }
      };
      return paramMetadataCache;
    }
    const cacheRoot = join(localAppData, 'SoulForge', 'tools', 'smithbox', '2.2.4');
    try {
      const imported = await importPinnedSmithboxSdtParamMetadata({ cacheRoot });
      if (!imported.ok) {
        const first = imported.diagnostics[0];
        paramMetadataCache = {
          loaded: true,
          package: null,
          diagnostic: {
            code: first?.code ?? 'PARAM_METADATA_IMPORT_REJECTED',
            message: first?.message ?? 'PARAM 字段定义导入被拒绝。'
          }
        };
        return paramMetadataCache;
      }
      paramMetadataCache = { loaded: true, package: imported.package, diagnostic: null };
      return paramMetadataCache;
    } catch (error) {
      paramMetadataCache = {
        loaded: true,
        package: null,
        diagnostic: {
          code: 'PARAM_METADATA_IMPORT_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }
      };
      return paramMetadataCache;
    }
  };

  /* ------------------------------------------------------------------ */
  /*  本机 Yapped 只读覆盖（T5-1）                                       */
  /*                                                                    */
  /*  Smithbox 元数据给的是英文字段名。用户装的中文汉化版 Yapped 在      */
  /*  Paramdex\\SDT\\Defs\\*.xml 里带中文 DisplayName/Description，       */
  /*  本模块只从本机 Yapped 安装只读抽这两样，覆盖到 Smithbox 文档上。    */
  /*  这是**显示层覆盖**：origin 与偏移不动，写链只消费字段 id/type/      */
  /*  offset，不受显示名影响。                                          */
  /*                                                                    */
  /*  刻意不做成 Smithbox 那样的钉死发布包：Yapped 是本机第三方工具     */
  /*  安装目录，不是可再分发来源，没有归档摘要可钉。这里只读、不入库、   */
  /*  失败降级（拿不到就回落到 Smithbox 英文）。                          */
  /* ------------------------------------------------------------------ */

  /** T5 固定候选：本机 Yapped Rune Bear 发布包真实落地（grok 已求证存在）。 */
  const YAPPED_SDT_FIXED_CANDIDATES = [
    'D:\\mystream\\Sekiro Shadows Die Twice\\tools\\Yapped Rune Bear v2.14.1'
      + '\\Yapped Rune Bear v2.14.1\\Paramdex\\SDT'
  ];

  /**
   * 定位本机 Yapped 的 `Paramdex\SDT` 根（含 Defs/ 与 Names/）。
   *
   * 候选顺序：SOULFORGE_YAPPED_SDT_ROOT 显式环境变量 → 固定候选 → 已挂载
   * 会话兄弟 tools/<一层子目录>/Paramdex/SDT。找不到返回 null，由调用方
   * 降级到 Smithbox 英文 —— 这是可选增强，绝不能把「中文名不可用」升级成
   * 「PARAM 不可用」。
   */
  const locateYappedSdtRootSync = (): string | null => {
    const probe = (candidate: string): boolean => {
      try {
        return existsSync(join(candidate, 'Defs')) && existsSync(join(candidate, 'Names'));
      } catch {
        return false;
      }
    };
    const explicit = process.env.SOULFORGE_YAPPED_SDT_ROOT?.trim();
    if (explicit) {
      const candidate = resolve(explicit);
      if (probe(candidate)) return candidate;
    }
    for (const candidate of YAPPED_SDT_FIXED_CANDIDATES) {
      if (probe(candidate)) return candidate;
    }
    const roots: string[] = [];
    pushToolsSubdirs(roots, activeSession?.layers.baseRoot);
    const overlay = activeSession?.layers.overlayRoot?.trim();
    if (overlay) pushToolsSubdirs(roots, dirname(dirname(overlay)));
    const gameRootEnv = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
    if (gameRootEnv) pushToolsSubdirs(roots, gameRootEnv);
    for (const root of roots) {
      const candidate = join(root, 'Paramdex', 'SDT');
      if (probe(candidate)) return candidate;
    }
    return null;
  };

  let yappedOverlayCache: {
    loaded: true;
    /** ParamType → 字段覆盖；null 表示本机无 Yapped 或读不到可用 Defs。 */
    defs: ReadonlyMap<string, YappedParamOverlay> | null;
    /** 容器条目名 → 行 id → 行名；null 表示本机无 Yapped 或读不到可用 Names。 */
    rowNames: ReadonlyMap<string, ReadonlyMap<number, string>> | null;
    diagnostics: YappedSourceDiagnostic[];
  } | null = null;

  /**
   * 惰性读本机 Yapped Defs/Names 索引并缓存。只读一次：160 个 xml + 160 个
   * txt 实测数秒级，每读一个 param 都跑一遍会让界面卡住。空/缺失回 null，
   * 不抛 —— 失败降级到 Smithbox 英文。
   */
  const loadYappedOverlay = async (): Promise<{
    defs: ReadonlyMap<string, YappedParamOverlay> | null;
    rowNames: ReadonlyMap<string, ReadonlyMap<number, string>> | null;
    diagnostics: YappedSourceDiagnostic[];
  }> => {
    if (yappedOverlayCache) return yappedOverlayCache;
    const sdtRoot = locateYappedSdtRootSync();
    if (!sdtRoot) {
      yappedOverlayCache = {
        loaded: true,
        defs: null,
        rowNames: null,
        diagnostics: [{
          severity: 'info',
          code: 'YAPPED_SDT_NOT_FOUND',
          message: '未找到本机 Yapped Paramdex/SDT，字段名回落 Smithbox 英文标注。'
        }]
      };
      return yappedOverlayCache;
    }
    const [defs, names] = await Promise.all([
      readYappedSdtDefsIndex(join(sdtRoot, 'Defs')),
      readYappedSdtRowNamesIndex(join(sdtRoot, 'Names'))
    ]);
    yappedOverlayCache = {
      loaded: true,
      defs: defs.ok ? defs.byTypeName : null,
      rowNames: names.ok ? names.byEntryName : null,
      diagnostics: [...defs.diagnostics, ...names.diagnostics]
    };
    return yappedOverlayCache;
  };

  /**
   * PARAM 元数据信任决定的持久化：userData 下的独立 JSON。
   *
   * 为什么不进 app.db：信任决定是一条单值用户设置，不需要事务；而 app.db 走
   * OperationLogUtilityClient 子进程，把它当宿主会让「能不能打开 PARAM 字段
   * 视图」耦合到那个子进程的可用性上。核心逻辑（摘要比对、策略构造）在
   * core 的 paramMetadataTrustStore 里，与存储介质无关。
   *
   * 读失败一律当「未确认」而不抛：一条坏掉的设置不该让 PARAM 打不开，
   * 而重新问一次用户比猜测一个残缺策略的含义安全。
   */
  const trustSettingsPath = join(app.getPath('userData'), 'param-metadata-trust.json');
  const trustSettingsStore: AppSettingsStore = {
    get(key) {
      try {
        const raw = readFileSync(trustSettingsPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const value = parsed[key];
        return typeof value === 'string' ? value : undefined;
      } catch {
        return undefined;
      }
    },
    set(key, valueJson) {
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(readFileSync(trustSettingsPath, 'utf8')) as Record<string, unknown>;
      } catch {
        existing = {};
      }
      existing[key] = valueJson;
      writeFileSync(trustSettingsPath, JSON.stringify(existing, null, 2), 'utf8');
    },
    delete(key) {
      try {
        const existing = JSON.parse(readFileSync(trustSettingsPath, 'utf8')) as Record<string, unknown>;
        delete existing[key];
        writeFileSync(trustSettingsPath, JSON.stringify(existing, null, 2), 'utf8');
      } catch {
        // 文件不存在或已损坏：删除是幂等的，无事可做。
      }
    }
  };

  /**
   * 走**正规**路径取字段定义：包校验 → 描述符匹配 →（T5-2 起）行宽自动授信。
   *
   * 此前生产侧是 `definitions.find((e) => e.document.typeName === typeName)`，
   * 绕过了 matchParamMetadataPackage 的五键严格匹配、包摘要与信任策略三层检查。
   * 那三层守的是「两台机器拿到同名但内容不同的元数据包」—— 偏移对不上就是
   * 往错误字节位置写数值，存出来的 param 静默损坏。
   *
   * 返回的 origin 决定渲染器是否放行字段写入：
   *   · 行宽与定义一致 → 'imported'，写入放行（T5-2 自动授信，不再要求先点信任）；
   *   · 未确认信任 → 不再挡编辑（grok T5：「可留开发者撤销，但不挡编辑」），
   *     仅保留 param.metadata.setTrust 作为开发者侧的可选撤销入口。
   */
  const resolveTrustedParamDefinition = async (
    typeName: string,
    rowDataSize: number
  ): Promise<{
    document: ParamDefDocument | null;
    trusted: boolean;
    diagnostic: { code: string; message: string } | null;
  }> => {
    const metadata = await loadParamMetadata();
    if (!metadata.package) {
      return { document: null, trusted: false, diagnostic: metadata.diagnostic };
    }
    const entry = metadata.package.definitions
      .find((candidate) => candidate.document.typeName === typeName);
    if (!entry) {
      return {
        document: null,
        trusted: false,
        diagnostic: {
          code: 'PARAM_METADATA_TYPE_NOT_FOUND',
          message: `元数据包里没有类型 ${typeName} 的字段定义。`
        }
      };
    }
    if (entry.document.rowDataSize !== rowDataSize) {
      return {
        document: null,
        trusted: false,
        diagnostic: {
          code: 'PARAM_METADATA_ROW_WIDTH_MISMATCH',
          message: `字段定义行宽（${entry.document.rowDataSize}）与真实 PARAM（${rowDataSize}）不一致，`
            + '不做解码 —— 用错位的布局解释字节会产出看似合理但完全错误的数值。'
        }
      };
    }
    // 显示层覆盖：本机 Yapped 有该类型的中文 DisplayName/Description 就套上，
    // 没有（或本机没装 Yapped）就原样回落 Smithbox。覆盖不改变 origin。
    const yapped = await loadYappedOverlay();
    const applyOverlay = (document: ParamDefDocument): ParamDefDocument =>
      yapped.defs ? applyYappedFieldOverlay(document, yapped.defs) : document;
    // T5-2：行宽匹配即授信。包在导入时已核对归档/源树/许可证三个摘要（钉死），
    // 行宽匹配保证本表字段偏移对齐 —— 两把锁都过，不再把「用户点过确认」当第三道门。
    return {
      document: applyOverlay({ ...entry.document, origin: 'imported' }),
      trusted: true,
      diagnostic: null
    };
  };

  /** 当前元数据包的身份与信任状态，供界面显示确认入口。 */
  handle('param.metadata.trustState', async () => {
    const metadata = await loadParamMetadata();
    if (!metadata.package) {
      return {
        ok: false,
        trusted: false,
        packageId: null,
        packageVersion: null,
        diagnostics: metadata.diagnostic
          ? [{
              severity: 'error' as const,
              code: metadata.diagnostic.code,
              message: metadata.diagnostic.message
            }]
          : []
      };
    }
    const decision = readTrustDecision(trustSettingsStore);
    return {
      ok: true,
      trusted: trustCoversPackage(decision, metadata.package),
      packageId: metadata.package.packageId,
      packageVersion: metadata.package.packageVersion,
      sourceIdentity: metadata.package.source?.identity ?? null,
      sourceRevision: metadata.package.source?.revision ?? null,
      licenseSpdxExpression: metadata.package.license?.spdxExpression ?? null,
      ...(decision ? { confirmedAt: decision.confirmedAt } : {}),
      diagnostics: []
    };
  });

  /**
   * 记录用户对当前元数据包的信任决定。
   *
   * 「这个文件是不是那个发布」由钉死策略校验（导入器已核对归档摘要、源树摘要与
   * 许可证摘要）；「你愿不愿意用它」只能由用户回答，应用不预置。
   * 信任绑定到三个摘要而不是包名：包升级或被替换后摘要变化，旧决定不再覆盖，
   * 会重新询问。
   */
  handle('param.metadata.setTrust', async (_event, trusted: boolean) => {
    const metadata = await loadParamMetadata();
    if (!metadata.package) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: metadata.diagnostic?.code ?? 'PARAM_METADATA_UNAVAILABLE',
          message: metadata.diagnostic?.message ?? '元数据包不可用，无法记录信任决定。'
        }]
      };
    }
    if (!trusted) {
      clearTrustDecision(trustSettingsStore);
      return { ok: true, trusted: false, diagnostics: [] };
    }
    const built = buildTrustPolicyFromPackage(
      metadata.package,
      `USER_CONFIRMED_${metadata.package.packageId}_${metadata.package.packageVersion}`
    );
    if (!built.ok) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: built.code,
          message: built.message
        }]
      };
    }
    writeTrustDecision(trustSettingsStore, {
      policy: built.policy,
      confirmedAt: new Date().toISOString()
    });
    return { ok: true, trusted: true, diagnostics: [] };
  });

  handle('resource.readParamDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 PARAM。',
          sourceUri
        }]
      };
    }
    // PARAM-10A「backup 不读」：backup/previous 只经 History & Recovery 显式
    // 只读打开（ROUTE-06）。路由层挡住普通打开路径还不够——绕过路由直接
    // invoke 本通道的调用方也要被同一把锁拒绝，否则 backup 会以普通 PARAM
    // 文档的身份出现在编辑器里。
    if (isParamBackupPath(file.relativePath)) {
      return {
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        fieldDefs: null,
        fieldEnums: null,
        fieldDefsDiagnostic: null,
        fieldDefsOrigin: null,
        fieldDefsTrusted: false,
        rows: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'BACKUP_READ_FORBIDDEN',
          message: 'backup 文件只能在 History & Recovery 中以只读方式查看，不能作为 PARAM 文档读取。',
          sourceUri
        }]
      };
    }
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) {
      return sanitizeRendererValue({
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        fieldDefs: null,
        fieldEnums: null,
        fieldDefsDiagnostic: null,
        fieldDefsOrigin: null,
        fieldDefsTrusted: false,
        rows: [],
        diagnostics: roots.diagnostics
      });
    }
    const result = await readParamDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots: roots.allowedRoots,
      maxRows: 500
    });
    // 字段定义：走 resolveTrustedParamDefinition（包校验 + 行宽核对 + 用户信任
    // 策略），不再直接 definitions.find(...) 绕过那三层检查。
    //
    // 缺失不影响行数据返回 —— 那部分来自 native 解析，是权威的。fieldDefs 为
    // null 时界面显示「无字段定义」并说明原因，而不是一个空的第三列。
    //
    // definitions[].document 才是 ParamDefDocument —— definitions[] 本身只有
    // key/digest/document 三项。逐字段核对过 shared/paramdef.ts，没有靠猜：
    // 第一版我写成 def.typeName、f.enumId、f.bitSize，三处全错（真实为
    // def.document.typeName、f.enumRef、f.bitfield）。IPC 边界上这类错误
    // typecheck 未必拦得住，只表现为「字段列空着」。
    const typeName = result.data?.typeName ?? '';
    const resolved = typeName && result.data
      ? await resolveTrustedParamDefinition(typeName, result.data.rowDataSize)
      : { document: null, trusted: false, diagnostic: null };
    const paramDef = resolved.document;
    // 行宽已在 resolveTrustedParamDefinition 里核对过：拿到 document 就意味着
    // 行宽一致，拿不到时它给出 ROW_WIDTH_MISMATCH 诊断。
    const rowWidthMatches = paramDef !== null;

    return sanitizeRendererValue({
      ok: result.ok,
      sourceUri,
      relativePath: file.relativePath,
      // 字段定义与行宽是否对得上：行宽不一致时不做解码 —— 用错位的布局解释字节
      // 会产出看起来合理但完全错误的数值，那比没有字段列危险得多。
      fieldDefs: rowWidthMatches && paramDef
        ? paramDef.fields.map((field) => ({
            id: field.id,
            name: field.name,
            type: field.type,
            offset: field.offset,
            size: field.size,
            ...(field.bitfield ? { bitfield: field.bitfield } : {}),
            ...(field.enumRef ? { enumRef: field.enumRef } : {}),
            // 跨表引用原样透传（解析在渲染器侧用 core 的纯函数做）：
            // 这里做解析会把一个字段变成一棵结构，IPC 面上更容易漂移。
            ...(field.refs ? { refs: field.refs } : {}),
            ...(field.min !== undefined ? { min: field.min } : {}),
            ...(field.max !== undefined ? { max: field.max } : {})
          }))
        : null,
      // 枚举定义随字段一起给：界面要把 0/1/2 显示成可读名称，
      // 而不是让用户对着裸数字猜。
      fieldEnums: rowWidthMatches && paramDef?.enums
        ? paramDef.enums.map((enumDef) => ({
            id: enumDef.id,
            name: enumDef.name,
            // 枚举值的显示名叫 label（不是 name）——这是本轮第四处猜错的字段名，
            // 前三处是 def.typeName / f.enumId / f.bitSize。全部按
            // shared/paramdef.ts 逐字段核对后改正。
            values: enumDef.values.map((value) => ({ value: value.value, label: value.label }))
          }))
        : null,
      // 诊断统一来自 resolveTrustedParamDefinition：它区分「包不可用」
      // 「类型不存在」「行宽不符」「尚未授信」四种情形，各自给出可行动的码。
      // 尤其「尚未授信」不是故障 —— 字段可读、只是写入未放行，文案必须说清
      // 下一步动作（确认一次），否则用户会以为功能坏了。
      fieldDefsDiagnostic: resolved.diagnostic,
      /**
       * 字段定义的授信状态。渲染器据此决定是否放行字段写入。
       *
       * origin 是 'imported' 才放行 —— 这个值不是渲染器自己拼的，而是主进程
       * 在包校验、行宽核对与用户信任策略都通过后才给出的。
       */
      fieldDefsOrigin: paramDef?.origin ?? null,
      fieldDefsTrusted: resolved.trusted,
      data: result.data
        ? {
            sourceHash: result.data.sourceHash,
            typeName: result.data.typeName,
            rowCount: result.data.rowCount,
            rowDataSize: result.data.rowDataSize,
            // dataBase64 必须逐行判类型：Bridge 对超出载荷门限的页不下发行字节
            // （见 resource.readParamPage 头部注释的实测因果），真实 gameparam
            // 几乎总是这种情况。此前无条件 Buffer.from(undefined) 会抛 TypeError，
            // 而 handle 包装没有 try/catch，于是整个 IPC promise reject，渲染器
            // 只看到「PARAM 读取异常」——把「本页没有字节」报成了「读取失败」。
            rows: result.data.rows.map((r) => ({
              id: r.id,
              ...(typeof r.dataBase64 === 'string'
                ? {
                    dataBase64: r.dataBase64,
                    dataHexPreview: Buffer.from(r.dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              dataHash: r.dataHash,
              ...(r.name ? { name: r.name } : {})
            })),
            rowsTruncated: result.data.rowCount > result.data.rows.length,
            authority: result.data.authority
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  /**
   * GPARAM-11A：graphics param（.gparam / .gparam.dcx）typed 读取。
   *
   * 与 PARAM 同一把锁：backup 不读（.bak/.prev 只经 History & Recovery 显式
   * 只读打开）；未索引资源结构化失败。Bridge 侧 read-gparam-document 解 DCX
   * （KRAK 需要 Oodle 运行时，故传 activeSession.layers.baseRoot）并返回
   * 分组分页的 typed 文档 —— 不能借 PARAM parser，也不能把读取失败显示成
   * 空 bank（失败一律 ok:false + 结构化诊断）。
   */
  handle('resource.readGparamDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
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
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) {
      return sanitizeRendererValue({
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        data: null,
        diagnostics: roots.diagnostics
      });
    }
    const gameRoot = activeSession?.layers.baseRoot;
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

  /**
   * GPARAM-11C：drawparam 的 typed 字段写入（loose / DCX storage profile）。
   *
   * 与 PARAM 容器通道同一形态：typed field-set mutation（group→param→
   * valueIndex→value）→ write-gparam（C#：只认 typed 定位，无 bytes replace
   * fallback；重读验证目标值与兄弟值后才报告 GPARAM_STAGING_WRITE_VERIFIED）
   * → stageBridgeOutput 落暂存 → applyNativeMutation 经 Patch Engine 提交
   * （含备份、确认与回滚元数据）。DCX 源需要 Oodle 运行时（baseRoot）。
   *
   * expectedDocumentHash 由渲染器回传 read 时的 sourceHash：哈希不符说明
   * 工作副本已漂移，拒绝写入（并发保护，与 PARAM 同一语义）。
   */
  handle(
    'resource.commitGparamMutations',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      mutations: GparamFieldSetMutation[]
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
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
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
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
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'GPARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
      const gameRoot = activeSession.layers.baseRoot;
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
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * MTD 材质属性写回（MATERIAL-53C）。与 commitGparamMutations 同一形态：
   * typed property set（paramId + newValue）→ write-mtd-document（C#：只认 typed
   * 定位，目标 param 文本区间含 XML 标记时 fail-closed MTD_WRITE_BLOCKED_）
   * → stageBridgeOutput 落暂存 → applyNativeMutation 经 Patch Engine 提交
   * （含备份、确认与回滚元数据）。DCX 源需要 Oodle 运行时（baseRoot）。
   *
   * expectedDocumentHash 由渲染器回传 read 时的 sourceHash：哈希不符说明
   * 工作副本已漂移，拒绝写入（并发保护，与 PARAM/GPARAM 同一语义）。
   */
  handle(
    'resource.commitMtdPropertySet',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      set: { paramId: string; newValue?: string }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
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
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
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
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'MTD_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
      const gameRoot = activeSession.layers.baseRoot;
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
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * BEHAVIOR-55C：ESD 状态转移写回（behavior-transition-upsert）。
   *
   * 渲染器回传读时的 sourceHash 作为 expectedDocumentHash；mutation 为
   * set-transition-target（字节级外科替换条件 targetStateOffset，-1 清空）/
   * insert-transition（entry 表内新增裸跳转条件）——命令参数体（RPN 字节码）
   * 永久不解码，任何触碰它的 mutation 由 C# 侧以 ESD_WRITE_BLOCKED_UNKNOWN_STRUCTURE
   * fail-closed。写链照 MTD/PARAM 同一范式：stageBridgeOutput 落暂存 →
   * applyNativeMutation 经 Patch Engine 提交（含备份、确认与回滚元数据）。
   * ESD 在 talkesdbnd.dcx 容器内时，容器外层重建由 Patch 管线完成。
   */
  handle(
    'resource.commitEsdTransition',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      mutations: EsdTransitionMutation[]
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
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
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
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
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'ESD_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
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
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * ANIMATION-56C：TAE 事件写回（tae-event-upsert）。
   *
   * 渲染器回传读时的 sourceHash 作为 expectedDocumentHash；mutation 为
   * update-event-times（字节级外科替换事件 startTime/endTime float32，时间槽被
   * 兄弟事件共享时 C# 侧 fail-closed TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE）/
   * insert-event（事件参数体按模板逐字节拷贝后追加新事件）。写链照
   * ESD/PARAM 同一范式：stageBridgeOutput 落暂存 → applyNativeMutation 经
   * Patch Engine 提交（含备份、确认与回滚元数据）。TAE 在 anibnd.dcx 容器内时，
   * 容器外层重建由 Patch 管线完成。
   */
  handle(
    'resource.commitTaeEvent',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      mutations: TaeEventUpsertMutation[]
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
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
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
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
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'TAE_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
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
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * VFX-54C：FXR 字段写回（vfx-field-set）。
   *
   * 渲染器回传读时的 sourceHash 作为 expectedDocumentHash；mutation 为
   * vfx-field-set（字节级外科替换某个「已知布局」容器——host/property/section8——
   * 里 Section11 的一个 Int32）。C# 侧只在整份文件结构被完全理解时开放写入口：
   * 未识别 node type、layout warning、Section9 非空、Section12-14 非空都会以
   * FXR_WRITE_BLOCKED_UNKNOWN_STRUCTURE fail-closed。写链照 ESD/TAE 同一范式：
   * stageBridgeOutput 落暂存 → applyNativeMutation 经 Patch Engine 提交（含备份、
   * 确认与回滚元数据）。FXR 在 ffxbnd.dcx 容器内时，容器外层重建由 Patch 管线完成。
   */
  handle(
    'resource.commitFxrFieldSet',
    async (
      event,
      sourceUri: string,
      expectedDocumentHash: string,
      mutations: VfxFieldSetMutation[]
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
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
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
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
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'FXR_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
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
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * Paginated PARAM row access (hard constraint 17). Main assembles/caches the
   * complete row table once (up to MAX_PAGED_PARAM_ROWS) and serves bounded
   * pages; the renderer never receives the whole document. `query` filters the
   * complete table in main so search covers every page. Rows carry full bytes
   * so the renderer can duplicate rows and edit fields without the full set.
   *
   * ── 行字节为什么要单独再取一页(2026-08-10 实测)──
   *
   * C# 的载荷门控是按**页**算的（ParamNativeDocument.ToEnvelope）：页行数超过
   * rowPreviewLimit（默认 32）或页字节数超过 512 KB 时，整页 `dataBase64` 全为 null。
   * 而全表读取等于「页大小 = 总行数」，必然超限，于是缓存下来的每一行都没有字节。
   *
   * 实测同一个 BehaviorParam（5275 行 × 32 字节）：
   *   commandOptions {}                  → rows 5275, payloadsIncluded=false, 无字节
   *   commandOptions {rowPage:0,size:20} → rows 20,   payloadsIncluded=true,  有字节
   * ATK_PARAM_ST（537 行 × 464 字节）在 pageSize 32 下同样带字节。
   *
   * 后果曾是：行表能显示 id/name，但字段解码、行复制、字段编辑全部拿不到输入 ——
   * 「PARAM 页面不可编辑」的直接原因之一。
   *
   * 所以这里分两次读：
   *   ① 全表一次（无分页）—— 只为 id/name 索引与跨页搜索，字节缺失是预期的；
   *   ② 当前页一次（带 rowPage/rowPageSize）—— 取这一页的真实字节。
   * 只有在无搜索、页窗口与 bridge 页对齐时②才可用；有搜索时页内容是过滤后的
   * 子集，与 bridge 的物理页不对应，此时如实不给字节而不是给错字节。
   */
  handle(
    'resource.readParamPage',
    async (
      _event,
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      query?: string,
      loadAll?: boolean
    ) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (message: string, code = 'RESOURCE_NOT_INDEXED') => ({
        ok: false,
        sourceUri,
        sourceHash: null,
        rowCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        rows: [],
        rowsTruncated: false,
        diagnostics: [{
          severity: 'error' as const,
          code,
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('资源未索引，无法分页读取 PARAM。');
      }
      // PARAM-10A「backup 不读」：与 readParamDocument 同一把锁。backup 只经
      // History & Recovery 只读打开（ROUTE-06），分页通道不提供绕过出口。
      if (isParamBackupPath(file.relativePath)) {
        return failure('backup 文件只能在 History & Recovery 中以只读方式查看，不能分页读取 PARAM。', 'BACKUP_READ_FORBIDDEN');
      }
      let cached = loadAll ? paramAllCache.get(sourceUri) : paramPageCache.get(sourceUri);
      if (!cached) {
        // 直接调 Bridge 而不用 readParamDocumentViaBridge：后者不传 commandOptions。
        //
        // 注意原注释声称「不传 commandOptions 会让 C# 抛 InvalidOperationException」
        // ——2026-08-10 实测该说法**已不成立**：BridgeCommandService 的 optionsIsObject
        // 守卫（commit 5b669c6）修掉了那个 crash，现在不传会正常返回、只是没有行字节。
        // 保留显式空对象仍然是对的（不依赖对端的缺省行为），但理由变了，故更正记录，
        // 避免后来者按过期结论去「修」一个不存在的 crash。
        //
        // 这里刻意读全表（无 rowPage/rowPageSize）：全表用于 id/name 索引与跨页搜索。
        // 全表必然超出载荷门限因而无字节，当前页的字节在下方单独取一次。
        // loadAll（用户裁定 2026-08-14）则相反：includeAllPayloads 跳过门控，
        // 一次拿回全表 + 全部行字节（帧上限提到 32 MiB 绝对上限）。
        const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
        if (roots.diagnostics.length > 0) {
          return {
            ok: false,
            sourceUri,
            sourceHash: null,
            rowCount: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            rows: [],
            rowsTruncated: false,
            diagnostics: roots.diagnostics
          };
        }
        const result = await runBridge<{
          sourceHash?: string;
          typeName?: string;
          dataVersion?: number;
          rowCount?: number;
          rowDataSize?: number;
          rows?: Array<{ id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
          authority?: string;
        }>({
          command: 'read-param-document',
          filePath: file.absolutePath,
          allowedRoots: roots.allowedRoots,
          timeoutMs: 120_000,
          commandOptions: loadAll ? { includeAllPayloads: true } : {},
          ...(loadAll ? { maxFrameBytes: 32 * 1024 * 1024 } : {})
        });
        if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
          return {
            ok: false,
            sourceUri,
            sourceHash: null,
            rowCount: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            rows: [],
            rowsTruncated: false,
            diagnostics: result.diagnostics
          };
        }
        const rows = (result.data.rows ?? []).slice(0, MAX_PAGED_PARAM_ROWS);
        cached = {
          sourceHash: result.data.sourceHash,
          typeName: result.data.typeName ?? 'UNKNOWN_PARAM',
          rowDataSize: result.data.rowDataSize ?? 0,
          rowCount: result.data.rowCount ?? rows.length,
          rows,
          ...(result.data.authority ? { authority: result.data.authority } : {})
        };
        if (loadAll) paramAllCache.set(sourceUri, cached);
        else paramPageCache.set(sourceUri, cached);
      }
      const q = (query ?? '').trim().toLowerCase();
      const filtered = q.length === 0
        ? cached.rows
        : cached.rows.filter((row) =>
            String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
          );

      // ── 全量路径（用户裁定）：打开表一次返回全部行（含字节），renderer 本地
      //    过滤/虚拟化，不再分批续取。行字节已经随 includeAllPayloads 全量在手，
      //    不再走下方的页字节二次读取。字段定义照常解析（裸 param 路径的
      //    ParamDefPanel 依赖它，与 readParamDocument 同一套三层检查）。
      if (loadAll) {
        const loadAllTypeName = cached.typeName ?? '';
        const loadAllResolved = loadAllTypeName
          ? await resolveTrustedParamDefinition(loadAllTypeName, cached.rowDataSize)
          : { document: null, trusted: false, diagnostic: null };
        const loadAllParamDef = loadAllResolved.document;
        const loadAllWidthMatches = loadAllParamDef !== null;
        return {
          ok: true,
          sourceUri,
          sourceHash: cached.sourceHash,
          typeName: cached.typeName,
          rowDataSize: cached.rowDataSize,
          fieldDefs: loadAllWidthMatches && loadAllParamDef
            ? loadAllParamDef.fields.map((field) => ({
                id: field.id,
                name: field.name,
                type: field.type,
                offset: field.offset,
                size: field.size,
                ...(field.bitfield ? { bitfield: field.bitfield } : {}),
                ...(field.enumRef ? { enumRef: field.enumRef } : {}),
                ...(field.refs ? { refs: field.refs } : {}),
                ...(field.min !== undefined ? { min: field.min } : {}),
                ...(field.max !== undefined ? { max: field.max } : {})
              }))
            : null,
          fieldEnums: loadAllWidthMatches && loadAllParamDef?.enums
            ? loadAllParamDef.enums.map((enumDef) => ({
                id: enumDef.id,
                name: enumDef.name,
                values: enumDef.values.map((value) => ({ value: value.value, label: value.label }))
              }))
            : null,
          fieldDefsDiagnostic: loadAllResolved.diagnostic,
          fieldDefsOrigin: loadAllParamDef?.origin ?? null,
          fieldDefsTrusted: loadAllResolved.trusted,
          rowCount: filtered.length,
          page: 0,
          pageSize: filtered.length,
          pageCount: 1,
          rows: filtered.map((row) => {
            const dataBase64 = typeof row.dataBase64 === 'string' ? row.dataBase64 : undefined;
            return {
              id: row.id,
              ...(dataBase64 !== undefined
                ? {
                    dataBase64,
                    dataHexPreview: Buffer.from(dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              ...(row.name ? { name: row.name } : {})
            };
          }),
          rowsTruncated: cached.rowCount > cached.rows.length,
          ...(cached.authority ? { authority: cached.authority } : {}),
          diagnostics: []
        };
      }
      const window = normalizePageWindow(
        filtered.length,
        requestedPage,
        requestedPageSize || PARAM_PAGE_SIZE
      );

      /**
       * 取当前页的真实行字节（见本 handler 头部注释的实测因果）。
       *
       * 仅在无搜索时进行：有搜索时页内容是过滤后的子集，与 bridge 的物理页不
       * 对应，按物理页取回的字节会**对错行**。宁可不给字节，也不能给错字节 ——
       * 错字节会被写回去，那是静默的数据损坏。
       *
       * 失败不影响行表：字节缺失只让字段编辑不可用，而 id/name 列表仍然有用。
       * 因此这里吞掉分页读取的失败但把诊断带出去，不让整个面板变空。
       */
      const pageBytes = new Map<number, string>();
      const pageByteDiagnostics: Diagnostic[] = [];
      if (q.length === 0 && window.size > 0) {
        const bridgePage = Math.floor(window.offset / window.size);
        const alignedOffset = bridgePage * window.size;
        if (alignedOffset === window.offset) {
          // ROOT-07：只读分页字节读取同样只传已存在并 verified 的 roots；
          // 失败与读取失败同语义——字节缺失只让字段编辑不可用，不影响行表。
          const pageRoots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
          if (pageRoots.diagnostics.length > 0) {
            pageByteDiagnostics.push(...pageRoots.diagnostics);
          } else {
          try {
            const paged = await runBridge<{
              rows?: Array<{ id: number; dataBase64?: string | null }>;
              payloadsIncluded?: boolean;
            }>({
              command: 'read-param-document',
              filePath: file.absolutePath,
              allowedRoots: pageRoots.allowedRoots,
              timeoutMs: 60_000,
              commandOptions: { rowPage: bridgePage, rowPageSize: window.size }
            });
            for (const row of paged.data?.rows ?? []) {
              if (typeof row.dataBase64 === 'string') pageBytes.set(row.id, row.dataBase64);
            }
            if (paged.data?.payloadsIncluded === false) {
              pageByteDiagnostics.push({
                severity: 'info',
                code: 'PARAM_PAGE_PAYLOAD_OMITTED',
                message: '本页行字节未随分页下发（页字节数超出 Bridge 载荷门限）；'
                  + '字段编辑对本页不可用，行列表不受影响。',
                sourceUri
              });
            }
          } catch (error) {
            pageByteDiagnostics.push({
              severity: 'warning',
              code: 'PARAM_PAGE_PAYLOAD_READ_FAILED',
              message: `本页行字节读取失败：${error instanceof Error ? error.message : String(error)}`,
              sourceUri
            });
          }
          }
        }
      }

      return {
        ok: true,
        sourceUri,
        sourceHash: cached.sourceHash,
        typeName: cached.typeName,
        rowDataSize: cached.rowDataSize,
        rowCount: filtered.length,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        rows: filtered
          .slice(window.offset, window.offset + window.size)
          .map((row) => {
            // 字节优先取本页分页读取的结果（全表读取的行恒无字节，见头部注释）。
            // 两处都没有时如实不带该字段——绝不伪造字节。
            const dataBase64 = typeof row.dataBase64 === 'string'
              ? row.dataBase64
              : pageBytes.get(row.id);
            return {
              id: row.id,
              ...(typeof dataBase64 === 'string'
                ? {
                    dataBase64,
                    dataHexPreview: Buffer.from(dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              ...(row.name ? { name: row.name } : {})
            };
          }),
        rowsTruncated: cached.rowCount > cached.rows.length,
        ...(cached.authority ? { authority: cached.authority } : {}),
        diagnostics: pageByteDiagnostics
      };
    }
  );

  handle(
    'resource.applyParamMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: { kind: 'upsert' | 'delete'; id: number; dataBase64?: string }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 PARAM。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (mutation.kind === 'upsert' && !mutation.dataBase64) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_UPSERT_DATA_REQUIRED',
            message: 'PARAM upsert 需要 dataBase64。',
            sourceUri
          }]
        };
      }
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const bridgeMutation =
        mutation.kind === 'delete'
          ? { kind: 'delete' as const, id: mutation.id }
          : { kind: 'upsert' as const, id: mutation.id, dataBase64: mutation.dataBase64! };
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'param',
        stagingFileName: `${basename(file.relativePath)}.mut.param`,
        stageWrite: (context) => commitParamMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation
        }),
        title: `PARAM mutation ${mutation.kind} ${mutation.id}`,
        confirmActionLabel: '提交 PARAM 变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) paramPageCache.delete(sourceUri);
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  handle(
    'resource.applyParamFieldMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: {
        rowId: number;
        fieldId: string;
        value: number | string | boolean;
        rowDataBase64: string;
        definition: unknown;
      }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 PARAM。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;

      // Apply field-level mutation to get the modified row bytes
      const fieldResult = applyParamFieldMutation({
        rowDataBase64: mutation.rowDataBase64,
        definition: mutation.definition as ParamDefDocument,
        fieldId: mutation.fieldId,
        value: mutation.value
      });
      if (!fieldResult.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: fieldResult.code,
            message: fieldResult.message,
            sourceUri
          }]
        };
      }

      // Send the modified row as a whole-row upsert to the Bridge
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'param',
        stagingFileName: `${basename(file.relativePath)}.field.param`,
        stageWrite: (context) => commitParamMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: { kind: 'upsert' as const, id: mutation.rowId, dataBase64: fieldResult.nextDataBase64 }
        }),
        title: `PARAM field set ${mutation.fieldId} on row ${mutation.rowId}`,
        confirmActionLabel: '提交 PARAM 字段变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) paramPageCache.delete(sourceUri);
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * 容器内 param 的字段写入：改字段 → 重打包容器 → Patch Engine 提交。
   *
   * ── 为什么单独一条通道 ──
   *
   * resource.applyParamFieldMutation 的写目标是**裸 param 文件**；而用户实际打开
   * 的是 parambnd 容器，改动必须回到容器里才算生效。这一段此前缺失：write-param
   * 只能产出一个裸 param 暂存文件，没有路径把它塞回 BND4 再压 DCX。
   *
   * ── 三段链路，全部在 staging 完成，只有最后一步经 Patch Engine 落盘 ──
   *
   *   ① applyParamFieldMutation（TS）——把字段值编码进行字节，得到整行 base64；
   *   ② write-param（C#）——以整行 upsert 产出改过的裸 param（暂存）；
   *   ③ write-bnd4 replace（C#）——把该裸 param 按 entryIndex 塞回容器副本，
   *      C# 侧写完会重读验证（BND4_STAGING_WRITE_VERIFIED）。
   *
   * ②③ 的输出都落会话 stagingRoot；真正的落盘由 applyNativeMutation 的
   * commit port（Patch Engine）完成，含备份与回滚元数据。
   *
   * ── 实测（2026-08-10，mods/param/gameparam/gameparam.parambnd.dcx 副本）──
   *
   * 138 个条目：条目数不变，只有目标条目（index 7 = BehaviorParam）内容哈希变化，
   * 其余 137 个字节不变，write-bnd4 重读验证通过。也就是说重打包不会波及无关条目。
   *
   * ── expectedChildHash 为什么必须由调用方给 ──
   *
   * C# 的 replace 会拿它比对容器内当前条目的存储字节（Bnd4NativeWriter 的
   * RequireHash）。不给就没有并发保护：两个改动同时基于同一份旧字节时，
   * 后一个会静默覆盖前一个。渲染器持有解包时的条目哈希，原样回传。
   */
  handle(
    'resource.applyContainerParamFieldMutation',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      mutation: {
        entryIndex: number;
        expectedChildHash: string;
        rowId: number;
        fieldId: string;
        value: number | string | boolean;
        rowDataBase64: string;
        definition: unknown;
      }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入容器内 PARAM。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;

      // ① 字段值编码进行字节。定义未授信时 applyParamFieldMutation 之前就该被
      //    渲染器挡住，但这里不依赖前端守卫 —— 它只校验行宽与 base64 合法性，
      //    真正的授权判定在 resolveTrustedParamDefinition 给出的 origin 上。
      const definition = mutation.definition as ParamDefDocument;
      if (definition?.origin !== 'imported' && definition?.origin !== 'user-derived') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_FIELD_DEFINITION_NOT_TRUSTED',
            message: '字段定义来源未授信，拒绝写入。元数据字段偏移若与真实 PARAM 不符，'
              + '按它写入就是往错误字节位置塞数值。请先确认信任该元数据包。',
            sourceUri: containerUri
          }]
        };
      }
      const fieldResult = applyParamFieldMutation({
        rowDataBase64: mutation.rowDataBase64,
        definition,
        fieldId: mutation.fieldId,
        value: mutation.value
      });
      if (!fieldResult.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: fieldResult.code,
            message: fieldResult.message,
            sourceUri: containerUri
          }]
        };
      }

      // 解包目标条目：write-param 需要一个裸 param 作为输入基底。
      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: file.sha256 ?? expectedContainerHash,
        entry: { index: mutation.entryIndex }
      });
      if (!unpacked.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: sanitizeDiagnostics(unpacked.diagnostics)
        };
      }

      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      // ROOT-07：stage 前 mkdir → realpath → boundary check；两处回调共用。
      const stage = await verifiedStageRoots(activeSession, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
      const oodle = activeSession.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {};

      // ② 先在暂存区产出改过的裸 param。用 stageBridgeOutput 而不是自己建目录：
      //    它保证输出路径不逃逸、用完清理，且失败带结构化诊断。
      const paramStage = await stageBridgeOutput({
        stagingRoot: storage.stagingRoot,
        prefix: 'param-field',
        fileName: `${basename(unpacked.child.name)}.mutated`,
        allowedRoots: () => [...stage.allowedRoots],
        write: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-param',
            filePath: unpacked.child.absolutePath,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 120_000,
            commandOptions: {
              outputPath: context.outputPath,
              // expectedDocumentHash 是 Bridge write-param 的必填并发保护：哈希不符
              // 说明「读与写之间条目被改过」，拒绝写入。实测（probeParamWrite）缺它会
              // 恒定 PARAM_STAGING_WRITE_FAILED。unpacked.child.storedContentHash 就是
              // 该裸 param 文件的 SourceHash（entry ContentHash 对存储字节取哈希）。
              expectedDocumentHash: unpacked.child.storedContentHash,
              mutation: 'upsert',
              id: mutation.rowId,
              dataBase64: fieldResult.nextDataBase64
            }
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        }
      });
      if (!paramStage.ok || !paramStage.bytes) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            ...sanitizeDiagnostics(paramStage.result?.diagnostics ?? []),
            ...paramStage.diagnostics.map((diagnostic) => ({
              severity: 'error' as const,
              code: diagnostic.code,
              message: diagnostic.message,
              sourceUri: containerUri
            })),
            {
              severity: 'error' as const,
              code: 'PARAM_FIELD_STAGE_FAILED',
              message: '字段改动未能产出裸 param 暂存文件，容器未被修改。',
              sourceUri: containerUri
            }
          ]
        };
      }
      const mutatedChildBase64 = paramStage.bytes.toString('base64');

      // ③ 把裸 param 塞回容器，经 Patch Engine 提交重打包后的容器。
      const outcome = await applyNativeMutation({
        file,
        sourceUri: containerUri,
        expectedHash: expectedContainerHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'parambnd',
        stagingFileName: `${basename(file.relativePath)}.repacked`,
        stageWrite: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-bnd4',
            filePath: file.absolutePath,
            resourceUri: containerUri,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 180_000,
            commandOptions: {
              outputPath: context.outputPath,
              mutation: 'replace',
              expectedContainerHash,
              entryIndex: mutation.entryIndex,
              expectedChildHash: mutation.expectedChildHash,
              contentBase64: mutatedChildBase64
            },
            ...oodle
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'BND4_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        },
        title: `PARAM field ${mutation.fieldId} on row ${mutation.rowId}`
          + ` in ${unpacked.child.name}`,
        confirmActionLabel: '提交容器内 PARAM 字段变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });

      if (outcome.status === 'committed' && outcome.result.ok) {
        // 容器变了：行缓存、条目缓存与解包缓存全部失效，否则下一次读会拿到旧字节。
        paramPageCache.delete(containerUri);
        containerChildrenCache.clear();
        unpackedParamCache.clear();
      }
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * 容器内 PARAM 的**行名**写入（T5-3）。
   *
   * 与 resource.applyContainerParamFieldMutation 走同一条 Patch 链（grok T5：
   * 「提交走与字段写入相同的 Patch 链，禁止 fs.writeFile 写 Mod」）：
   *
   *   ① write-param upsert（C#）—— 行数据原样回传、只带新 name，产出改过的裸 param；
   *   ② write-bnd4 replace（C#）—— 按 entryIndex 塞回容器副本，C# 侧重读验证；
   *   ③ 真正落盘由 applyNativeMutation 的 commit port（Patch Engine）完成，含备份
   *      与回滚元数据。
   *
   * name 允许空串（清掉该行名字）。upsert 的 dataBase64 必须原样携带当前行字节：
   * C# 的 ApplyCompactMutations 对 upsert 强制要求 dataBase64 且长度=行宽，
   * 名字只改不改数据，字节原样回传即可。
   */
  handle(
    'resource.applyContainerParamRowNameMutation',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      mutation: {
        entryIndex: number;
        expectedChildHash: string;
        rowId: number;
        name: string;
        rowDataBase64: string;
      }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入容器内 PARAM 行名。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      if (typeof mutation.name !== 'string') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_ROW_NAME_INVALID',
            message: '行名必须是字符串。',
            sourceUri: containerUri
          }]
        };
      }
      if (typeof mutation.rowDataBase64 !== 'string' || mutation.rowDataBase64.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_ROW_DATA_MISSING',
            message: '行名写入需要当前行字节（原样回传，避免写宽错位）。',
            sourceUri: containerUri
          }]
        };
      }

      // 解包目标条目：write-param 需要一个裸 param 作为输入基底。
      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: file.sha256 ?? expectedContainerHash,
        entry: { index: mutation.entryIndex }
      });
      if (!unpacked.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: sanitizeDiagnostics(unpacked.diagnostics)
        };
      }

      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const stage = await verifiedStageRoots(activeSession, storage, 'PARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await ensureActiveOperationLog(activeSession);
      const oodle = activeSession.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {};

      // ① 暂存区产出改过行名的裸 param。expectedDocumentHash = 该裸 param 的
      //    SourceHash（= 容器条目的 ContentHash，见字段写入的注释）。
      const paramStage = await stageBridgeOutput({
        stagingRoot: storage.stagingRoot,
        prefix: 'param-row-name',
        fileName: `${basename(unpacked.child.name)}.renamed`,
        allowedRoots: () => [...stage.allowedRoots],
        write: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-param',
            filePath: unpacked.child.absolutePath,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 120_000,
            commandOptions: {
              outputPath: context.outputPath,
              expectedDocumentHash: unpacked.child.storedContentHash,
              mutation: 'upsert',
              id: mutation.rowId,
              dataBase64: mutation.rowDataBase64,
              name: mutation.name
            }
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        }
      });
      if (!paramStage.ok || !paramStage.bytes) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            ...sanitizeDiagnostics(paramStage.result?.diagnostics ?? []),
            ...paramStage.diagnostics.map((diagnostic) => ({
              severity: 'error' as const,
              code: diagnostic.code,
              message: diagnostic.message,
              sourceUri: containerUri
            })),
            {
              severity: 'error' as const,
              code: 'PARAM_ROW_NAME_STAGE_FAILED',
              message: '行名改动未能产出裸 param 暂存文件，容器未被修改。',
              sourceUri: containerUri
            }
          ]
        };
      }
      const renamedChildBase64 = paramStage.bytes.toString('base64');

      // ② 把裸 param 塞回容器，经 Patch Engine 提交重打包后的容器。
      const outcome = await applyNativeMutation({
        file,
        sourceUri: containerUri,
        expectedHash: expectedContainerHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'parambnd',
        stagingFileName: `${basename(file.relativePath)}.repacked`,
        stageWrite: async (context) => {
          const written = await runBridge<Record<string, unknown>>({
            command: 'write-bnd4',
            filePath: file.absolutePath,
            resourceUri: containerUri,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            timeoutMs: 180_000,
            commandOptions: {
              outputPath: context.outputPath,
              mutation: 'replace',
              expectedContainerHash,
              entryIndex: mutation.entryIndex,
              expectedChildHash: mutation.expectedChildHash,
              contentBase64: renamedChildBase64
            },
            ...oodle
          });
          return {
            ok: written.parseStatus !== 'failed'
              && written.diagnostics.some(
                (diagnostic) => diagnostic.code === 'BND4_STAGING_WRITE_VERIFIED'
              ),
            diagnostics: written.diagnostics
          };
        },
        title: `PARAM row name for row ${mutation.rowId} in ${unpacked.child.name}`,
        confirmActionLabel: '提交容器内 PARAM 行名变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });

      if (outcome.status === 'committed' && outcome.result.ok) {
        paramPageCache.delete(containerUri);
        containerChildrenCache.clear();
        unpackedParamCache.clear();
      }
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * 解包容器内 param 并全量读出（T5-4 导入导出的公共前置）。
   *
   * 与 resource.readContainerParamPage 同一条前置链：unpackContainerParamChild
   * 先把条目解成裸 param 落会话暂存区，再 read-param-document（includeAllPayloads）
   * 一次拿回全部行字节。返回的 child 同时携带 storedContentHash —— 那是写回
   * write-param 时 requiredDocumentHash 的并发保护凭据。
   */
  const readContainerParamFull = async (input: {
    file: IndexedFile;
    containerUri: string;
    expectedContainerHash: string;
    entryIndex: number;
  }): Promise<
    | {
        ok: true;
        child: UnpackedParamChild;
        typeName: string;
        rowDataSize: number;
        rows: Array<{ id: number; dataBase64?: string | null; name?: string }>;
        diagnostics: Diagnostic[];
      }
    | { ok: false; diagnostics: Diagnostic[] }
  > => {
    const unpacked = await unpackContainerParamChild({
      containerPath: input.file.absolutePath,
      containerUri: input.containerUri,
      containerHash: input.file.sha256 ?? input.expectedContainerHash,
      entry: { index: input.entryIndex }
    });
    if (!unpacked.ok) return { ok: false, diagnostics: sanitizeDiagnostics(unpacked.diagnostics) };
    const stageRoots = activeSession
      ? await verifiedStageRoots(
          activeSession,
          durableStoragePaths(activeSession.meta.workspaceId),
          'PARAM_STAGING_PREPARE_FAILED'
        )
      : null;
    if (stageRoots && stageRoots.diagnostics.length > 0) {
      return { ok: false, diagnostics: stageRoots.diagnostics };
    }
    const allowedRoots = stageRoots
      ? [...stageRoots.allowedRoots]
      : [dirname(unpacked.child.absolutePath)];
    const full = await runBridge<{
      sourceHash?: string;
      typeName?: string;
      rowDataSize?: number;
      rows?: Array<{ id: number; dataBase64?: string | null; name?: string }>;
    }>({
      command: 'read-param-document',
      filePath: unpacked.child.absolutePath,
      allowedRoots,
      timeoutMs: 120_000,
      commandOptions: { includeAllPayloads: true },
      maxFrameBytes: 32 * 1024 * 1024
    });
    if (full.parseStatus === 'failed' || !full.data?.sourceHash) {
      return { ok: false, diagnostics: sanitizeDiagnostics(full.diagnostics) };
    }
    return {
      ok: true,
      child: unpacked.child,
      typeName: full.data.typeName ?? '',
      rowDataSize: full.data.rowDataSize ?? 0,
      rows: full.data.rows ?? [],
      diagnostics: []
    };
  };

  /**
   * T5-4 批量导入的共享提交路径（grok T5：「提交走与字段写入相同的 Patch 链，
   * 禁止 fs.writeFile 写 Mod」）。
   *
   * ① write-param mutations（C#）—— 批量 upsert 行数据/行名，产出改过的裸 param；
   * ② write-bnd4 replace（C#）—— 按 entryIndex 塞回容器副本，C# 侧重读验证；
   * ③ 真正落盘由 applyNativeMutation 的 commit port（Patch Engine）完成，含备份
   *    与回滚元数据。
   *
   * unpackedChild 由调用方（readContainerParamFull）解包并读出，这里直接复用，
   * 不重复解包；expectedDocumentHash 用它的 storedContentHash（并发保护，与
   * 字段/行名写入一致）。write-param 的 upsert 强制 dataBase64 且长度=行宽——
   * 导入路径的行字节一律由读回的最新字节承载，不凭空构造。
   */
  const commitContainerParamBulk = async (
    event: IpcMainInvokeEvent,
    input: {
      containerUri: string;
      expectedContainerHash: string;
      file: IndexedFile;
      entryIndex: number;
      expectedChildHash: string;
      unpackedChild: UnpackedParamChild;
      mutations: Array<Record<string, unknown>>;
      title: string;
      confirmActionLabel: string;
    }
  ): Promise<RendererSaveResult> => {
    const session = activeSession;
    if (!session) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'PARAM_IMPORT_NO_SESSION',
          message: '需要已打开的工作区才能写入容器内 PARAM。',
          sourceUri: input.containerUri
        }]
      };
    }
    const storage = durableStoragePaths(session.meta.workspaceId);
    const stage = await verifiedStageRoots(session, storage, 'PARAM_STAGING_PREPARE_FAILED');
    if (stage.diagnostics.length > 0) {
      return { ok: false, changedFiles: [], diagnostics: stage.diagnostics };
    }
    const operationLog = await ensureActiveOperationLog(session);
    const oodle = session.layers.baseRoot
      ? { oodleRuntimeRoot: session.layers.baseRoot }
      : {};

    const paramStage = await stageBridgeOutput({
      stagingRoot: storage.stagingRoot,
      prefix: 'param-import',
      fileName: `${basename(input.unpackedChild.name)}.imported`,
      allowedRoots: () => [...stage.allowedRoots],
      write: async (context) => {
        const written = await runBridge<Record<string, unknown>>({
          command: 'write-param',
          filePath: input.unpackedChild.absolutePath,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          timeoutMs: 120_000,
          commandOptions: {
            outputPath: context.outputPath,
            expectedDocumentHash: input.unpackedChild.storedContentHash,
            mutations: input.mutations
          }
        });
        return {
          ok: written.parseStatus !== 'failed'
            && written.diagnostics.some(
              (diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED'
            ),
          diagnostics: written.diagnostics
        };
      }
    });
    if (!paramStage.ok || !paramStage.bytes) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [
          ...sanitizeDiagnostics(paramStage.result?.diagnostics ?? []),
          ...paramStage.diagnostics.map((diagnostic) => ({
            severity: 'error' as const,
            code: diagnostic.code,
            message: diagnostic.message,
            sourceUri: input.containerUri
          })),
          {
            severity: 'error' as const,
            code: 'PARAM_IMPORT_STAGE_FAILED',
            message: '批量改动未能产出裸 param 暂存文件，容器未被修改。',
            sourceUri: input.containerUri
          }
        ]
      };
    }
    const childBase64 = paramStage.bytes.toString('base64');

    const outcome = await applyNativeMutation({
      file: input.file,
      sourceUri: input.containerUri,
      expectedHash: input.expectedContainerHash,
      stagingRoot: storage.stagingRoot,
      allowedRoots: () => [...stage.allowedRoots],
      stagingPrefix: 'parambnd',
      stagingFileName: `${basename(input.file.relativePath)}.repacked`,
      stageWrite: async (context) => {
        const written = await runBridge<Record<string, unknown>>({
          command: 'write-bnd4',
          filePath: input.file.absolutePath,
          resourceUri: input.containerUri,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          timeoutMs: 180_000,
          commandOptions: {
            outputPath: context.outputPath,
            mutation: 'replace',
            expectedContainerHash: input.expectedContainerHash,
            entryIndex: input.entryIndex,
            expectedChildHash: input.expectedChildHash,
            contentBase64: childBase64
          },
          ...oodle
        });
        return {
          ok: written.parseStatus !== 'failed'
            && written.diagnostics.some(
              (diagnostic) => diagnostic.code === 'BND4_STAGING_WRITE_VERIFIED'
            ),
          diagnostics: written.diagnostics
        };
      },
      title: input.title,
      confirmActionLabel: input.confirmActionLabel
    }, {
      confirm: electronConfirmationPort(event),
      commit: sessionCommitPort(session, operationLog, storage)
    });

    if (outcome.status === 'committed' && outcome.result.ok) {
      paramPageCache.delete(input.containerUri);
      paramAllCache.delete(input.containerUri);
      containerChildrenCache.clear();
      unpackedParamCache.clear();
    }
    return toSaveResultFromOutcome(outcome, indexedFiles);
  };

  /**
   * 校验导出目标路径不在受 Patch Engine 管理的目录内。
   *
   * 导出 CSV 是用户主动保存到自选路径的新文件，不是 Mod 资源改动，因此不走
   * Patch Engine（硬约束针对的是「改 Mod 资源」）。但游戏目录只读、Mod 工作区
   * 不落旁路文件，两者都挡 —— 选中这两处时拒绝并给可复现的下一步。
   */
  const rejectExportIntoManagedRoots = (
    target: string,
    containerUri: string
  ): RendererSaveResult | null => {
    const abs = resolve(target);
    const roots = [
      activeSession?.layers.baseRoot,
      activeSession?.layers.overlayRoot
    ];
    for (const root of roots) {
      if (root && (abs === root || abs.startsWith(root + sep))) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_EXPORT_INTO_MANAGED_ROOT',
            message: '不要导出到游戏目录或 Mod 工作区：那里由 Patch Engine 管理。请选择工作区外的目录。',
            sourceUri: containerUri
          }]
        };
      }
    }
    return null;
  };

  /**
   * T5-4：导出行（CSV，主进程保存对话框）。
   *
   * 表头 = `id,name,<字段内部 id>…`。用内部 id 而不是显示名做表头，是为了让
   * param.importRowsCsv 能按表头精确回写 —— 显示名（中文 DisplayName）可能重名，
   * 拿它定位字段会写错列。字段值经 decodeRowFields 解码，解码失败或缺失的单元格
   * 导成空串（导入时空串 = 不改，见 importRowsCsv）。
   */
  handle(
    'param.exportRowsCsv',
    async (
      _event,
      containerUri: string,
      expectedContainerHash: string,
      entryIndex: number
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_EXPORT_NO_SESSION',
            message: '需要已打开的工作区才能导出 PARAM。',
            sourceUri: containerUri
          }]
        };
      }
      const full = await readContainerParamFull({ file, containerUri, expectedContainerHash, entryIndex });
      if (!full.ok) {
        return { ok: false, changedFiles: [], diagnostics: full.diagnostics };
      }
      const resolved = full.typeName
        ? await resolveTrustedParamDefinition(full.typeName, full.rowDataSize)
        : { document: null };
      const def = resolved.document;
      if (!def) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_EXPORT_NO_DEF',
            message: `无法解析 ${full.typeName ?? '该表'} 的字段定义，不能导出字段值。`,
            sourceUri: containerUri
          }]
        };
      }
      const headers = ['id', 'name', ...def.fields.map((field) => field.id)];
      const rows = full.rows.map((row) => {
        const data = typeof row.dataBase64 === 'string' && row.dataBase64.length > 0
          ? Buffer.from(row.dataBase64, 'base64')
          : null;
        const values = data ? decodeRowFields(data, def) : [];
        const byId = new Map(values.map((value) => [value.fieldId, value]));
        return [
          String(row.id),
          row.name ?? '',
          ...def.fields.map((field) => {
            const value = byId.get(field.id);
            if (!value || value.diagnostic) return '';
            return value.value === null ? '' : String(value.value);
          })
        ];
      });
      const csv = toCsvText(headers, rows);
      const opened = await dialog.showSaveDialog({
        title: '导出 PARAM 行（CSV）',
        defaultPath: `${full.child.name.replace(/\.param$/i, '')}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (opened.canceled || !opened.filePath) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'info',
            code: 'CSV_EXPORT_CANCELLED',
            message: '已取消导出。',
            sourceUri: containerUri
          }]
        };
      }
      const blocked = rejectExportIntoManagedRoots(opened.filePath, containerUri);
      if (blocked) return blocked;
      try {
        await writeFile(opened.filePath, csv, 'utf8');
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_EXPORT_WRITE_FAILED',
            message: error instanceof Error ? error.message : '写入导出文件失败。',
            sourceUri: containerUri
          }]
        };
      }
      return {
        ok: true,
        changedFiles: [],
        diagnostics: [{
          severity: 'info',
          code: 'CSV_EXPORT_SAVED',
          message: `已导出 ${rows.length} 行到 ${opened.filePath}。`,
          sourceUri: containerUri
        }]
      };
    }
  );

  /**
   * T5-4：导出备注（行名，CSV：id,name）—— 对照 Yapped Export/Import Names。
   */
  handle(
    'param.exportNamesCsv',
    async (
      _event,
      containerUri: string,
      expectedContainerHash: string,
      entryIndex: number
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_EXPORT_NO_SESSION',
            message: '需要已打开的工作区才能导出 PARAM 行名。',
            sourceUri: containerUri
          }]
        };
      }
      const full = await readContainerParamFull({ file, containerUri, expectedContainerHash, entryIndex });
      if (!full.ok) {
        return { ok: false, changedFiles: [], diagnostics: full.diagnostics };
      }
      const csv = toCsvText(
        ['id', 'name'],
        full.rows.map((row) => [String(row.id), row.name ?? ''])
      );
      const opened = await dialog.showSaveDialog({
        title: '导出 PARAM 行名（CSV）',
        defaultPath: `${full.child.name.replace(/\.param$/i, '')}.names.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (opened.canceled || !opened.filePath) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'info',
            code: 'CSV_EXPORT_CANCELLED',
            message: '已取消导出行名。',
            sourceUri: containerUri
          }]
        };
      }
      const blocked = rejectExportIntoManagedRoots(opened.filePath, containerUri);
      if (blocked) return blocked;
      try {
        await writeFile(opened.filePath, csv, 'utf8');
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_EXPORT_WRITE_FAILED',
            message: error instanceof Error ? error.message : '写入导出文件失败。',
            sourceUri: containerUri
          }]
        };
      }
      return {
        ok: true,
        changedFiles: [],
        diagnostics: [{
          severity: 'info',
          code: 'CSV_EXPORT_SAVED',
          message: `已导出 ${full.rows.length} 行行名到 ${opened.filePath}。`,
          sourceUri: containerUri
        }]
      };
    }
  );

  /**
   * T5-4：导入备注（行名 CSV：id,name）—— 对照 Yapped Import Names。
   *
   * 主进程打开对话框选文件；逐 id 把「当前行字节原样回传 + 新 name」拼成
   * write-param upsert，整批经 commitContainerParamBulk 走 Patch Engine。
   * 行 id 不存在的记录被跳过并汇总诊断 —— 导入是部分成功，不吞异常。
   */
  handle(
    'param.importNamesCsv',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      entryIndex: number,
      expectedChildHash: string
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_IMPORT_NO_SESSION',
            message: '需要已打开的工作区才能导入 PARAM 行名。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      const opened = await dialog.showOpenDialog({
        title: '导入行名（CSV：id,name）',
        properties: ['openFile'],
        filters: [{ name: 'CSV / 文本', extensions: ['csv', 'txt'] }]
      });
      if (opened.canceled || opened.filePaths.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'info',
            code: 'CSV_IMPORT_CANCELLED',
            message: '已取消导入行名。',
            sourceUri: containerUri
          }]
        };
      }
      const selectedNamesPath = opened.filePaths[0];
      if (!selectedNamesPath) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NO_FILE',
            message: '没有选中导入文件。',
            sourceUri: containerUri
          }]
        };
      }
      let csvText: string;
      try {
        csvText = await readFile(selectedNamesPath, 'utf8');
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_READ_FAILED',
            message: error instanceof Error ? error.message : '无法读取所选文件。',
            sourceUri: containerUri
          }]
        };
      }
      const parsed = parseCsvText(csvText);
      const header0 = (parsed.headers[0] ?? '').trim().toLowerCase();
      const header1 = (parsed.headers[1] ?? '').trim().toLowerCase();
      if (parsed.headers.length < 2 || header0 !== 'id' || header1 !== 'name') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_BAD_HEADER',
            message: '行名 CSV 的表头必须是 id,name（多余列会被忽略）。',
            sourceUri: containerUri
          }]
        };
      }
      const full = await readContainerParamFull({ file, containerUri, expectedContainerHash, entryIndex });
      if (!full.ok) {
        return { ok: false, changedFiles: [], diagnostics: full.diagnostics };
      }
      const rowById = new Map(full.rows.map((row) => [row.id, row]));
      const mutations: Array<Record<string, unknown>> = [];
      const skipped: string[] = [];
      for (const record of parsed.rows) {
        const idNum = Number(record[0]);
        if (!Number.isInteger(idNum)) {
          skipped.push(`「${record[0] ?? ''}」不是整数 id`);
          continue;
        }
        const existing = rowById.get(idNum);
        if (!existing) {
          skipped.push(`id ${idNum} 在表内不存在`);
          continue;
        }
        if (typeof existing.dataBase64 !== 'string' || existing.dataBase64.length === 0) {
          skipped.push(`id ${idNum} 没有可回传的行字节`);
          continue;
        }
        mutations.push({ kind: 'upsert', id: idNum, dataBase64: existing.dataBase64, name: record[1] ?? '' });
      }
      if (mutations.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NOTHING_TO_APPLY',
            message: skipped.length > 0
              ? `没有可导入的行名：${skipped.slice(0, 5).join('；')}${skipped.length > 5 ? ` 等 ${skipped.length} 条` : ''}`
              : 'CSV 没有数据行。',
            sourceUri: containerUri
          }]
        };
      }
      return commitContainerParamBulk(event, {
        containerUri,
        expectedContainerHash,
        file,
        entryIndex,
        expectedChildHash,
        unpackedChild: full.child,
        mutations,
        title: `import ${mutations.length} row names into ${full.child.name}`,
        confirmActionLabel: '提交批量行名导入'
      });
    }
  );

  /**
   * T5-4：导入行（CSV：id,name,<字段内部 id>…）。
   *
   * 表头第二列起的字段列必须是该表字段的内部 id（与 exportRowsCsv 对齐）。空
   * 单元格 = 不改该字段；bool 单元格按 /^(1|true|yes|on)$/ 判定；字段编码失败
   * 的记录跳过并汇总诊断。整批 upsert 经 commitContainerParamBulk 走 Patch Engine。
   */
  handle(
    'param.importRowsCsv',
    async (
      event,
      containerUri: string,
      expectedContainerHash: string,
      entryIndex: number,
      expectedChildHash: string
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_IMPORT_NO_SESSION',
            message: '需要已打开的工作区才能导入 PARAM 行。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      const opened = await dialog.showOpenDialog({
        title: '导入行（CSV：id,name,字段…）',
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (opened.canceled || opened.filePaths.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'info',
            code: 'CSV_IMPORT_CANCELLED',
            message: '已取消导入行。',
            sourceUri: containerUri
          }]
        };
      }
      const selectedRowsPath = opened.filePaths[0];
      if (!selectedRowsPath) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NO_FILE',
            message: '没有选中导入文件。',
            sourceUri: containerUri
          }]
        };
      }
      let csvText: string;
      try {
        csvText = await readFile(selectedRowsPath, 'utf8');
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_READ_FAILED',
            message: error instanceof Error ? error.message : '无法读取所选文件。',
            sourceUri: containerUri
          }]
        };
      }
      const parsed = parseCsvText(csvText);
      const header0 = (parsed.headers[0] ?? '').trim().toLowerCase();
      if (parsed.headers.length < 1 || header0 !== 'id') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_BAD_HEADER',
            message: '行数据 CSV 的表头必须是 id（其后可跟 name 与字段列）。',
            sourceUri: containerUri
          }]
        };
      }
      const header1 = (parsed.headers[1] ?? '').trim().toLowerCase();
      const fieldIds = parsed.headers.slice(header1 === 'name' ? 2 : 1)
        .map((header) => header.trim());
      if (fieldIds.length === 0 && header1 !== 'name') {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NO_COLUMNS',
            message: '行数据 CSV 除了 id 外没有可导入的列（至少要有 name 或一个字段列）。',
            sourceUri: containerUri
          }]
        };
      }
      const full = await readContainerParamFull({ file, containerUri, expectedContainerHash, entryIndex });
      if (!full.ok) {
        return { ok: false, changedFiles: [], diagnostics: full.diagnostics };
      }
      const resolved = full.typeName
        ? await resolveTrustedParamDefinition(full.typeName, full.rowDataSize)
        : { document: null };
      const def = resolved.document;
      if (!def) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_IMPORT_NO_DEF',
            message: `无法解析 ${full.typeName ?? '该表'} 的字段定义，不能导入行数据。`,
            sourceUri: containerUri
          }]
        };
      }
      const fieldById = new Map(def.fields.map((field) => [field.id, field]));
      const unknownColumns = fieldIds.filter((id) => !fieldById.has(id));
      if (unknownColumns.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_UNKNOWN_FIELD',
            message: `CSV 含未知字段列：${unknownColumns.join('、')}。表头必须是该表的字段内部 id。`,
            sourceUri: containerUri
          }]
        };
      }
      const rowById = new Map(full.rows.map((row) => [row.id, row]));
      const mutations: Array<Record<string, unknown>> = [];
      const skipped: string[] = [];
      for (const record of parsed.rows) {
        const idNum = Number(record[0]);
        if (!Number.isInteger(idNum)) {
          skipped.push(`「${record[0] ?? ''}」不是整数 id`);
          continue;
        }
        const existing = rowById.get(idNum);
        if (!existing) {
          skipped.push(`id ${idNum} 在表内不存在`);
          continue;
        }
        if (typeof existing.dataBase64 !== 'string' || existing.dataBase64.length === 0) {
          skipped.push(`id ${idNum} 没有可回传的行字节`);
          continue;
        }
        let next: Buffer = Buffer.from(existing.dataBase64, 'base64');
        const fieldErrors: string[] = [];
        for (let column = 0; column < fieldIds.length; column += 1) {
          const raw = record[column + (header1 === 'name' ? 2 : 1)] ?? '';
          if (raw === '') continue; // 空单元格 = 不改该字段
          const field = fieldById.get(fieldIds[column]!);
          const effectiveValue = field?.type === 'bool'
            ? /^(1|true|yes|on)$/i.test(raw)
            : raw;
          const encoded = encodeFieldMutation(next, def, fieldIds[column]!, effectiveValue);
          if (!encoded.ok) {
            fieldErrors.push(`${fieldIds[column]}: ${encoded.message}`);
            continue;
          }
          next = encoded.next;
        }
        if (fieldErrors.length > 0) {
          skipped.push(`id ${idNum} 部分字段未应用（${fieldErrors.join('；')}）`);
        }
        const name = (record[1] ?? '').trim();
        mutations.push({
          kind: 'upsert',
          id: idNum,
          dataBase64: next.toString('base64'),
          ...(name && header1 === 'name' ? { name } : {})
        });
      }
      if (mutations.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CSV_IMPORT_NOTHING_TO_APPLY',
            message: skipped.length > 0
              ? `没有可导入的行：${skipped.slice(0, 5).join('；')}${skipped.length > 5 ? ` 等 ${skipped.length} 条` : ''}`
              : 'CSV 没有数据行。',
            sourceUri: containerUri
          }]
        };
      }
      return commitContainerParamBulk(event, {
        containerUri,
        expectedContainerHash,
        file,
        entryIndex,
        expectedChildHash,
        unpackedChild: full.child,
        mutations,
        title: `import ${mutations.length} rows into ${full.child.name}`,
        confirmActionLabel: '提交批量行数据导入'
      });
    }
  );

  /**
   * 列出 parambnd 容器内的 param 条目（Smithbox 的 Param List 那一栏）。
   *
   * 为什么不复用 listContainerChildrenPage：那条通道服务于通用容器工作台，
   * 返回全部条目类型且 childUri 不可读。这里只给 param 条目，并且每一项都能
   * 直接交给 resource.readContainerParamPage 拿到行 —— 也就是「列得出来就读得到」。
   * 报告过的形态是反面：UI 能列出 138 个名字，却拿不到其中任何一个的字节。
   */
  handle('resource.listContainerParams', async (_event, containerUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === containerUri);
    if (!file) {
      return {
        ok: false,
        containerUri,
        params: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法列出容器内 param。',
          sourceUri: containerUri
        }]
      };
    }
    if (!activeSession) {
      return {
        ok: false,
        containerUri,
        params: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'PARAM_LIST_NO_SESSION',
          message: '没有活动工作区会话。',
          sourceUri: containerUri
        }]
      };
    }
    // ROOT-07：只读枚举只传已存在并 verified 的 roots，不附加 staging。
    const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
    if (roots.diagnostics.length > 0) {
      return {
        ok: false,
        containerUri,
        params: [],
        diagnostics: roots.diagnostics
      };
    }
    const dcx = await runBridge<NativeDcxEnvelopeLike>({
      command: 'read-dcx-document',
      filePath: file.absolutePath,
      resourceUri: containerUri,
      allowedRoots: roots.allowedRoots,
      timeoutMs: 120_000,
      // KRAK（game-side）容器缺 Oodle 连条目表都读不出 —— 实测。
      ...(activeSession.layers.baseRoot
        ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
        : {})
    });
    if (dcx.parseStatus === 'failed') {
      return {
        ok: false,
        containerUri,
        params: [],
        diagnostics: sanitizeDiagnostics(dcx.diagnostics)
      };
    }
    const entries = dcx.data?.nested?.entries ?? [];
    const seen = new Set<string>();
    const params = entries
      .map((entry, position) => {
        const index = entry.index ?? position;
        return {
          entryIndex: index,
          name: sanitizeEntryName(entry.name ?? `entry_${position}`, index, seen),
          size: entry.uncompressedSize ?? 0
        };
      })
      // 只保留 .param —— 容器里也可能有别的东西，混进来会让左栏出现点不开的项。
      .filter((entry) => entry.name.toLowerCase().endsWith('.param'));
    return {
      ok: true,
      containerUri,
      containerFormat: dcx.data?.compressionFormat ?? null,
      params,
      diagnostics: params.length === 0
        ? [{
            severity: 'info' as const,
            code: 'PARAM_LIST_EMPTY',
            message: `容器内 ${entries.length} 个条目中没有 .param 文件。`,
            sourceUri: containerUri
          }]
        : []
    };
  });

  /**
   * 读取 parambnd 容器内某个 param 的一页行。
   *
   * 这条通道补的是「容器 → 内部 param 文件」那一跳（详见
   * unpackContainerParamChild 的注释）：先解包成裸 param 落会话暂存区，
   * 再复用 resource.readParamPage 的分页读取逻辑。
   *
   * 直接把容器 URI 交给 read-param-document 会硬失败（实测
   * `PARAM_DOCUMENT_READ_FAILED: PARAM 类型名偏移无效`），因为它不解 DCX/BND4。
   */
  handle(
    'resource.readContainerParamPage',
    async (
      _event,
      containerUri: string,
      entryIndex: number,
      requestedPage: number,
      requestedPageSize: number,
      query?: string,
      loadAll?: boolean
    ) => {
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      const failure = (code: string, message: string, extra: Diagnostic[] = []) => ({
        ok: false,
        containerUri,
        entryIndex,
        sourceHash: null,
        typeName: null,
        rowDataSize: 0,
        rowCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        rows: [],
        rowsTruncated: false,
        // P1 裁定：容器 PARAM 工作台 FIELDS 栏依赖字段定义。失败路径与成功路径
        // 保持同一字段面，只是定义一概为空——渲染器据此显示「没有可用的字段定义」
        // 的语义（而非「字段列渲染异常」）。
        fieldDefs: null,
        fieldEnums: null,
        fieldDefsDiagnostic: null,
        fieldDefsOrigin: null,
        fieldDefsTrusted: false,
        diagnostics: [
          { severity: 'error' as const, code, message, sourceUri: containerUri },
          ...extra
        ]
      });
      if (!file) return failure('RESOURCE_NOT_INDEXED', '资源未索引，无法读取容器内 param。');

      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: file.sha256 ?? createHash('sha256').update(file.absolutePath).digest('hex'),
        entry: { index: entryIndex }
      });
      if (!unpacked.ok) {
        return failure(
          'PARAM_CONTAINER_UNPACK_FAILED',
          '容器内 param 解包失败，无法读取行。',
          unpacked.diagnostics
        );
      }

      const paramPath = unpacked.child.absolutePath;
      // ROOT-07：解包产物在 staging——先 mkdir/realpath/boundary 验证再注册，
      // 绝不把不存在的目录交给 Bridge。
      const stageRoots = activeSession
        ? await verifiedStageRoots(
            activeSession,
            durableStoragePaths(activeSession.meta.workspaceId),
            'PARAM_STAGING_PREPARE_FAILED'
          )
        : null;
      if (stageRoots && stageRoots.diagnostics.length > 0) {
        return failure(
          'PARAM_STAGING_PREPARE_FAILED',
          '无法准备安全暂存目录。',
          stageRoots.diagnostics
        );
      }
      const allowedRoots = stageRoots ? [...stageRoots.allowedRoots] : [dirname(paramPath)];

      // ── 全表读：只为 id/name 索引与跨页搜索（行字节恒缺，见 readParamPage 注释）。
      //    loadAll（用户裁定 2026-08-14）：includeAllPayloads 一次拿回全表 +
      //    全部行字节（帧上限提到 32 MiB 绝对上限），renderer 打开表即全量。──
      const full = await runBridge<{
        sourceHash?: string;
        typeName?: string;
        rowCount?: number;
        rowDataSize?: number;
        rows?: Array<{ id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
        authority?: string;
      }>({
        command: 'read-param-document',
        filePath: paramPath,
        allowedRoots,
        timeoutMs: 120_000,
        commandOptions: loadAll ? { includeAllPayloads: true } : {},
        ...(loadAll ? { maxFrameBytes: 32 * 1024 * 1024 } : {})
      });
      if (full.parseStatus === 'failed' || !full.data?.sourceHash) {
        return failure(
          'PARAM_DOCUMENT_READ_FAILED',
          `解包后的 ${unpacked.child.name} 无法解析为 PARAM。`,
          sanitizeDiagnostics(full.diagnostics)
        );
      }

      // P1 裁定：容器工作台走 readContainerParamPage，渲染器的 FIELDS 栏只从
      // fieldDefs 拿定义，而这条通道此前根本没返回。这里复用与
      // resource.readParamDocument 完全相同的 resolveTrustedParamDefinition 与
      // 逐字段映射（包校验 + 行宽核对 + 用户信任策略三层都不绕过）。
      const containerTypeName = full.data.typeName ?? '';
      const resolvedContainerDef = containerTypeName
        ? await resolveTrustedParamDefinition(containerTypeName, full.data.rowDataSize ?? 0)
        : { document: null, trusted: false, diagnostic: null };
      const containerParamDef = resolvedContainerDef.document;
      // 行宽已在 resolveTrustedParamDefinition 内核对：拿到 document 即行宽一致。
      const containerRowWidthMatches = containerParamDef !== null;

      const allRows = (full.data.rows ?? []).slice(0, MAX_PAGED_PARAM_ROWS);
      const q = (query ?? '').trim().toLowerCase();
      const filtered = q.length === 0
        ? allRows
        : allRows.filter((row) =>
            String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
          );

      // ── 全量路径（用户裁定）：一次返回全部行（含字节）；渲染器本地过滤与
      //    虚拟化，不再分批续取；字段定义照常随页下发（P1 裁定，与分页路径一致）。
      if (loadAll) {
        // T5-3 行名回落：Bridge 没解码出名字的行，查本机 Yapped Names（条目名键）。
        // 键是容器条目名（SpEffectParam，不带 .param），与 Defs 的 ParamType 键不同。
        const yappedRowNames = (await loadYappedOverlay()).rowNames;
        const yappedEntryName = unpacked.child.name.replace(/\.param$/i, '');
        const yappedNameFor = (rowId: number): string | undefined =>
          yappedRowNames?.get(yappedEntryName)?.get(rowId);
        return {
          ok: true,
          containerUri,
          entryIndex: unpacked.child.entryIndex,
          paramName: unpacked.child.name,
          containerHash: file.sha256 ?? '',
          childHash: unpacked.child.storedContentHash,
          sourceHash: full.data.sourceHash,
          typeName: full.data.typeName ?? 'UNKNOWN_PARAM',
          rowDataSize: full.data.rowDataSize ?? 0,
          fieldDefs: containerRowWidthMatches && containerParamDef
            ? containerParamDef.fields.map((field) => ({
                id: field.id,
                name: field.name,
                type: field.type,
                offset: field.offset,
                size: field.size,
                ...(field.bitfield ? { bitfield: field.bitfield } : {}),
                ...(field.enumRef ? { enumRef: field.enumRef } : {}),
                ...(field.refs ? { refs: field.refs } : {}),
                ...(field.min !== undefined ? { min: field.min } : {}),
                ...(field.max !== undefined ? { max: field.max } : {}),
                ...(field.description ? { description: field.description } : {})
              }))
            : null,
          fieldEnums: containerRowWidthMatches && containerParamDef?.enums
            ? containerParamDef.enums.map((enumDef) => ({
                id: enumDef.id,
                name: enumDef.name,
                values: enumDef.values.map((value) => ({ value: value.value, label: value.label }))
              }))
            : null,
          fieldDefsDiagnostic: resolvedContainerDef.diagnostic,
          fieldDefsOrigin: containerParamDef?.origin ?? null,
          fieldDefsTrusted: resolvedContainerDef.trusted,
          rowCount: filtered.length,
          page: 0,
          pageSize: filtered.length,
          pageCount: 1,
          rows: filtered.map((row) => {
            const dataBase64 = typeof row.dataBase64 === 'string' ? row.dataBase64 : undefined;
            const yappedName = row.name ? undefined : yappedNameFor(row.id);
            return {
              id: row.id,
              ...(dataBase64 !== undefined
                ? {
                    dataBase64,
                    dataHexPreview: Buffer.from(dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              ...(row.name
                ? { name: row.name }
                : (yappedName ? { name: yappedName, nameOrigin: 'yapped' as const } : {}))
            };
          }),
          rowsTruncated: (full.data.rowCount ?? allRows.length) > allRows.length,
          ...(full.data.authority ? { authority: full.data.authority } : {}),
          diagnostics: [...unpacked.diagnostics]
        };
      }

      const window = normalizePageWindow(
        filtered.length,
        requestedPage,
        requestedPageSize || PARAM_PAGE_SIZE
      );

      // ── 当页字节：与 readParamPage 同一策略，有搜索时不取（会对错行）──
      const pageBytes = new Map<number, string>();
      const pageByteDiagnostics: Diagnostic[] = [];
      if (q.length === 0 && window.size > 0) {
        const bridgePage = Math.floor(window.offset / window.size);
        if (bridgePage * window.size === window.offset) {
          try {
            const paged = await runBridge<{
              rows?: Array<{ id: number; dataBase64?: string | null }>;
              payloadsIncluded?: boolean;
            }>({
              command: 'read-param-document',
              filePath: paramPath,
              allowedRoots,
              timeoutMs: 60_000,
              commandOptions: { rowPage: bridgePage, rowPageSize: window.size }
            });
            for (const row of paged.data?.rows ?? []) {
              if (typeof row.dataBase64 === 'string') pageBytes.set(row.id, row.dataBase64);
            }
            if (paged.data?.payloadsIncluded === false) {
              pageByteDiagnostics.push({
                severity: 'info',
                code: 'PARAM_PAGE_PAYLOAD_OMITTED',
                message: '本页行字节未随分页下发（页字节数超出 Bridge 载荷门限）；'
                  + '字段编辑对本页不可用，行列表不受影响。',
                sourceUri: containerUri
              });
            }
          } catch (error) {
            pageByteDiagnostics.push({
              severity: 'warning',
              code: 'PARAM_PAGE_PAYLOAD_READ_FAILED',
              message: `本页行字节读取失败：${error instanceof Error ? error.message : String(error)}`,
              sourceUri: containerUri
            });
          }
        }
      }

      return {
        ok: true,
        containerUri,
        entryIndex: unpacked.child.entryIndex,
        paramName: unpacked.child.name,
        /**
         * 写回所需的两个哈希，原样回传给 applyContainerParamFieldMutation。
         *
         * containerHash 防「容器在读与写之间被改过」，childHash 防「同一条目被
         * 并发改过」。渲染器不自己算：它拿不到容器字节，算出来的只能是猜的。
         */
        containerHash: file.sha256 ?? '',
        childHash: unpacked.child.storedContentHash,
        sourceHash: full.data.sourceHash,
        typeName: full.data.typeName ?? 'UNKNOWN_PARAM',
        rowDataSize: full.data.rowDataSize ?? 0,
        // P1 裁定：字段定义与枚举随容器 PARAM 一起下发，映射与
        // resource.readParamDocument 完全一致（含 bitfield/enumRef/refs/min/max 的
        // 条件展开与 enum label 字段名）。渲染器据此渲染 FIELDS 栏，而不是空列。
        fieldDefs: containerRowWidthMatches && containerParamDef
          ? containerParamDef.fields.map((field) => ({
              id: field.id,
              name: field.name,
              type: field.type,
              offset: field.offset,
              size: field.size,
              ...(field.bitfield ? { bitfield: field.bitfield } : {}),
              ...(field.enumRef ? { enumRef: field.enumRef } : {}),
              ...(field.refs ? { refs: field.refs } : {}),
              ...(field.min !== undefined ? { min: field.min } : {}),
              ...(field.max !== undefined ? { max: field.max } : {}),
              ...(field.description ? { description: field.description } : {})
            }))
          : null,
        fieldEnums: containerRowWidthMatches && containerParamDef?.enums
          ? containerParamDef.enums.map((enumDef) => ({
              id: enumDef.id,
              name: enumDef.name,
              values: enumDef.values.map((value) => ({ value: value.value, label: value.label }))
            }))
          : null,
        fieldDefsDiagnostic: resolvedContainerDef.diagnostic,
        fieldDefsOrigin: containerParamDef?.origin ?? null,
        fieldDefsTrusted: resolvedContainerDef.trusted,
        rowCount: filtered.length,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        rows: filtered
          .slice(window.offset, window.offset + window.size)
          .map((row) => {
            const dataBase64 = typeof row.dataBase64 === 'string'
              ? row.dataBase64
              : pageBytes.get(row.id);
            return {
              id: row.id,
              ...(typeof dataBase64 === 'string'
                ? {
                    dataBase64,
                    dataHexPreview: Buffer.from(dataBase64, 'base64')
                      .subarray(0, 16)
                      .toString('hex')
                  }
                : {}),
              ...(row.name ? { name: row.name } : {})
            };
          }),
        rowsTruncated: (full.data.rowCount ?? allRows.length) > allRows.length,
        ...(full.data.authority ? { authority: full.data.authority } : {}),
        diagnostics: [...unpacked.diagnostics, ...pageByteDiagnostics]
      };
    }
  );

  /**
   * 一次读出容器内某个 param 的**完整行索引**（只 id + name，不含行字节）。
   *
   * ── 为什么加这条通道 ──
   *
   * 行表原先靠「滚到底就取下一页」累积，实测这个形态撑不住两件事：
   *
   *   ① **跨表引用跳转**。目标行可能在第 42 页。往累积列表里塞第 42 页会得到一段
   *      与前面不连续的行（第 k+1..41 页缺失），列表顺序变成假的；而靠行筛选跳转
   *      也不行 —— 后端的 id 筛选是**子串**匹配（实测精确匹配项最远排在筛选结果第
   *      36 位，页大小只有 20），且有筛选时刻意不下发行字节，跳过去字段栏是空的。
   *   ② **总量语义**。虚拟滚动要一条完整长列表才成立，累积页数只是「已取到多少」。
   *
   * 而这条通道几乎不增加成本：后端本来就在**每次**分页请求里读一遍全表
   * （`commandOptions: {}`，行字节必然缺失）再切片。把那份全表直接给渲染器，
   * 换来的是「一个 param 只读一次索引」，比每滚一页读一次全表更省。
   *
   * 行字节仍按页取（载荷门限按页算，见 readContainerParamPage 的实测因果）：
   * 选中某行时只取包含它的那一页。
   */
  handle(
    'resource.readContainerParamRowIndex',
    async (_event, containerUri: string, entryIndex: number) => {
      const failure = (code: string, message: string, extra: Diagnostic[] = []) => ({
        ok: false as const,
        containerUri,
        entryIndex,
        paramName: null,
        typeName: null,
        rowDataSize: 0,
        rowCount: 0,
        rows: [],
        rowsTruncated: false,
        containerHash: '',
        childHash: '',
        diagnostics: [
          { severity: 'error' as const, code, message, sourceUri: containerUri },
          ...extra
        ]
      });
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file) return failure('RESOURCE_NOT_INDEXED', '资源未索引，无法读取 PARAM 行索引。');
      if (!Number.isSafeInteger(entryIndex) || entryIndex < 0) {
        return failure('PARAM_ENTRY_INDEX_INVALID', '容器条目下标非法。');
      }

      const unpacked = await unpackContainerParamChild({
        containerPath: file.absolutePath,
        containerUri,
        containerHash: file.sha256 ?? createHash('sha256').update(file.absolutePath).digest('hex'),
        entry: { index: entryIndex }
      });
      if (!unpacked.ok) {
        return failure(
          'PARAM_CONTAINER_UNPACK_FAILED',
          '容器内 param 解包失败，无法读取行索引。',
          unpacked.diagnostics
        );
      }

      // ROOT-07：解包产物在 staging——先 mkdir/realpath/boundary 验证再注册。
      const stageRoots = activeSession
        ? await verifiedStageRoots(
            activeSession,
            durableStoragePaths(activeSession.meta.workspaceId),
            'PARAM_STAGING_PREPARE_FAILED'
          )
        : null;
      if (stageRoots && stageRoots.diagnostics.length > 0) {
        return failure(
          'PARAM_STAGING_PREPARE_FAILED',
          '无法准备安全暂存目录。',
          stageRoots.diagnostics
        );
      }
      const full = await runBridge<{
        sourceHash?: string;
        typeName?: string;
        rowCount?: number;
        rowDataSize?: number;
        rows?: Array<{ id: number; name?: string }>;
        authority?: string;
      }>({
        command: 'read-param-document',
        filePath: unpacked.child.absolutePath,
        allowedRoots: stageRoots ? [...stageRoots.allowedRoots] : [dirname(unpacked.child.absolutePath)],
        timeoutMs: 60_000,
        commandOptions: {}
      });
      if (full.parseStatus === 'failed' || !full.data?.sourceHash) {
        return failure(
          'PARAM_DOCUMENT_READ_FAILED',
          `解包后的 ${unpacked.child.name} 无法解析为 PARAM。`,
          sanitizeDiagnostics(full.diagnostics)
        );
      }

      const allRows = full.data.rows ?? [];
      // 截断上限与分页读取一致：两条通道的下标必须落在同一个区间，
      // 否则按索引算出的页号会指向分页通道取不到的行。
      const rows = allRows.slice(0, MAX_PAGED_PARAM_ROWS);
      const declared = full.data.rowCount ?? allRows.length;
      return {
        ok: true as const,
        containerUri,
        entryIndex: unpacked.child.entryIndex,
        paramName: unpacked.child.name,
        typeName: full.data.typeName ?? 'UNKNOWN_PARAM',
        rowDataSize: full.data.rowDataSize ?? 0,
        rowCount: rows.length,
        rows: rows.map((row) => ({
          id: row.id,
          ...(row.name ? { name: row.name } : {})
        })),
        // 截断必须说出来：少给行而不声明，用户会以为这个 param 就这么大。
        rowsTruncated: declared > rows.length,
        containerHash: file.sha256 ?? '',
        childHash: unpacked.child.storedContentHash,
        ...(full.data.authority ? { authority: full.data.authority } : {}),
        diagnostics: [
          ...unpacked.diagnostics,
          ...(declared > rows.length
            ? [{
                severity: 'warning' as const,
                code: 'PARAM_ROW_INDEX_TRUNCATED',
                message: `行索引在 ${rows.length} 行处截断（实际 ${declared} 行）。`,
                sourceUri: containerUri
              }]
            : [])
        ]
      };
    }
  );

  handle('resource.inspectContainerTree', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container inspect.',
          sourceUri
        }]
      };
    }
    return inspectContainerTree(file.absolutePath, { relativePath: file.relativePath });
  });

  handle(
    'resource.listContainerChildren',
    async (_event, sourceUri: string, recursive?: boolean) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          children: [],
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before listing container children.',
            sourceUri
          }]
        };
      }
      return listContainerChildren(file.absolutePath, {
        relativePath: file.relativePath,
        recursive: recursive === true
      });
    }
  );

  /**
   * Paginated container-child entry access (hard constraint 17). BND4/script
   * containers may expose hundreds of entries; main materializes the entry
   * table once and serves bounded pages so the renderer never holds the whole
   * table. Children are projected to the renderer-safe DTO subset (no absolute
   * paths / diagnostics cross the bridge).
   */
  handle(
    'resource.listContainerChildrenPage',
    async (
      _event,
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      recursive?: boolean
    ) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (message: string) => ({
        ok: false,
        totalCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        children: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('资源未索引，无法分页枚举容器子项。');
      }
      const recursiveFlag = recursive === true;
      const cacheKey = `${sourceUri}::${recursiveFlag ? 'recursive' : 'flat'}`;
      let children = containerChildrenCache.get(cacheKey);
      if (!children) {
        const loaded = await loadContainerChildrenTable(file, sourceUri, recursiveFlag);
        if (!loaded.ok) {
          return {
            ok: false,
            totalCount: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            children: [],
            diagnostics: loaded.diagnostics
          };
        }
        children = loaded.children;
        containerChildrenCache.set(cacheKey, children);
      }
      const window = normalizePageWindow(
        children.length,
        requestedPage,
        requestedPageSize || CONTAINER_PAGE_SIZE
      );
      return {
        ok: true,
        totalCount: children.length,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        children: children
          .slice(window.offset, window.offset + window.size)
          .map((child) => ({
            childId: child.childId,
            ...(child.name ? { name: child.name } : {}),
            offset: child.offset,
            size: child.size,
            ...(child.compressedSize !== undefined
              ? { compressedSize: child.compressedSize }
              : {}),
            hash: child.hash,
            formatKind: child.formatKind,
            sourceContainerUri: child.sourceContainerUri,
            childUri: child.childUri,
            rawBytesAvailable: child.rawBytesAvailable,
            canReplace: child.canReplace,
            ...(child.nestedFormat ? { nestedFormat: child.nestedFormat } : {})
          })),
        diagnostics: []
      };
    }
  );

  handle(
    'resource.readContainerChild',
    async (_event, childUri: string) => {
      const hash = childUri.indexOf('#');
      const containerUri = hash >= 0 ? childUri.slice(0, hash) : childUri;
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file) {
        return {
          ok: false,
          childUri,
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Parent container must be indexed before reading a child.',
            sourceUri: containerUri
          }]
        };
      }
      return readContainerChild(file.absolutePath, childUri, { relativePath: file.relativePath });
    }
  );

  handle(
    'resource.replaceContainerChild',
    async (
      event,
      childUri: string,
      expectedContainerHash: string,
      expectedChildHash: string,
      newContentBase64: string
    ): Promise<RendererSaveResult> => {
      const hash = childUri.indexOf('#');
      const containerUri = hash >= 0 ? childUri.slice(0, hash) : childUri;
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Parent container must be indexed before child replace.',
            sourceUri: containerUri
          }]
        };
      }
      if (!activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CONTAINER_WRITE_NO_SESSION',
            message: '需要已打开的 Sekiro 工作区才能替换容器子项。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      const operationLog = activeSession
        ? await ensureActiveOperationLog(activeSession)
        : undefined;
      const storage = activeSession ? durableStoragePaths(activeSession.meta.workspaceId) : undefined;
      const confirmation = await requestWriteConfirmation({
        event,
        resourceLabel: `${file.relativePath} / ${childUri.slice(childUri.indexOf('#') + 1)}`,
        sourceUri: containerUri,
        actionLabel: '替换容器子项',
        payloadHash: createHash('sha256')
          .update(`${expectedContainerHash}\n${expectedChildHash}\n${newContentBase64}`)
          .digest('hex')
      });
      if (!confirmation) return cancelledWrite(containerUri);
      const result = await replaceContainerChild({
        file,
        childUri,
        expectedContainerHash,
        expectedChildHash,
        newContentBase64,
        confirmation,
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {}),
        ...(storage ?? {})
      });
      if (result.ok) {
        containerChildrenCache.clear();
        scriptContainerEntriesCache.clear();
      }
      return toRendererSaveResult(result, indexedFiles);
    }
  );

  handle('resource.roundTripContainer', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        byteIdentical: false,
        payloadEquivalent: false,
        originalHash: '',
        rebuiltHash: '',
        childHashMatches: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container roundtrip.',
          sourceUri
        }]
      };
    }
    return roundTripContainer(file.absolutePath);
  });

  handle('resource.validateContainer', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        format: 'unknown' as const,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container validate.',
          sourceUri
        }]
      };
    }
    return validateContainer(file.absolutePath);
  });

  handle('resource.probeContainerCapabilities', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    const probed = await probeContainerCapabilityOptions(file.absolutePath);
    // 必须脱敏：ResourceCapabilityMatrix 含 absolutePath
    // （resourceCapabilities.ts:45），而 verify-desktop-security-runtime.mjs 把它
    // 列为泄漏键。这与 readRawMetadata 那处（commit 3b67e63）同形态——handler 直接
    // return 含绝对路径的对象，而同文件其余 handler 都走了 sanitizeRendererValue。
    // 该 channel 此前 renderer 零引用，所以泄漏一直没被触发；接线前必须先补上，
    // 否则接线的同一刻就打开了泄漏。
    //
    // 另两条同族（roundTripContainer / validateContainer）实测**不含**路径
    // （ContainerRoundTripReport 与校验报告都只有布尔与计数），故未加脱敏——
    // 无差别包一层会让「哪些返回值真的带路径」这个事实变得看不出来。
    return sanitizeRendererValue(resolveResourceCapabilities(file, probed));
  });

  handle('resource.scriptContainerEvidence', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before script evidence.',
          sourceUri
        }]
      };
    }
    if (!activeSession) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'WORKSPACE_NOT_OPEN',
          message: '需要已打开的工作区才能构建 script 容器证据。',
          sourceUri
        }]
      };
    }
    const storage = durableStoragePaths(activeSession.meta.workspaceId);
    // ROOT-07：证据构建可能解包到 staging——先 mkdir/realpath/boundary 验证。
    const stage = await verifiedStageRoots(activeSession, storage, 'SCRIPT_EVIDENCE_STAGING_PREPARE_FAILED');
    if (stage.diagnostics.length > 0) {
      return {
        ok: false,
        diagnostics: stage.diagnostics
      };
    }
    return buildScriptContainerEvidence({
      containerPath: file.absolutePath,
      allowedRoots: [...stage.allowedRoots],
      timeoutMs: 60_000
    });
  });

  /**
   * Paginated script-container entry access (hard constraint 17). The complete
   * classified entry table is materialized once in main and served as bounded
   * pages; the renderer navigates every entry the container reports.
   *
   * Enumeration uses the Bridge `read-dcx-document` command (the same source as
   * the native replace baseline) because it returns the complete inner BND4
   * entry table — `inventory-asset-resources` only returns a bounded sample and
   * cannot back full-coverage navigation. If the full read fails, a bounded
   * inventory sample is served and `entriesComplete=false` keeps the report
   * honest. Classification per entry stays on the main side.
   */
  handle(
    'resource.listScriptContainerEntriesPage',
    async (_event, sourceUri: string, requestedPage: number, requestedPageSize: number) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (code: string, message: string, diagnostics?: StructuredDiagnostic[]) => ({
        ok: false,
        containerFormat: 'unknown',
        entryCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        entries: [],
        classificationSummary: emptyScriptClassificationSummary(),
        entriesComplete: false,
        diagnostics: diagnostics ?? [{
          severity: 'error' as const,
          code,
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('RESOURCE_NOT_INDEXED', '资源未索引，无法分页枚举脚本容器条目。');
      }
      if (!activeSession) {
        return failure('WORKSPACE_NOT_OPEN', '需要已打开的工作区才能分页读取脚本容器条目。');
      }
      let cached = scriptContainerEntriesCache.get(sourceUri);
      if (!cached) {
        // ROOT-07：只读枚举只传已存在并 verified 的 roots，不附加 staging。
        const roots = await verifiedReadRoots(activeSession, dirname(file.absolutePath));
        if (roots.diagnostics.length > 0) {
          return failure('BRIDGE_ROOT_MISSING', '允许根目录不存在。', roots.diagnostics);
        }
        const dcx = await runBridge<ScriptDcxDocumentLike>({
          command: 'read-dcx-document',
          filePath: file.absolutePath,
          resourceUri: `file:///${file.absolutePath.replace(/\\/g, '/')}`,
          allowedRoots: roots.allowedRoots,
          timeoutMs: 60_000
        });
        const nested = dcx.parseStatus === 'failed' ? undefined : dcx.data?.nested;
        if (!nested || !Array.isArray(nested.entries)) {
          // Full read unavailable: fall back to the bounded inventory sample.
          const inventory = await runBridge<ScriptInventoryDataLike>({
            command: 'inventory-asset-resources',
            filePath: file.absolutePath,
            resourceUri: `file:///${file.absolutePath.replace(/\\/g, '/')}`,
            allowedRoots: roots.allowedRoots,
            timeoutMs: 60_000
          });
          if (inventory.parseStatus === 'failed') {
            return failure(
              'SCRIPT_PAGED_INVENTORY_FAILED',
              '脚本容器完整读取与采样枚举均失败。',
              inventory.diagnostics
            );
          }
          const data = inventory.data ?? {};
          const rawEntries = data.entries ?? data.sampleEntries ?? [];
          const entries: ScriptContainerEntryEvidence[] = rawEntries.map((entry) => {
            const name = entry.name ?? `entry_${entry.index ?? 0}`;
            const classification = classifyScriptEntry(name);
            return {
              name,
              index: entry.index ?? 0,
              size: entry.uncompressedSize ?? 0,
              extension: name.split('.').pop()?.toLowerCase() ?? '',
              classification,
              magicLabel: magicLabel(classification)
            };
          });
          cached = {
            containerFormat: data.format ?? 'BND4',
            entryCount: data.entryCount ?? rawEntries.length,
            entries,
            classificationSummary: summarizeScriptClassifications(entries),
            entriesComplete: false,
            diagnostics: inventory.diagnostics
          };
        } else {
          const entries: ScriptContainerEntryEvidence[] = nested.entries.map((entry) => {
            const name = entry.name ?? `entry_${entry.index ?? 0}`;
            const classification = classifyScriptEntry(name);
            return {
              name,
              index: entry.index ?? 0,
              size: entry.uncompressedSize ?? entry.compressedSize ?? 0,
              extension: name.split('.').pop()?.toLowerCase() ?? '',
              classification,
              magicLabel: magicLabel(classification)
            };
          });
          cached = {
            containerFormat: dcx.data?.format
              ? `${dcx.data.format}->${nested.format ?? 'BND4'}`
              : (nested.format ?? 'BND4'),
            entryCount: nested.entryCount ?? entries.length,
            entries,
            classificationSummary: summarizeScriptClassifications(entries),
            entriesComplete: true,
            diagnostics: dcx.diagnostics
          };
        }
        scriptContainerEntriesCache.set(sourceUri, cached);
      }
      const window = normalizePageWindow(
        cached.entries.length,
        requestedPage,
        requestedPageSize || SCRIPT_PAGE_SIZE
      );
      return {
        ok: true,
        containerFormat: cached.containerFormat,
        entryCount: cached.entryCount,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        entries: cached.entries.slice(window.offset, window.offset + window.size),
        classificationSummary: cached.classificationSummary,
        entriesComplete: cached.entriesComplete,
        diagnostics: cached.diagnostics
      };
    }
  );

  /**
   * 脚本条目源码级只读视图（SCRIPT-41）。
   *
   * 主进程用**真实字节**逐条判定：不看文件名、不接受证据采样的分类结论。
   * 明文条目返回按真实 encoding 解码的文本；字节码条目只返回判定证据，
   * 渲染器据此只展示明确的只读字节视图。childUri 在主进程内按
   * `containerUri#bnd/child/<entryName>` 构造（与 core readContainerChild
   * 的解析格式一致），渲染器不接触内层地址。
   */
  handle(
    'resource.readScriptEntryPlaintext',
    async (_event, sourceUri: string, entryName: string): Promise<ScriptEntryPlaintextView> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (code: string, message: string, diagnostics?: StructuredDiagnostic[]): ScriptEntryPlaintextView => ({
        ok: false,
        name: entryName,
        classification: 'unknown',
        isPlaintext: false,
        verdictCode: code,
        printableRatio: 0,
        totalBytes: 0,
        trailingPaddingBytes: 0,
        containsNul: false,
        luaBytecodeMagic: false,
        encoding: 'ascii',
        hasBom: false,
        newlines: { crlf: 0, lf: 0, cr: 0 },
        diagnostics: diagnostics ?? [{
          severity: 'error' as const,
          code,
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('RESOURCE_NOT_INDEXED', '父容器未索引，无法读取脚本条目明文。');
      }
      if (!activeSession) {
        return failure('WORKSPACE_NOT_OPEN', '需要已打开的工作区才能读取脚本条目明文。');
      }
      const childUri = `${sourceUri}#bnd/child/${encodeURIComponent(entryName)}`;
      const read = await readContainerChild(file.absolutePath, childUri, { relativePath: file.relativePath });
      if (!read.ok || !read.bytes) {
        return {
          ok: false,
          name: entryName,
          classification: classifyScriptEntry(entryName),
          isPlaintext: false,
          verdictCode: 'PLAINTEXT_READ_FAILED',
          printableRatio: 0,
          totalBytes: read.bytes?.length ?? 0,
          trailingPaddingBytes: 0,
          containsNul: false,
          luaBytecodeMagic: false,
          encoding: 'ascii',
          hasBom: false,
          newlines: { crlf: 0, lf: 0, cr: 0 },
          diagnostics: read.diagnostics
        };
      }
      const verdict = classifyPlaintextBytes(read.bytes);
      const encoding = verdict.detectedEncoding;
      const hasBom = encoding === 'utf8-bom';
      let text: string | undefined;
      let newlines: { crlf: number; lf: number; cr: number } = { crlf: 0, lf: 0, cr: 0 };
      if (verdict.isPlaintext) {
        // 尾部 NUL 是容器对齐填充，不属于文本内容；解码前剥掉，否则解码文本会
        // 带一串不可见的 NUL 结尾，且换行统计会被污染。
        const contentEnd = read.bytes.length - verdict.trailingPaddingBytes;
        text = decodePlaintext(read.bytes.subarray(0, contentEnd), encoding);
        newlines = analyzePlaintextLineEndings(text);
      }
      return {
        ok: true,
        name: entryName,
        classification: classifyScriptEntry(entryName),
        isPlaintext: verdict.isPlaintext,
        verdictCode: verdict.code,
        printableRatio: verdict.printableRatio,
        totalBytes: verdict.totalBytes,
        trailingPaddingBytes: verdict.trailingPaddingBytes,
        containsNul: verdict.containsNul,
        luaBytecodeMagic: verdict.luaBytecodeMagic,
        encoding,
        hasBom,
        newlines,
        ...(text !== undefined ? { text } : {}),
        diagnostics: verdict.diagnostics
      };
    }
  );

  handle('operation.list', async (): Promise<RendererPatchHistoryEntry[]> => {
    if (!activeSession || !activeOperationLog) return [];
    const history = await activeOperationLog.history(activeSession.meta.workspaceId);
    const reversedOperationIds = new Set(
      history
        .filter((entry) => entry.status === 'committed' && entry.inverseOfOpId)
        .map((entry) => entry.inverseOfOpId!)
    );
    return history.map((entry) => toRendererHistoryEntry(
      reversedOperationIds.has(entry.opId) ? { ...entry, status: 'rolled_back' } : entry,
      indexedFiles
    ));
  });

  handle('operation.rollback', async (_event, opId: string): Promise<RollbackOperationIpcResult> => {
    if (!activeSession || !activeOperationLog) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'WORKSPACE_NOT_OPEN',
          message: 'Open a workspace before rolling back an operation.'
        }]
      };
    }

    const sourceOperation = await activeOperationLog.get(opId);
    if (!sourceOperation) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'OPERATION_NOT_FOUND',
          message: '找不到要回滚的操作。'
        }]
      };
    }
    const confirmation = await requestWriteConfirmation({
      event: _event,
      resourceLabel: sourceOperation.title,
      sourceUri: sourceOperation.files[0]?.targetUri ?? `operation://${opId}`,
      actionLabel: '回滚操作',
      payloadHash: createHash('sha256').update(opId).digest('hex'),
      extraSubjects: [`ROLLBACK_OPERATION:${opId}`]
    });
    if (!confirmation) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'warning',
          code: 'WRITE_CONFIRMATION_CANCELLED',
          message: '用户取消了回滚操作。'
        }]
      };
    }

    const storage = durableStoragePaths(activeSession.meta.workspaceId);

    const result = await rollbackOperation({
      opId,
      store: activeOperationLog,
      session: activeSession,
      confirmation,
      ...storage
    });

    return {
      ok: result.ok,
      opId: result.opId,
      ...(result.inverseOpId ? { inverseOpId: result.inverseOpId } : {}),
      restoredFiles: result.restoredFiles.map((path) => {
        return indexedFiles.find((file) => file.absolutePath === path)?.sourceUri ?? '[本机路径已隐藏]';
      }),
      diagnostics: sanitizeDiagnostics(result.diagnostics)
    };
  });

  handle('ai.tools', async () => toolRegistry.list());

  handle('ai.sidebarDraft', async (_event, request: AiSidebarDraftRequest): Promise<AiSidebarDraft> => {
    return buildAiSidebarDraft({
      ...request,
      settings: { ...request.settings, mode: activeAiMode },
      availableTools: request.availableTools.length > 0 ? request.availableTools : toolRegistry.list()
    });
  });

  handle(
    'ai.runTool',
    async (_event, name: string, input: unknown): Promise<ToolResult> => {
      if (!activeIndex) {
        return {
          ok: false,
          error: {
            code: 'WORKSPACE_NOT_ANALYZED',
            message: 'Analyze a workspace before running AI-safe tools.'
          }
        };
      }

      return toolRegistry.run(name, input, { workspaceIndex: activeIndex, mode: activeAiMode });
    }
  );

  // Model service configs — renderer receives DTO without secrets.
  handle('modelService.list', async () => modelServiceVault.listConfigs());

  handle('modelService.encryptionAvailable', async () => modelServiceVault.isEncryptionAvailable());

  handle(
    'modelService.upsert',
    async (
      _event,
      input: {
        id?: string;
        displayName: string;
        protocol: 'openai-compatible' | 'anthropic-compatible';
        baseUrl: string;
        model: string;
        apiKey?: string;
      }
    ) => {
      // apiKey is accepted once for encryption; never returned in the response DTO.
      const saved = await modelServiceVault.upsertConfig(input);
      return {
        id: saved.id,
        displayName: saved.displayName,
        protocol: saved.protocol,
        baseUrl: saved.baseUrl,
        model: saved.model,
        hasCredential: saved.hasCredential,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt
      };
    }
  );

  handle('modelService.delete', async (_event, configId: string) => {
    await modelServiceVault.deleteConfig(configId);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /*  AI agent sessions (Codex-derived kernel). Long tasks run async, */
  /*  report progress via 'ai:agent:event', cancel and have timeouts  */
  /*  (hard constraint 16). Keys stay in main (vault + adapter only). */
  /* ---------------------------------------------------------------- */

  const agentSessionsBaseDir = join(app.getPath('userData'), 'agent');
  const activeAgentRuns = new Map<string, AbortController>();
  /**
   * main 签发的 opaque 资源引用 token 注册表（AGENT-60C）。key = token 串，
   * value = 签发作用域（webContents.id）+ tokenId。renderer 提交资源引用时，main
   * 先查本表再比对 sender —— 跨 sender token 在本层被拒，不依赖 renderer 自觉。
   */
  const agentReferenceRegistry = new Map<string, { ownerId: string; tokenId: string }>();

  /**
   * Approval requests awaiting a renderer answer, keyed `sessionId:callId`.
   *
   * The loop's requestApproval is an awaited promise, but the renderer channel
   * is push + invoke. This map is the join: main pushes an event, parks the
   * resolver here, and ai.agent.approval.respond resolves it.
   *
   * A pending approval is *not* an implicit allow. Every path that discards a
   * resolver must resolve it as a rejection first (cancel, window teardown,
   * timeout) — dropping the promise would hang the loop, and defaulting it to
   * an allow would execute a write nobody approved.
   */
  const pendingApprovals = new Map<
    string,
    { resolve: (response: { decision: ApprovalDecision; note?: string }) => void; timer: NodeJS.Timeout }
  >();

  /**
   * How long an approval request waits before it self-rejects.
   *
   * Unbounded waiting is not an option: the loop holds the tool phase open, so
   * a user who walks away leaves the session pinned. Rejecting on timeout is
   * the safe direction — the agent reports "not approved" and stops, and the
   * user can re-run. Ten minutes is long enough to read a diff.
   */
  const APPROVAL_TIMEOUT_MS = 600_000;

  const settleApproval = (
    key: string,
    response: { decision: ApprovalDecision; note?: string }
  ): boolean => {
    const pending = pendingApprovals.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingApprovals.delete(key);
    pending.resolve(response);
    return true;
  };

  /** Reject everything still pending for one session (cancel / teardown). */
  const rejectSessionApprovals = (sessionId: string, note: string): void => {
    for (const key of [...pendingApprovals.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        settleApproval(key, { decision: 'reject', note });
      }
    }
  };

  /** §12.11 严格 seq：同一 session 的推送 seq 单调递增（renderer 侧丢弃重复/倒序）。 */
  const agentSessionSeqs = new Map<string, number>();
  const sendAgentEvent = (
    sessionId: string,
    event: AgentEvent | AiAgentSessionLifecycleEvent
  ): void => {
    if (webContents.isDestroyed()) return;
    const seq = (agentSessionSeqs.get(sessionId) ?? 0) + 1;
    agentSessionSeqs.set(sessionId, seq);
    const envelope: AiAgentEventEnvelope = { sessionId, seq, event };
    webContents.send('ai:agent:event', sanitizeRendererValue(envelope));
  };

  const resolveSessionPath = (
    sessionPath: string
  ): { ok: true; absolute: string } | { ok: false; error: { code: string; message: string } } => {
    const base = resolve(agentSessionsBaseDir);
    const absolute = resolve(base, sessionPath);
    if (absolute !== base && !absolute.startsWith(base + sep)) {
      return {
        ok: false,
        error: { code: 'ROLLOUT_PATH_FORBIDDEN', message: '会话路径必须位于会话目录内。' }
      };
    }
    return { ok: true, absolute };
  };

  handle('ai.agent.run', async (_event, request: AiAgentRunRequest): Promise<AiAgentRunIpcResult> => {
    if (!activeIndex) {
      return {
        ok: false,
        error: { code: 'WORKSPACE_NOT_ANALYZED', message: '请先分析工作区再运行 AI Agent。' }
      };
    }
    if (
      typeof request?.configId !== 'string' || request.configId.trim() === ''
      || typeof request?.prompt !== 'string' || request.prompt.trim() === ''
    ) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'configId 与 prompt 必填。' } };
    }
    // AGENT-60D 提交期消费点：资源引用 token 必须是 main 签发的、未过期、且
    // 属于当前 sender。跨 sender / 伪造 token 在这里被拒，不进入工具上下文。
    // 这是 agent 通道，不是 param/format 读取，**不得**返回 BACKUP_READ_FORBIDDEN。
    const resources = request.resources ?? [];
    const ownerId = String(_event.sender.id);
    for (const reference of resources) {
      const registered = agentReferenceRegistry.get(reference.token);
      if (registered === undefined || registered.tokenId === undefined) {
        return {
          ok: false,
          error: { code: 'AGENT_TOKEN_UNKNOWN', message: '资源引用 token 不在已签发注册表中，拒绝提交。' }
        };
      }
      const scope = validateAgentReferenceScope(reference.token, ownerId);
      if (!scope.ok) {
        return { ok: false, error: { code: scope.code, message: scope.message } };
      }
      if (registered.ownerId !== ownerId) {
        return {
          ok: false,
          error: { code: 'AGENT_TOKEN_SENDER_MISMATCH', message: '资源引用属于其他发送方，拒绝提交。' }
        };
      }
    }
    const stored = (await modelServiceVault.listConfigs()).find((config) => config.id === request.configId);
    if (!stored) {
      return { ok: false, error: { code: 'MODEL_SERVICE_CONFIG_NOT_FOUND', message: '模型服务配置不存在。' } };
    }
    if (!stored.hasCredential) {
      return {
        ok: false,
        error: { code: 'MODEL_SERVICE_UNCONFIGURED', message: '模型服务未配置凭据；未发起网络请求。' }
      };
    }
    const apiKey = await modelServiceVault.resolveApiKey(stored.id);
    if (!apiKey) {
      return {
        ok: false,
        error: { code: 'MODEL_SERVICE_UNCONFIGURED', message: '模型服务凭据不可解密；未发起网络请求。' }
      };
    }
    const modelConfig = {
      id: stored.id,
      displayName: stored.displayName,
      protocol: stored.protocol,
      baseUrl: stored.baseUrl,
      model: stored.model,
      hasCredential: true as const,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt
    };
    const adapterResult = createConfiguredModelServiceAdapter({ config: modelConfig, apiKey });
    if (!adapterResult.ok) {
      const diagnostic = adapterResult.diagnostics[0];
      return { ok: false, error: { code: diagnostic?.code ?? 'MODEL_SERVICE_INVALID', message: diagnostic?.message ?? '模型服务配置无效。' } };
    }
    const mode: ToolContext['mode'] = request.mode === 'normal' || request.mode === 'fullPermission'
      ? request.mode
      : 'plan';
    const bridge = createAgentToolBridge({
      registry: toolRegistry,
      context: { workspaceIndex: activeIndex, mode }
    });

    let resumeFrom: ResumedRollout | undefined;
    if (request.resumeSessionPath !== undefined) {
      const resolved = resolveSessionPath(request.resumeSessionPath);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const loaded = await loadRolloutSession(resolved.absolute);
      if (!loaded.ok) {
        return { ok: false, error: { code: loaded.code, message: loaded.message } };
      }
      const { ok: _ok, path: _path, ...resumed } = loaded;
      resumeFrom = resumed;
    }

    const sessionId = randomUUID();
    const controller = new AbortController();
    activeAgentRuns.set(sessionId, controller);
    sendAgentEvent(sessionId, { type: 'session-accepted', mode });

    const permissionMode = mode === 'fullPermission' ? 'full' : mode;

    /**
     * Approval bridge. Parks a resolver keyed by callId, pushes the request to
     * the renderer, and lets ai.agent.approval.respond settle it.
     *
     * Wired unconditionally rather than only outside plan mode: plan mode
     * currently denies write tools before they reach the approval gate, so the
     * callback simply never fires there. Making it conditional would mean that
     * whether a write can happen without approval depends on a mode check
     * written in two places.
     */
    const requestApproval = (approvalRequest: {
      step: number;
      callId: string;
      toolName: string;
      permissionLevel: string;
      argumentsJson: string;
    }): Promise<{ decision: ApprovalDecision; note?: string }> =>
      new Promise((resolveApproval) => {
        const key = `${sessionId}:${approvalRequest.callId}`;
        const timer = setTimeout(() => {
          // timed_out 而不是 reject：审计里「用户拒绝了」与「没人回答」是两个
          // 不同事实，后续动作也不同（前者要改方案，后者要看是不是没人在场）。
          settleApproval(key, {
            decision: 'timed_out',
            note: `审批请求超过 ${Math.round(APPROVAL_TIMEOUT_MS / 60_000)} 分钟未回答，按未批准处理。`
          });
        }, APPROVAL_TIMEOUT_MS);
        // unref so a parked approval never keeps the process alive on quit.
        timer.unref?.();
        pendingApprovals.set(key, { resolve: resolveApproval, timer });
        if (webContents.isDestroyed()) {
          // No renderer to ask. Reject rather than execute — a closed window is
          // not consent.
          settleApproval(key, { decision: 'reject', note: '渲染进程已关闭，无法请求审批。' });
        }
      });

    /**
     * Resolve a unified diff for a pending write.
     *
     * Lives in main because it reads the current file — the loop has no
     * filesystem access, and giving it any would soften the "tools are the only
     * way the agent touches the workspace" boundary.
     *
     * Path resolution goes through activeSession.resolveWritablePath, so the
     * read-only-base-game constraint is enforced by the existing mechanism
     * rather than a second check written here. An unresolvable path yields null
     * (no diff) rather than an error: failing to *preview* a change must never
     * decide whether it gets approved.
     */
    const resolveApprovalDiff = async (input: {
      toolName: string;
      argumentsJson: string;
    }): Promise<ApprovalDiff | null> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.argumentsJson);
      } catch {
        return null;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;

      // 两种形态都支持:propose_text_patch 的平铺字段,与 PatchProposal 的
      // changes[0]。只取第一条 —— 一次审批对应一个具体动作。
      const changes = Array.isArray(record.changes) ? record.changes : null;
      const firstChange = typeof changes?.[0] === 'object' && changes[0] !== null
        ? changes[0] as Record<string, unknown>
        : null;
      const structuredEdit = typeof firstChange?.structuredEdit === 'object'
        && firstChange.structuredEdit !== null
        ? firstChange.structuredEdit as Record<string, unknown>
        : null;

      const targetPath = typeof record.targetPath === 'string' && record.targetPath !== ''
        ? record.targetPath
        : typeof firstChange?.targetPath === 'string' ? firstChange.targetPath : '';
      const afterText = typeof record.newText === 'string'
        ? record.newText
        : typeof structuredEdit?.newText === 'string' ? structuredEdit.newText : null;
      if (targetPath === '' || afterText === null) return null;
      if (!activeSession) return null;

      // 用 Secure 版而不是同步版：同步 resolveWritablePath 的注释写明它只是
      // **词法预检**，权威检查是 resolveWritablePathSecure（会解析 junction 与
      // symlink）。一个指向原版游戏目录的 symlink 能骗过词法检查——这里只是读，
      // 但「游戏目录只读」这条边界该由权威机制守，不该因为「只是预览」就放宽。
      const writable = await activeSession.resolveWritablePathSecure(targetPath, 'overlay');
      if (!writable.ok || typeof writable.absolutePath !== 'string') return null;
      const resolvedPath = writable.absolutePath;

      let beforeText = '';
      let newFile = false;
      try {
        beforeText = await readFile(resolvedPath, 'utf8');
      } catch {
        // 目标不存在:整篇都是新增。这与「读失败」在界面上必须可区分,
        // 故用 newFile 标记而不是静默当成空文件对比。
        newFile = true;
      }

      const unifiedDiff = createUnifiedDiff(beforeText, afterText, {
        fromFile: newFile ? '(新文件)' : targetPath,
        toFile: targetPath
      });
      const lines = unifiedDiff.split('\n');
      const addedLines = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
      const removedLines = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;

      // 上限:几千行的 diff 会把审批卡片变成读不完的墙,而读不完的 diff 等于
      // 没有 diff。截断必须显式说明截了多少,否则用户会以为改动就这么点。
      const MAX_DIFF_LINES = 400;
      const truncated = lines.length > MAX_DIFF_LINES;

      return {
        targetPath,
        unifiedDiff: truncated ? lines.slice(0, MAX_DIFF_LINES).join('\n') : unifiedDiff,
        addedLines,
        removedLines,
        newFile,
        ...(truncated
          ? {
              truncatedNote: `diff 共 ${lines.length} 行，此处只显示前 ${MAX_DIFF_LINES} 行；`
                + `完整改动为 +${addedLines} / -${removedLines} 行。`
            }
          : {})
      };
    };

    void runAgentSession({
      sessionsDir: agentSessionsBaseDir,
      sessionId,
      adapter: adapterResult.adapter,
      config: modelConfig,
      apiKey,
      prompt: request.prompt,
      permissionMode,
      tools: bridge.tools,
      executeTool: bridge.executeTool,
      signal: controller.signal,
      requestApproval,
      resolveApprovalDiff,
      ...(request.approvalRequiredLevels
        ? { approvalRequiredLevels: request.approvalRequiredLevels }
        : {}),
      ...(request.streaming === true ? { streaming: true } : {}),
      ...(request.timeoutMs != null && request.timeoutMs > 0
        ? { timeoutMs: Math.trunc(request.timeoutMs) }
        : {}),
      ...(request.maxSteps != null && request.maxSteps > 0
        ? { maxSteps: Math.trunc(request.maxSteps) }
        : {}),
      ...(request.maxTotalOutputTokens != null && request.maxTotalOutputTokens > 0
        ? { maxTotalOutputTokens: Math.trunc(request.maxTotalOutputTokens) }
        : {}),
      ...(request.autoCompactTokenLimit != null && request.autoCompactTokenLimit > 0
        ? { compaction: { autoCompactTokenLimit: Math.trunc(request.autoCompactTokenLimit) } }
        : {}),
      // Only the attempt count is renderer-controllable, and it is clamped:
      // backoff base and jitter stay at the loop's defaults. Exposing those
      // would let the renderer configure a hot retry loop against a
      // third-party provider. Read inline so the value's origin is visible at
      // the call site rather than in a variable computed elsewhere.
      ...(request.retryMaxAttempts != null && request.retryMaxAttempts > 0
        ? { retryPolicy: { maxAttempts: Math.min(8, Math.trunc(request.retryMaxAttempts)) } }
        : {}),
      ...(request.useContextBroker === true
        ? {
            contextBroker: createContextBroker(),
            ...(request.contextMaxBytes != null && request.contextMaxBytes > 0
              ? { contextBrokerOptions: { maxBytes: Math.trunc(request.contextMaxBytes) } }
              : {})
          }
        : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
      onEvent: (event) => sendAgentEvent(sessionId, event)
    }).then((result) => {
      activeAgentRuns.delete(sessionId);
      rejectSessionApprovals(sessionId, '会话已结束，未回答的审批按拒绝处理。');
      sendAgentEvent(sessionId, {
        type: 'session-done',
        finishReason: result.run.finishReason,
        steps: result.run.steps,
        rolloutFileName: basename(result.rolloutPath)
      });
    }).catch((error: unknown) => {
      activeAgentRuns.delete(sessionId);
      // Also on the failure path: a crashed run must not leave resolvers parked.
      rejectSessionApprovals(sessionId, '会话异常结束，未回答的审批按拒绝处理。');
      sendAgentEvent(sessionId, {
        type: 'session-error',
        code: 'AGENT_SESSION_FAILED',
        message: error instanceof Error ? error.message : String(error)
      });
    });

    return { ok: true, sessionId };
  });

  handle('ai.agent.cancel', async (_event, sessionId: string): Promise<{ ok: boolean }> => {
    const controller = activeAgentRuns.get(sessionId);
    if (controller) controller.abort();
    // Cancel must also settle parked approvals. An abort signal does not reach
    // a promise the loop is awaiting, so without this the loop would sit in the
    // tool phase waiting for an answer the user has already walked away from.
    rejectSessionApprovals(sessionId, '任务已取消，未回答的审批按拒绝处理。');
    return { ok: true };
  });

  /**
   * Renderer's answer to one approval request.
   *
   * Returns matched:false for an unknown key rather than throwing — a stale
   * answer (session already ended, request already timed out) is a normal race,
   * not an error, and the renderer needs to tell the two apart to clear its UI.
   */
  handle(
    'ai.agent.approval.respond',
    async (
      _event,
      request: AiAgentApprovalResponseRequest
    ): Promise<{ ok: true; matched: boolean } | { ok: false; error: { code: string; message: string } }> => {
      if (
        typeof request?.sessionId !== 'string' || request.sessionId === ''
        || typeof request?.callId !== 'string' || request.callId === ''
      ) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionId 与 callId 必填。' } };
      }
      // 用户可发起的四档。`timed_out` 刻意**不在**其中：它只能由主进程的超时
      // 定时器产生。允许 renderer 自称超时会让「没人回答」这个事实可以被伪造，
      // 而审计正是靠它区分「用户拒绝」与「无人在场」。
      const allowed = ['once', 'always', 'reject', 'never', 'abort'] as const;
      if (!allowed.includes(request.decision as (typeof allowed)[number])) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: `decision 取值应为 ${allowed.join(' | ')} 之一。`
          }
        };
      }
      const matched = settleApproval(`${request.sessionId}:${request.callId}`, {
        decision: request.decision,
        ...(typeof request.note === 'string' && request.note !== '' ? { note: request.note } : {})
      });
      return { ok: true, matched };
    }
  );

  /**
   * §12.11 审批提交通道（DecideAgentApprovalRequest）。
   *
   * Change Review 卡「批准并提交 / 拒绝」的消费点。照现有 IPC 范式：named DTO +
   * runtime decoder（decodeDecideAgentApprovalRequest）先做形状校验，再 settle
   * 挂起的审批。decision 只有两档：`approve-and-commit`（映射 loop 的 `once`，
   * 批准这一次并让 loop 提交）与 `reject`。`timed_out` 只能由主进程超时定时器
   * 产生，renderer 不得自称超时。
   *
   * session/root 校验：reviewId 经 decoder 强制为 stable id（非路径）；settleApproval
   * 对未知 key 返回 matched:false（会话已结束 / 已超时的正常竞态），不抛异常。
   * 这是 agent 通道，不是 param/format 读取，**不得**返回 BACKUP_READ_FORBIDDEN。
   */
  handle(
    'agent.approval.decide',
    async (_event, request: unknown): Promise<
      { ok: true; matched: boolean } | { ok: false; error: { code: string; message: string } }
    > => {
      let decoded: DecideAgentApprovalRequest;
      try {
        decoded = decodeDecideAgentApprovalRequest(request, 'DecideAgentApprovalRequest');
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: error instanceof Error ? error.message : '审批决定请求格式非法。'
          }
        };
      }
      const decision = decoded.decision === 'approve-and-commit' ? 'once' : 'reject';
      const matched = settleApproval(`${decoded.sessionId}:${decoded.reviewId}`, { decision });
      return { ok: true, matched };
    }
  );

  handle('ai.agent.sessions', async (): Promise<AiAgentSessionListIpcResult> => {
    const sessions = await listRolloutSessions(agentSessionsBaseDir, 50);
    return {
      ok: true,
      sessions: sessions.map((session) => ({
        sessionPath: relative(agentSessionsBaseDir, session.path),
        fileName: session.fileName,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        messageCount: session.messageCount,
        parseErrors: session.parseErrors,
        interrupted: session.interrupted,
        compactedWindows: session.compactedWindows,
        sizeBytes: session.sizeBytes,
        modifiedAt: session.modifiedAt
      }))
    };
  });

  handle('ai.agent.session.load', async (_event, sessionPath: string): Promise<AiAgentSessionLoadIpcResult> => {
    if (typeof sessionPath !== 'string' || sessionPath.trim() === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionPath 必填。' } };
    }
    const resolved = resolveSessionPath(sessionPath);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const loaded = await loadRolloutSession(resolved.absolute);
    if (!loaded.ok) {
      return { ok: false, error: { code: loaded.code, message: loaded.message } };
    }
    return {
      ok: true,
      meta: loaded.meta,
      messageCount: loaded.messages.length,
      parseErrors: loaded.parseErrors,
      interrupted: loaded.interrupted,
      compactedWindows: loaded.compactedWindows,
      messagesPage: loaded.messages.slice(-20)
    };
  });

  /**
   * 资源引用通道（AGENT-60C）。
   *
   * 把 renderer 的 §12.8 语义选区换成 main 签发的 opaque token（§12.11
   * AgentResourceReference）。约束：
   *  - 必须先分析工作区（root 校验）；
   *  - 选区经 decodeEditorSelectionContext + renderer 安全白名单校验，绝对路径 /
   *    raw parser / Hex dump 直接拒绝（AGENT_SELECTION_UNSAFE）；
   *  - token 只携带 tokenId / sender 作用域 / TTL / 逻辑元数据，不携带任何路径；
   *    提交时跨 sender 使用被 validateAgentReferenceScope 拒绝。
   * 这是 agent 通道，不是 param/format 读取，**不得**返回 BACKUP_READ_FORBIDDEN。
   */
  handle(
    'agent.resourceReference.create',
    async (event, request: unknown): Promise<AgentResourceReferenceCreateIpcResult> => {
      if (!activeIndex) {
        return { ok: false, error: { code: 'WORKSPACE_NOT_ANALYZED', message: '请先分析工作区再引用资源。' } };
      }
      const selectionValue = typeof request === 'object' && request !== null
        ? (request as Record<string, unknown>).selection
        : undefined;
      let selection: EditorSelectionContext;
      try {
        selection = decodeEditorSelectionContext(selectionValue, 'ResourceReferenceRequest.selection');
      } catch (error) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: error instanceof Error ? error.message : '选区格式非法。' }
        };
      }
      const issues = selectionRendererSafetyIssues(selection);
      if (issues.length > 0) {
        return {
          ok: false,
          error: {
            code: 'AGENT_SELECTION_UNSAFE',
            message: issues.map((issue) => issue.message).join('；'),
            diagnostics: issues
          }
        };
      }
      const tokenId = randomUUID();
      const ownerId = String(event.sender.id);
      const label = agentSelectionSummary(selection);
      const token = mintAgentReferenceToken({
        kind: 'resource',
        tokenId,
        ownerId,
        domain: selection.domain,
        label
      });
      const reference: AgentResourceReference = {
        token,
        domain: selection.domain,
        label,
        expiresAt: agentReferenceExpiresAt()
      };
      agentReferenceRegistry.set(token, { ownerId, tokenId });
      return { ok: true, reference };
    }
  );
}
