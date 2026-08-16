/**
 * EVENT-30B：DarkScript3 式 Event 源码工作台 renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），CodeMirror
 * 只在浏览器挂载（useEffect 不执行），因此这里钉两类契约：
 *
 * 1. SSR 结构：DarkScript3 式骨架挂载即有——文档标签栏（role=tablist）、源码主区
 *    （data-editor-engine=codemirror）；T4 后无四钮（查找替换 / Outline / Inspector /
 *    Problems）、无 Outline/Inspector/Problems 面板、无底部 dock；未打开文档时是
 *    显式空态而不是错误。
 * 2. Negative source（EVENT-30B 对照 §11）：不再用 textarea 兜底（source-fallback
 *    消失）；不做 260/320 固定三栏（无 event-source__grid）；Flow / Hex / Raw Bytes
 *    不在默认 viewport；查找走 CodeMirror search keymap（Ctrl+F）；diagnostic gutter
 *    用 GutterMarker；dirty 标记 per-tab；renderer 不持有文件系统路径。
 *
 * 真实多 tab 交互（键盘、IME、large source、多 tab dirty、Go to Event、查找面板）
 * 由 renderer E2E（renderer.spec.mjs）覆盖——它们需要真实 DOM 与 CodeMirror。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EventSourceWorkbenchPanel,
  baselineText,
  buildInspectorRows,
  isSourceReadOnly,
  parseInspectorCall,
  type EventSourceTabData
} from './EventSourceWorkbenchPanel.js';
import type { EmevdEditorDocument } from '@soulforge/shared';

// node 环境没有 window；组件 SSR 不读 window（CM 不在服务端挂载），但置空对象
// 保持与 FmgWorkbenchPanel 测试一致的隔离姿态。
(globalThis as unknown as { window: Record<string, unknown> }).window = {};

const DOCUMENT: EmevdEditorDocument = {
  schemaVersion: 1,
  resourceUri: 'file://event/common.emevd',
  revision: 1,
  events: [
    {
      eventUri: 'file://event/common.emevd#event/50',
      eventId: 50,
      restBehavior: 1,
      layer: -1,
      instructions: [
        {
          instructionUri: 'file://event/common.emevd#event/50/instr/0',
          bank: 9999,
          id: 1,
          argsBase64: '',
          unknown: true,
          anchor: { documentInstanceId: 'doc-1', localNodeId: 'i0', sourceFingerprint: 'fp' }
        }
      ],
      anchor: { documentInstanceId: 'doc-1', localNodeId: 'e50', sourceFingerprint: 'fp' }
    },
    {
      eventUri: 'file://event/common.emevd#event/60',
      eventId: 60,
      restBehavior: 0,
      layer: -1,
      instructions: [],
      anchor: { documentInstanceId: 'doc-1', localNodeId: 'e60', sourceFingerprint: 'fp' }
    }
  ],
  bytesBase64: '',
  diagnostics: [
    { severity: 'warning', code: 'EMEVD_UNKNOWN_INSTRUCTION', message: 'bank 9999 id 1 未知。' }
  ],
  documentInstanceId: 'doc-1'
};

function render(pendingTab: EventSourceTabData | null = null): string {
  return renderToStaticMarkup(
    <EventSourceWorkbenchPanel pendingTab={pendingTab} />
  );
}

describe('EventSourceWorkbenchPanel SSR 结构（DarkScript3 式骨架挂载即有）', () => {
  it('区域名是「Event 源码工作台」', () => {
    assert.match(render(), /aria-label="Event 源码工作台"/);
  });

  it('文档标签栏 role=tablist 存在，未打开文档时是显式空态', () => {
    const html = render();
    assert.match(html, /role="tablist"/);
    assert.match(html, /暂无打开的事件文档。/);
  });

  it('T4：无 查找替换 / Outline / Inspector / Problems 四钮，无「选中节点」面板', () => {
    const html = render();
    assert.doesNotMatch(html, />查找替换<\/button>/);
    assert.doesNotMatch(html, />Outline<\/button>/);
    assert.doesNotMatch(html, />Inspector<\/button>/);
    assert.doesNotMatch(html, />Problems<\/button>/);
    assert.doesNotMatch(html, /选中节点/);
  });

  it('源码主区用 CodeMirror 引擎挂载位（data-editor-engine=codemirror）', () => {
    assert.match(render(), /data-editor-engine="codemirror"/);
  });

  it('T4：Outline / Inspector / Problems 一律不渲染', () => {
    const html = render();
    assert.doesNotMatch(html, /aria-label="事件大纲"/);
    assert.doesNotMatch(html, /aria-label="事件检查器"/);
    assert.doesNotMatch(html, /aria-label="事件问题"/);
  });
});

describe('Negative source tests（EVENT-30B 对照 §11）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'EventSourceWorkbenchPanel.tsx'),
    'utf8'
  );

  it('不再用 textarea 兜底编辑（source-fallback 消失，只保留 CodeMirror 挂载位）', () => {
    assert.doesNotMatch(panelSource, /data-editor-engine="source-fallback"/);
    assert.doesNotMatch(panelSource, /<textarea/);
    assert.match(panelSource, /data-editor-engine="codemirror"/);
  });

  it('不做 260/320 固定三栏：无 event-source__grid，也无 esw-dock（Problems 全删）', () => {
    assert.doesNotMatch(panelSource, /event-source__grid/);
    assert.doesNotMatch(panelSource, /event-source__problems/);
    assert.doesNotMatch(panelSource, /esw-dock/);
  });

  it('Flow / Hex / Raw Bytes 不在默认 viewport（SSR 骨架不含这些面板，原始 bytes 只能经 Developer Diagnostics）', () => {
    const html = render();
    assert.doesNotMatch(html, /\bFlow\b/);
    assert.doesNotMatch(html, /\bHex\b/);
    assert.doesNotMatch(html, /Raw Bytes/);
  });

  it('T4：查找走 CodeMirror search keymap（Ctrl+F），不渲染工具条查找钮', () => {
    assert.match(panelSource, /from '@codemirror\/search'/);
    assert.match(panelSource, /searchKeymap/);
    assert.doesNotMatch(panelSource, /openSearchPanel/);
  });

  it('T4-3：EMEDF 指令名 autocomplete（Ctrl+Space + 输入时）与悬停参数名列表', () => {
    assert.match(panelSource, /readEmedfCompletionCatalog/);
    assert.match(panelSource, /autocompletion\(\{ override: \[createCompletionSource/);
    assert.match(panelSource, /hoverTooltip\(createHoverTooltipSource/);
    assert.match(panelSource, /createCompletionSource/);
    // 只读 EMEDF 公开字段；不携带「加载完整源码」入口。
    assert.doesNotMatch(panelSource, /loadFullDslTemplate/);
  });

  it('diagnostic gutter 用 GutterMarker（未知指令 → event 块行 warning 记号）', () => {
    assert.match(panelSource, /class EventDiagMarker extends GutterMarker/);
    assert.match(panelSource, /lineMarker\(view, line\)/);
    assert.match(panelSource, /_eventLineInfo/);
  });

  it('多 tab dirty 标记 per-tab（esw-tab__dirty），dirty 只在工作台内部维护', () => {
    assert.match(panelSource, /esw-tab__dirty/);
    assert.match(panelSource, /dirty: boolean/);
    assert.match(panelSource, /per-tab EditorState/);
  });

  it('renderer 不持有文件系统路径：无本地盘符路径字面量', () => {
    assert.doesNotMatch(panelSource, /[A-Za-z]:[\\/][A-Za-z0-9_]/);
  });

  it('文档标签是逻辑 EMEVD 文档（tabId=资源 URI），不是扫描的物理文件计数', () => {
    assert.match(panelSource, /tabId: string/);
    assert.match(panelSource, /按 tabId 去重/);
  });
});

describe('S15 事件失败面：读取失败时源码区给可行动句，禁止假 resource 源码', () => {
  const FAILED_DOCUMENT: EmevdEditorDocument = {
    schemaVersion: 1,
    resourceUri: 'file://event/m11_02_71_10.emevd.dcx',
    revision: 1,
    events: [],
    bytesBase64: '',
    diagnostics: [{
      severity: 'error',
      code: 'EMEVD_DOCUMENT_KRAK_OODLE_UNAVAILABLE',
      message: '这份事件是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。'
    }],
    documentInstanceId: 'doc-failed'
  };

  function failedTab(diagnostic: { severity: 'error' | 'info' | 'warning'; code: string; message: string }): EventSourceTabData {
    return {
      tabId: 'file://event/m11_02_71_10.emevd.dcx',
      title: 'm11_02_71_10',
      resourceUri: 'file://event/m11_02_71_10.emevd.dcx',
      document: { ...FAILED_DOCUMENT, diagnostics: [diagnostic] },
      sourceHash: null,
      live: false,
      dslTemplate: null,
      dslTemplateTruncated: false,
      dslTemplateTotalLines: 0,
      sourceStyle: 'none'
    };
  }

  it('KRAK 缺 Oodle：源码区是 code + Bridge 可行动句，不再画 resource "file://…"', () => {
    const text = baselineText(failedTab({
      severity: 'error',
      code: 'EMEVD_DOCUMENT_KRAK_OODLE_UNAVAILABLE',
      message: '这份事件是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。'
    }));
    assert.match(text, /EMEVD_DOCUMENT_KRAK_OODLE_UNAVAILABLE/);
    assert.match(text, /到「开始」页选择含 sekiro\.exe 的原版目录后再打开/);
    assert.doesNotMatch(text, /resource "file:\/\/event\//);
  });

  it('其它读取失败：code + 人话 + 下一步（下一步只在 message 未含「开始」时追加）', () => {
    const text = baselineText(failedTab({
      severity: 'error',
      code: 'EMEVD_DOCUMENT_READ_FAILED',
      message: 'EMEVD 事件表解析失败。'
    }));
    assert.match(text, /EMEVD_DOCUMENT_READ_FAILED/);
    assert.match(text, /EMEVD 事件表解析失败/);
    assert.match(text, /下一步/);
    assert.doesNotMatch(text, /resource "file:\/\/event\//);
  });

  it('无 error/warning 诊断的失败 tab 退回 renderSource 旧基线（不凭空编失败句）', () => {
    const tab = failedTab({ severity: 'error', code: 'X', message: 'y' });
    const text = baselineText({
      ...tab,
      document: { ...tab.document, diagnostics: [{ severity: 'info', code: 'INFO', message: '记录' }] }
    });
    // 退回 renderSource：既有投影（resource 行 + 事件块），但**不**出现失败句。
    assert.doesNotMatch(text, /事件脚本读不出来/);
    assert.match(text, /resource/);
  });

  it('live + 无模板仍是 EMEDF 缺失失败关闭（不混淆两条失败路径）', () => {
    const tab: EventSourceTabData = {
      ...failedTab({ severity: 'error', code: 'X', message: 'y' }),
      live: true
    };
    const text = baselineText(tab);
    assert.match(text, /未找到用户本机 EMEDF/);
  });
});

describe('S14：DarkScript 源码可编辑（去橙头 / 去黄条 / 去只读锁）', () => {
  it('live DarkScript 不再只读：$Event 源码可编辑（写链是反汇编形状对齐编译器）', () => {
    assert.equal(isSourceReadOnly({
      live: true,
      dslTemplate: '$Event(0, Default, function() {});',
      sourceStyle: 'dark-script'
    }), false);
  });

  it('不可编只剩两类：非 live（读取失败）与无 dslTemplate（EMEDF 缺失失败关闭）', () => {
    assert.equal(isSourceReadOnly({
      live: false,
      dslTemplate: 'x',
      sourceStyle: 'dark-script'
    }), true);
    assert.equal(isSourceReadOnly({
      live: true,
      dslTemplate: null,
      sourceStyle: 'dark-script'
    }), true);
  });

  it('没有橙色头（EVENT / SOURCE 眉题与 h2 都不渲染）', () => {
    const html = render();
    assert.doesNotMatch(html, /EVENT \/ SOURCE/);
    assert.doesNotMatch(html, /event-source__header/);
    assert.doesNotMatch(html, />事件源码工作台<\/h2>/);
  });

  it('没有日常黄条（只读展示 / 写入仍经 Bridge 与补丁引擎 字样不出现）', () => {
    const html = render();
    assert.doesNotMatch(html, /反汇编源码只读/);
    assert.doesNotMatch(html, /本版只读展示/);
    assert.doesNotMatch(html, /写入仍经 Bridge/);
    assert.doesNotMatch(html, /补丁引擎/);
  });

  it('没有「编译并提交」按钮；工具条只留查找/保存提示', () => {
    const html = render();
    assert.doesNotMatch(html, />编译并提交</);
    assert.doesNotMatch(html, /提交中…/);
    assert.match(html, /查找：Ctrl\+F/);
    assert.match(html, /保存：Ctrl\+S/);
  });

  it('Ctrl+S 进 CodeMirror keymap（Mod-s 保存当前源码）', () => {
    const panelSource = readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'EventSourceWorkbenchPanel.tsx'),
      'utf8'
    );
    assert.match(panelSource, /key: 'Mod-s'/);
  });

  it('保存失败提示是结构化诊断，不带「见底部日志」', () => {
    const html = render();
    // 就绪态不渲染 status；有状态变化时 role="status" 承载诊断文案。
    assert.doesNotMatch(html, /见底部日志/);
    const panelSource = readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'EventSourceWorkbenchPanel.tsx'),
      'utf8'
    );
    assert.match(panelSource, /role="status"/);
  });
});

describe('S31 右栏词义：选中语句 → EMEDF 参数说明（纯函数）', () => {
  it('parseInspectorCall：普通调用行解析出名字与参数值', () => {
    const result = parseInspectorCall('InitializeEvent(0,77770001,0)');
    assert.equal(result.kind, 'call');
    if (result.kind === 'call') {
      assert.equal(result.call.name, 'InitializeEvent');
      assert.deepEqual(result.call.args, [0, 77770001, 0]);
    }
  });

  it('parseInspectorCall：WaitFor 折叠块拆成 predicate 列表（数字/布尔）', () => {
    const result = parseInspectorCall('WaitFor(IfPlayerHasItem(6,2498)&&IfCharacterHasSpEffect(10000,127800));');
    assert.equal(result.kind, 'wait');
    if (result.kind === 'wait') {
      assert.equal(result.predicates.length, 2);
      assert.deepEqual(result.predicates[0]!.args, [6, 2498]);
      assert.deepEqual(result.predicates[1]!.args, [10000, 127800]);
    }
  });

  it('parseInspectorCall：事件头 / 注释 / 空行 → none', () => {
    assert.equal(parseInspectorCall('$Event(0,Default,function(){').kind, 'none');
    assert.equal(parseInspectorCall('//unknownbank=9999id=7').kind, 'none');
  });

  it('parseInspectorCall：无法解析的行 → unparseable', () => {
    assert.equal(parseInspectorCall('&&IfCharacterHasSpEffect(10000,127800));').kind, 'unparseable');
    assert.equal(parseInspectorCall('Name(abc);').kind, 'unparseable');
  });

  it('buildInspectorRows：命中 EMEDF 目录 → 每参数名/类型/当前值', () => {
    const catalog = [{
      name: 'InitializeEvent', bank: 2000, id: 0,
      args: [
        { name: 'eventSlotId', type: 's32' as const },
        { name: 'eventId', type: 'u32' as const },
        { name: 'params', type: 'u32' as const, vararg: true }
      ]
    }];
    const { rows, unknownNames } = buildInspectorRows(
      { kind: 'call', call: { name: 'InitializeEvent', args: [9, 77770002, 0] } },
      catalog
    );
    assert.equal(unknownNames.length, 0);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.bank, 2000);
    assert.equal(row.id, 0);
    assert.equal(row.args.length, 3);
    assert.deepEqual(row.args.map((a) => [a.name, a.value]), [
      ['eventSlotId', '9'],
      ['eventId', '77770002'],
      ['params', '0']
    ]);
  });

  it('buildInspectorRows：同名的不同 bank:id 全部列出（不猜歧义）', () => {
    const catalog = [
      { name: 'IfPlayerHasItem', bank: 4, id: 10, args: [{ name: 'resultConditionGroup', type: 's8' as const }, { name: 'itemType', type: 'u32' as const }, { name: 'itemId', type: 'u32' as const }] },
      { name: 'IfPlayerHasItem', bank: 5, id: 77, args: [{ name: 'other', type: 's8' as const }] }
    ];
    const { rows } = buildInspectorRows(
      { kind: 'call', call: { name: 'IfPlayerHasItem', args: [1, 6, 2498] } },
      catalog
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.bank), [4, 5]);
  });

  it('buildInspectorRows：WaitFor predicate 的 conditionGroup 簿记参数标「折叠隐藏」', () => {
    const catalog = [{
      name: 'IfPlayerHasItem', bank: 4, id: 10,
      args: [
        { name: 'resultConditionGroup', type: 's8' as const },
        { name: 'itemType', type: 'u32' as const },
        { name: 'itemId', type: 'u32' as const }
      ]
    }];
    const { rows } = buildInspectorRows(
      { kind: 'wait', predicates: [{ name: 'IfPlayerHasItem', args: [6, 2498] }] },
      catalog
    );
    const args = rows[0]!.args;
    assert.equal(args[0]!.hidden, true);
    assert.equal(args[0]!.value, '（折叠隐藏）');
    assert.deepEqual(args.slice(1).map((a) => a.value), ['6', '2498']);
  });

  it('buildInspectorRows：目录匹配不到的名字进 unknownNames（诚实未解码）', () => {
    const { rows, unknownNames } = buildInspectorRows(
      { kind: 'call', call: { name: 'MysteryOp', args: [1] } },
      []
    );
    assert.equal(rows.length, 0);
    assert.deepEqual(unknownNames, ['MysteryOp']);
  });

  it('SSR 骨架含词义栏与空态', () => {
    const html = render();
    assert.match(html, /aria-label="事件源码说明"/);
    assert.match(html, /选中一条语句查看参数说明。/);
  });

  it('分栏按钮与每列独立 host（data-tab-id）存在，列间不共享编辑器', () => {
    const html = render();
    assert.match(html, /分栏 1/);
    const panelSource = readFileSync(
      join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'EventSourceWorkbenchPanel.tsx'),
      'utf8'
    );
    assert.match(panelSource, /data-tab-id=\{tab\.tabId\}/);
    assert.match(panelSource, /setColumnCount/);
    assert.match(panelSource, /每个 tab 列一个 host \+ 一个 EditorView/);
  });
});
