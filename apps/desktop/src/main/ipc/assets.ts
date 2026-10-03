import type { IpcMainInvokeEvent } from 'electron';
import type { WriteConfirmationPort } from '@soulforge/core';
import type { TrustedIpcHandle } from './registration.js';
import { createAssetReadService, type AssetReadServiceDeps } from '../services/assetReadService.js';
import { createAssetMutationService, type AssetMutationServiceDeps } from '../services/assetMutationService.js';

export interface AssetIpcDeps extends AssetReadServiceDeps, AssetMutationServiceDeps {
  handle: TrustedIpcHandle;
  electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort;
}

export function registerAssetIpcHandlers(deps: AssetIpcDeps): void {
  const read = createAssetReadService({
    get indexedFiles() { return deps.indexedFiles; },
    get activeSession() { return deps.activeSession; },
    verifiedReadRoots: (session, fallback) => deps.verifiedReadRoots(session, fallback),
    resolveFlverReadFile: sourceUri => deps.resolveFlverReadFile(sourceUri)
  });
  const mutation = createAssetMutationService({
    get indexedFiles() { return deps.indexedFiles; },
    get activeSession() { return deps.activeSession; },
    verifiedStageRoots: (session, storage, code) => deps.verifiedStageRoots(session, storage, code),
    durableStoragePaths: workspaceId => deps.durableStoragePaths(workspaceId),
    rejectNonSekiroNativeWrite: (sourceUri, file) => deps.rejectNonSekiroNativeWrite(sourceUri, file),
    ensureActiveOperationLog: session => deps.ensureActiveOperationLog(session),
    sessionCommitPort: (session, operationLog, storage) => deps.sessionCommitPort(session, operationLog, storage),
    toSaveResultFromOutcome: (outcome, files) => deps.toSaveResultFromOutcome(outcome, files)
  });
  deps.handle('resource.readFlverDocument', (_event, ...args: Parameters<typeof read.readFlverDocument>) => read.readFlverDocument(...args));
  deps.handle('resource.readTpfDocument', (_event, ...args: Parameters<typeof read.readTpfDocument>) => read.readTpfDocument(...args));
  deps.handle('resource.readTpfTexturePreview', (_event, ...args: Parameters<typeof read.readTpfTexturePreview>) => read.readTpfTexturePreview(...args));
  deps.handle('resource.readFlverMesh', (_event, ...args: Parameters<typeof read.readFlverMesh>) => read.readFlverMesh(...args));
  deps.handle('resource.readFlverSkeleton', (_event, ...args: Parameters<typeof read.readFlverSkeleton>) => read.readFlverSkeleton(...args));
  deps.handle('resource.readFlverDummies', (_event, ...args: Parameters<typeof read.readFlverDummies>) => read.readFlverDummies(...args));
  deps.handle('resource.readFlverTextureSlots', (_event, ...args: Parameters<typeof read.readFlverTextureSlots>) => read.readFlverTextureSlots(...args));
  deps.handle('resource.readEsdDocument', (_event, ...args: Parameters<typeof read.readEsdDocument>) => read.readEsdDocument(...args));
  deps.handle('resource.readMtdDocument', (_event, ...args: Parameters<typeof read.readMtdDocument>) => read.readMtdDocument(...args));
  deps.handle('resource.readFxrDocument', (_event, ...args: Parameters<typeof read.readFxrDocument>) => read.readFxrDocument(...args));
  deps.handle('resource.listFxrEntries', (_event, ...args: Parameters<typeof read.listFxrEntries>) => read.listFxrEntries(...args));
  deps.handle('resource.readGparamDocument', (_event, ...args: Parameters<typeof read.readGparamDocument>) => read.readGparamDocument(...args));
  deps.handle('resource.applyFlverMutation', (event, ...args: Tail<Parameters<typeof mutation.applyFlverMutation>>) =>
    mutation.applyFlverMutation(() => deps.electronConfirmationPort(event), ...args));
  deps.handle('resource.saveTpfTextureReplace', (event, ...args: Tail<Parameters<typeof mutation.saveTpfTextureReplace>>) =>
    mutation.saveTpfTextureReplace(() => deps.electronConfirmationPort(event), ...args));
  deps.handle('resource.commitGparamMutations', (event, ...args: Tail<Parameters<typeof mutation.commitGparamMutations>>) =>
    mutation.commitGparamMutations(() => deps.electronConfirmationPort(event), ...args));
  deps.handle('resource.commitMtdPropertySet', (event, ...args: Tail<Parameters<typeof mutation.commitMtdPropertySet>>) =>
    mutation.commitMtdPropertySet(() => deps.electronConfirmationPort(event), ...args));
  deps.handle('resource.commitEsdTransition', (event, ...args: Tail<Parameters<typeof mutation.commitEsdTransition>>) =>
    mutation.commitEsdTransition(() => deps.electronConfirmationPort(event), ...args));
  deps.handle('resource.commitTaeEvent', (event, ...args: Tail<Parameters<typeof mutation.commitTaeEvent>>) =>
    mutation.commitTaeEvent(() => deps.electronConfirmationPort(event), ...args));
  deps.handle('resource.commitFxrFieldSet', (event, ...args: Tail<Parameters<typeof mutation.commitFxrFieldSet>>) =>
    mutation.commitFxrFieldSet(() => deps.electronConfirmationPort(event), ...args));
}

type Tail<Args extends unknown[]> = Args extends [unknown, ...infer Rest] ? Rest : never;
