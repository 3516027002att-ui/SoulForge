/**
 * WebGPU capability detection for the renderer process.
 * Reports availability without requiring Three.js WebGPU renderer.
 */

interface GPUAdapterLike {
  features: { has: (name: string) => boolean };
  readonly info?: Partial<NonNullable<WebGpuCapability['adapterInfo']>>;
}

export type RendererBackend = 'webgpu' | 'webgl2';

export interface WebGpuCapability {
  available: boolean;
  adapterInfo?: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
  };
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
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

    // GPUAdapter.info replaces requestAdapterInfo in current Chromium.
    // https://developer.chrome.com/blog/new-in-webgpu-127#gpuadapter_info_attribute
    let adapterInfo: WebGpuCapability['adapterInfo'];
    try {
      const info = adapter.info;
      if (info) {
        const text = (value: unknown) => typeof value === 'string' ? value : '';
        adapterInfo = {
          vendor: text(info.vendor), architecture: text(info.architecture),
          device: text(info.device), description: text(info.description)
        };
      }
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'WEBGPU_ADAPTER_INFO_FAILED',
        message: `WebGPU adapter 信息不可读：${error instanceof Error ? error.message : String(error)}`
      });
    }
    diagnostics.push({
      severity: 'info',
      code: 'WEBGPU_ADAPTER_FOUND',
      message: adapterInfo
        ? `WebGPU adapter: ${adapterInfo.vendor} ${adapterInfo.architecture} ${adapterInfo.device}`
        : 'WebGPU adapter 可用。'
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
 * Capability discovery does not select the active backend. WebGL2 remains
 * the default until native diffuse-blend and image/performance parity pass.
 */
export function resolveRendererBackend(
  override: RendererBackend | undefined,
  _gpuAvailable: boolean
): RendererBackend {
  return override ?? 'webgl2';
}

export async function preferredRendererBackend(): Promise<RendererBackend> {
  const capability = await detectWebGpu();
  return resolveRendererBackend(undefined, capability.available);
}
