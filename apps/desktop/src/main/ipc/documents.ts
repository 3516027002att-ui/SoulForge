import { createHash } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import {
  buildNativeDocumentLocator,
  EditorDocumentStore,
  runBridge,
  type EditorDocumentDataSource,
  type EditorMutationApplyPort,
  type WorkspaceSession
} from '@soulforge/core';
import {
  EDITOR_DOCUMENT_IPC_CHANNELS,
  decodeApplyEditorMutationRequest,
  decodeOpenEditorDocumentRequest,
  decodePageEditorDocumentRequest,
  decodeReadEditorContentRequest,
  type ApplyEditorMutationValue,
  type BridgeDocumentLocatorValue,
  type EditorContentValue,
  type EditorDocumentErrorCode,
  type EditorDocumentPageValue,
  type EditorDocumentResult,
  type IndexedFile,
  type OpenEditorDocumentValue
} from '@soulforge/shared';
import { prepareBridgeRoots, type BridgeRootSession } from '../bridgeRoots.js';
import { toRendererEditorDocumentResult } from '../rendererDto.js';
import type { TrustedIpcHandle } from './registration.js';

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

/** workspace 生命周期（打开/重挂载）调用的 domain-owned reset。 */
export function resetEditorDocumentStore(): void {
  editorDocumentStore = null;
}

function editorDocumentFailure(
  code: EditorDocumentErrorCode,
  retryable: boolean
): EditorDocumentResult<never> {
  return { ok: false, code, retryable };
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

export interface DocumentIpcDeps {
  handle: TrustedIpcHandle;
  readonly activeSession: WorkspaceSession | null;
  readonly activeWorkspaceSessionId: string | null;
  readonly indexedFiles: readonly IndexedFile[];
  durableStoragePaths(workspaceId: string): {
    root: string;
    backupBaseDir: string;
    recoveryDir: string;
    stagingRoot: string;
  };
  bridgeRootSession(session: WorkspaceSession, storage: { root: string }): BridgeRootSession;
}

export function registerDocumentIpcHandlers(deps: DocumentIpcDeps): void {
  /**
   * ownerKey 绑定「会话 + 窗口」：另一窗口（webContents）即使猜中 handle 也
   * 得到 owner-mismatch；重新扫描工作区（activeWorkspaceSessionId 更换）后
   * 旧 handle 全部失效——这正是 cross-sender rejection 的实现点。
   */
  function deriveDocumentOwnerKey(event: IpcMainInvokeEvent): string {
    return createHash('sha256')
      .update(`${deps.activeWorkspaceSessionId ?? 'no-session'}:${event.sender.id}`)
      .digest('hex');
  }

  /**
   * §14.4 document.open：renderer 发送逻辑引用，main 从当前活动索引解析出
   * 资源 → Bridge probe 确认格式栈 → 组装 main-only locator → 打开
   * owner-bound 文档。open 是六通道中唯一做 native 探针的；page/readContent/
   * apply 只认 opaque handle。「引用与活动 Catalog 精确匹配」在 CAT-05 落地
   * 前用索引(sourceUri + 域)近似，如实标注。
   */
  deps.handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.open,
    async (event, rawRequest: unknown): Promise<EditorDocumentResult<OpenEditorDocumentValue>> => {
      const request = decodeOpenEditorDocumentRequest(rawRequest);
      const ownerKey = deriveDocumentOwnerKey(event);
      if (!deps.activeSession || !deps.activeWorkspaceSessionId) {
        return editorDocumentFailure('runtime-blocked', true);
      }
      const file = deps.indexedFiles.find((item) => item.sourceUri === request.document.resourceId);
      if (!file) return editorDocumentFailure('not-found', false);
      const allowedKinds = DOMAIN_RESOURCE_KINDS[request.document.domain] ?? [];
      if (!allowedKinds.includes(file.resourceKind)) return editorDocumentFailure('not-found', false);

      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      // ROOT-07：locator probe 可能解包 DCX 到 staging——先 mkdir/realpath/
      // boundary 验证再注册，绝不把不存在的目录交给 Bridge。
      const roots = await prepareBridgeRoots(deps.bridgeRootSession(deps.activeSession, storage), 'stage');
      if (!roots.ok) return editorDocumentFailure('runtime-blocked', true);
      const probe = await runBridge<BridgeDocumentLocatorValue>({
        command: 'probe-document-locator',
        filePath: file.absolutePath,
        resourceUri: file.sourceUri,
        allowedRoots: [...roots.allowedRoots],
        ...(deps.activeSession.layers.baseRoot ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot } : {}),
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

  deps.handle(
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

  deps.handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.page,
    async (event, rawRequest: unknown): Promise<EditorDocumentResult<EditorDocumentPageValue>> => {
      const request = decodePageEditorDocumentRequest(rawRequest);
      return toRendererEditorDocumentResult(
        await ensureEditorDocumentStore().page(deriveDocumentOwnerKey(event), request)
      );
    }
  );

  deps.handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.readContent,
    async (event, rawRequest: unknown): Promise<EditorDocumentResult<EditorContentValue>> => {
      const request = decodeReadEditorContentRequest(rawRequest);
      return toRendererEditorDocumentResult(
        await ensureEditorDocumentStore().readContent(deriveDocumentOwnerKey(event), request)
      );
    }
  );

  deps.handle(
    EDITOR_DOCUMENT_IPC_CHANNELS.apply,
    async (event, rawRequest: unknown): Promise<EditorDocumentResult<ApplyEditorMutationValue>> => {
      const request = decodeApplyEditorMutationRequest(rawRequest);
      return toRendererEditorDocumentResult(
        await ensureEditorDocumentStore().apply(deriveDocumentOwnerKey(event), request)
      );
    }
  );

  deps.handle(
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
}
