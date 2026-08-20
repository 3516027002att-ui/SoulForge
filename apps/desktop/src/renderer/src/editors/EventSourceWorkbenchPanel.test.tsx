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
  EventMeaningPane,
  EventSourceWorkbenchPanel,
  baselineText,
  isSourceReadOnly,
  type EventSourceTabData
} from './EventSourceWorkbenchPanel.js';
import type {
  LineInspection,
  ResourceJumpResult
} from '../emevd/eventSourceNavigate.js';
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
  const navigateSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'emevd', 'eventSourceNavigate.ts'),
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

  it('T4：查找走 CodeMirror search keymap（Ctrl+F），不渲染工具条查找钮；S35 起先拉齐未加载部分再开查找面板', () => {
    assert.match(panelSource, /from '@codemirror\/search'/);
    assert.match(panelSource, /searchKeymap/);
    // S35（event-common-load.md §3.2）：Ctrl+F 先 ensureTabComplete 一次拉齐，
    // 再 openSearchPanel —— 禁止为「查找要全文」在打开时同步拉全文。
    assert.match(panelSource, /openSearchPanel/);
    assert.match(panelSource, /ensureTabCompleteRef/);
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

  it('不自动保存：无失焦提交；工具条有保存/撤回，Ctrl+S 仍走 submitSource', () => {
    assert.doesNotMatch(panelSource, /addEventListener\('focusout'/);
    assert.doesNotMatch(panelSource, /失焦直接应用/);
    assert.match(panelSource, /data-testid="esw-save"/);
    assert.match(panelSource, /data-testid="esw-revert"/);
    assert.match(panelSource, /function revertSource/);
    assert.match(panelSource, /title="保存（Ctrl\+S）"/);
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

  it('S35：增量源按视口续载；完整缓冲仍是原子提交（无 16ms 分片 / sourceFillTarget 回归）', () => {
    // S35（event-common-load.md §3.2）打开首帧只有 400 行前缀，全文按视口
    // 续载；但增量灌入**不是** S18 的 16ms interval 分片，也没有
    // sourceFillTarget 状态机。常量定义留在 assembleEmevdSource /
    // incrementalSourceInjection，面板不直接引用字面常量。
    assert.doesNotMatch(panelSource, /SOURCE_PREFIX_LINES|SOURCE_SLICE_LINES/);
    assert.doesNotMatch(panelSource, /appendSourceSlices/);
    assert.doesNotMatch(panelSource, /splitSourceForFirstFrame/);
    assert.doesNotMatch(panelSource, /sourceFillTarget:/);
    assert.doesNotMatch(panelSource, /setInterval/);
    assert.match(panelSource, /incrementalSourceInjection/);
    assert.match(panelSource, /isNearLoadedBottom/);
    assert.match(panelSource, /fetchAllRemainingSource/);
    assert.match(panelSource, /createCompleteSourceState/);
    assert.match(panelSource, /openingPreview/);
  });

  it('S19：DarkScript 多通道词法与 $Event 折叠存在', () => {
    assert.match(panelSource, /darkScriptStreamLanguage/);
    assert.match(panelSource, /tokenTable/);
    assert.match(panelSource, /foldService/);
    assert.match(panelSource, /eventBlockFoldRange/);
    assert.match(panelSource, /ComparisonType/);
    assert.match(panelSource, /X\d+_\d+/);
  });

  it('S31：词义列、并排分栏、事件头索引；没有假灯泡', () => {
    // 12-D：可见栏标题不再是「词义」；可访问名用不出现在画面上的「指令说明」，
    // 栏头（源码栏 + 词义栏）一并隐藏，避免和 esw-tab / App tab 重复身份。
    assert.doesNotMatch(panelSource, /title: '词义'/);
    assert.match(panelSource, /ariaLabel: '指令说明'/);
    assert.match(panelSource, /hideHeader: true/);
    assert.match(panelSource, /并排对照/);
    assert.match(panelSource, /indexEventHeaders/);
    assert.match(panelSource, /insufficient_evidence/);
    assert.doesNotMatch(panelSource, /lightbulb|Move to file/i);
    assert.match(navigateSource, /classifyArgRole/);
    assert.match(navigateSource, /eventid/i);
    // S31：fmg/param 实参不再是假死路 —— 有跳转按钮与 param-id 分类，
    // 旧「事件面板没有 FMG 表，不能跳」死路文案已删除。
    assert.doesNotMatch(panelSource, /事件面板没有 FMG 表，不能跳/);
    assert.match(panelSource, /转到文本条目/);
    assert.match(panelSource, /转到 PARAM 行/);
    assert.match(navigateSource, /param-id/);
  });

  it('S14：没有橙色头、日常黄条、「编译并提交」和只读锁；保存走按键/Ctrl+S，不自动保存', () => {
    assert.doesNotMatch(panelSource, /EVENT \/ SOURCE/);
    assert.doesNotMatch(panelSource, /编译并提交/);
    assert.doesNotMatch(panelSource, /本版只读展示/);
    assert.doesNotMatch(panelSource, /写入仍经 Bridge/);
    assert.doesNotMatch(panelSource, /Ctrl\+S 应用/);
    assert.doesNotMatch(panelSource, /已应用，可回滚/);
    assert.match(panelSource, /data-testid="esw-save"/);
    assert.match(panelSource, /data-testid="esw-revert"/);
    assert.match(panelSource, /已保存。/);
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
  it('S14：live DarkScript 可编辑，不能再靠 sourceStyle 锁死', () => {
    assert.equal(isSourceReadOnly({
      live: true,
      dslTemplate: '$Event(0, Default, function() {});',
      sourceStyle: 'dark-script'
    }), false);
  });

  it('未标记 dark-script 的 live 模板仍可编辑（写链保留给 patch-dsl）', () => {
    assert.equal(isSourceReadOnly({
      live: true,
      dslTemplate: '$Resource file://event/common.emevd',
      sourceStyle: 'patch-dsl'
    }), false);
  });

  it('非 live 或没有模板仍只读（失败关闭 / demo）', () => {
    assert.equal(isSourceReadOnly({
      live: false,
      dslTemplate: '$Event(0, Default, function() {});',
      sourceStyle: 'dark-script'
    }), true);
    assert.equal(isSourceReadOnly({
      live: true,
      dslTemplate: null,
      sourceStyle: 'none'
    }), true);
  });
});

describe('S31 词义列：fmg-id / param-id 实参的跳转 UI（SSR）', () => {
  const INSTRUCTION: LineInspection = {
    kind: 'instruction',
    name: 'CreateItem',
    bank: 5,
    id: 0,
    args: [
      { name: 'itemNameId', type: 's32', value: '1100', role: 'fmg-item-name-id', resourceId: 1100 },
      { name: 'messageId', type: 's32', value: '1', role: 'fmg-text-id', resourceId: 1 },
      { name: 'paramId', type: 's32', value: '3300', role: 'param-id', resourceId: 3300 },
      { name: 'slotNumber', type: 's32', value: '0', role: 'none' }
    ],
    unknown: false
  };

  function renderPane(
    inspection: LineInspection,
    resourceJump: ResourceJumpResult | null = null
  ): string {
    return renderToStaticMarkup(
      <EventMeaningPane
        inspection={inspection}
        jump={null}
        resourceJump={resourceJump}
        onJumpEvent={() => {}}
        onJumpResource={() => {}}
        documentTitle="common"
      />
    );
  }

  it('fmg 系与 param 系实参渲染跳转按钮，不再画「没有 FMG 表」死路', () => {
    const html = renderPane(INSTRUCTION);
    assert.match(html, />转到文本条目 1100<\/button>/);
    assert.match(html, />转到文本条目 1<\/button>/);
    assert.match(html, />转到 PARAM 行 3300<\/button>/);
    assert.doesNotMatch(html, /事件面板没有 FMG 表，不能跳/);
    // 非目标角色不渲染跳转。
    assert.doesNotMatch(html, /转到文本条目 0/);
  });

  it('resourceJump 命中时给出目标位置（资源 + 表名）', () => {
    const html = renderPane(INSTRUCTION, {
      kind: 'hit',
      resourceUri: 'fixture://msg/zhocn/item.msgbnd.dcx',
      title: 'item',
      detail: 'Item Name',
      tableId: 'zh:item:Item Name'
    });
    assert.match(html, /目标在 item（Item Name）。/);
  });

  it('resourceJump 不足证据时展示 insufficient_evidence 文案', () => {
    const html = renderPane(INSTRUCTION, {
      kind: 'insufficient_evidence',
      code: 'insufficient_evidence',
      message: '有 2 个已打开的文本表匹配「物品名」，无法确定目标。'
    });
    assert.match(html, /有 2 个已打开的文本表匹配「物品名」，无法确定目标。/);
    // 不足证据与命中互斥：同一块里不再出现「目标在 …」。
    assert.doesNotMatch(html, /目标在/);
  });
});

describe('S35 增量源（event-common-load.md §3.2：首帧前缀 + 按视口续载）', () => {
  const repoRoot = process.cwd();
  const panelSource = readFileSync(
    join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'EventSourceWorkbenchPanel.tsx'),
    'utf8'
  );
  const incrementalTab: EventSourceTabData = {
    tabId: 'file://event/common.emevd',
    title: 'common',
    resourceUri: 'file://event/common.emevd',
    document: DOCUMENT,
    sourceHash: 'sha256:abc',
    live: true,
    dslTemplate: null,
    dslTemplateTruncated: false,
    dslTemplateTotalLines: 70_000,
    sourceStyle: 'dark-script',
    sourceToken: 'tok',
    sourcePrefix: 'L0\nL1\nL2',
    sourceTotalLines: 70_000
  };

  it('增量源 tab（dslTemplate null + sourceToken）是 live 可编辑的，不是失败关闭', () => {
    assert.equal(isSourceReadOnly(incrementalTab), false);
  });

  it('EMEDF 缺失失败关闭（无 token 无模板）仍是只读', () => {
    assert.equal(isSourceReadOnly({
      ...incrementalTab,
      sourceToken: null
    }), true);
  });

  it('baselineText 对增量源返回 sourcePrefix（首帧不拼全文、不触发 slice IPC）', () => {
    assert.equal(baselineText(incrementalTab), 'L0\nL1\nL2');
  });

  it('提交后重读回灌走完整 dslTemplate（无 token 字段）', () => {
    const complete: EventSourceTabData = {
      tabId: incrementalTab.tabId,
      title: incrementalTab.title,
      resourceUri: incrementalTab.resourceUri,
      document: DOCUMENT,
      sourceHash: 'sha256:abc',
      live: true,
      dslTemplate: '$Event(0, Default, function() {\n});',
      dslTemplateTruncated: false,
      dslTemplateTotalLines: 2,
      sourceStyle: 'dark-script'
    };
    assert.equal(isSourceReadOnly(complete), false);
    assert.equal(baselineText(complete), '$Event(0, Default, function() {\n});');
  });

  it('只读失败句不受增量源影响（非 live + token 仍只读）', () => {
    assert.equal(isSourceReadOnly({ ...incrementalTab, live: false }), true);
  });

  it('12-A：EMEDF 缺失横幅只留给真没 token 的 live tab（增量源 tab 不渲染）', () => {
    // SSR 不跑 effect（tabs 为空、activeTab 为 null），横幅 JSX 需源码级锁定：
    // 条件带上 !activeTab.sourceToken —— 增量源 tab（dslTemplate null 但持
    // sourceToken）加载中不得画「未找到用户本机 EMEDF」，那是不全的错归因。
    assert.match(panelSource, /activeTab\?\.live && activeTab\.dslTemplate === null && !activeTab\.sourceToken/);
  });

  it('12-A：挂载/切回前台即对增量源 tab 按片后台续载（首帧仍只带前缀）', () => {
    // SSR 无法跑 effect；源码级钉住接线：activeTabId 变化时走 fillRemainingInSlices
    // （每片立刻 append），不得再对打开路径调 ensureTabComplete 一次拉齐——
    // 那会让前 400 行卡住直到切走再切回来。
    assert.match(panelSource, /incrementalSourcesRef\.current\.get\(activeTabId\)/);
    assert.match(panelSource, /fillRemainingInSlicesRef\.current\(activeTabId\)/);
    assert.match(panelSource, /fillRemainingInSlices/);
    const mountEffect = panelSource.slice(
      panelSource.indexOf('12-A：打开并挂上前缀后'),
      panelSource.indexOf('if (!splitTabId || !splitHostRef.current)')
    );
    assert.match(mountEffect, /fillRemainingInSlicesRef\.current\(activeTabId\)/);
    assert.doesNotMatch(mountEffect, /ensureTabCompleteRef\.current\(activeTabId\)/);
    // 首帧缓冲仍是前缀，不把全量塞进第一次 IPC。
    assert.equal(baselineText(incrementalTab), 'L0\nL1\nL2');
  });

  it('12-C：事件工作台有独立高度宿主，源码列与词义列不跟 viewer-content 一起滚', () => {
    const appSource = readFileSync(
      join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx'),
      'utf8'
    );
    const css = readFileSync(
      join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'src', 'styles.css'),
      'utf8'
    );
    assert.match(appSource, /className="event-source-host"/);
    assert.match(css, /\.viewer-content:has\(\.event-source-host:not\(\[hidden\]\)\)/);
    const hostRule = css.slice(
      css.indexOf('.event-source-host:not([hidden])'),
      css.indexOf('.event-source-workbench {')
    );
    assert.match(hostRule, /overflow:\s*hidden/);
    const workbenchOverride = css.slice(
      css.indexOf('.event-source-workbench .workbench {'),
      css.indexOf('.event-source__section-header')
    );
    assert.doesNotMatch(workbenchOverride, /height:\s*auto/);
    assert.match(workbenchOverride, /min-height:\s*0/);
  });
});
