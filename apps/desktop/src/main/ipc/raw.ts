import type { TrustedIpcHandle } from './registration.js';
import { createRawResourceService, type RawResourceService, type RawResourceServiceDeps } from '../services/rawResourceService.js';
export { clearRawResourceCaches as clearRawIpcCaches } from '../services/rawResourceService.js';

export interface RawIpcDeps extends RawResourceServiceDeps { handle: TrustedIpcHandle; }

/** Trusted literal reads; container/script projection and lifetime are application-owned. */
export function registerRawIpcHandlers(deps: RawIpcDeps): void {
  const service = createRawResourceService({
    get indexedFiles() { return deps.indexedFiles; },
    get activeSession() { return deps.activeSession; },
    durableStoragePaths: deps.durableStoragePaths,
    bridgeRootSession: deps.bridgeRootSession,
    bridgeRootsDiagnostic: deps.bridgeRootsDiagnostic,
    verifiedReadRoots: deps.verifiedReadRoots,
    verifiedStageRoots: deps.verifiedStageRoots
  });
  deps.handle('resource.readRawRange', (_event, ...args: Parameters<RawResourceService['readRawRange']>) => service.readRawRange(...args));
  deps.handle('resource.readRawMetadata', (_event, ...args: Parameters<RawResourceService['readRawMetadata']>) => service.readRawMetadata(...args));
  deps.handle('resource.inspectContainerTree', (_event, ...args: Parameters<RawResourceService['inspectContainerTree']>) => service.inspectContainerTree(...args));
  deps.handle('resource.listContainerChildren', (_event, ...args: Parameters<RawResourceService['listContainerChildren']>) => service.listContainerChildren(...args));
  deps.handle('resource.listContainerChildrenPage', (_event, ...args: Parameters<RawResourceService['listContainerChildrenPage']>) => service.listContainerChildrenPage(...args));
  deps.handle('resource.readContainerChild', (_event, ...args: Parameters<RawResourceService['readContainerChild']>) => service.readContainerChild(...args));
  deps.handle('resource.roundTripContainer', (_event, ...args: Parameters<RawResourceService['roundTripContainer']>) => service.roundTripContainer(...args));
  deps.handle('resource.validateContainer', (_event, ...args: Parameters<RawResourceService['validateContainer']>) => service.validateContainer(...args));
  deps.handle('resource.probeContainerCapabilities', (_event, ...args: Parameters<RawResourceService['probeContainerCapabilities']>) => service.probeContainerCapabilities(...args));
  deps.handle('resource.scriptContainerEvidence', (_event, ...args: Parameters<RawResourceService['scriptContainerEvidence']>) => service.scriptContainerEvidence(...args));
  deps.handle('resource.listScriptContainerEntriesPage', (_event, ...args: Parameters<RawResourceService['listScriptContainerEntriesPage']>) => service.listScriptContainerEntriesPage(...args));
  deps.handle('resource.readScriptEntryPlaintext', (_event, ...args: Parameters<RawResourceService['readScriptEntryPlaintext']>) => service.readScriptEntryPlaintext(...args));
  deps.handle('resource.readScriptSource', (_event, ...args: Parameters<RawResourceService['readScriptSource']>) => service.readScriptSource(...args));
}
