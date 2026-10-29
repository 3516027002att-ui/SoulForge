/**
 * WebGPU capability detection for the renderer process.
 * Reports availability without requiring Three.js WebGPU renderer.
 *
 * Backend decision (issue #32, fully unblocked by #34): detection is
 * *diagnostic* only — `resolveRendererBackend` still defaults to WebGL2.
 * Chromium 150 dropped `GPUAdapter.requestAdapterInfo()` in favour of
 * `adapter.info`; the old code awaited the removed method inside the same `try`
 * as `requestAdapter()`, so every probe threw and WebGPU was reported
 * unavailable on every build. Reading adapter information is now best-effort: a
 * missing or throwing info source only records a diagnostic and leaves
 * `available` untouched.
 */

/** Adapter info fields as reported by `adapter.info` (Chromium ≥ 150). */
interface GPUAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

interface GPUAdapterLike {
  features: { has: (name: string) => boolean };
  /** Present on Chromium ≥ 150; absent on older builds. */
  info?: GPUAdapterInfoLike;
  /** Removed in Chromium ≥ 150; kept for older builds. */
  requestAdapterInfo?: () => Promise<GPUAdapterInfoLike | null | undefined>;
}

export interface WebGpuAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export interface WebGpuCapability {
  available: boolean;
  adapterInfo?: WebGpuAdapterInfo;
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
}

function normalizeAdapterInfo(raw: GPUAdapterInfoLike | null | undefined): WebGpuAdapterInfo {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    vendor: text(raw?.vendor),
    architecture: text(raw?.architecture),
    device: text(raw?.device),
    description: text(raw?.description)
  };
}

function describeAdapter(info: WebGpuAdapterInfo): string {
  const parts = [info.vendor, info.architecture, info.device].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(' ') : '未报告设备信息';
}

/**
 * Read adapter information without letting it decide availability.
 * Returns null when no info source exists or reading it throws.
 */
async function readAdapterInfo(
  adapter: GPUAdapterLike,
  diagnostics: WebGpuCapability['diagnostics']
): Promise<WebGpuAdapterInfo | null> {
  if (adapter.info && typeof adapter.info === 'object') {
    return normalizeAdapterInfo(adapter.info);
  }
  if (typeof adapter.requestAdapterInfo === 'function') {
    try {
      return normalizeAdapterInfo(await adapter.requestAdapterInfo());
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'WEBGPU_ADAPTER_INFO_UNAVAILABLE',
        message: `adapter 信息读取失败，WebGPU 仍可用：${error instanceof Error ? error.message : String(error)}`
      });
      return null;
    }
  }
  diagnostics.push({
    severity: 'info',
    code: 'WEBGPU_ADAPTER_INFO_UNAVAILABLE',
    message: 'adapter 未提供 info/requestAdapterInfo；WebGPU 仍可用，设备信息未知。'
  });
  return null;
}

/**
 * Detect WebGPU availability and adapter info.
 * Returns a capability report without creating a GPU context.
 */
export async function detectWebGpu(): Promise<WebGpuCapability> {
  const diagnostics: WebGpuCapability['diagnostics'] = [];

  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    diagnostics.push({
      severity: 'info',
      code: 'WEBGPU_NOT_IN_NAVIGATOR',
      message: 'navigator.gpu 不可用；将使用 WebGL2 回退。'
    });
    return { available: false, diagnostics };
  }

  const gpu = (navigator as unknown as { gpu: { requestAdapter: (opts?: unknown) => Promise<GPUAdapterLike | null> } }).gpu;

  try {
    const adapter = await gpu.requestAdapter({
      powerPreference: 'high-performance'
    });
    if (!adapter) {
      diagnostics.push({
        severity: 'warning',
        code: 'WEBGPU_NO_ADAPTER',
        message: '未找到 GPU adapter；将使用 WebGL2 回退。'
      });
      return { available: false, diagnostics };
    }

    const adapterInfo = await readAdapterInfo(adapter, diagnostics);
    diagnostics.push({
      severity: 'info',
      code: 'WEBGPU_ADAPTER_FOUND',
      message: `WebGPU adapter: ${describeAdapter(adapterInfo ?? normalizeAdapterInfo(null))}`
    });

    // Check for required features
    const hasTimestampQuery = adapter.features.has('timestamp-query');
    if (!hasTimestampQuery) {
      diagnostics.push({
        severity: 'info',
        code: 'WEBGPU_NO_TIMESTAMP_QUERY',
        message: 'timestamp-query 不可用；性能分析受限。'
      });
    }

    return {
      available: true,
      ...(adapterInfo ? { adapterInfo } : {}),
      diagnostics
    };
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'WEBGPU_REQUEST_FAILED',
      message: `WebGPU adapter 请求失败：${error instanceof Error ? error.message : String(error)}`
    });
    return { available: false, diagnostics };
  }
}

/**
 * Determine the preferred renderer backend based on WebGPU availability.
 *
 * WebGPU must be opted into explicitly until the second-layer diffuse mixing
 * exists on that backend (#34): `onBeforeCompile` injection only runs on
 * WebGLRenderer, so switching the default today would silently drop that layer.
 */
export async function preferredRendererBackend(
  options: { webgpuEnabled?: boolean } = {}
): Promise<'webgpu' | 'webgl2'> {
  if (options.webgpuEnabled !== true) return 'webgl2';
  const capability = await detectWebGpu();
  return capability.available ? 'webgpu' : 'webgl2';
}
