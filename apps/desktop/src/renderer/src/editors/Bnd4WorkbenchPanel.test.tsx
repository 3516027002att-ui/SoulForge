/**
 * CONTAINER-40：BND4 三栏容器工作台接入后的 renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），而
 * Bnd4WorkbenchPanel 的条目分页由 effect 驱动（inspectContainerTree →
 * listContainerChildrenPage），SSR 只能看到挂载即有的骨架与空态。因此这里钉两类契约：
 *
 * 1. SSR 结构：三栏 Containers | Entries | Preview / Source 挂载即存在，没有为
 *    凑四栏造 Tools 空栏；未选容器时左栏是显式 muted 空态而不是错误；
 * 2. Negative source：Bytes 只在用户显式选择原始视图时出现（选中不自动读字节）；
 *    未确认子项只读展示、不制造专属能力；Entries 用稳定 child identity
 *    （childId + childUri，不靠可重复文件名）；唯一写路径是用户提供字节的
 *    整个子项替换（无 typed add/delete）。
 *
 * 真实 live 链路（Bridge → ipc → inspectContainerTree / listContainerChildrenPage）
 * 由 bridge:verify:bnd4-writer / bridge:verify:bnd4-transaction 覆盖，本文件只钉
 * renderer 侧的展示与接线约束。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Bnd4WorkbenchPanel } from './Bnd4WorkbenchPanel.js';

// node 环境没有 window；getRendererRuntime 读 window.soulforge。设为空对象 →
// bridge 为 null → live 路径短路，SSR 输出纯初始结构（effect 不跑）。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

function render(): string {
  return renderToStaticMarkup(
    <Bnd4WorkbenchPanel
      resourceUri="fixture://chr/sample.chrbnd.dcx"
      onMutationCommitted={async () => {}}
    />
  );
}

describe('Bnd4WorkbenchPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('区域名是「BND4 容器工作台」', () => {
    assert.match(render(), /aria-label="BND4 容器工作台"/);
  });

  it('三栏 Containers | Entries | Preview / Source 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="Containers"/);
    assert.match(html, /aria-label="Entries"/);
    assert.match(html, /aria-label="Preview \/ Source"/);
  });

  it('没有为凑四栏造 Tools 空栏', () => {
    const html = render();
    assert.doesNotMatch(html, /aria-label="Tools"/);
  });

  it('未选容器时左栏是显式 muted 空态而不是错误', () => {
    const html = render();
    assert.match(html, /选择左侧容器资源后显示工作台。/);
    assert.doesNotMatch(html, /className="danger"/);
  });
});

describe('Negative source tests（CONTAINER-40 五类覆盖）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'Bnd4WorkbenchPanel.tsx'),
    'utf8'
  );

  it('Bytes 只在用户显式选择原始视图时出现：选中不自动读字节', () => {
    // selectChild 里不出现 readContainerChild；读字节只发生在显式的
    // toggleBytes（showBytes 控制）。此前选中即读整个子项字节。
    const selectChildStart = panelSource.indexOf('function selectChild');
    const selectChildEnd = panelSource.indexOf('async function toggleBytes');
    assert.ok(selectChildStart >= 0 && selectChildEnd > selectChildStart, 'selectChild 函数未找到，负向断言失锚');
    assert.doesNotMatch(panelSource.slice(selectChildStart, selectChildEnd), /readContainerChild/);
    assert.match(panelSource, /showBytes/);
    assert.match(panelSource, /查看原始字节（Bytes）/);
  });

  it('未确认子项只读展示，不制造专属能力', () => {
    assert.match(panelSource, /未接入专属编辑器，仅在此只读预览，不制造专属能力/);
    // projection 只标注目标，不自建解析：formatKind 来自 core，renderer 不扫字节
    // （注释里提及函数名只是职责说明，负向断言针对调用——带左括号）。
    assert.doesNotMatch(panelSource, /detectNestedFormat\(/);
    assert.doesNotMatch(panelSource, /guessFormatKind\(/);
  });

  it('Entries 用稳定 child identity（childId + childUri），不靠可重复文件名', () => {
    assert.match(panelSource, /child\.childUri/);
    assert.match(panelSource, /child\.childId/);
    // 行 key 与选中判定都用 childUri，而不是 name。
    assert.match(panelSource, /key=\{child\.childUri\}/);
    assert.match(panelSource, /child\.childUri === selectedChildUri/);
  });

  it('唯一写路径是用户提供字节的整个子项替换，无 typed add/delete', () => {
    assert.match(panelSource, /replaceContainerChild/);
    assert.match(panelSource, /替换字节必须由用户提供/);
    assert.doesNotMatch(panelSource, /addChild/);
    assert.doesNotMatch(panelSource, /deleteChild/);
  });

  it('第一栏只列逻辑容器，不列 backup/cache', () => {
    // backup/cache/audit 由 App 的 artifact-role prefilter 拦在资源树层，
    // 本工作台不出现这些旁路文件。
    assert.doesNotMatch(panelSource, /backup/);
    assert.doesNotMatch(panelSource, /\.cache/);
  });
});
