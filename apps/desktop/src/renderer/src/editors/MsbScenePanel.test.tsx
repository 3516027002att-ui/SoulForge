/**
 * MAP-50B：MSB 三栏地图工作台接入后的 renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），而
 * MsbScenePanel 的 3D 场景由 effect 驱动（buildMsbSceneManifest →
 * mountThreeProxyScene），SSR 只能看到挂载即有的骨架与空态。因此这里钉两类契约：
 *
 * 1. SSR 结构：三栏 Map Object List | Viewport | Properties 挂载即存在，
 *    没有为凑四栏造 Tools 空栏；未加载 MSB 数据时左栏是显式 muted 空态而不是错误；
 * 2. Negative source：S36 开闸后 footer 恒为提交入口形态（part/region 位置微调与
 *    part transform），writeEnabled 关闭时按钮禁用并显式标注「写入未开放」，绝不
 *    静默假装已保存；viewport 只承载 proxy scene 宿主（SSR 下无 canvas、
 *    无假缩略图/假预览）；左栏对象列表由 scene manifest 派生而不是 renderer 扫字节；
 *    写路径只走 Bridge commit 回调，不自行解析字节。
 *
 * 真实 live 链路（Bridge → ipc → readMsbDocument → mountThreeProxyScene）由
 * bridge:verify:msb-all 与 E2E 覆盖，本文件只钉 renderer 侧的展示与接线约束。
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MsbScenePanel, mergeMapStaticGeometryChunks } from './MsbScenePanel.js';

function resolvePartModelName(
  part: { modelIndex?: number },
  models: Array<{ name: string }>
): string | null {
  if (typeof part.modelIndex !== 'number' || part.modelIndex < 0) return null;
  return models[part.modelIndex]?.name ?? null;
}

// node 环境没有 window；getRendererRuntime 读 window.soulforge。设为空对象 →
// bridge 为 null → live 路径短路，SSR 输出纯初始结构（effect 不跑）。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <MsbScenePanel
      mapResourceUri="fixture://map/m10.msb.dcx"
      sourcePath="map/m10.msb.dcx"
      game="sekiro"
      revision="fixture-hash-0001"
      parts={[]}
      {...overrides}
    />
  );
}

function encodeFloat32(values: readonly number[]): string {
  const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true));
  return Buffer.from(bytes).toString('base64');
}

function encodeIndices(values: readonly number[], indexElementBytes: 2 | 4 = 2): string {
  const bytes = new Uint8Array(values.length * indexElementBytes);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    if (indexElementBytes === 4) view.setUint32(index * indexElementBytes, value, true);
    else view.setUint16(index * indexElementBytes, value, true);
  });
  return Buffer.from(bytes).toString('base64');
}

function decodeFloat32(value: string): number[] {
  const bytes = Buffer.from(value, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += Float32Array.BYTES_PER_ELEMENT) {
    values.push(view.getFloat32(offset, true));
  }
  return values;
}

function decodeIndices(value: string, indexSize: 16 | 32): number[] {
  const bytes = Buffer.from(value, 'base64');
  const elementBytes = indexSize / 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += elementBytes) {
    values.push(elementBytes === 4 ? view.getUint32(offset, true) : view.getUint16(offset, true));
  }
  return values;
}

function staticGeometryChunk(offset: number, indexElementBytes: 2 | 4 = 2) {
  return {
    positionsBase64: encodeFloat32([
      offset, 0, 0,
      offset + 1, 0, 0,
      offset, 1, 0
    ]),
    indicesBase64: encodeIndices([0, 1, 2], indexElementBytes),
    indexElementBytes,
    uvsBase64: encodeFloat32([0, 0, 1, 0, 0, 1]),
    normalsBase64: encodeFloat32([0, 1, 0, 0, 1, 0, 0, 1, 0])
  };
}

describe('MAP static geometry chunk 重组', () => {
  it('单 chunk 保留原始几何数据', () => {
    const merged = mergeMapStaticGeometryChunks([staticGeometryChunk(0)]);

    assert.equal(merged.vertexCount, 3);
    assert.equal(merged.indexSize, 16);
    assert.deepEqual(decodeFloat32(merged.positionsBase64!), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual(decodeIndices(merged.indicesBase64!, merged.indexSize!), [0, 1, 2]);
  });

  it('多个 chunk 按返回顺序拼接并重定位索引', () => {
    const merged = mergeMapStaticGeometryChunks([
      staticGeometryChunk(0),
      staticGeometryChunk(10),
      staticGeometryChunk(20)
    ]);

    assert.equal(merged.vertexCount, 9);
    assert.deepEqual(decodeFloat32(merged.positionsBase64!), [
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      10, 0, 0, 11, 0, 0, 10, 1, 0,
      20, 0, 0, 21, 0, 0, 20, 1, 0
    ]);
    assert.deepEqual(decodeIndices(merged.indicesBase64!, merged.indexSize!), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(decodeFloat32(merged.uvsBase64!), [
      0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1
    ]);
  });

  it('空中间或结束 chunk 不丢失有效几何，全部为空时不创建 geometry', () => {
    const merged = mergeMapStaticGeometryChunks([
      staticGeometryChunk(0),
      { positionsBase64: '' },
      staticGeometryChunk(20)
    ]);
    const terminalEmpty = mergeMapStaticGeometryChunks([staticGeometryChunk(0), { positionsBase64: '' }]);
    const allEmpty = mergeMapStaticGeometryChunks([]);

    assert.equal(merged.vertexCount, 6);
    assert.deepEqual(decodeIndices(merged.indicesBase64!, merged.indexSize!), [0, 1, 2, 3, 4, 5]);
    assert.equal(terminalEmpty.vertexCount, 3);
    assert.equal(allEmpty.positionsBase64, undefined);
  });
});

describe('MsbScenePanel 初始结构（挂载即有的三栏骨架）', () => {
  it('工作台根的可访问名是「MSB 地图工作台」', () => {
    assert.match(render(), /aria-label="MSB 地图工作台"/);
  });

  it('三栏 Map Object List | Viewport | Properties 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="Map Object List"/);
    assert.match(html, /aria-label="Viewport"/);
    assert.match(html, /aria-label="Properties"/);
  });

  it('没有为凑四栏造 Tools 空栏', () => {
    const html = render();
    assert.doesNotMatch(html, /aria-label="Tools"/);
  });

  it('未加载 MSB 数据时左栏是显式 muted 空态而不是错误', () => {
    // effect 不跑 → manifest 为 null → 左栏空态。空态是「未加载」而不是失败。
    const html = render();
    assert.match(html, /未加载 MSB 数据：请先在资源浏览器里选择一个 map 资源。/);
    assert.doesNotMatch(html, /className="danger"/);
  });

  it('S19 失败面：openFailure 非空时左栏显示可行动错误块，不再假 0 实体空态', () => {
    const html = render({
      openFailure: {
        code: 'MSB_DOCUMENT_KRAK_OODLE_UNAVAILABLE',
        message: '这份地图是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。'
      }
    });
    assert.match(html, /MSB_DOCUMENT_KRAK_OODLE_UNAVAILABLE/);
    assert.match(html, /到「开始」页选择含 sekiro\.exe 的原版目录后再打开/);
    // 失败态不能再给「未加载」的观感：两者是不同分支。
    assert.doesNotMatch(html, /未加载 MSB 数据/);
    // 工作台可访问名仍在（失败不是白屏）。
    assert.match(html, /aria-label="MSB 地图工作台"/);
  });
});

describe('Negative source tests（MAP-50B 五类覆盖）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'MsbScenePanel.tsx'),
    'utf8'
  );

  it('问题4-B：footer 整段移除——不出现实时模式/提交按钮/微调输入', () => {
    const html = render();
    assert.doesNotMatch(html, /实时模式/);
    assert.doesNotMatch(html, /提交 part 位置/);
    assert.doesNotMatch(html, /提交 region 位置/);
    assert.doesNotMatch(html, /提交 part transform/);
    assert.doesNotMatch(html, /ΔX|rotX|scaleX/);
  });

  it('面板不渲染数值微调输入；只提供真实 Gizmo 模式控件', () => {
    const html = render();
    assert.doesNotMatch(html, /type="number"/);
    assert.match(html, /aria-label="变换模式"/);
    assert.match(html, />移动<|>旋转<|>缩放</);
  });

  it('视口状态不再写「无绝对路径」', () => {
    const html = render({
      parts: [{ name: 'ground', posX: 0, posY: 0, posZ: 0, modelIndex: 0 }],
      models: [{ name: 'm10_00_00_00_000000' }]
    });
    assert.doesNotMatch(html, /无绝对路径/);
    assert.doesNotMatch(html, /见底部日志/);
  });

  it('视口帮助明确提示 Shift+WASD 加速漫游', () => {
    assert.match(panelSource, /Shift\+WASD 加速/);
  });

  it('resolvePartModelName 按 modelIndex 取逻辑名', () => {
    assert.equal(resolvePartModelName({ modelIndex: 1 }, [{ name: 'a' }, { name: 'm10_00_00_00_000080' }]), 'm10_00_00_00_000080');
    assert.equal(resolvePartModelName({}, [{ name: 'a' }]), null);
  });

  it('viewport 只承载 proxy scene 宿主：SSR 下不渲染 canvas/假预览', () => {
    const html = render();
    // scene-host 是空 div（effect 才挂 canvas）；任何假缩略图/假预览都不该出现。
    // 注意 SSR 输出 HTML，className 已序列化为 class。
    assert.match(html, /class="scene-host"/);
    assert.doesNotMatch(html, /<canvas/);
    assert.doesNotMatch(html, /假预览|fakePreview/);
  });

  it('S23/问题4-A：part 模型加载走 mapbnd 读链，按全部 part 报进度「已挂 N / M」', () => {
    const html = render();
    assert.doesNotMatch(html, /无绝对路径/);
    assert.doesNotMatch(html, /见底部日志/);
    assert.match(panelSource, /readMapPartMesh/);
    assert.match(panelSource, /mapbnd/);
    assert.match(panelSource, /FrameTaskQueue/);
    assert.match(panelSource, /MapModelLoadCache/);
    // 进度句：已挂 loaded / total。
    assert.match(panelSource, /已挂 \$\{meshStatus\.loaded\} \/ \$\{meshStatus\.total\}/);
    // S23 去重：按 modelName 去重后串行拉取，同一 FLVER 只读一次
    assert.match(panelSource, /byModel/);
    assert.match(panelSource, /distinctModels/);
  });

  it('左栏对象列表由 scene manifest 派生，renderer 不扫字节、不猜格式', () => {
    assert.match(panelSource, /manifest\??\.entities/);
    assert.match(panelSource, /pick\('msb-route'\)/);
    assert.match(panelSource, /props\.routes/);
    // 注释里提及的函数名只是职责说明，负向断言针对调用——带左括号。
    assert.doesNotMatch(panelSource, /detectNestedFormat\(/);
    assert.doesNotMatch(panelSource, /guessFormatKind\(/);
    assert.doesNotMatch(panelSource, /readFile\(/);
  });

  it('model/event 不制造 3D 能力：只有 part/region 驱动 viewport 高亮', () => {
    // selectEntity 对 part/region 调 handle.setSelected；model/event 仅更新属性表。
    // 断言高亮调用被类型守卫包裹（而不是无条件触发），且守卫里只有两种 kind。
    assert.match(panelSource, /if \(entity\.kind === 'msb-part' \|\| entity\.kind === 'msb-region'\)/);
    assert.match(panelSource, /handleRef\.current\?\.setSelected\(entity\.id\)/);
  });

  it('问题4-B：面板不再持有地图写入回调/写路径', () => {
    assert.doesNotMatch(panelSource, /onPartPositionCommit/);
    assert.doesNotMatch(panelSource, /onPartTransformCommit/);
    assert.doesNotMatch(panelSource, /writeEnabled/);
    assert.doesNotMatch(panelSource, /writeMsbDocument\(/);
  });

  it('问题4-A：不设数据上限；对象完整保留并用虚拟列表限制 DOM，名字不 slice 截断', () => {
    assert.doesNotMatch(panelSource, /MAP_MESH_PREFETCH_LIMIT/);
    assert.doesNotMatch(panelSource, /GROUP_RENDER_LIMIT/);
    assert.doesNotMatch(panelSource, /\.slice\(0,\s*\d+\)\s*\.map\(/);
    assert.doesNotMatch(panelSource, /\.slice\(0,\s*40\)/);
    assert.doesNotMatch(panelSource, /data-testid="msb-region-truncation"/);
    assert.match(panelSource, /useVirtualizer/);
    assert.match(panelSource, /for \(const entity of group\.entries\)/);
    assert.match(panelSource, /getVirtualItems\(\)/);
    assert.match(panelSource, /title=\{row\.entity\.label\}/);
  });

  it('Gizmo 拖动只在结束时提交一次语义变换，模型上传受帧预算调度', () => {
    const controllerSource = readFileSync(
      join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'scene', 'threeSceneController.ts'),
      'utf8'
    );
    assert.match(controllerSource, /pendingTransformChange = \{ id: itemId/);
    assert.match(controllerSource, /if \(pendingTransformChange\) input\.onTransformChange\?\.\(pendingTransformChange\)/);
    assert.match(panelSource, /uploadQueue\s*\.enqueue/);
  });
});
