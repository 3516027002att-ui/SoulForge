/**
 * SCRIPT-41：脚本容器三栏工作台接入后的 renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），而
 * ScriptContainerPanel 的条目分页与源码视图都由 effect 驱动（listScriptContainerEntriesPage
 * → 选中 → readScriptEntryPlaintext），SSR 只能看到挂载即有的骨架与空态。因此这里钉两类契约：
 *
 * 1. SSR 结构：三栏 Container/Files | Source/只读反汇编 | Metadata 挂载即存在，
 *    没有为凑四栏造 Tools 空栏；未选条目时中栏是显式 muted 空态而不是错误；
 * 2. Negative source：解码/判定/换行统计/childUri 构造全部在 main 侧（renderer
 *    文本面不自解编码、不拼内层地址）；字节码条目只展示只读字节视图、绝不伪装
 *    成可编辑源码；唯一写路径是用户提供字节的整内层文件替换。
 *
 * 真实 live 链路（Bridge → ipc → readScriptEntryPlaintext → classifyPlaintextBytes
 * / decodePlaintext）由 test:script-container-evidence / test:plaintext-script-write
 * 覆盖，本文件只钉 renderer 侧的展示与接线约束。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScriptContainerPanel } from './ScriptContainerPanel.js';

// node 环境没有 window；getRendererRuntime 读 window.soulforge。设为空对象 →
// bridge 为 null → live 路径短路，SSR 输出纯初始结构（effect 不跑）。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

function render(): string {
  return renderToStaticMarkup(
    <ScriptContainerPanel
      resourceUri="fixture://script/m25_00_00_00.luabnd.dcx"
      onMutationCommitted={async () => {}}
    />
  );
}

describe('ScriptContainerPanel 初始结构（挂载即有的三栏骨架）', () => {
  it('区域名是「脚本容器工作台」', () => {
    assert.match(render(), /aria-label="脚本容器工作台"/);
  });

  it('三栏 Container/Files | Source/只读反汇编 | Metadata 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="Container \/ Files"/);
    assert.match(html, /aria-label="Source \/ 只读反汇编"/);
    assert.match(html, /aria-label="Metadata"/);
  });

  it('没有为凑四栏造 Tools 空栏', () => {
    const html = render();
    assert.doesNotMatch(html, /aria-label="Tools"/);
    assert.doesNotMatch(html, /aria-label="Symbols"/);
  });

  it('未选条目时中栏是显式 muted 空态而不是错误', () => {
    const html = render();
    assert.match(html, /选择左侧条目后显示源码级只读视图。/);
    assert.doesNotMatch(html, /className="danger"/);
  });
});

describe('Negative source tests（SCRIPT-41 六类覆盖）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'ScriptContainerPanel.tsx'),
    'utf8'
  );

  it('解码/判定/换行统计全在 main 侧：renderer 不自解编码、不扫字节', () => {
    // 明文解码、Shift-JIS、可打印比例、尾部填充都在 main（core plaintextScriptEntry）。
    // renderer 出现解码/判定**调用**（带左括号）就是回到了「渲染器二次解析」；
    // 注释里提及函数名只是职责说明，不构成调用，不在负向断言范围。
    assert.doesNotMatch(panelSource, /TextDecoder\(/);
    assert.doesNotMatch(panelSource, /decodePlaintext\(/);
    assert.doesNotMatch(panelSource, /classifyPlaintextBytes\(/);
    // 但必须消费 main 给出的真实判定字段（否则「真实字节判定」在 UI 上无出口）。
    assert.match(panelSource, /readScriptEntryPlaintext\(/);
    assert.match(panelSource, /isPlaintext/);
  });

  it('childUri 由 main 构造：renderer 不拼内层地址', () => {
    // 内层地址（#bnd/child/…）构造在 ipc.ts 的 readScriptEntryPlaintext。
    // renderer 只传 resourceUri + entryName。
    assert.doesNotMatch(panelSource, /#bnd\/child/);
    assert.match(panelSource, /readScriptEntryPlaintext\(props\.resourceUri, entryName\)/);
  });

  it('encoding/BOM/newline/NUL 明示：四类证据都在源码主区有出口', () => {
    assert.match(panelSource, /encodingLabel/);
    assert.match(panelSource, /hasBom/);
    assert.match(panelSource, /newlines\.crlf/);
    assert.match(panelSource, /trailingPaddingBytes/);
    assert.match(panelSource, /containsNul/);
  });

  it('字节码不伪装可编辑源码：只展示只读字节视图', () => {
    // 字节码分支必须明确「绝不显示为可编辑源码」，且只给 Hex 只读证据。
    assert.match(panelSource, /绝不显示为可编辑源码/);
    assert.match(panelSource, /编译产物，非明文源码/);
    assert.match(panelSource, /HexEditorPanel/);
  });

  it('唯一写路径是用户提供字节的整内层文件替换，不生成字节码', () => {
    assert.match(panelSource, /replaceContainerChild/);
    assert.match(panelSource, /替换字节必须由用户提供/);
    // 不出现「编辑字节码文本 → 写回」的实现（没有编译器）：面板只消费
    // main 的只读视图，不构建任何明文脚本编辑操作。
    assert.doesNotMatch(panelSource, /buildPlaintextScriptEdit/);
    assert.doesNotMatch(panelSource, /encodePlaintext/);
  });

  it('三栏不用四栏模板：没有 Symbol/Tools 占位标题', () => {
    assert.doesNotMatch(panelSource, /title: 'Symbols'/);
    assert.doesNotMatch(panelSource, /title: 'Tools'/);
  });
});
