import { useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import type { RendererWorkspaceScanResult } from '../../main/ipc.js';
import { ScriptContainerPanel } from './editors/ScriptContainerPanel.js';
import { Bnd4WorkbenchPanel } from './editors/Bnd4WorkbenchPanel.js';
import {
  describeBridgeAbsence,
  getRendererRuntime
} from './runtime/rendererRuntime.js';
import { domainLabel } from './navigation/domainNavigation.js';
import { DomainNavigationBar } from './navigation/DomainNavigationBar.js';
import { libraryDisplayName } from './navigation/domainLibraries.js';
import { AmbientField } from './theme/AmbientField.js';
import { useSpectralTheme } from './theme/useSpectralTheme.js';
import { useShellInteractionController, type ShellInteractionController } from './app/useShellInteractionController.js';
import { useChangeOperationsController, type ChangeOperationsController, type OperationHistoryRefreshOutcome } from './app/useChangeOperationsController.js';
import { useNavigationController } from './app/useNavigationController.js';
import { useAgentUiController } from './app/useAgentUiController.js';
import { useResourceDocumentController } from './app/useResourceDocumentController.js';
import { useWorkspaceController } from './app/useWorkspaceController.js';
import { useTextDocumentController } from './app/useTextDocumentController.js';
import { useMapDocumentController } from './app/useMapDocumentController.js';
import { useEventDocumentController } from './app/useEventDocumentController.js';
import { PlainTextEditorView, MapEditorView, TextEditorView, EventEditorView } from './app/LoadedDocumentViews.js';
import { AssetEditorView } from './app/AssetEditorView.js';
import { useEditorProjection } from './app/useEditorProjection.js';
import { AgentDockView } from './app/AgentDockView.js';
import { WorkspaceHeaderView } from './app/WorkspaceHeaderView.js';
import { NavigationSidebarViews } from './app/NavigationSidebarViews.js';
import { CommandPaletteView } from './app/CommandPaletteView.js';
import { ChangeOperationsSidebarViews, OperationsWorkbenchView } from './app/ChangeOperationsViews.js';
import { WorkspaceSummaryView } from './app/WorkspaceSummaryView.js';
import { ParamEditorView } from './app/ParamEditorView.js';
import { useParamMutationController } from './app/useParamMutationController.js';
import { useParamDocumentController } from './app/useParamDocumentController.js';
import { SettingsPanelView } from './app/SettingsPanelView.js';
import { useRuntimeSettingsController } from './app/useRuntimeSettingsController.js';
import { CiteSelectScrim } from './agent/CiteSelectScrim.js';
import { PanelErrorBoundary } from './components/PanelErrorBoundary.js';
import { StartWorkspacePanel } from './workbench/StartWorkspacePanel.js';
import { resetAllDocuments, type DocumentResetActions } from './staging/documentReset.js';
import { matchesCommandSearch } from './navigation/commandPaletteSearch.js';

/** SoulForge 产品图标：标题栏和欢迎页使用透明 S 形标志。 */
const SOULFORGE_ICON_URL = new URL('./assets/soulforge-icon.png', import.meta.url).href;

/**
 * R5 裁定：侧栏每个面板头部右上角的关闭按钮——关掉后最左活动栏的对应图标
 * 仍可点回来（activateSidebarView 同视图再点是收起/展开切换）。
 */
function SidebarCloseButton({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <button
      type="button"
      className="sidebar__close"
      onClick={onClose}
      aria-label="收起侧栏"
      title="收起侧栏（Ctrl B）"
    >
      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </button>
  );
}

export function App(): ReactElement {
  // 运行表面在页面生命周期内稳定：Electron 桥接或 browser-preview 降级。
  const runtime = getRendererRuntime();
  const bridge = runtime.bridge;
  const isBrowserPreview = runtime.kind === 'browser-preview';
  // S12 卸掉状态栏后 status 无显示出口。setStatus 调用点仍保留（流程记录），
  // S15 失败句机制（编辑区 code + 人话 + 下一步）接手时会系统性清理。
  const [, setStatus] = useState('就绪');
  const shellCommandsRef = useRef<Pick<ShellInteractionController, 'pushToast'> | null>(null);
  function pushToast(text: string, kind: 'ok' | 'warn' = 'ok'): void {
    shellCommandsRef.current?.pushToast(text, kind);
  }

  const changeCommandsRef = useRef<Pick<ChangeOperationsController, 'refreshOperationHistory'> | null>(null);

  const workspaceController = useWorkspaceController({
      bridge, setStatus, pushToast, announceDesktopOnly, refreshOperationHistory,
      onWorkspaceInstalled: installWorkspaceViews,
      onWorkspaceRemounted: resetWorkspaceResourceViews,
      onAnalysisLoaded: next => setEventUri(next?.events?.[0]?.uri ?? ''),
      onSearchActivated: () => activateSearchResults()
    });
  const { workspace, sessionMeta, baseRootChoice, analysis, tools, files, allFiles, openWorkspace, chooseBaseDirectory, clearBaseDirectory, search: searchWorkspaceResources } = workspaceController;

  const resourceDocument = useResourceDocumentController({ bridge, setStatus, pushToast, refreshOperationHistory, describeBridgeAbsence,
      onSelectionActivated: activateResourceSelection });
  const { selectedFile, preview, openTabs, editDirty, selectFile, switchToOpenTab, closeTab,
    clearResourceSelection, clearResourcePreview, resetWorkspaceDocuments, resetTaeDocument, resetEsdDocument,
    resetFlverDocument, applyTextResourceAndReload, lastOpenFailure, setLastOpenFailure } = resourceDocument;
  const agent = useAgentUiController({ bridge, workspace, selectedFile, lastOpenFailure, setStatus, pushToast, announceDesktopOnly, describeBridgeAbsence });
  const { agentOpen, setAgentOpen, agentWidth, citeSelecting, setCiteSelecting, handleCiteSettle, setEventUri,
    resetAgentWorkspaceState, resetAgentSelectionState } = agent;

  const eventDocument = useEventDocumentController({
      bridge, selectedFile, setStatus, describeBridgeAbsence,
      onEventOpenFailure: failure => setLastOpenFailure(current =>
        failure ?? (current?.kind === 'event-open-failed' ? null : current))
    });
  const { resetEventDocument } = eventDocument;
  const textDocument = useTextDocumentController({ bridge, selectedFile, setStatus, pushToast });
  const { fmgSourceHash, fmgLive, resetTextDocument, applyFmgMutationAndReload } = textDocument;
  const mapDocument = useMapDocumentController({
      bridge, selectedFile, setStatus,
      onMapOpenFailure: failure => setLastOpenFailure(current =>
        failure ?? (current?.kind === 'msb-open-failed' ? null : current))
    });
  const { resetMapDocument } = mapDocument;

  const paramDocument = useParamDocumentController({
    bridge, selectedFile, setStatus, pushToast, refreshOperationHistory, describeBridgeAbsence
  });
  const { paramSourceHash, paramLive, paramRowPayloads, setParamRevealRowId, reloadParamRowsFromSource,
    applyParamFieldMutationFromPanel, resetParamDocument, ownsParamDocument } = paramDocument;

  const runtimeSettings = useRuntimeSettingsController({ bridge, setStatus, pushToast, announceDesktopOnly });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState('');
  const navigation = useNavigationController({
      bridge, isBrowserPreview, workspace, files, allFiles, openTabs, selectedFile, editDirty, sidebarCollapsed,
      setSidebarCollapsed, cmdkOpen, cmdkQuery, selectFile, switchToOpenTab, clearResourceSelection, clearResourcePreview,
      setParamRevealRowId, setStatus, searchWorkspaceResources
    });
  const { activeDomain, centerView, sidebarView, fmgRevealRequest, domainSummaries, domainLibraries,
    cmdkNormalized, cmdkAllResourceMatches, domainCommands,
    selectDomain, installWorkspaceNavigation, activateSearchResults, activateSidebarView, showSidebarView,
    openOperationsView, openBnd4ForSelection, jumpToResource, resetNavigationTextState,
    onResourceSelectionActivated, clearFmgRevealRequest } = navigation;
  const changeOperations = useChangeOperationsController({
    bridge, workspace, selectedFile, editDirty, fmgSourceHash, paramSourceHash, applyTextResourceAndReload,
    applyFmgMutationAndReload, reloadParamRowsFromSource, applyParamFieldMutationFromPanel,
    setStatus, pushToast, announceDesktopOnly, describeBridgeAbsence, onRollbackCommitted: reloadSelectedResourceAfterRollback
  });
  changeCommandsRef.current = changeOperations;
  const { pendingChangeCount, hasUncommittedChanges, resetChangeWorkspaceState } = changeOperations;
  const shellInteraction = useShellInteractionController({ sidebarCollapsed, setSidebarCollapsed, cmdkOpen, setCmdkOpen,
    cmdkQuery, setCmdkQuery, activeDomain, setAgentOpen, pendingChangeCount, hasUncommittedChanges, showSidebarView });
  shellCommandsRef.current = shellInteraction;
  const { sidebarWidth, shellRef, cmdkIndex, toasts, tabbarRef, focusSearchPanel,
    startSidebarResize, startTabbarDrag, moveTabbarDrag, endTabbarDrag } = shellInteraction;

  // Workspace background analysis and document owners may retain an earlier render's callback.
  // Resolve only the current command here; the history owner still guards its captured request.
  async function refreshOperationHistory(): Promise<OperationHistoryRefreshOutcome> {
    return await changeCommandsRef.current?.refreshOperationHistory();
  }

  /**
   * 每种资源族的编辑态复位动作。
   *
   * 切换工作区与切换选中文件都必须把全部族清空，否则面板会继续显示上一个资源的
   * 行/条目/场景。此前这两处是手写 setter 列表，实测 openWorkspace **8 个族一个
   * 都没复位**、selectFile 漏掉 FMG/PARAM/EMEVD/MSB——而漏一项不会有编译错误、
   * 测试失败或诊断，只能靠肉眼发现。
   *
   * 现在改为一处登记（staging/documentReset.ts）+ 一次 resetAllDocuments 调度，
   * 并由单测对着本文件源码做双向对账：登记表漏项或新增未登记的 setter 都会红。
   * 写入侧本就有 live + sourceHash 双重前置条件，所以这个 bug 不会写错文件；
   * 它污染的是显示层的「已解析」观感（硬约束 7 要求严格区分 authority 状态）。
   */
  const documentResetActions = useMemo<DocumentResetActions>(() => ({
    fmg: () => {
      resetTextDocument();
      resetNavigationTextState();
    },
    param: resetParamDocument,
    emevd: resetEventDocument,
    msb: () => {
      resetMapDocument();
      // Cross-domain opening failure shares the existing unified reset boundary.
      setLastOpenFailure(null);
    },
    tae: resetTaeDocument,
    esd: resetEsdDocument,
    flver: resetFlverDocument
  }), []);
  const editorProjection = useEditorProjection({ navigation, document: resourceDocument, workspace, files, allFiles, fmgLive, bridge });
  const { activeEditor, showBnd4Workbench, paramWorkbenchFile, showTextWorkbench, fmgPanelLive, showEventWorkbench, showEditorWelcome } = editorProjection;

  const paramMutations = useParamMutationController({
      bridge, selectedFile, paramWorkbenchFile, paramLive, paramSourceHash, paramRowPayloads,
      reloadParamRowsFromSource, ownsParamDocument, setStatus, pushToast, refreshOperationHistory, describeBridgeAbsence
    });

  const spectralTheme = useSpectralTheme();

  /** Electron-only 操作在 browser-preview 表面的统一可见降级：不抛异常、不静默。 */
  function announceDesktopOnly(operation: string): void {
    const message = describeBridgeAbsence(operation);
    setStatus(message);
    pushToast(message, 'warn');
  }
  function activateResourceSelection(): void {
    resetAgentSelectionState();
    resetAllDocuments(documentResetActions);
    onResourceSelectionActivated();
  }

  function installWorkspaceViews(result: RendererWorkspaceScanResult): void {
    resetWorkspaceDocuments();
    resetAgentWorkspaceState();
    resetChangeWorkspaceState();
    resetAllDocuments(documentResetActions);
    installWorkspaceNavigation(result.workspaceSessionId, result.files);
  }

  function resetWorkspaceResourceViews(): void {
    resetWorkspaceDocuments();
    resetAllDocuments(documentResetActions);
  }

  /**
   * 回滚后重新走一次完整的资源打开链，而不是只刷新文本预览。
   * MSB/TAE/FLVER 等领域面板的 useEffect 依赖选中文件对象；克隆对象
   * 让当前资源在内容恢复后必然触发重读，同时保留同一 sourceUri/tab。
   */
  async function reloadSelectedResourceAfterRollback(): Promise<void> {
    if (!selectedFile) return;
    await selectFile({ ...selectedFile });
  }
  // 命令面板与顶部工作域栏共用 domainSummaries（同一份 DomainSummary 数据源），
  // 不维护第二套 IA 标签。R1 裁定：GPARAM 已从顶栏隐藏（并入左侧「参数」），
  // 命令面板同样不提供一级入口。
  const cmdkCommands: Array<{ id: string; icon: string; label: string; hint?: string; run: () => void }> = [
    ...domainCommands,
    { id: 'open-bnd4', icon: '▤', label: '以 BND4 容器打开当前选择', run: openBnd4ForSelection },
    { id: 'open-workspace', icon: '⌘', label: '打开 Mod 工作区…', run: (): void => { void openWorkspace(); } },
    { id: 'view-operations', icon: '◷', label: '切换到任务与历史', run: openOperationsView },
    { id: 'open-settings', icon: '⚙', label: '切换到设置', run: (): void => { setSidebarCollapsed(false); showSidebarView('settings'); } },
    { id: 'focus-search', icon: '⌕', label: '聚焦资源搜索', hint: '搜索', run: focusSearchPanel },
    { id: 'toggle-agent', icon: '✦', label: '切换 AI Agent 面板', hint: 'Ctrl J', run: (): void => { setAgentOpen((open) => !open); } },
    { id: 'toggle-sidebar', icon: '◨', label: '切换侧栏', hint: 'Ctrl B', run: (): void => { setSidebarCollapsed((collapsed) => !collapsed); } }
  ];
  const filteredCmdkCommands = useMemo(
    () => cmdkCommands.filter((command) => matchesCommandSearch(command.label, cmdkNormalized)),
    [cmdkCommands, cmdkNormalized]
  );
  const cmdkItemCount = filteredCmdkCommands.length + cmdkAllResourceMatches.length;
  const selectedCmdkIndex = Math.min(cmdkIndex, Math.max(0, cmdkItemCount - 1));

  function runCmdkItem(index: number): void {
    if (index < filteredCmdkCommands.length) {
      const command = filteredCmdkCommands[index];
      if (command) {
        setCmdkOpen(false);
        command.run();
      }
      return;
    }
    const file = cmdkAllResourceMatches[index - filteredCmdkCommands.length];
    if (file) {
      setCmdkOpen(false);
      void selectFile(file);
    }
  }

  const welcomeStats = workspace
    ? `已索引 ${allFiles.length} 个资源 · ${workspace.workspaceLabel}${analysis ? ` · 已解析 ${analysis.parsedFiles}` : ''}`
    : '未打开 Mod 工作区 · 从左侧资源浏览器打开';

  const sidebarStyle = { '--sidebar-w': `${sidebarWidth}px` } as CSSProperties;
  const agentStyle = { '--agent-w': `${agentWidth}px` } as CSSProperties;

  return (
    <>
    <AmbientField manifest={spectralTheme.manifest} />
    <div className="app-root">
      {/* ══════════ 标题栏 ══════════ */}
      <WorkspaceHeaderView workspace={workspaceController} shell={shellInteraction} isBrowserPreview={isBrowserPreview} iconUrl={SOULFORGE_ICON_URL} />

      <DomainNavigationBar
        domain={activeDomain}
        domains={domainSummaries}
        onSelect={selectDomain}
        resourceSidebarOpen={!sidebarCollapsed && sidebarView === 'explorer'}
      />

      <div className="shell" ref={shellRef}>
        {/* ══════════ 活动栏 ══════════
            问题 1：开始态侧栏已拆掉（有工作区后「开始」不是页），搜索继续只走
            Ctrl+K，暂存区 / 审计与回滚作为 ab-item 回到活动栏（贴底、Agent 齿轮
            上方；第八个图标不用——搜索不进活动栏）。资源浏览器并入各领域资源树。 */}
        <nav className="activitybar" aria-label="主导航">
          <div className="ab-spacer"></div>
          <button
            type="button"
            className={sidebarView === 'staging' && !sidebarCollapsed ? 'ab-item is-active' : 'ab-item'}
            onClick={() => activateSidebarView('staging')}
            title={`暂存区${pendingChangeCount > 0 ? `（${pendingChangeCount}）` : ''}`}
            aria-label="暂存区"
            aria-current={sidebarView === 'staging' && !sidebarCollapsed ? true : undefined}
          >
            {pendingChangeCount > 0 && <span className="ab-badge">{pendingChangeCount}</span>}
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M4 5h16v14H4z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={sidebarView === 'audit' && !sidebarCollapsed ? 'ab-item is-active' : 'ab-item'}
            onClick={() => activateSidebarView('audit')}
            title="审计与回滚"
            aria-label="审计与回滚"
            aria-current={sidebarView === 'audit' && !sidebarCollapsed ? true : undefined}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className={agentOpen ? 'ab-item is-active' : 'ab-item'}
            onClick={() => setAgentOpen((open) => !open)}
            title="AI Agent"
            aria-label="AI Agent 面板"
            aria-pressed={agentOpen}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M12 2.8l1.9 5.6 5.6 1.9-5.6 1.9L12 17.8l-1.9-5.6-5.6-1.9 5.6-1.9Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M18.6 15.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" fill="currentColor" opacity=".7" />
            </svg>
          </button>
          <button
            type="button"
            className={sidebarView === 'settings' && !sidebarCollapsed ? 'ab-item is-active' : 'ab-item'}
            onClick={() => activateSidebarView('settings')}
            title="设置"
            aria-label="设置"
            aria-current={sidebarView === 'settings' && !sidebarCollapsed ? true : undefined}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95A7 7 0 0 0 14 5.3L13.7 2.8h-3.4L10 5.3a7 7 0 0 0-2.5 1.24l-2.36-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.5 1.24l.3 2.5h3.4l.3-2.5a7 7 0 0 0 2.5-1.24l2.36.95 2-3.46-2-1.55c.09-.46.14-.93.14-1.4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
        </nav>

        {/* ══════════ 侧栏 ══════════ */}
        <aside className={`sidebar${sidebarCollapsed ? ' is-collapsed' : ''}`} style={sidebarStyle}>
          {/* ── 资源浏览器 ── */}
          <NavigationSidebarViews navigation={navigation} resource={resourceDocument} workspace={workspace}
            isBrowserPreview={isBrowserPreview} closeButton={<SidebarCloseButton onClose={() => setSidebarCollapsed(true)} />}
            searchInputRef={shellInteraction.searchInputRef} />

          {/* ── 搜索 ── */}


          {/* ── 暂存区 ── */}
          <ChangeOperationsSidebarViews operations={changeOperations} sidebarView={sidebarView} hasWorkspace={workspace !== null}
            closeButton={<SidebarCloseButton onClose={() => setSidebarCollapsed(true)} />} />

          {/* ── 审计与回滚 ── */}


          {/* ── 设置 ── */}
          <SettingsPanelView active={sidebarView === 'settings'} closeButton={<SidebarCloseButton onClose={() => setSidebarCollapsed(true)} />}
            isBrowserPreview={isBrowserPreview} workspace={{ sessionMeta, baseRootChoice, chooseBaseDirectory, clearBaseDirectory }}
            spectralTheme={spectralTheme} runtimeSettings={runtimeSettings} bridge={bridge} />

          <div className="sidebar-resizer" onPointerDown={startSidebarResize} aria-hidden="true"></div>
        </aside>

        {/* ══════════ 编辑器主区 ══════════ */}
        <main className="editor-area">
          {/* 13-C：tabbar 露出底边横条可拖（styles.css 删掉了 scrollbar-width: none /
              ::-webkit-scrollbar display:none）；指针按住拖 = 横向滚，滚轮（含竖向）
              在 tabbar 上改 scrollLeft，不让竖向滚轮落到下方工作台。 */}
          <div
            ref={tabbarRef}
            className="tabbar"
            role="tablist"
            aria-label="打开的资源"
            onPointerDown={startTabbarDrag}
            onPointerMove={moveTabbarDrag}
            onPointerUp={endTabbarDrag}
            onPointerLeave={endTabbarDrag}
            onPointerCancel={endTabbarDrag}
          >
            {openTabs.map((tab) => {
              const isActive = selectedFile?.sourceUri === tab.sourceUri;
              // R1/P7 裁定：文档标签显示逻辑名（去复合扩展），物理路径只进 title。
              const shortName = libraryDisplayName(tab.relativePath);
              return (
                <div
                  key={tab.sourceUri}
                  className={isActive ? 'tab is-active' : 'tab'}
                  role="tab"
                  aria-selected={isActive}
                  title={tab.relativePath}
                  onClick={() => void selectFile(tab)}
                >
                  <span className="tab__name">{shortName}</span>
                  {isActive && hasUncommittedChanges && <span className="tab__dirty" title="有未写入变更"></span>}
                  <button
                    type="button"
                    className="tab__close"
                    aria-label={`关闭 ${tab.relativePath}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab);
                    }}
                  >
                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="editor-viewport">
            <div className="editor-pane is-active">
              {/* 10-A：tab 下面的面包屑行整块删除（`PARAM · gameparam` 与 tab 重复，
                  未写入变更圆点已在 tab__dirty 上，不靠这行活着）。 */}
              <div className="pane-content">
                <div className="viewer-content">
          {/* 面板级错误边界：任何一个资源族面板抛异常时只降级它自己，不带走整个界面。
              renderer 此前完全没有 ErrorBoundary，实测点 map 目录触发
              SCENE_URI_INVALID 后全部元素消失（详见 PanelErrorBoundary 注释）。
              key 绑定当前资源，切换资源时重建边界，避免上一份错误状态粘住。 */}
          <PanelErrorBoundary
            label={`${domainLabel(activeDomain)} 工作域`}
            /* key 按编辑器类型而非 selectedFile：EVENT-30B 多文档工作台（事件/
               GPARAM）跨资源保留标签与未提交编辑，key 绑 selectedFile 会让
               切文件即卸载重建、内部 tabs 全丢。错误隔离仍按类型成立：某类型
               面板崩溃只降级该类型，不带走整个界面。 */
            key={`panel-boundary:${activeEditor}`}
          >
          {activeEditor === 'project' && (
            <StartWorkspacePanel
              workspaceLabel={workspace?.workspaceLabel ?? null}
              baseRootChoiceLabel={baseRootChoice?.label ?? null}
              baseMounted={sessionMeta?.baseMounted ?? false}
              browserPreview={isBrowserPreview}
              onOpenWorkspace={() => void openWorkspace()}
              onChooseBaseDirectory={() => void chooseBaseDirectory()}
              onClearBaseDirectory={() => void clearBaseDirectory()}
            />
          )}
          <AssetEditorView {...editorProjection} activeDomain={activeDomain} domainLibraries={domainLibraries}
            selectedFile={selectedFile} document={resourceDocument} />

          {/* Structured preview / 原生格式检查 / 原始字节视图在 S12 前曾常驻此面板，
              把编辑器挤到滚动区外。S12 拍死：编辑壳不再展示证据投影与 hex 视图，
              它们只存在于 main / AI 引用 / 开发者通道。 */}
          {/* 纯文本编辑器只在 plain-text 时出现。
              此前条件是 `previewKind === 'text'`，而它对 FMG/msg 资源同样为真，
              于是文本编辑器会和 FMG 文本工作台**叠在一起**——同一个资源两个编辑区，
              正是「一叠卡片」的又一处来源。 */}
          {activeEditor === 'plain-text' && <PlainTextEditorView document={resourceDocument} />}
          {activeEditor === 'map' && <MapEditorView selectedFile={selectedFile} document={mapDocument}
            openFailure={lastOpenFailure?.kind === 'msb-open-failed' ? lastOpenFailure : null} />}
          {/* EVENT-30B 事件工作台移出本边界：它跨资源/跨编辑域保留 tab 与
              EditorState，不能用 activeEditor key 每次重建。 */}
          {showTextWorkbench && <TextEditorView selectedFile={selectedFile} document={textDocument} live={fmgPanelLive}
            revealRequest={fmgRevealRequest} onRevealHandled={clearFmgRevealRequest} />}
          {/* PARAM 容器工作台（Smithbox 式三栏）。
              打开 parambnd 时它是主视图：容器本身不是可解析的 PARAM
              （read-param-document 不解 DCX/BND4，直接喂容器会报
              「PARAM 类型名偏移无效」），必须先在左栏选容器内某个 param。
              这正是此前「打开 gameparam.parambnd.dcx 显示 0 行」的原因。 */}
          <ParamEditorView activeEditor={activeEditor} selectedFile={selectedFile} paramWorkbenchFile={paramWorkbenchFile}
            document={paramDocument} mutations={paramMutations} />

          {activeEditor === 'script' && (
            <>
              {/* 删掉「实时脚本容器只读证据（字节码绝不显示为可编辑源码）」标题行。
                  「字节码绝不显示为可编辑源码」是对实现的承诺，不是用户要读的说明；
                  面板自己会说明哪些条目可编辑。 */}
              <ScriptContainerPanel
                key={selectedFile?.sourceUri ?? 'none'}
                resourceUri={selectedFile?.sourceUri ?? ''}
                onMutationCommitted={() => void refreshOperationHistory()}
              />
            </>
          )}
          {showBnd4Workbench && (
            <>
              <p className="muted">
                {selectedFile
                   ? 'BND4 容器工作台'
                  : '选择左侧容器资源后显示工作台'}
              </p>
              <Bnd4WorkbenchPanel
                key={selectedFile?.sourceUri ?? 'none'}
                resourceUri={selectedFile?.sourceUri ?? ''}
                onMutationCommitted={() => void refreshOperationHistory()}
              />
            </>
          )}
          {centerView === 'operations' && (
            <OperationsWorkbenchView operations={changeOperations} preview={preview}
              onCancelJob={() => setStatus('任务取消请求已记录；待 TaskQueue IPC。')} />
          )}
          {/* 删掉「空文件。」与「预览失败。」两句：它们既不说明问题也不给出动作，
              而且与下方的编辑器并存（一个资源同时出现「预览失败」和一张空表）。
              空文件的事实由编辑器自身的空态表达；读取失败由工作台错误态表达。 */}

          </PanelErrorBoundary>
          {/*
            EVENT-30B：事件工作台常驻挂载。切到 PARAM/MAP 域时只是 hidden，不卸载，
            因此 tab、dirty、每个 tab 的 EditorState 与用户滚动位置都保留。
          */}
          <EventEditorView active={showEventWorkbench} document={eventDocument} onJumpResource={jumpToResource} />
                </div>
              </div>
            </div>

            {/* ── 欢迎页：真实工作区摘要 ── */}
            <WorkspaceSummaryView workspace={workspaceController} operations={changeOperations} document={resourceDocument}
              navigation={navigation} setSidebarCollapsed={setSidebarCollapsed} showEditorWelcome={showEditorWelcome}
              welcomeStats={welcomeStats} iconUrl={SOULFORGE_ICON_URL} />
          </div>
          {citeSelecting && (
            <CiteSelectScrim
              onSettle={(hits) => void handleCiteSettle(hits)}
              onCancel={() => setCiteSelecting(false)}
            />
          )}
        </main>

        {/* ══════════ Agent 面板 ══════════ */}
        {/* Agent owner holds width and persistence; the shell projects its layout width. */}
        <AgentDockView agent={agent} activeDomain={activeDomain} selectedFile={selectedFile}
          hasBridge={bridge !== null} fallbackTools={tools} style={agentStyle} />
      </div>

      {/* ══════════ 命令面板 ══════════ */}
      <CommandPaletteView cmdkOpen={cmdkOpen} cmdkQuery={cmdkQuery} cmdkItemCount={cmdkItemCount}
        selectedCmdkIndex={selectedCmdkIndex} filteredCmdkCommands={filteredCmdkCommands} cmdkAllResourceMatches={cmdkAllResourceMatches}
        workspace={workspace} selectFile={selectFile} shell={shellInteraction} setCmdkQuery={setCmdkQuery} runCmdkItem={runCmdkItem} />

      <div className="toast-root" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <span className="toast__icon" aria-hidden="true">{toast.kind === 'ok' ? '✓' : '⚠'}</span>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
    </>
  );
}
