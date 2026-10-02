import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolDescriptor } from '@soulforge/core';
import type { AnalyzeWorkspaceSummary, DirectorySelection, RendererWorkspaceScanResult, RendererWorkspaceSession } from '../../../main/ipc.js';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
export type WorkspaceBridge = Pick<NonNullable<RendererRuntime['bridge']>, 'scanWorkspace' | 'lastWorkspaceSelection' | 'openWorkspaceDialog' | 'openBaseDialog' | 'remountBase' | 'analyzeWorkspace' | 'searchResources'>;
export interface WorkspaceOptions {
  bridge: WorkspaceBridge | null;
  setStatus(message: string): void;
  pushToast(message: string, kind?: 'ok' | 'warn'): void;
  announceDesktopOnly(operation: string): void;
  onWorkspaceInstalled(result: RendererWorkspaceScanResult): void;
  onWorkspaceRemounted(result: Awaited<ReturnType<WorkspaceBridge['remountBase']>>): void;
  onSearchActivated(): void;
  onAnalysisLoaded(analysis: AnalyzeWorkspaceSummary): void;
  refreshOperationHistory(): Promise<void>;
}
export function useWorkspaceController(options: WorkspaceOptions) {
  const { bridge, setStatus, pushToast, announceDesktopOnly, onWorkspaceInstalled, onWorkspaceRemounted, onSearchActivated, onAnalysisLoaded, refreshOperationHistory } = options;
  const [workspace, setWorkspace] = useState<RendererWorkspaceScanResult | null>(null);
  const [sessionMeta, setSessionMeta] = useState<RendererWorkspaceSession | null>(null);
  const [baseRootChoice, setBaseRootChoice] = useState<DirectorySelection | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeWorkspaceSummary | null>(null);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [files, setFiles] = useState<RendererIndexedFile[]>([]);
  const [allFiles, setAllFiles] = useState<RendererIndexedFile[]>([]);
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const mountGenerationRef = useRef(0);
  const manualMountRequestedRef = useRef(false);
  const searchRequestRef = useRef(0);
  const baseRemountRequestRef = useRef(0);
  const bridgeOwner = useMemo(() => ({}), [bridge]);
  const lifetimeRef = useRef({ mounted: false, bridgeOwner });
  useEffect(() => {
    lifetimeRef.current = { mounted: true, bridgeOwner };
    return () => { lifetimeRef.current.mounted = false; mountGenerationRef.current++; };
  }, [bridgeOwner]);
  function ownsBridge(): boolean {
    return lifetimeRef.current.mounted && lifetimeRef.current.bridgeOwner === bridgeOwner;
  }
  function ownsMount(generation: number): boolean {
    return ownsBridge() && mountGenerationRef.current === generation;
  }
  async function mountWorkspace(
    overlaySelectionId: string,
    baseSelectionId: string | undefined,
    origin: 'manual' | 'restored'
  ): Promise<void> {
    if (!bridge || !ownsBridge()) return;
    if (origin === 'restored' && (workspaceRef.current !== null || manualMountRequestedRef.current)) return;
    if (origin === 'manual') manualMountRequestedRef.current = true;
    const generation = ++mountGenerationRef.current;
    try {
      setStatus(origin === 'restored' ? '正在恢复上次的工作区...' : '正在扫描工作区...');
      const result = await bridge.scanWorkspace({
        overlaySelectionId,
        ...(baseSelectionId ? { baseSelectionId } : {})
      });
      if (!ownsMount(generation)) return;
      setWorkspace(result);
      setSessionMeta(result.session ?? null);
      setAllFiles(result.files);
      setFiles(result.files);
      setAnalysis(null);
      onWorkspaceInstalled(result);
      const baseLabel = result.session.baseMounted
        ? ' · 已挂载只读原版游戏目录'
        : ' · 未挂载原版游戏目录';
      setBaseRootChoice(null);
      const restoredPrefix = origin === 'restored' ? '已恢复上次的工作区：' : '';
      setStatus(`${restoredPrefix}已索引并打开 ${result.files.length} 个文件${baseLabel}`);
      const baseToastSuffix = result.session.baseMounted ? '（已挂载原版游戏目录）' : '';
      pushToast(
        origin === 'restored'
          ? `已恢复 Mod 工作区「${result.workspaceLabel}」，共加载 ${result.files.length} 个文件${baseToastSuffix}`
          : `已成功选择并打开 Mod 工作区「${result.workspaceLabel}」，共加载 ${result.files.length} 个文件${baseToastSuffix}`,
        'ok'
      );

      // 后台静默构建深度分析与证据索引，不阻断主工作台展现与窗口交互
      void (async () => {
        try {
          const nextAnalysis = await bridge.analyzeWorkspace();
          if (!ownsMount(generation)) return;
          setAnalysis(nextAnalysis);
          setTools(nextAnalysis?.tools ?? []);
          onAnalysisLoaded(nextAnalysis);
          await refreshOperationHistory();
          if (!ownsMount(generation)) return;
          const parsed = nextAnalysis?.parsedFiles ?? 0;
          const inspected = nextAnalysis?.inspectedFiles ?? 0;
          setStatus(`${restoredPrefix}已就绪：已索引 ${result.files.length} 个文件，解析 ${parsed} 个文本/资源${baseLabel}`);
          pushToast(
            `工作区符号与数据索引构建完成（已解析 ${parsed} 个，已检查 ${inspected} 个）`,
            'ok'
          );
        } catch {
          // 后台分析静默降级
        }
      })();
    } catch (error) {
      if (!ownsMount(generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      /*
       * 自动恢复失败不弹 toast（S12 后无状态栏，也不写底栏）。
       *
       * 那条路径没有用户动作在等结果 —— 启动时弹一个「打开工作区失败」的提示
       * 会让人以为自己做错了什么，而实际原因通常是上次的目录被移动或删除了。
       * 手动打开失败仍然弹：那时用户在等反馈。
       */
      setStatus(origin === 'restored'
        ? `上次的工作区已无法打开（${message}），请重新选择。`
        : `打开工作区失败：${message}`);
      if (origin === 'manual') pushToast(`打开工作区失败：${message}`, 'warn');
    }
  }
  async function openWorkspace(): Promise<void> {
    if (!ownsBridge()) return;
    if (!bridge) {
      announceDesktopOnly('打开 Mod 工作区');
      return;
    }
    const workspaceSelection = await bridge.openWorkspaceDialog();
    // 用户取消目录对话框：安静返回，不显示错误。
    if (!workspaceSelection || !ownsBridge()) return;
    await mountWorkspace(
      workspaceSelection.selectionId,
      baseRootChoice?.selectionId,
      'manual'
    );
  }
  async function remountBase(baseSelection: DirectorySelection | null): Promise<boolean> {
    if (!bridge || !workspace || !ownsBridge() || workspaceRef.current !== workspace || typeof bridge.remountBase !== 'function') return false;
    const currentSessionId = workspace.workspaceSessionId;
    const generation = mountGenerationRef.current;
    const requestId = ++baseRemountRequestRef.current;
    const ownsRemount = () => ownsMount(generation) && baseRemountRequestRef.current === requestId
      && workspaceRef.current?.workspaceSessionId === currentSessionId;
    try {
      const result = await bridge.remountBase(baseSelection?.selectionId ?? null);
      if (!ownsRemount()) return false;
      setWorkspace((previous) =>
        previous && previous.workspaceSessionId === currentSessionId
          ? { ...previous, workspaceSessionId: result.workspaceSessionId, session: result.session }
          : previous
      );
      setSessionMeta(result.session);
      onWorkspaceRemounted(result);
      return true;
    } catch (error) {
      if (!ownsRemount()) return false;
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`重挂原版目录失败：${message}`);
      pushToast(`重挂原版目录失败：${message}`, 'warn');
      return false;
    }
  }
  async function chooseBaseDirectory(): Promise<void> {
    if (!ownsBridge()) return;
    if (!bridge) {
      announceDesktopOnly('选择原版目录');
      return;
    }
    const generation = mountGenerationRef.current;
    try {
      const selection = await bridge.openBaseDialog();
      if (!selection || !ownsMount(generation)) return;
      setBaseRootChoice(selection);
      if (workspace) {
        const published = await remountBase(selection);
        if (!published || !ownsMount(generation)) return;
        setStatus(`已挂载只读原版游戏目录：${selection.label}`);
      } else {
        setStatus(`已选择只读原版游戏目录：${selection.label}`);
      }
    } catch (error) {
      if (!ownsMount(generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`选择原版目录失败：${message}`);
      pushToast(`选择原版目录失败：${message}`, 'warn');
    }
  }
  async function clearBaseDirectory(): Promise<void> {
    if (!ownsBridge()) return;
    setBaseRootChoice(null);
    if (workspace) {
      // S22：清原版同样当场生效（同一 overlay 重挂一个不带 base 的 session）。
      const generation = mountGenerationRef.current;
      const published = await remountBase(null);
      if (!published || !ownsMount(generation)) return;
      setStatus('已卸载原版游戏目录（当前工作区保持打开）');
    } else {
      setStatus('已清除原版游戏目录选择');
    }
  }
  useEffect(() => {
    if (!bridge || typeof bridge.lastWorkspaceSelection !== 'function') return;
    let cancelled = false;
    void (async () => {
      try {
        const last = await bridge.lastWorkspaceSelection();
        if (cancelled || !last?.overlay) return;
        if (workspaceRef.current !== null || manualMountRequestedRef.current) return;
        await mountWorkspace(
          last.overlay.selectionId,
          last.base?.selectionId,
          'restored'
        );
      } catch {
        // 恢复失败静默：启动时没有用户动作在等结果，报错只会让人困惑。
        // 失败原因（若来自 scan）已由 mountWorkspace 记录。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  async function search(query: string): Promise<void> {
    if (!ownsBridge()) return;
    if (!bridge) {
      announceDesktopOnly('资源搜索');
      return;
    }
    const generation = mountGenerationRef.current;
    const requestId = ++searchRequestRef.current;
    const result = await bridge.searchResources(query);
    if (!ownsMount(generation) || searchRequestRef.current !== requestId) return;
    setAllFiles(result);
    setFiles(result);
    onSearchActivated();
    setStatus(`搜索返回 ${result.length} 个文件`);
  }
  return { workspace, sessionMeta, baseRootChoice, analysis, tools, files, allFiles, mountWorkspace, openWorkspace, chooseBaseDirectory, clearBaseDirectory, search };
}
export type WorkspaceController = ReturnType<typeof useWorkspaceController>;
