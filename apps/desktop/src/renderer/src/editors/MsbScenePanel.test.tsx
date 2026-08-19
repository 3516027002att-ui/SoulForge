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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MsbScenePanel } from './MsbScenePanel.js';

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

  it('问题4-B：面板不再自行渲染任何写入口（无输入框/无按钮）', () => {
    const html = render();
    assert.doesNotMatch(html, /type="number"/);
    assert.doesNotMatch(html, /<button/);
  });

  it('视口状态不再写「无绝对路径」', () => {
    const html = render({
      parts: [{ name: 'ground', posX: 0, posY: 0, posZ: 0, modelIndex: 0 }],
      models: [{ name: 'm10_00_00_00_000000' }]
    });
    assert.doesNotMatch(html, /无绝对路径/);
    assert.doesNotMatch(html, /见底部日志/);
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
    assert.match(panelSource, /applyLoadedMeshes/);
    // 进度句：已挂 loaded / total。
    assert.match(panelSource, /已挂 \$\{meshStatus\.loaded\} \/ \$\{meshStatus\.total\}/);
    assert.match(panelSource, /const targets = parts;/);
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

  it('问题4-B：面板不再持有地图写入回调/写路径', () => {
    assert.doesNotMatch(panelSource, /onPartPositionCommit/);
    assert.doesNotMatch(panelSource, /onPartTransformCommit/);
    assert.doesNotMatch(panelSource, /writeEnabled/);
    assert.doesNotMatch(panelSource, /writeMsbDocument\(/);
  });

  it('问题4-A：不再有预取/分组渲染上限；对象列表全量、名字不 slice 截断', () => {
    assert.doesNotMatch(panelSource, /MAP_MESH_PREFETCH_LIMIT/);
    assert.doesNotMatch(panelSource, /GROUP_RENDER_LIMIT/);
    assert.doesNotMatch(panelSource, /\.slice\(0,\s*\d+\)\s*\.map\(/);
    assert.doesNotMatch(panelSource, /\.slice\(0,\s*40\)/);
    assert.doesNotMatch(panelSource, /data-testid="msb-region-truncation"/);
    assert.match(panelSource, /group\.entries\.map\(/);
    assert.match(panelSource, /title=\{entity\.label\}/);
  });
});
