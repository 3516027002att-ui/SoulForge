import type { IpcMainInvokeEvent } from 'electron';
import type { TrustedIpcHandle } from './registration.js';
import type { ResourceWriteConfirmation } from '../services/resourceWriteContext.js';
import { createResourceReadService, type ResourceReadServiceDeps } from '../services/resourceReadService.js';
import { createResourceMutationService, type ResourceMutationServiceDeps } from '../services/resourceMutationService.js';
import { createScriptSourceService, type ScriptSourceServiceDeps } from '../services/scriptSourceService.js';

export interface ResourceIpcDeps extends ResourceReadServiceDeps, ResourceMutationServiceDeps, ScriptSourceServiceDeps {
  handle: TrustedIpcHandle;
  requestWriteConfirmation(input: Parameters<ResourceWriteConfirmation>[0] & { event?: IpcMainInvokeEvent }): ReturnType<ResourceWriteConfirmation>;
  getActiveWorkspaceSessionId(): string | null;
  getActiveSessionLayers?(): { overlayRoot?: string; baseRoot?: string | null };
}

export function registerResourceIpcHandlers(deps: ResourceIpcDeps): void {
  const read = createResourceReadService({
    getIndexedFiles: () => deps.getIndexedFiles(),
    getActiveIndex: () => deps.getActiveIndex(),
    getActiveSession: () => deps.getActiveSession(),
    withForegroundPriority: <T>(fn: () => Promise<T>) => deps.withForegroundPriority(fn),
  });
  const mutation = createResourceMutationService({
    getActiveWorkspaceSessionGeneration: () => deps.getActiveWorkspaceSessionGeneration(),
    getIndexedFiles: () => deps.getIndexedFiles(),
    replaceIndexedFile: (sourceUri, file) => deps.replaceIndexedFile(sourceUri, file),
    getActiveSession: () => deps.getActiveSession(),
    durableStoragePaths: (workspaceId) => deps.durableStoragePaths(workspaceId),
    ensureActiveOperationLog: (session) => deps.ensureActiveOperationLog(session),
    rejectNonSekiroNativeWrite: (sourceUri, file) => deps.rejectNonSekiroNativeWrite(sourceUri, file),
    refreshActiveIndexAfterNativeWrite: (changedSources, carrier) => deps.refreshActiveIndexAfterNativeWrite(changedSources, carrier),
    bumpPathSourceGenerationForUris: (uris) => deps.bumpPathSourceGenerationForUris(uris),
    clearResourceRelatedCaches: () => deps.clearResourceRelatedCaches(),
  });
  const script = createScriptSourceService({
    getActiveWorkspaceSessionGeneration: () => deps.getActiveWorkspaceSessionGeneration(),
    getIndexedFiles: () => deps.getIndexedFiles(),
    replaceIndexedFile: (sourceUri, file) => deps.replaceIndexedFile(sourceUri, file),
    getActiveSession: () => deps.getActiveSession(),
    durableStoragePaths: (workspaceId) => deps.durableStoragePaths(workspaceId),
    ensureActiveOperationLog: (session) => deps.ensureActiveOperationLog(session),
    verifiedReadRoots: (session, fallback) => deps.verifiedReadRoots(session, fallback),
    verifiedStageRoots: (session, storage, code) => deps.verifiedStageRoots(session, storage, code),
    sessionCommitPort: (session, operationLog, storage, options) => deps.sessionCommitPort(session, operationLog, storage, options),
    toSaveResultFromOutcome: (outcome, files) => deps.toSaveResultFromOutcome(outcome, files),
    rejectNonSekiroNativeWrite: (sourceUri, file) => deps.rejectNonSekiroNativeWrite(sourceUri, file),
    refreshActiveIndexAfterNativeWrite: (changedSources, carrier) => deps.refreshActiveIndexAfterNativeWrite(changedSources, carrier),
    clearResourceRelatedCaches: () => deps.clearResourceRelatedCaches(),
  });
  deps.handle('resource.replaceContainerChild', (event, ...args: Tail<Parameters<typeof mutation.replaceContainerChild>>) =>
    mutation.replaceContainerChild(input => deps.requestWriteConfirmation({ ...input, event }), ...args));
  deps.handle('resource.saveScriptSource', (event, ...args: Tail<Parameters<typeof script.saveScriptSource>>) =>
    script.saveScriptSource(input => deps.requestWriteConfirmation({ ...input, event }), ...args));
  deps.handle('resource.preview', (_event, ...args: Parameters<typeof read.preview>) => read.preview(...args));
  deps.handle('resource.saveText', (event, ...args: Tail<Parameters<typeof mutation.saveText>>) =>
    mutation.saveText(input => deps.requestWriteConfirmation({ ...input, event }), ...args));
  deps.handle('resource.search', (_event, ...args: Parameters<typeof read.search>) => read.search(...args));
}

type Tail<Args extends unknown[]> = Args extends [unknown, ...infer Rest] ? Rest : never;
