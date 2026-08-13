/**
 * TEXTURE-52B：TpfWorkbenchPanel 的渲染结构 + 负向清单。
 *
 * 三条主线：
 * 1. SSR 结构断言：真渲染 TpfWorkbenchPanel（react-dom/server），钉住工作台
 *    骨架 —— 工具条面包屑、Containers/Textures/Viewer/Properties 四栏、各栏
 *    空态引导。SSR 不跑 effect，所以这里看到的是「挂载即有的结构」，异步读取
 *    由 e2e 负责。
 * 2. 纯逻辑断言：containerDisplayName 去扩展（物理路径只在 title）。
 * 3. Negative source tests：写入**只有** read（TEXTURE-52C 才接 replace）——
 *    无 type=button（初始无选中即无分页/替换控件）；无字节直写；无 3D
 *    viewport（不渲染 canvas）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TpfWorkbenchPanel, type TpfContainerView } from './TpfWorkbenchPanel.js';

// node 环境没有 window，而 getRendererBridge 会读 window.soulforge —— 不设
// 会在渲染时 ReferenceError。设为空对象 → browser-preview 表面 → bridge 为
// null → 组件里的桥接 effect 全部短路，SSR 输出纯初始结构。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

const containers: TpfContainerView[] = [
  { sourceUri: 'fixture://menu/start.tpf.dcx', relativePath: 'menu/start.tpf.dcx' },
  { sourceUri: 'fixture://menu/broken.tpf.dcx', relativePath: 'menu/broken.tpf.dcx' }
];

function render(initialUri?: string): string {
  return renderToStaticMarkup(
    <TpfWorkbenchPanel containers={containers} {...(initialUri ? { initialUri } : {})} />
  );
}

describe('TpfWorkbenchPanel 初始结构（挂载即有的骨架）', () => {
  it('工作台有可访问名', () => {
    const html = render();
    assert.match(html, /aria-label="Texture 工作台"/);
  });

  it('四栏 Containers/Textures/Viewer/Properties 同时存在（TEXTURE-52B）', () => {
    const html = render();
    assert.match(html, /aria-label="Containers"/);
    assert.match(html, /aria-label="Textures"/);
    assert.match(html, /aria-label="Viewer"/);
    assert.match(html, /aria-label="Properties"/);
  });

  it('Containers 栏列出全部容器，显示名去扩展，物理路径只在 title', () => {
    const html = render();
    assert.match(html, /start/);
    assert.match(html, /broken/);
    // 显示名去 .tpf.dcx；title 保留完整相对路径（metadata details）。
    assert.doesNotMatch(html, />start\.tpf\.dcx</);
    assert.match(html, /title="menu\/start\.tpf\.dcx"/);
  });

  it('标题是 §2.5 正确形态：Texture · N containers', () => {
    const html = render();
    assert.match(html, /Texture · 2 containers/);
  });

  it('未选容器时各栏给出引导空态', () => {
    const html = render();
    assert.match(html, /先在最左栏选择一个容器/);
    assert.match(html, /在中间选择一张纹理查看预览/);
    assert.match(html, /选择一张纹理查看元数据/);
  });

  it('初始渲染无任何 type=button（无假 replace / 无多余控件）', () => {
    const html = render();
    assert.doesNotMatch(html, /type="button"/);
  });

  it('无 3D viewport：不渲染 canvas 或视图容器（§2.5 TEXTURE 无 3D viewport）', () => {
    const html = render();
    assert.doesNotMatch(html, /<canvas/i);
  });
});

describe('TpfWorkbenchPanel 纯逻辑（显示名）', () => {
  it('container 显示名去 .tpf.dcx 与 .tpf', () => {
    assert.match(render(), /<span class="wb-row__name"[^>]*>start<\/span>/);
    assert.doesNotMatch(render(), />start\.tpf\.dcx</);
  });
});

describe('Negative source tests（TEXTURE-52B）', () => {
  const repoRoot = process.cwd();
  const workbenchSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'TpfWorkbenchPanel.tsx'),
    'utf8'
  );

  it('渲染侧桥接调用只有 read，无任何写出口（52C 才接 replace）', () => {
    const bridgeCalls = [...workbenchSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(bridgeCalls.length > 0, '工作台没有任何 bridge 调用（read 通道缺失）');
    assert.ok(
      bridgeCalls.every((name) => name.startsWith('read')),
      `发现非 read 桥接调用：${bridgeCalls.filter((n) => !n.startsWith('read')).join(', ')}`
    );
  });

  it('无字节直写（不能有 contentBase64 / dataBase64 fallback）', () => {
    assert.doesNotMatch(workbenchSource, /contentBase64|dataBase64/);
  });

  it('writer 未就绪时隐藏 replace：Properties 栏给诚实说明，无替换控件', () => {
    assert.match(workbenchSource, /纹理写回链尚未接通/);
    assert.match(workbenchSource, /没有 replace 入口/);
    // 不渲染任何 replace 按钮：渲染侧没有 replace 相关 button 文案。
    assert.doesNotMatch(workbenchSource, />replace</i);
  });

  it('无 3D viewport：不引用 three / canvas / FlverViewer', () => {
    assert.doesNotMatch(workbenchSource, /three|FlverViewer|<canvas/i);
  });

  it('预览失败保留列表：失败诊断渲染在 Viewer 栏，选择链不清空', () => {
    // preview failure isolation 的形态：纹理列表不因预览失败而清空，Viewer
    // 栏独立渲染失败诊断（tpf-preview-failure）。
    assert.match(workbenchSource, /previewFailure/);
    assert.match(workbenchSource, /data-testid="tpf-preview-failure"/);
    // 选中纹理的读取与预览失败互不影响：纹理列表渲染不依赖 preview 状态。
    assert.doesNotMatch(workbenchSource, /previewFailure && \(\s*<div className="wb-list"/);
  });

  it('截断说明走 formatListTruncation 且保留 tpf-truncation testId（listTruncation 契约）', () => {
    assert.match(workbenchSource, /formatListTruncation/);
    assert.match(workbenchSource, /data-testid="tpf-truncation"/);
  });
});
