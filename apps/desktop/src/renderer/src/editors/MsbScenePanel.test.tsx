/**
 * MAP-50B：MSB 三栏地图工作台接入后的 renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），而
 * MsbScenePanel 的 3D 场景由 effect 驱动（buildMsbSceneManifest →
 * mountThreeProxyScene），SSR 只能看到挂载即有的骨架与空态。因此这里钉两类契约：
 *
 * 1. SSR 结构：三栏 Map Object List | Viewport | Properties 挂载即存在，
 *    没有为凑四栏造 Tools 空栏；未加载 MSB 数据时左栏是显式 muted 空态而不是错误；
 * 2. Negative source：deferred（msb 目前处于延期只读预览）时整个 footer 只有延期
 *    提示，没有任何保存动作；viewport 只承载 proxy scene 宿主（SSR 下无 canvas、
 *    无假缩略图/假预览）；左栏对象列表由 scene manifest 派生而不是 renderer 扫字节；
 *    唯一写路径（非 deferred）也只走 Bridge commit 回调，不自行解析字节。
 *
 * 真实 live 链路（Bridge → ipc → readMsbDocument → mountThreeProxyScene）由
 * bridge:verify:msb-all 与 E2E 覆盖，本文件只钉 renderer 侧的展示与接线约束。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MsbScenePanel } from './MsbScenePanel.js';

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
});

describe('Negative source tests（MAP-50B 五类覆盖）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'MsbScenePanel.tsx'),
    'utf8'
  );

  it('deferred（只读预览）时无保存动作：整个 footer 只有延期提示', () => {
    const html = render({ deferredPreviewRelease: 'V0.6' });
    assert.match(html, /只读预览，无位置提交入口/);
    assert.doesNotMatch(html, /提交 part 位置/);
    assert.doesNotMatch(html, /提交 region 位置/);
    assert.doesNotMatch(html, /提交 part transform/);
    assert.doesNotMatch(html, /type="number"/);
  });

  it('非 deferred 时才出现提交入口，且 writer 未开放时按钮存在但仅本地预览', () => {
    const html = render({ writeEnabled: false });
    assert.match(html, /提交 part 位置/);
    assert.match(html, /disabled/);
    assert.match(html, /MSB 写入未开放：微调仅为本地预览，不会写入。/);
  });

  it('viewport 只承载 proxy scene 宿主：SSR 下不渲染 canvas/假预览', () => {
    const html = render();
    // scene-host 是空 div（effect 才挂 canvas）；任何假缩略图/假预览都不该出现。
    // 注意 SSR 输出 HTML，className 已序列化为 class。
    assert.match(html, /class="scene-host"/);
    assert.doesNotMatch(html, /<canvas/);
    assert.doesNotMatch(html, /假预览|fakePreview/);
  });

  it('左栏对象列表由 scene manifest 派生，renderer 不扫字节、不猜格式', () => {
    assert.match(panelSource, /manifest\??\.entities/);
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

  it('写路径只走 Bridge commit 回调，不在 renderer 侧碰字节', () => {
    // commitNudge/commitTransform 只构造参数交给 onPartPositionCommit 等回调。
    assert.match(panelSource, /props\.onPartPositionCommit/);
    assert.match(panelSource, /props\.onPartTransformCommit/);
    assert.doesNotMatch(panelSource, /writeMsbDocument\(/);
  });
});
