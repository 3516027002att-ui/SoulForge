import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  analyzePlaintextLineEndings,
  buildScriptContainerEvidence,
  classifyPlaintextBytes,
  classifyScriptEntry,
  decodePlaintext,
  inspectContainerTree,
  listContainerChildren,
  locateDsLuaDecompilerSync,
  magicLabel,
  normalizePageWindow,
  probeContainerCapabilityOptions,
  readContainerChild,
  readRawResourceMetadata,
  readRawResourceRange,
  resolveResourceCapabilities,
  roundTripContainer,
  runBridge,
  sanitizeEntryName,
  validateContainer,
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
  prepareBridgeRoots,
  type BridgeRootSession,
  type PrepareBridgeRootsResult
} from '../bridgeRoots.js';
import { sanitizeDiagnostics, sanitizeRendererValue } from '../rendererDto.js';
import type { NativeDcxEnvelopeLike } from './bridgeEnvelopes.js';
import type { TrustedIpcHandle } from './registration.js';

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
  deps: RawIpcDeps,
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
}): Promise<ReadScriptContainerChildResult | { ok: false; diagnostics: StructuredDiagnostic[] }> {
  const dcx = await runBridge<ScriptDcxDocumentLike>({
    command: 'read-dcx-document',
    filePath: input.containerPath,
    resourceUri: input.containerUri,
    allowedRoots: input.allowedRoots,
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
export function clearRawIpcCaches(): void {
  containerChildrenCache.clear();
  scriptContainerEntriesCache.clear();
}

/** 反编译器命中来源的人类可读标识（renderer 展示用，不含路径）。 */
function decompilerLabel(origin: 'explicit' | 'v1.1.5' | 'tools-scan' | 'legacy' | 'none'): string {
  switch (origin) {
    case 'explicit':
      return 'DSLuaDecompiler（显式路径）';
    case 'v1.1.5':
      return 'DSLuaDecompiler v1.1.5';
    case 'tools-scan':
      return 'DSLuaDecompiler（tools 扫描）';
    case 'legacy':
      return 'DSLuaDecompiler（hks解码目录）';
    default:
      return 'DSLuaDecompiler';
  }
}

/**
 * S16 脚本 IDE：HKS 字节码反编译（main 进程 spawn 本机 DSLuaDecompiler.exe）。
 *
 * `DSLuaDecompiler <file> --console` 把 Lua 字节码反编译到 stdout；发行目标
 * net7，本机可能只有 .NET 6/8，故注入 DOTNET_ROLL_FORWARD=LatestMajor。
 * stdout 有界（8 MiB）、超时 kill；一切失败结构化返回，不抛给 renderer。
 */
export interface DsLuaDecompileRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  spawnFailure: string | null;
  truncated: boolean;
}

export async function runDsLuaDecompilerCapture(
  exePath: string,
  hksPath: string,
  timeoutMs: number
): Promise<DsLuaDecompileRunResult> {
  return await new Promise((resolveResult) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const stdoutLimit = 8 * 1024 * 1024;
    const settle = (result: DsLuaDecompileRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    const current = (exitCode: number | null, extra: Partial<DsLuaDecompileRunResult>): DsLuaDecompileRunResult => ({
      ok: exitCode === 0 && !truncated,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      timedOut: false,
      exitCode,
      spawnFailure: null,
      truncated,
      ...extra
    });
    timer = setTimeout(() => {
      try { child?.kill(); } catch { /* 超时终止，尽力而为 */ }
      settle(current(null, { timedOut: true }));
    }, timeoutMs);
    try {
      child = spawn(exePath, [hksPath, '--console'], {
        cwd: dirname(exePath),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DOTNET_ROLL_FORWARD: 'LatestMajor' }
      });
    } catch (error) {
      settle({
        ok: false,
        stdout: '',
        stderr: String(error),
        timedOut: false,
        exitCode: null,
        spawnFailure: error instanceof Error ? error.message : String(error),
        truncated: false
      });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = stdoutLimit - stdout.length;
      if (bytes.length > remaining) truncated = true;
      if (remaining > 0) stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = stdoutLimit - stderr.length;
      if (bytes.length > remaining) truncated = true;
      if (remaining > 0) stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
    });
    child.once('error', (error) => {
      settle({
        ok: false,
        stdout: '',
        stderr: '',
        timedOut: false,
        exitCode: null,
        spawnFailure: error.message,
        truncated: false
      });
    });
    child.once('close', (code) => {
      settle(current(code, {}));
    });
  });
}

export interface RawIpcDeps {
  handle: TrustedIpcHandle;
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

export function registerRawIpcHandlers(deps: RawIpcDeps): void {
  deps.handle(
    'resource.readRawRange',
    async (_event, sourceUri: string, offset: number, length: number) => {
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
            message: 'Resource must be indexed before raw range read.',
            sourceUri
          }]
        };
      }
      return readRawResourceRange(file, offset, length);
    }
  );

  deps.handle('resource.readRawMetadata', async (_event, sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    const meta = await readRawResourceMetadata(file, { computeHash: file.size <= 32 * 1024 * 1024 });
    // 必须脱敏：RawResourceMetadata 含 absolutePath（rawRead.ts:16），而
    // verify-desktop-security-runtime.mjs 把 absolutePath 列为泄漏键。此前这里
    // 直接 return 原对象，等于把本机绝对路径送进 renderer——同文件其余 handler
    // （:675/:904/:933/:948）都走了 sanitizeRendererValue，只有这一条漏了。
    // 该 channel 此前 renderer 零引用，所以泄漏一直没被触发；接线前必须先补上。
    return sanitizeRendererValue(meta);
  });

  deps.handle('resource.inspectContainerTree', async (_event, sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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

  deps.handle(
    'resource.listContainerChildren',
    async (_event, sourceUri: string, recursive?: boolean) => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
  deps.handle(
    'resource.listContainerChildrenPage',
    async (
      _event,
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
    }
  );

  deps.handle(
    'resource.readContainerChild',
    async (_event, childUri: string) => {
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
      return readContainerChild(file.absolutePath, childUri, { relativePath: file.relativePath });
    }
  );

  deps.handle('resource.roundTripContainer', async (_event, sourceUri: string) => {
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
          message: 'Resource must be indexed before container roundtrip.',
          sourceUri
        }]
      };
    }
    return roundTripContainer(file.absolutePath);
  });

  deps.handle('resource.validateContainer', async (_event, sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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

  deps.handle('resource.probeContainerCapabilities', async (_event, sourceUri: string) => {
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
  });

  deps.handle('resource.scriptContainerEvidence', async (_event, sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
  deps.handle(
    'resource.listScriptContainerEntriesPage',
    async (_event, sourceUri: string, requestedPage: number, requestedPageSize: number) => {
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
        const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
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
  deps.handle(
    'resource.readScriptEntryPlaintext',
    async (_event, sourceUri: string, entryName: string): Promise<ScriptEntryPlaintextView> => {
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

  /**
   * S16 脚本 IDE：源码视图（容器条目或独立脚本文件）。
   *
   * 明文条目按真实 encoding 返回文本；`\x1bLua` 字节码条目调本机
   * DSLuaDecompiler 反编译为 Lua 文本（main spawn，renderer 只收文本）；
   * 反编译不可用/失败/其他字节码 → kind='failure' 结构化原因，绝不把字节码
   * 呈现为可编辑源码。容器条目同时回传 child/container hash 供保存时做
   * 乐观并发校验。
   *
   * 容器子项以 **entryIndex** 为主键（renderer 手里只有打码后的名字，
   * `#bnd/child/<name>` 对不上任何真实子项），字节走 native 读链
   * readScriptContainerChildByIndex（snapshot-bnd4-child），**不**走
   * readContainerChild → readSyntheticBnd——合成 SFBN 只认 TS 合成 BND，
   * 真 luabnd 必失败（英文 not authoritative），反编译器吃不到字节。
   */
  deps.handle(
    'resource.readScriptSource',
    async (_event, sourceUri: string, entryName?: string, entryIndex?: number): Promise<ScriptSourceView> => {
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
        const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
        if (roots.diagnostics.length > 0) {
          return failure('SCRIPT_SOURCE_READ_FAILED', '读取脚本容器条目失败。', roots.diagnostics);
        }
        const child = await readScriptContainerChildByIndex({
          containerPath: file.absolutePath,
          containerUri: sourceUri,
          entryIndex,
          allowedRoots: roots.allowedRoots
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
        const tree = await inspectContainerTree(file.absolutePath, { relativePath: file.relativePath });
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
      // Lua 字节码：本机 DSLuaDecompiler 反编译（只读定位，找不到给结构化失败）。
      const probe = locateDsLuaDecompilerSync({
        baseRoot: deps.activeSession.layers.baseRoot ?? null,
        overlayRoot: deps.activeSession.layers.overlayRoot ?? null,
        gameRootEnv: process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() ?? null
      });
      if (!probe.exePath) {
        return failure('SCRIPT_DECOMPILER_NOT_FOUND',
          '本机找不到 DSLuaDecompiler：该脚本是 Lua 字节码，需要反编译器才能编辑。请把 DSLuaDecompiler.exe 放到 Sekiro 兄弟 tools 目录，或设置 SOULFORGE_DSLUADECOMPILER_PATH。');
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'SCRIPT_DECOMPILE_STAGING_FAILED');
      if (stage.diagnostics.length > 0) {
        return failure('SCRIPT_DECOMPILE_STAGING_FAILED', '无法准备反编译暂存目录。', stage.diagnostics);
      }
      const stageRoot = stage.writableRoots[0];
      if (!stageRoot) {
        return failure('SCRIPT_DECOMPILE_STAGING_FAILED', '反编译暂存目录未就绪。', stage.diagnostics);
      }
      const tmpPath = join(stageRoot, `s16-decompile-${randomUUID()}.hks`);
      await writeFile(tmpPath, Buffer.from(bytes));
      const decompiled = await runDsLuaDecompilerCapture(probe.exePath, tmpPath, 120_000);
      await unlink(tmpPath).catch(() => { /* 暂存清理尽力而为 */ });
      if (!decompiled.ok) {
        if (decompiled.timedOut) {
          return failure('SCRIPT_DECOMPILE_TIMED_OUT', '反编译超时（120 秒），请稍后重试。');
        }
        if (decompiled.spawnFailure) {
          return failure('SCRIPT_DECOMPILE_SPAWN_FAILED', `反编译器无法启动：${decompiled.spawnFailure}`);
        }
        if (decompiled.truncated) {
          return failure('SCRIPT_DECOMPILE_OUTPUT_TRUNCATED', '反编译输出超过 8 MiB 有界上限，未返回文本。');
        }
        const tail = decompiled.stderr.trim().split(/\r?\n/).slice(-5).join('\n');
        return failure('SCRIPT_DECOMPILE_FAILED',
          `反编译失败（退出码 ${decompiled.exitCode ?? '未知'}）${tail ? `：${tail}` : ''}`);
      }
      return {
        ok: true,
        logicalName,
        kind: 'decompiled',
        sourceText: decompiled.stdout,
        // S34：反编译文本的 encoding 标记为 'decompiled'；写回时按 UTF-8 明文落盘
        // （saveScriptSource 的 writeEncoding 映射把非 utf8-bom/shift_jis 归一到 utf8）。
        encoding: 'decompiled',
        decompiled: true,
        decompiler: decompilerLabel(probe.origin),
        ...containerFields,
        writeSupported: true,
        diagnostics: []
      };
    }
  );
}
