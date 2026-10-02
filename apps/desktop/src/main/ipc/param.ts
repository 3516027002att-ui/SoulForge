import { dialog, type IpcMainInvokeEvent } from 'electron';
import type { WriteConfirmationPort } from '@soulforge/core';
import { PARAM_SESSION_IPC_CHANNELS } from '@soulforge/shared';
import { createParamService, type ParamService, type ParamServiceDeps } from '../services/paramService.js';
import type { TrustedIpcHandle } from './registration.js';
import { WorkspaceReadLifetime } from './workspaceReadLifetime.js';

export interface ParamIpcDeps extends Omit<ParamServiceDeps, 'readLifetime' | 'dialog'> {
  handle: TrustedIpcHandle;
  electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort;
}
type ConfirmedArgs<Call> = Call extends (confirmation: () => WriteConfirmationPort, ...args: infer Args) => unknown ? Args : never;
const readLifetime = new WorkspaceReadLifetime();
let activeService: ParamService | null = null;

export function clearParamIpcCaches(): void {
  if (activeService) activeService.clearCaches();
  else readLifetime.invalidate();
}
export function getForensicsCounters(): Record<string, number> {
  return activeService?.getForensicsCounters() ?? {};
}

/** Only this adapter sees Electron events or channel names. The registrar is
 * already trusted; read scopes keep superseded projections from crossing it. */
export function registerParamIpcHandlers(deps: ParamIpcDeps): void {
  const currentSession = () => deps.getActiveSession ? deps.getActiveSession() : deps.activeSession;
  const handle = readLifetime.register(deps.handle, currentSession);
  const service = createParamService({
    get indexedFiles() { return deps.indexedFiles; },
    get activeSession() { return deps.activeSession; },
    get activeWorkspaceSessionId() { return deps.activeWorkspaceSessionId; },
    getIndexedFiles: () => deps.getIndexedFiles ? deps.getIndexedFiles() : deps.indexedFiles,
    getActiveSession: currentSession,
    getActiveWorkspaceSessionId: () => deps.getActiveWorkspaceSessionId ? deps.getActiveWorkspaceSessionId() : deps.activeWorkspaceSessionId,
    durableStoragePaths: (...args) => deps.durableStoragePaths(...args),
    bridgeRootSession: (...args) => deps.bridgeRootSession(...args),
    bridgeRootsDiagnostic: (...args) => deps.bridgeRootsDiagnostic(...args),
    verifiedReadRoots: (...args) => deps.verifiedReadRoots(...args),
    verifiedStageRoots: (...args) => deps.verifiedStageRoots(...args),
    rejectNonSekiroNativeWrite: (...args) => deps.rejectNonSekiroNativeWrite(...args),
    ensureActiveOperationLog: (...args) => deps.ensureActiveOperationLog(...args),
    sessionCommitPort: (...args) => deps.sessionCommitPort(...args),
    toSaveResultFromOutcome: (...args) => deps.toSaveResultFromOutcome(...args),
    refreshActiveIndexAfterNativeWrite: (...args) => deps.refreshActiveIndexAfterNativeWrite(...args),
    sha256FileNow: (...args) => deps.sha256FileNow(...args),
    readLifetime,
    dialog: {
      showSaveDialog: options => dialog.showSaveDialog(options),
      showOpenDialog: options => dialog.showOpenDialog(options)
    }
  });
  activeService = service;
  handle(PARAM_SESSION_IPC_CHANNELS.open, (_event, ...args: Parameters<ParamService['openParamSession']>) => service.openParamSession(...args));
  handle(PARAM_SESSION_IPC_CHANNELS.readIndexPage, (_event, ...args: Parameters<ParamService['readParamIndexPage']>) => service.readParamIndexPage(...args));
  handle(PARAM_SESSION_IPC_CHANNELS.readRows, (_event, ...args: Parameters<ParamService['readParamRows']>) => service.readParamRows(...args));
  handle('param.metadata.trustState', (_event, ...args: Parameters<ParamService['trustState']>) => service.trustState(...args));
  handle('param.metadata.setTrust', (_event, ...args: Parameters<ParamService['setTrust']>) => service.setTrust(...args));
  handle('resource.readParamDocument', (_event, ...args: Parameters<ParamService['readParamDocument']>) => service.readParamDocument(...args));
  handle('resource.readParamPage', (_event, ...args: Parameters<ParamService['readParamPage']>) => service.readParamPage(...args));
  handle('resource.applyParamMutation', (event, ...args: ConfirmedArgs<ParamService['applyParamMutation']>) =>
    service.applyParamMutation(() => deps.electronConfirmationPort(event), ...args));
  handle('resource.applyParamFieldMutation', (event, ...args: ConfirmedArgs<ParamService['applyParamFieldMutation']>) =>
    service.applyParamFieldMutation(() => deps.electronConfirmationPort(event), ...args));
  handle('resource.applyContainerParamFieldMutation', (_event, ...args: Parameters<ParamService['applyContainerParamFieldMutation']>) => service.applyContainerParamFieldMutation(...args));
  handle('resource.applyContainerParamRowNameMutation', (_event, ...args: Parameters<ParamService['applyContainerParamRowNameMutation']>) => service.applyContainerParamRowNameMutation(...args));
  handle('resource.applyContainerParamRowMutations', (_event, ...args: Parameters<ParamService['applyContainerParamRowMutations']>) => service.applyContainerParamRowMutations(...args));
  handle('param.exportRowsCsv', (_event, ...args: Parameters<ParamService['exportRowsCsv']>) => service.exportRowsCsv(...args));
  handle('param.exportNamesCsv', (_event, ...args: Parameters<ParamService['exportNamesCsv']>) => service.exportNamesCsv(...args));
  handle('param.importNamesCsv', (_event, ...args: Parameters<ParamService['importNamesCsv']>) => service.importNamesCsv(...args));
  handle('param.importRowsCsv', (_event, ...args: Parameters<ParamService['importRowsCsv']>) => service.importRowsCsv(...args));
  handle('resource.listContainerParams', (_event, ...args: Parameters<ParamService['listContainerParams']>) => service.listContainerParams(...args));
  handle('resource.readContainerParamPage', (_event, ...args: Parameters<ParamService['readContainerParamPage']>) => service.readContainerParamPage(...args));
  handle('resource.readContainerParamRowIndex', (_event, ...args: Parameters<ParamService['readContainerParamRowIndex']>) => service.readContainerParamRowIndex(...args));
}
