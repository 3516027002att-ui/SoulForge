import type { TrustedIpcHandle } from './registration.js';
import { createTextService, type TextService, type TextServiceDeps } from '../services/textService.js';
export type { TextCatalogResponse } from '../../ipc/publicTypes.js';
export { clearTextServiceCaches as clearTextIpcCaches } from '../services/textService.js';

export interface TextIpcDeps extends TextServiceDeps { handle: TrustedIpcHandle; }

/** Trusted literal channel registration; TEXT business and read lifetime are application-owned. */
export function registerTextIpcHandlers(deps: TextIpcDeps): void {
  const service = createTextService({
    get indexedFiles() { return deps.indexedFiles; },
    get activeSession() { return deps.activeSession; },
    durableStoragePaths: deps.durableStoragePaths,
    bridgeRootSession: deps.bridgeRootSession,
    bridgeRootsDiagnostic: deps.bridgeRootsDiagnostic,
    verifiedReadRoots: deps.verifiedReadRoots,
    verifiedStageRoots: deps.verifiedStageRoots,
    rejectNonSekiroNativeWrite: deps.rejectNonSekiroNativeWrite,
    sha256FileNow: deps.sha256FileNow,
    ensureActiveOperationLog: deps.ensureActiveOperationLog,
    sessionCommitPort: deps.sessionCommitPort,
    toSaveResultFromOutcome: deps.toSaveResultFromOutcome,
    refreshActiveIndexAfterNativeWrite: deps.refreshActiveIndexAfterNativeWrite
  });
  deps.handle('resource.readFmgDocument', (_event, ...args: Parameters<TextService['readFmgDocument']>) => service.readFmgDocument(...args));
  deps.handle('resource.readFmgPage', (_event, ...args: Parameters<TextService['readFmgPage']>) => service.readFmgPage(...args));
  deps.handle('resource.readTextCatalog', (_event, ...args: Parameters<TextService['readTextCatalog']>) => service.readTextCatalog(...args));
  deps.handle('resource.readFmgTablePage', (_event, ...args: Parameters<TextService['readFmgTablePage']>) => service.readFmgTablePage(...args));
  deps.handle('resource.applyFmgMutation', (_event, ...args: Parameters<TextService['applyFmgMutation']>) => service.applyFmgMutation(...args));
}
