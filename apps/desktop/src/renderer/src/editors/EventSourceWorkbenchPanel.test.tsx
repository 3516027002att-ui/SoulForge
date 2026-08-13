/**
 * EVENT-30B：DarkScript3 式 Event 源码工作台 renderer 单元测试。
 *
 * renderer-unit 是纯 node SSR（react-dom/server，无 DOM、不跑 effect），CodeMirror
 * 只在浏览器挂载（useEffect 不执行），因此这里钉两类契约：
 *
 * 1. SSR 结构：DarkScript3 式骨架挂载即有——文档标签栏（role=tablist）、工具条
 *    （查找替换 / Outline / Inspector / Problems）、源码主区（data-editor-engine=
 *    codemirror）、Problems 底部 dock 默认展开；Outline / Inspector 默认不渲染
 *    （仅显式打开）；未打开文档时是显式空态而不是错误。
 * 2. Negative source（EVENT-30B 对照 §11）：不再用 textarea 兜底（source-fallback
 *    消失）；不做 260/320 固定三栏（无 event-source__grid）；Problems 不再是第四栏
 *    而是底部 dock（无 event-source__problems）；Flow / Hex / Raw Bytes 不在默认
 *    viewport；查找替换走 CodeMirror search（@codemirror/search）而非自实现查找
 *    UI；diagnostic gutter 用 GutterMarker；dirty 标记 per-tab；renderer 不持有
 *    文件系统路径。
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

  it('工具条含 查找替换 / Outline / Inspector / Problems 四个显式开关', () => {
    const html = render();
    assert.match(html, />查找替换<\/button>/);
    assert.match(html, />Outline<\/button>/);
    assert.match(html, />Inspector<\/button>/);
    assert.match(html, /Problems<\/button>/);
  });

  it('源码主区用 CodeMirror 引擎挂载位（data-editor-engine=codemirror）', () => {
    assert.match(render(), /data-editor-engine="codemirror"/);
  });

  it('Outline / Inspector 默认不渲染（仅显式打开）；Problems 底部 dock 默认展开', () => {
    const html = render();
    assert.doesNotMatch(html, /aria-label="事件大纲"/);
    assert.doesNotMatch(html, /aria-label="事件检查器"/);
    assert.match(html, /aria-label="事件问题"/);
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

  it('不做 260/320 固定三栏：无 event-source__grid，Problems 不再是第四栏', () => {
    assert.doesNotMatch(panelSource, /event-source__grid/);
    assert.doesNotMatch(panelSource, /event-source__problems/);
    assert.match(panelSource, /esw-dock/);
  });

  it('Flow / Hex / Raw Bytes 不在默认 viewport（SSR 骨架不含这些面板，原始 bytes 只能经 Developer Diagnostics）', () => {
    const html = render();
    assert.doesNotMatch(html, /\bFlow\b/);
    assert.doesNotMatch(html, /\bHex\b/);
    assert.doesNotMatch(html, /Raw Bytes/);
  });

  it('查找替换走 CodeMirror search（@codemirror/search），非自实现查找 UI', () => {
    assert.match(panelSource, /from '@codemirror\/search'/);
    assert.match(panelSource, /searchKeymap/);
    assert.match(panelSource, /openSearchPanel/);
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
