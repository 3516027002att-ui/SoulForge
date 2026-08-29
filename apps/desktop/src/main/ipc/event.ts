import { basename, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { IpcMainInvokeEvent } from 'electron';
import {
  applyNativeMutation,
  commitEmevdMutationViaBridge,
  fingerprintEmedfRegistry,
  listEmedfCompletionItems,
  openResourcePreview,
  readFullEmevdDocumentViaBridge,
  resolveEmevdRegistry,
  runBridge,
  submitEmevdDslPlanViaFourView,
  type EmedfCompletionItem,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type WorkspaceSession,
  type WriteConfirmationPort
} from '@soulforge/core';
import {
  EmevdEditorDocument,
  type Diagnostic,
  type IndexedFile
} from '@soulforge/shared';
import { prepareBridgeRoots, type BridgeRootSession, type PrepareBridgeRootsResult } from '../bridgeRoots.js';
import { commitEmevdFullDocument, EmevdAuthorityCache } from '../emevdAuthorityCache.js';
import { renderEmevdDarkScriptAsync } from '../emevdDarkScriptWorkerHost.js';
import { EmevdOpenSlots } from '../emevdOpenSlots.js';
import { EmevdSourceTokens } from '../emevdSourceTokens.js';
import { sanitizeDiagnostics, sanitizeRendererValue, type RendererSaveResult } from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { TrustedIpcHandle } from './registration.js';

/**
 * Authoritative full EMEVD editor documents keyed by sourceUri. Assembled in
 * main via paginated Bridge reads; the renderer only ever edits DSL text and
 * never holds these documents (hard constraint 18).
 */
const emevdFullDocuments = new EmevdAuthorityCache<EmevdEditorDocument>();

type EmevdFullReadInput = Parameters<typeof readFullEmevdDocumentViaBridge>[0] & {
  attachIdentity?: boolean;
  cachePolicy?: 'default' | 'bypass';
  signal?: AbortSignal;
  oodleRuntimeRoot?: string;
  useDocumentSession?: boolean;
};

type EmevdFullReadResult = Awaited<ReturnType<typeof readFullEmevdDocumentViaBridge>> & {
  cancelled?: boolean;
  authority?: string;
};

function readFullEmevdDocument(input: EmevdFullReadInput): Promise<EmevdFullReadResult> {
  // 工作树 core 有这些字段；node_modules junction 仍指向主仓旧类型。
  return readFullEmevdDocumentViaBridge(
    input as Parameters<typeof readFullEmevdDocumentViaBridge>[0]
  ) as Promise<EmevdFullReadResult>;
}

/**
 * 打开事件文档的在飞请求槽，**按 renderer 窗口分槽**。
 *
 * renderer 一次只显示一份事件文档，所以「同一个窗口的新打开请求到达」本身就等价于
 * 「那个窗口的上一份被放弃」—— 主进程不需要 renderer 再补发一条取消 IPC 就能判定
 * 这件事。放弃的那份要停掉的是：剩余分页读、outline 构建、写 emevdFullDocuments、
 * 以及整段反汇编。
 *
 * 之所以按 `WebContents.id` 分槽而不是用一个全局槽：全局槽下两个窗口会互相取消，
 * B 窗口打开任何事件文档都会把 A 窗口正在读的那份打断，而 A 那边看到的是自己毫无
 * 理由地静默丢弃。窗口之间没有任何「一次只显示一份」的关系，共享槽位是错的。
 *
 * 这个槽只覆盖 `resource.readEmevdFullDocument` 这条打开路径。submitEmevdDslPlan 里
 * 的提交前置读与写回后重读**不进槽**：它们是写链的一部分，被一次无关的打开取消掉
 * 会让提交半途而废。
 *
 * 能真正生效的前提是反汇编改成了分片异步（renderEmevdDarkScriptAsync）：主进程单
 * 线程，取消信号要被看见就得先有一次事件循环让出。同步反汇编那 75 ms 里新请求的
 * IPC 消息只能排队等着，等它跑完才轮到 abort，于是「取消」变成「取消不掉」。
 *
 * 槽位表实现连同它的三条并发不变式（按窗口隔离 / 到达顺序即建槽顺序 / dispose
 * 回收）抽到了 ./emevdOpenSlots，那里有对应的单元测试；埋在本文件里只能靠读代码
 * 确认，无法证伪。
 */
const activeEmevdOpens = new EmevdOpenSlots();
const emevdSourceTokens = new EmevdSourceTokens();

/**
 * 取消不是解析失败：`cancelled: true` 让 renderer 走静默丢弃分支，而不是把「用户
 * 切走了」渲染成「这个文件打不开」。诊断 severity 因此是 info，不是 error。
 *
 * 槽位不显式归还：留在槽里的已完成 controller 是无害的（abort 打在已结束的操作上
 * 是 no-op），同窗口下一次 begin 会替换它，省掉横跨整个 handler 的 try/finally。
 */
function emevdOpenCancelled(sourceUri: string) {
  return {
    ok: false as const,
    cancelled: true as const,
    sourceUri,
    diagnostics: [{
      severity: 'info' as const,
      code: 'EMEVD_LOAD_CANCELLED',
      message: '打开事件文档的请求已被更晚的打开请求取代。',
      sourceUri
    }]
  };
}

/** S18-F：反汇编文本缓存（sourceHash → 文本）。容量 4：common / common_func
 * 各一份加余量；写回后 hash 变自然落新 key，旧 key 按插入序淘汰。 */
const EMEVD_DISASSEMBLY_CACHE_CAPACITY = 4;
const emevdDisassemblyCache = new Map<string, {
  text: string;
  truncated: boolean;
  totalLines: number;
}>();

function cacheEmevdDisassembly(
  cacheKey: string | null,
  entry: { text: string; truncated: boolean; totalLines: number }
): void {
  if (!cacheKey) return;
  // 命中已有 key 时先删再插，保持 LRU 语义：刷新 common 不该把 common_func 挤掉。
  emevdDisassemblyCache.delete(cacheKey);
  emevdDisassemblyCache.set(cacheKey, entry);
  while (emevdDisassemblyCache.size > EMEVD_DISASSEMBLY_CACHE_CAPACITY) {
    const oldestKey = emevdDisassemblyCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    emevdDisassemblyCache.delete(oldestKey);
  }
}

/* ------------------------------------------------------------------ */
/*  EMEDF 自动定位（同步、只读、有界）。                                 */
/*                                                                    */
/*  R3/P4 裁定：事件源码必须是 DarkScript3 式（EMEDF 函数名），没 EMEDF 失败关闭。 */
/*  T4 查找顺序（grok 2026-08-15 拍死）：                              */
/*  1. SOULFORGE_EMEDF_PATH（显式覆盖）；                              */
/*  2. 固定候选：本机 DarkScript3 事件编辑器发布包的真实落地            */
/*     `<tools>/事件编辑器3.4.1/Resources/sekiro-common.emedf.json`；  */
/*  3. 已挂载 baseRoot 兄弟 `tools/<一层子目录>/Resources/`（DarkScript3 发布包  */
/*     常规落地形态）；                                                */
/*  4. 已挂载 overlay 根向上两级（workspace 层）的兄弟 `tools/<一层>/Resources/`； */
/*  5. SOULFORGE_SEKIRO_GAME_ROOT 同样扫兄弟 tools；                   */
/*  6. 有界用户目录（Desktop/Documents/Downloads）。                   */
/*  绝不递归整盘；找不到返回 null，由 resolveEmevdRegistry 失败关闭到 fixture。 */
/* ------------------------------------------------------------------ */

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

function locateUserEmedfSync(deps: EventIpcDeps): string | null {
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
  deps.pushToolsSubdirs(roots, deps.activeSession?.layers.baseRoot);
  // 4) 已挂载 overlay 根向上两级（workspace 层）的兄弟 tools/<一层>/Resources/。
  const overlay = deps.activeSession?.layers.overlayRoot?.trim();
  if (overlay) deps.pushToolsSubdirs(roots, dirname(dirname(overlay)));
  // 5) SOULFORGE_SEKIRO_GAME_ROOT 同样扫兄弟 tools。
  const gameRootEnv = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (gameRootEnv) deps.pushToolsSubdirs(roots, gameRootEnv);
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
function getEmevdRegistry(deps: EventIpcDeps): ReturnType<typeof resolveEmevdRegistry> {
  // 12-B：只有「imported」才算成功缓存。origin 为 fixture（首次查找时文件还不在 /
  // 路径暂时不可读 / 解析失败）不得缓存 —— 用户把文件放回或修好后再开同一份事件
  // 文档要立即生效，不能把失败钉死到进程退出。
  if (!cachedEmevdRegistry || cachedEmevdRegistry.origin !== 'imported') {
    cachedEmevdRegistry = resolveEmevdRegistry(locateUserEmedfSync(deps));
  }
  return cachedEmevdRegistry;
}

/** workspace 生命周期调用的 domain-owned reset（全清：文档 + 反汇编缓存）。 */
export function clearEmevdIpcCaches(): void {
  emevdFullDocuments.clear();
  emevdDisassemblyCache.clear();
}

/** remountBase 只清权威文档缓存（与拆分前该处的清理范围一致）。 */
export function resetEmevdDocuments(): void {
  emevdFullDocuments.clear();
}

/** 窗口销毁时回收该窗口的在飞打开与源码令牌。 */
export function disposeEmevdWindow(windowId: number): void {
  activeEmevdOpens.dispose(windowId);
  emevdSourceTokens.dropWindow(windowId);
}

export interface EventIpcDeps {
  handle: TrustedIpcHandle;
  /** 活动索引文件表：写回成功后按条目原地替换（与拆分前语义一致）。 */
  readonly indexedFiles: IndexedFile[];
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
  pushToolsSubdirs(roots: string[], gameRoot: string | undefined): void;
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  sessionCommitPort(
    session: WorkspaceSession,
    operationLog: OperationLogUtilityClient,
    storage: { backupBaseDir: string; recoveryDir: string }
  ): RawReplaceCommitPort;
  electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort;
  toSaveResultFromOutcome(outcome: NativeMutationOutcome, files: readonly IndexedFile[]): RendererSaveResult;
  refreshActiveIndexAfterNativeWrite(
    changedSources?: readonly string[],
    carrier?: { knowledgeRefresh?: unknown }
  ): Promise<unknown>;
}

export function registerEventIpcHandlers(deps: EventIpcDeps): void {
  /** Renderer-safe EMEVD envelope (no absolute paths). */
  deps.handle('resource.readEmevdDocument', async (_event, sourceUri: string) => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
      const readRoots = deps.activeSession
        ? await prepareBridgeRoots(
            deps.bridgeRootSession(deps.activeSession, deps.durableStoragePaths(deps.activeSession.meta.workspaceId)),
            'read'
          )
        : null;
      if (readRoots && !readRoots.ok) {
        return {
          ok: false,
          diagnostics: [deps.bridgeRootsDiagnostic('BRIDGE_ROOT_MISSING', readRoots)]
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
        timeoutMs: 120_000,
        // S15：遗留通道补上与生产打开（readEmevdFullDocument）同一句 —— KRAK
        // 事件挂上原版后必须能解，不能再当「KRAK 打不开」的根因。
        ...(deps.activeSession?.layers.baseRoot
          ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
          : {})
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
  deps.handle(
    'resource.applyEmevdMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: Record<string, unknown>
    ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
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
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      // ROOT-07：stage 前先 mkdir → realpath → boundary check 并注册 allowed
      // roots；回调同步返回已验证集合（stageBridgeOutput 的 mkdir 幂等）。
      const roots = await prepareBridgeRoots(deps.bridgeRootSession(deps.activeSession, storage), 'stage');
      if (!roots.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [deps.bridgeRootsDiagnostic('EMEVD_STAGING_PREPARE_FAILED', roots)]
        };
      }
      const bridgeMutation = {
        kind: String(mutation.kind ?? mutation.mutation ?? ''),
        ...mutation
      } as Parameters<typeof commitEmevdMutationViaBridge>[0]['mutation'];
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
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
        confirm: deps.electronConfirmationPort(event),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) {
        const refreshed = await openResourcePreview({
          file,
          inspectNative: true,
          parseStructured: true,
          ...(deps.activeSession.layers.baseRoot ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot } : {})
        });
        const index = deps.indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
        if (index >= 0) deps.indexedFiles[index] = refreshed.file;
        await deps.refreshActiveIndexAfterNativeWrite([sourceUri], outcome.result);
      }
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    }
  );

  /**
   * 取消本窗口在飞的事件文档打开。
   *
   * 与「下一次打开请求隐式取消上一份」互补：切走域、关编辑器时不会再有打开请求，
   * 没有这条通道那次读就会跑完整个反汇编，产物直接丢掉。返回 `cancelled` 表示
   * 当时确实有一份在飞的读被中止 —— 没有也不是错误（用户可能已经读完了），所以
   * `ok` 恒真，两者分开报。
   */
  deps.handle('resource.cancelEmevdFullDocument', async (event) => {
    const cancelled = activeEmevdOpens.cancel(event.sender.id);
    emevdSourceTokens.dropWindow(event.sender.id);
    return { ok: true, cancelled };
  });

  deps.handle(
    'resource.readEmevdSourceSlice',
    async (event, token: string, fromLine: number, lineCount: number) => {
      if (typeof token !== 'string' || token.length === 0) {
        return {
          ok: false,
          code: 'EMEVD_SOURCE_TOKEN_EXPIRED',
          message: '源码切片令牌无效。'
        };
      }
      return emevdSourceTokens.readSlice(
        token,
        event.sender.id,
        Number(fromLine),
        Number(lineCount)
      );
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
  deps.handle(
    'resource.readEmevdFullDocument',
    async (event, sourceUri: string, documentInstanceId: string, loadFullDslTemplate?: boolean) => {
      // 建槽必须在任何 await 之前：见 EmevdOpenSlots.begin 的注释。放在这里意味着连
      // 「文件没索引到」「没工作区」这些早退分支也会先建槽，那是无害的——它们同步
      // 返回，槽里留下一个已经用不上的 controller，等同窗口下一次打开时被替换掉。
      // 反过来把建槽推到校验之后，就又回到「谁先建槽」由 await 时序决定的老问题。
      const openController = activeEmevdOpens.begin(event.sender.id, sourceUri);
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
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
      if (!deps.activeSession) {
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
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      // ROOT-07：完整文档读取不需要落盘（Bridge 原生解 DCX），但 staging root
      // 仍注册以便后续 submit 复用。
      const roots = await prepareBridgeRoots(deps.bridgeRootSession(deps.activeSession, storage), 'stage');
      if (!roots.ok) {
        return {
          ok: false,
          sourceUri,
          diagnostics: [deps.bridgeRootsDiagnostic('EMEVD_STAGING_PREPARE_FAILED', roots)]
        };
      }
      // 槽已在 handler 开头建好（openController）。这里补一次取消检查：root 准备
      // 期间同窗口可能已经来了更新的请求，那这次读根本不该发出去。
      if (openController.signal.aborted) return emevdOpenCancelled(sourceUri);
      const full = await readFullEmevdDocument({
        filePath: file.absolutePath,
        allowedRoots: [...roots.allowedRoots],
        resourceUri: sourceUri,
        registry: getEmevdRegistry(deps).registry,
        signal: openController.signal,
        ...(documentInstanceId ? { documentInstanceId } : {}),
        // pageSize 不再显式指定：走 DEFAULT_PAGE_SIZE（8192，避免单页 33k 指令 JSON 长帧）。
        ...(deps.activeSession.layers.baseRoot ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot } : {}),
        timeoutMs: 120_000
      });
      // 取消分支必须在失败分支之前：两者都是 ok:false，先判失败会把取消报成打开失败。
      if (full.cancelled) return emevdOpenCancelled(sourceUri);
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
      // 权威缓存必须在反汇编成功（或确认无需反汇编）之后才写入。
      // 渲染期间被取消时，被放弃的文档不得提前成为 submitEmevdDslPlan 的权威。
      if (openController.signal.aborted) return emevdOpenCancelled(sourceUri);
      const registryResolution = getEmevdRegistry(deps);
      // R3/P4 裁定：反汇编必须是 DarkScript3 式（EMEDF 函数名）；没 EMEDF 失败
      // 关闭——不再下发 hash 伪源码（旧 renderEmevdPatchDslBounded 输出已从
      // production 入口移除，底层 dslCompiler/typed 写链保留）。
      // 3.1：首包只回 outline + 前 400 行 + opaque source token，全文不进
      // 第一次 IPC。3.3：反汇编在 worker_threads（renderEmevdDarkScriptAsync）。
      // loadFullDslTemplate 参数保留以兼容既有 IPC 契约与 core smoke，不再
      // 把 70K 行一次塞回 renderer。
      let dslTemplate: string | null = null;
      let sourcePrefix: string | null = null;
      let sourceToken: string | null = null;
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
        const disassemblyCacheKey = full.sourceHash
          ? `${full.sourceHash}::${fingerprintEmedfRegistry(registryResolution.registry)}`
          : null;
        const cachedDisassembly = disassemblyCacheKey
          ? emevdDisassemblyCache.get(disassemblyCacheKey)
          : undefined;
        let fullText: string | null = null;
        if (cachedDisassembly) {
          fullText = cachedDisassembly.text;
          dslTemplateTruncated = cachedDisassembly.truncated;
          dslTemplateTotalLines = cachedDisassembly.totalLines;
          sourceStyle = 'dark-script';
        } else {
          const bounded = await renderEmevdDarkScriptAsync(
            full.document,
            registryResolution.registry,
            { signal: openController.signal }
          );
          if (bounded.cancelled) return emevdOpenCancelled(sourceUri);
          fullText = bounded.text;
          dslTemplateTruncated = bounded.truncated;
          dslTemplateTotalLines = bounded.totalLines;
          sourceStyle = 'dark-script';
          cacheEmevdDisassembly(disassemblyCacheKey, {
            text: bounded.text,
            truncated: bounded.truncated,
            totalLines: bounded.totalLines
          });
        }
        if (fullText !== null) {
          const stored = emevdSourceTokens.put(event.sender.id, sourceUri, fullText, {
            truncated: dslTemplateTruncated
          });
          sourceToken = stored.token;
          sourcePrefix = stored.prefix;
          dslTemplateTotalLines = stored.totalLines;
        }
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
      if (openController.signal.aborted) {
        if (sourceToken) emevdSourceTokens.dropToken(sourceToken);
        return emevdOpenCancelled(sourceUri);
      }
      if (!commitEmevdFullDocument(
        emevdFullDocuments,
        sourceUri,
        full.document,
        openController.signal,
        full.sourceHash ?? null
      )) {
        if (sourceToken) emevdSourceTokens.dropToken(sourceToken);
        return emevdOpenCancelled(sourceUri);
      }
      activeEmevdOpens.finish(event.sender.id, sourceUri, openController);
      return {
        ok: true,
        sourceUri,
        documentInstanceId,
        revision: full.document.revision,
        eventCount: full.document.events.length,
        instructionCount: full.instructionTotal,
        dslTemplate,
        sourcePrefix,
        sourceToken,
        sourceTotalLines: dslTemplateTotalLines,
        sourceStyle,
        dslTemplateTruncated,
        dslTemplateTotalLines,
        sourceHash: full.sourceHash ?? null,
        sourceFormat: full.sourceFormat ?? null,
        outerFileHash: full.outerFileHash ?? null,
        // renderer 的状态行要 authority；以前它是另发一次 readEmevdDocument 才拿到的，
        // 那次读除了这一个字符串没有别的用处（见 App.loadEmevd）。
        authority: full.authority ?? null,
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
  deps.handle('resource.readEmedfCompletionCatalog', async (): Promise<{
    ok: boolean;
    origin: 'imported' | 'fixture';
    items: EmedfCompletionItem[];
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }> => {
    const resolution = getEmevdRegistry(deps);
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
  deps.handle(
    'resource.submitEmevdDslPlan',
    // S14：mode 决定编译前端 —— 'dark-script'（$Event 源码）或 'patch'（旧 hash DSL）。
    async (event, sourceUri: string, sourceText: string, mode: 'patch' | 'dark-script' = 'patch'): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
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
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
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
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      // ROOT-07：DSL 提交链需要 staging（Bridge 暂存写）——先验证再注册。
      const roots = await prepareBridgeRoots(deps.bridgeRootSession(deps.activeSession, storage), 'stage');
      if (!roots.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [deps.bridgeRootsDiagnostic('EMEVD_STAGING_PREPARE_FAILED', roots)]
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const registry = getEmevdRegistry(deps).registry;
      const full = await readFullEmevdDocument({
        filePath: file.absolutePath,
        allowedRoots: [...roots.allowedRoots],
        resourceUri: sourceUri,
        registry,
        ...(document.documentInstanceId !== undefined ? { documentInstanceId: document.documentInstanceId } : {}),
        // 不写死 pageSize：走默认 8192。bypass 的第一页会重解析，后续页走
        // documentSession 同快照切片，不会按页把 33k 指令再解一遍。
        // 提交前置读必须绕过 Bridge 文档缓存：这一读产出 expectedDocumentHash /
        // expectedOuterFileHash，是写回的前置条件，要的是此刻磁盘上的真实内容。
        cachePolicy: 'bypass' as const,
        timeoutMs: 120_000,
        attachIdentity: true
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
          mode
        },
        document: fresh,
        registry,
        sourcePath: targetPath,
        expectedDocumentHash: full.sourceHash ?? '',
        // 修改目标始终是 outer source resource：.dcx 时 file_replace 前置按 outer 字节比对。
        ...(full.outerFileHash !== undefined ? { expectedOuterFileHash: full.outerFileHash } : {}),
        allowedRoots: [...roots.allowedRoots],
        workspaceId: deps.activeSession.meta.workspaceId,
        workspaceRoot: deps.activeSession.layers.overlayRoot,
        stagingRoot: storage.stagingRoot,
        ...(deps.activeSession ? { session: deps.activeSession } : {}),
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
      const refreshed = await readFullEmevdDocument({
        filePath: file.absolutePath,
        allowedRoots: [...roots.allowedRoots],
        resourceUri: sourceUri,
        registry,
        ...(document.documentInstanceId !== undefined ? { documentInstanceId: document.documentInstanceId } : {}),
        // 同上：不写死更小的 pageSize；bypass 后续页靠 session，不再整份重解析。
        // 写回后重读同样绕过缓存：刚提交的文件在缓存里可能留着提交前那一份，
        // 而这一读的产物要装进 emevdFullDocuments 当权威文档。
        cachePolicy: 'bypass' as const,
        timeoutMs: 120_000,
        attachIdentity: true
      });
      if (refreshed.ok && refreshed.document) {
        emevdFullDocuments.replace(sourceUri, refreshed.document, refreshed.sourceHash ?? null);
      }
      const preview = await openResourcePreview({
        file,
        inspectNative: true,
        parseStructured: true,
        ...(deps.activeSession.layers.baseRoot ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot } : {})
      });
      const index = deps.indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
      if (index >= 0) deps.indexedFiles[index] = preview.file;
      const response: RendererSaveResult = {
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
      await deps.refreshActiveIndexAfterNativeWrite([sourceUri], response);
      return response;
    }
  );
}
