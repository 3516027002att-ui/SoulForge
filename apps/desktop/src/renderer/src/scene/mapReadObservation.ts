/** Own the invocation, never replace Electron's frozen contextBridge exports. */
export async function observeMapGeometryRead<T>(
  invoke: () => Promise<T>,
  metadata: { modelName: string; cursorPresent: boolean; sessionPresent: boolean; requestId: string }
): Promise<T> {
  const startedAt = performance.now();
  // Event-only identity also survives equal clocks and a reused requestId.
  const observationId = {};
  let timeOrigin: number | undefined;
  let requestMetadata: typeof metadata | undefined;
  try {
    requestMetadata = { ...metadata };
    timeOrigin = performance.timeOrigin;
    window.dispatchEvent(new CustomEvent('sf-map-read-start', {
      detail: { ...requestMetadata, observationId, startedAt, timeOrigin }
    }));
  } catch { /* Observation cannot prevent invocation. */ }
  let result: T | undefined;
  let error: unknown;
  try {
    result = await invoke();
    return result;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    // Observation cannot change a successful read or a cancellation/failure.
    try {
      window.dispatchEvent(new CustomEvent('sf-map-read-timing', {
        detail: { ...requestMetadata, observationId, startedAt, completedAt: performance.now(), timeOrigin, result, error }
      }));
    } catch { /* Browser-preview/headless may have no EventTarget. */ }
  }
}
