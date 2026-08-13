/**
 * TEXT-20B：FMG 四栏 Smithbox 式工作台接入后的 renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），而
 * FmgWorkbenchPanel 的条目/目录展示完全由 effect（readTextCatalog → 选表 →
 * readFmgTablePage 分页）驱动，SSR 只能看到挂载即有的骨架与空态。因此这里钉
 * 三类契约：
 *
 * 1. SSR 结构：工作台骨架（区域名、四栏、工具条面包屑）挂载即存在，未选表时
 *    是显式「先选择语言、容器与文本表」空态而不是错误；
 * 2. 纯渲染语义（source contract）：真空表 / 无匹配 / 失败三个空态分离
 *    （muted 空态 vs danger 诊断）、重复 FMG ID 槽位保留（行 map 不去重）、
 *    language→container→table 选择链全部消费 Bridge metadata 的 typed ID；
 * 3. Negative source：renderer 文本面不自解析 msg/ 路径、不构造语言/容器 typed
 *    ID、TPF 不进文本目录、live 失败只上抛诊断且绝不回退到 demo entries、
 *    bridge 出口只有 readTextCatalog + readFmgTablePage 两个 typed 读取。
 *
 * 真实 live 链路（Bridge → ipc → readTextCatalog / readFmgTablePage）由
 * bridge:verify:fmg 与 test:fmg-reference-integrity 覆盖（parse failure、重复
 * FMG ID 的语义判断在 native 层），本文件只钉 renderer 侧的展示与接线约束。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FmgWorkbenchPanel } from './FmgWorkbenchPanel.js';

// node 环境没有 window；getRendererRuntime 会读 window.soulforge。设为空对象 →
// browser-preview 表面 → bridge 为 null → live 路径短路，SSR 输出纯初始结构
// （effect 不跑，目录/分页响应不参与，条目区是挂载即有的空态）。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

function render(entries: unknown[] = []): string {
  return renderToStaticMarkup(
    <FmgWorkbenchPanel
      resourceUri="fixture://msg/zhocn/item.msgbnd.dcx"
      entries={entries as Array<{ id: number; text: string }>}
    />
  );
}

describe('FmgWorkbenchPanel 初始结构（挂载即有的四栏骨架）', () => {
  it('区域名是「FMG 本地化工作台」', () => {
    assert.match(render(), /aria-label="FMG 本地化工作台"/);
  });

  it('四栏 Languages/Containers/File List · Text Entries · Text Content · Tools 同时存在', () => {
    const html = render();
    assert.match(html, /aria-label="Languages\/Containers\/File List"/);
    assert.match(html, /aria-label="Text Entries"/);
    assert.match(html, /aria-label="Text Content"/);
    assert.match(html, /aria-label="Tools"/);
  });

  it('工具条面包屑是「文本」', () => {
    assert.match(render(), /<b>文本<\/b>/);
  });

  it('未选表时不伪装错误：显式「先选择语言、容器与文本表」muted 空态', () => {
    const html = render();
    assert.match(html, /先选择语言、容器与文本表/);
    assert.doesNotMatch(html, /danger/);
  });
});

describe('Negative source tests（TEXT-20B 五类失败覆盖）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'FmgWorkbenchPanel.tsx'),
    'utf8'
  );
  const appSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx'),
    'utf8'
  );

  it('真空表/无匹配/失败三个空态是分离分支：muted 空态与 danger 诊断不共用渲染分支', () => {
    // 真空表（ok 且 0 条）→ muted「当前页无条目」；无匹配（有查询）→ muted
    // 「没有匹配的条目」；失败 → danger pageError。三者不能合并成同一分支，
    // 否则 parse failure 会被伪装成「空表」或「无匹配」——这正是 TEXT-20A Done
    // 禁止的「失败不返回 0 entries」。
    assert.match(panelSource, /pageEntries\.length === 0 && !loading/);
    assert.match(panelSource, /当前页无条目。/);
    assert.match(panelSource, /没有匹配的条目。/);
    assert.match(panelSource, /pageError && <p className="danger">/);
  });

  it('parse failure：live 失败只上抛诊断、不伪装条目，不回退 demo entries', () => {
    // 表分页路径 `!result.ok` → setPageError + setPageEntries([])；demo 回退被
    // `if (liveMode) return;` 挡住，绝不与失败结果合并。
    assert.match(panelSource, /if \(!result\.ok\)/);
    assert.match(panelSource, /setPageError\(result\.diagnostics/);
    assert.match(panelSource, /setPageEntries\(\[\]\)/);
    assert.match(panelSource, /if \(liveMode\) return;/);
  });

  it('语言缺失：typed ID 来自 Bridge metadata，renderer 不解析 msg/ 路径', () => {
    // language/container/table 三级 typed ID 由 readTextCatalog 产出（TEXT-20A
    // Flow）；renderer 只消费 catalog 里的 metadata。出现 .split(/[/\\]/) 或
    // msg[\\/] 字面量就是回到了「从路径猜」。
    assert.doesNotMatch(panelSource, /\.split\(/);
    assert.doesNotMatch(panelSource, /msg[\\/]/);
    // 但选择链必须消费这些 typed ID（否则链上没有 typed 出口）。
    assert.match(panelSource, /readTextCatalog/);
    assert.match(panelSource, /languageId/);
    assert.match(panelSource, /tableId/);
  });

  it('重复 FMG ID：条目行 map 不去重，保留重复槽位（FMG 允许跨组重复 ID，lossless 不丢槽位）', () => {
    // FMG 同一 ID 可能跨组出现两个槽位；面板必须逐槽渲染，不得按 id 去重，
    // 否则 roundtrip 后槽位丢失。语义判断在 native 层，renderer 只保证逐槽展示。
    const rowMap = panelSource.slice(
      panelSource.indexOf('pageEntries.map'),
      panelSource.indexOf('pageEntries.map') + 600
    );
    assert.ok(rowMap.includes('pageEntries.map'), '条目行不是 map 渲染');
    assert.doesNotMatch(rowMap, /\.filter\(|Map\.from|new Set/);
  });

  it('TPF route rejection：文本工作台不引用 tpf/texbnd 读取', () => {
    assert.doesNotMatch(panelSource, /\.tpf|texbnd|tpfDocument|TpfDocument/);
    // App.tsx 的文本装载路径只走 readFmgDocument，不借 TPF route。
    const loadFmgStart = appSource.indexOf('function loadFmg');
    const loadFmgEnd = appSource.indexOf('void loadFmg');
    assert.ok(loadFmgStart >= 0 && loadFmgEnd > loadFmgStart, 'loadFmg 函数未找到，负向断言失锚');
    assert.doesNotMatch(appSource.slice(loadFmgStart, loadFmgEnd), /Tpf|tpf|texbnd/);
  });

  it('工作台桥接调用只有目录与表分页两个 typed 读取出口，写入只经 onMutation（fmg_entry_*）', () => {
    const bridgeCalls = [...panelSource.matchAll(/bridge\.(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    assert.ok(bridgeCalls.length > 0, '工作台没有任何 bridge 调用（目录/分页读取出口缺失）');
    assert.ok(
      bridgeCalls.every((name) => name === 'readTextCatalog' || name === 'readFmgTablePage'),
      `发现非只读桥接调用：${bridgeCalls.filter((n) => n !== 'readTextCatalog' && n !== 'readFmgTablePage').join(', ')}`
    );
    // 写入只以 typed mutation 回调上抛，面板内无 applyFmgMutation / bytes replace。
    assert.doesNotMatch(panelSource, /applyFmgMutation/);
    assert.match(panelSource, /fmg_entry_upsert/);
    assert.match(panelSource, /fmg_entry_delete/);
    assert.match(panelSource, /fmg_entry_add/);
  });

  it('面板 mutation 携带选中表 tableId（TEXT-20C 容器写路由的前置契约）', () => {
    // 容器写需要 entryIndex 定位目标 child；renderer 只知道 typed tableId，由
    // main 的 textTableRefs 转 entryIndex。mutation 必须带上 selectedTableId，
    // 否则 App 侧无法把写路由进 msgbnd/DCX（会退回 loose 写而硬失败）。
    assert.match(panelSource, /selectedTableId/);
    assert.match(panelSource, /tableId: selectedTableId/);
    // demo 模式（无选中表）允许省略 tableId：exactOptionalPropertyTypes 下用
    // 条件展开而不是显式 undefined。
    assert.match(panelSource, /selectedTableId !== null \? \{ tableId: selectedTableId \} : \{\}/);
  });
});
