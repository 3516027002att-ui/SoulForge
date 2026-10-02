import { buildNativeDocumentLocator, EditorDocumentStore, runBridge as nativeRunBridge, type EditorDocumentDataSource, type EditorMutationApplyPort, type WorkspaceSession } from '@soulforge/core';
import { decodeApplyEditorMutationRequest, decodeOpenEditorDocumentRequest, decodePageEditorDocumentRequest, decodeReadEditorContentRequest, type ApplyEditorMutationValue, type BridgeDocumentLocatorValue, type EditorContentValue, type EditorDocumentErrorCode, type EditorDocumentPageValue, type EditorDocumentResult, type IndexedFile, type OpenEditorDocumentValue } from '@soulforge/shared';
import { prepareBridgeRoots as nativePrepareBridgeRoots, type BridgeRootSession } from '../bridgeRoots.js';
import { toRendererEditorDocumentResult } from '../rendererDto.js';
import { WorkspaceReadLifetime } from '../ipc/workspaceReadLifetime.js';
/* ------------------------------------------------------------------ */
/*  §14.4 DocumentStore IPC（DOCSTORE-04）                             */
/*  renderer 只发逻辑引用；ownerKey 由 main 从 trusted webContents 与 */
/*  workspace session 派生，renderer 永远不能传入；locator 由 main     */
/*  probe 组装（含 outerSourceUri），永不出 main。                     */
/* ------------------------------------------------------------------ */
const readLifetime = new WorkspaceReadLifetime();
const prepareBridgeRoots = readLifetime.guardCall(nativePrepareBridgeRoots);
const runBridge = readLifetime.guardCall(nativeRunBridge);
let editorDocumentStore: EditorDocumentStore | null = null;
/**
 * 惰性创建文档仓库。分页数据源与写链是骨架：由后续卡（PARAM-10B、TEXT-20B
 * 等）接入真实实现；未接入的查询/写入如实返回 capability-blocked /
 * mutation-rejected，不假装成功。
 */
function ensureEditorDocumentStore(): EditorDocumentStore {
    readLifetime.assertCurrent();
    if (editorDocumentStore)
        return editorDocumentStore;
    const skeletonDataSource: EditorDocumentDataSource = {
        loadPage: async () => ({ items: null, nextCursor: null, totalKnown: null }),
        readContent: async () => null
    };
    const skeletonApplyPort: EditorMutationApplyPort = {
        apply: async () => ({ kind: 'rejected', code: 'WRITE_CHAIN_NOT_CONNECTED' })
    };
    editorDocumentStore = new EditorDocumentStore({
        ttlMs: 30 * 60000,
        dataSource: skeletonDataSource,
        applyPort: skeletonApplyPort
    });
    return editorDocumentStore;
}
/** workspace 生命周期（打开/重挂载）调用的 domain-owned reset。 */
export function resetEditorDocumentStore(): void {
    readLifetime.invalidate();
    editorDocumentStore = null;
}
function editorDocumentFailure(code: EditorDocumentErrorCode, retryable: boolean): EditorDocumentResult<never> {
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
export interface DocumentServiceDeps {
    getActiveSession(): WorkspaceSession | null;
    getActiveWorkspaceSessionId(): string | null;
    getIndexedFiles(): readonly IndexedFile[];
    durableStoragePaths(workspaceId: string): {
        root: string;
        backupBaseDir: string;
        recoveryDir: string;
        stagingRoot: string;
    };
    bridgeRootSession(session: WorkspaceSession, storage: {
        root: string;
    }): BridgeRootSession;
}
/** Main-derived owner scope; contains no sender or registration authority. */
export type DocumentOwner = () => string;
export function createDocumentService(input: DocumentServiceDeps) {
    const ports = Object.freeze({ ...input });
    const deps = Object.freeze({
        get activeSession() { return ports.getActiveSession(); },
        get activeWorkspaceSessionId() { return ports.getActiveWorkspaceSessionId(); },
        get indexedFiles() { return ports.getIndexedFiles(); },
        durableStoragePaths: ports.durableStoragePaths,
        bridgeRootSession: ports.bridgeRootSession
    });
    const run = <Result>(readOnly: boolean, operation: () => Promise<Result>) => readLifetime.run(() => deps.activeSession, readOnly, operation, () => ({ ok: false as const, cancelled: true, code: 'runtime-blocked' as const, retryable: true, diagnostics: [{ severity: 'info' as const, code: 'WORKSPACE_READ_SUPERSEDED', message: '工作区已更换，旧读取结果已丢弃。' }] }));
    const open = async (owner: DocumentOwner, rawRequest: unknown): Promise<EditorDocumentResult<OpenEditorDocumentValue>> => {
        const request = decodeOpenEditorDocumentRequest(rawRequest);
        const ownerKey = owner();
        if (!deps.activeSession || !deps.activeWorkspaceSessionId) {
            return editorDocumentFailure('runtime-blocked', true);
        }
        const file = deps.indexedFiles.find((item) => item.sourceUri === request.document.resourceId);
        if (!file)
            return editorDocumentFailure('not-found', false);
        const allowedKinds = DOMAIN_RESOURCE_KINDS[request.document.domain] ?? [];
        if (!allowedKinds.includes(file.resourceKind))
            return editorDocumentFailure('not-found', false);
        const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
        // ROOT-07：locator probe 可能解包 DCX 到 staging——先 mkdir/realpath/
        // boundary 验证再注册，绝不把不存在的目录交给 Bridge。
        const roots = await prepareBridgeRoots(deps.bridgeRootSession(deps.activeSession, storage), 'stage');
        if (!roots.ok)
            return editorDocumentFailure('runtime-blocked', true);
        const probe = await runBridge<BridgeDocumentLocatorValue>({
            command: 'probe-document-locator',
            filePath: file.absolutePath,
            resourceUri: file.sourceUri,
            allowedRoots: [...roots.allowedRoots],
            ...(deps.activeSession.layers.baseRoot ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot } : {}),
            timeoutMs: 60000
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
        if (outcome.kind === 'blocked')
            return editorDocumentFailure('runtime-blocked', true);
        if (outcome.kind !== 'confirmed')
            return editorDocumentFailure('native-open-failed', false);
        return toRendererEditorDocumentResult(await ensureEditorDocumentStore().open(ownerKey, outcome.locator));
    };
    const get = async (owner: DocumentOwner, documentHandle: string): Promise<EditorDocumentResult<OpenEditorDocumentValue>> => {
        if (typeof documentHandle !== 'string' || documentHandle.length === 0) {
            return editorDocumentFailure('invalid-request', false);
        }
        return toRendererEditorDocumentResult(await ensureEditorDocumentStore().get(owner(), documentHandle));
    };
    const page = async (owner: DocumentOwner, rawRequest: unknown): Promise<EditorDocumentResult<EditorDocumentPageValue>> => {
        const request = decodePageEditorDocumentRequest(rawRequest);
        return toRendererEditorDocumentResult(await ensureEditorDocumentStore().page(owner(), request));
    };
    const readContent = async (owner: DocumentOwner, rawRequest: unknown): Promise<EditorDocumentResult<EditorContentValue>> => {
        const request = decodeReadEditorContentRequest(rawRequest);
        return toRendererEditorDocumentResult(await ensureEditorDocumentStore().readContent(owner(), request));
    };
    const apply = async (owner: DocumentOwner, rawRequest: unknown): Promise<EditorDocumentResult<ApplyEditorMutationValue>> => {
        const request = decodeApplyEditorMutationRequest(rawRequest);
        return toRendererEditorDocumentResult(await ensureEditorDocumentStore().apply(owner(), request));
    };
    const close = async (owner: DocumentOwner, documentHandle: string): Promise<EditorDocumentResult<{
        closed: true;
    }>> => {
        if (typeof documentHandle !== 'string' || documentHandle.length === 0) {
            return editorDocumentFailure('invalid-request', false);
        }
        return toRendererEditorDocumentResult(await ensureEditorDocumentStore().close(owner(), documentHandle));
    };
    return Object.freeze({ open: (owner: DocumentOwner, rawRequest: unknown) => run(true, () => open(owner, rawRequest)),
        get: (owner: DocumentOwner, documentHandle: string) => run(true, () => get(owner, documentHandle)),
        page: (owner: DocumentOwner, rawRequest: unknown) => run(true, () => page(owner, rawRequest)),
        readContent: (owner: DocumentOwner, rawRequest: unknown) => run(true, () => readContent(owner, rawRequest)),
        apply: (owner: DocumentOwner, rawRequest: unknown) => run(false, () => apply(owner, rawRequest)),
        close: (owner: DocumentOwner, documentHandle: string) => run(false, () => close(owner, documentHandle)) });
}
export type DocumentService = ReturnType<typeof createDocumentService>;
