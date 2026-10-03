import type { MapGeometryPrepareObservation } from './mapGeometryPrepareClient.js';

/** Renderer-local binding; the revision identifies the MSB, not a resolved FLVER. */
export interface MapModelObservationIdentity {
  modelName: string;
  loadId: string;
  sourceUri: string;
  sourceRevision: string;
  canvas: object | null;
}

export interface MapModelLoadObservation {
  readonly identity: Readonly<MapModelObservationIdentity>;
  observePreparation(event: MapGeometryPrepareObservation): void;
  snapshotPreparation(): MapGeometryPrepareObservation | null;
}

export interface MapModelLoadInvocation<T> {
  promise: Promise<T>;
  observation: MapModelLoadObservation | null;
}

function snapshotIdentity(identity: MapModelObservationIdentity): Readonly<MapModelObservationIdentity> {
  try { return Object.freeze({ ...identity }); }
  catch { return Object.freeze({ modelName: '', loadId: '', sourceUri: '', sourceRevision: '', canvas: null }); }
}

export function createMapModelLoadObservation(identity: MapModelObservationIdentity): MapModelLoadObservation {
  const capturedIdentity = snapshotIdentity(identity);
  let preparation: MapGeometryPrepareObservation | null = null;
  return Object.freeze({
    identity: capturedIdentity,
    observePreparation(event: MapGeometryPrepareObservation) {
      // This callback belongs to one loader invocation. Never replace it with
      // the newest model-name or shared-geometry association.
      if (preparation === null) preparation = { ...event };
    },
    snapshotPreparation: () => preparation === null ? null : { ...preparation }
  });
}

export function captureMapModelLoadInvocation<T>(
  invoke: () => Promise<T>,
  readObservation: () => MapModelLoadObservation | null | undefined
): MapModelLoadInvocation<T> {
  // The existing loader creates its record synchronously before its first
  // await. Capture it now, while preserving the exact cached promise/result.
  const promise = invoke();
  let observation: MapModelLoadObservation | null = null;
  try { observation = readObservation() ?? null; } catch { /* Observation is best-effort. */ }
  return { promise, observation };
}

interface RendererClockPoint {
  atMs: number | null;
  timeOrigin: number | null;
}

function observeClock(): RendererClockPoint {
  let atMs: number | null = null, timeOrigin: number | null = null;
  try { const value = performance.now(); if (Number.isFinite(value)) atMs = value; } catch {}
  try { const value = performance.timeOrigin; if (Number.isFinite(value)) timeOrigin = value; } catch {}
  return { atMs, timeOrigin };
}

/** Observe the actual queue callback, without turning telemetry into upload failure. */
export function observeMapModelUpload(
  queue: { enqueue(run: () => boolean | void): Promise<boolean> },
  replace: () => boolean,
  observation: MapModelLoadObservation | null,
  preparedJobId: string | undefined,
  isCurrent: () => boolean
): Promise<boolean> {
  let identity: Readonly<MapModelObservationIdentity> | null = null;
  let preparation: MapGeometryPrepareObservation | null = null;
  try {
    if (observation) {
      identity = snapshotIdentity(observation.identity);
      preparation = observation.snapshotPreparation();
    }
  } catch { /* Missing observation remains unavailable; replacement still runs. */ }
  const enqueued = observeClock();
  return queue.enqueue(() => {
    const started = observeClock();
    const uploaded = replace();
    const completed = observeClock();
    if (uploaded) {
      try {
        if (identity && isCurrent()) {
          window.dispatchEvent(new CustomEvent('sf-map-model-ready', {
            detail: {
              ...identity,
              readyAtUnixMs: completed.atMs === null || completed.timeOrigin === null
                ? null : completed.timeOrigin + completed.atMs,
              postReturn: {
                schemaVersion: 1,
                preparation,
                preparedJobId: preparedJobId ?? null,
                upload: {
                  enqueuedAtMs: enqueued.atMs,
                  startedAtMs: started.atMs,
                  completedAtMs: completed.atMs,
                  timeOriginAtEnqueue: enqueued.timeOrigin,
                  timeOriginAtStart: started.timeOrigin,
                  timeOriginAtCompletion: completed.timeOrigin
                }
              }
            }
          }));
        }
      } catch { /* Success/error/cancellation belongs to replacement, not telemetry. */ }
    }
    return uploaded;
  });
}
