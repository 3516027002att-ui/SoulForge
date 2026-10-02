import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { classifyWorkspaceOpen, PARAM_ROW_PAYLOAD_BATCH_MAX, paramPhysicalRowKey } from '@soulforge/shared';
import type { ParamDefDocument, ParamPhysicalRowIdentity } from '@soulforge/shared';
import type { RendererWorkspaceScanResult } from '../../main/ipc.js';
import type { RendererIndexedFile } from '../../main/rendererDto.js';
import { ParamWorkbench } from './workbench/ParamWorkbench.js';
import { GparamWorkbench, type GparamBankView } from './workbench/GparamWorkbench.js';
import { selectEditor } from './workbench/selectEditor.js';

import { MsbScenePanel } from './editors/MsbScenePanel.js';
import { EventSourceWorkbenchPanel } from './editors/EventSourceWorkbenchPanel.js';
import { FmgWorkbenchPanel } from './editors/FmgWorkbenchPanel.js';
import { ParamTablePanel } from './editors/ParamTablePanel.js';
import { WorkbenchOpsPanel } from './editors/WorkbenchOpsPanel.js';
import { ParamDefPanel } from './editors/ParamDefPanel.js';
import { TaeWorkbenchPanel } from './editors/TaeWorkbenchPanel.js';
import { EsdWorkbenchPanel } from './editors/EsdWorkbenchPanel.js';
import { FlverWorkbenchPanel } from './editors/FlverWorkbenchPanel.js';
import { TpfWorkbenchPanel, type TpfContainerView } from './editors/TpfWorkbenchPanel.js';
import { MaterialWorkbenchPanel, type MaterialFileView } from './editors/MaterialWorkbenchPanel.js';
import { VfxWorkbenchPanel, type VfxFileView } from './editors/VfxWorkbenchPanel.js';
import { ScriptContainerPanel } from './editors/ScriptContainerPanel.js';
import { Bnd4WorkbenchPanel } from './editors/Bnd4WorkbenchPanel.js';
import { ChangeQueuePanel } from './staging/ChangeQueuePanel.js';
import {
  describeBridgeAbsence,
  getRendererRuntime
} from './runtime/rendererRuntime.js';
import { domainLabel } from './navigation/domainNavigation.js';
import { DomainNavigationBar } from './navigation/DomainNavigationBar.js';
import { DomainLibraryList } from './navigation/DomainLibraryList.js';
import { libraryDisplayName } from './navigation/domainLibraries.js';
import { AmbientField } from './theme/AmbientField.js';
import { useSpectralTheme } from './theme/useSpectralTheme.js';
import { shouldShowEditorWelcome } from './theme/editorWelcome.js';
import { useChangeOperationsController, type ChangeOperationsController, type OperationHistoryRefreshOutcome } from './app/useChangeOperationsController.js';
import { useNavigationController } from './app/useNavigationController.js';
import { useAgentUiController, AGENT_MIN_WIDTH, AGENT_MAX_WIDTH, AGENT_DEFAULT_WIDTH } from './app/useAgentUiController.js';
import { useResourceDocumentController } from './app/useResourceDocumentController.js';
import { useWorkspaceController } from './app/useWorkspaceController.js';
import { useTextDocumentController } from './app/useTextDocumentController.js';
import { useMapDocumentController } from './app/useMapDocumentController.js';
import { useEventDocumentController } from './app/useEventDocumentController.js';
import { useParamMutationController } from './app/useParamMutationController.js';
import { useParamDocumentController } from './app/useParamDocumentController.js';
import { SettingsPanelView } from './app/SettingsPanelView.js';
import { useRuntimeSettingsController } from './app/useRuntimeSettingsController.js';
import { AgentSidebar } from './agent/AgentSidebar.js';
import { CiteSelectScrim } from './agent/CiteSelectScrim.js';
import { clampAgentDockWidth } from './agent/AgentDockResizer.js';
import { resolveKeybinding } from './keybindings/applyKeybinding.js';
import { describeRunBlocker, isAgentTaskActive } from './agent/agentTaskState.js';
import { MsgTableEditor } from './components/MsgTableEditor.js';
import { PanelErrorBoundary } from './components/PanelErrorBoundary.js';
import { StartWorkspacePanel } from './workbench/StartWorkspacePanel.js';
import { formatFilesCount, operationStatusLabel, shortenPath } from './format/uiText.js';
import { resetAllDocuments, type DocumentResetActions } from './staging/documentReset.js';
import {
  FOCUSABLE_SELECTOR,
  isTrappableElement,
  nextTrappedFocusIndex
} from './a11y/focusTrap.js';
import { matchesCommandSearch } from './navigation/commandPaletteSearch.js';

/** P0 安全收口：权限模式由主进程锁定，renderer 不得自行切换。 */
const AI_PERMISSION_LOCK_REASON = '权限由应用安全设置控制。';

/** SoulForge 产品图标：标题栏和欢迎页使用透明 S 形标志。 */
const SOULFORGE_ICON_URL = new URL('./assets/soulforge-icon.png', import.meta.url).href;

/** 事件内层标签只留短名：`event/common.emevd.dcx` → `common`。 */
function eventDocumentTitle(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base.replace(/\.emevd(?:\.dcx)?$/i, '') || base;
}

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

/**
 * 空 paramdef：origin 为 fixture 且无字段，definitionCanCommit 永不放行写入。
 *
 * 真实 live PARAM 的字段定义经 `openParamSession.metadata` 送入 renderer；
 * 这里仍只作为未加载/浏览器预览的空态。definitionCanCommit 继续依赖
 * main 返回的 origin/trusted 结果，renderer 不自行给 metadata 授信。
 */
const EMPTY_PARAM_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: '',
  version: 0,
  rowDataSize: 0,
  origin: 'fixture',
  fields: []
};

export function App(): ReactElement {
  // 运行表面在页面生命周期内稳定：Electron 桥接或 browser-preview 降级。
  const runtime = getRendererRuntime();
  const bridge = runtime.bridge;
  const isBrowserPreview = runtime.kind === 'browser-preview';
  // S12 卸掉状态栏后 status 无显示出口。setStatus 调用点仍保留（流程记录），
  // S15 失败句机制（编辑区 code + 人话 + 下一步）接手时会系统性清理。
  const [, setStatus] = useState('就绪');
  const changeCommandsRef = useRef<Pick<ChangeOperationsController, 'refreshOperationHistory'> | null>(null);

  const { workspace, sessionMeta, baseRootChoice, analysis, tools, files, allFiles, openWorkspace, chooseBaseDirectory, clearBaseDirectory, search: searchWorkspaceResources } =
    useWorkspaceController({
      bridge, setStatus, pushToast, announceDesktopOnly, refreshOperationHistory,
      onWorkspaceInstalled: installWorkspaceViews,
      onWorkspaceRemounted: resetWorkspaceResourceViews,
      onAnalysisLoaded: next => setEventUri(next?.events?.[0]?.uri ?? ''),
      onSearchActivated: () => activateSearchResults()
    });

  /**
   * S15/S19 失败面：最近一次资源打开失败的结构化记录（只含逻辑名，绝无绝对
   * 路径——message 来自已过 sanitizer 的 IPC 诊断）。随下一次 runAiAgent 提交给
   * 模型（main 校验后进系统提示），工作台同款话术直接进编辑区。
   */
  const [lastOpenFailure, setLastOpenFailure] = useState<{
    kind:
      | 'event-open-failed'
      | 'msb-open-failed'
      | 'fmg-open-failed'
      | 'param-open-failed'
      | 'script-open-failed'
      | 'tae-open-failed';
    document: string;
    code: string;
    message: string;
  } | null>(null);
  const { selectedFile, preview, editText, lastSavedText, msgRows, saveDiagnostics, openTabs, taeData, esdData, flverData,
    canEditText, hasMsgTable, editDirty, selectFile, switchToOpenTab, closeTab, clearResourceSelection, clearResourcePreview,
    resetWorkspaceDocuments, resetTaeDocument, resetEsdDocument, resetFlverDocument, setEditText, updateMsgRow, addMsgRow,
    removeMsgRow, saveCurrentText, applyTextResourceAndReload, applyFlverMaterialSlotSetAndReload } =
    useResourceDocumentController({ bridge, setStatus, pushToast, refreshOperationHistory, describeBridgeAbsence,
      onSelectionActivated: activateResourceSelection });
  const { agentOpen, setAgentOpen, agentWidth, setAgentWidth, agentExpanded, setAgentExpanded, agentInteractionMode,
    changeAgentInteractionMode, setAgentResources, handleAgentAttachmentsChange, citeSelecting, setCiteSelecting,
    pendingCiteHits, setPendingCiteHits, handleCiteSettle, aiProvider, setAiProvider, aiThinking, setAiThinking, aiMode,
    aiPrompt, setAiPrompt, aiDraft, aiBusy, agentGoal, agentIdleNotice, agentTask, agentServices, agentServiceId,
    setAgentServiceId, agentSessions, agentSessionsError, agentSessionDetail, respondingApprovalCallId, approvalError,
    agentTools, toolOutput, eventUri, setEventUri, sendAgentPrompt, startNewAgentTask, runAgentTask, cancelAgentTask,
    respondAgentApproval, refreshAgentSessions, loadAgentSession, runToolSearch, explainEvent,
    resetAgentWorkspaceState, resetAgentSelectionState } =
    useAgentUiController({ bridge, workspace, selectedFile, lastOpenFailure, setStatus, pushToast, announceDesktopOnly, describeBridgeAbsence });


  const { eventPendingTab, eventOpening, eventSourcePreview, resetEventDocument, submitEventDsl } =
    useEventDocumentController({
      bridge, selectedFile, setStatus, describeBridgeAbsence,
      onEventOpenFailure: failure => setLastOpenFailure(current =>
        failure ?? (current?.kind === 'event-open-failed' ? null : current))
    });
  const { fmgEntries, fmgSourceHash, fmgLive, resetTextDocument, applyFmgMutationAndReload, submitFmgEntry } =
    useTextDocumentController({ bridge, selectedFile, setStatus, pushToast });
  const { msbParts, msbModels, msbRegions, msbEvents, msbRoutes, msbSourceCounts, msbSourceHash, setMsbSourceHash, resetMapDocument } =
    useMapDocumentController({
      bridge, selectedFile, setStatus,
      onMapOpenFailure: failure => setLastOpenFailure(current =>
        failure ?? (current?.kind === 'msb-open-failed' ? null : current))
    });

  const {
    paramTypeName, paramRows, paramRowCount, paramSourceHash,
    paramLive, paramRowPayloads, paramIndexLoading, paramIndexDiagnostic,
    paramFieldDefs, paramFieldEnums, paramFieldDefsOrigin, paramFieldDefsDiagnostic,
    paramRowDataSize, paramRevealRowId, setParamRevealRowId, readParamRowsForPanel,
    reloadParamRowsFromSource, applyParamFieldMutationFromPanel, paramFieldDefinition, resetParamDocument, ownsParamDocument,
  } = useParamDocumentController({
    bridge, selectedFile, setStatus, pushToast, refreshOperationHistory, describeBridgeAbsence
  });

  const runtimeSettings = useRuntimeSettingsController({ bridge, setStatus, pushToast, announceDesktopOnly });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(264);
  const shellRef = useRef<HTMLDivElement>(null);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState('');
  const { query, setQuery, activeDomain, centerView, bnd4Forced, sidebarView, fmgRevealRequest, resourceMode,
    indexedFiles, domainSummaries, domainLibraries, domainGroups, preferredParamContainer, preferredAnimationContainer,
    physicalBrowseFiles, searchHits, cmdkNormalized, cmdkAllResourceMatches, domainCommands,
    selectDomain, installWorkspaceNavigation, activateSearchResults, search, activateSidebarView, showSidebarView,
    openOperationsView, openBnd4ForSelection, jumpToResource, resetNavigationTextState,
    onResourceSelectionActivated, clearFmgRevealRequest } = useNavigationController({
      bridge, isBrowserPreview, workspace, files, allFiles, openTabs, selectedFile, editDirty, sidebarCollapsed,
      setSidebarCollapsed, cmdkOpen, cmdkQuery, selectFile, switchToOpenTab, clearResourceSelection, clearResourcePreview,
      setParamRevealRowId, setStatus, searchWorkspaceResources
    });
  const changeOperations = useChangeOperationsController({
    bridge, workspace, selectedFile, editDirty, fmgSourceHash, paramSourceHash, applyTextResourceAndReload,
    applyFmgMutationAndReload, reloadParamRowsFromSource, applyParamFieldMutationFromPanel,
    setStatus, pushToast, announceDesktopOnly, describeBridgeAbsence, onRollbackCommitted: reloadSelectedResourceAfterRollback
  });
  changeCommandsRef.current = changeOperations;
  const { operationHistory, rollbackInFlight, changeState, pendingChangeCount, hasUncommittedChanges, draftChanges, lastOperation,
    commitStagedChanges, rollbackOp, rollbackFileOp, resetChangeWorkspaceState,
    approveChange, rejectChange, undoChangeToDraft, discardChange, clearTerminalChanges } = changeOperations;

  // Workspace background analysis and document owners may retain an earlier render's callback.
  // Resolve only the current command here; the history owner still guards its captured request.
  async function refreshOperationHistory(): Promise<OperationHistoryRefreshOutcome> {
    return await changeCommandsRef.current?.refreshOperationHistory();
  }


  // 问题 1：标题栏 workspace-switcher 菜单开合。有工作区后换文件夹的唯一常驻入口
  // （任何领域都在）；点菜单项 / 点遮罩关闭。
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [cmdkIndex, setCmdkIndex] = useState(0);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; kind: 'ok' | 'warn' }>>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cmdkInputRef = useRef<HTMLInputElement>(null);
  const cmdkDialogRef = useRef<HTMLDivElement>(null);
  /** 命令面板打开前的焦点位置；关闭时归还，避免焦点掉回文档开头。 */
  const cmdkReturnFocusRef = useRef<HTMLElement | null>(null);
  // 13-C：顶栏 tab 条。ref 供非被动 wheel 监听挂载；dragRef 记录拖拽起点
  //（startX 视口坐标 + 按下时的 scrollLeft），指针移动换算成横向滚动。
  const tabbarRef = useRef<HTMLDivElement>(null);
  const tabbarDragRef = useRef<{ startX: number; startScrollLeft: number } | null>(null);
  const toastIdRef = useRef(0);
  const prevPendingCountRef = useRef(0);

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

  // BND 不是顶层目录：选择真实 BND 文件后自动进入容器工作台，
  // 命令面板可对任意选中强制「以 BND4 容器打开」。
  const selectedIsContainer = selectedFile !== null
    && (selectedFile.formatKind === 'bnd' || selectedFile.formatKind === 'dcx'
      || selectedFile.compoundExtension.includes('.bnd')
      || selectedFile.compoundExtension.includes('.dcx'));

  /**
   * 打开的是不是 param 容器（parambnd）。
   *
   * 判定按路径与复合扩展名，而不是 formatKind：实测 `.bak` 备份文件的
   * formatLabel 是「Backup File」（`.bak` 的 endsWith 先命中），但它同样是一个
   * parambnd 容器 —— 用户截图里打开的正是 `gameparam.parambnd.dcx.bak`，
   * 若按 formatKind 判定会把它排除在工作台之外，回到「0 行」的老样子。
   *
   * 容器需要三栏工作台而不是行表：read-param-document 不解 DCX/BND4，
   * 容器路径直接喂进去必失败，必须先选容器内某个 param 再读。
   */
  const selectedIsParamContainer = centerView === 'resource'
    && selectedFile !== null
    && selectedFile.resourceKind === 'param'
    && /\.parambnd(\.dcx)?(\.bak)?$/i.test(selectedFile.relativePath);

  /**
   * 该资源用哪个编辑器 —— 唯一一个。
   *
   * 主视图区曾有 15 个**互不排斥**的条件块，打开一个 parambnd 会同时命中三四个
   * （param 容器工作台 + 通用 BND4 容器工作台 + preview 分支），于是主区变成
   * 「一叠卡片竖着堆」。用户两轮反馈都指向这一点，而改单个组件解决不了：
   * 病根在装配方式。
   *
   * 现在由 selectEditor 给出唯一编辑器，下面各块按它分派。选择逻辑是纯函数，
   * 由 selectEditor.test.ts 钉住「任何输入恰好产出一个编辑器」——那条约束
   * 在旧 JSX 装配里无法断言。
   */
  const activeEditor = selectEditor({
    centerView,
    resourceMode,
    selectedFile: selectedFile
      ? {
          relativePath: selectedFile.relativePath,
          resourceKind: selectedFile.resourceKind,
          formatKind: selectedFile.formatKind,
          compoundExtension: selectedFile.compoundExtension
        }
      : null,
    previewKind: preview?.previewKind,
    textEditable: canEditText,
    bnd4Forced
  });
  const showBnd4Workbench = activeEditor === 'container';

  /**
   * MATERIAL-53B：.mtd 后缀补正到 material 工作台。
   *
   * selectEditor 的 legacy/语义路径目前把 material 归到 'binary'（material 工作台
   * 实施前的显式占位）。本卡在 App 装配层做后缀补正：.mtd 文件在 activeEditor 为
   * 'binary' 时改走 MaterialWorkbenchPanel，同时排除下方 binary 兜底文案，保证
   * 「每个输入恰好渲染一个编辑器」。selectEditor.ts 的正式路由由主会话收尾。
   */
  const isMaterialFile = selectedFile !== null && /\.mtd$/i.test(selectedFile.relativePath) === true;

  /**
   * VFX-54B：.fxr/.fxr.dcx 后缀补正到 VFX 工作台。
   *
   * 与 isMaterialFile 同形态：selectEditor 的 legacy/语义路径目前把 vfx 归到
   * 'binary'（selectEditor.ts 的 editorIdForIntegration 对 vfx 返回 binary，
   * legacy 后缀推断也没有 .fxr）。本卡在 App 装配层做后缀补正：.fxr 文件在
   * activeEditor 为 'binary' 时改走 VfxWorkbenchPanel，同时排除下方 binary
   * 兜底文案。selectEditor.ts 的正式路由由主会话收尾。
   */
  const isVfxFile = selectedFile !== null
    && classifyWorkspaceOpen(selectedFile.relativePath).openKind === 'vfx';

  /**
   * GPARAM 域的全部磁盘文件（工作台 Files 栏的数据源，§2.5 Files 是逻辑 bank）。
   *
   * 按后缀过滤而不是 resourceKind：与 selectEditor 对 gparam 的判据一致
   * （ROUTE-06 的 legacy 路径同用 .gparam/.gparam.dcx 后缀）。任务开始时
   * mods/param/drawparam 有 34 个文件，但那是快照不是常量 —— 这里永远按
   * 当前索引实测计数。
   */
  const gparamBanks = useMemo<GparamBankView[]>(() => {
    const indexed = allFiles.length > 0 ? allFiles : files;
    return indexed
      .filter((file) => /\.gparam(\.dcx)?$/i.test(file.relativePath))
      .map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }));
  }, [allFiles, files]);

  /**
   * TEXTURE 域的全部 TPF 文件（工作台 Containers 栏的数据源）。
   *
   * 按后缀过滤而不是 resourceKind：与 selectEditor 对 tpf 的判据一致
   * （legacy 路径同用 .tpf/.tpf.dcx 后缀）。数量永远按当前索引实测计数。
   */
  const textureContainers = useMemo<TpfContainerView[]>(() => {
    const indexed = allFiles.length > 0 ? allFiles : files;
    return indexed
      .filter((file) => classifyWorkspaceOpen(file.relativePath).openKind === 'tpf')
      .map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }));
  }, [allFiles, files]);

  /**
   * MATERIAL 域的全部 MTD 文件（工作台 File list 栏的数据源）。
   *
   * 按后缀过滤而不是 resourceKind：与 selectEditor 对后缀的判据同口径
   * （material 尚未进 selectEditor 的 legacy 路径，见下方 isMaterialFile 补正）。
   */
  const materialFiles = useMemo<MaterialFileView[]>(() => {
    const indexed = allFiles.length > 0 ? allFiles : files;
    return indexed
      .filter((file) => /\.mtd$/i.test(file.relativePath))
      .map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }));
  }, [allFiles, files]);

  /**
   * VFX 域的全部 FXR 文件（工作台 Effect / Particle list 栏的数据源）。
   *
   * 按后缀过滤而不是 resourceKind：与 selectEditor 对 vfx 的判据一致
   * （.fxr 是 leaf FXR，.fxr.dcx 是压缩 FXR，.ffxbnd.dcx 是效果容器）。
   * 数量永远按当前索引实测计数。
   */
  const vfxFiles = useMemo<VfxFileView[]>(() => {
    const indexed = allFiles.length > 0 ? allFiles : files;
    return indexed
      .filter((file) => classifyWorkspaceOpen(file.relativePath).openKind === 'vfx')
      .map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }));
  }, [allFiles, files]);
  const paramWorkbenchFile = activeEditor === 'param-container' && selectedFile
    ? selectedFile
    : activeDomain === 'param' && activeEditor === 'empty'
      ? preferredParamContainer
      : null;
  const { applyContainerParamFieldMutation, applyContainerParamRowNameMutation, applyContainerParamRowMutation,
    applyParamRowMutationFromPanel } = useParamMutationController({
      bridge, selectedFile, paramWorkbenchFile, paramLive, paramSourceHash, paramRowPayloads,
      reloadParamRowsFromSource, ownsParamDocument, setStatus, pushToast, refreshOperationHistory, describeBridgeAbsence
    });

  const showTextWorkbench = activeEditor === 'text'
    || (activeDomain === 'text' && activeEditor === 'empty' && workspace !== null);
  // 11-B：打开文本域（未选具体文件）也进 live 目录链 —— readTextCatalog 扫全部
  // 已索引 MSG 容器，不依赖选中文件；否则「文本→item」的第一步就做不出来。
  const fmgPanelLive = fmgLive
    || (activeDomain === 'text' && activeEditor === 'empty'
      && typeof bridge?.readTextCatalog === 'function'
      && typeof bridge?.readFmgTablePage === 'function');
  const showEventWorkbench = activeEditor === 'event'
    || (activeDomain === 'event' && activeEditor === 'empty' && workspace !== null);
  // T2：开始页（project 域）接管空工作区，欢迎层不再覆盖它 —— 欢迎层只在
  // 非开始工作域的「无工作区」空态出现，避免 z-index:3 拦截开始页按钮点击。
  const showEditorWelcome = activeDomain !== 'project' && shouldShowEditorWelcome({
    hasWorkspace: workspace !== null,
    openTabCount: openTabs.length
  });

  const spectralTheme = useSpectralTheme();

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      // 三条关闭路径之一：Escape 关闭命令面板，走统一出口保证焦点归还。
      //（路径：Escape、Ctrl+K 再按、点遮罩，都用 closeCmdk，否则焦点归还变成随机的。）
      if (event.key === 'Escape' && cmdkOpen) {
        closeCmdk();
        return;
      }
      // T7：壳层/工作台键统一走键位表（keybindings/keymapTable.ts + applyKeybinding.ts）。
      // Ctrl 与 Meta 等价（沿用既有 handler 的行为）；输入框/textarea/contenteditable/
      // Agent composer 内由 resolveKeybinding 的 editable-target 守卫放行原生编辑键，
      // 壳层三键始终命中（守卫前置）。
      const target = event.target;
      const targetIsEditable = target instanceof HTMLElement && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable === true
        || target.closest('.agent__composer') !== null
      );
      const outcome = resolveKeybinding(
        {
          key: event.key,
          ctrlKey: event.ctrlKey || event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: false
        },
        activeDomain,
        { targetIsEditable, viewportPointerActive: false }
      );
      // App 只接管壳层三键；edit/domain 键由各工作台组件自己处理，这里不 preventDefault。
      if (!outcome.hit || outcome.entry.scope !== 'shell') return;
      event.preventDefault();
      switch (outcome.entry.id) {
        case 'shell.command-palette':
          if (cmdkOpen) closeCmdk(); else openCmdk();
          break;
        case 'shell.agent':
          setAgentOpen((open) => !open);
          break;
        case 'shell.sidebar':
          setSidebarCollapsed((collapsed) => !collapsed);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [cmdkOpen, activeDomain]);

  // 首个候选变更出现时自动切到暂存面板，保证审查动作可见可达。
  useEffect(() => {
    const previous = prevPendingCountRef.current;
    prevPendingCountRef.current = pendingChangeCount;
    if (previous === 0 && pendingChangeCount > 0) {
      setSidebarCollapsed(false);
      showSidebarView('staging');
    }
  }, [pendingChangeCount]);

  useEffect(() => {
    if (!hasUncommittedChanges) return undefined;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUncommittedChanges]);

  /** Electron-only 操作在 browser-preview 表面的统一可见降级：不抛异常、不静默。 */
  function announceDesktopOnly(operation: string): void {
    const message = describeBridgeAbsence(operation);
    setStatus(message);
    pushToast(message, 'warn');
  }

  function openCmdk(): void {
    // 记住打开前的焦点：关闭时要还回去，否则焦点掉回文档开头，键盘用户丢失
    // 上下文（刚才在哪一行、哪个按钮上，全部要重新 Tab 找回）。
    cmdkReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setCmdkQuery('');
    setCmdkIndex(0);
    setCmdkOpen(true);
    window.setTimeout(() => cmdkInputRef.current?.focus(), 30);
  }

  function closeCmdk(): void {
    setCmdkOpen(false);
    // 焦点归还。用 setTimeout 让它排在 React 卸载模态之后：卸载时浏览器会把焦点
    // 打回 body，先 focus 再卸载等于白做。
    const target = cmdkReturnFocusRef.current;
    cmdkReturnFocusRef.current = null;
    if (target !== null && document.contains(target)) {
      window.setTimeout(() => target.focus(), 0);
    }
  }

  /**
   * 模态内的 Tab 环绕。
   *
   * 命令面板与 Agent 抽屉都是 role="dialog"，但此前都不拦 Tab——焦点可以 Tab 出
   * 模态落到背后的主界面上。对键盘/屏幕阅读器用户来说是「对话框开着，但我在操作
   * 被它遮住的东西」，且没有任何提示。
   *
   * 索引计算与可聚焦判定都在 a11y/focusTrap.ts（纯逻辑、有单测覆盖环绕边界）；
   * 这里只负责 DOM 查询与 focus() 调用。
   */
  function trapTabWithin(container: HTMLElement | null, event: ReactKeyboardEvent): void {
    if (container === null || event.key !== 'Tab') return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => isTrappableElement(element));
    if (focusable.length === 0) return;
    const currentIndex = focusable.findIndex((element) => element === document.activeElement);
    const nextIndex = nextTrappedFocusIndex({
      focusableCount: focusable.length,
      currentIndex,
      shift: event.shiftKey
    });
    if (nextIndex < 0) return;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  function focusSearchPanel(): void {
    setSidebarCollapsed(false);
    showSidebarView('search');
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handleMove = (moveEvent: PointerEvent): void => {
      // R5 裁定：侧栏下限与其他工作台栏一致——几乎能拖没，只留一条不让整列消失。
      setSidebarWidth(Math.min(480, Math.max(44, startWidth + moveEvent.clientX - startX)));
    };
    const handleUp = (): void => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  /**
   * 13-C：tabbar 指针按住拖 = 横向滚。
   *
   * 在 tabbar 上按下（左键）记起点，pointermove 时按位移负向换算 scrollLeft——
   * 手指/指针向右拖，内容向左滚。点击 tab（按下即抬起且几乎不动）不触发位移，
   * 点击选择语义保留。
   */
  function startTabbarDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const el = event.currentTarget;
    tabbarDragRef.current = { startX: event.clientX, startScrollLeft: el.scrollLeft };
  }

  function moveTabbarDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = tabbarDragRef.current;
    if (!drag) return;
    event.currentTarget.scrollLeft = drag.startScrollLeft - (event.clientX - drag.startX);
    event.preventDefault();
  }

  function endTabbarDrag(): void {
    tabbarDragRef.current = null;
  }

  /**
   * 13-C：滚轮（含竖向滚轮）在 tabbar 上改 scrollLeft。
   *
   * 用原生非被动 wheel 监听才能 preventDefault——否则竖向滚轮会落到下方工作台，
   * 与 tabbar 本身完全不滚横向冲突。deltaY + deltaX 都折算进 scrollLeft。
   */
  useEffect(() => {
    const el = tabbarRef.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent): void => {
      el.scrollLeft += event.deltaY + event.deltaX;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function pushToast(text: string, kind: 'ok' | 'warn' = 'ok'): void {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((list) => {
      if (list.some((toast) => toast.text === text)) return list;
      return [...list, { id, text, kind }];
    });
    window.setTimeout(() => {
      setToasts((list) => list.filter((toast) => toast.id !== id));
    }, 4200);
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
  // 8-A：Composer 思考强度按当前选中服务的协议换表；没有服务时当 openai-compatible。
  const activeAgentProtocol = agentServices
    .find((service) => service.id === agentServiceId)?.protocol ?? 'openai-compatible';

  const sidebarStyle = { '--sidebar-w': `${sidebarWidth}px` } as CSSProperties;
  const agentStyle = { '--agent-w': `${agentWidth}px` } as CSSProperties;

  return (
    <>
    <AmbientField manifest={spectralTheme.manifest} />
    <div className="app-root">
      {/* ══════════ 标题栏 ══════════ */}
      <header className="titlebar">
        <div className="titlebar__brand">
          <img className="brand-mark" src={SOULFORGE_ICON_URL} width="16" height="16" alt="" aria-hidden="true" />
          <span className="brand-name">SoulForge</span>
          {/* 问题 1：不可点的品牌标签 → 壳层常驻的 workspace-switcher 按钮/菜单。
              有工作区后换 Mod 工作区 / 原版目录的任何领域入口都在这里（打开/更换
              Mod、选择/更换/清原版三件事与旧开始页同一套 handler）。 */}
          <div className="workspace-switcher" data-testid="workspace-switcher">
            <button
              type="button"
              className="workspace-switcher__trigger"
              onClick={() => setWorkspaceSwitcherOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={workspaceSwitcherOpen}
              title={sessionMeta?.workspaceLabel ?? workspace?.workspaceLabel ?? '未打开工作区'}
            >
              <span className="workspace-switcher__label">{workspace?.workspaceLabel ?? '未打开工作区'}</span>
              <span className="workspace-switcher__game"> · {sessionMeta?.game ?? 'sekiro'}</span>
              <span className="workspace-switcher__caret" aria-hidden="true">▾</span>
            </button>
            {workspaceSwitcherOpen && (
              <>
                <div
                  className="workspace-switcher__backdrop"
                  onClick={() => setWorkspaceSwitcherOpen(false)}
                  aria-hidden="true"
                />
                <div className="workspace-switcher__menu" role="menu" data-testid="workspace-switcher-menu">
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="switcher-open-workspace"
                    onClick={() => { setWorkspaceSwitcherOpen(false); void openWorkspace(); }}
                    {...(isBrowserPreview ? { 'aria-disabled': true } : {})}
                  >
                    {workspace ? '更换 Mod 工作区' : '打开 Mod 工作区'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="switcher-choose-base-directory"
                    onClick={() => { setWorkspaceSwitcherOpen(false); void chooseBaseDirectory(); }}
                    {...(isBrowserPreview ? { 'aria-disabled': true } : {})}
                  >
                    {baseRootChoice ? '更换原版目录' : '选择原版目录'}
                  </button>
                  {baseRootChoice && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="switcher-clear-base-directory"
                      onClick={() => { setWorkspaceSwitcherOpen(false); clearBaseDirectory(); }}
                    >
                      清除原版目录
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="titlebar__center">
          <button type="button" className="cmdk-trigger" onClick={openCmdk} title="命令面板">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16.5 16.5 L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>搜索资源或命令…</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>
      </header>

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
          <section className={sidebarView === 'explorer' ? 'panel is-active' : 'panel'} data-panel-id="explorer" aria-label="资源浏览器">
            <div className="panel__header">
              <h2 className="panel__title">资源浏览器</h2>
              {/* SHELL-09：数量只在 Files 物理浏览内出现且带语义单位（§3.3）；
                 语义领域不显示任何文件数。12-E：语义领域不再拼「XX 逻辑库」，
                 hint 为空时不渲染空 span；project 的「开始」按问题 6 处理。 */}
              {activeDomain === 'files' ? (
                <span className="panel__hint">
                  {formatFilesCount(physicalBrowseFiles.length)}
                </span>
              ) : activeDomain === 'project' ? (
                <span className="panel__hint">开始</span>
              ) : null}
              <SidebarCloseButton onClose={() => setSidebarCollapsed(true)} />
            </div>
            <div className="panel__body panel__body--pad">
              {isBrowserPreview && (
                <div className="runtime-notice" role="note">
                  浏览器预览：文件系统功能仅在 SoulForge 桌面版可用
                </div>
              )}
              {activeDomain === 'files' ? (
                <>
                  <div className="search-box">
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="过滤路径 / 类型"
                      aria-label="过滤资源列表"
                    />
                  </div>
                  {/* SHELL-09：物理 taxonomy 只出现在 Files 领域（§16 resourceFamilies
                      从领域栏 production 依赖中移除）。资源族过滤条已断开：Files 物理
                      浏览由搜索框（路径/类型子串）+ .file-list 承载。显示不设限：
                      过滤后的完整集合一次 map，由 .file-list 自身滚动。 */}
                  <div className="file-list">
                    {physicalBrowseFiles.map((file) => (
                      <button
                        type="button"
                        key={file.sourceUri}
                        className={selectedFile?.sourceUri === file.sourceUri ? 'file-item selected' : 'file-item'}
                        onClick={() => void selectFile(file)}
                      >
                        <span className="file-item__name">{file.relativePath}</span>
                        <small className="file-item__meta">{file.resourceKind} | {file.formatLabel} | {(file.size / 1024).toFixed(1)} KB</small>
                      </button>
                    ))}
                    {physicalBrowseFiles.length === 0 && (
                      <p className="empty-hint">当前目录没有匹配资源。可切换到 all 或调整路径过滤。</p>
                    )}
                  </div>
                </>
              ) : activeDomain === 'project' ? (
                /* 开始态侧栏已拆。有工作区后点「开始」只折资源栏、不把
                   activeDomain 写成 project，所以这段只在无工作区的首次冷启动
                   命中——中央 StartWorkspacePanel 是大入口，侧栏只留一行引导文案。
                   暂存区 / 审计与回滚入口在活动栏 ab-item，搜索走 Ctrl+K。 */
                <p className="empty-hint">
                  打开 Mod 工作区后，这里会列出该领域的可打开资源。
                </p>
              ) : (
                <DomainLibraryList
                  files={domainLibraries}
                  {...(domainGroups ? { groups: domainGroups } : {})}
                  selectedUri={selectedFile?.sourceUri ?? null}
                  emptyHint={
                    workspace
                      ? `${domainLabel(activeDomain)} 工作区里还没有可打开的文件。可到「文件」领域按路径浏览。`
                      : '打开 Mod 工作区后，这里会列出该领域可打开的资源。'
                  }
                  onSelect={(file) => {
                    const match = indexedFiles.find((item) => item.sourceUri === file.sourceUri);
                    if (match) void selectFile(match);
                  }}
                />
              )}
            </div>
          </section>

          {/* ── 搜索 ── */}
          <section className={sidebarView === 'search' ? 'panel is-active' : 'panel'} data-panel-id="search" aria-label="搜索">
            <div className="panel__header">
              <h2 className="panel__title">搜索</h2>
              <SidebarCloseButton onClose={() => setSidebarCollapsed(true)} />
            </div>
            <div className="panel__body panel__body--pad">
              <div className="search-box search-box--with-action">
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void search();
                    }
                  }}
                  placeholder="在资源中搜索…"
                  autoComplete="off"
                  aria-label="在资源中搜索"
                />
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void search()}>搜索</button>
              </div>
              <div className="search-results">
                {query.trim() === '' && (
                  <p className="empty-hint">输入关键字，按路径 / 类型检索工作区资源；回车调用资源搜索。</p>
                )}
                {query.trim() !== '' && searchHits.length === 0 && <p className="empty-hint">无匹配结果。</p>}
                {query.trim() !== '' && searchHits.map((file) => (
                  <button type="button" key={file.sourceUri} className="search-hit" onClick={() => void selectFile(file)}>
                    <div className="search-hit__path">{file.relativePath}</div>
                    <div className="search-hit__line">{file.resourceKind} · {file.formatLabel} · {(file.size / 1024).toFixed(1)} KB</div>
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* ── 暂存区 ── */}
          <section className={sidebarView === 'staging' ? 'panel is-active' : 'panel'} data-panel-id="staging" aria-label="暂存区">
            <div className="panel__header">
              <h2 className="panel__title">暂存区</h2>
              <span className={pendingChangeCount > 0 ? 'pill pill--warn' : 'pill'}>
                {pendingChangeCount > 0 ? `${pendingChangeCount} 项待处理` : '暂存为空'}
              </span>
              <SidebarCloseButton onClose={() => setSidebarCollapsed(true)} />
            </div>
            <div className="panel__body panel__body--pad">
              <ChangeQueuePanel
                state={changeState}
                actions={{
                  approve: (id) => { approveChange(id); },
                  reject: (id) => { rejectChange(id); },
                  undoToDraft: (id) => { undoChangeToDraft(id); },
                  discard: (id) => { discardChange(id); },
                  clearTerminal: () => { clearTerminalChanges(); },
                  commit: () => { void commitStagedChanges(); }
                }}
              />
            </div>
          </section>

          {/* ── 审计与回滚 ── */}
          <section className={sidebarView === 'audit' ? 'panel is-active' : 'panel'} data-panel-id="audit" aria-label="审计与回滚">
            <div className="panel__header">
              <h2 className="panel__title">审计与回滚</h2>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!workspace} onClick={() => void refreshOperationHistory()}>
                刷新
              </button>
              <SidebarCloseButton onClose={() => setSidebarCollapsed(true)} />
            </div>
            <div className="panel__body panel__body--pad">
              {!workspace && <p className="empty-hint">打开工作区并完成至少一次补丁提交后可在此回滚。</p>}
              {workspace && operationHistory.length === 0 && (
                <p className="empty-hint">尚无已记录操作。写入暂存变更后会记录到持久操作日志。</p>
              )}
              <div className="audit-timeline">
                {operationHistory.map((entry) => (
                  <div
                    key={entry.opId}
                    className={
                      entry.status === 'rolled_back'
                        ? 'audit-entry audit-entry--rollback'
                        : entry.status === 'failed'
                          ? 'audit-entry audit-entry--failed'
                          : 'audit-entry audit-entry--commit'
                    }
                  >
                    <div className="audit-entry__title">{entry.title}</div>
                    <div className="audit-entry__meta">
                      <span className={`op-status op-status-${entry.status}`}>{operationStatusLabel(entry.status)}</span>
                      <span>{entry.fileCount} 个文件 · {entry.committedAt ?? entry.createdAt}</span>
                    </div>
                    <div className="audit-entry__meta" title={entry.changedPaths.join('\n')}>
                      <span>
                        {entry.changedPaths[0] ? shortenPath(entry.changedPaths[0]) : '—'}
                        {entry.changedPaths.length > 1 ? ` +${entry.changedPaths.length - 1}` : ''}
                      </span>
                    </div>
                    {entry.status === 'committed' && (
                      <div className="audit-entry__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={rollbackInFlight === `operation:${entry.opId}`}
                          onClick={() => void rollbackOp(entry.opId)}
                        >
                          {rollbackInFlight === `operation:${entry.opId}` ? '回滚中…' : '回滚'}
                        </button>
                        <details className="audit-entry__files">
                          <summary>文件级回滚（{entry.fileCount}）</summary>
                          {entry.changedPaths.map((path) => (
                            <div key={`${entry.opId}:${path}`} className="audit-entry__file">
                              <span className="audit-entry__file-path" title={path}>{shortenPath(path)}</span>
                              {path === '[本机路径已隐藏]' ? null : (
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  disabled={rollbackInFlight === `file:${entry.opId}:${path}`}
                                  onClick={() => void rollbackFileOp(entry.opId, path)}
                                >
                                  {rollbackInFlight === `file:${entry.opId}:${path}` ? '回滚中…' : '回滚此文件'}
                                </button>
                              )}
                            </div>
                          ))}
                        </details>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>

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
          {activeEditor === 'gparam' && (
            <GparamWorkbench
              key={`gparam-wb:${selectedFile?.sourceUri ?? 'none'}`}
              banks={gparamBanks}
              {...(selectedFile?.sourceUri ? { initialUri: selectedFile.sourceUri } : {})}
            />
          )}
          {activeDomain === 'gparam' && activeEditor === 'empty' && gparamBanks.length > 0 && (
            <GparamWorkbench
              key={`gparam-wb:${gparamBanks.map((b) => b.sourceUri).join(',')}`}
              banks={gparamBanks}
            />
          )}
          {activeDomain === 'gparam' && activeEditor === 'empty' && gparamBanks.length === 0 && (
            <section className="domain-placeholder" data-testid="gparam-placeholder" aria-label="GPARAM 工作域">
              <span className="domain-placeholder__eyebrow">GPARAM</span>
              <h2>GPARAM 工作台</h2>
              <p>工作区中没有 GPARAM 文件。挂载包含 drawparam 的 Mod 工作区后这里会列出所有 bank。</p>
            </section>
          )}
          {activeDomain === 'texture' && activeEditor === 'empty' && textureContainers.length > 0 && (
            <TpfWorkbenchPanel
              key={`tpf-wb:${textureContainers.map((c) => c.sourceUri).join(',')}`}
              containers={textureContainers}
            />
          )}
          {activeDomain === 'texture' && activeEditor === 'empty' && textureContainers.length === 0 && (
            <section className="domain-placeholder" data-testid="texture-placeholder" aria-label="纹理工作域">
              <span className="domain-placeholder__eyebrow">TEXTURE</span>
              <h2>Texture 工作台</h2>
              <p>工作区中没有 TPF 文件。挂载包含纹理包的 Mod 工作区后这里会列出所有容器。</p>
            </section>
          )}
          {activeDomain === 'vfx' && activeEditor === 'empty' && vfxFiles.length > 0 && (
            <VfxWorkbenchPanel
              key={`vfx-wb:${vfxFiles.map((f) => f.sourceUri).join(',')}`}
              files={vfxFiles}
            />
          )}
          {activeDomain === 'vfx' && activeEditor === 'empty' && vfxFiles.length === 0 && (
            <section className="domain-placeholder" data-testid="vfx-placeholder" aria-label="VFX 工作域">
              <span className="domain-placeholder__eyebrow">VFX</span>
              <h2>VFX 工作台</h2>
              <p>工作区中没有 FXR 文件。挂载包含特效文件（.fxr）的 Mod 工作区后这里会列出所有特效条目。</p>
            </section>
          )}
          {activeDomain === 'material' && activeEditor === 'empty' && materialFiles.length > 0 && (
            <MaterialWorkbenchPanel
              key={`mtd-wb:${materialFiles.map((file) => file.sourceUri).join(',')}`}
              files={materialFiles}
            />
          )}
          {activeDomain === 'material' && activeEditor === 'empty' && materialFiles.length === 0 && (
            <section className="domain-placeholder" data-testid="material-placeholder" aria-label="材质工作域">
              <span className="domain-placeholder__eyebrow">MATERIAL</span>
              <h2>Material 工作台</h2>
              <p>工作区中没有 MTD 文件。挂载包含材质定义的 Mod 工作区后这里会列出所有文件。</p>
            </section>
          )}
          {activeEditor === 'empty' && activeDomain !== 'gparam' && activeDomain !== 'texture'
            && activeDomain !== 'vfx' && activeDomain !== 'material'
            && !paramWorkbenchFile && !showTextWorkbench && !showEventWorkbench && (
            activeDomain === 'files'
              ? <p className="muted">在左侧选择一个文件开始编辑。</p>
            : <section className="domain-placeholder" data-testid="domain-editor-placeholder" aria-label={`${domainLabel(activeDomain)} 工作域`}>
                <span className="domain-placeholder__eyebrow">DOMAIN / {domainLabel(activeDomain)}</span>
                <h2>从左侧打开一个文件</h2>
                <p>
                  {domainLibraries.length > 0
                    ? '从左侧选择已打开的资源，或按 Ctrl K 搜索。'
                    : '从左侧选择一个文件开始编辑，可到「文件」领域按路径浏览。'}
                </p>
              </section>
          )}
          {/* Structured preview / 原生格式检查 / 原始字节视图在 S12 前曾常驻此面板，
              把编辑器挤到滚动区外。S12 拍死：编辑壳不再展示证据投影与 hex 视图，
              它们只存在于 main / AI 引用 / 开发者通道。 */}
          {/* 纯文本编辑器只在 plain-text 时出现。
              此前条件是 `previewKind === 'text'`，而它对 FMG/msg 资源同样为真，
              于是文本编辑器会和 FMG 文本工作台**叠在一起**——同一个资源两个编辑区，
              正是「一叠卡片」的又一处来源。 */}
          {activeEditor === 'plain-text' && (
            <section className="text-editor-panel">
              <div className="text-editor-toolbar">
                <strong>文本编辑器</strong>
                <div>
                  <button type="button" disabled={!editDirty} onClick={() => void saveCurrentText()}>保存</button>
                  <button type="button" disabled={!editDirty} onClick={() => setEditText(lastSavedText)}>还原</button>
                </div>
              </div>
              {hasMsgTable && (
                <MsgTableEditor
                  rows={msgRows}
                  onAdd={addMsgRow}
                  onRemove={removeMsgRow}
                  onUpdate={updateMsgRow}
                />
              )}
              <textarea
                value={editText}
                readOnly={!canEditText}
                onChange={(event) => setEditText(event.target.value)}
                spellCheck={false}
                /* 主编辑器此前无可访问名：屏幕阅读器只念「文本区域」，用户无从
                   判断正在编辑哪个资源。只读态也要说明，否则「改不了」在无障碍
                   视角下是静默的。 */
                aria-label={selectedFile
                  ? `${selectedFile.relativePath} 文本内容${canEditText ? '' : '（只读）'}`
                  : '资源文本内容（未选择文件）'}
                aria-readonly={!canEditText}
              />
              {saveDiagnostics.length > 0 && (
                <div className="save-diagnostics">
                  {saveDiagnostics.map((message) => <span key={message}>{message}</span>)}
                </div>
              )}
            </section>
          )}
          {activeEditor === 'map' && (
            <>
              {/* 删掉了「实时 Bridge MSB parts / 空场景（未选中可解析 MSB 或读取失败）」
                  这行标题：工作台自己有标题栏与空态提示，这行只是重复；而「未选中
                  可解析 MSB 或读取失败」把两种完全不同的情形（还没选文件 / 选了但
                  读不出来）混成一句，用户无法据此判断下一步做什么。读取失败由
                  工作台自身的错误态表达。 */}
              <MsbScenePanel
                key={`${selectedFile?.sourceUri ?? ''}:${msbSourceHash ?? ''}:${msbParts.length}:${msbRegions.length}:${msbRoutes.length}`}
                mapResourceUri={selectedFile?.sourceUri ?? ''}
                sourcePath={selectedFile?.relativePath ?? ''}
                game="sekiro"
                revision={msbSourceHash ?? '未加载'}
                models={msbModels}
                parts={msbParts}
                regions={msbRegions}
                events={msbEvents}
                routes={msbRoutes}
                sourceCounts={msbSourceCounts}
                onRevisionChange={setMsbSourceHash}
                openFailure={lastOpenFailure?.kind === 'msb-open-failed' ? lastOpenFailure : null}
              />
            </>
          )}
          {/* EVENT-30B 事件工作台移出本边界：它跨资源/跨编辑域保留 tab 与
              EditorState，不能用 activeEditor key 每次重建。 */}
          {showTextWorkbench && (
            <>
              {/* 同上：删掉「实时 Bridge FMG · hash … / 空条目（未选中可解析 FMG
                  或读取失败）」标题行。 */}
              <FmgWorkbenchPanel
                key={selectedFile?.sourceUri ?? ''}
                resourceUri={selectedFile?.sourceUri ?? ''}
                entries={fmgEntries}
                live={fmgPanelLive}
                revealRequest={fmgRevealRequest}
                onRevealHandled={clearFmgRevealRequest}
                onMutation={submitFmgEntry}
              />
            </>
          )}
          {/* PARAM 容器工作台（Smithbox 式三栏）。
              打开 parambnd 时它是主视图：容器本身不是可解析的 PARAM
              （read-param-document 不解 DCX/BND4，直接喂容器会报
              「PARAM 类型名偏移无效」），必须先在左栏选容器内某个 param。
              这正是此前「打开 gameparam.parambnd.dcx 显示 0 行」的原因。 */}
          {paramWorkbenchFile && (
            <ParamWorkbench
              key={`param-wb:${paramWorkbenchFile.sourceUri}`}
              containerUri={paramWorkbenchFile.sourceUri}
              containerLabel={paramWorkbenchFile.relativePath}
              fieldEnums={paramFieldEnums}
              resolveDefinition={(typeName, rowDataSizeFromPage) => {
                // 只在类型名与行宽都对得上时给出定义：行宽不符说明这份元数据
                // 描述的是另一个版本的 param，按它解码会全部错位。
                if (!paramFieldDefs || paramFieldDefs.length === 0) return null;
                if (paramTypeName !== typeName) return null;
                if (paramRowDataSize !== rowDataSizeFromPage) return null;
                return {
                  schemaVersion: 1,
                  typeName,
                  version: 0,
                  rowDataSize: paramRowDataSize,
                  // 授信来源由主进程裁定，不在此处硬写（见 paramFieldDefsOrigin）。
                  origin: paramFieldDefsOrigin,
                  fields: paramFieldDefs
                };
              }}
              onApplyFieldMutation={applyContainerParamFieldMutation}
              onApplyRowNameMutation={applyContainerParamRowNameMutation}
              onApplyRowMutation={applyContainerParamRowMutation}
            />
          )}
          {activeEditor === 'param-rows' && (
            <>
              {/* 同上：删掉「实时 Bridge PARAM · hash … / 空行（未选中可解析 PARAM
                  或读取失败）」标题行。 */}
              <ParamTablePanel
                key={`${selectedFile?.sourceUri ?? ''}:${paramLive ? 'live' : 'empty'}:${paramSourceHash ?? ''}`}
                typeName={paramTypeName}
                resourceUri={selectedFile?.sourceUri ?? ''}
                rows={paramRows}
                live={paramLive}
                rowCount={paramRowCount}
                indexLoading={paramIndexLoading}
                indexDiagnostic={paramIndexDiagnostic}
                onReadRows={readParamRowsForPanel}
                revealRowId={paramRevealRowId}
                onRevealHandled={() => setParamRevealRowId(null)}
                onMutation={applyParamRowMutationFromPanel}
              />
              {paramLive && paramFieldDefinition !== null && paramFieldDefsOrigin === 'fixture' && (
                <p className="muted" data-testid="param-fielddefs-readonly">
                  字段当前只读。
                </p>
              )}
              {paramLive && paramFieldDefinition === null && paramFieldDefsDiagnostic !== null && (
                <p className="muted" data-testid="param-fielddefs-missing">
                  无字段定义（{paramFieldDefsDiagnostic.code}）：{paramFieldDefsDiagnostic.message}
                </p>
              )}
              <ParamDefPanel
                key={`paramdef:${paramLive ? 'live' : 'empty'}:${paramSourceHash ?? ''}`}
                typeName={paramLive ? paramTypeName : '未加载'}
                rowDataSize={paramLive ? paramRowDataSize : 0}
                origin={paramLive ? '待绑定' : 'fixture'}
                resourceUri={selectedFile?.sourceUri ?? ''}
                live={paramLive}
                definition={paramFieldDefinition}
                rows={paramRows}
                getRowDataBase64={(identity) => paramRowPayloads.get(paramPhysicalRowKey(identity))}
                {...(paramLive && selectedFile
                  ? {
                    // S29：裸 .param 字段直写（applyParamFieldMutation → Patch Engine），
                    // 不进审查队列；状态/重读由 applyParamFieldMutationFromPanel 负责。
                    onApplyFieldMutation: (input: {
                      rowId: number;
                      identity: ParamPhysicalRowIdentity;
                      fieldId: string;
                      value: number | string | boolean;
                      rowDataBase64: string;
                      definition: unknown;
                    }) => applyParamFieldMutationFromPanel(input)
                  }
                  : {})}
              />
            </>
          )}
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
            <WorkbenchOpsPanel
              jobs={[]}
              history={operationHistory.map((entry) => ({
                opId: entry.opId,
                status: entry.status,
                mode: entry.mode,
                summary: entry.title,
                createdAt: entry.createdAt,
                fileCount: entry.fileCount,
                canRollback: entry.status === 'committed'
              }))}
              rollbackBusyOpId={rollbackInFlight?.startsWith('operation:')
                ? rollbackInFlight.slice('operation:'.length)
                : null}
              diagnostics={(preview?.diagnostics ?? []).map((d) => ({
                severity: d.severity,
                code: d.code,
                message: d.message,
                ...(d.sourceUri ? { resourceUri: d.sourceUri } : {})
              }))}
              patchImpact={null}
              onCancelJob={() => setStatus('任务取消请求已记录；待 TaskQueue IPC。')}
              onRollback={(opId) => { void rollbackOp(opId); }}
            />
          )}
          {/* 删掉「空文件。」与「预览失败。」两句：它们既不说明问题也不给出动作，
              而且与下方的编辑器并存（一个资源同时出现「预览失败」和一张空表）。
              空文件的事实由编辑器自身的空态表达；读取失败由工作台错误态表达。 */}
          {activeEditor === 'tae' && selectedFile && (
            <TaeWorkbenchPanel resourceUri={selectedFile.sourceUri} data={taeData as never} />
          )}
          {activeEditor === 'esd' && selectedFile && (
            <EsdWorkbenchPanel resourceUri={selectedFile.sourceUri} data={esdData as never} />
          )}
          {activeEditor === 'flver' && selectedFile && (
            <FlverWorkbenchPanel
              key={`flver-wb:${selectedFile?.sourceUri ?? 'none'}:${flverData !== null}`}
              resourceUri={selectedFile.sourceUri}
              data={flverData as never}
              onMaterialSlotSet={(input) => { void applyFlverMaterialSlotSetAndReload(input); }}
            />
          )}
          {activeEditor === 'tpf' && (
            <TpfWorkbenchPanel
              key={`tpf-wb:${selectedFile?.sourceUri ?? 'none'}`}
              containers={textureContainers}
              {...(selectedFile?.sourceUri ? { initialUri: selectedFile.sourceUri } : {})}
            />
          )}
          {activeEditor === 'vfx' && selectedFile && (
            <VfxWorkbenchPanel
              key={`vfx-wb:${selectedFile.sourceUri}`}
              files={vfxFiles}
              initialUri={selectedFile.sourceUri}
            />
          )}
          {activeEditor === 'binary' && isMaterialFile && selectedFile && (
            <MaterialWorkbenchPanel
              key={`mtd-wb:${selectedFile.sourceUri}`}
              files={materialFiles}
              initialUri={selectedFile.sourceUri}
            />
          )}
          {activeEditor === 'binary' && isVfxFile && selectedFile && (
            <VfxWorkbenchPanel
              key={`vfx-wb:${selectedFile.sourceUri}`}
              files={vfxFiles}
              initialUri={selectedFile.sourceUri}
            />
          )}
          {activeEditor === 'binary' && !isMaterialFile && !isVfxFile && selectedFile && classifyWorkspaceOpen(selectedFile.relativePath).openKind !== 'history' && (
            <p className="muted">
              {classifyWorkspaceOpen(selectedFile.relativePath).openKind === 'blocked-scope'
                 ? '当前版本暂不支持 HKX 语义解析。'
                : classifyWorkspaceOpen(selectedFile.relativePath).openKind === 'blocked-no-parser'
                  ? '这个格式还没有确认过的 parser，不能声称已经读懂。'
                    : '这个格式还没有专用编辑器。'}
            </p>
          )}
          {activeEditor === 'binary' && !isMaterialFile && !isVfxFile && !selectedFile && (
            <p className="muted">这个格式还没有专用编辑器。</p>
          )}
          </PanelErrorBoundary>
          {/*
            EVENT-30B：事件工作台常驻挂载。切到 PARAM/MAP 域时只是 hidden，不卸载，
            因此 tab、dirty、每个 tab 的 EditorState 与用户滚动位置都保留。
          */}
          <PanelErrorBoundary key="panel-boundary:event" label="Event 源码工作台">
            <div hidden={!showEventWorkbench} className="event-source-host">
              <EventSourceWorkbenchPanel
                /* EVENT-30B：工作台自己管理多文档标签与 dirty；App 只按资源 URI
                   提供最近一次打开/刷新的有界投影（pendingTab），并把 DSL 提交能力
                   上抛。key 固定，切资源时工作台不重挂载，标签与未提交编辑得以保留。 */
                active={showEventWorkbench}
                opening={eventOpening}
                openingPreview={eventSourcePreview}
                pendingTab={eventPendingTab}
                onJumpResource={jumpToResource}
                onDslSubmit={submitEventDsl}
              />
            </div>
          </PanelErrorBoundary>
                </div>
              </div>
            </div>

            {/* ── 欢迎页：真实工作区摘要 ── */}
            <div className={`editor-welcome${showEditorWelcome ? '' : ' is-hidden'}`}>
              <div className="welcome">
                <div className="welcome__head">
                  <img src={SOULFORGE_ICON_URL} width="26" height="26" className="welcome-mark" alt="" aria-hidden="true" />
                  <h1>SoulForge</h1>
                  <span className="welcome__ws">{workspace?.workspaceLabel ?? '未打开工作区'} · {sessionMeta?.game ?? 'sekiro'}</span>
                </div>
                <p className="welcome__stats">{welcomeStats}</p>

                <section className="welcome__section" aria-label="待审查变更">
                  <div className="welcome-quick__label">待审查变更</div>
                  {draftChanges.length === 0 ? (
                    <p className="empty-hint welcome-empty">没有待审查的变更。</p>
                  ) : (
                    draftChanges.map((item) => (
                        <div className="review-row" key={item.id}>
                          <span className="review-row__target" title={item.sourceUri}>{item.target}</span>
                          <span className="review-row__delta">{item.summary}</span>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              setSidebarCollapsed(false);
                              showSidebarView('staging');
                            }}
                          >
                            审查
                          </button>
                        </div>
                      ))
                  )}
                </section>

                <section className="welcome__section" aria-label="最近打开">
                  <div className="welcome-quick__label">最近打开</div>
                  {openTabs.length === 0 ? (
                    <p className="empty-hint welcome-empty">暂无最近打开。从左侧资源树选择资源，或按 Ctrl K 搜索。</p>
                  ) : (
                    <div className="welcome-quick__grid">
                      {openTabs.slice(-6).reverse().map((tab) => (
                        <button type="button" key={tab.sourceUri} className="quick-item" onClick={() => void selectFile(tab)}>
                          <span className="quick-item__body">
                            <span className="quick-item__name">{tab.relativePath}</span>
                            <span className="quick-item__desc">{tab.resourceKind} · {tab.formatLabel}</span>
                          </span>
                          <span className="quick-item__ext">{tab.formatLabel}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <div className="welcome-meta">
                  <span>
                    {lastOperation
                      ? `最近写入 ${lastOperation.title} · ${lastOperation.committedAt ?? lastOperation.createdAt}`
                      : '本工作区尚无写入记录'}
                  </span>
                  <div className="welcome-shortcuts">
                    <span><kbd>Ctrl K</kbd> 命令面板</span>
                    <span><kbd>Ctrl J</kbd> AI Agent</span>
                    <span><kbd>Ctrl B</kbd> 侧栏</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {citeSelecting && (
            <CiteSelectScrim
              onSettle={(hits) => void handleCiteSettle(hits)}
              onCancel={() => setCiteSelecting(false)}
            />
          )}
        </main>

        {/* ══════════ Agent 面板 ══════════ */}
        {/* resize 已内聚到 AgentDockResizer（AgentSidebar 内部）；宽度状态仍由 App
            持有，因为 overlay 判定与 workspace 持久化都要读它。 */}
        <PanelErrorBoundary key="panel-boundary:agent" label="Agent 面板">
          <AgentSidebar
            open={agentOpen}
            style={agentStyle}
            expanded={agentExpanded}
            agentWidth={agentWidth}
            agentMinWidth={AGENT_MIN_WIDTH}
            agentMaxWidth={AGENT_MAX_WIDTH}
            onAgentWidthChange={(width) => {
              setAgentWidth(width);
              setAgentExpanded(false);
            }}
            busy={aiBusy}
            provider={aiProvider}
            thinking={aiThinking}
            protocol={activeAgentProtocol}
            permissionMode={aiMode}
            permissionLockReason={AI_PERMISSION_LOCK_REASON}
            goal={agentGoal}
            idleNotice={agentIdleNotice}
            draft={aiDraft}
            prompt={aiPrompt}
            contextLabel={domainLabel(activeDomain)}
            selectedFilePath={selectedFile?.relativePath ?? null}
            onResourcesChange={setAgentResources}
            onAttachmentsChange={handleAgentAttachmentsChange}
            tools={agentTools.length > 0 ? agentTools : tools}
            toolOutput={toolOutput}
            task={{
              task: agentTask,
              services: agentServices,
              selectedServiceId: agentServiceId,
              runBlocker: describeRunBlocker({
                hasBridge: bridge !== null,
                configId: agentServiceId,
                prompt: aiPrompt,
                active: isAgentTaskActive(agentTask)
              }),
              sessions: agentSessions,
              sessionsError: agentSessionsError,
              sessionDetail: agentSessionDetail,
              onSelectService: setAgentServiceId,
              onRun: () => void runAgentTask(),
              onCancel: () => void cancelAgentTask(),
              onRefreshSessions: () => void refreshAgentSessions(),
              onLoadSession: (sessionPath) => void loadAgentSession(sessionPath),
              onResumeSession: (sessionPath) => void runAgentTask(sessionPath),
              onRespondApproval: (callId, decision) => void respondAgentApproval(callId, decision),
              respondingApprovalCallId,
              approvalError
            }}
            eventUri={eventUri}
            onEventUriChange={setEventUri}
            onProviderChange={setAiProvider}
            onThinkingChange={setAiThinking}
            onPromptChange={setAiPrompt}
            onSend={() => void sendAgentPrompt()}
            citeSelecting={citeSelecting}
            onToggleCiteSelect={() => setCiteSelecting((selecting) => !selecting)}
            pendingCiteHits={pendingCiteHits}
            onCiteHitsConsumed={() => setPendingCiteHits(null)}
            onNewTask={startNewAgentTask}
            onToggleExpand={() => {
              setAgentExpanded((expanded) => !expanded);
              setAgentWidth((width) => width >= AGENT_MAX_WIDTH ? AGENT_DEFAULT_WIDTH : AGENT_MAX_WIDTH);
            }}
            interactionMode={agentInteractionMode}
            onInteractionModeChange={changeAgentInteractionMode}
            onClose={() => setAgentOpen(false)}
            onRunToolSearch={(toolQuery) => void runToolSearch(toolQuery)}
            onExplainEvent={(uri) => void explainEvent(uri)}
          />
        </PanelErrorBoundary>
      </div>

      {/* ══════════ 命令面板 ══════════ */}
      <div
        className={`cmdk-overlay${cmdkOpen ? ' is-open' : ''}`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeCmdk();
        }}
      >
        <div
          className="cmdk"
          role="dialog"
          aria-modal="true"
          aria-label="命令面板"
          ref={cmdkDialogRef}
          onKeyDown={(event) => trapTabWithin(cmdkDialogRef.current, event)}
        >
          <div className="cmdk__input-wrap">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={cmdkInputRef}
              value={cmdkQuery}
              onChange={(event) => {
                setCmdkQuery(event.target.value);
                setCmdkIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCmdkIndex((index) => (cmdkItemCount === 0 ? 0 : (index + 1) % cmdkItemCount));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCmdkIndex((index) => (cmdkItemCount === 0 ? 0 : (index - 1 + cmdkItemCount) % cmdkItemCount));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  runCmdkItem(selectedCmdkIndex);
                }
              }}
              placeholder="输入命令或搜索资源…"
              autoComplete="off"
              aria-label="输入命令或搜索资源"
            />
          </div>
          <div className="cmdk__list">
            {cmdkItemCount === 0 && (
              <p className="empty-hint">
                {workspace ? '无匹配命令或资源。' : '请先打开 Mod 工作区；打开后可搜索资源。'}
              </p>
            )}
            {filteredCmdkCommands.map((command, index) => (
              <button
                key={command.id}
                type="button"
                className={index === selectedCmdkIndex ? 'cmdk-item is-selected' : 'cmdk-item'}
                onClick={() => {
                  closeCmdk();
                  command.run();
                }}
              >
                <span className="cmdk-item__icon" aria-hidden="true">{command.icon}</span>
                <span className="cmdk-item__label">{command.label}</span>
                {command.hint && <span className="cmdk-item__hint">{command.hint}</span>}
              </button>
            ))}
            {cmdkAllResourceMatches.map((file, index) => {
              const itemIndex = filteredCmdkCommands.length + index;
              return (
                <button
                  key={file.sourceUri}
                  type="button"
                  className={itemIndex === selectedCmdkIndex ? 'cmdk-item is-selected' : 'cmdk-item'}
                  onClick={() => {
                    closeCmdk();
                    void selectFile(file);
                  }}
                >
                  <span className="cmdk-item__icon" aria-hidden="true">⌘</span>
                  <span className="cmdk-item__label">{file.relativePath}</span>
                  <span className="cmdk-item__hint">{file.formatLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

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
