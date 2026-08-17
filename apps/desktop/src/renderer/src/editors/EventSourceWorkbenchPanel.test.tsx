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
  isSourceReadOnly,
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

  it('S19：文档原子提交 —— 不允许 400 行前缀 / 分片追加 / sourceFillTarget 回归', () => {
    assert.doesNotMatch(panelSource, /SOURCE_PREFIX_LINES|SOURCE_SLICE_LINES/);
    assert.doesNotMatch(panelSource, /appendSourceSlices/);
    assert.doesNotMatch(panelSource, /splitSourceForFirstFrame/);
    assert.doesNotMatch(panelSource, /sourceFillTarget:/);
    assert.match(panelSource, /createCompleteSourceState/);
  });

  it('S19：DarkScript 多通道词法与 $Event 折叠存在', () => {
    assert.match(panelSource, /darkScriptStreamLanguage/);
    assert.match(panelSource, /tokenTable/);
    assert.match(panelSource, /foldService/);
    assert.match(panelSource, /eventBlockFoldRange/);
    assert.match(panelSource, /ComparisonType/);
    assert.match(panelSource, /X\d+_\d+/);
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

describe('DarkScript 源码只读（按钮层与 CodeMirror 创建共用同一判据）', () => {
  it('live DarkScript 也必须只读，不能只靠 !live', () => {
    assert.equal(isSourceReadOnly({
      live: true,
      dslTemplate: '$Event(0, Default, function() {});',
      sourceStyle: 'dark-script'
    }), true);
  });

  it('未标记 dark-script 的 live 模板仍可编辑（写链保留给 patch-dsl）', () => {
    assert.equal(isSourceReadOnly({
      live: true,
      dslTemplate: '$Resource file://event/common.emevd',
      sourceStyle: 'patch-dsl'
    }), false);
  });
});
