/** Own the invocation, never replace Electron's frozen contextBridge exports. */
export async function observeMapGeometryRead<T>(
  invoke: () => Promise<T>,
  metadata: { modelName: string; cursorPresent: boolean; sessionPresent: boolean; requestId: string }
): Promise<T> {
  const startedAt = performance.now();
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
        detail: { ...metadata, startedAt, completedAt: performance.now(), timeOrigin: performance.timeOrigin, result, error }
      }));
    } catch { /* Browser-preview/headless may have no EventTarget. */ }
  }
}
