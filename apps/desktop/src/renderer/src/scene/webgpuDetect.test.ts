/**
 * WebGPU 探测的单元测试（issue #32）。
 *
 * 回归点：Chromium 150 删掉了 `GPUAdapter.requestAdapterInfo()`，只剩
 * `adapter.info`。旧实现把这次调用放在与 `requestAdapter()` 同一个 try 里，
 * 于是探测必然抛异常、被判不可用，WebGPU 永远退到 WebGL2，而且没有任何
 * 用例能发现——因为可用性判定和设备信息读取耦合在一起。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectWebGpu, preferredRendererBackend } from './webgpuDetect.js';

interface StubAdapter {
  features?: { has: (name: string) => boolean };
  info?: Record<string, unknown>;
  requestAdapterInfo?: () => Promise<unknown>;
}

function stubGpu(adapter: StubAdapter | null, options: { throwOnRequest?: boolean } = {}): void {
  const gpu = {
    requestAdapter: async () => {
      if (options.throwOnRequest) throw new Error('adapter request exploded');
      return adapter as unknown;
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu },
    configurable: true,
    writable: true
  });
}

function features(available: string[] = ['timestamp-query']): { has: (name: string) => boolean } {
  return { has: (name: string) => available.includes(name) };
}

describe('detectWebGpu', () => {
  it('Chromium 150 形态：只有 adapter.info，没有 requestAdapterInfo，判为可用', async () => {
    stubGpu({
      features: features(),
      info: { vendor: 'nvidia', architecture: 'ampere', device: 'RTX 3070', description: 'discrete' }
    });
    const capability = await detectWebGpu();
    assert.equal(capability.available, true);
    assert.deepEqual(capability.adapterInfo, {
      vendor: 'nvidia',
      architecture: 'ampere',
      device: 'RTX 3070',
      description: 'discrete'
    });
    assert.ok(capability.diagnostics.some((entry) => entry.code === 'WEBGPU_ADAPTER_FOUND'));
  });

  it('adapter.info 各字段为空字符串时仍判为可用', async () => {
    stubGpu({ features: features(), info: { vendor: '', architecture: '', device: '', description: '' } });
    const capability = await detectWebGpu();
    assert.equal(capability.available, true);
    assert.equal(capability.adapterInfo?.vendor, '');
    const found = capability.diagnostics.find((entry) => entry.code === 'WEBGPU_ADAPTER_FOUND');
    assert.ok(found);
    assert.match(found.message, /未报告设备信息/);
  });

  it('读设备信息失败只记诊断，不把 WebGPU 判为不可用', async () => {
    stubGpu({
      features: features(),
      requestAdapterInfo: async () => {
        throw new Error('info unavailable');
      }
    });
    const capability = await detectWebGpu();
    assert.equal(capability.available, true);
    assert.equal(capability.adapterInfo, undefined);
    const unavailable = capability.diagnostics.find((entry) => entry.code === 'WEBGPU_ADAPTER_INFO_UNAVAILABLE');
    assert.ok(unavailable);
    assert.equal(unavailable.severity, 'warning');
  });

  it('两者都没有时给出信息未知诊断，但仍判为可用', async () => {
    stubGpu({ features: features() });
    const capability = await detectWebGpu();
    assert.equal(capability.available, true);
    assert.equal(capability.adapterInfo, undefined);
    assert.ok(capability.diagnostics.some((entry) => entry.code === 'WEBGPU_ADAPTER_INFO_UNAVAILABLE'));
  });

  it('旧形态：只有 requestAdapterInfo 时照旧读取', async () => {
    stubGpu({
      features: features(),
      requestAdapterInfo: async () => ({ vendor: 'amd', architecture: 'rdna2', device: 'RX 6800', description: '' })
    });
    const capability = await detectWebGpu();
    assert.equal(capability.available, true);
    assert.equal(capability.adapterInfo?.vendor, 'amd');
  });

  it('缺少 timestamp-query 只记信息级诊断', async () => {
    stubGpu({ features: features([]), info: { vendor: 'intel' } });
    const capability = await detectWebGpu();
    assert.equal(capability.available, true);
    const missing = capability.diagnostics.find((entry) => entry.code === 'WEBGPU_NO_TIMESTAMP_QUERY');
    assert.ok(missing);
    assert.equal(missing.severity, 'info');
  });

  it('没有 adapter 时判为不可用', async () => {
    stubGpu(null);
    const capability = await detectWebGpu();
    assert.equal(capability.available, false);
    assert.ok(capability.diagnostics.some((entry) => entry.code === 'WEBGPU_NO_ADAPTER'));
  });

  it('requestAdapter 抛错时判为不可用并如实上报原因', async () => {
    stubGpu({ features: features() }, { throwOnRequest: true });
    const capability = await detectWebGpu();
    assert.equal(capability.available, false);
    const failed = capability.diagnostics.find((entry) => entry.code === 'WEBGPU_REQUEST_FAILED');
    assert.ok(failed);
    assert.equal(failed.severity, 'error');
    assert.match(failed.message, /adapter request exploded/);
  });
});

describe('preferredRendererBackend', () => {
  it('默认仍走 WebGL2（#34 之前不切换默认后端）', async () => {
    stubGpu({ features: features(), info: { vendor: 'nvidia' } });
    assert.equal(await preferredRendererBackend(), 'webgl2');
  });

  it('显式 opt-in 且适配器可用时才返回 webgpu', async () => {
    stubGpu({ features: features(), info: { vendor: 'nvidia' } });
    assert.equal(await preferredRendererBackend({ webgpuEnabled: true }), 'webgpu');
  });

  it('显式 opt-in 但适配器不可用时仍回落 WebGL2', async () => {
    stubGpu(null);
    assert.equal(await preferredRendererBackend({ webgpuEnabled: true }), 'webgl2');
  });
});
