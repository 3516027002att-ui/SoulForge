import { Me3RuntimeAdapter, type WorkspaceSession } from '@soulforge/core';
import { sanitizeRendererValue } from '../rendererDto.js';
export interface WorkspaceRuntimeServiceDeps {
    getWorkspaceSession(): WorkspaceSession | null;
    getWorkspaceSessionId(): string | null;
    localApplicationDataRoot(): string;
    createGateway(localDataRoot: string): ConstructorParameters<typeof Me3RuntimeAdapter>[0]['gateway'];
}
export function createWorkspaceRuntimeService(input: WorkspaceRuntimeServiceDeps) {
    const deps = Object.freeze({ ...input });
    let runtimeAdapter: Me3RuntimeAdapter | null = null;
    let runtimeGateway: ReturnType<WorkspaceRuntimeServiceDeps['createGateway']> | null = null;
    function ensureRuntimeAdapter(): Me3RuntimeAdapter {
        if (!runtimeAdapter) {
            runtimeGateway = deps.createGateway(deps.localApplicationDataRoot());
            runtimeAdapter = new Me3RuntimeAdapter({ gateway: runtimeGateway, versionPolicy: { policyId: 'soulforge.me3-v0_12_1', supportedVersions: ['0.12.1'] } });
        }
        return runtimeAdapter;
    }
    const detectMe3 = async () => {
        const adapter = new Me3RuntimeAdapter({ gateway: deps.createGateway(deps.localApplicationDataRoot()), versionPolicy: { policyId: 'soulforge.me3-v0_12_1', supportedVersions: ['0.12.1'] } });
        return await adapter.detect({ timeoutMs: 5000 });
    };
    const prepareMe3Profile = async () => {
        const activeSession = deps.getWorkspaceSession();
        const activeWorkspaceSessionId = deps.getWorkspaceSessionId();
        if (!activeSession || !activeWorkspaceSessionId) {
            return { ok: false, status: 'failed' as const, authority: 'unverified' as const, diagnostics: [{ severity: 'error' as const, code: 'RUNTIME_NO_WORKSPACE', message: '需要已打开的工作区才能准备 me3 配置文件。' }] };
        }
        const adapter = ensureRuntimeAdapter();
        const result = await adapter.prepareProfile({ workspaceSessionId: activeWorkspaceSessionId, game: 'sekiro' }, { timeoutMs: 30000 });
        return sanitizeRendererValue(result);
    };
    const launchMe3 = async (profileId: string) => {
        const activeWorkspaceSessionId = deps.getWorkspaceSessionId();
        if (!activeWorkspaceSessionId) {
            return { ok: false, status: 'failed' as const, authority: 'unverified' as const, diagnostics: [{ severity: 'error' as const, code: 'RUNTIME_NO_WORKSPACE', message: '需要已打开的工作区才能启动 me3。' }] };
        }
        const adapter = ensureRuntimeAdapter();
        const result = await adapter.launch({ profile: { profileId, workspaceSessionId: activeWorkspaceSessionId, game: 'sekiro', profileVersion: 'v1', contentSha256: '' } }, { timeoutMs: 15000 });
        return sanitizeRendererValue(result);
    };
    const terminateMe3 = async (sessionId: string) => {
        const adapter = ensureRuntimeAdapter();
        const result = await adapter.terminate({ sessionId, game: 'sekiro', state: 'running', startedAt: new Date().toISOString(), diagnostics: [] }, { timeoutMs: 10000 });
        return sanitizeRendererValue(result);
    };
    return Object.freeze({ detectMe3, prepareMe3Profile, launchMe3, terminateMe3 });
}
export type WorkspaceRuntimeService = ReturnType<typeof createWorkspaceRuntimeService>;
