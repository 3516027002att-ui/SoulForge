import { open, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  analyzePlaintextLineEndings,
  buildScriptContainerEvidence as nativeBuildScriptContainerEvidence,
  classifyPlaintextBytes,
  classifyScriptEntry,
  decodePlaintext,
  inspectContainerTree as nativeInspectContainerTree,
  listContainerChildren as nativeListContainerChildren,
  magicLabel,
  normalizePageWindow,
  probeContainerCapabilityOptions,
  readContainerChild as readNativeContainerChild,
  readRawResourceMetadata as nativeReadRawResourceMetadata,
  readRawResourceRange as nativeReadRawResourceRange,
  resolveResourceCapabilities,
  roundTripContainer as roundTripNativeContainer,
  runBridge as nativeRunBridge,
  sanitizeEntryName,
  validateContainer as validateNativeContainer,
  type ScriptContainerEntryEvidence,
  type ScriptEntryClassification,
  type WorkspaceSession
} from '@soulforge/core';
import {
  CONTAINER_PAGE_SIZE,
  SCRIPT_PAGE_SIZE,
  type Diagnostic,
  type IndexedFile,
  type ScriptEntryPlaintextView,
  type ScriptSourceView,
  type StructuredDiagnostic
} from '@soulforge/shared';
import {
  prepareBridgeRoots as nativePrepareBridgeRoots,
  type BridgeRootSession,
  type PrepareBridgeRootsResult
} from '../bridgeRoots.js';
import { sanitizeDiagnostics, sanitizeRendererValue } from '../rendererDto.js';
import type { NativeBnd4DocumentLike, NativeDcxEnvelopeLike } from '../ipc/bridgeEnvelopes.js';
import { WorkspaceReadLifetime } from '../ipc/workspaceReadLifetime.js';

type CachedContainerChildren = Awaited<
  ReturnType<typeof listNativeContainerChildren>
>['children'];

const readLifetime = new WorkspaceReadLifetime();
const prepareBridgeRoots = readLifetime.guardCall(nativePrepareBridgeRoots);
const runBridge = readLifetime.guardCall(nativeRunBridge);
const readRawResourceRange = readLifetime.guardCall(nativeReadRawResourceRange);
const readRawResourceMetadata = readLifetime.guardCall(nativeReadRawResourceMetadata);
const inspectNativeContainerTree = readLifetime.guardCall(nativeInspectContainerTree);
const listNativeContainerChildren = readLifetime.guardCall(nativeListContainerChildren);
const buildScriptContainerEvidence = readLifetime.guardCall(nativeBuildScriptContainerEvidence);
const containerChildrenCache = readLifetime.createCache<string, CachedContainerChildren>();

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
const scriptContainerEntriesCache = readLifetime.createCache<string, CachedScriptContainerEntries>();

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

type NativeContainerKind = 'bnd3' | 'bnd4' | 'dcx';

/** Classify routing from eight bytes; native format parsing remains in C#. */
async function probeNativeContainerKind(absolutePath: string): Promise<NativeContainerKind | null> {
  const handle = await open(absolutePath, 'r');
  try {
    const header = Buffer.alloc(8);
    let length = 0;
    while (length < header.length) {
      const { bytesRead } = await handle.read(header, length, header.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const magic = header.subarray(0, Math.min(length, 4)).toString('ascii');
    if (magic === 'BND3' || magic === 'BND4') {
      if (length >= 8 && header.subarray(4, 8).equals(Buffer.from('SFBN', 'ascii'))) return null;
      return magic === 'BND3' ? 'bnd3' : 'bnd4';
    }
    return magic === 'DCX\0' ? 'dcx' : null;
  } finally {
    await handle.close();
  }
}

/** Probe first so real archives avoid the TS fixture reader's full-file scan. */
async function loadContainerChildrenTable(
  deps: RawResourceServiceDeps,
  file: IndexedFile,
  sourceUri: string,
  recursive: boolean
): Promise<{ ok: boolean; children: CachedContainerChildren; diagnostics: StructuredDiagnostic[] }> {
  let kind: NativeContainerKind | null;
  try {
    kind = await probeNativeContainerKind(file.absolutePath);
  } catch {
    return { ok: false, children: [], diagnostics: [{
      severity: 'error', code: 'CONTAINER_HEADER_READ_FAILED',
      message: 'Could not read the container header.', sourceUri
    }] };
  }
  if (kind === 'bnd3') {
    return { ok: false, children: [], diagnostics: [{
      severity: 'error', code: 'BND3_NATIVE_ENUMERATION_UNSUPPORTED',
      message: 'Native BND3 enumeration is not supported by the Bridge.', sourceUri
    }] };
  }
  if (kind === null) {
    const result = await listNativeContainerChildren(file.absolutePath, {
      relativePath: file.relativePath, recursive
    });
    return { ok: result.ok, children: result.ok ? result.children : [], diagnostics: result.diagnostics };
  }
  let allowedRoots: string[] | null = null;
  if (deps.activeSession) {
    const roots = await prepareBridgeRoots(
      deps.bridgeRootSession(deps.activeSession, deps.durableStoragePaths(deps.activeSession.meta.workspaceId)),
      'read'
    );
    if (!roots.ok) {
      return { ok: false, children: [], diagnostics: [deps.bridgeRootsDiagnostic('BRIDGE_ROOT_MISSING', roots)] };
    }
    allowedRoots = [...roots.allowedRoots];
  }
  return enumerateNativeContainerEntries(file.absolutePath, sourceUri,
    allowedRoots ?? [dirname(file.absolutePath)], kind);
}

/** Complete native entry table, projected to logical names and read-only capabilities. */
async function enumerateNativeContainerEntries(
  absolutePath: string,
  sourceUri: string,
  allowedRoots: string[],
  kind: 'bnd4' | 'dcx'
): Promise<{
  ok: boolean;
  children: CachedContainerChildren;
  diagnostics: StructuredDiagnostic[];
}> {
  const result = await runBridge<NativeDcxEnvelopeLike & NativeBnd4DocumentLike>({
    command: kind === 'bnd4' ? 'list-bnd4-entries' : 'read-dcx-document',
    filePath: absolutePath,
    resourceUri: 'file:///' + absolutePath.replace(/\\/g, '/'),
    allowedRoots,
    ...(kind === 'bnd4' ? { commandOptions: { includeContentHashes: true } } : {}),
    timeoutMs: 60_000
  });
  if (result.parseStatus === 'failed') {
    return { ok: false, children: [], diagnostics: result.diagnostics };
  }
  const entries = (kind === 'bnd4' ? result.data?.entries : result.data?.nested?.entries) ?? [];
  if (entries.length === 0) {
    return { ok: true, children: [], diagnostics: [{
      severity: 'info', code: 'BND_NATIVE_ENUMERATION_EMPTY',
      message: 'Bridge returned no native BND4 entries; the payload may not be BND4.', sourceUri
    }] };
  }
  const seen = new Set<string>();
  const children = entries.map((entry) => {
    const rawName = entry.name ?? 'entry_' + (entry.index ?? 0);
    const name = sanitizeEntryName(rawName, entry.index ?? 0, seen);
    const extension = name.split('.').pop()?.toLowerCase() ?? 'unknown';
    return {
      childId: String(entry.index ?? 0), name,
      offset: entry.dataOffset ?? 0, size: entry.uncompressedSize ?? 0,
      ...(entry.compressedSize !== undefined && entry.compressedSize !== entry.uncompressedSize
        ? { compressedSize: entry.compressedSize } : {}),
      hash: entry.contentHash ?? '', formatKind: extension,
      sourceContainerUri: sourceUri,
      childUri: sourceUri + '#bnd/child/' + encodeURIComponent(name),
      // Loose binders are list-only; the child snapshot path still requires DCX.
      rawBytesAvailable: kind === 'dcx', canReplace: false, diagnostics: []
    } satisfies CachedContainerChildren[number];
  });
  return { ok: true, children, diagnostics: [{
    severity: 'info', code: 'BND_NATIVE_ENUMERATION_COMPLETE',
    message: 'Complete native BND4 entry table: ' + entries.length + ' entries.', sourceUri
  }] };
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

/**
 * 把 Bridge 枚举行映射成 renderer-safe 脚本条目 DTO。
 *
 * Sekiro luabnd 内层名是构建机绝对路径（如
 * `N:\NTC\data\Target\INTERROOT_win64\script\ai\out\bin\goal_list.lua`），直接
 * 出站会被 sanitizeRendererValue 的 maskPathFragments 打成 `[本机路径已隐藏]`。
 * 因此出站名一律经 sanitizeEntryName 液化到 basename（重名加 `#index`，与
 * PARAM 解包 / enumerateNativeContainerEntries 同口径）；分类与扩展名仍按
 * 原始名判定（液化名带 `#index` 后缀会污染扩展名解析）。
 */
function scriptEntryEvidenceFromBridge(
  entry: ScriptDcxEntryLike | ScriptInventoryEntryLike,
  size: number,
  seen: Set<string>
): ScriptContainerEntryEvidence {
  const rawName = entry.name ?? `entry_${entry.index ?? 0}`;
  const name = sanitizeEntryName(rawName, entry.index ?? 0, seen);
  const classification = classifyScriptEntry(rawName);
  return {
    name,
    index: entry.index ?? 0,
    size,
    extension: rawName.split('.').pop()?.toLowerCase() ?? '',
    classification,
    magicLabel: magicLabel(classification)
  };
}

/**
 * 脚本容器内子项按 BND4 `entryIndex` 用 Bridge native 读链取真实字节
 * （13-A：luabnd 里的 Lua 必须能点开看到反编译文本）。
 *
 * 枚举走 `read-dcx-document`（与 listScriptContainerEntriesPage / PARAM
 * unpackContainerParamChild 同源，只读），取字节走 `snapshot-bnd4-child`
 * （与 core scriptContainerEvidence 的 magic 采样同命令，返回完整
 * contentBase64）。刻意**不**走 readContainerChild → readSyntheticBnd：
 * 合成 SFBN 只认 TS 合成 BND，真 luabnd 无 SFBN 标记必失败（红字英文
 * `not authoritative`），反编译器一行都吃不到字节。
 *
 * 返回的 `name` 是 sanitizeEntryName 液化的 basename（内层名是构建机绝对路径，
 * 直接入 DTO 会被打码成 `[本机路径已隐藏]`）；`rawName`/`storedContentHash`
 * 供主进程内部使用。
 */
interface ReadScriptContainerChildResult {
  ok: true;
  bytes: Uint8Array;
  rawName: string;
  /** sanitizeEntryName 液化的 basename（DTO 出站名）。 */
  name: string;
  storedContentHash: string;
  diagnostics: StructuredDiagnostic[];
}
async function readScriptContainerChildByIndex(input: {
  containerPath: string;
  containerUri: string;
  entryIndex: number;
  allowedRoots: string[];
  oodleRuntimeRoot?: string;
}): Promise<ReadScriptContainerChildResult | { ok: false; diagnostics: StructuredDiagnostic[] }> {
  const dcx = await runBridge<ScriptDcxDocumentLike>({
    command: 'read-dcx-document',
    filePath: input.containerPath,
    resourceUri: input.containerUri,
    allowedRoots: input.allowedRoots,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    timeoutMs: 60_000
  });
  if (dcx.parseStatus === 'failed') {
    return { ok: false, diagnostics: sanitizeDiagnostics(dcx.diagnostics) };
  }
  const entries = dcx.data?.nested?.entries ?? [];
  const target = entries.find((entry) => (entry.index ?? -1) === input.entryIndex);
  if (!target || !target.name) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error' as const,
        code: 'SCRIPT_SOURCE_ENTRY_NOT_FOUND',
        message: `脚本容器内没有索引 ${input.entryIndex} 的条目。`,
        sourceUri: input.containerUri
      }]
    };
  }
  const snapshot = await runBridge<{ contentBase64?: string }>({
    command: 'snapshot-bnd4-child',
    filePath: input.containerPath,
    resourceUri: input.containerUri,
    allowedRoots: input.allowedRoots,
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {}),
    timeoutMs: 120_000,
    commandOptions: { entryIndex: input.entryIndex }
  });
  if (snapshot.parseStatus === 'failed' || !snapshot.data?.contentBase64) {
    return {
      ok: false,
      diagnostics: [
        ...sanitizeDiagnostics(snapshot.diagnostics),
        {
          severity: 'error' as const,
          code: 'SCRIPT_SOURCE_CHILD_SNAPSHOT_FAILED',
          message: `读取脚本容器条目 ${target.name}（索引 ${input.entryIndex}）字节失败。`,
          sourceUri: input.containerUri
        }
      ]
    };
  }
  const name = sanitizeEntryName(target.name, input.entryIndex, new Set());
  return {
    ok: true,
    bytes: new Uint8Array(Buffer.from(snapshot.data.contentBase64, 'base64')),
    rawName: target.name,
    name,
    storedContentHash: target.contentHash ?? '',
    diagnostics: []
  };
}

/** workspace 生命周期与容器写回后由组合根调用的 domain-owned reset。 */
export function clearRawResourceCaches(): void {
  readLifetime.invalidate();
  containerChildrenCache.clear();
  scriptContainerEntriesCache.clear();
}

export interface RawResourceServiceDeps {
  readonly indexedFiles: readonly IndexedFile[];
  readonly activeSession: WorkspaceSession | null;
  durableStoragePaths(workspaceId: string): {
    root: string;
    backupBaseDir: string;
    recoveryDir: string;
    stagingRoot: string;
  };
  bridgeRootSession(session: WorkspaceSession, storage: { root: string }): BridgeRootSession;
  bridgeRootsDiagnostic(
    code: string,
    result: Extract<PrepareBridgeRootsResult, { ok: false }>
  ): Diagnostic;
  verifiedReadRoots(
    session: WorkspaceSession | null,
    fallback: string
  ): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  verifiedStageRoots(
    session: WorkspaceSession,
    storage: { root: string },
    code: string
  ): Promise<{ allowedRoots: string[]; writableRoots: string[]; diagnostics: Diagnostic[] }>;
}

export function createRawResourceService(deps: RawResourceServiceDeps) {
  const verifiedReadRoots = readLifetime.guardCall(deps.verifiedReadRoots);
  const currentSession = () => deps.activeSession;
  const readRawRange = async (sourceUri: string, offset: number, length: number) => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
            message: '请先索引资源，再读取原始范围。',
            sourceUri
          }]
        };
      }
      return readRawResourceRange(file, offset, length);
    };

  const readRawMetadata = async (sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    const meta = await readRawResourceMetadata(file, { computeHash: file.size <= 32 * 1024 * 1024 });
    // 必须脱敏：RawResourceMetadata 含 absolutePath（rawRead.ts:16），而
    // verify-desktop-security-runtime.mjs 把 absolutePath 列为泄漏键。此前这里
    // 直接 return 原对象，等于把本机绝对路径送进 renderer——同文件其余 handler
    // （:675/:904/:933/:948）都走了 sanitizeRendererValue，只有这一条漏了。
    // 该 channel 此前 renderer 零引用，所以泄漏一直没被触发；接线前必须先补上。
    return sanitizeRendererValue(meta);
  };

  const inspectContainerTree = async (sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '请先索引资源，再检查容器。',
          sourceUri
        }]
      };
    }
    return inspectNativeContainerTree(file.absolutePath, { relativePath: file.relativePath });
  };

  const listContainerChildren = async (sourceUri: string, recursive?: boolean) => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          children: [],
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
          message: '请先索引资源，再列出容器条目。',
            sourceUri
          }]
        };
      }
      return loadContainerChildrenTable(deps, file, sourceUri, recursive === true);
    };

  /**
   * Paginated container-child entry access (hard constraint 17). BND4/script
   * containers may expose hundreds of entries; main materializes the entry
   * table once and serves bounded pages so the renderer never holds the whole
   * table. Children are projected to the renderer-safe DTO subset (no absolute
   * paths / diagnostics cross the bridge).
   */
  const listContainerChildrenPage = async (
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      recursive?: boolean
    ) => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
        const loaded = await loadContainerChildrenTable(deps, file, sourceUri, recursiveFlag);
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
    };

  const readContainerChild = async (childUri: string) => {
      const hash = childUri.indexOf('#');
      const containerUri = hash >= 0 ? childUri.slice(0, hash) : childUri;
      const file = deps.indexedFiles.find((item) => item.sourceUri === containerUri);
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
      return readNativeContainerChild(file.absolutePath, childUri, { relativePath: file.relativePath });
    };

  const roundTripContainer = async (sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
          message: '请先索引资源，再执行容器往返校验。',
          sourceUri
        }]
      };
    }
    return roundTripNativeContainer(file.absolutePath);
  };

  const validateContainer = async (sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        format: 'unknown' as const,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '请先索引资源，再验证容器。',
          sourceUri
        }]
      };
    }
    return validateNativeContainer(file.absolutePath);
  };

  const probeContainerCapabilities = async (sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
  };

  const scriptContainerEvidence = async (sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '请先索引资源，再获取脚本证据。',
          sourceUri
        }]
      };
    }
    if (!deps.activeSession) {
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
    const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
    // ROOT-07：证据构建可能解包到 staging——先 mkdir/realpath/boundary 验证。
    const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'SCRIPT_EVIDENCE_STAGING_PREPARE_FAILED');
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
  };

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
  const listScriptContainerEntriesPage = async (sourceUri: string, requestedPage: number, requestedPageSize: number) => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
      if (!deps.activeSession) {
        return failure('WORKSPACE_NOT_OPEN', '需要已打开的工作区才能分页读取脚本容器条目。');
      }
      let cached = scriptContainerEntriesCache.get(sourceUri);
      if (!cached) {
        // ROOT-07：只读枚举只传已存在并 verified 的 roots，不附加 staging。
        const roots = await verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
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
          const seen = new Set<string>();
          const entries: ScriptContainerEntryEvidence[] = rawEntries.map((entry) =>
            scriptEntryEvidenceFromBridge(entry, entry.uncompressedSize ?? 0, seen)
          );
          cached = {
            containerFormat: data.format ?? 'BND4',
            entryCount: data.entryCount ?? rawEntries.length,
            entries,
            classificationSummary: summarizeScriptClassifications(entries),
            entriesComplete: false,
            diagnostics: inventory.diagnostics
          };
        } else {
          const seen = new Set<string>();
          const entries: ScriptContainerEntryEvidence[] = nested.entries.map((entry) =>
            scriptEntryEvidenceFromBridge(
              entry,
              entry.uncompressedSize ?? entry.compressedSize ?? 0,
              seen
            )
          );
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
    };

  /**
   * 脚本条目源码级只读视图（SCRIPT-41）。
   *
   * 主进程用**真实字节**逐条判定：不看文件名、不接受证据采样的分类结论。
   * 明文条目返回按真实 encoding 解码的文本；字节码条目只返回判定证据，
   * 渲染器据此只展示明确的只读字节视图。childUri 在主进程内按
   * `containerUri#bnd/child/<entryName>` 构造（与 core readContainerChild
   * 的解析格式一致），渲染器不接触内层地址。
   */
  const readScriptEntryPlaintext = async (sourceUri: string, entryName: string): Promise<ScriptEntryPlaintextView> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
      if (!deps.activeSession) {
        return failure('WORKSPACE_NOT_OPEN', '需要已打开的工作区才能读取脚本条目明文。');
      }
      const childUri = `${sourceUri}#bnd/child/${encodeURIComponent(entryName)}`;
      const read = await readNativeContainerChild(file.absolutePath, childUri, { relativePath: file.relativePath });
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
    };

  /**
   * S16 脚本 IDE：源码视图（容器条目或独立脚本文件）。
   *
   * 明文条目按真实 encoding 返回文本；`\x1bLua` 字节码条目经 Bridge 内置
   * SoulForge HKS dialect 反编译为完整 Lua 文本（renderer 只收文本）；
   * 当前 dialect 的覆盖缺口/失败 → 结构化原因，不能把当前范围的未知语义
   * 伪装为完成。容器条目同时回传 child/container hash 供保存时做
   * 乐观并发校验。
   *
   * 容器子项以 **entryIndex** 为主键（renderer 手里只有打码后的名字，
   * `#bnd/child/<name>` 对不上任何真实子项），字节走 native 读链
   * readScriptContainerChildByIndex（snapshot-bnd4-child），**不**走
   * readContainerChild → readSyntheticBnd——合成 SFBN 只认 TS 合成 BND，
   * 真 luabnd 必失败（英文 not authoritative），反编译器吃不到字节。
   */
  const readScriptSource = async (sourceUri: string, entryName?: string, entryIndex?: number): Promise<ScriptSourceView> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      let logicalName = entryName ?? (file ? basename(file.relativePath) : 'script');
      const failure = (code: string, message: string, diagnostics?: StructuredDiagnostic[]): ScriptSourceView => ({
        ok: false,
        logicalName,
        kind: 'failure',
        writeSupported: false,
        diagnostics: diagnostics ?? [{ severity: 'error' as const, code, message, sourceUri }]
      });
      if (!file) {
        return failure('RESOURCE_NOT_INDEXED', '资源未索引，无法读取脚本源码。');
      }
      if (!deps.activeSession) {
        return failure('WORKSPACE_NOT_OPEN', '需要已打开的工作区才能读取脚本源码。');
      }
      let bytes: Uint8Array;
      let childHash: string | undefined;
      let containerHash: string | undefined;
      let resolvedEntryIndex: number | undefined = entryIndex;
      if (entryIndex !== undefined) {
        // 容器子项：按 BND4 entryIndex 用 native 读链取真实字节（13-A）。
        const roots = await verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
        if (roots.diagnostics.length > 0) {
          return failure('SCRIPT_SOURCE_READ_FAILED', '读取脚本容器条目失败。', roots.diagnostics);
        }
        const child = await readScriptContainerChildByIndex({
          containerPath: file.absolutePath,
          containerUri: sourceUri,
          entryIndex,
          allowedRoots: roots.allowedRoots,
          ...(deps.activeSession.layers.baseRoot
            ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
            : {})
        });
        if (!child.ok) {
          return failure('SCRIPT_SOURCE_READ_FAILED', '读取脚本容器条目失败。', child.diagnostics);
        }
        bytes = child.bytes;
        childHash = child.storedContentHash || undefined;
        // native 枚举给出的液化 basename 是权威名（renderer 传进来的名字只作回显）。
        logicalName = child.name;
        entryName = child.name;
        // 容器根 hash：真实 BND 的 inspectContainerTree 给不出（只认合成标记），
        // 取不到就留空，保存乐观并发校验以子项哈希为主。
        const tree = await inspectNativeContainerTree(file.absolutePath, { relativePath: file.relativePath });
        containerHash = tree.ok && tree.tree?.rootHash ? tree.tree.rootHash : undefined;
      } else {
        // 独立脚本文件（.hks/.lua）：有界整读。
        try {
          const fileStat = await stat(file.absolutePath);
          if (fileStat.size > 64 * 1024 * 1024) {
            return failure('SCRIPT_SOURCE_TOO_LARGE', '脚本文件超过 64 MiB 有界读取上限，未打开。');
          }
          bytes = new Uint8Array(await readFile(file.absolutePath));
        } catch (error) {
          return failure('SCRIPT_SOURCE_READ_FAILED', '读取脚本文件失败。', [{
            severity: 'error' as const,
            code: 'SCRIPT_SOURCE_READ_FAILED',
            message: error instanceof Error ? error.message : String(error),
            sourceUri
          }]);
        }
      }
      const verdict = classifyPlaintextBytes(bytes);
      const containerFields = resolvedEntryIndex !== undefined
        ? {
            containerUri: sourceUri,
            entryName,
            entryIndex: resolvedEntryIndex,
            ...(childHash !== undefined ? { childHash } : {}),
            ...(containerHash !== undefined ? { containerHash } : {})
          }
        : {};
      if (verdict.isPlaintext) {
        const contentEnd = bytes.length - verdict.trailingPaddingBytes;
        return {
          ok: true,
          logicalName,
          kind: 'plaintext',
          sourceText: decodePlaintext(bytes.subarray(0, contentEnd), verdict.detectedEncoding),
          encoding: verdict.detectedEncoding,
          decompiled: false,
          ...containerFields,
          writeSupported: true,
          diagnostics: verdict.diagnostics
        };
      }
      if (!verdict.luaBytecodeMagic) {
        return failure('SCRIPT_SOURCE_BYTECODE_UNSUPPORTED',
          '该条目是其他类型字节码（非 Lua），本版不提供反编译，只读。', [{
            severity: 'error' as const,
            code: 'SCRIPT_SOURCE_BYTECODE_UNSUPPORTED',
            message: `判定依据：${verdict.code ?? '非明文'}`,
            sourceUri
          }]);
      }
       // Lua 字节码：Bridge 内置 first-party HKS parser/IR，禁止外部 locator。
       const roots = await verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
       if (roots.diagnostics.length > 0) {
         return failure('SCRIPT_HKS_READ_FAILED', '读取 HKS 源码前的路径证明失败。', roots.diagnostics);
       }
       const native = await runBridge<{
         sourceText?: string;
         encoding?: string;
         dialect?: string;
         package?: string;
         revision?: string;
         sourceHash?: string;
         compiler?: { provenance?: string; package?: string; revision?: string };
         decompiler?: { provenance?: string; package?: string; revision?: string };
         functionCount?: number;
         coverage?: unknown;
       }>({
         command: 'read-hks-source',
         filePath: file.absolutePath,
         resourceUri: sourceUri,
         allowedRoots: roots.allowedRoots,
         workspaceSessionId: deps.activeSession.meta.workspaceId,
         commandOptions: resolvedEntryIndex !== undefined
           ? { contentBase64: Buffer.from(bytes).toString('base64') }
           : {},
         timeoutMs: 120_000,
         maxFrameBytes: 32 * 1024 * 1024
       });
       if (native.parseStatus === 'failed' || !native.data?.sourceText) {
         return failure('SCRIPT_HKS_READ_FAILED', 'SoulForge 内置 HKS dialect 未能生成完整源码。', [
           ...native.diagnostics.map((item) => ({
             severity: item.severity,
             code: item.code,
             message: item.message,
             sourceUri
           })),
           {
             severity: 'error' as const,
             code: 'SCRIPT_HKS_READ_FAILED',
             message: '当前 Sekiro 1.6.x HKS coverage gate 未通过，未返回伪造源码。',
             sourceUri
           }
         ]);
       }
       const semantic = native.data;
      return {
        ok: true,
        logicalName,
        kind: 'decompiled',
         sourceText: semantic.sourceText!,
        encoding: 'decompiled',
        decompiled: true,
        decompiler: 'SoulForge HKS IR（内置）',
        ...(semantic.compiler ? { compiler: { origin: 'first-party' as const, package: semantic.compiler.package ?? 'soulforge-sekiro-hks-schema', revision: semantic.compiler.revision ?? 'unknown' } } : {}),
        ...(semantic.decompiler ? { decompilerProvenance: { origin: 'first-party' as const, package: semantic.decompiler.package ?? 'soulforge-sekiro-hks-schema', revision: semantic.decompiler.revision ?? 'unknown' } } : {}),
        ...(semantic.dialect ? { dialect: semantic.dialect } : {}),
        ...(semantic.revision ? { revision: semantic.revision } : {}),
        ...(semantic.sourceHash ? { sourceHash: semantic.sourceHash } : {}),
        ...containerFields,
        writeSupported: true,
        diagnostics: native.diagnostics.map((item) => ({
          severity: item.severity,
          code: item.code,
          message: item.message,
          sourceUri
        }))
      };
    };
  const supersededRead = () => ({ok: false, cancelled: true, diagnostics: [{severity: 'info' as const, code: 'WORKSPACE_READ_SUPERSEDED', message: '工作区已更换，旧读取结果已丢弃。'}]});
  return Object.freeze({
    readRawRange: (...args: Parameters<typeof readRawRange>) => readLifetime.run(currentSession, true, () => readRawRange(...args), supersededRead),
    readRawMetadata: (...args: Parameters<typeof readRawMetadata>) => readLifetime.run(currentSession, true, () => readRawMetadata(...args), supersededRead),
    inspectContainerTree: (...args: Parameters<typeof inspectContainerTree>) => readLifetime.run(currentSession, true, () => inspectContainerTree(...args), supersededRead),
    listContainerChildren: (...args: Parameters<typeof listContainerChildren>) => readLifetime.run(currentSession, true, () => listContainerChildren(...args), supersededRead),
    listContainerChildrenPage: (...args: Parameters<typeof listContainerChildrenPage>) => readLifetime.run(currentSession, true, () => listContainerChildrenPage(...args), supersededRead),
    readContainerChild: (...args: Parameters<typeof readContainerChild>) => readLifetime.run(currentSession, true, () => readContainerChild(...args), supersededRead),
    roundTripContainer: (...args: Parameters<typeof roundTripContainer>) => readLifetime.run(currentSession, true, () => roundTripContainer(...args), supersededRead),
    validateContainer: (...args: Parameters<typeof validateContainer>) => readLifetime.run(currentSession, true, () => validateContainer(...args), supersededRead),
    probeContainerCapabilities: (...args: Parameters<typeof probeContainerCapabilities>) => readLifetime.run(currentSession, true, () => probeContainerCapabilities(...args), supersededRead),
    scriptContainerEvidence: (...args: Parameters<typeof scriptContainerEvidence>) => readLifetime.run(currentSession, true, () => scriptContainerEvidence(...args), supersededRead),
    listScriptContainerEntriesPage: (...args: Parameters<typeof listScriptContainerEntriesPage>) => readLifetime.run(currentSession, true, () => listScriptContainerEntriesPage(...args), supersededRead),
    readScriptEntryPlaintext: (...args: Parameters<typeof readScriptEntryPlaintext>) => readLifetime.run(currentSession, true, () => readScriptEntryPlaintext(...args), supersededRead),
    readScriptSource: (...args: Parameters<typeof readScriptSource>) => readLifetime.run(currentSession, true, () => readScriptSource(...args), supersededRead),
    clearCaches: clearRawResourceCaches
  });
}

export type RawResourceService = ReturnType<typeof createRawResourceService>;
