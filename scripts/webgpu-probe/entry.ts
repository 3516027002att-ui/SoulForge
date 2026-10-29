/**
 * Electron 实机探测入口：#32 验收第 3 条。
 *
 * 在真正的 Electron 43（Chromium 150）里跑一遍 webgpuDetect，并让
 * threeSceneController 的 resolveRendererBackend 拿真实探测结果做一次决策，
 * 证明「诊断说 WebGPU 可用，而默认后端仍是 WebGL2」。
 */
import { detectWebGpu } from '../../apps/desktop/src/renderer/src/scene/webgpuDetect';
import { resolveRendererBackend } from '../../apps/desktop/src/renderer/src/scene/threeSceneController';

const globalScope = globalThis as unknown as { __probeResult?: unknown; __probeError?: string };

void (async () => {
  try {
    const capability = await detectWebGpu();
    const adapterLike = (navigator as unknown as { gpu?: unknown }).gpu;
    const gpu = adapterLike as { requestAdapter?: (options?: unknown) => Promise<null | {
      info?: Record<string, unknown>;
      features?: { has?: (name: string) => boolean };
      requestAdapterInfo?: () => Promise<Record<string, unknown>>;
    }> } | undefined;
    // 记录适配器上真正存在的字段，分清「info 可用」和「只有 legacy 方法」。
    let adapterShape: Record<string, unknown> | null = null;
    try {
      const raw = await gpu?.requestAdapter?.({ powerPreference: 'high-performance' });
      adapterShape = raw
        ? {
            hasInfo: raw.info !== undefined,
            infoKeys: raw.info ? Object.keys(raw.info) : [],
            hasRequestAdapterInfo: typeof raw.requestAdapterInfo === 'function',
            timestampQuery: raw.features?.has?.('timestamp-query') === true
          }
        : null;
    } catch (error) {
      adapterShape = { requestFailed: error instanceof Error ? error.message : String(error) };
    }

    globalScope.__probeResult = {
      electron: (globalThis as unknown as { process?: { versions?: Record<string, string> } }).process?.versions ?? null,
      userAgent: navigator.userAgent,
      hasNavigatorGpu: adapterLike !== undefined,
      adapterShape,
      capability,
      // 生产调用点传的是 undefined override + 未开启 webgpuEnabled，
      // 所以这里同时给出「默认」和「显式开启」两种决策结果。
      backendDefault: resolveRendererBackend(undefined, capability.available),
      backendWhenExplicitlyEnabled: resolveRendererBackend(undefined, capability.available, { webgpuEnabled: true })
    };
  } catch (error) {
    globalScope.__probeError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
})();
