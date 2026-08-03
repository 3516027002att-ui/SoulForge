/**
 * WebGPU capability detection for the renderer process.
 * Reports availability without requiring Three.js WebGPU renderer.
 */

interface GPUAdapterLike {
  features: { has: (name: string) => boolean };
  requestAdapterInfo: () => Promise<{
    vendor: string;
    architecture: string;
    device: string;
    description: string;
  }>;
}

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

    const info = await adapter.requestAdapterInfo();
    diagnostics.push({
      severity: 'info',
      code: 'WEBGPU_ADAPTER_FOUND',
      message: `WebGPU adapter: ${info.vendor} ${info.architecture} ${info.device}`
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
      adapterInfo: {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description
      },
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
 */
export async function preferredRendererBackend(): Promise<'webgpu' | 'webgl2'> {
  const capability = await detectWebGpu();
  return capability.available ? 'webgpu' : 'webgl2';
}
