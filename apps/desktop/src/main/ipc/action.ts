import type { TrustedIpcHandle } from './registration.js';
import { createActionService, type ActionServiceDeps } from '../services/actionService.js';
import { createCharacterPreviewService, type CharacterPreviewServiceDeps } from '../services/characterPreviewService.js';

// Compatibility imports for existing workspace indexing and MAP helper ports.
// Each implementation is owned once by its application service.
export { buildActionBinderMembershipIndex, resolveActionEffectiveBaseRoot, type ActionBinderMembershipIndexBuildResult } from '../services/actionService.js';
export { characterTexturePackagePaths, assembleC0000CompatibilityPreview, getActionForensicsCounters } from '../services/characterPreviewService.js';

export interface ActionIpcDeps extends ActionServiceDeps, CharacterPreviewServiceDeps {
  handle: TrustedIpcHandle;
}

export function registerActionIpcHandlers(deps: ActionIpcDeps): void {
  const action = createActionService({
    get indexedFiles() { return deps.indexedFiles; },
    get activeSession() { return deps.activeSession; },
    get activeIndex() { return deps.activeIndex; },
    get activeWorkspaceSessionId() { return deps.activeWorkspaceSessionId; },
    asBasicDiagnostics: items => deps.asBasicDiagnostics(items),
    verifiedReadRoots: (session, fallback) => deps.verifiedReadRoots(session, fallback),
    get ensureActionBinderMembershipForFamily() {
      return deps.ensureActionBinderMembershipForFamily
        ? (family: string) => deps.ensureActionBinderMembershipForFamily!(family)
        : undefined;
    },
    get waitForWorkspaceIndexing() {
      return deps.waitForWorkspaceIndexing ? () => deps.waitForWorkspaceIndexing!() : undefined;
    }
  });
  const character = createCharacterPreviewService({
    get indexedFiles() { return deps.indexedFiles; },
    get activeSession() { return deps.activeSession; },
    safeExists: path => deps.safeExists(path),
    verifiedReadRoots: (session, fallback) => deps.verifiedReadRoots(session, fallback)
  });
  deps.handle('resource.readTaeDocument', (_event, ...args: Parameters<typeof action.readTaeDocument>) => action.readTaeDocument(...args));
  deps.handle('resource.readTaeTemplateCatalog', (_event, ...args: Parameters<typeof action.readTaeTemplateCatalog>) => action.readTaeTemplateCatalog(...args));
  deps.handle('resource.readTaeEventParams', (_event, ...args: Parameters<typeof action.readTaeEventParams>) => action.readTaeEventParams(...args));
  deps.handle('resource.readTaeChrbndPreview', (_event, ...args: Parameters<typeof character.readTaeChrbndPreview>) => character.readTaeChrbndPreview(...args));
  deps.handle('resource.readTaeAnimationClip', (_event, ...args: Parameters<typeof action.readTaeAnimationClip>) => action.readTaeAnimationClip(...args));
  deps.handle('resource.sampleTaeAnimationPose', (_event, ...args: Parameters<typeof action.sampleTaeAnimationPose>) => action.sampleTaeAnimationPose(...args));
  deps.handle('resource.resolveChrbndPreview', (_event, ...args: Parameters<typeof character.resolveChrbndPreview>) => character.resolveChrbndPreview(...args));
}
