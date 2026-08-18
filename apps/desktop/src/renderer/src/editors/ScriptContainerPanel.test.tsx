/**
 * S16：脚本 IDE（Files | Source 两栏 / 独立文件单 Source）renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），而
 * ScriptContainerPanel 的形态识别（probeMode）、分页与源码读取都由 effect 驱动。
 * SSR 只能看到挂载即有的骨架与空态；bridge 为 null 时 live 路径短路。
 * 因此这里钉两类契约：
 *
 * 1. SSR 结构：未识别形态时是单 Source 骨架（无 Container/Metadata 栏、
 *    不造四栏 Tools 空栏）。未选中条目时 Source 栏是显式 muted 空态而不是错误；
 * 2. Negative source：解码/判定/反编译/childUri 构造全在 main 侧（renderer
 *    文本面不自解编码、不拼内层地址、不调反编译器）；反编译失败只给结构化
 *    原因，绝不显示 fake hex、不把字节码呈现为可编辑源码；写回统一走
 *    readScriptSource/saveScriptSource（renderer 不直接碰 replaceContainerChild）。
 *
 * 真实 live 链路（Bridge → ipc → readScriptSource → classifyPlaintextBytes /
 * 本机 DSLuaDecompiler）由 e2e 与 core 验证覆盖，本文件只钉 renderer 展示与
 * 接线约束。
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

describe('ScriptContainerPanel 初始结构（挂载未识别形态，单 Source 骨架）', () => {
  it('工作台区域已挂载', () => {
    assert.match(render(), /aria-label="脚本编辑"/);
  });

  it('Source 栏挂载即有；Files/Metadata 不在未识别形态出现', () => {
    const html = render();
    assert.match(html, /aria-label="Source"/);
    assert.doesNotMatch(html, /aria-label="Files"/);
    assert.doesNotMatch(html, /aria-label="Metadata"/);
  });

  it('没有为凑四栏造 Tools/Symbols 空栏', () => {
    const html = render();
    assert.doesNotMatch(html, /aria-label="Tools"/);
    assert.doesNotMatch(html, /aria-label="Symbols"/);
  });

  it('未选条目时 Source 栏是显式 muted 空态而不是错误', () => {
    const html = render();
    assert.match(html, /正在读取脚本源码…/);
    assert.doesNotMatch(html, /className="danger"/);
  });
});

describe('Negative source tests（S16 契约）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'ScriptContainerPanel.tsx'),
    'utf8'
  );

  it('解码/判定/反编译全在 main 侧：renderer 不自解编码、不扫字节、不调反编译器', () => {
    // 明文解码、字节判定、DSLuaDecompiler spawn 都在 main（core plaintextScriptEntry
    // / dsLuaDecompilerLocator + ipc.runDsLuaDecompilerCapture）。renderer 出现解码/
    // 判定/反编译**调用**（带左括号）就是回到了「渲染器二次解析」；注释里提及
    // 函数名只是职责说明，不构成调用，不在负向断言范围。
    assert.doesNotMatch(panelSource, /TextDecoder\(/);
    assert.doesNotMatch(panelSource, /decodePlaintext\(/);
    assert.doesNotMatch(panelSource, /classifyPlaintextBytes\(/);
    assert.doesNotMatch(panelSource, /locateDsLuaDecompilerSync\(/);
    // 但必须消费 main 给出的真实来源与结果（否则「反编译在 main」在 UI 上无出口）。
    assert.match(panelSource, /readScriptSource\(/);
    assert.match(panelSource, /\.kind === 'decompiled'/);
    assert.match(panelSource, /decompiler\b/);
  });

  it('childUri 由 main 构造：renderer 不拼内层地址，只传 resourceUri + 条目名 + index', () => {
    // 内层地址（#bnd/child/…）在 main 侧构造（readScriptSource 按 entryIndex
    // 走 native 读链，见下方 13-A 断言）。renderer 只传 resourceUri + 条目名 +
    // entryIndex（index 是读链主键，不打码后的名字）。
    assert.doesNotMatch(panelSource, /#bnd\/child/);
    assert.match(panelSource, /bridge\.readScriptSource\(/);
    assert.match(panelSource, /entry \? entry\.name : undefined/);
    assert.match(panelSource, /entry \? entry\.index : undefined/);
  });

  it('源码形态必须明示：明文 / 反编译 / 不可编辑都有出口', () => {
    assert.match(panelSource, /'明文源码'/);
    assert.match(panelSource, /'反编译源码'/);
    assert.match(panelSource, /sourceKindLabel/);
    assert.match(panelSource, /source\.kind === 'failure'/);
  });

  it('反编译失败只给结构化原因，绝不显示 fake hex / 不把字节码伪装成可编辑源码', () => {
    // S16 删掉了 HexEditorPanel 与「编译产物，非明文源码」假视图。
    assert.doesNotMatch(panelSource, /HexEditorPanel/);
    assert.doesNotMatch(panelSource, /编译产物，非明文源码/);
    assert.match(panelSource, /不把字节码呈现为可编辑源码/);
    assert.match(panelSource, /不伪造反编译结果/);
  });

  it('写回统一走 saveScriptSource（renderer 不直接调 replaceContainerChild）', () => {
    assert.match(panelSource, /saveScriptSource\(/);
    assert.doesNotMatch(panelSource, /replaceContainerChild\(/);
    assert.doesNotMatch(panelSource, /openReplace\(/);
    // Ctrl+S 应用 + S14 话术（保存回滚通道在 main，renderer 只展示状态）。
    assert.match(panelSource, /'Mod-s'/);
    assert.match(panelSource, /'正在应用…'/);
    assert.match(panelSource, /'已应用，可回滚。'/);
  });

  it('S34：保存时把打开编码回传 main（按打开编码写回），renderer 不自编码', () => {
    assert.match(panelSource, /source\.encoding/);
    assert.doesNotMatch(panelSource, /new TextEncoder\(\)/);
    assert.doesNotMatch(panelSource, /encodePlaintext\(/);
  });

  it('容器形态是两栏 Files | Source：没有 Container/Metadata 栏', () => {
    // 旧三栏（Container/Files、Source/只读反汇编、Metadata）与「用户提供字节的
    // 整内层替换」表单已随 S16 删除。
    assert.doesNotMatch(panelSource, /title: 'Container \/ Files'/);
    assert.doesNotMatch(panelSource, /title: 'Metadata'/);
    assert.doesNotMatch(panelSource, /'Source \/ 只读反汇编'/);
    assert.match(panelSource, /id: 'files', title: 'Files'/);
    assert.match(panelSource, /id: 'source', title: 'Source'/);
  });
});

describe('13-A luabnd 子项按 index 走 native 读链（名字 basename / 失败态无 SFBN）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'ScriptContainerPanel.tsx'),
    'utf8'
  );
  const ipcSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'main', 'ipc.ts'),
    'utf8'
  );
  // 切片到具体 handler，避免把别的通道（save / plaintext 视图）算进来。
  const listHandler = ipcSource.slice(
    ipcSource.indexOf("'resource.listScriptContainerEntriesPage'"),
    ipcSource.indexOf("'resource.readScriptEntryPlaintext'")
  );
  const sourceHandler = ipcSource.slice(
    ipcSource.indexOf("'resource.readScriptSource'"),
    ipcSource.indexOf("'resource.saveScriptSource'")
  );
  const childReader = ipcSource.slice(
    ipcSource.indexOf('function scriptEntryEvidenceFromBridge'),
    ipcSource.indexOf('function clearEditorPageCaches')
  );

  it('列表出站名经 sanitizeEntryName（内层绝对路径不被打成「本机路径已隐藏」）', () => {
    // 列表 handler 只经 scriptEntryEvidenceFromBridge 映射条目（内部做 basename
    // 液化）；禁止直接 `const name = entry.name` 把构建机绝对路径塞进 DTO。
    assert.match(listHandler, /scriptEntryEvidenceFromBridge\(entry, /);
    assert.doesNotMatch(listHandler, /const name = entry\.name/);
    // 液化网关内部调用 sanitizeEntryName。
    assert.match(childReader, /sanitizeEntryName\(/);
  });

  it('读子项走 native 读链（snapshot-bnd4-child），不喂 SFBN 合成链', () => {
    // readScriptSource 按 entryIndex 取字节；不再拼 #bnd/child 走
    // readContainerChild→readSyntheticBnd（真 luabnd 无 SFBN 标记必失败）。
    assert.match(sourceHandler, /readScriptContainerChildByIndex\(/);
    assert.doesNotMatch(sourceHandler, /readContainerChild\(/);
    assert.doesNotMatch(sourceHandler, /const childUri =/);
    assert.match(childReader, /snapshot-bnd4-child/);
    assert.match(childReader, /commandOptions: \{ entryIndex: input\.entryIndex \}/);
  });

  it('失败诊断是中文：SFBN / not authoritative 不进入脚本源码读取链', () => {
    assert.doesNotMatch(sourceHandler, /SFBN|not authoritative/);
    // 真实读失败走中文出口，不把字节码包装成可编辑源码。
    assert.match(sourceHandler, /'读取脚本容器条目失败。'/);
  });

  it('renderer 选择条目带 entry.index：读链以 index 为主键', () => {
    assert.match(panelSource, /selectEntry\(\{ name: entry\.name, index: entry\.index \}\)/);
    assert.match(panelSource, /setSelectedEntry\(entry\)/);
    // 高亮与读链都不再用打码后的名字当主键。
    assert.doesNotMatch(panelSource, /entry\.name === selectedName/);
  });

  it('独立 .hks /.lua 单文件按后缀直接 standalone，不对单文件调分页通道', () => {
    // 面板源码里的 `/\.hks$/i.test(rawUri)` 判定占位（分隔符已转义）。
    assert.match(panelSource, /\.hks\$\/i\.test\(rawUri\)/);
    assert.match(panelSource, /\.lua\$\/i\.test\(rawUri\)/);
    assert.match(panelSource, /setMode\('standalone'\)/);
  });

  it('info 级诊断不得进 pageError：只有 error 才涂红', () => {
    // 「DCX 完整 payload 重建…通过」这类 info 不是失败，不能红字。旧的
    // 「有诊断就涂红」判定被 firstPageError 取代（只放行 severity==='error'）。
    assert.match(panelSource, /firstPageError\(result\.diagnostics\)/);
    assert.match(panelSource, /d\.severity === 'error'/);
    assert.doesNotMatch(panelSource, /if \(result\.diagnostics\.length > 0\)/);
  });
});

describe('S34 脚本全量读写（main 侧按打开编码写回，不硬编码 UTF-8）', () => {
  const ipcSource = readFileSync(
    join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'ipc.ts'),
    'utf8'
  );
  // 从 saveScriptSource 注册处切片到下一个 handler（operation.list）：
  // 容器条目分支与独立文件分支都在这个 handler 里，后面的 handler 不算。
  const saveChain = ipcSource.slice(
    ipcSource.indexOf('resource.saveScriptSource'),
    ipcSource.indexOf("handle('operation.list'")
  );

  it('读取回传 encoding：明文=检测编码，反编译=decompiled', () => {
    assert.match(ipcSource, /encoding: verdict\.detectedEncoding/);
    assert.match(ipcSource, /encoding: 'decompiled'/);
  });

  it('保存按打开编码重新编码：utf8-bom/shift_jis 走 writeEncoding 映射，其余归一 utf8', () => {
    assert.match(ipcSource, /const writeEncoding = /);
    // 编码感知写回由 encodeScriptSourceForWriteback 按原始字节分类完成
    // （明文跟打开编码 / 反编译 UTF-8 / mixed-unknown 拒绝），禁止硬编码 UTF-8。
    assert.match(saveChain, /encodeScriptSourceForWriteback\(read\.bytes, sourceText\)/);
    assert.match(saveChain, /encodeScriptSourceForWriteback\(originalBytes, sourceText\)/);
    assert.doesNotMatch(saveChain, /Buffer\.from\(sourceText, 'utf8'\)/);
  });

  it('独立文件整文件替换走 saveRawReplace（Patch Engine 备份/回滚）', () => {
    assert.match(saveChain, /saveRawReplace\(/);
  });

  it('不再弹「保存脚本源码」确认框：requestWriteConfirmation 只签发静默回执', () => {
    // 确认回执是 Patch Engine 高风险门的凭据，不是弹窗；主进程全仓无 dialog.showMessageBox 调用。
    assert.doesNotMatch(ipcSource, /dialog\.showMessageBox\(/);
    assert.match(ipcSource, /不再弹系统确认框/);
  });
});