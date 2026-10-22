import type { IpcMainInvokeEvent } from 'electron';
import type { WriteConfirmationPort } from '@soulforge/core';
import type { TrustedIpcHandle } from './registration.js';
import { createEventService, type EventService, type EventServiceDeps } from '../services/eventService.js';

export interface EventIpcDeps extends EventServiceDeps {
  handle: TrustedIpcHandle;
  electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort;
}

let workspaceEventService: EventService | undefined;
export function clearEmevdIpcCaches(): void { workspaceEventService?.clearCaches(); }
export function resetEmevdDocuments(): void { workspaceEventService?.resetDocuments(); }
export function disposeEmevdWindow(windowId: number): void { workspaceEventService?.disposeWindow(windowId); }

/** Literal trusted transport registration; window and confirmation authority
 * enter only through this adapter, never through renderer-owned arguments. */
export function registerEventIpcHandlers(deps: EventIpcDeps): void {
  workspaceEventService?.clearCaches();
  const service = createEventService({
    get indexedFiles() { return deps.indexedFiles; },
    get activeSession() { return deps.activeSession; },
    replaceIndexedFile: (sourceUri, file) => deps.replaceIndexedFile(sourceUri, file),
    durableStoragePaths: workspaceId => deps.durableStoragePaths(workspaceId),
    bridgeRootSession: (session, storage) => deps.bridgeRootSession(session, storage),
    bridgeRootsDiagnostic: (code, result) => deps.bridgeRootsDiagnostic(code, result),
    rejectNonSekiroNativeWrite: (sourceUri, file) => deps.rejectNonSekiroNativeWrite(sourceUri, file),
    ensureActiveOperationLog: session => deps.ensureActiveOperationLog(session),
    sessionCommitPort: (session, operationLog, storage, options) => deps.sessionCommitPort(session, operationLog, storage, options),
    toSaveResultFromOutcome: (outcome, files) => deps.toSaveResultFromOutcome(outcome, files),
    refreshActiveIndexAfterNativeWrite: (sources, carrier) => deps.refreshActiveIndexAfterNativeWrite(sources, carrier)
  });
  workspaceEventService = service;
  deps.handle('resource.readEmevdDocument', (_event, ...args: Parameters<EventService['readEmevdDocument']>) => service.readEmevdDocument(...args));
  deps.handle('resource.applyEmevdMutation', (event, ...args: Tail<Parameters<EventService['applyEmevdMutation']>>) => service.applyEmevdMutation(() => deps.electronConfirmationPort(event), ...args));
  deps.handle('resource.cancelEmevdFullDocument', event => service.cancelEmevdFullDocument(event.sender.id));
  deps.handle('resource.readEmevdSourceSlice', (event, ...args: Tail<Parameters<EventService['readEmevdSourceSlice']>>) => service.readEmevdSourceSlice(event.sender.id, ...args));
  deps.handle('resource.readEmevdFullDocument', (event, ...args: Tail<Parameters<EventService['readEmevdFullDocument']>>) => service.readEmevdFullDocument(event.sender.id, ...args));
  deps.handle('resource.readEmedfCompletionCatalog', () => service.readEmedfCompletionCatalog());
  deps.handle('resource.submitEmevdDslPlan', (_event, ...args: Parameters<EventService['submitEmevdDslPlan']>) => service.submitEmevdDslPlan(...args));
}

type Tail<Args extends unknown[]> = Args extends [unknown, ...infer Rest] ? Rest : never;
