import { basename, dirname } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import {
  applyNativeMutation,
  commitFmgMutationViaBridge,
  normalizePageWindow,
  readFmgDocumentViaBridge,
  runBridge,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type WorkspaceSession
} from '@soulforge/core';
import {
  FMG_PAGE_SIZE,
  logicalFmgTableName,
  type Diagnostic,
  type FmgEntryPage,
  type IndexedFile
} from '@soulforge/shared';
import { prepareBridgeRoots, type BridgeRootSession, type PrepareBridgeRootsResult } from '../bridgeRoots.js';
import { sanitizeRendererValue, type RendererSaveResult } from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { TrustedIpcHandle } from './registration.js';

/* ------------------------------------------------------------------ */
/*  Text/FMG domain caches (hard constraint 17)                        */
/*  Main holds the complete document; the renderer only ever receives  */
/*  bounded pages via resource.readFmgPage / resource.readFmgTablePage.*/
/*  Each cache is invalidated on mutation commit so the next page      */
/*  fetch re-reads the fresh file.                                     */
/* ------------------------------------------------------------------ */

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

/** workspace 生命周期调用的 domain-owned reset（与拆分前根级清理范围一致）。 */
export function clearTextIpcCaches(): void {
  fmgPageCache.clear();
  fmgTableCache.clear();
  textTableRefs.clear();
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
    /** S30：非空文本条数（「N 槽 · M 有字」的 M）；旧 Bridge 不报时缺省。 */
    filledCount?: number;
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
    /** S30：非空文本条数；Bridge 未上报时缺省（renderer 回落「N 条」）。 */
    filledCount?: number;
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

export interface TextIpcDeps {
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
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  sha256FileNow(filePath: string): Promise<string>;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  sessionCommitPort(
    session: WorkspaceSession,
    operationLog: OperationLogUtilityClient,
    storage: { backupBaseDir: string; recoveryDir: string }
  ): RawReplaceCommitPort;
  toSaveResultFromOutcome(outcome: NativeMutationOutcome, files: readonly IndexedFile[]): RendererSaveResult;
  refreshActiveIndexAfterNativeWrite(
    changedSources?: readonly string[],
    carrier?: { knowledgeRefresh?: unknown }
  ): Promise<unknown>;
}

export function registerTextIpcHandlers(deps: TextIpcDeps): void {
  deps.handle('resource.readFmgDocument', async (_event, sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
    const readRoots = deps.activeSession
      ? await prepareBridgeRoots(
          deps.bridgeRootSession(deps.activeSession, deps.durableStoragePaths(deps.activeSession.meta.workspaceId)),
          'read'
        )
      : null;
    if (readRoots && !readRoots.ok) {
      return {
        ok: false,
        sourceUri,
        relativePath: file.relativePath,
        data: null,
        diagnostics: [deps.bridgeRootsDiagnostic('BRIDGE_ROOT_MISSING', readRoots)]
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
  deps.handle(
    'resource.readFmgPage',
    async (
      _event,
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      query?: string
    ) => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
        const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
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
  deps.handle('resource.readTextCatalog', async (): Promise<TextCatalogResponse> => {
    const fail = (diagnostics: Diagnostic[]): TextCatalogResponse => ({
      ok: false,
      libraryId: 'game-text',
      title: 'Text',
      languages: [],
      diagnostics
    });
    if (!deps.activeSession) {
      return fail([{
        severity: 'error',
        code: 'WORKSPACE_SESSION_REQUIRED',
        message: '请先打开工作区，再读取文本目录。'
      }]);
    }
    const roots = await deps.verifiedReadRoots(deps.activeSession, deps.activeSession.layers.overlayRoot);
    if (roots.diagnostics.length > 0) return fail(roots.diagnostics);

    // R2 裁定：文本目录默认只列出简体中文（zhocn），英语/日语整包延期至 V0.6。
    // 过滤时需要同时接纳 `/zhocn/` 与 Windows 分隔符 `\zhocn\`，且大小写不敏感
    // （真实索引路径由主进程生成，分隔符随平台，段名大小写不随平台）。
    const isZhocnPath = (relativePath: string): boolean =>
      /[\\/]zhocn[\\/]/i.test(relativePath);
    const allMsgFiles = deps.indexedFiles.filter(
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
      // S13：Bridge 的表名可能是原构建机绝对路径（N:\GR\…\Title_Items.fmg）。
      // 出 renderer 前投影为逻辑表名（basename、去 .fmg、同名加序号）；renderer
      // 永不看到「[本机路径已隐藏]」当表名。tableId（stableId）仍是路由标识。
      const seenTableNames = new Set<string>();
      const tables = catalog.tables.map((table) => {
        const entryName = logicalFmgTableName(table.entryName, table.entryIndex ?? 0, seenTableNames);
        const ref: TextTableRef = {
          tableId: table.stableId,
          languageId,
          containerId,
          containerKind,
          sourceUri: file.sourceUri,
          entryIndex: table.entryIndex,
          entryName
        };
        textTableRefs.set(ref.tableId, ref);
        return {
          tableId: table.stableId,
          entryName,
          entryCount: table.entryCount,
          ...(table.filledCount !== undefined ? { filledCount: table.filledCount } : {}),
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
  deps.handle(
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
      const file = deps.indexedFiles.find((item) => item.sourceUri === ref.sourceUri);
      if (!file) {
        return failure('TEXT_TABLE_SOURCE_MISSING', `文本表 ${ref.entryName} 的源资源未索引。`);
      }
      let cached = fmgTableCache.get(tableId);
      if (!cached) {
        const roots = await deps.verifiedReadRoots(deps.activeSession, dirname(file.absolutePath));
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

  deps.handle(
    'resource.applyFmgMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: { kind: 'upsert' | 'delete' | 'add'; id: number; text?: string },
      tableId?: string
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
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
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
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
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      // ROOT-07：stage 前 mkdir → realpath → boundary check；回调同步返回
      // 已验证集合（stageBridgeOutput 的 mkdir 幂等）。
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'FMG_STAGING_PREPARE_FAILED');
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
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      // S29：能打开就能写。renderer 可能没带回 hash（此前它有权据此拒写），
      // main 在写时现算兜底。现算值只用于并发保护凭据，head 真漂移（别人改过）
      // 仍会被写链的 hash 比较拒绝；「从来没算过」不是拒写理由。
      const expectedHashNow = expectedHash || file.sha256 || await deps.sha256FileNow(file.absolutePath);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedHashNow,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'fmg',
        stagingFileName: `${basename(file.relativePath)}.mut.fmg`,
        stageWrite: (context) => commitFmgMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHashNow,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation,
          ...(entryIndex !== undefined ? { entryIndex } : {})
        }),
        title: `FMG mutation ${mutation.kind} ${mutation.id}`,
        confirmActionLabel: '提交 FMG 变更'
      }, {
        // S29：日常 FMG 写入不弹「高风险确认」；备份/回滚仍经 Patch Engine。
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) {
        // 容器写会更新整容器 DCX hash → 同容器内所有表缓存都失效，逐表清；
        // 裸 fmg 的页缓存照旧清。
        fmgPageCache.delete(sourceUri);
        for (const [cachedTableId, ref] of textTableRefs) {
          if (ref.sourceUri === sourceUri) fmgTableCache.delete(cachedTableId);
        }
        await deps.refreshActiveIndexAfterNativeWrite([sourceUri], outcome.result);
      }
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    }
  );
}
