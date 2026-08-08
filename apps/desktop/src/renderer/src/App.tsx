import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react';
import {
  DEFERRED_PREVIEW_TARGET_RELEASE,
  isDeferredPreviewEditorKind
} from '@soulforge/shared';
import type {
  Diagnostic,
  MsbMapEventLike,
  MsbModelLike,
  MsbPartTransformLike,
  MsbRegionLike,
  MsbSceneSourceCounts,
  ParamDefDocument,
  ResourceKind
} from '@soulforge/shared';
import type {
  AnalyzeWorkspaceSummary,
  DirectorySelection,
  RendererWorkspaceScanResult,
  RendererWorkspaceSession
} from '../../main/ipc.js';
import type {
  RendererIndexedFile,
  RendererPatchHistoryEntry,
  RendererResourcePreview
} from '../../main/rendererDto.js';
import type {
  AiPermissionMode,
  AiProvider,
  AiSidebarDraft,
  AiSidebarDraftRequest,
  AiThinkingLevel,
  ToolDescriptor,
  ToolResult
} from '@soulforge/core';
import { HexEditorPanel } from './editors/HexEditorPanel.js';
import { MsbScenePanel } from './editors/MsbScenePanel.js';
import { EmevdFourViewPanel } from './editors/EmevdFourViewPanel.js';
import { FmgWorkbenchPanel } from './editors/FmgWorkbenchPanel.js';
import { ParamTablePanel } from './editors/ParamTablePanel.js';
import { WorkbenchOpsPanel } from './editors/WorkbenchOpsPanel.js';
import { ParamDefPanel } from './editors/ParamDefPanel.js';
import { TaeWorkbenchPanel } from './editors/TaeWorkbenchPanel.js';
import { EsdWorkbenchPanel } from './editors/EsdWorkbenchPanel.js';
import { FlverWorkbenchPanel } from './editors/FlverWorkbenchPanel.js';
import { TpfWorkbenchPanel } from './editors/TpfWorkbenchPanel.js';
import { ScriptContainerPanel } from './editors/ScriptContainerPanel.js';
import { Bnd4WorkbenchPanel } from './editors/Bnd4WorkbenchPanel.js';
import type { EmevdEditorDocument } from '@soulforge/shared';
import {
  mapEmevdEnvelopeToDocument,
  type BridgeEmevdEnvelopeLike
} from './emevd/mapEmevdEnvelope.js';
import {
  ChangeControlStore,
  type CandidateChange,
  type ChangeDiagnostic
} from './staging/changeControl.js';
import { ChangeQueuePanel } from './staging/ChangeQueuePanel.js';
import {
  describeBridgeAbsence,
  getRendererRuntime
} from './runtime/rendererRuntime.js';
import { RESOURCE_FAMILIES, type ResourceMode } from './navigation/resourceFamilies.js';
import { WorkspaceResourceBar } from './navigation/WorkspaceResourceBar.js';
import { Me3RuntimePanel } from './runtime/Me3RuntimePanel.js';
import { AgentSidebar } from './agent/AgentSidebar.js';
import type {
  AgentSessionDetail,
  AgentSessionRow,
  ModelServiceChoice
} from './agent/AgentTaskPanel.js';
import {
  INITIAL_AGENT_TASK_STATE,
  describeRunBlocker,
  isAgentTaskActive,
  markAgentTaskCancelling,
  reduceAgentTaskEvent,
  startAgentTask,
  type AgentTaskState
} from './agent/agentTaskState.js';
import {
  NativeInspectionCard,
  StructuredPreviewCard
} from './components/PreviewCards.js';
import { MsgTableEditor } from './components/MsgTableEditor.js';
import { PanelErrorBoundary } from './components/PanelErrorBoundary.js';
import {
  extractMsgRows,
  nextMsgId,
  serializeMsgRowsToTsv,
  type EditableMsgRow
} from './format/msgRows.js';
import {
  FILE_LIST_PAGE_SIZE,
  SEARCH_HIT_LIMIT,
  filterFilesForMode,
  formatListTruncation,
  formatPageRange,
  formatPreviewTruncation,
  operationStatusLabel,
  shortenPath
} from './format/uiText.js';
import { resetAllDocuments, type DocumentResetActions } from './staging/documentReset.js';
import {
  FOCUSABLE_SELECTOR,
  isTrappableElement,
  nextTrappedFocusIndex
} from './a11y/focusTrap.js';

type SidebarView = 'explorer' | 'search' | 'staging' | 'audit' | 'settings';

/** 中央内容：资源编辑 / 任务与历史；设置位于左侧面板，不再占用中央区。 */
type CenterView = 'resource' | 'operations' | 'settings';

/** P0 安全收口：权限模式由主进程锁定，renderer 不得自行切换。 */
const AI_PERMISSION_LOCK_REASON = 'P0 安全收口期间由主进程锁定为计划模式；renderer 不能抬高授权。';

/** 欢迎页「待审查变更」摘要显示条数。摘要之外的条数由截断说明报出。 */
const WELCOME_DRAFT_LIMIT = 5;

/** 命令面板（Ctrl K）列出的资源命中条数。命中总数由截断说明报出。 */
const CMDK_RESOURCE_HIT_LIMIT = 8;

/** 无实时 MSB 数据时的空 parts（真实数据经 Bridge 读取后填充）。 */
const EMPTY_MSB_PARTS: MsbPartTransformLike[] = [];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function hexTextToBase64(hexText: string): string {
  const cleaned = hexText.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length < 2) return btoa('');
  const bytes = new Uint8Array(Math.floor(cleaned.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** 无实时 EMEVD 文档时的空文档（真实文档经 Bridge 读取后替换）。 */
const EMPTY_EMEVD_DOCUMENT: EmevdEditorDocument = {
  schemaVersion: 1,
  resourceUri: '',
  revision: 0,
  bytesBase64: '',
  events: [],
  diagnostics: []
};

const EMPTY_FMG_ENTRIES: Array<{ id: number; text: string }> = [];

const EMPTY_PARAM_ROWS: Array<{ id: number; name?: string; dataHexPreview: string }> = [];

/**
 * 空 paramdef：origin 为 fixture 且无字段，definitionCanCommit 永不放行写入。
 *
 * ⚠️ 真实字段定义的来源**已实现但尚未接进 main**（2026-08-08 实测）：
 * packages/core/src/param/smithboxParamMetadataSource.ts 是 Paramdex-compatible
 * metadata 投影，已从 core barrel 导出（index.ts:72），并有
 * runSmithboxParamMetadataSourceSmoke 与 runParamMetadataNativeSmoke 两条验证。
 * 但 apps/desktop/src/main 侧对它零引用——没有任何 IPC 通道把它送到 renderer。
 *
 * 所以下面 :2261 那处 `definition={paramLive ? null : EMPTY_PARAM_DEF}` 的两条
 * 分支都进不了字段表：live 分支给 null 触发 ParamDefPanel 短路，非 live 分支给
 * fields:[] 导致 fieldViews 为空。这不是「投影不存在」，是最后一跳没接
 * ——原注释写成「来自 main 侧投影」是把待接线状态写成了已完成状态。
 *
 * 接线前不要把这里改成看起来能用：definitionCanCommit 靠 origin/fields 拦住写入，
 * 是保护性设计。要解除断点需先建 main→renderer 的 metadata 通道，
 * 且 matchParamMetadataPackage 要求显式用户信任策略（缺失报
 * PARAM_METADATA_TRUST_POLICY_REQUIRED 并拒绝匹配），不能绕过。
 */
const EMPTY_PARAM_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: '',
  version: 0,
  rowDataSize: 0,
  origin: 'fixture',
  fields: []
};

interface MsbPositionCommitInput {
  partName: string;
  posX: number;
  posY: number;
  posZ: number;
}

interface MsbTransformCommitInput {
  partName: string;
  posX: number;
  posY: number;
  posZ: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

/** applyMsbMutation 支持的原生 MSB mutation 形态（与 preload 通道一致）。 */
type MsbNativeMutation = {
  kind: 'set_part_position' | 'set_part_transform' | 'set_region_position';
  partName: string;
  posX?: number;
  posY?: number;
  posZ?: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
};

export function App(): ReactElement {
  // 运行表面在页面生命周期内稳定：Electron 桥接或 browser-preview 降级。
  const runtime = getRendererRuntime();
  const bridge = runtime.bridge;
  const isBrowserPreview = runtime.kind === 'browser-preview';
  const [workspace, setWorkspace] = useState<RendererWorkspaceScanResult | null>(null);
  const [sessionMeta, setSessionMeta] = useState<RendererWorkspaceSession | null>(null);
  const [baseRootChoice, setBaseRootChoice] = useState<DirectorySelection | null>(null);
  const [operationHistory, setOperationHistory] = useState<RendererPatchHistoryEntry[]>([]);
  const [analysis, setAnalysis] = useState<AnalyzeWorkspaceSummary | null>(null);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [selectedFile, setSelectedFile] = useState<RendererIndexedFile | null>(null);
  const [preview, setPreview] = useState<RendererResourcePreview | null>(null);
  const [editText, setEditText] = useState('');
  const [lastSavedText, setLastSavedText] = useState('');
  const [msgRows, setMsgRows] = useState<EditableMsgRow[]>([]);
  const [saveDiagnostics, setSaveDiagnostics] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [eventUri, setEventUri] = useState('');
  const [toolOutput, setToolOutput] = useState<ToolResult | null>(null);
  const [files, setFiles] = useState<RendererIndexedFile[]>([]);
  const [allFiles, setAllFiles] = useState<RendererIndexedFile[]>([]);
  const [resourceMode, setResourceMode] = useState<ResourceMode>('all');
  const [centerView, setCenterView] = useState<CenterView>('resource');
  const [bnd4Forced, setBnd4Forced] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('explorer');
  const [agentOpen, setAgentOpen] = useState(true);
  const [status, setStatus] = useState('就绪');
  const [emevdDocument, setEmevdDocument] = useState<EmevdEditorDocument>(EMPTY_EMEVD_DOCUMENT);
  const [emevdSourceHash, setEmevdSourceHash] = useState<string | null>(null);
  const [emevdLive, setEmevdLive] = useState(false);
  /** Patch-DSL template from the authoritative full document (main-side). */
  const [emevdDslTemplate, setEmevdDslTemplate] = useState<string | null>(null);
  const [emevdDslTemplateTruncated, setEmevdDslTemplateTruncated] = useState(false);
  const [emevdDslTemplateTotalLines, setEmevdDslTemplateTotalLines] = useState(0);
  const [taeData, setTaeData] = useState<Record<string, unknown> | null>(null);
  const [esdData, setEsdData] = useState<Record<string, unknown> | null>(null);
  const [flverData, setFlverData] = useState<Record<string, unknown> | null>(null);
  const [tpfData, setTpfData] = useState<Record<string, unknown> | null>(null);
  const [fmgEntries, setFmgEntries] = useState(EMPTY_FMG_ENTRIES);
  const [fmgSourceHash, setFmgSourceHash] = useState<string | null>(null);
  const [fmgLive, setFmgLive] = useState(false);
  const [msbParts, setMsbParts] = useState<MsbPartTransformLike[]>(EMPTY_MSB_PARTS);
  const [msbModels, setMsbModels] = useState<MsbModelLike[]>([]);
  const [msbRegions, setMsbRegions] = useState<MsbRegionLike[]>([]);
  const [msbEvents, setMsbEvents] = useState<MsbMapEventLike[]>([]);
  const [msbSourceCounts, setMsbSourceCounts] = useState<MsbSceneSourceCounts>({
    models: 0,
    parts: EMPTY_MSB_PARTS.length,
    regions: 0,
    events: 0
  });
  const [msbLive, setMsbLive] = useState(false);
  const [msbSourceHash, setMsbSourceHash] = useState<string | null>(null);
  const [paramTypeName, setParamTypeName] = useState('');
  const [paramRows, setParamRows] = useState(EMPTY_PARAM_ROWS);
  const [paramSourceHash, setParamSourceHash] = useState<string | null>(null);
  const [paramLive, setParamLive] = useState(false);
  const [paramRowPayloads, setParamRowPayloads] = useState<Map<number, string>>(new Map());
  const [paramRowDataSize, setParamRowDataSize] = useState<number>(16);

  const [aiProvider, setAiProvider] = useState<AiProvider>('mock');
  const [aiThinking, setAiThinking] = useState<AiThinkingLevel>('normal');
  const [aiMode] = useState<AiPermissionMode>('plan');
  const [aiPrompt, setAiPrompt] = useState('解释当前资源的证据链，并给出下一步安全修改计划。');
  const [aiDraft, setAiDraft] = useState<AiSidebarDraft | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [agentGoal, setAgentGoal] = useState<string | null>(null);
  /* ── AI agent 任务（REL-G 的 renderer 入口）───────────────────────────────
     任务状态全部由 agentTaskState 的纯函数折叠，本组件只持有它的当前值——
     折叠规则放在组件里就只能靠真实 Electron 才能测，而那一层抓不到规则本身的错。 */
  const [agentTask, setAgentTask] = useState<AgentTaskState>(INITIAL_AGENT_TASK_STATE);
  const [agentServices, setAgentServices] = useState<ModelServiceChoice[]>([]);
  const [agentServiceId, setAgentServiceId] = useState<string | null>(null);
  const [agentSessions, setAgentSessions] = useState<AgentSessionRow[]>([]);
  const [agentSessionsPage, setAgentSessionsPage] = useState(0);
  const [agentSessionsError, setAgentSessionsError] = useState<string | null>(null);
  const [agentSessionDetail, setAgentSessionDetail] = useState<AgentSessionDetail | null>(null);
  const [agentTools, setAgentTools] = useState<ToolDescriptor[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(264);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState('');
  const [cmdkIndex, setCmdkIndex] = useState(0);
  const [clockText, setClockText] = useState('--:--');
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; kind: 'ok' | 'warn' }>>([]);
  const [openTabs, setOpenTabs] = useState<RendererIndexedFile[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cmdkInputRef = useRef<HTMLInputElement>(null);
  const cmdkDialogRef = useRef<HTMLDivElement>(null);
  /** 命令面板打开前的焦点位置；关闭时归还，避免焦点掉回文档开头。 */
  const cmdkReturnFocusRef = useRef<HTMLElement | null>(null);
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
      setFmgEntries(EMPTY_FMG_ENTRIES);
      setFmgSourceHash(null);
      setFmgLive(false);
    },
    param: () => {
      setParamRows(EMPTY_PARAM_ROWS);
      setParamTypeName('');
      setParamSourceHash(null);
      setParamLive(false);
      setParamRowPayloads(new Map());
    },
    emevd: () => {
      setEmevdDocument(EMPTY_EMEVD_DOCUMENT);
      setEmevdSourceHash(null);
      setEmevdLive(false);
      setEmevdDslTemplate(null);
      setEmevdDslTemplateTruncated(false);
      setEmevdDslTemplateTotalLines(0);
    },
    msb: () => {
      setMsbParts(EMPTY_MSB_PARTS);
      setMsbModels([]);
      setMsbRegions([]);
      setMsbEvents([]);
      setMsbSourceCounts({ models: 0, parts: EMPTY_MSB_PARTS.length, regions: 0, events: 0 });
      setMsbLive(false);
      setMsbSourceHash(null);
    },
    tae: () => setTaeData(null),
    esd: () => setEsdData(null),
    flver: () => setFlverData(null),
    tpf: () => setTpfData(null)
  }), []);

  const counts = useMemo(() => workspace?.countsByKind ?? null, [workspace]);
  const diagnostics = [...(workspace?.diagnostics ?? []), ...(analysis?.diagnostics ?? []), ...(preview?.diagnostics ?? [])];
  // BND 不是顶层目录：选择真实 BND 文件后自动进入容器工作台，
  // 命令面板可对任意选中强制「以 BND4 容器打开」。
  const selectedIsContainer = selectedFile !== null
    && (selectedFile.formatKind === 'bnd' || selectedFile.formatKind === 'dcx'
      || selectedFile.compoundExtension.includes('.bnd')
      || selectedFile.compoundExtension.includes('.dcx'));
  const showBnd4Workbench = centerView === 'resource' && (bnd4Forced || selectedIsContainer);
  const canEditText = preview?.previewKind === 'text' && preview.structuredPreview?.editable === true && !preview.truncated;
  const hasMsgTable = canEditText && msgRows.length > 0;
  const editDirty = editText !== lastSavedText;
  const changeStore = useMemo(() => new ChangeControlStore(), []);
  const changeState = useSyncExternalStore(changeStore.subscribe, changeStore.getState);
  const pendingChangeCount = changeState.items.filter((item) =>
    item.status === 'draft' || item.status === 'staged' || item.status === 'failed'
  ).length;
  const hasUncommittedChanges = editDirty
    || changeState.items.some((item) => item.status === 'draft' || item.status === 'staged');

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === 'k') {
          event.preventDefault();
          if (cmdkOpen) {
            closeCmdk();
          } else {
            openCmdk();
          }
          return;
        }
        if (key === 'j') {
          event.preventDefault();
          setAgentOpen((open) => !open);
          return;
        }
        if (key === 'b') {
          event.preventDefault();
          setSidebarCollapsed((collapsed) => !collapsed);
          return;
        }
      }
      // 必须走 closeCmdk 而不是 setCmdkOpen(false)：后者绕过焦点归还，Escape 关闭
      // 后焦点会掉回文档开头。三条关闭路径（Escape、Ctrl+K 再按、点遮罩）都必须
      // 用同一个出口，否则「哪条路径会归还焦点」变成随机的。
      if (event.key === 'Escape' && cmdkOpen) closeCmdk();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [cmdkOpen]);

  useEffect(() => {
    const tick = (): void => {
      const now = new Date();
      setClockText(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`);
    };
    tick();
    const timer = window.setInterval(tick, 15000);
    return () => window.clearInterval(timer);
  }, []);

  // 首个候选变更出现时自动切到暂存面板，保证审查动作可见可达。
  useEffect(() => {
    const previous = prevPendingCountRef.current;
    prevPendingCountRef.current = pendingChangeCount;
    if (previous === 0 && pendingChangeCount > 0) {
      setSidebarCollapsed(false);
      setSidebarView('staging');
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

  /**
   * 订阅 AI agent 进度推送（onAiAgentEvent）。
   *
   * 这是 invoke 之外的第二种形态：主进程用 webContents.send 主动推
   * （ipc.ts:2899），preload 用 ipcRenderer.on 订阅并返回退订函数
   * （preload/index.ts:308-316）。挂载期只订阅一次，退订交给 effect 的清理函数——
   * 每次状态变化都重订会造成同一事件被折叠多次，而进度数字翻倍不会抛异常。
   *
   * 折叠里的会话隔离（reduceAgentTaskEvent 对 sessionId 不符者原样返回）保证
   * 上一次运行的迟到事件不会把新任务标成已结束。
   */
  useEffect(() => {
    if (!bridge) return undefined;
    return bridge.onAiAgentEvent((envelope) => {
      setAgentTask((current) => reduceAgentTaskEvent(current, envelope));
    });
  }, [bridge]);

  /** 模型服务与工具清单：任务面板的两个前置数据源，与工作区无关，挂载期取一次。 */
  useEffect(() => {
    if (!bridge) return;
    void (async () => {
      try {
        const [services, toolList] = await Promise.all([
          bridge.listModelServices(),
          bridge.listAiTools()
        ]);
        setAgentServices(services.map((service) => ({
          id: service.id,
          displayName: service.displayName,
          hasCredential: service.hasCredential
        })));
        setAgentTools(toolList);
        // 默认选中第一个已配置凭据的服务：未配置凭据的服务会被主进程以
        // MODEL_SERVICE_UNCONFIGURED 拒绝（ipc.ts:2939），默认选它等于默认失败。
        setAgentServiceId((current) => current
          ?? services.find((service) => service.hasCredential)?.id
          ?? services[0]?.id
          ?? null);
      } catch (error) {
        setAgentSessionsError(error instanceof Error ? error.message : '读取模型服务或工具清单失败');
      }
    })();
  }, [bridge]);
  const visibleFiles = useMemo(
    () => filterFilesForMode(allFiles.length > 0 ? allFiles : files, resourceMode, query),
    [allFiles, files, resourceMode, query]
  );

  /**
   * 资源浏览器分页。
   *
   * 此前 `visibleFiles.map` 无分页无上限，只靠 `.file-list` 的 `overflow-y: auto`
   * 挡住视觉——DOM 仍然全量建出。规模不可控（实测整个只狼解包树 9111 个文件），
   * 属于硬约束 17 明确要求分页/虚拟化的场景。
   *
   * 页码必须随过滤条件复位，否则「停在第 30 页时改过滤词」会得到一个空页面，
   * 而空页面看起来与「没有匹配资源」完全一样——用户无法区分是真没有还是页码
   * 越界了。
   */
  const [filePage, setFilePage] = useState(0);
  const filePageCount = Math.max(1, Math.ceil(visibleFiles.length / FILE_LIST_PAGE_SIZE));
  const clampedFilePage = Math.min(filePage, filePageCount - 1);
  useEffect(() => {
    setFilePage(0);
  }, [resourceMode, query, allFiles, files]);
  const pagedFiles = useMemo(
    () => visibleFiles.slice(
      clampedFilePage * FILE_LIST_PAGE_SIZE,
      clampedFilePage * FILE_LIST_PAGE_SIZE + FILE_LIST_PAGE_SIZE
    ),
    [visibleFiles, clampedFilePage]
  );
  const searchHits = useMemo(() => visibleFiles.slice(0, SEARCH_HIT_LIMIT), [visibleFiles]);
  /**
   * 欢迎页「待审查变更」摘要条数。摘要不是队列本体——完整队列在暂存区面板，
   * 所以这里保留截断，但必须说清还有多少没显示（否则 5 条与 50 条长得一样，
   * 用户会以为只剩 5 个待审）。
   */
  const draftChanges = changeState.items.filter((item) => item.status === 'draft');
  const draftTruncationNote = formatListTruncation({
    total: draftChanges.length,
    shown: Math.min(draftChanges.length, WELCOME_DRAFT_LIMIT),
    noun: '项待审查变更',
    hint: '完整队列见暂存区面板'
  });
  const searchTruncationNote = formatListTruncation({
    total: visibleFiles.length,
    shown: searchHits.length,
    noun: '个资源',
    hint: '缩小关键字，或到资源浏览器分页浏览全部'
  });

  useEffect(() => {
    let cancelled = false;
    async function loadParam(): Promise<void> {
      if (resourceMode !== 'param') return;
      const target = selectedFile
        ?? visibleFiles.find((file) => file.resourceKind === 'param')
        ?? null;
      if (!bridge || !target || typeof bridge.readParamDocument !== 'function') {
        setParamRows(EMPTY_PARAM_ROWS);
        setParamTypeName('');
        setParamSourceHash(null);
        setParamLive(false);
        setParamRowPayloads(new Map());
        return;
      }
      setStatus(`正在读取 PARAM：${target.relativePath}`);
      try {
        const result = await bridge.readParamDocument(target.sourceUri) as {
          ok?: boolean;
          data?: {
            sourceHash?: string;
            typeName?: string;
            rows?: Array<{
              id: number;
              dataBase64?: string;
              dataHexPreview?: string;
              name?: string;
            }>;
            rowCount?: number;
            rowDataSize?: number;
            authority?: string;
          } | null;
        };
        if (cancelled) return;
        if (!result?.ok || !result.data?.rows?.length) {
          setParamRows(EMPTY_PARAM_ROWS);
          setParamLive(false);
          setParamSourceHash(null);
          setParamRowPayloads(new Map());
          setStatus('PARAM 实时读取失败：显示空列表，未加载任何演示数据。');
          return;
        }
        const payloads = new Map<number, string>();
        setParamRows(result.data.rows.map((r) => {
          if (r.dataBase64) payloads.set(r.id, r.dataBase64);
          return {
            id: r.id,
            dataHexPreview: r.dataHexPreview ?? '',
            ...(r.name ? { name: r.name } : {})
          };
        }));
        setParamRowPayloads(payloads);
        setParamTypeName(result.data.typeName ?? target.relativePath);
        setParamSourceHash(result.data.sourceHash ?? null);
        if (result.data.rowDataSize !== undefined) setParamRowDataSize(result.data.rowDataSize);
        setParamLive(true);
        setStatus(
          `已加载 PARAM：${result.data.rowCount ?? result.data.rows.length} 行`
          + (result.data.authority ? ` · ${result.data.authority}` : '')
        );
      } catch (error) {
        if (cancelled) return;
        setParamLive(false);
        setStatus(error instanceof Error ? error.message : 'PARAM 读取异常');
      }
    }
    void loadParam();
    return () => {
      cancelled = true;
    };
  }, [bridge, resourceMode, selectedFile, visibleFiles]);

  useEffect(() => {
    let cancelled = false;
    async function loadFmg(): Promise<void> {
      if (resourceMode !== 'msg') return;
      const target = selectedFile
        ?? visibleFiles.find((file) => file.resourceKind === 'msg')
        ?? null;
      if (!bridge || !target || typeof bridge.readFmgDocument !== 'function') {
        setFmgEntries(EMPTY_FMG_ENTRIES);
        setFmgSourceHash(null);
        setFmgLive(false);
        return;
      }
      setStatus(`正在读取 FMG：${target.relativePath}`);
      try {
        const result = await bridge.readFmgDocument(target.sourceUri) as {
          ok?: boolean;
          data?: {
            sourceHash?: string;
            entries?: Array<{ id: number; text: string }>;
            entryCount?: number;
            authority?: string;
          } | null;
        };
        if (cancelled) return;
        if (!result?.ok || !result.data?.entries?.length) {
          setFmgEntries(EMPTY_FMG_ENTRIES);
          setFmgSourceHash(null);
          setFmgLive(false);
          setStatus('FMG 实时读取失败：显示空列表，未加载任何演示数据。');
          return;
        }
        setFmgEntries(result.data.entries.map((e) => ({ id: e.id, text: e.text })));
        setFmgSourceHash(result.data.sourceHash ?? null);
        setFmgLive(true);
        setStatus(
          `已加载 FMG：${result.data.entryCount ?? result.data.entries.length} 条`
          + (result.data.authority ? ` · authority=${result.data.authority}` : '')
        );
      } catch (error) {
        if (cancelled) return;
        setFmgLive(false);
        setStatus(error instanceof Error ? error.message : 'FMG 读取异常');
      }
    }
    void loadFmg();
    return () => {
      cancelled = true;
    };
  }, [bridge, resourceMode, selectedFile, visibleFiles]);

  useEffect(() => {
    let cancelled = false;
    async function loadMsb(): Promise<void> {
      if (resourceMode !== 'map') return;
      const target = selectedFile
        ?? visibleFiles.find((file) => file.resourceKind === 'map')
        ?? null;
      if (!bridge || !target || typeof bridge.readMsbDocument !== 'function') {
        setMsbParts(EMPTY_MSB_PARTS);
        setMsbModels([]);
        setMsbRegions([]);
        setMsbEvents([]);
        setMsbSourceCounts({ models: 0, parts: EMPTY_MSB_PARTS.length, regions: 0, events: 0 });
        setMsbLive(false);
        return;
      }
      setStatus(`正在读取 MSB：${target.relativePath}`);
      try {
        const result = await bridge.readMsbDocument(target.sourceUri) as {
          ok?: boolean;
          data?: {
            sourceHash?: string;
            models?: Array<{ name: string; nativeOffset?: number; typeId: number }>;
            parts?: Array<{
              name: string;
              nativeOffset?: number;
              posX: number;
              posY: number;
              posZ: number;
              rotX?: number;
              scaleX?: number;
              scaleY?: number;
              scaleZ?: number;
            }>;
            regions?: Array<{
              name: string;
              nativeOffset?: number;
              typeId: number;
              posX: number;
              posY: number;
              posZ: number;
            }>;
            events?: Array<{ name: string; nativeOffset?: number; typeId: number }>;
            modelCount?: number;
            partCount?: number;
            regionCount?: number;
            eventCount?: number;
            authority?: string;
          } | null;
        };
        if (cancelled) return;
        if (!result?.ok || !result.data?.parts?.length) {
          setMsbParts(EMPTY_MSB_PARTS);
          setMsbModels([]);
          setMsbRegions([]);
          setMsbEvents([]);
          setMsbSourceCounts({ models: 0, parts: EMPTY_MSB_PARTS.length, regions: 0, events: 0 });
          setMsbLive(false);
          setStatus('MSB 实时读取失败：显示空场景，未加载任何演示数据。');
          return;
        }
        setMsbParts(result.data.parts.map((p) => ({
          name: p.name,
          ...(p.nativeOffset === undefined ? {} : { nativeOffset: p.nativeOffset }),
          posX: p.posX,
          posY: p.posY,
          posZ: p.posZ,
          rotX: p.rotX ?? 0,
          scaleX: p.scaleX ?? 1,
          scaleY: p.scaleY ?? 1,
          scaleZ: p.scaleZ ?? 1
        })));
        setMsbModels((result.data.models ?? []).map((model) => ({
          name: model.name,
          ...(model.nativeOffset === undefined ? {} : { nativeOffset: model.nativeOffset }),
          typeId: model.typeId
        })));
        setMsbRegions((result.data.regions ?? []).map((r) => ({
          name: r.name,
          ...(r.nativeOffset === undefined ? {} : { nativeOffset: r.nativeOffset }),
          typeId: r.typeId,
          posX: r.posX,
          posY: r.posY,
          posZ: r.posZ
        })));
        setMsbEvents((result.data.events ?? []).map((event) => ({
          name: event.name,
          ...(event.nativeOffset === undefined ? {} : { nativeOffset: event.nativeOffset }),
          typeId: event.typeId
        })));
        setMsbSourceCounts({
          models: result.data.modelCount ?? result.data.models?.length ?? 0,
          parts: result.data.partCount ?? result.data.parts.length,
          regions: result.data.regionCount ?? result.data.regions?.length ?? 0,
          events: result.data.eventCount ?? result.data.events?.length ?? 0
        });
        setMsbSourceHash(result.data.sourceHash ?? null);
        setMsbLive(true);
        setStatus(
          `已加载 MSB：${result.data.partCount ?? result.data.parts.length} parts`
          + (result.data.regionCount !== undefined ? ` / ${result.data.regionCount} regions` : '')
          + (result.data.authority ? ` · ${result.data.authority}` : '')
        );
      } catch (error) {
        if (cancelled) return;
        setMsbModels([]);
        setMsbEvents([]);
        setMsbLive(false);
        setStatus(error instanceof Error ? error.message : 'MSB 读取异常');
      }
    }
    void loadMsb();
    return () => {
      cancelled = true;
    };
  }, [bridge, resourceMode, selectedFile, visibleFiles]);

  useEffect(() => {
    let cancelled = false;
    async function loadEmevd(): Promise<void> {
      if (resourceMode !== 'event') return;
      const target = selectedFile
        ?? visibleFiles.find((file) => file.resourceKind === 'event')
        ?? null;
      if (!bridge || !target || typeof bridge.readEmevdDocument !== 'function') {
        setEmevdDocument(EMPTY_EMEVD_DOCUMENT);
        setEmevdSourceHash(null);
        setEmevdLive(false);
        return;
      }
      setStatus(`正在读取 EMEVD：${target.relativePath}`);
      try {
        const result = await bridge.readEmevdDocument(target.sourceUri) as {
          ok?: boolean;
          data?: BridgeEmevdEnvelopeLike | null;
          diagnostics?: Array<{ message?: string }>;
        };
        if (cancelled) return;
        if (!result?.ok || !result.data) {
          setEmevdDocument({
            ...EMPTY_EMEVD_DOCUMENT,
            resourceUri: target.sourceUri,
            diagnostics: [{
              severity: 'warning',
              code: 'EMEVD_LIVE_READ_FAILED',
              message: result?.diagnostics?.[0]?.message
                ?? '未能从 Bridge 读取 EMEVD；显示空文档。'
            }]
          });
          setEmevdSourceHash(null);
          setEmevdLive(false);
          setStatus('EMEVD 实时读取失败：显示空文档，未加载任何演示数据。');
          return;
        }
        const doc = mapEmevdEnvelopeToDocument(target.sourceUri, result.data, { maxEvents: 128 });
        setEmevdDocument(doc);
        setEmevdSourceHash(result.data.sourceHash ?? null);
        setEmevdLive(true);
        setStatus(
          `已加载 EMEVD：${result.data.eventCount ?? doc.events.length} 事件 / `
          + `${result.data.instructionCount ?? 0} 指令（authority=${result.data.authority ?? 'unknown'}）`
        );
        // Load the authoritative full-document DSL template in the background;
        // renderer never receives the full document itself.
        if (typeof bridge.readEmevdFullDocument === 'function') {
          const full = await bridge.readEmevdFullDocument(
            target.sourceUri,
            `renderer-${target.sourceUri}-${Date.now()}`
          );
          if (cancelled) return;
          if (full?.ok && full.dslTemplate) {
            setEmevdDslTemplate(full.dslTemplate);
            setEmevdDslTemplateTruncated(full.dslTemplateTruncated ?? false);
            setEmevdDslTemplateTotalLines(full.dslTemplateTotalLines ?? 0);
          } else {
            setEmevdDslTemplate(null);
            setEmevdDslTemplateTruncated(false);
            setEmevdDslTemplateTotalLines(0);
            setStatus(full?.diagnostics?.[0]?.message ?? '完整文档 DSL 模板加载失败；DSL 视图保持只读。');
          }
        }
      } catch (error) {
        if (cancelled) return;
        setEmevdLive(false);
        setEmevdSourceHash(null);
        setStatus(error instanceof Error ? error.message : 'EMEVD 读取异常');
      }
    }
    void loadEmevd();
    return () => {
      cancelled = true;
    };
  }, [bridge, resourceMode, selectedFile, visibleFiles]);

  async function refreshOperationHistory(): Promise<void> {
    if (!bridge) return;
    const history = await bridge.listOperations();
    setOperationHistory(history);
  }

  async function reloadParamRowsFromSource(): Promise<void> {
    if (!bridge || !selectedFile) return;
    const reload = await bridge.readParamDocument(selectedFile.sourceUri) as {
      ok?: boolean;
      data?: {
        sourceHash?: string;
        typeName?: string;
        rows?: Array<{
          id: number;
          dataBase64?: string;
          dataHexPreview?: string;
          name?: string;
        }>;
        rowDataSize?: number;
      } | null;
    };
    if (reload?.ok && reload.data?.rows) {
      const payloads = new Map<number, string>();
      setParamRows(reload.data.rows.map((r) => {
        if (r.dataBase64) payloads.set(r.id, r.dataBase64);
        return {
          id: r.id,
          dataHexPreview: r.dataHexPreview ?? '',
          ...(r.name ? { name: r.name } : {})
        };
      }));
      setParamRowPayloads(payloads);
      setParamSourceHash(reload.data.sourceHash ?? null);
      if (reload.data.typeName) setParamTypeName(reload.data.typeName);
      if (reload.data.rowDataSize !== undefined) setParamRowDataSize(reload.data.rowDataSize);
    }
  }

  async function applyParamFieldMutationFromPanel(input: {
    rowId: number;
    fieldId: string;
    value: number | string | boolean;
    rowDataBase64: string;
    definition: unknown;
  }): Promise<{ ok: boolean; diagnostics?: Array<{ code: string; message: string }> }> {
    if (!paramSourceHash || !selectedFile) {
      return {
        ok: false,
        diagnostics: [{ code: 'PARAM_FIELD_NO_LIVE_DOCUMENT', message: '需要实时 PARAM 文档才能提交字段。' }]
      };
    }
    if (!bridge) {
      return {
        ok: false,
        diagnostics: [{ code: 'BRIDGE_UNAVAILABLE', message: describeBridgeAbsence('提交 PARAM 字段') }]
      };
    }
    if (typeof bridge.applyParamFieldMutation !== 'function') {
      return {
        ok: false,
        diagnostics: [{ code: 'PRELOAD_MISSING', message: '当前预加载未暴露 applyParamFieldMutation。' }]
      };
    }
    setStatus('正在经 Bridge/补丁引擎提交 PARAM 字段…');
    const result = await bridge.applyParamFieldMutation(
      selectedFile.sourceUri,
      paramSourceHash,
      {
        rowId: input.rowId,
        fieldId: input.fieldId,
        value: input.value,
        rowDataBase64: input.rowDataBase64,
        definition: input.definition
      }
    );
    if (result.ok) {
      await reloadParamRowsFromSource();
      await refreshOperationHistory();
      setStatus(`PARAM 字段 ${input.fieldId} 已提交并重读。`);
      return { ok: true, diagnostics: result.diagnostics ?? [] };
    }
    return {
      ok: false,
      diagnostics: (result.diagnostics ?? []).map((diagnostic: Diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message
      }))
    };
  }

  /**
   * MSB 写路径当前为延期只读预览（V0.6 治理承接后开闸），函数保留接线。
   * 实际是否放行以 IPC 返回为准：主进程在 deferredPreview 门禁下 fail-closed。
   */
  async function applyMsbNativeMutationAndReload(
    mutation: MsbNativeMutation,
    label: string
  ): Promise<void> {
    if (!msbLive || !msbSourceHash || !selectedFile) {
      setStatus('MSB 写入仅在实时模式可用。');
      return;
    }
    if (!bridge) {
      setStatus(describeBridgeAbsence(`提交 MSB ${label}`));
      return;
    }
    if (typeof bridge.applyMsbMutation !== 'function') {
      setStatus('当前预加载未暴露 applyMsbMutation。');
      return;
    }
    setStatus(`正在提交 MSB ${label}…`);
    const result = await bridge.applyMsbMutation(
      selectedFile.sourceUri,
      msbSourceHash,
      mutation
    );
    if (!result.ok) {
      setStatus(result.diagnostics?.[0]?.message ?? `MSB ${label} 提交失败`);
      return;
    }
    const reload = await bridge.readMsbDocument(selectedFile.sourceUri) as {
      ok?: boolean;
      data?: {
        sourceHash?: string;
        parts?: Array<{
          name: string;
          nativeOffset?: number;
          posX: number;
          posY: number;
          posZ: number;
          rotX?: number;
          scaleX?: number;
          scaleY?: number;
          scaleZ?: number;
        }>;
        regions?: Array<{
          name: string;
          nativeOffset?: number;
          typeId: number;
          posX: number;
          posY: number;
          posZ: number;
        }>;
        models?: Array<{ name: string; nativeOffset?: number; typeId: number }>;
        events?: Array<{ name: string; nativeOffset?: number; typeId: number }>;
        modelCount?: number;
        partCount?: number;
        regionCount?: number;
        eventCount?: number;
      } | null;
    };
    if (reload?.ok && reload.data?.parts?.length) {
      setMsbParts(reload.data.parts.map((p) => ({
        name: p.name,
        ...(p.nativeOffset === undefined ? {} : { nativeOffset: p.nativeOffset }),
        posX: p.posX,
        posY: p.posY,
        posZ: p.posZ,
        rotX: p.rotX ?? 0,
        scaleX: p.scaleX ?? 1,
        scaleY: p.scaleY ?? 1,
        scaleZ: p.scaleZ ?? 1
      })));
      setMsbRegions((reload.data.regions ?? []).map((r) => ({
        name: r.name,
        ...(r.nativeOffset === undefined ? {} : { nativeOffset: r.nativeOffset }),
        typeId: r.typeId,
        posX: r.posX,
        posY: r.posY,
        posZ: r.posZ
      })));
      setMsbModels((reload.data.models ?? []).map((model) => ({
        name: model.name,
        ...(model.nativeOffset === undefined ? {} : { nativeOffset: model.nativeOffset }),
        typeId: model.typeId
      })));
      setMsbEvents((reload.data.events ?? []).map((event) => ({
        name: event.name,
        ...(event.nativeOffset === undefined ? {} : { nativeOffset: event.nativeOffset }),
        typeId: event.typeId
      })));
      setMsbSourceCounts({
        models: reload.data.modelCount ?? reload.data.models?.length ?? 0,
        parts: reload.data.partCount ?? reload.data.parts.length,
        regions: reload.data.regionCount ?? reload.data.regions?.length ?? 0,
        events: reload.data.eventCount ?? reload.data.events?.length ?? 0
      });
      setMsbSourceHash(reload.data.sourceHash ?? null);
      setStatus(`MSB ${label} 已提交并重读。`);
    } else {
      setStatus('MSB 已提交，但重读失败。');
    }
    await refreshOperationHistory();
  }

  async function commitMsbPosition(
    input: MsbPositionCommitInput,
    kind: 'set_part_position' | 'set_region_position'
  ): Promise<void> {
    const label = kind === 'set_region_position' ? 'region' : 'part';
    await applyMsbNativeMutationAndReload(
      {
        kind,
        partName: input.partName,
        posX: input.posX,
        posY: input.posY,
        posZ: input.posZ
      },
      `${label} 位置`
    );
  }

  async function commitMsbTransform(input: MsbTransformCommitInput): Promise<void> {
    await applyMsbNativeMutationAndReload(
      {
        kind: 'set_part_transform',
        partName: input.partName,
        posX: input.posX,
        posY: input.posY,
        posZ: input.posZ,
        rotX: input.rotX,
        rotY: input.rotY,
        rotZ: input.rotZ,
        scaleX: input.scaleX,
        scaleY: input.scaleY,
        scaleZ: input.scaleZ
      },
      `transform ${input.partName}`
    );
  }

  /** Electron-only 操作在 browser-preview 表面的统一可见降级：不抛异常、不静默。 */
  function announceDesktopOnly(operation: string): void {
    const message = describeBridgeAbsence(operation);
    setStatus(message);
    pushToast(message, 'warn');
  }

  async function chooseBaseDirectory(): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('选择原版目录');
      return;
    }
    try {
      const selection = await bridge.openBaseDialog();
      if (!selection) return;
      setBaseRootChoice(selection);
      setStatus(`已选择只读原版游戏目录：${selection.label}（下次打开 Mod 工作区时生效）`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`选择原版目录失败：${message}`);
      pushToast(`选择原版目录失败：${message}`, 'warn');
    }
  }

  function clearBaseDirectory(): void {
    setBaseRootChoice(null);
    setStatus('已清除原版游戏目录选择');
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
    setSidebarView('search');
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function activateSidebarView(view: SidebarView): void {
    if (view === sidebarView && !sidebarCollapsed) {
      setSidebarCollapsed(true);
      return;
    }
    setSidebarCollapsed(false);
    setSidebarView(view);
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handleMove = (moveEvent: PointerEvent): void => {
      setSidebarWidth(Math.min(480, Math.max(180, startWidth + moveEvent.clientX - startX)));
    };
    const handleUp = (): void => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  function pushToast(text: string, kind: 'ok' | 'warn' = 'ok'): void {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((list) => [...list, { id, text, kind }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((toast) => toast.id !== id));
    }, 4200);
  }

  async function sendAgentPrompt(): Promise<void> {
    const text = aiPrompt.trim();
    if (!text || aiBusy) return;
    setAgentGoal(text);
    setAiBusy(true);
    try {
      await buildAiDraft();
    } finally {
      setAiBusy(false);
    }
  }

  function closeTab(file: RendererIndexedFile): void {
    const next = openTabs.filter((tab) => tab.sourceUri !== file.sourceUri);
    setOpenTabs(next);
    if (selectedFile?.sourceUri === file.sourceUri) {
      const fallback = next.length > 0 ? next[next.length - 1] : null;
      if (fallback) {
        void selectFile(fallback);
      } else {
        setSelectedFile(null);
        setPreview(null);
      }
    }
  }

  async function openWorkspace(): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('打开 Mod 工作区');
      return;
    }
    try {
      const workspaceSelection = await bridge.openWorkspaceDialog();
      // 用户取消目录对话框：安静返回，不显示错误。
      if (!workspaceSelection) return;

      setStatus('正在扫描工作区...');
      const result = await bridge.scanWorkspace({
        overlaySelectionId: workspaceSelection.selectionId,
        ...(baseRootChoice ? { baseSelectionId: baseRootChoice.selectionId } : {})
      });
      setWorkspace(result);
      setSessionMeta(result.session ?? null);
      setAllFiles(result.files);
      setFiles(result.files);
      setResourceMode('all');
      setCenterView('resource');
      setSidebarView('explorer');
      setSelectedFile(null);
      setPreview(null);
      setOpenTabs([]);
      setAgentGoal(null);
      setEditText('');
      setLastSavedText('');
      setMsgRows([]);
      setSaveDiagnostics([]);
      setAnalysis(null);
      setToolOutput(null);
      setAiDraft(null);
      setOperationHistory([]);
      setBnd4Forced(false);
      // 换工作区必须清空全部资源族编辑态：否则新工作区的面板会继续显示上一个
      // 工作区的 FMG 条目 / PARAM 行 / EMEVD 事件 / MSB 场景。
      resetAllDocuments(documentResetActions);

      setStatus('正在构建轻量证据索引...');
      const nextAnalysis = await bridge.analyzeWorkspace();
      setAnalysis(nextAnalysis);
      setTools(nextAnalysis?.tools ?? []);
      setEventUri(nextAnalysis?.events?.[0]?.uri ?? '');
      await refreshOperationHistory();
      const baseLabel = result.session.baseMounted
        ? ' · 已挂载只读原版游戏目录'
        : ' · 未挂载原版游戏目录';
      setBaseRootChoice(null);
      setStatus(`已索引并可打开 ${result.files.length} 个文件，解析 ${nextAnalysis?.parsedFiles ?? 0} 个文本/mock 资源${baseLabel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`打开工作区失败：${message}`);
      pushToast(`打开工作区失败：${message}`, 'warn');
    }
  }

  async function search(): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('资源搜索');
      return;
    }
    const result = await bridge.searchResources(query);
    setAllFiles(result);
    setFiles(result);
    setStatus(`搜索返回 ${result.length} 个文件`);
  }

  function selectResourceMode(mode: ResourceMode): void {
    if (mode !== resourceMode && editDirty) {
      const confirmed = window.confirm('当前文本有未生成变更的修改，切换目录将保留草稿但可能离开编辑视图。继续？');
      if (!confirmed) return;
    }
    setResourceMode(mode);
    setCenterView('resource');
    const filtered = filterFilesForMode(allFiles, mode, query);
    setStatus(mode === 'all'
      ? `全部资源：${filtered.length} 个文件`
      : `${mode}：${filtered.length} 个资源`);
  }

  function openOperationsView(): void {
    setCenterView('operations');
    setStatus('任务与历史：写入、回滚与诊断记录');
  }

  function openBnd4ForSelection(): void {
    if (!selectedFile) {
      setStatus('先选择一个容器资源，再以 BND4 容器打开。');
      return;
    }
    setBnd4Forced(true);
    setCenterView('resource');
    setStatus(`以 BND4 容器打开：${selectedFile.relativePath}`);
  }

  async function selectFile(file: RendererIndexedFile): Promise<void> {
    setSelectedFile(file);
    setOpenTabs((tabs) =>
      tabs.some((tab) => tab.sourceUri === file.sourceUri) ? tabs : [...tabs, file]
    );
    setPreview(null);
    setEditText('');
    setLastSavedText('');
    setMsgRows([]);
    setSaveDiagnostics([]);
    setAiDraft(null);
    // 换选中文件同样要清空全部资源族：此前这里只清了 TAE/ESD/FLVER/TPF，
    // FMG/PARAM/EMEVD/MSB 会残留到下一个文件的面板上。
    resetAllDocuments(documentResetActions);
    setBnd4Forced(false);
    setCenterView('resource');
    if (!bridge) {
      setStatus(describeBridgeAbsence(`打开 ${file.relativePath}`));
      return;
    }
    setStatus(`正在打开 ${file.relativePath}...`);
    const nextPreview = await bridge.openResourcePreview(file.sourceUri);
    setPreview(nextPreview);
    const text = nextPreview?.text ?? '';
    setEditText(text);
    setLastSavedText(text);
    setMsgRows(extractMsgRows(nextPreview));
    // Load TAE/ESD/FLVER/TPF document data via typed preload IPC (V0.6 只读预览族)。
    if (file.relativePath.endsWith('.tae')) {
      const result = await bridge.readTaeDocument(file.sourceUri) as { ok: boolean; data?: Record<string, unknown> };
      if (result.ok && result.data) setTaeData(result.data);
    }
    if (file.relativePath.endsWith('.esd')) {
      const result = await bridge.readEsdDocument(file.sourceUri) as { ok: boolean; data?: Record<string, unknown> };
      if (result.ok && result.data) setEsdData(result.data);
    }
    if (file.relativePath.endsWith('.flver')) {
      const result = await bridge.readFlverDocument(file.sourceUri) as { ok: boolean; data?: Record<string, unknown> };
      if (result.ok && result.data) setFlverData(result.data);
    }
    if (file.relativePath.endsWith('.tpf')) {
      const result = await bridge.readTpfDocument(file.sourceUri) as { ok: boolean; data?: Record<string, unknown> };
      if (result.ok && result.data) setTpfData(result.data);
    }
    setStatus(nextPreview ? `已打开 ${file.relativePath}` : '无法预览该资源');
  }

  /** 文本编辑「保存」= 生成候选变更，进入审查队列；实际写入由变更队列提交执行。 */
  function saveCurrentText(): void {
    if (!selectedFile || !preview) return;
    changeStore.propose({
      kind: 'text',
      sourceUri: selectedFile.sourceUri,
      target: selectedFile.relativePath,
      summary: `全文更新（${editText.length} 字符）`,
      oldValue: lastSavedText.length > 40 ? `${lastSavedText.slice(0, 40)}…` : lastSavedText,
      newValue: editText,
      payload: {}
    });
    setStatus('变更已进入审查队列：批准后暂存，写入时自动备份。');
  }

  /** 变更队列写入执行器：按 kind 调用对应 IPC，保留 hash 前置条件与重读。 */
  async function applyStagedChange(
    change: CandidateChange
  ): Promise<{ ok: boolean; diagnostics?: ChangeDiagnostic[] }> {
    const mapDiag = (list?: Diagnostic[]): ChangeDiagnostic[] =>
      (list ?? []).map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message }));
    if (!bridge) {
      return {
        ok: false,
        diagnostics: [{ code: 'BRIDGE_UNAVAILABLE', message: describeBridgeAbsence('写入暂存变更') }]
      };
    }
    switch (change.kind) {
      case 'text': {
        const result = await bridge.saveTextResource(change.sourceUri, change.newValue);
        if (result.ok) {
          const refreshed = await bridge.openResourcePreview(change.sourceUri);
          setPreview(refreshed);
          const text = refreshed?.text ?? change.newValue;
          setEditText(text);
          setLastSavedText(text);
          setMsgRows(extractMsgRows(refreshed));
        }
        return { ok: result.ok, diagnostics: mapDiag(result.diagnostics) };
      }
      case 'fmg': {
        if (!fmgSourceHash) {
          return { ok: false, diagnostics: [{ code: 'FMG_NO_LIVE_HASH', message: 'FMG 实时 hash 缺失，拒绝写入。' }] };
        }
        const payload = change.payload as { op: 'upsert' | 'add' | 'delete'; id: number; text?: string };
        const result = await bridge.applyFmgMutation(change.sourceUri, fmgSourceHash, {
          kind: payload.op,
          id: payload.id,
          ...(payload.text !== undefined ? { text: payload.text } : {})
        });
        if (result.ok) {
          const reload = await bridge.readFmgDocument(change.sourceUri) as {
            ok?: boolean;
            data?: { sourceHash?: string; entries?: Array<{ id: number; text: string }> } | null;
          };
          if (reload?.ok && reload.data?.entries) {
            setFmgEntries(reload.data.entries.map((entry) => ({ id: entry.id, text: entry.text })));
            setFmgSourceHash(reload.data.sourceHash ?? null);
          }
        }
        return { ok: result.ok, diagnostics: mapDiag(result.diagnostics) };
      }
      case 'param-row': {
        if (!paramSourceHash) {
          return { ok: false, diagnostics: [{ code: 'PARAM_NO_LIVE_HASH', message: 'PARAM 实时 hash 缺失，拒绝写入。' }] };
        }
        const payload = change.payload as { op: 'upsert' | 'delete'; id: number; dataBase64?: string };
        const result = await bridge.applyParamMutation(
          change.sourceUri,
          paramSourceHash,
          payload.op === 'delete'
            ? { kind: 'delete', id: payload.id }
            : { kind: 'upsert', id: payload.id, dataBase64: payload.dataBase64 ?? '' }
        );
        if (result.ok) await reloadParamRowsFromSource();
        return { ok: result.ok, diagnostics: mapDiag(result.diagnostics) };
      }
      case 'param-field': {
        const input = change.payload as {
          rowId: number;
          fieldId: string;
          value: number | string | boolean;
          rowDataBase64: string;
          definition: unknown;
        };
        return applyParamFieldMutationFromPanel(input);
      }
    }
  }

  async function commitStagedChanges(): Promise<void> {
    setStatus('正在校验并写入已暂存变更…');
    const result = await changeStore.commitAll(applyStagedChange);
    await refreshOperationHistory();
    setStatus(
      result.failed === 0
        ? `写入完成：${result.written} 项已写入，原文件已备份，可回滚。`
        : `写入结束：${result.written} 项已写入，${result.failed} 项失败（原因见诊断）。`
    );
    pushToast(
      result.failed === 0
        ? `写入完成：${result.written} 项已写入，原文件已备份，可回滚`
        : `写入结束：${result.failed} 项失败（原因见诊断）`,
      result.failed === 0 ? 'ok' : 'warn'
    );
  }

  async function rollbackOp(opId: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('回滚操作');
      return;
    }
    setStatus(`正在回滚操作 ${opId.slice(0, 8)}...`);
    const result = await bridge.rollbackOperation(opId);
    await refreshOperationHistory();
    if (!result.ok) {
      setStatus(`回滚失败：${result.diagnostics.map((d: Diagnostic) => d.message).join('; ') || opId}`);
      return;
    }
    if (selectedFile) {
      const refreshed = await bridge.openResourcePreview(selectedFile.sourceUri);
      setPreview(refreshed);
      const text = refreshed?.text ?? '';
      setEditText(text);
      setLastSavedText(text);
      setMsgRows(extractMsgRows(refreshed));
    }
    setStatus(`已回滚 ${result.restoredFiles.length} 个文件`);
  }

  function updateMsgRow(index: number, patch: Partial<EditableMsgRow>): void {
    const nextRows = msgRows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row);
    setMsgRows(nextRows);
    setEditText(serializeMsgRowsToTsv(nextRows));
  }

  function addMsgRow(): void {
    const nextRows = [...msgRows, { textId: nextMsgId(msgRows), text: '', ...(msgRows[0]?.category ? { category: msgRows[0].category } : {}) }];
    setMsgRows(nextRows);
    setEditText(serializeMsgRowsToTsv(nextRows));
  }

  function removeMsgRow(index: number): void {
    const nextRows = msgRows.filter((_row, rowIndex) => rowIndex !== index);
    setMsgRows(nextRows);
    setEditText(serializeMsgRowsToTsv(nextRows));
  }

  async function buildAiDraft(): Promise<void> {
    const request: AiSidebarDraftRequest = {
      settings: {
        provider: aiProvider,
        thinking: aiThinking,
        mode: aiMode
      },
      userPrompt: aiPrompt,
      context: {
        ...(workspace?.workspaceSessionId ? { workspaceSessionId: workspace.workspaceSessionId } : {}),
        ...(selectedFile
          ? {
              selectedResource: {
                sourceUri: selectedFile.sourceUri,
                relativePath: selectedFile.relativePath,
                resourceKind: selectedFile.resourceKind
              }
            }
          : {}),
        ...(preview?.previewKind ? { previewKind: preview.previewKind } : {}),
        diagnosticsCount: diagnostics.length,
        ...(analysis?.referenceStats ? { referenceStats: analysis.referenceStats } : {}),
        ...(eventUri ? { currentEventUri: eventUri } : {})
      },
      availableTools: tools
    };

    if (!bridge) {
      setStatus(describeBridgeAbsence('生成计划草稿'));
      return;
    }
    setStatus('正在生成 AI 计划草稿...');
    const draft = await bridge.buildAiSidebarDraft(request);
    setAiDraft(draft);
    setStatus(draft.status === 'ready' ? 'AI 计划草稿已生成' : 'AI 模型服务尚未配置，已生成本地计划草稿');
  }

  /* ── AI agent 任务：运行 / 取消 / 会话历史 ───────────────────────────────
     六个通道的 renderer 侧唯一调用点。权限模式**不由这里传**：ai.agent.run 的
     request.mode 省略时主进程落到 'plan'（ipc.ts:2967 的三元），传 'fullPermission'
     会真的抬高工具上限。renderer 抬高授权是红线，故这里刻意不带 mode 字段。 */

  async function refreshAgentSessions(): Promise<void> {
    if (!bridge) {
      setAgentSessionsError(describeBridgeAbsence('读取 AI 会话历史'));
      return;
    }
    const result = await bridge.listAiAgentSessions();
    if (!result.ok) {
      setAgentSessionsError(`${result.error.code}：${result.error.message}`);
      return;
    }
    setAgentSessionsError(null);
    setAgentSessions(result.sessions);
    setAgentSessionsPage(0);
  }

  /**
   * 发起任务。resumeSessionPath 有值时承接既有会话。
   *
   * 失败分支必须落到可见状态：主进程对未分析工作区、缺配置、缺凭据分别返回
   * WORKSPACE_NOT_ANALYZED / MODEL_SERVICE_CONFIG_NOT_FOUND /
   * MODEL_SERVICE_UNCONFIGURED（ipc.ts:2923-2951），吞掉它们会让用户看到
   * 「点了没反应」。
   */
  async function runAgentTask(resumeSessionPath?: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('运行 AI 任务');
      return;
    }
    if (agentServiceId === null) {
      setStatus('尚未选择模型服务，未发起 AI 任务');
      return;
    }
    const prompt = aiPrompt.trim();
    if (prompt === '') {
      setStatus('任务描述为空，未发起 AI 任务');
      return;
    }
    setAgentTask(INITIAL_AGENT_TASK_STATE);
    setStatus('正在发起 AI 任务...');
    const result = await bridge.runAiAgent({
      configId: agentServiceId,
      prompt,
      ...(resumeSessionPath !== undefined ? { resumeSessionPath } : {})
    });
    if (!result.ok) {
      setAgentTask({
        ...INITIAL_AGENT_TASK_STATE,
        phase: 'error',
        error: { code: result.error.code, message: result.error.message }
      });
      setStatus(`AI 任务未发起：${result.error.code}`);
      pushToast(`AI 任务未发起：${result.error.message}`, 'warn');
      return;
    }
    setAgentGoal(prompt);
    setAgentTask(startAgentTask(result.sessionId));
    setStatus('AI 任务已发起，进度会在 Agent 面板更新');
  }

  /**
   * 取消当前任务。
   *
   * 必须真的发出 IPC：主进程持有 AbortController（ipc.ts:2988 的 activeAgentRuns），
   * cancel 通道 abort 它（ipc.ts:3027-3031）。只改本地状态不发 IPC 的「取消」会让
   * 任务继续跑到底，而界面显示已取消——那比没有取消按钮更糟。
   *
   * 本地只落到 cancelling，终态仍等主进程的 session-done/session-error。
   */
  async function cancelAgentTask(): Promise<void> {
    const sessionId = agentTask.sessionId;
    if (!bridge || sessionId === null) {
      announceDesktopOnly('取消 AI 任务');
      return;
    }
    setAgentTask((current) => markAgentTaskCancelling(current));
    setStatus('已发出取消请求，等待当前步骤让出');
    await bridge.cancelAiAgent(sessionId);
  }

  async function loadAgentSession(sessionPath: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('查看 AI 会话');
      return;
    }
    const result = await bridge.loadAiAgentSession(sessionPath);
    if (!result.ok) {
      setAgentSessionsError(`${result.error.code}：${result.error.message}`);
      setAgentSessionDetail(null);
      return;
    }
    setAgentSessionsError(null);
    setAgentSessionDetail({
      sessionPath,
      messageCount: result.messageCount,
      parseErrors: result.parseErrors,
      interrupted: result.interrupted,
      compactedWindows: result.compactedWindows,
      loadedMessages: result.messagesPage.length,
      permissionMode: result.meta?.permissionMode ?? null,
      protocol: result.meta?.protocol ?? null
    });
    setStatus(`已载入会话 ${sessionPath}，共 ${result.messageCount} 条消息`);
  }

  async function runToolSearch(toolQuery: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('运行安全工具');
      return;
    }
    const result = await bridge.runAiTool('search_resources', { query: toolQuery, limit: 8 });
    setToolOutput(result);
  }

  async function explainEvent(uri: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('解释事件');
      return;
    }
    const result = await bridge.runAiTool('explain_event', { uri });
    setToolOutput(result);
  }
  // 命令面板与顶部资源栏共用 RESOURCE_FAMILIES 配置源，不维护第二套标签和顺序。
  const cmdkCommands: Array<{ id: string; icon: string; label: string; hint?: string; run: () => void }> = [
    ...RESOURCE_FAMILIES.map((family) => ({
      id: `resource-${family.id}`,
      icon: '◧',
      label: family.id === 'all' ? '显示全部资源' : `切换到 ${family.label} 目录`,
      ...(family.id !== 'all' && counts ? { hint: String(counts[family.id] ?? 0) } : {}),
      run: (): void => {
        setSidebarCollapsed(false);
        setSidebarView('explorer');
        selectResourceMode(family.id);
      }
    })),
    { id: 'open-bnd4', icon: '▤', label: '以 BND4 容器打开当前选择', run: openBnd4ForSelection },
    { id: 'open-workspace', icon: '⌘', label: '打开 Mod 工作区…', run: (): void => { void openWorkspace(); } },
    { id: 'view-operations', icon: '◷', label: '切换到任务与历史', run: openOperationsView },
    { id: 'open-settings', icon: '⚙', label: '切换到设置', run: (): void => { setSidebarCollapsed(false); setSidebarView('settings'); } },
    { id: 'focus-search', icon: '⌕', label: '聚焦资源搜索', hint: '搜索', run: focusSearchPanel },
    { id: 'toggle-agent', icon: '✦', label: '切换 AI Agent 面板', hint: 'Ctrl J', run: (): void => { setAgentOpen((open) => !open); } },
    { id: 'toggle-sidebar', icon: '◨', label: '切换侧栏', hint: 'Ctrl B', run: (): void => { setSidebarCollapsed((collapsed) => !collapsed); } }
  ];
  const cmdkNormalized = cmdkQuery.trim().toLowerCase();
  const filteredCmdkCommands = cmdkCommands.filter(
    (command) => !cmdkNormalized || command.label.toLowerCase().includes(cmdkNormalized)
  );
  /**
   * 命令面板的资源命中。
   *
   * 保留 8 条上限：命令面板是「快速跳转」而不是浏览器，列长了反而选不动。但必须
   * 说清命中总数——此前静默截断，用户敲了个宽泛关键字看到 8 条，会以为工作区里
   * 只有这 8 个匹配文件（实测整树 9111 文件，宽泛关键字可命中数千）。
   */
  const cmdkAllResourceMatches = cmdkNormalized
    ? (allFiles.length > 0 ? allFiles : files)
        .filter((file) => file.relativePath.toLowerCase().includes(cmdkNormalized))
    : [];
  const cmdkResourceHits = cmdkAllResourceMatches.slice(0, CMDK_RESOURCE_HIT_LIMIT);
  const cmdkTruncationNote = formatListTruncation({
    total: cmdkAllResourceMatches.length,
    shown: cmdkResourceHits.length,
    noun: '个资源',
    hint: '到资源浏览器按目录分页浏览，或用更精确的关键字'
  });
  const cmdkItemCount = filteredCmdkCommands.length + cmdkResourceHits.length;
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
    const file = cmdkResourceHits[index - filteredCmdkCommands.length];
    if (file) {
      setCmdkOpen(false);
      void selectFile(file);
    }
  }

  const welcomeStats = workspace
    ? `已索引 ${allFiles.length} 个资源 · ${workspace.workspaceLabel}${analysis ? ` · 已解析 ${analysis.parsedFiles}` : ''}`
    : '未打开 Mod 工作区 · 从左侧资源浏览器打开';
  const lastOperation = operationHistory.length > 0 ? operationHistory[0] : null;
  const sidebarStyle = { '--sidebar-w': `${sidebarWidth}px` } as CSSProperties;

  return (
    <div className="app-root">
      {/* ══════════ 标题栏 ══════════ */}
      <header className="titlebar">
        <div className="titlebar__brand">
          <svg className="brand-mark" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M12 2 L21 7 V17 L12 22 L3 17 V7 Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M12 7 L16.5 9.6 V14.4 L12 17 L7.5 14.4 V9.6 Z" fill="currentColor" opacity=".85" />
          </svg>
          <span className="brand-name">SoulForge</span>
          <span className="brand-tag" title={sessionMeta?.workspaceLabel ?? workspace?.workspaceLabel ?? '未打开工作区'}>
            {workspace?.workspaceLabel ?? '未打开工作区'} · {sessionMeta?.game ?? 'sekiro'}
          </span>
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

      <WorkspaceResourceBar
        mode={resourceMode}
        counts={counts}
        onSelect={selectResourceMode}
      />

      <div className="shell">
        {/* ══════════ 活动栏 ══════════ */}
        <nav className="activitybar" aria-label="主导航">
          <button
            type="button"
            className={sidebarView === 'explorer' && !sidebarCollapsed ? 'ab-item is-active' : 'ab-item'}
            onClick={() => activateSidebarView('explorer')}
            title="资源浏览器"
            aria-label="资源浏览器"
            aria-current={sidebarView === 'explorer' && !sidebarCollapsed ? true : undefined}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.2h9A1.5 1.5 0 0 1 21 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className={sidebarView === 'search' && !sidebarCollapsed ? 'ab-item is-active' : 'ab-item'}
            onClick={() => activateSidebarView('search')}
            title="搜索"
            aria-label="搜索"
            aria-current={sidebarView === 'search' && !sidebarCollapsed ? true : undefined}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M15.8 15.8L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className={sidebarView === 'staging' && !sidebarCollapsed ? 'ab-item is-active' : 'ab-item'}
            onClick={() => activateSidebarView('staging')}
            title="暂存区"
            aria-label={pendingChangeCount > 0 ? `暂存区（${pendingChangeCount} 项待处理）` : '暂存区'}
            aria-current={sidebarView === 'staging' && !sidebarCollapsed ? true : undefined}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M12 12l8-4.5M12 12L4 7.5M12 12v9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
            {pendingChangeCount > 0 && <span className="ab-badge" aria-hidden="true">{pendingChangeCount}</span>}
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
              <path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M12 7v5l3.2 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              <path d="M18.5 2.5v4h-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="ab-spacer"></div>
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
              {/* 超过一页时标题栏就要说明「显示的是一页」，否则 200 与 9111 长得一样。 */}
              <span className="panel__hint">
                {resourceMode} · {visibleFiles.length} 项
                {visibleFiles.length > FILE_LIST_PAGE_SIZE
                  ? ` · 本页 ${pagedFiles.length}`
                  : ''}
              </span>
            </div>
            <div className="panel__body panel__body--pad">
              {isBrowserPreview && (
                <div className="runtime-notice" role="note">
                  浏览器预览：文件系统功能仅在 SoulForge 桌面版可用
                </div>
              )}
              <div className="explorer-actions">
                <button
                  type="button"
                  className="btn btn--primary btn--block"
                  data-testid="open-workspace"
                  onClick={() => void openWorkspace()}
                  {...(isBrowserPreview ? {
                    'aria-disabled': true,
                    title: '浏览器预览：「打开 Mod 工作区」仅在 SoulForge 桌面版可用'
                  } : {})}
                >
                  打开 Mod 工作区
                </button>
                <div className="row gap">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    data-testid="choose-base-directory"
                    onClick={() => void chooseBaseDirectory()}
                    {...(isBrowserPreview ? {
                      'aria-disabled': true,
                      title: '浏览器预览：「选择原版目录」仅在 SoulForge 桌面版可用'
                    } : {})}
                  >
                    {baseRootChoice ? '更换原版目录' : '选择原版目录'}
                  </button>
                  {baseRootChoice && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={clearBaseDirectory}>清除</button>
                  )}
                </div>
                {baseRootChoice && (
                  <p className="explorer-base-note" title={baseRootChoice.label}>
                    原版（下次打开生效）：{baseRootChoice.label}
                  </p>
                )}
                <div className="explorer-mount">
                  <span className="explorer-mount__item" title={workspace?.workspaceLabel ?? '未打开 Mod 工作区'}>
                    工作区：{workspace?.workspaceLabel ?? '未打开'}
                  </span>
                  <span className={sessionMeta?.baseMounted ? 'pill pill--ok' : 'pill'}>
                    原版：{sessionMeta?.baseMounted ? '已挂载（只读）' : baseRootChoice ? '待打开生效' : '未挂载'}
                  </span>
                </div>
              </div>
              <div className="search-box">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="过滤路径 / 类型"
                  aria-label="过滤资源列表"
                />
              </div>
              <div className="file-list">
                {pagedFiles.map((file) => (
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
                {visibleFiles.length === 0 && (
                  <p className="empty-hint">当前目录没有匹配资源。可切换到 all 或调整路径过滤。</p>
                )}
              </div>
              {/* 分页导航：只在真的超过一页时出现，避免小工作区多一排无意义控件。 */}
              {visibleFiles.length > FILE_LIST_PAGE_SIZE && (
                <div className="row gap pager" data-testid="file-list-pager">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={clampedFilePage <= 0}
                    onClick={() => setFilePage((page) => Math.max(0, page - 1))}
                  >
                    上一页
                  </button>
                  <span className="muted" data-testid="file-list-page-range">
                    {formatPageRange({
                      page: clampedFilePage,
                      pageSize: FILE_LIST_PAGE_SIZE,
                      total: visibleFiles.length,
                      noun: '资源'
                    })}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={clampedFilePage >= filePageCount - 1}
                    onClick={() => setFilePage((page) => Math.min(filePageCount - 1, page + 1))}
                  >
                    下一页
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* ── 搜索 ── */}
          <section className={sidebarView === 'search' ? 'panel is-active' : 'panel'} data-panel-id="search" aria-label="搜索">
            <div className="panel__header"><h2 className="panel__title">搜索</h2></div>
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
                {query.trim() !== '' && visibleFiles.length === 0 && <p className="empty-hint">无匹配结果。</p>}
                {query.trim() !== '' && searchTruncationNote && (
                  <p className="muted" data-testid="search-truncation">{searchTruncationNote}</p>
                )}
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
            </div>
            <div className="panel__body panel__body--pad">
              <ChangeQueuePanel
                state={changeState}
                actions={{
                  approve: (id) => { changeStore.approve(id); },
                  reject: (id) => { changeStore.reject(id); },
                  undoToDraft: (id) => { changeStore.undoToDraft(id); },
                  discard: (id) => { changeStore.discard(id); },
                  clearTerminal: () => { changeStore.clearTerminal(); },
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
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void rollbackOp(entry.opId)}>
                          回滚
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ── 设置 ── */}
          <section className={sidebarView === 'settings' ? 'panel is-active' : 'panel'} data-panel-id="settings" aria-label="设置">
            <div className="panel__header"><h2 className="panel__title">设置</h2></div>
            <div className="panel__body panel__body--pad">
              {/* 模型、思考强度与权限模式已迁入右侧 Agent 面板；此处只保留工作区与安全基础设施设置。 */}
              <div className="setting-row">
                <div>
                  <div className="setting-name">原版游戏目录（只读）</div>
                  <div className="setting-desc">
                    {sessionMeta?.baseLabel
                      ?? baseRootChoice?.label
                      ?? (sessionMeta ? '未挂载' : '打开工作区前可先选择')}
                  </div>
                </div>
                <span className={sessionMeta?.baseMounted ? 'pill pill--ok' : 'pill'}>
                  {sessionMeta ? (sessionMeta.baseMounted ? '已挂载' : '未挂载') : '待选择'}
                </span>
              </div>
              <div className="row gap setting-actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void chooseBaseDirectory()}
                  {...(isBrowserPreview ? { 'aria-disabled': true } : {})}
                >
                  {baseRootChoice ? '更换原版游戏目录' : '选择原版游戏目录'}
                </button>
                {baseRootChoice && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={clearBaseDirectory}>清除选择</button>
                )}
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-name">写入路径</div>
                  <div className="setting-desc">变更必须经暂存与备份后写入（内部：PatchIR / Patch Engine）</div>
                </div>
                <span className="pill pill--ok">强制</span>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-name">回滚</div>
                  <div className="setting-desc">写入前自动备份，可按操作回滚</div>
                </div>
                <span className="pill pill--ok">可用</span>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-name">界面主题</div>
                  <div className="setting-desc">锻造台暗色</div>
                </div>
                <span className="pill">暗色（亮色待定）</span>
              </div>

              {/*
                me3 运行时挂在设置面板：它是工作区级的运行基础设施，不属任何单个资源。
                放这里不违反本面板的 e2e 约束（renderer.spec.mjs:354-356 只禁
                「思考强度」「模型服务」「运行 / 权限模式」三个词，那些属 Agent 面板）。

                启动按钮默认禁用，门槛走 me3LaunchGuard 的纯判定——scope.json 的
                SCOPE-RUNTIME 明禁 launch-with-missing-or-ambiguous-capability，
                而 launchMe3 会真实启动零售游戏。
              */}
              <Me3RuntimePanel />
            </div>
          </section>

          <div className="sidebar-resizer" onPointerDown={startSidebarResize} aria-hidden="true"></div>
        </aside>

        {/* ══════════ 编辑器主区 ══════════ */}
        <main className="editor-area">
          <div className="tabbar" role="tablist" aria-label="打开的资源">
            {openTabs.map((tab) => {
              const isActive = selectedFile?.sourceUri === tab.sourceUri;
              const shortName = tab.relativePath.split(/[\\/]/).pop() ?? tab.relativePath;
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
              <div className="pane-toolbar">
                <span className="crumb">
                  <b>{centerView === 'operations' ? '任务与历史' : resourceMode}</b>
                  {selectedFile ? ` · ${selectedFile.relativePath}` : ' · 资源预览'}
                </span>
                <span className="toolbar-spacer"></span>
                {hasUncommittedChanges && <span className="pill pill--warn">未写入变更</span>}
              </div>
              <div className="pane-content">
                <div className="viewer-content">
          {/* 面板级错误边界：任何一个资源族面板抛异常时只降级它自己，不带走整个界面。
              renderer 此前完全没有 ErrorBoundary，实测点 map 目录触发
              SCENE_URI_INVALID 后全部元素消失（详见 PanelErrorBoundary 注释）。
              key 绑定当前资源，切换资源时重建边界，避免上一份错误状态粘住。 */}
          <PanelErrorBoundary
            label={`${resourceMode} 资源面板`}
            key={`panel-boundary:${selectedFile?.sourceUri ?? 'none'}`}
          >
          {!selectedFile && <p className="muted">选择左侧资源后显示限量文本或十六进制预览。</p>}
          {preview?.structuredPreview && <StructuredPreviewCard preview={preview.structuredPreview} />}
          {preview?.nativeInspection && <NativeInspectionCard inspection={preview.nativeInspection} />}
          {preview?.previewKind === 'text' && (
            <section className="text-editor-panel">
              <div className="text-editor-toolbar">
                <strong>{canEditText ? '文本编辑器' : '文本预览'}</strong>
                <div>
                  <button type="button" disabled={!canEditText || !editDirty} onClick={() => saveCurrentText()}>生成变更候选</button>
                  <button type="button" disabled={!editDirty} onClick={() => setEditText(lastSavedText)}>还原</button>
                </div>
              </div>
              {!canEditText && <p className="muted">该资源当前只读。原因通常是预览被截断、不是文本资源，或原生二进制写回器尚未启用。</p>}
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
          {preview?.previewKind === 'hex' && preview.hex && (
            <HexEditorPanel
              title={selectedFile?.relativePath ?? '二进制资源'}
              initialBytesBase64={typeof preview.hex === 'string' && !preview.hex.includes(' ')
                ? preview.hex
                : hexTextToBase64(preview.hex)}
              totalBytes={preview.file?.size}
              {...(selectedFile && bridge
                ? {
                    // 接 readRawMetadata（main handler ipc.ts:1198）。独立价值是
                    // 「不读内容就能拿到整文件哈希」——hex 视图一次只加载一个
                    // 4 KiB 窗口，算不出整文件哈希，而校验「我看的这份字节属于哪个
                    // 文件版本」需要它。core 对超上限文件报 deferred 而非硬算。
                    onLoadMetadata: async () => {
                      const raw = await bridge.readRawMetadata(selectedFile.sourceUri) as
                        Record<string, unknown> | null;
                      if (raw === null) return null;
                      return {
                        ...(typeof raw.size === 'number' ? { size: raw.size } : {}),
                        ...(typeof raw.contentHash === 'string' ? { contentHash: raw.contentHash } : {}),
                        ...(typeof raw.hashStatus === 'string' ? { hashStatus: raw.hashStatus } : {})
                      };
                    }
                  }
                : {})}
              {...(selectedFile && bridge
                ? {
                    // 接 readRawRange（main handler ipc.ts:1170）——预览只读前 64 KiB，
                    // 而实测 mods 下 237 个文件有 148 个超过它，此前 hex 证据对这些文件
                    // 只能看到开头且把前缀长度当总量显示。硬约束 17 要求大规模访问分页。
                    // 不用 `as` 整体断言 IPC 返回值——第一版那样写掩盖了一个真 bug：
                    // core 的字段叫 base64（rawRead.ts:35）而我写成 bytesBase64，
                    // 断言让 typecheck 通过、功能却永远读不到数据。改为逐字段取值 +
                    // 运行期类型判断，字段名对不上时至少 diagnostics 会带出原因。
                    onLoadRange: async (offset: number, length: number) => {
                      const raw = await bridge.readRawRange(
                        selectedFile.sourceUri,
                        offset,
                        length
                      ) as Record<string, unknown> | null;
                      const rec = raw ?? {};
                      const diags = Array.isArray(rec.diagnostics)
                        ? (rec.diagnostics as Array<{ code?: unknown; message?: unknown }>).map((d) => ({
                            code: String(d.code ?? 'UNKNOWN'),
                            message: String(d.message ?? '')
                          }))
                        : [];
                      return {
                        ok: rec.ok === true,
                        ...(typeof rec.base64 === 'string' ? { base64: rec.base64 } : {}),
                        ...(typeof rec.fileSize === 'number' ? { fileSize: rec.fileSize } : {}),
                        diagnostics: diags
                      };
                    }
                  }
                : {})}
            />
          )}
          {preview?.previewKind === 'hex' && !preview.hex && <pre className="muted">无 Hex 预览数据。</pre>}
          {centerView === 'resource' && resourceMode === 'map' && (
            <>
              <p className="muted">
                {msbLive ? '实时 Bridge MSB parts' : '空场景（未选中可解析 MSB 或读取失败）'}
              </p>
              <MsbScenePanel
                key={`${selectedFile?.sourceUri ?? ''}:${msbSourceHash ?? ''}:${msbParts.length}:${msbRegions.length}`}
                mapResourceUri={selectedFile?.sourceUri ?? ''}
                sourcePath={selectedFile?.relativePath ?? ''}
                game="sekiro"
                revision={msbSourceHash ?? '未加载'}
                models={msbModels}
                parts={msbParts}
                regions={msbRegions}
                events={msbEvents}
                sourceCounts={msbSourceCounts}
                maxNodes={2000}
                writeEnabled={!isDeferredPreviewEditorKind('msb')
                  && msbLive
                  && Boolean(msbSourceHash)
                  && Boolean(selectedFile)}
                {...(isDeferredPreviewEditorKind('msb')
                  ? { deferredPreviewRelease: DEFERRED_PREVIEW_TARGET_RELEASE }
                  : {
                      onPartPositionCommit: (input: MsbPositionCommitInput) => {
                        void commitMsbPosition(input, 'set_part_position');
                      },
                      onRegionPositionCommit: (input: MsbPositionCommitInput) => {
                        void commitMsbPosition(input, 'set_region_position');
                      },
                      onPartTransformCommit: (input: MsbTransformCommitInput) => {
                        void commitMsbTransform(input);
                      }
                    })}
              />
            </>
          )}
          {centerView === 'resource' && resourceMode === 'event' && (
            <>
              <p className="muted">
                {emevdLive
                  ? `实时 Bridge 文档${emevdSourceHash ? ` · hash ${emevdSourceHash.slice(0, 12)}…` : ''}`
                  : '空文档（未选中可解析的 EMEVD 或读取失败）'}
              </p>
              <EmevdFourViewPanel
                key={`${emevdDocument.resourceUri}:${emevdDocument.revision}:${emevdLive ? 'live' : 'demo'}`}
                initialDocument={emevdDocument}
                {...(emevdDslTemplate !== null ? { dslTemplate: emevdDslTemplate } : {})}
                {...(emevdDslTemplateTruncated
                  ? {
                      dslTemplateTruncated: true,
                      dslTemplateTotalLines: emevdDslTemplateTotalLines,
                      onLoadFullDslTemplate: async () => {
                        if (!selectedFile || !bridge) return;
                        const full = await bridge.readEmevdFullDocument(
                          selectedFile.sourceUri,
                          `renderer-${selectedFile.sourceUri}-${Date.now()}`,
                          true
                        );
                        if (full?.ok && full.dslTemplate) {
                          setEmevdDslTemplate(full.dslTemplate);
                          setEmevdDslTemplateTruncated(false);
                          setEmevdDslTemplateTotalLines(full.dslTemplateTotalLines ?? 0);
                          setStatus(`完整 DSL 模板已加载（共 ${full.dslTemplateTotalLines ?? 0} 行）。`);
                        } else {
                          setStatus(full?.diagnostics?.[0]?.message ?? '完整模板加载失败。');
                        }
                      }
                    }
                  : {})}
                onDslSubmit={async (sourceText) => {
                  if (!emevdLive || !selectedFile) {
                    return {
                      ok: false,
                      diagnostics: [{ severity: 'error', code: 'EMEVD_DSL_NO_LIVE_DOCUMENT', message: '需要实时 EMEVD 文档才能提交 DSL。' }]
                    };
                  }
                  if (!bridge) {
                    return {
                      ok: false,
                      diagnostics: [{ severity: 'error', code: 'BRIDGE_UNAVAILABLE', message: describeBridgeAbsence('提交 EMEVD DSL') }]
                    };
                  }
                  if (typeof bridge.submitEmevdDslPlan !== 'function') {
                    return {
                      ok: false,
                      diagnostics: [{ severity: 'error', code: 'PRELOAD_MISSING', message: '当前预加载未暴露 submitEmevdDslPlan。' }]
                    };
                  }
                  const result = await bridge.submitEmevdDslPlan(selectedFile.sourceUri, sourceText);
                  if (result.ok) {
                    const reload = await bridge.readEmevdFullDocument(
                      selectedFile.sourceUri,
                      `renderer-${selectedFile.sourceUri}-${Date.now()}`
                    );
                    if (reload?.ok && reload.dslTemplate) {
                      setEmevdDslTemplate(reload.dslTemplate);
                      setEmevdDslTemplateTruncated(reload.dslTemplateTruncated ?? false);
                      setEmevdDslTemplateTotalLines(reload.dslTemplateTotalLines ?? 0);
                      if (reload.sourceHash) setEmevdSourceHash(reload.sourceHash);
                      const refreshed = await bridge.readEmevdDocument(selectedFile.sourceUri) as {
                        ok?: boolean;
                        data?: BridgeEmevdEnvelopeLike | null;
                      };
                      if (refreshed?.ok && refreshed.data) {
                        setEmevdDocument(mapEmevdEnvelopeToDocument(selectedFile.sourceUri, refreshed.data, { maxEvents: 128 }));
                      }
                      return {
                        ok: true,
                        diagnostics: result.diagnostics ?? [],
                        nextDslTemplate: reload.dslTemplate
                      };
                    }
                  }
                  return {
                    ok: result.ok,
                    diagnostics: result.diagnostics ?? [{
                      severity: 'error',
                      code: 'EMEVD_DSL_SUBMIT_FAILED',
                      message: 'DSL 提交失败。'
                    }]
                  };
                }}
                onStructuredMutation={(mutation) => {
                  void (async () => {
                    if (!emevdLive || !emevdSourceHash || !selectedFile) {
                      setStatus('当前资源未实时加载，不能生成 mutation；请先选中可解析资源。');
                      return;
                    }
                    if (!bridge) {
                      setStatus(describeBridgeAbsence('提交 EMEVD mutation'));
                      return;
                    }
                    if (typeof bridge.applyEmevdMutation !== 'function') {
                      setStatus('当前预加载未暴露 applyEmevdMutation。');
                      return;
                    }
                    setStatus('正在经 Bridge/补丁引擎提交 EMEVD mutation…');
                    const eventIdMatch = /#event\/(-?\d+)/.exec(mutation.eventUri);
                    const eventId = eventIdMatch ? Number(eventIdMatch[1]) : undefined;
                    const bridgeMutation =
                      mutation.kind === 'emevd_set_rest_behavior'
                        ? {
                            kind: 'set_rest_behavior',
                            eventId,
                            restBehavior: mutation.restBehavior
                          }
                        : {
                            kind: 'update_id',
                            eventId,
                            newEventId: mutation.newEventId
                          };
                    const result = await bridge.applyEmevdMutation(
                      selectedFile.sourceUri,
                      emevdSourceHash,
                      bridgeMutation
                    );
                    if (!result.ok) {
                      setStatus(result.diagnostics?.[0]?.message ?? 'EMEVD 提交失败');
                      return;
                    }
                    setStatus('EMEVD mutation 已提交；正在重读…');
                    const reload = await bridge.readEmevdDocument(selectedFile.sourceUri) as {
                      ok?: boolean;
                      data?: BridgeEmevdEnvelopeLike | null;
                    };
                    if (reload?.ok && reload.data) {
                      setEmevdDocument(mapEmevdEnvelopeToDocument(selectedFile.sourceUri, reload.data, {
                        maxEvents: 128
                      }));
                      setEmevdSourceHash(reload.data.sourceHash ?? null);
                      setStatus('EMEVD 已提交并重读。');
                    } else {
                      setStatus('EMEVD 已提交，但重读失败。');
                    }
                    await refreshOperationHistory();
                  })();
                }}
              />
            </>
          )}
          {centerView === 'resource' && resourceMode === 'msg' && (
            <>
              <p className="muted">
                {fmgLive
                  ? `实时 Bridge FMG${fmgSourceHash ? ` · hash ${fmgSourceHash.slice(0, 12)}…` : ''}`
                  : '空条目（未选中可解析 FMG 或读取失败）'}
              </p>
              <FmgWorkbenchPanel
                key={`${selectedFile?.sourceUri ?? ''}:${fmgLive ? 'live' : 'empty'}:${fmgSourceHash ?? ''}`}
                resourceUri={selectedFile?.sourceUri ?? ''}
                entries={fmgEntries}
                live={fmgLive}
                onMutation={(mutation) => {
                  if (!fmgLive || !fmgSourceHash || !selectedFile) {
                    setStatus('当前 FMG 未实时加载，不能生成候选变更；请先选中可解析资源。');
                    return;
                  }
                  const op = mutation.kind === 'fmg_entry_delete' ? 'delete'
                    : mutation.kind === 'fmg_entry_add' ? 'add' : 'upsert';
                  const oldText = op === 'upsert'
                    ? (fmgEntries.find((entry) => entry.id === mutation.id)?.text ?? '')
                    : '';
                  changeStore.propose({
                    kind: 'fmg',
                    sourceUri: selectedFile.sourceUri,
                    target: `${selectedFile.relativePath}#${mutation.id}`,
                    summary: op === 'delete'
                      ? `删除条目 ${mutation.id}`
                      : `${mutation.text ?? ''}`,
                    oldValue: op === 'delete' ? oldText || `条目 ${mutation.id}` : oldText,
                    newValue: op === 'delete' ? '（删除）' : mutation.text ?? '',
                    payload: {
                      op,
                      id: mutation.id,
                      ...(mutation.text !== undefined ? { text: mutation.text } : {})
                    }
                  });
                  setStatus('FMG 候选变更已进入审查队列。');
                }}
              />
            </>
          )}
          {centerView === 'resource' && resourceMode === 'param' && (
            <>
              <p className="muted">
                {paramLive
                  ? `实时 Bridge PARAM${paramSourceHash ? ` · hash ${paramSourceHash.slice(0, 12)}…` : ''}`
                  : '空行（未选中可解析 PARAM 或读取失败）'}
              </p>
              <ParamTablePanel
                key={`${selectedFile?.sourceUri ?? ''}:${paramLive ? 'live' : 'empty'}:${paramSourceHash ?? ''}`}
                typeName={paramTypeName}
                resourceUri={selectedFile?.sourceUri ?? ''}
                rows={paramRows}
                live={paramLive}
                onMutation={(mutation) => {
                  if (!paramLive || !paramSourceHash || !selectedFile) {
                    setStatus('当前 PARAM 未实时加载，不能生成候选变更；请先选中可解析资源。');
                    return;
                  }
                  if (mutation.kind === 'param_row_delete') {
                    changeStore.propose({
                      kind: 'param-row',
                      sourceUri: selectedFile.sourceUri,
                      target: `${selectedFile.relativePath}#${mutation.id}`,
                      summary: `删除行 ${mutation.id}`,
                      oldValue: `行 ${mutation.id}`,
                      newValue: '（删除）',
                      payload: { op: 'delete', id: mutation.id }
                    });
                    setStatus('PARAM 行删除候选已进入审查队列。');
                    return;
                  }
                  // Duplicate/upsert payload: the paged table carries the full row
                  // bytes (dataBase64); fall back to the App-side payload map
                  // for rows outside the current page.
                  const payload =
                    mutation.dataBase64
                    ?? paramRowPayloads.get(mutation.id)
                    ?? (mutation.sourceId !== undefined
                      ? paramRowPayloads.get(mutation.sourceId)
                      : undefined);
                  if (!payload) {
                    setStatus('缺少 row dataBase64，无法生成候选（截断行）。');
                    return;
                  }
                  changeStore.propose({
                    kind: 'param-row',
                    sourceUri: selectedFile.sourceUri,
                    target: `${selectedFile.relativePath}#${mutation.id}`,
                    summary: mutation.sourceId !== undefined
                      ? `复制行 ${mutation.sourceId} → ${mutation.id}`
                      : `写入行 ${mutation.id}`,
                    oldValue: '',
                    newValue: `行 ${mutation.id}（${payload.length} 字节 base64）`,
                    payload: { op: 'upsert', id: mutation.id, dataBase64: payload }
                  });
                  setStatus('PARAM 行候选已进入审查队列。');
                }}
              />
              <ParamDefPanel
                key={`paramdef:${paramLive ? 'live' : 'empty'}:${paramSourceHash ?? ''}`}
                typeName={paramLive ? paramTypeName : '未加载'}
                rowDataSize={paramLive ? paramRowDataSize : 0}
                origin={paramLive ? '待绑定' : 'fixture'}
                resourceUri={selectedFile?.sourceUri ?? ''}
                live={paramLive}
                definition={paramLive ? null : EMPTY_PARAM_DEF}
                rows={paramRows}
                getRowDataBase64={(rowId) => paramRowPayloads.get(rowId)}
                {...(paramLive && selectedFile
                  ? {
                    onApplyFieldMutation: async (input: {
                      rowId: number;
                      fieldId: string;
                      value: number | string | boolean;
                      rowDataBase64: string;
                      definition: unknown;
                    }) => {
                      const target = selectedFile;
                      changeStore.propose({
                        kind: 'param-field',
                        sourceUri: target.sourceUri,
                        target: `${target.relativePath}#${input.rowId}.${input.fieldId}`,
                        summary: `${input.fieldId} → ${String(input.value)}`,
                        oldValue: '',
                        newValue: String(input.value),
                        payload: { ...input }
                      });
                      setStatus('PARAM 字段候选已进入审查队列。');
                      return { ok: true, diagnostics: [] };
                    }
                  }
                  : {})}
              />
            </>
          )}
          {centerView === 'resource' && resourceMode === 'script' && (
            <>
              <p className="muted">
                {selectedFile
                  ? '实时脚本容器只读证据（字节码绝不显示为可编辑源码）'
                  : '选择左侧脚本容器（如 luabnd）后显示只读证据'}
              </p>
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
                  ? 'BND4 容器工作台（只读条目树 + 用户提供字节的整个子项替换）'
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
              diagnostics={(preview?.diagnostics ?? []).map((d) => ({
                severity: d.severity,
                code: d.code,
                message: d.message,
                ...(d.sourceUri ? { resourceUri: d.sourceUri } : {})
              }))}
              patchImpact={null}
              onCancelJob={() => setStatus('任务取消请求已记录；待 TaskQueue IPC。')}
              onRollback={(opId) => {
                if (!bridge) {
                  announceDesktopOnly('回滚操作');
                  return;
                }
                void bridge.rollbackOperation(opId).then(() => {
                  setStatus(`已请求回滚 ${opId}`);
                }).catch((error: unknown) => {
                  setStatus(error instanceof Error ? error.message : '回滚失败');
                });
              }}
            />
          )}
          {preview?.previewKind === 'empty' && <p className="muted">空文件。</p>}
          {preview?.previewKind === 'failed' && <p className="danger">预览失败。</p>}
          {selectedFile?.relativePath?.endsWith('.tae') && (
            <TaeWorkbenchPanel resourceUri={selectedFile.sourceUri} data={taeData as never} />
          )}
          {selectedFile?.relativePath?.endsWith('.esd') && (
            <EsdWorkbenchPanel resourceUri={selectedFile.sourceUri} data={esdData as never} />
          )}
          {selectedFile?.relativePath?.endsWith('.flver') && (
            <FlverWorkbenchPanel resourceUri={selectedFile.sourceUri} data={flverData as never} />
          )}
          {selectedFile?.relativePath?.endsWith('.tpf') && (
            <TpfWorkbenchPanel resourceUri={selectedFile.sourceUri} data={tpfData as never} />
          )}
          {preview?.truncated && (
            <p className="muted">
              {formatPreviewTruncation(preview.bytesRead, preview.file?.size)}
            </p>
          )}
          </PanelErrorBoundary>
                </div>
              </div>
            </div>

            {/* ── 欢迎页：真实工作区摘要 ── */}
            <div className={`editor-welcome${openTabs.length > 0 ? ' is-hidden' : ''}`}>
              <div className="welcome">
                <div className="welcome__head">
                  <svg viewBox="0 0 24 24" width="26" height="26" className="welcome-mark" aria-hidden="true">
                    <path d="M12 2 L21 7 V17 L12 22 L3 17 V7 Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                    <path d="M12 7 L16.5 9.6 V14.4 L12 17 L7.5 14.4 V9.6 Z" fill="currentColor" opacity=".8" />
                  </svg>
                  <h1>SoulForge</h1>
                  <span className="welcome__ws">{workspace?.workspaceLabel ?? '未打开工作区'} · {sessionMeta?.game ?? 'sekiro'}</span>
                </div>
                <p className="welcome__stats">{welcomeStats}</p>

                <section className="welcome__section" aria-label="待审查变更">
                  <div className="welcome-quick__label">待审查变更</div>
                  {draftChanges.length === 0 ? (
                    <p className="empty-hint welcome-empty">没有待审查的变更。</p>
                  ) : (
                    draftChanges
                      .slice(0, WELCOME_DRAFT_LIMIT)
                      .map((item) => (
                        <div className="review-row" key={item.id}>
                          <span className="review-row__target" title={item.sourceUri}>{item.target}</span>
                          <span className="review-row__delta">{item.summary}</span>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              setSidebarCollapsed(false);
                              setSidebarView('staging');
                            }}
                          >
                            审查
                          </button>
                        </div>
                      ))
                  )}
                  {draftTruncationNote && (
                    <p className="muted" data-testid="welcome-draft-truncation">{draftTruncationNote}</p>
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
        </main>

        {/* ══════════ Agent 面板 ══════════ */}
        <AgentSidebar
          open={agentOpen}
          busy={aiBusy}
          provider={aiProvider}
          thinking={aiThinking}
          permissionMode={aiMode}
          permissionLockReason={AI_PERMISSION_LOCK_REASON}
          goal={agentGoal}
          draft={aiDraft}
          prompt={aiPrompt}
          contextLabel={resourceMode}
          selectedFilePath={selectedFile?.relativePath ?? null}
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
            sessionsPage: agentSessionsPage,
            sessionsError: agentSessionsError,
            sessionDetail: agentSessionDetail,
            onSelectService: setAgentServiceId,
            onRun: () => void runAgentTask(),
            onCancel: () => void cancelAgentTask(),
            onRefreshSessions: () => void refreshAgentSessions(),
            onSessionsPageChange: setAgentSessionsPage,
            onLoadSession: (sessionPath) => void loadAgentSession(sessionPath),
            onResumeSession: (sessionPath) => void runAgentTask(sessionPath)
          }}
          eventUri={eventUri}
          onEventUriChange={setEventUri}
          onProviderChange={setAiProvider}
          onThinkingChange={setAiThinking}
          onPromptChange={setAiPrompt}
          onSend={() => void sendAgentPrompt()}
          onClose={() => setAgentOpen(false)}
          onRunToolSearch={(toolQuery) => void runToolSearch(toolQuery)}
          onExplainEvent={(uri) => void explainEvent(uri)}
        />
      </div>

      {/* ══════════ 状态栏 ══════════ */}
      <footer className="status-bar">
        <div className="statusbar__left">
          <span className="st-item st-branch" title="工作区">
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M6 3v6a4 4 0 0 0 4 4h4" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="6" cy="5" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="6" cy="19" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="18" cy="13" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M6 7v10" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            {workspace?.workspaceLabel ?? '未打开工作区'}
          </span>
          <span className="st-item" title="VFS 索引">
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <ellipse cx="12" cy="5.5" rx="7" ry="2.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5 5.5v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6M5 11.5v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {allFiles.length} 资源已索引
          </span>
          <span className="st-item" title="当前中央资源">当前：{selectedFile?.relativePath ?? '无'}</span>
        </div>
        <div className="statusbar__right">
          <span className="st-item st-status" role="status" title={status}>{status}</span>
          <span className="st-item">{diagnostics.length ? `${diagnostics.length} 条诊断` : '没有诊断'}</span>
          <span className="st-item st-ok" title="写入前自动备份">
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M12 3l7 3v5c0 4.4-3 8-7 10-4-2-7-5.6-7-10V6Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            备份：启用 · 可回滚
          </span>
          <span className="st-item">{clockText}</span>
        </div>
      </footer>

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
            {cmdkItemCount === 0 && <p className="empty-hint">无匹配命令或资源。</p>}
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
            {cmdkResourceHits.map((file, index) => {
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
            {cmdkTruncationNote && (
              <p className="muted cmdk-truncation" data-testid="cmdk-truncation">{cmdkTruncationNote}</p>
            )}
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
  );
}
