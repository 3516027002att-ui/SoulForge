import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type {
  ContainerReadHint,
  ContainerReadSummary,
  Diagnostic,
  MapExport,
  ParamExport,
  ResourceKind,
  ResourceStructuredPreview,
  TextEntrySymbol
} from '@soulforge/shared';
import type {
  AnalyzeWorkspaceSummary,
  DirectorySelection,
  RendererWorkspaceScanResult,
  RendererWorkspaceSession
} from '../../main/ipc.js';
import type {
  RendererBridgeResult,
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
import { ModelServiceSettingsPanel } from './editors/ModelServiceSettingsPanel.js';
import { EmevdFourViewPanel } from './editors/EmevdFourViewPanel.js';
import { FmgWorkbenchPanel } from './editors/FmgWorkbenchPanel.js';
import { ParamTablePanel } from './editors/ParamTablePanel.js';
import { WorkbenchOpsPanel } from './editors/WorkbenchOpsPanel.js';
import { ParamDefPanel } from './editors/ParamDefPanel.js';
import type { EmevdEditorDocument } from '@soulforge/shared';
import {
  mapEmevdEnvelopeToDocument,
  type BridgeEmevdEnvelopeLike
} from './emevd/mapEmevdEnvelope.js';

const RESOURCE_KIND_ORDER: ResourceKind[] = ['event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai', 'sfx', 'chr', 'obj', 'other', 'unknown'];

type WorkspaceMode = ResourceKind | 'files' | 'ai' | 'settings' | 'ops';

const WORKSPACE_MODES: Array<{ id: WorkspaceMode; label: string }> = [
  { id: 'files', label: '文件' },
  { id: 'event', label: 'EMEVD 事件' },
  { id: 'map', label: 'MSB 地图' },
  { id: 'param', label: 'PARAM 参数' },
  { id: 'msg', label: 'FMG 文本' },
  { id: 'menu', label: '菜单' },
  { id: 'script', label: '脚本' },
  { id: 'action', label: '动作' },
  { id: 'chr', label: '角色资源' },
  { id: 'obj', label: '物件资源' },
  { id: 'sfx', label: 'SFX 特效' },
  { id: 'other', label: '其他' },
  { id: 'ops', label: '任务与历史' },
  { id: 'ai', label: 'AI' },
  { id: 'settings', label: '设置' }
];

/** Demo parts for map-mode proxy scene until Bridge MSB IPC is wired to the renderer. */
const DEMO_MSB_PARTS = [
  { name: 'm000010_1077', posX: -18.2, posY: -22.0, posZ: 34.0, rotX: -18, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 },
  { name: 'm000010_1143', posX: -44.5, posY: 45.0, posZ: -61.1, rotX: -48, scaleX: 1, scaleY: 1, scaleZ: 1 },
  { name: 'm000010_1144', posX: -43.6, posY: 9.3, posZ: -38.3, rotX: -55, scaleX: 1, scaleY: 1, scaleZ: 1 },
  { name: 'gate_proxy_a', posX: 12, posY: 0, posZ: 8, rotX: 0, scaleX: 2, scaleY: 4, scaleZ: 1 },
  { name: 'gate_proxy_b', posX: -8, posY: 0, posZ: -14, rotX: 90, scaleX: 1.5, scaleY: 1.5, scaleZ: 1.5 }
];

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

const DEMO_EMEVD_DOCUMENT: EmevdEditorDocument = {
  schemaVersion: 1,
  resourceUri: 'file://event/common.emevd',
  revision: 0,
  bytesBase64: btoa('EVD\0demo-bytes-for-readonly-view'),
  events: [
    {
      eventUri: 'file://event/common.emevd#event/50',
      eventId: 50,
      restBehavior: 0,
      layer: -1,
      instructions: [
        {
          instructionUri: 'file://event/common.emevd#event/50/instr/0',
          bank: 1,
          id: 10,
          argsBase64: '',
          unknown: true
        },
        {
          instructionUri: 'file://event/common.emevd#event/50/instr/1',
          bank: 1,
          id: 20,
          argsBase64: '',
          unknown: true
        }
      ]
    },
    {
      eventUri: 'file://event/common.emevd#event/100',
      eventId: 100,
      restBehavior: 1,
      layer: -1,
      instructions: []
    }
  ],
  diagnostics: [{
    severity: 'info',
    code: 'EMEVD_UNKNOWN_INSTRUCTIONS_PRESERVED',
    message: '未知 instruction 已保留；无 schema 时不可结构化改 args。'
  }]
};

const DEMO_FMG_ENTRIES = [
  { id: 5200, text: '旋风斩' },
  { id: 5201, text: '寄鹰斩' },
  { id: 5300, text: '义手忍具' }
];

const DEMO_PARAM_ROWS = [
  { id: 0, name: 'row_0', dataHexPreview: 'ffffffff00000000' },
  { id: 1, name: 'row_1', dataHexPreview: '0100000002000000' },
  { id: 2, dataHexPreview: '0000000000000000' }
];

interface EditableMsgRow {
  textId: string;
  text: string;
  category?: string;
}

export function App(): ReactElement {
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
  const [toolQuery, setToolQuery] = useState('');
  const [eventUri, setEventUri] = useState('');
  const [toolOutput, setToolOutput] = useState<ToolResult | null>(null);
  const [files, setFiles] = useState<RendererIndexedFile[]>([]);
  const [allFiles, setAllFiles] = useState<RendererIndexedFile[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('files');
  const [status, setStatus] = useState('就绪');
  const [emevdDocument, setEmevdDocument] = useState<EmevdEditorDocument>(DEMO_EMEVD_DOCUMENT);
  const [emevdSourceHash, setEmevdSourceHash] = useState<string | null>(null);
  const [emevdLive, setEmevdLive] = useState(false);
  const [fmgEntries, setFmgEntries] = useState(DEMO_FMG_ENTRIES);
  const [fmgSourceHash, setFmgSourceHash] = useState<string | null>(null);
  const [fmgLive, setFmgLive] = useState(false);
  const [msbParts, setMsbParts] = useState(DEMO_MSB_PARTS);
  const [msbRegions, setMsbRegions] = useState<Array<{
    name: string;
    typeId: number;
    posX: number;
    posY: number;
    posZ: number;
  }>>([]);
  const [msbLive, setMsbLive] = useState(false);
  const [msbSourceHash, setMsbSourceHash] = useState<string | null>(null);
  const [paramTypeName, setParamTypeName] = useState('ACTION_GUIDE_PARAM_ST');
  const [paramRows, setParamRows] = useState(DEMO_PARAM_ROWS);
  const [paramSourceHash, setParamSourceHash] = useState<string | null>(null);
  const [paramLive, setParamLive] = useState(false);
  const [paramRowPayloads, setParamRowPayloads] = useState<Map<number, string>>(new Map());

  const [aiProvider, setAiProvider] = useState<AiProvider>('mock');
  const [aiThinking, setAiThinking] = useState<AiThinkingLevel>('normal');
  const [aiMode] = useState<AiPermissionMode>('plan');
  const [aiPrompt, setAiPrompt] = useState('解释当前资源的证据链，并给出下一步安全修改计划。');
  const [aiDraft, setAiDraft] = useState<AiSidebarDraft | null>(null);

  const counts = useMemo(() => workspace?.countsByKind ?? null, [workspace]);
  const diagnostics = [...(workspace?.diagnostics ?? []), ...(analysis?.diagnostics ?? []), ...(preview?.diagnostics ?? [])];
  const groupedTools = useMemo(() => groupToolsByPermission(tools), [tools]);
  const canEditText = preview?.previewKind === 'text' && preview.structuredPreview?.editable === true && !preview.truncated;
  const hasMsgTable = canEditText && msgRows.length > 0;
  const editDirty = editText !== lastSavedText;
  const visibleFiles = useMemo(
    () => filterFilesForMode(allFiles.length > 0 ? allFiles : files, workspaceMode, query),
    [allFiles, files, workspaceMode, query]
  );

  useEffect(() => {
    let cancelled = false;
    async function loadParam(): Promise<void> {
      if (workspaceMode !== 'param') return;
      const target = selectedFile
        ?? visibleFiles.find((file) => file.resourceKind === 'param')
        ?? null;
      if (!target || typeof window.soulforge.readParamDocument !== 'function') {
        setParamRows(DEMO_PARAM_ROWS);
        setParamTypeName('ACTION_GUIDE_PARAM_ST');
        setParamSourceHash(null);
        setParamLive(false);
        setParamRowPayloads(new Map());
        return;
      }
      setStatus(`正在读取 PARAM：${target.relativePath}`);
      try {
        const result = await window.soulforge.readParamDocument(target.sourceUri) as {
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
            authority?: string;
          } | null;
        };
        if (cancelled) return;
        if (!result?.ok || !result.data?.rows?.length) {
          setParamRows(DEMO_PARAM_ROWS);
          setParamLive(false);
          setParamSourceHash(null);
          setParamRowPayloads(new Map());
          setStatus('PARAM 实时读取失败，已回退演示行。');
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
  }, [workspaceMode, selectedFile, visibleFiles]);

  useEffect(() => {
    let cancelled = false;
    async function loadFmg(): Promise<void> {
      if (workspaceMode !== 'msg') return;
      const target = selectedFile
        ?? visibleFiles.find((file) => file.resourceKind === 'msg')
        ?? null;
      if (!target || typeof window.soulforge.readFmgDocument !== 'function') {
        setFmgEntries(DEMO_FMG_ENTRIES);
        setFmgSourceHash(null);
        setFmgLive(false);
        return;
      }
      setStatus(`正在读取 FMG：${target.relativePath}`);
      try {
        const result = await window.soulforge.readFmgDocument(target.sourceUri) as {
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
          setFmgEntries(DEMO_FMG_ENTRIES);
          setFmgSourceHash(null);
          setFmgLive(false);
          setStatus('FMG 实时读取失败，已回退演示条目。');
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
  }, [workspaceMode, selectedFile, visibleFiles]);

  useEffect(() => {
    let cancelled = false;
    async function loadMsb(): Promise<void> {
      if (workspaceMode !== 'map') return;
      const target = selectedFile
        ?? visibleFiles.find((file) => file.resourceKind === 'map')
        ?? null;
      if (!target || typeof window.soulforge.readMsbDocument !== 'function') {
        setMsbParts(DEMO_MSB_PARTS);
        setMsbRegions([]);
        setMsbLive(false);
        return;
      }
      setStatus(`正在读取 MSB：${target.relativePath}`);
      try {
        const result = await window.soulforge.readMsbDocument(target.sourceUri) as {
          ok?: boolean;
          data?: {
            sourceHash?: string;
            parts?: Array<{
              name: string;
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
              typeId: number;
              posX: number;
              posY: number;
              posZ: number;
            }>;
            partCount?: number;
            regionCount?: number;
            authority?: string;
          } | null;
        };
        if (cancelled) return;
        if (!result?.ok || !result.data?.parts?.length) {
          setMsbParts(DEMO_MSB_PARTS);
          setMsbRegions([]);
          setMsbLive(false);
          setStatus('MSB 实时读取失败，已回退演示 parts。');
          return;
        }
        setMsbParts(result.data.parts.map((p) => ({
          name: p.name,
          posX: p.posX,
          posY: p.posY,
          posZ: p.posZ,
          rotX: p.rotX ?? 0,
          scaleX: p.scaleX ?? 1,
          scaleY: p.scaleY ?? 1,
          scaleZ: p.scaleZ ?? 1
        })));
        setMsbRegions((result.data.regions ?? []).map((r) => ({
          name: r.name,
          typeId: r.typeId,
          posX: r.posX,
          posY: r.posY,
          posZ: r.posZ
        })));
        setMsbSourceHash(result.data.sourceHash ?? null);
        setMsbLive(true);
        setStatus(
          `已加载 MSB：${result.data.partCount ?? result.data.parts.length} parts`
          + (result.data.regionCount !== undefined ? ` / ${result.data.regionCount} regions` : '')
          + (result.data.authority ? ` · ${result.data.authority}` : '')
        );
      } catch (error) {
        if (cancelled) return;
        setMsbLive(false);
        setStatus(error instanceof Error ? error.message : 'MSB 读取异常');
      }
    }
    void loadMsb();
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, selectedFile, visibleFiles]);

  useEffect(() => {
    let cancelled = false;
    async function loadEmevd(): Promise<void> {
      if (workspaceMode !== 'event') return;
      const target = selectedFile
        ?? visibleFiles.find((file) => file.resourceKind === 'event')
        ?? null;
      if (!target || typeof window.soulforge.readEmevdDocument !== 'function') {
        setEmevdDocument(DEMO_EMEVD_DOCUMENT);
        setEmevdSourceHash(null);
        setEmevdLive(false);
        return;
      }
      setStatus(`正在读取 EMEVD：${target.relativePath}`);
      try {
        const result = await window.soulforge.readEmevdDocument(target.sourceUri) as {
          ok?: boolean;
          data?: BridgeEmevdEnvelopeLike | null;
          diagnostics?: Array<{ message?: string }>;
        };
        if (cancelled) return;
        if (!result?.ok || !result.data) {
          setEmevdDocument({
            ...DEMO_EMEVD_DOCUMENT,
            resourceUri: target.sourceUri,
            diagnostics: [{
              severity: 'warning',
              code: 'EMEVD_LIVE_READ_FAILED',
              message: result?.diagnostics?.[0]?.message
                ?? '未能从 Bridge 读取 EMEVD；显示演示文档。'
            }]
          });
          setEmevdSourceHash(null);
          setEmevdLive(false);
          setStatus('EMEVD 实时读取失败，已回退演示文档。');
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
  }, [workspaceMode, selectedFile, visibleFiles]);

  async function refreshOperationHistory(): Promise<void> {
    const history = await window.soulforge.listOperations();
    setOperationHistory(history);
  }

  async function commitMsbPosition(
    input: { partName: string; posX: number; posY: number; posZ: number },
    kind: 'set_part_position' | 'set_region_position'
  ): Promise<void> {
    if (!msbLive || !msbSourceHash || !selectedFile) {
      setStatus('MSB 位置提交仅在实时模式可用。');
      return;
    }
    if (typeof window.soulforge.applyMsbMutation !== 'function') {
      setStatus('当前预加载未暴露 applyMsbMutation。');
      return;
    }
    const label = kind === 'set_region_position' ? 'region' : 'part';
    setStatus(`正在提交 MSB ${label} 位置：${input.partName}`);
    const result = await window.soulforge.applyMsbMutation(
      selectedFile.sourceUri,
      msbSourceHash,
      {
        kind,
        partName: input.partName,
        posX: input.posX,
        posY: input.posY,
        posZ: input.posZ
      }
    );
    if (!result.ok) {
      setStatus(result.diagnostics?.[0]?.message ?? `MSB ${label} 位置提交失败`);
      return;
    }
    const reload = await window.soulforge.readMsbDocument(selectedFile.sourceUri) as {
      ok?: boolean;
      data?: {
        sourceHash?: string;
        parts?: Array<{
          name: string;
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
          typeId: number;
          posX: number;
          posY: number;
          posZ: number;
        }>;
      } | null;
    };
    if (reload?.ok && reload.data?.parts?.length) {
      setMsbParts(reload.data.parts.map((p) => ({
        name: p.name,
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
        typeId: r.typeId,
        posX: r.posX,
        posY: r.posY,
        posZ: r.posZ
      })));
      setMsbSourceHash(reload.data.sourceHash ?? null);
      setStatus(`MSB ${label} ${input.partName} 位置已提交并重读。`);
    } else {
      setStatus('MSB 已提交，但重读失败。');
    }
    await refreshOperationHistory();
  }

  async function chooseBaseDirectory(): Promise<void> {
    const selection = await window.soulforge.openBaseDialog();
    if (!selection) return;
    setBaseRootChoice(selection);
    setStatus(`已选择只读原版游戏目录：${selection.label}（下次打开 Mod 工作区时生效）`);
  }

  function clearBaseDirectory(): void {
    setBaseRootChoice(null);
    setStatus('已清除原版游戏目录选择');
  }

  async function openWorkspace(): Promise<void> {
    const workspaceSelection = await window.soulforge.openWorkspaceDialog();
    if (!workspaceSelection) return;

    setStatus('正在扫描工作区...');
    const result = await window.soulforge.scanWorkspace({
      overlaySelectionId: workspaceSelection.selectionId,
      ...(baseRootChoice ? { baseSelectionId: baseRootChoice.selectionId } : {})
    });
    setWorkspace(result);
    setSessionMeta(result.session ?? null);
    setAllFiles(result.files);
    setFiles(result.files);
    setWorkspaceMode('files');
    setSelectedFile(null);
    setPreview(null);
    setEditText('');
    setLastSavedText('');
    setMsgRows([]);
    setSaveDiagnostics([]);
    setAnalysis(null);
    setToolOutput(null);
    setAiDraft(null);
    setOperationHistory([]);

    setStatus('正在构建轻量证据索引...');
    const nextAnalysis = await window.soulforge.analyzeWorkspace();
    setAnalysis(nextAnalysis);
    setTools(nextAnalysis.tools);
    setEventUri(nextAnalysis.events[0]?.uri ?? '');
    await refreshOperationHistory();
    const baseLabel = result.session.baseMounted
      ? ' · 已挂载只读原版游戏目录'
      : ' · 未挂载原版游戏目录';
    setBaseRootChoice(null);
    setStatus(`已索引并可打开 ${result.files.length} 个文件，解析 ${nextAnalysis.parsedFiles} 个文本/mock 资源${baseLabel}`);
  }

  async function search(): Promise<void> {
    const result = await window.soulforge.searchResources(query);
    setAllFiles(result);
    setFiles(result);
    setStatus(`搜索返回 ${result.length} 个文件`);
  }

  function switchMode(mode: WorkspaceMode): void {
    setWorkspaceMode(mode);
    if (mode === 'ai') {
      setStatus('AI 侧边栏已聚焦：计划优先，写入必须经过 Patch Engine');
      return;
    }
    if (mode === 'settings') {
    setStatus('设置：模型服务、思考强度和权限模式见右侧 AI 面板');
      return;
    }
    const filtered = filterFilesForMode(allFiles, mode, query);
    setStatus(mode === 'files'
      ? `文件模式：${filtered.length} 个文件`
      : `${workspaceModeLabel(mode)}：${filtered.length} 个资源`);
  }

  async function selectFile(file: RendererIndexedFile): Promise<void> {
    setSelectedFile(file);
    setPreview(null);
    setEditText('');
    setLastSavedText('');
    setMsgRows([]);
    setSaveDiagnostics([]);
    setAiDraft(null);
    setStatus(`正在打开 ${file.relativePath}...`);
    const nextPreview = await window.soulforge.openResourcePreview(file.sourceUri);
    setPreview(nextPreview);
    const text = nextPreview?.text ?? '';
    setEditText(text);
    setLastSavedText(text);
    setMsgRows(extractMsgRows(nextPreview));
    setStatus(nextPreview ? `已打开 ${file.relativePath}` : '无法预览该资源');
  }

  async function saveCurrentText(): Promise<void> {
    if (!selectedFile || !preview) return;
    setStatus(`正在保存 ${selectedFile.relativePath}...`);
    const result = await window.soulforge.saveTextResource(selectedFile.sourceUri, editText);
    setSaveDiagnostics(result.diagnostics.map((diagnostic: Diagnostic) => `${diagnostic.code}: ${diagnostic.message}`));

    if (!result.ok) {
      setStatus(`保存失败：${selectedFile.relativePath}`);
      return;
    }

    const refreshed = await window.soulforge.openResourcePreview(selectedFile.sourceUri);
    setPreview(refreshed);
    const text = refreshed?.text ?? editText;
    setEditText(text);
    setLastSavedText(text);
    setMsgRows(extractMsgRows(refreshed));
    await refreshOperationHistory();
    setStatus(`已保存 ${selectedFile.relativePath}，已建立可回滚备份`);
  }

  async function rollbackOp(opId: string): Promise<void> {
    setStatus(`正在回滚操作 ${opId.slice(0, 8)}...`);
    const result = await window.soulforge.rollbackOperation(opId);
    await refreshOperationHistory();
    if (!result.ok) {
      setStatus(`回滚失败：${result.diagnostics.map((d: Diagnostic) => d.message).join('; ') || opId}`);
      return;
    }
    if (selectedFile) {
      const refreshed = await window.soulforge.openResourcePreview(selectedFile.sourceUri);
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

    setStatus('正在生成 AI 计划草稿...');
    const draft = await window.soulforge.buildAiSidebarDraft(request);
    setAiDraft(draft);
    setStatus(draft.status === 'ready' ? 'AI 计划草稿已生成' : 'AI 模型服务尚未配置，已生成本地计划草稿');
  }

  async function runToolSearch(): Promise<void> {
    const result = await window.soulforge.runAiTool('search_resources', { query: toolQuery, limit: 8 });
    setToolOutput(result);
  }

  async function explainEvent(): Promise<void> {
    const result = await window.soulforge.runAiTool('explain_event', { uri: eventUri });
    setToolOutput(result);
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <section>
          <h1>SoulForge</h1>
          <p>魂游 Mod 专业工作台 · V0.5 安全底座 | Mod 覆盖层可写 · 原版游戏目录只读 · 补丁引擎唯一写入</p>
        </section>
        <div className="top-bar-actions">
          <button type="button" className="secondary-action" onClick={() => void chooseBaseDirectory()}>
            {baseRootChoice ? '更换原版游戏目录' : '选择原版游戏目录（可选）'}
          </button>
          {baseRootChoice && (
            <button type="button" className="ghost-action" onClick={clearBaseDirectory}>清除原版游戏目录</button>
          )}
          <button type="button" onClick={() => void openWorkspace()}>打开 Mod 工作区</button>
        </div>
      </header>

      <nav className="mode-tabs" aria-label="编辑器模式">
        {WORKSPACE_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={workspaceMode === mode.id ? (mode.id === 'ai' ? 'active ai-tab' : 'active') : mode.id === 'ai' ? 'ai-tab' : undefined}
            onClick={() => switchMode(mode.id)}
          >
            {mode.label}
            {counts && isResourceKindMode(mode.id) ? ` ${counts[mode.id] ?? 0}` : ''}
          </button>
        ))}
      </nav>

      <section className="workspace-summary">
        <div className="workspace-summary-lines">
          <div>
            <strong>工作区（Mod 覆盖层）：</strong> {workspace?.workspaceLabel ?? '未打开'}
            <span className="mode-badge">{workspaceModeLabel(workspaceMode)}</span>
          </div>
          <div>
            <strong>原版游戏目录（只读）：</strong>{' '}
            {sessionMeta?.baseLabel
              ?? baseRootChoice?.label
              ?? (sessionMeta ? '未挂载' : '打开工作区前可先选择')}
            {sessionMeta && (
              <span className={!sessionMeta.baseMounted ? 'base-pill missing' : 'base-pill ready'}>
                {sessionMeta.baseMounted ? '已挂载' : '未挂载'}
              </span>
            )}
          </div>
        </div>
        {counts && (
          <div className="counts">
            {RESOURCE_KIND_ORDER.map((kind) => (
              <button
                key={kind}
                type="button"
                className={workspaceMode === kind ? 'count-chip active' : 'count-chip'}
                onClick={() => switchMode(kind)}
              >
                {kind}: {counts[kind]}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="content-grid">
        <aside className="resource-pane">
          <div className="search-row">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索路径 / 类型"
            />
            <button type="button" onClick={search}>搜索</button>
          </div>
          <div className="file-list">
            {visibleFiles.map((file) => (
              <button
                type="button"
                key={file.sourceUri}
                className={selectedFile?.sourceUri === file.sourceUri ? 'file-item selected' : 'file-item'}
                onClick={() => void selectFile(file)}
              >
                <span>{file.relativePath}</span>
                <small>{file.resourceKind} | {file.formatLabel} | {(file.size / 1024).toFixed(1)} KB</small>
              </button>
            ))}
            {visibleFiles.length === 0 && (
              <p className="muted pane-empty">当前模式没有匹配资源。可切换到文件模式或调整搜索。</p>
            )}
          </div>
        </aside>

        <section className="viewer-pane">
          <h2>{selectedFile?.relativePath ?? '资源预览'}</h2>
          {!selectedFile && <p className="muted">选择左侧资源后显示限量文本或十六进制预览。</p>}
          {preview?.structuredPreview && <StructuredPreviewCard preview={preview.structuredPreview} />}
          {preview?.nativeInspection && <NativeInspectionCard inspection={preview.nativeInspection} />}
          {preview?.previewKind === 'text' && (
            <section className="text-editor-panel">
              <div className="text-editor-toolbar">
                <strong>{canEditText ? '文本编辑器' : '文本预览'}</strong>
                <div>
                  <button type="button" disabled={!canEditText || !editDirty} onClick={() => void saveCurrentText()}>保存</button>
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
              onPatch={() => setStatus('Hex mutation 已在渲染进程演示；提交须经主进程补丁引擎。')}
            />
          )}
          {preview?.previewKind === 'hex' && !preview.hex && <pre className="muted">无 Hex 预览数据。</pre>}
          {workspaceMode === 'map' && (
            <>
              <p className="muted">
                {msbLive ? '实时 Bridge MSB parts' : '演示 parts（未选中可解析 MSB 或读取失败）'}
              </p>
              <MsbScenePanel
                key={`${selectedFile?.sourceUri ?? 'demo'}:${msbLive ? 'live' : 'demo'}:${msbParts.length}:${msbRegions.length}`}
                mapResourceUri={selectedFile?.sourceUri ?? 'file://map/preview.msb'}
                parts={msbParts}
                regions={msbRegions}
                maxNodes={64}
                writeEnabled={msbLive && Boolean(msbSourceHash) && Boolean(selectedFile)}
                onPartPositionCommit={(input) => {
                  void commitMsbPosition(input, 'set_part_position');
                }}
                onRegionPositionCommit={(input) => {
                  void commitMsbPosition(input, 'set_region_position');
                }}
              />
            </>
          )}
          {workspaceMode === 'event' && (
            <>
              <p className="muted">
                {emevdLive
                  ? `实时 Bridge 文档${emevdSourceHash ? ` · hash ${emevdSourceHash.slice(0, 12)}…` : ''}`
                  : '演示文档（未选中可解析的 EMEVD 或读取失败）'}
              </p>
              <EmevdFourViewPanel
                key={`${emevdDocument.resourceUri}:${emevdDocument.revision}:${emevdLive ? 'live' : 'demo'}`}
                initialDocument={emevdDocument}
                onStructuredMutation={(mutation) => {
                  void (async () => {
                    if (!emevdLive || !emevdSourceHash || !selectedFile) {
                      setStatus('EMEVD mutation 仅在演示模式产生 UI 状态；提交须经实时文档 + 补丁引擎。');
                      return;
                    }
                    if (typeof window.soulforge.applyEmevdMutation !== 'function') {
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
                    const result = await window.soulforge.applyEmevdMutation(
                      selectedFile.sourceUri,
                      emevdSourceHash,
                      bridgeMutation
                    );
                    if (!result.ok) {
                      setStatus(result.diagnostics?.[0]?.message ?? 'EMEVD 提交失败');
                      return;
                    }
                    setStatus('EMEVD mutation 已提交；正在重读…');
                    const reload = await window.soulforge.readEmevdDocument(selectedFile.sourceUri) as {
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
          {workspaceMode === 'msg' && (
            <>
              <p className="muted">
                {fmgLive
                  ? `实时 Bridge FMG${fmgSourceHash ? ` · hash ${fmgSourceHash.slice(0, 12)}…` : ''}`
                  : '演示条目（未选中可解析 FMG 或读取失败）'}
              </p>
              <FmgWorkbenchPanel
                key={`${selectedFile?.sourceUri ?? 'demo'}:${fmgLive ? 'live' : 'demo'}`}
                resourceUri={selectedFile?.sourceUri ?? 'file://msg/demo.fmg'}
                entries={fmgEntries}
                onMutation={(mutation) => {
                  void (async () => {
                    if (!fmgLive || !fmgSourceHash || !selectedFile) {
                      setStatus('FMG mutation 仅在演示模式产生 UI 状态；提交须经实时文档 + 补丁引擎。');
                      return;
                    }
                    if (typeof window.soulforge.applyFmgMutation !== 'function') {
                      setStatus('当前预加载未暴露 applyFmgMutation。');
                      return;
                    }
                    setStatus('正在经 Bridge/补丁引擎提交 FMG mutation…');
                    const result = await window.soulforge.applyFmgMutation(
                      selectedFile.sourceUri,
                      fmgSourceHash,
                      {
                        kind: mutation.kind === 'fmg_entry_delete' ? 'delete' : 'upsert',
                        id: mutation.id,
                        ...(mutation.text !== undefined ? { text: mutation.text } : {})
                      }
                    );
                    if (!result.ok) {
                      setStatus(result.diagnostics?.[0]?.message ?? 'FMG 提交失败');
                      return;
                    }
                    const reload = await window.soulforge.readFmgDocument(selectedFile.sourceUri) as {
                      ok?: boolean;
                      data?: {
                        sourceHash?: string;
                        entries?: Array<{ id: number; text: string }>;
                      } | null;
                    };
                    if (reload?.ok && reload.data?.entries) {
                      setFmgEntries(reload.data.entries.map((e) => ({ id: e.id, text: e.text })));
                      setFmgSourceHash(reload.data.sourceHash ?? null);
                      setStatus('FMG 已提交并重读。');
                    } else {
                      setStatus('FMG 已提交，但重读失败。');
                    }
                    await refreshOperationHistory();
                  })();
                }}
              />
            </>
          )}
          {workspaceMode === 'param' && (
            <>
              <p className="muted">
                {paramLive
                  ? `实时 Bridge PARAM${paramSourceHash ? ` · hash ${paramSourceHash.slice(0, 12)}…` : ''}`
                  : '演示行（未选中可解析 PARAM 或读取失败）'}
              </p>
              <ParamTablePanel
                key={`${selectedFile?.sourceUri ?? 'demo'}:${paramLive ? 'live' : 'demo'}`}
                typeName={paramTypeName}
                resourceUri={selectedFile?.sourceUri ?? 'file://param/demo.param'}
                rows={paramRows}
                onMutation={(mutation) => {
                  void (async () => {
                    if (!paramLive || !paramSourceHash || !selectedFile) {
                      setStatus('PARAM mutation 仅在演示模式产生 UI 状态；提交须经实时文档 + 补丁引擎。');
                      return;
                    }
                    if (typeof window.soulforge.applyParamMutation !== 'function') {
                      setStatus('当前预加载未暴露 applyParamMutation。');
                      return;
                    }
                    if (mutation.kind === 'param_row_delete') {
                      setStatus('正在删除 PARAM 行…');
                      const result = await window.soulforge.applyParamMutation(
                        selectedFile.sourceUri,
                        paramSourceHash,
                        { kind: 'delete', id: mutation.id }
                      );
                      if (!result.ok) {
                        setStatus(result.diagnostics?.[0]?.message ?? 'PARAM 删除失败');
                        return;
                      }
                    } else {
                      // Duplicate uses sourceId payload; plain upsert uses mutation.id payload.
                      const payload =
                        paramRowPayloads.get(mutation.id)
                        ?? (mutation.sourceId !== undefined
                          ? paramRowPayloads.get(mutation.sourceId)
                          : undefined);
                      if (!payload) {
                        setStatus('缺少 row dataBase64，无法 upsert（演示/截断行）。');
                        return;
                      }
                      setStatus(
                        mutation.sourceId !== undefined
                          ? `正在复制 PARAM 行 ${mutation.sourceId} → ${mutation.id}…`
                          : '正在提交 PARAM 行 upsert…'
                      );
                      const result = await window.soulforge.applyParamMutation(
                        selectedFile.sourceUri,
                        paramSourceHash,
                        { kind: 'upsert', id: mutation.id, dataBase64: payload }
                      );
                      if (!result.ok) {
                        setStatus(result.diagnostics?.[0]?.message ?? 'PARAM upsert 失败');
                        return;
                      }
                    }
                    const reload = await window.soulforge.readParamDocument(selectedFile.sourceUri) as {
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
                      setStatus('PARAM 已提交并重读。');
                    } else {
                      setStatus('PARAM 已提交，但重读失败。');
                    }
                    await refreshOperationHistory();
                  })();
                }}
              />
              <ParamDefPanel
                typeName={paramLive ? `${paramTypeName}（用户派生 def 待绑定）` : 'DEMO_PARAM_ST'}
                rowDataSize={16}
                origin="fixture"
                fields={[
                  { id: 'f_id', name: 'idHint', type: 's32', offset: 0, size: 4, valuePreview: '42' },
                  { id: 'f_hp', name: 'hp', type: 'u16', offset: 4, size: 2, valuePreview: '100' },
                  { id: 'f_flag', name: 'enabled', type: 'bool', offset: 6, size: 1, valuePreview: 'true' },
                  { id: 'f_rate', name: 'rate', type: 'f32', offset: 8, size: 4, valuePreview: '1.5' }
                ]}
                onFieldChange={() => setStatus('paramdef 字段 mutation 已产生；提交须经补丁引擎，不得写官方适配包。')}
              />
            </>
          )}
          {workspaceMode === 'settings' && <ModelServiceSettingsPanel />}
          {workspaceMode === 'ops' && (
            <WorkbenchOpsPanel
              jobs={[
                {
                  id: 'demo-job-1',
                  title: '索引工作区',
                  status: operationHistory.length > 0 ? 'completed' : 'queued',
                  progressCurrent: operationHistory.length > 0 ? 1 : 0,
                  progressTotal: 1,
                  progressMessage: '等待主进程任务队列接线'
                }
              ]}
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
                void window.soulforge.rollbackOperation(opId).then(() => {
                  setStatus(`已请求回滚 ${opId}`);
                }).catch((error: unknown) => {
                  setStatus(error instanceof Error ? error.message : '回滚失败');
                });
              }}
            />
          )}
          {preview?.previewKind === 'empty' && <p className="muted">空文件。</p>}
          {preview?.previewKind === 'failed' && <p className="danger">预览失败。</p>}
          {preview?.truncated && <p className="muted">预览只读取文件前缀，确保大型 DCX/BND 等二进制文件也能安全打开。</p>}
        </section>

        <aside className="ai-pane">
          <div className="ai-pane-header">
            <div>
              <h2>AI 侧边栏</h2>
              <p>计划优先，证据优先，写入必须经过 Patch Engine。</p>
            </div>
            <span className={aiProvider === 'mock' ? 'provider-pill ready' : 'provider-pill'}>
              {aiProvider === 'mock' ? '本地草稿' : '需要配置'}
            </span>
          </div>

          <div className="ai-control-grid">
            <label>
              模型服务
              <select value={aiProvider} onChange={(event) => setAiProvider(event.target.value as AiProvider)}>
                <option value="mock">本地计划草稿</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label>
              思考强度
              <select value={aiThinking} onChange={(event) => setAiThinking(event.target.value as AiThinkingLevel)}>
                <option value="fast">快速</option>
                <option value="normal">普通</option>
                <option value="deep">深入</option>
                <option value="extreme">极致</option>
              </select>
            </label>
            <label>
              权限模式
              <select value={aiMode} disabled title="P0 安全收口期间由主进程锁定为计划模式">
                <option value="plan">计划模式</option>
              </select>
            </label>
          </div>

          <div className="context-card ai-context-card">
            <strong>当前上下文</strong>
            <span>{selectedFile?.sourceUri ?? '未选择资源'}</span>
            {analysis && <span>引用：高 {analysis.referenceStats.high} / 中 {analysis.referenceStats.medium} / 低 {analysis.referenceStats.low}</span>}
            <span>{diagnostics.length ? `范围内有 ${diagnostics.length} 条诊断` : '范围内没有诊断'}</span>
          </div>

          <label className="ai-prompt-box">
            目标
            <textarea
              value={aiPrompt}
              onChange={(event) => setAiPrompt(event.target.value)}
              placeholder="例如：解释当前事件引用了哪些文本和参数，并提出安全修改计划。"
            />
          </label>
          <button className="primary-action" type="button" onClick={() => void buildAiDraft()}>生成计划草稿</button>

          {aiDraft && (
            <section className="ai-draft-card">
              <div className="ai-draft-title">
                <strong>{aiDraft.title}</strong>
                <span>{modelServiceLabel(aiDraft.provider)} / {thinkingLabel(aiDraft.thinking)} / {permissionModeLabel(aiDraft.mode)}</span>
              </div>
              <p>{aiDraft.summary}</p>

              <div className="ai-mini-section">
                <strong>建议工具</strong>
                {aiDraft.recommendedTools.length === 0 && <span className="muted">暂无建议。</span>}
                {aiDraft.recommendedTools.map((tool) => (
                  <span key={tool.toolName} className="tool-chip" title={tool.reason}>{tool.toolName}</span>
                ))}
              </div>

              <div className="ai-mini-section">
                <strong>下一步</strong>
                <ol>
                  {aiDraft.nextActions.map((action) => <li key={action}>{action}</li>)}
                </ol>
              </div>

              <details>
                <summary>提示词预览</summary>
                <pre className="tool-output">{aiDraft.promptPreview}</pre>
              </details>
            </section>
          )}

          <div className="tool-panel">
            <strong>安全工具</strong>
            <div className="tool-group">
              <small>读取 / 分析</small>
              <div className="tool-list">
                {groupedTools.read.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)}
              </div>
            </div>
            <div className="tool-group">
              <small>提案 / 验证</small>
              <div className="tool-list">
                {groupedTools.plan.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)}
              </div>
            </div>
            <div className="tool-group">
              <small>提交 / 回滚</small>
              <div className="tool-list">
                {groupedTools.write.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)}
              </div>
            </div>
            <div className="tool-row">
              <input value={toolQuery} onChange={(event) => setToolQuery(event.target.value)} placeholder="输入资源搜索条件" />
              <button type="button" onClick={() => void runToolSearch()}>运行</button>
            </div>
            <div className="tool-row">
              <input value={eventUri} onChange={(event) => setEventUri(event.target.value)} placeholder="event://..." />
              <button type="button" onClick={() => void explainEvent()}>解释事件</button>
            </div>
          </div>

          {analysis && (
            <div className="context-card">
              <strong>证据索引</strong>
              <span>已解析：{analysis.parsedFiles}</span>
              <span>已检查：{analysis.inspectedFiles}</span>
              <span>引用：高 {analysis.referenceStats.high} / 中 {analysis.referenceStats.medium} / 低 {analysis.referenceStats.low}</span>
            </div>
          )}

          <section className="operation-history-panel">
            <div className="operation-history-header">
              <strong>操作历史</strong>
              <button type="button" className="ghost-action" disabled={!workspace} onClick={() => void refreshOperationHistory()}>
                刷新
              </button>
            </div>
            {!workspace && <p className="muted">打开工作区并完成至少一次补丁提交后可在此回滚。</p>}
            {workspace && operationHistory.length === 0 && (
              <p className="muted">尚无已记录操作。保存文本资源后会写入持久操作日志。</p>
            )}
            <div className="operation-history-list">
              {operationHistory.map((entry) => (
                <div key={entry.opId} className="operation-history-item">
                  <div className="operation-history-meta">
                    <strong title={entry.opId}>{entry.title}</strong>
                    <span className={`op-status op-status-${entry.status}`}>{operationStatusLabel(entry.status)}</span>
                    <small>
                      {entry.fileCount} 个文件 · {entry.committedAt ?? entry.createdAt}
                    </small>
                    <small className="muted" title={entry.changedPaths.join('\n')}>
                      {entry.changedPaths[0] ? shortenPath(entry.changedPaths[0]) : '—'}
                      {entry.changedPaths.length > 1 ? ` +${entry.changedPaths.length - 1}` : ''}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={entry.status !== 'committed'}
                    onClick={() => void rollbackOp(entry.opId)}
                  >
                    回滚
                  </button>
                </div>
              ))}
            </div>
          </section>

          {toolOutput && <pre className="tool-output">{JSON.stringify(toolOutput, null, 2)}</pre>}
        </aside>
      </section>

      <footer className="status-bar">
        <span>{status}</span>
        <span>{diagnostics.length ? `${diagnostics.length} 条诊断` : '没有诊断'}</span>
      </footer>
    </main>
  );
}

function MsgTableEditor({
  rows,
  onAdd,
  onRemove,
  onUpdate
}: {
  rows: EditableMsgRow[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<EditableMsgRow>) => void;
}): ReactElement {
  return (
    <section className="msg-table-editor">
      <div className="msg-table-toolbar">
        <strong>FMG 文本表</strong>
        <button type="button" onClick={onAdd}>新增文本</button>
      </div>
      <div className="msg-table-grid msg-table-header">
        <span>ID</span>
        <span>Text</span>
        <span>Action</span>
      </div>
      {rows.map((row, index) => (
        <div className="msg-table-grid" key={`${row.textId}-${index}`}>
          <input
            value={row.textId}
            onChange={(event) => onUpdate(index, { textId: event.target.value })}
            aria-label="text id"
          />
          <textarea
            value={row.text}
            onChange={(event) => onUpdate(index, { text: event.target.value })}
            aria-label="text value"
          />
          <button type="button" onClick={() => onRemove(index)}>删除</button>
        </div>
      ))}
      <p className="muted">表格编辑会同步生成规范 TSV 文本；保存仍走 Patch Engine，并会自动备份原文件。</p>
    </section>
  );
}

function StructuredPreviewCard({ preview }: { preview: ResourceStructuredPreview }): ReactElement {
  const eventCount = preview.events?.reduce((total, eventExport) => total + eventExport.events.length, 0) ?? 0;
  const instructionCount = preview.events?.reduce(
    (total, eventExport) => total + eventExport.events.reduce((sum, event) => sum + event.instructions.length, 0),
    0
  ) ?? 0;
  const msgCount = preview.msgs?.reduce((total, msgExport) => total + msgExport.entries.length, 0) ?? 0;
  const paramRows = collectParamRows(preview.params);
  const paramFieldCount = paramRows.reduce((total, row) => total + (row.fields?.length ?? 0), 0);
  const mapEntities = collectMapEntities(preview.maps);
  const mapRegions = preview.maps?.flatMap((mapExport) => mapExport.regions) ?? [];

  return (
    <section className="structured-preview-card">
      <div className="structured-preview-title">
        <strong>Structured preview</strong>
        <span>{preview.parser} / {preview.status}</span>
      </div>
      <p>{preview.summary}</p>
      <div className="structured-preview-grid">
        <span>kind: {preview.kind}</span>
        <span>editable: {preview.editable ? 'yes' : 'no'}</span>
        <span>events: {eventCount}</span>
        <span>instructions: {instructionCount}</span>
        <span>texts: {msgCount}</span>
        <span>param rows: {paramRows.length}</span>
        <span>param fields: {paramFieldCount}</span>
        <span>map entities: {mapEntities.length}</span>
        <span>map regions: {mapRegions.length}</span>
        <span>diagnostics: {preview.diagnostics.length}</span>
      </div>
      <EditCapabilityStrip preview={preview} />
      {preview.events && preview.events.length > 0 && (
        <details>
          <summary>Events</summary>
          <div className="structured-symbol-list">
            {preview.events.flatMap((eventExport) => eventExport.events).slice(0, 24).map((event) => (
              <span key={event.uri}>{event.eventId}{event.name ? ` · ${event.name}` : ''} · {event.instructions.length} instr</span>
            ))}
          </div>
        </details>
      )}
      {paramRows.length > 0 && (
        <details>
          <summary>Param rows</summary>
          <div className="structured-symbol-list">
            {paramRows.slice(0, 32).map((row) => (
              <span key={row.uri} title={formatParamFieldPreview(row.fields)}>
                {row.paramName} · {row.rowId}{row.rowName ? ` · ${row.rowName}` : ''} · {row.fields?.length ?? 0} field(s)
              </span>
            ))}
          </div>
        </details>
      )}
      {mapEntities.length > 0 && (
        <details>
          <summary>Map entities</summary>
          <div className="structured-symbol-list">
            {mapEntities.slice(0, 32).map((entity) => (
              <span key={entity.uri} title={formatVectorPreview(entity.position)}>
                {entity.mapId} · {entity.entityId ?? 'candidate'} · {entity.kind} · {entity.name}{entity.model ? ` · ${entity.model}` : ''}
              </span>
            ))}
          </div>
        </details>
      )}
      {mapRegions.length > 0 && (
        <details>
          <summary>Map regions</summary>
          <div className="structured-symbol-list">
            {mapRegions.slice(0, 32).map((region) => (
              <span key={region.uri} title={formatVectorPreview(region.position)}>
                {region.mapId} · {region.entityId ?? 'candidate'} · {region.name}{region.shape ? ` · ${region.shape}` : ''}
              </span>
            ))}
          </div>
        </details>
      )}
      {preview.msgs && preview.msgs.length > 0 && (
        <details>
          <summary>Text entries</summary>
          <div className="structured-symbol-list">
            {preview.msgs.flatMap((msgExport) => msgExport.entries).slice(0, 24).map((entry) => (
              <span key={entry.uri}>{entry.textId} · {entry.text.slice(0, 80)}</span>
            ))}
          </div>
        </details>
      )}
      {preview.container && <ContainerReadCard container={preview.container} />}
    </section>
  );
}

function EditCapabilityStrip({ preview }: { preview: ResourceStructuredPreview }): ReactElement {
  const hasNativeSemanticData = Boolean(preview.events?.length || preview.maps?.length || preview.params?.length || preview.msgs?.length);
  const hasContainerData = Boolean(preview.container);

  return (
    <div className="edit-capability-strip" aria-label="edit capability">
      <span className={preview.editable ? 'capability-pill ready' : 'capability-pill blocked'}>
        text: {preview.editable ? 'editable via Patch Engine' : 'read-only'}
      </span>
      <span className="capability-pill blocked">
        native: {hasNativeSemanticData ? 'parsed preview only' : 'no writer contract'}
      </span>
      <span className="capability-pill blocked">
        container: {hasContainerData ? 'child replacement disabled' : 'not a container preview'}
      </span>
    </div>
  );
}

function collectParamRows(params: ParamExport[] | undefined): ParamExport['rows'] {
  return params?.flatMap((paramExport) => paramExport.rows) ?? [];
}

function collectMapEntities(maps: MapExport[] | undefined): MapExport['entities'] {
  return maps?.flatMap((mapExport) => mapExport.entities) ?? [];
}

function formatParamFieldPreview(fields: ParamExport['rows'][number]['fields']): string {
  if (!fields || fields.length === 0) return 'No typed fields are available yet.';
  return fields.slice(0, 6).map((field) => `${field.name}=${String(field.value)}`).join(', ');
}

function formatVectorPreview(value: [number, number, number] | undefined): string {
  return value ? `position=${value.map((item) => item.toFixed(3)).join(', ')}` : 'No transform evidence is available yet.';
}

function ContainerReadCard({ container }: { container: ContainerReadSummary }): ReactElement {
  const childHints = container.hints.filter((hint) => hint.kind === 'binderChildCandidate' || hint.kind === 'pathHint');
  const confirmedBinderHints = container.hints.filter((hint) => hint.kind === 'binderChildTable' || hint.kind === 'dcxNestedBinderChildTable');
  const nestedHints = container.hints.filter((hint) => hint.kind === 'nestedMagicCandidate');

  return (
    <section className="container-read-card">
      <div className="container-read-title">
        <strong>Container read</strong>
        <span>{container.rootFormat ?? 'unknown'}</span>
      </div>
      <div className="container-read-grid">
        <span>file: {container.fileName ?? 'unknown'}</span>
        <span>size: {container.fileSize !== undefined ? `${(container.fileSize / 1024).toFixed(1)} KB` : 'unknown'}</span>
        <span>paths: {container.pathHintCount}</span>
        <span>candidate children: {container.binderChildCandidateCount}</span>
        <span>confirmed tables: {(container.binderChildTableCount ?? 0) + (container.dcxNestedBinderChildTableCount ?? 0)}</span>
        <span>nested magic: {container.nestedMagicCandidateCount}</span>
        <span>ext: {container.extensionChain.join(' ') || 'none'}</span>
      </div>
      {confirmedBinderHints.length > 0 && <BinderChildTable hints={confirmedBinderHints} />}
      {childHints.length > 0 && <ContainerHintList title="Path / child candidates" hints={childHints} />}
      {nestedHints.length > 0 && <ContainerHintList title="Nested format candidates" hints={nestedHints} />}
      <p className="muted">high confidence 的 BND 子表仍只代表已验证的 SoulForge fixture；真实原生 BND 写回前还需要 native fixture 和 writer contract。</p>
    </section>
  );
}

interface BinderChildRow {
  id?: number;
  name?: string;
  resourceKind?: string;
  offset?: number;
  packedSize?: number;
  unpackedSize?: number;
}

function BinderChildTable({ hints }: { hints: ContainerReadHint[] }): ReactElement {
  const rows = hints.flatMap((hint) => extractBinderChildRows(hint.raw));

  if (rows.length === 0) {
    return <ContainerHintList title="Confirmed binder child tables" hints={hints} />;
  }

  return (
    <details>
      <summary>Confirmed binder child rows</summary>
      <div className="binder-child-table" role="table" aria-label="confirmed binder child rows">
        <div className="binder-child-row binder-child-header" role="row">
          <span>ID</span>
          <span>Name</span>
          <span>Kind</span>
          <span>Offset</span>
          <span>Packed</span>
          <span>Unpacked</span>
        </div>
        {rows.slice(0, 80).map((row, index) => (
          <div className="binder-child-row" role="row" key={`${row.name ?? 'child'}-${row.id ?? index}-${index}`}>
            <span>{row.id ?? '—'}</span>
            <span title={row.name ?? ''}>{row.name ?? 'unknown'}</span>
            <span>{row.resourceKind ?? 'unknown'}</span>
            <span>{formatMaybeNumber(row.offset)}</span>
            <span>{formatMaybeNumber(row.packedSize)}</span>
            <span>{formatMaybeNumber(row.unpackedSize)}</span>
          </div>
        ))}
      </div>
      <p className="muted">子文件表是只读 inventory。替换 child、重打包和写回要等 BND writer contract。</p>
    </details>
  );
}

function extractBinderChildRows(raw: unknown): BinderChildRow[] {
  const record = asUiRecord(raw);
  const nestedData = asUiRecord(record.data ?? record.Data);
  const children = Array.isArray(record.children) ? record.children : Array.isArray(nestedData.children) ? nestedData.children : [];

  return children
    .map((child) => asBinderChildRow(child))
    .filter((child): child is BinderChildRow => child !== null);
}

function asBinderChildRow(value: unknown): BinderChildRow | null {
  const record = asUiRecord(value);
  const id = readFiniteNumber(record.id);
  const name = readString(record.name);
  const resourceKind = readString(record.resourceKind);
  const offset = readFiniteNumber(record.offset);
  const packedSize = readFiniteNumber(record.packedSize);
  const unpackedSize = readFiniteNumber(record.unpackedSize);

  if (id === undefined && !name && offset === undefined) return null;

  return {
    ...(id !== undefined ? { id } : {}),
    ...(name ? { name } : {}),
    ...(resourceKind ? { resourceKind } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(packedSize !== undefined ? { packedSize } : {}),
    ...(unpackedSize !== undefined ? { unpackedSize } : {})
  };
}

function asUiRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatMaybeNumber(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

function ContainerHintList({ title, hints }: { title: string; hints: ContainerReadHint[] }): ReactElement {
  return (
    <details>
      <summary>{title}</summary>
      <div className="container-hint-list">
        {hints.slice(0, 40).map((hint, index) => (
          <span key={`${hint.kind}-${hint.offset}-${index}`} title={JSON.stringify(hint.raw ?? {})}>
            {hint.offset.toString(16).padStart(8, '0')} · {hint.label} · {hint.resourceKind ?? hint.rootFormat ?? 'unknown'} · {hint.confidence}
          </span>
        ))}
      </div>
    </details>
  );
}

function extractMsgRows(preview: RendererResourcePreview | null | undefined): EditableMsgRow[] {
  return preview?.structuredPreview?.msgs
    ?.flatMap((msgExport) => msgExport.entries.map((entry) => msgEntryToEditableRow(entry, msgExport.category)))
    ?? [];
}

function msgEntryToEditableRow(entry: TextEntrySymbol, fallbackCategory?: string): EditableMsgRow {
  const category = entry.category ?? fallbackCategory;
  return {
    textId: String(entry.textId),
    text: entry.text,
    ...(category ? { category } : {})
  };
}

function serializeMsgRowsToTsv(rows: EditableMsgRow[]): string {
  return `${rows.map((row) => `${sanitizeTextId(row.textId)}\t${escapeTsvText(row.text)}`).join('\n')}\n`;
}

function sanitizeTextId(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : '0';
}

function escapeTsvText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', '\\n').replaceAll('\t', ' ');
}

function nextMsgId(rows: EditableMsgRow[]): string {
  const maxId = rows.reduce((max, row) => {
    const id = Number.parseInt(row.textId, 10);
    return Number.isFinite(id) ? Math.max(max, id) : max;
  }, 0);
  return String(maxId + 1);
}

interface NativeInspectionData {
  file?: {
    fileName?: string;
    size?: number;
    extension?: string;
    extensionChain?: string[];
  };
  resourceKind?: string;
  rootFormat?: string;
  parseStatus?: string;
  layers?: NativeInspectionLayer[];
  evidence?: NativeInspectionEvidence[];
  nextSteps?: string[];
}

interface NativeInspectionLayer {
  format?: string;
  offset?: number;
  length?: number;
  confidence?: string;
  metadata?: unknown;
}

interface NativeInspectionEvidence {
  kind?: string;
  offset?: number;
  value?: unknown;
  confidence?: string;
}

function NativeInspectionCard({ inspection }: { inspection: RendererBridgeResult<unknown> }): ReactElement {
  const data = asNativeInspectionData(inspection.data);
  const layers = data?.layers ?? [];
  const evidence = data?.evidence ?? [];
  const nextSteps = data?.nextSteps ?? [];

  return (
    <section className="native-inspection-card">
      <div className="native-inspection-title">
        <strong>原生格式检查</strong>
        <span>{inspection.parseStatus}</span>
      </div>
      <div className="native-inspection-grid">
        <span>资源类型：{data?.resourceKind ?? inspection.resourceKind}</span>
        <span>根格式：{data?.rootFormat ?? '未知'}</span>
        <span>容器层级：{layers.length}</span>
        <span>证据：{evidence.length}</span>
      </div>
      {layers.length > 0 && (
        <div className="native-chip-row">
          {layers.slice(0, 6).map((layer, index) => (
            <span key={`${layer.format ?? 'layer'}-${index}`} title={describeLayer(layer)}>
              {layer.format ?? '未知'} · {layer.confidence ?? '未知'}
            </span>
          ))}
        </div>
      )}
      {evidence.length > 0 && (
        <details>
          <summary>证据线索</summary>
          <ul className="native-evidence-list">
            {evidence.slice(0, 12).map((item, index) => (
              <li key={`${item.kind ?? 'evidence'}-${index}`}>
                <strong>{item.kind ?? '未知'}</strong>
                <span>offset={item.offset ?? 0}</span>
                <span>置信等级={item.confidence ?? '未知'}</span>
                <code>{summarizeEvidenceValue(item.value)}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {nextSteps.length > 0 && (
        <details>
          <summary>Bridge notes</summary>
          <ol>
            {nextSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </details>
      )}
    </section>
  );
}

function asNativeInspectionData(value: unknown): NativeInspectionData | null {
  if (!value || typeof value !== 'object') return null;
  return value as NativeInspectionData;
}

function describeLayer(layer: NativeInspectionLayer): string {
  const offset = layer.offset ?? 0;
  const length = layer.length ?? 0;
  return `offset=${offset}, length=${length}`;
}

function summarizeEvidenceValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    const json = JSON.stringify(value);
    return json.length > 220 ? `${json.slice(0, 217)}...` : json;
  } catch {
    return '[unserializable evidence]';
  }
}

function groupToolsByPermission(tools: ToolDescriptor[]): Record<'read' | 'plan' | 'write', ToolDescriptor[]> {
  const levelOf = (tool: ToolDescriptor): string => tool.permissionLevel ?? tool.permission;
  return {
    read: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'read' || level === 'analyze';
    }),
    plan: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'propose' || level === 'stage' || level === 'validate' || level === 'plan';
    }),
    write: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'commit' || level === 'rollback' || level === 'write';
    })
  };
}

function isResourceKindMode(mode: WorkspaceMode): mode is ResourceKind {
  return mode !== 'files' && mode !== 'ai' && mode !== 'settings' && mode !== 'ops';
}

function workspaceModeLabel(mode: WorkspaceMode): string {
  return WORKSPACE_MODES.find((item) => item.id === mode)?.label ?? mode;
}

function modelServiceLabel(provider: AiProvider): string {
  if (provider === 'mock') return '本地计划草稿';
  return provider === 'openai' ? 'OpenAI 模型服务' : 'Anthropic 模型服务';
}

function thinkingLabel(level: AiThinkingLevel): string {
  return ({ fast: '快速', normal: '普通', deep: '深入', extreme: '极致' } as const)[level];
}

function permissionModeLabel(mode: AiPermissionMode): string {
  return ({ plan: '计划模式', normal: '普通模式', fullPermission: '完全权限' } as const)[mode];
}

function operationStatusLabel(status: string): string {
  return ({
    planned: '已计划',
    pending: '待处理',
    staged: '已暂存',
    validated: '已验证',
    committed: '已提交',
    rolled_back: '已回滚',
    failed: '失败',
    recovery_required: '需要恢复'
  } as Record<string, string>)[status] ?? status;
}

function filterFilesForMode(
  files: RendererIndexedFile[],
  mode: WorkspaceMode,
  query: string
): RendererIndexedFile[] {
  const normalized = query.trim().toLowerCase();
  return files.filter((file) => {
    if (isResourceKindMode(mode) && file.resourceKind !== mode) return false;
    if (!normalized) return true;
    return file.relativePath.toLowerCase().includes(normalized)
      || file.resourceKind.toLowerCase().includes(normalized)
      || file.formatLabel.toLowerCase().includes(normalized);
  });
}

function shortenPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join('/')}`;
}
