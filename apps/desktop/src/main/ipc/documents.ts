import { createHash } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import type { WorkspaceSession } from '@soulforge/core';
import { EDITOR_DOCUMENT_IPC_CHANNELS, type IndexedFile } from '@soulforge/shared';
import type { BridgeRootSession } from '../bridgeRoots.js';
import type { TrustedIpcHandle } from './registration.js';
import { createDocumentService } from '../services/documentService.js';
export { resetEditorDocumentStore } from '../services/documentService.js';
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
    bridgeRootSession(session: WorkspaceSession, storage: {
        root: string;
    }): BridgeRootSession;
}
export function registerDocumentIpcHandlers(deps: DocumentIpcDeps): void {
    const service = createDocumentService({ getActiveSession: () => deps.activeSession, getActiveWorkspaceSessionId: () => deps.activeWorkspaceSessionId, getIndexedFiles: () => deps.indexedFiles, durableStoragePaths: deps.durableStoragePaths, bridgeRootSession: deps.bridgeRootSession });
    function deriveDocumentOwnerKey(event: IpcMainInvokeEvent): string {
        return createHash('sha256')
            .update(`${deps.activeWorkspaceSessionId ?? 'no-session'}:${event.sender.id}`)
            .digest('hex');
    }
    deps.handle(EDITOR_DOCUMENT_IPC_CHANNELS.open, (event, rawRequest: unknown) => service.open(() => deriveDocumentOwnerKey(event), rawRequest));
    deps.handle(EDITOR_DOCUMENT_IPC_CHANNELS.get, (event, documentHandle: string) => service.get(() => deriveDocumentOwnerKey(event), documentHandle));
    deps.handle(EDITOR_DOCUMENT_IPC_CHANNELS.page, (event, rawRequest: unknown) => service.page(() => deriveDocumentOwnerKey(event), rawRequest));
    deps.handle(EDITOR_DOCUMENT_IPC_CHANNELS.readContent, (event, rawRequest: unknown) => service.readContent(() => deriveDocumentOwnerKey(event), rawRequest));
    deps.handle(EDITOR_DOCUMENT_IPC_CHANNELS.apply, (event, rawRequest: unknown) => service.apply(() => deriveDocumentOwnerKey(event), rawRequest));
    deps.handle(EDITOR_DOCUMENT_IPC_CHANNELS.close, (event, documentHandle: string) => service.close(() => deriveDocumentOwnerKey(event), documentHandle));
}
