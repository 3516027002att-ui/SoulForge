import type { IpcMainInvokeEvent } from 'electron';
import type { RunBridgeCancellationTerminalReceipt, WriteConfirmationPort } from '@soulforge/core';
import type { Diagnostic } from '@soulforge/shared';
import type { TrustedIpcHandle } from './registration.js';
import { assembleC0000CompatibilityPreview, characterTexturePackagePaths } from './action.js';
import { executeMapRequest, isMapRequestCancellationError, MapRequestCancellationRegistry, normalizeMapRequestId } from './mapRequestCancellation.js';
import { createMapService, type MapService, type MapServiceDeps } from '../services/mapService.js';
import { MAP_REQUEST_CANCELLED_CODE } from '../services/mapReadContext.js';

export interface MapIpcDeps extends Omit<MapServiceDeps, 'characterTexturePackagePaths' | 'assembleC0000CompatibilityPreview'> {
  handle: TrustedIpcHandle;
  electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort;
}
type ConfirmedArgs<Call> = Call extends (confirmation: () => WriteConfirmationPort, ...args: infer Args) => unknown ? Args : never;
let activeService: MapService | null = null;
export function getMapForensicsCounters(): Record<string, number> { return activeService?.getMapForensicsCounters() ?? {}; }


const mapReadRequests = new MapRequestCancellationRegistry();
const MAP_CANCELLATION_TERMINAL_MARKER = '[SF_MAP_CANCELLATION_TERMINAL]';
const MAP_CANCELLATION_REQUESTED_MARKER = '[SF_MAP_CANCELLATION_REQUESTED]';

type MapCancellationTerminalReceipt = RunBridgeCancellationTerminalReceipt & {
  ownerId: number;
  /** Renderer-facing opaque request handle, not the Bridge request UUID. */
  mapRequestId: string;
};

function emitMapCancellationTerminal(receipt: MapCancellationTerminalReceipt): void {
  // Keep this diagnostic-only and opt-in.  The production MAP probe enables
  // the same main telemetry switch and consumes this as a structured line;
  // ordinary desktop sessions must not receive transport noise on stdout.
  if (process.env.SF_MAP_MAIN_TELEMETRY !== '1') return;
  try {
    // eslint-disable-next-line no-console
    console.log(`${MAP_CANCELLATION_TERMINAL_MARKER} ${JSON.stringify({
      schemaVersion: 1,
      source: 'soulforge.main.map.runBridge',
      ownerId: receipt.ownerId,
      requestId: receipt.mapRequestId,
      bridgeRequestId: receipt.requestId,
      outcome: receipt.outcome,
      requestPhase: receipt.requestPhase,
      cancelRequested: receipt.cancelRequested,
      receivedAt: receipt.receivedAt
    })}`);
  } catch {
    // Cancellation evidence must never affect the read/cancel path.
  }
}

function emitMapCancellationRequested(
  ownerId: number,
  requestId: string,
  status: 'cancelled' | 'already-cancelled' | 'not-found'
): void {
  if (process.env.SF_MAP_MAIN_TELEMETRY !== '1') return;
  try {
    // eslint-disable-next-line no-console
    console.log(`${MAP_CANCELLATION_REQUESTED_MARKER} ${JSON.stringify({
      schemaVersion: 1,
      source: 'soulforge.main.map.cancelMapStaticGeometry',
      ownerId,
      requestId,
      status,
      atUTC: new Date().toISOString()
    })}`);
  } catch {
    // Cancellation evidence must never affect the read/cancel path.
  }
}

type MapRequestCancellationResult = {
  ok: false;
  status?: 'partial';
  diagnostics: Diagnostic[];
};

function mapRequestCancelledResponse(
  requestId: string,
  sourceUri: string | undefined,
  terminalReceipts: readonly MapCancellationTerminalReceipt[] = []
): MapRequestCancellationResult {
  const commandCancelled = terminalReceipts.some((receipt) =>
    receipt.requestPhase === 'command'
    && receipt.outcome === 'cancelled'
    && receipt.cancelRequested === true
  );
  const artifactCancelled = terminalReceipts.some((receipt) =>
    receipt.requestPhase === 'artifact'
    && receipt.outcome === 'cancelled'
    && receipt.cancelRequested === true
  );
  return {
    ok: false,
    status: 'partial',
    diagnostics: [{
      severity: 'info',
      code: MAP_REQUEST_CANCELLED_CODE,
      message: '地图模型读取已取消。',
      ...(sourceUri ? { sourceUri } : {}),
      details: {
        requestId,
        cancellation: {
          cancelRequested: true,
          callerSettled: true,
          // A local AbortSignal proves the caller asked for cancellation, but
          // not that a Bridge frame was dispatched or that the daemon emitted
          // its terminal frame.  Keep those claims explicitly unverified
          // until the scoped receipt arrives.
          // A terminal receipt proves that the daemon reached a terminal
          // state, but its cancelRequested bit is not proof that main sent a
          // cancel frame: a terminal frame can race the local abort path.
          // Keep the request claim explicitly unverified and expose the
          // receipt observation separately.
          daemonCancelRequested: 'unverified',
          daemonTerminalObserved: terminalReceipts.length > 0,
          nativeActiveWorkStopped: 'unverified',
          nativeAbortObserved: commandCancelled ? true : 'unverified',
          artifactCancellationObserved: artifactCancelled,
          terminalReceipts: terminalReceipts.map((receipt) => ({
            schemaVersion: 1,
            source: 'soulforge.main.map.runBridge',
            ownerId: receipt.ownerId,
            requestId: receipt.mapRequestId,
            bridgeRequestId: receipt.requestId,
            outcome: receipt.outcome,
            requestPhase: receipt.requestPhase,
            cancelRequested: receipt.cancelRequested,
            receivedAt: receipt.receivedAt
          }))
        }
      }
    }]
  };
}

function mapRequestDuplicateResponse(requestId: string): MapRequestCancellationResult {
  return {
    ok: false,
    diagnostics: [{
      severity: 'error',
      code: 'MAP_REQUEST_DUPLICATE',
      message: '同一窗口已有相同 requestId 的地图读取在途。',
      details: { requestId }
    }]
  };
}

function mapRequestInvalidIdResponse(): MapRequestCancellationResult {
  return {
    ok: false,
    diagnostics: [{
      severity: 'error',
      code: 'MAP_REQUEST_ID_INVALID',
      message: '地图读取 requestId 无效，已拒绝。'
    }]
  };
}

async function withMapRequestCancellation<T>(
  event: IpcMainInvokeEvent,
  requestIdValue: unknown,
  work: (
    signal: AbortSignal | undefined,
    onCancellationTerminal?: (receipt: RunBridgeCancellationTerminalReceipt) => void
  ) => Promise<T>,
  sourceUri?: string
): Promise<T | MapRequestCancellationResult> {
  // Undefined is the legacy four-argument call. Preserve it as a no-signal
  // request for already shipped preload clients.
  if (requestIdValue === undefined || requestIdValue === null) return work(undefined);
  const requestId = normalizeMapRequestId(requestIdValue);
  if (!requestId) return mapRequestInvalidIdResponse();
  const ownerId = event.sender.id;
  const begun = mapReadRequests.begin(ownerId, requestId);
  if (begun.status === 'duplicate') return mapRequestDuplicateResponse(requestId);
  mapReadRequests.bindOwner(ownerId, event.sender);
  const { controller } = begun.lease;
  const terminalReceipts: MapCancellationTerminalReceipt[] = [];
  const onCancellationTerminal = (receipt: RunBridgeCancellationTerminalReceipt): void => {
    const enriched: MapCancellationTerminalReceipt = {
      ...receipt,
      ownerId,
      mapRequestId: requestId
    };
    terminalReceipts.push(enriched);
    emitMapCancellationTerminal(enriched);
  };
  try {
    const execution = await executeMapRequest(controller, (signal) => work(signal, onCancellationTerminal));
    // executeMapRequest performs the shared late-settlement guard: a value
    // resolved after cancellation is never published as a successful page.
    if (execution.outcome === 'cancelled') {
      return mapRequestCancelledResponse(requestId, sourceUri, terminalReceipts);
    }
    return execution.value;
  } catch (error) {
    // Keep the local code constant visible for diagnostics while the shared
    // helper owns normal abort/error classification.
    if (controller.signal.aborted || isMapRequestCancellationError(error)) {
      return mapRequestCancelledResponse(requestId, sourceUri, terminalReceipts);
    }
    throw error;
  } finally {
    mapReadRequests.finish(ownerId, requestId, controller);
  }
}

/** Trusted registration and request ownership stay at the transport boundary. */
export function registerMapIpcHandlers(deps: MapIpcDeps): void {
  const service = createMapService({
    get indexedFiles() { return deps.indexedFiles; },
    get indexedFilesRevision() { return deps.indexedFilesRevision; },
    get indexedFilesIdentityDigest() { return deps.indexedFilesIdentityDigest; },
    get activeSession() { return deps.activeSession; },
    get activeIndex() { return deps.activeIndex; },
    get activeWorkspaceSessionId() { return deps.activeWorkspaceSessionId; },
    get activeWorkspaceSessionGeneration() { return deps.activeWorkspaceSessionGeneration; },
    replaceIndexedFile: (...args) => deps.replaceIndexedFile(...args),
    safeExists: (...args) => deps.safeExists(...args),
    asBasicDiagnostics: (...args) => deps.asBasicDiagnostics(...args),
    durableStoragePaths: (...args) => deps.durableStoragePaths(...args),
    verifiedReadRoots: (...args) => deps.verifiedReadRoots(...args),
    rejectNonSekiroNativeWrite: (...args) => deps.rejectNonSekiroNativeWrite(...args),
    ensureActiveOperationLog: (...args) => deps.ensureActiveOperationLog(...args),
    refreshActiveIndexAfterNativeWrite: (...args) => deps.refreshActiveIndexAfterNativeWrite(...args),
    characterTexturePackagePaths, assembleC0000CompatibilityPreview
  });
  activeService = service;
  deps.handle('resource.readMsbDocument', (_event, ...args: Parameters<MapService['readMsbDocument']>) => service.readMsbDocument(...args));
  deps.handle('resource.readMapModelSource', (_event, ...args: Parameters<MapService['readMapModelSource']>) => service.readMapModelSource(...args));
  deps.handle('resource.readMapPartMesh', (_event, ...args: Parameters<MapService['readMapPartMesh']>) => service.readMapPartMesh(...args));
  deps.handle('resource.readMapStaticGeometry', (event, msbSourceUri: string, modelName: string, cursor?: string | null, sessionToken?: string | null, requestId?: string) =>
    withMapRequestCancellation(event, requestId, (signal, onCancellationTerminal) =>
      service.readMapStaticGeometry({ signal, ...(onCancellationTerminal ? { onCancellationTerminal } : {}) }, msbSourceUri, modelName, cursor, sessionToken), msbSourceUri));


  deps.handle(
    'resource.cancelMapStaticGeometry',
    async (event, requestIdValue: unknown): Promise<{
      ok: true;
      cancelled: boolean;
      status: 'cancelled' | 'already-cancelled' | 'not-found';
      requestId?: string;
    } | MapRequestCancellationResult> => {
      const requestId = normalizeMapRequestId(requestIdValue);
      if (!requestId) return mapRequestInvalidIdResponse();
      const result = mapReadRequests.cancel(event.sender.id, requestId);
      emitMapCancellationRequested(event.sender.id, requestId, result.status);
      return {
        ok: true,
        cancelled: result.status === 'cancelled',
        status: result.status,
        requestId
      };
    }
  );
  deps.handle('resource.applyMsbMutation', (event, ...args: ConfirmedArgs<MapService['applyMsbMutation']>) =>
    service.applyMsbMutation(() => deps.electronConfirmationPort(event), ...args));
  deps.handle('resource.executeMapTransaction', (event, ...args: ConfirmedArgs<MapService['executeMapTransaction']>) =>
    service.executeMapTransaction(() => deps.electronConfirmationPort(event), ...args));
}
