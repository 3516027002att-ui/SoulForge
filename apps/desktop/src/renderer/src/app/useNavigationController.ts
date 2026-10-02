import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { EDITOR_DOMAIN_IDS, type DomainSummary, type EditorDomainId } from '@soulforge/shared';
import type { RendererWorkspaceScanResult, TextCatalogResponse } from '../../../main/ipc.js';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import { findCatalogContainer, insufficientEvidence, resolveFmgJump, resolveParamJump,
  type ResourceJumpRequest, type ResourceJumpResult, type TextContainerRef } from '../emevd/eventSourceNavigate.js';
import { shouldLoadFmg, shouldLoadParam } from '../workbench/documentLoadGates.js';
import { buildDomainSummaries, domainLabel } from '../navigation/domainNavigation.js';
import { behaviorLibraryGroups, filesForDomain, libraryDisplayName, paramLibraryGroups,
  pickPreferredAnimation, pickPreferredParamContainer } from '../navigation/domainLibraries.js';
import { filterCommandPaletteResources, normalizeCommandSearchText } from '../navigation/commandPaletteSearch.js';
import { filterFilesForMode } from '../format/uiText.js';

export type SidebarView = 'explorer' | 'search' | 'staging' | 'audit' | 'settings';
export type CenterView = 'project' | 'resource' | 'operations' | 'settings';
export type NavigationBridge = Partial<Pick<NonNullable<RendererRuntime['bridge']>,
  'readTextCatalog' | 'readParamDocument' | 'readGparamDocument' | 'readFmgDocument'
  | 'readEmevdDocument' | 'readMsbDocument' | 'inspectContainerTree' | 'listScriptContainerEntriesPage'
  | 'readTaeDocument' | 'readEsdDocument' | 'readFlverDocument' | 'readTpfDocument' | 'readMtdDocument' | 'readFxrDocument'>>;
export interface NavigationOptions extends Pick<ResourceDocumentController,
  'selectFile' | 'switchToOpenTab' | 'clearResourceSelection' | 'clearResourcePreview'> {
  selectedFile: RendererIndexedFile | null;
  openTabs: readonly RendererIndexedFile[];
  editDirty: boolean;
  bridge: NavigationBridge | null;
  isBrowserPreview: boolean;
  workspace: RendererWorkspaceScanResult | null;
  files: readonly RendererIndexedFile[];
  allFiles: readonly RendererIndexedFile[];
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  cmdkOpen: boolean;
  cmdkQuery: string;
  setParamRevealRowId(rowId: number | null): void;
  setStatus(message: string): void;
  searchWorkspaceResources(query: string): Promise<void>;
}
export interface NavigationCommand { id: string; icon: string; label: string; hint?: string; run(): void }

export function shellUiStorageKey(workspaceSessionId: string | undefined,
  field: 'domain' | 'sourceUri' | 'sidebarCollapsed'): string {
  return `soulforge.ui.shell.v1.${workspaceSessionId ?? 'preview'}.${field}`;
}

/** Navigation coordinates existing document resets and reveal setters; all native reads/writes stay with their owners. */
export function useNavigationController(options: NavigationOptions) {
  const { bridge, workspace } = options;
  const portsRef = useRef(options); portsRef.current = options;
  const [query, setQuery] = useState('');
  const [activeDomain, setActiveDomain] = useState<EditorDomainId>('project');
  const [centerView, setCenterView] = useState<CenterView>('project');
  const [bnd4Forced, setBnd4Forced] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('explorer');
  const [textCatalog, setTextCatalog] = useState<TextCatalogResponse | null>(null);
  const [fmgRevealRequest, setFmgRevealRequest] = useState<{ tableId: string; entryId: number } | null>(null);
  const catalogRef = useRef<TextCatalogResponse | null>(null);
  const jumpRequestRef = useRef(0);
  const lifetimeRef = useRef({ mounted: false, bridge, workspace });
  const invalidateJump = useCallback(() => { jumpRequestRef.current++; }, []);
  // Stable reset is registered in the existing FMG reset action, before any destination reveal.
  const resetNavigationTextState = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    invalidateJump(); catalogRef.current = null; setTextCatalog(null); setFmgRevealRequest(null);
  }, [invalidateJump]);
  useEffect(() => {
    lifetimeRef.current = { mounted: true, bridge, workspace };
    resetNavigationTextState();
    return () => { lifetimeRef.current.mounted = false; invalidateJump(); };
  }, [bridge, workspace, invalidateJump, resetNavigationTextState]);
  const ownsContext = useCallback(() => lifetimeRef.current.mounted
    && lifetimeRef.current.bridge === bridge && lifetimeRef.current.workspace === workspace
    && portsRef.current.bridge === bridge && portsRef.current.workspace === workspace, [bridge, workspace]);

  // Resource selection invokes the existing reset registry first, then this synchronous shell callback.
  const onResourceSelectionActivated = useCallback(() => {
    if (!lifetimeRef.current.mounted) return;
    invalidateJump(); setBnd4Forced(false); setCenterView('resource');
  }, [invalidateJump]);
  const clearFmgRevealRequest = useCallback(() => {
    if (lifetimeRef.current.mounted) setFmgRevealRequest(null);
  }, []);

  useEffect(() => {
    if (!workspace) return;
    try {
      const sessionId = workspace.workspaceSessionId;
      if (activeDomain !== 'project') window.localStorage.setItem(shellUiStorageKey(sessionId, 'domain'), activeDomain);
      window.localStorage.setItem(shellUiStorageKey(sessionId, 'sourceUri'), options.selectedFile?.sourceUri ?? '');
      window.localStorage.setItem(shellUiStorageKey(sessionId, 'sidebarCollapsed'), String(options.sidebarCollapsed));
    } catch { /* Persistence is optional and must not block navigation. */ }
  }, [workspace, activeDomain, options.selectedFile?.sourceUri, options.sidebarCollapsed]);

  const domainSummaries = useMemo<readonly DomainSummary[]>(() => {
    const readContract = new Set<EditorDomainId>();
    if (bridge) {
      if (typeof bridge.readParamDocument === 'function') readContract.add('param');
      if (typeof bridge.readGparamDocument === 'function') readContract.add('gparam');
      if (typeof bridge.readFmgDocument === 'function') readContract.add('text');
      if (typeof bridge.readEmevdDocument === 'function') readContract.add('event');
      if (typeof bridge.readMsbDocument === 'function') readContract.add('map');
      if (typeof bridge.inspectContainerTree === 'function') readContract.add('container');
      if (typeof bridge.listScriptContainerEntriesPage === 'function') readContract.add('script');
      if (typeof bridge.readTaeDocument === 'function') readContract.add('animation');
      if (typeof bridge.readEsdDocument === 'function') readContract.add('behavior');
      if (typeof bridge.readFlverDocument === 'function') readContract.add('model');
      if (typeof bridge.readTpfDocument === 'function') readContract.add('texture');
      if (typeof bridge.readMtdDocument === 'function') readContract.add('material');
      if (typeof bridge.readFxrDocument === 'function') readContract.add('vfx');
    }
    return buildDomainSummaries({ readContract, runtimeReady: !options.isBrowserPreview });
  }, [bridge, options.isBrowserPreview]);
  const indexedFiles = options.allFiles.length > 0 ? options.allFiles : options.files;
  const domainLibraries = useMemo(() => filesForDomain(activeDomain, indexedFiles), [activeDomain, indexedFiles]);
  const domainGroups = useMemo(() => activeDomain === 'param' ? paramLibraryGroups(indexedFiles)
    : activeDomain === 'behavior' ? behaviorLibraryGroups(indexedFiles) : undefined, [activeDomain, indexedFiles]);
  const preferredParamContainer = useMemo(() => pickPreferredParamContainer(indexedFiles), [indexedFiles]);
  const preferredAnimationContainer = useMemo(() => pickPreferredAnimation(indexedFiles), [indexedFiles]);
  const resourceMode = 'all' as const;
  const physicalBrowseFiles = useMemo(() => activeDomain === 'files'
    ? filterFilesForMode([...indexedFiles], resourceMode, query) : [], [activeDomain, indexedFiles, query]);
  const searchHits = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? indexedFiles.filter(file => file.relativePath.toLowerCase().includes(normalized)
      || file.resourceKind.toLowerCase().includes(normalized) || file.formatLabel.toLowerCase().includes(normalized)) : [];
  }, [indexedFiles, query]);
  const cmdkNormalized = useMemo(() => normalizeCommandSearchText(options.cmdkQuery), [options.cmdkQuery]);
  const cmdkAllResourceMatches = useMemo(() => !options.cmdkOpen || !workspace || !cmdkNormalized ? []
    : filterCommandPaletteResources(indexedFiles, cmdkNormalized), [options.cmdkOpen, workspace, indexedFiles, cmdkNormalized]);

  const activateSidebarView = useCallback((view: SidebarView): void => {
    if (!ownsContext()) return;
    if (view === sidebarView && !portsRef.current.sidebarCollapsed) { portsRef.current.setSidebarCollapsed(true); return; }
    portsRef.current.setSidebarCollapsed(false); setSidebarView(view);
  }, [ownsContext, sidebarView]);
  const showSidebarView = useCallback((view: SidebarView): void => {
    if (!ownsContext()) return;
    portsRef.current.setSidebarCollapsed(false); setSidebarView(view);
  }, [ownsContext]);
  const activateSearchResults = useCallback(() => {
    if (!ownsContext()) return;
    invalidateJump(); setActiveDomain('files'); setCenterView('resource');
  }, [ownsContext, invalidateJump]);
  const search = useCallback(async () => {
    if (ownsContext()) await portsRef.current.searchWorkspaceResources(query);
  }, [ownsContext, query]);

  const restoreLastShellState = useCallback((workspaceSessionId: string, index: readonly RendererIndexedFile[]): boolean => {
    if (!ownsContext()) return false;
    try {
      const savedCollapsed = window.localStorage.getItem(shellUiStorageKey(workspaceSessionId, 'sidebarCollapsed'));
      const savedDomain = window.localStorage.getItem(shellUiStorageKey(workspaceSessionId, 'domain'));
      const savedSourceUri = window.localStorage.getItem(shellUiStorageKey(workspaceSessionId, 'sourceUri'));
      if (savedCollapsed !== null) portsRef.current.setSidebarCollapsed(savedCollapsed === 'true');
      if (savedDomain === null || !EDITOR_DOMAIN_IDS.includes(savedDomain as EditorDomainId) || savedDomain === 'project') return false;
      const domain = savedDomain as EditorDomainId;
      invalidateJump(); setSidebarView('explorer'); setCenterView('resource'); setActiveDomain(domain);
      if (savedSourceUri) {
        const match = index.find(file => file.sourceUri === savedSourceUri);
        if (match) { void portsRef.current.selectFile(match); return true; }
      }
      if (domain === 'param') {
        const preferred = pickPreferredParamContainer(index);
        if (preferred) void portsRef.current.selectFile(preferred);
      } else if (domain === 'text') portsRef.current.clearResourcePreview();
      return true;
    } catch { return false; }
  }, [ownsContext, invalidateJump]);
  const installWorkspaceNavigation = useCallback((workspaceSessionId: string, index: readonly RendererIndexedFile[]): void => {
    if (!ownsContext()) return;
    resetNavigationTextState(); setBnd4Forced(false); setCenterView('resource'); setSidebarView('explorer');
    if (restoreLastShellState(workspaceSessionId, index)) return;
    setActiveDomain('param'); portsRef.current.clearResourcePreview();
    const preferred = pickPreferredParamContainer(index);
    if (preferred) void portsRef.current.selectFile(preferred); else portsRef.current.clearResourceSelection();
  }, [ownsContext, resetNavigationTextState, restoreLastShellState]);

  const selectDomain = useCallback((domain: EditorDomainId): void => {
    if (!ownsContext()) return;
    const ports = portsRef.current;
    if (domain === 'project' && ports.workspace !== null) {
      setSidebarView('explorer');
      ports.setSidebarCollapsed(collapsed => !collapsed && sidebarView === 'explorer' ? true : false);
      return;
    }
    if (domain !== activeDomain && ports.editDirty
      && !window.confirm('当前文本有未生成变更的修改，切换工作域将保留草稿但可能离开编辑视图。继续？')) return;
    invalidateJump(); setActiveDomain(domain); setBnd4Forced(false);
    if (domain === 'project') {
      ports.clearResourceSelection(); setCenterView('project'); setSidebarView('explorer');
      ports.setSidebarCollapsed(false); ports.setStatus('开始页'); return;
    }
    if (domain === activeDomain) { if (domain === 'files') ports.setStatus('文件：物理浏览'); return; }
    const indexed = ports.allFiles.length > 0 ? ports.allFiles : ports.files;
    if (domain === 'param') {
      const preferred = pickPreferredParamContainer(indexed);
      if (preferred) { setCenterView('resource'); void ports.selectFile(preferred); ports.setStatus('PARAM：已打开参数工作台'); return; }
    }
    if (domain === 'text') {
      ports.clearResourcePreview(); setCenterView('resource'); ports.setStatus('文本：已打开文本工作台'); return;
    }
    if (domain === 'event') {
      const first = filesForDomain('event', indexed)[0];
      if (first) { setCenterView('resource'); void ports.selectFile(first); ports.setStatus('事件：源码工作台'); return; }
    }
    if (domain === 'behavior') {
      const preferred = pickPreferredAnimation(indexed);
      if (preferred) { setCenterView('resource'); void ports.selectFile(preferred); ports.setStatus('动作：已打开动画工作台'); return; }
    }
    ports.clearResourceSelection(); ports.clearResourcePreview(); setCenterView('resource');
    if (domain === 'files') { ports.setStatus('文件：物理浏览'); return; }
    const capability = domainSummaries.find(entry => entry.domain === domain)?.capability ?? 'deferred';
    ports.setStatus(capability === 'read-ready' ? `${domainLabel(domain)}：等待成熟工作台接线`
      : `${domainLabel(domain)}：${capability === 'deferred' ? '暂未提供读取能力' : '当前条件不满足'}`);
  }, [ownsContext, sidebarView, activeDomain, domainSummaries, invalidateJump]);
  const openOperationsView = useCallback(() => {
    if (!ownsContext()) return;
    invalidateJump(); setCenterView('operations'); portsRef.current.setStatus('任务与历史：写入、回滚与诊断记录');
  }, [ownsContext, invalidateJump]);
  const openBnd4ForSelection = useCallback(() => {
    if (!ownsContext()) return;
    const ports = portsRef.current;
    if (!ports.selectedFile) { ports.setStatus('先选择一个容器资源，再以 BND4 容器打开。'); return; }
    invalidateJump(); setBnd4Forced(true); setCenterView('resource'); ports.setStatus(`以 BND4 容器打开：${ports.selectedFile.relativePath}`);
  }, [ownsContext, invalidateJump]);

  const jumpToResource = useCallback(async (request: ResourceJumpRequest): Promise<ResourceJumpResult> => {
    const stale = () => insufficientEvidence('跳转上下文已变化，请在当前打开的文档中重新定位。');
    if (!ownsContext()) return stale();
    const requestId = ++jumpRequestRef.current;
    const origin = portsRef.current;
    const isCurrent = () => ownsContext() && requestId === jumpRequestRef.current
      && portsRef.current.openTabs === origin.openTabs
      && portsRef.current.selectedFile?.sourceUri === origin.selectedFile?.sourceUri;
    if (request.kind === 'param') {
      const openParams = origin.openTabs.filter(shouldLoadParam);
      const result = resolveParamJump(request.id, openParams.map(tab => ({ sourceUri: tab.sourceUri, title: libraryDisplayName(tab.relativePath) })));
      if (result.kind === 'hit') {
        const target = openParams.find(tab => tab.sourceUri === result.resourceUri);
        if (target && isCurrent()) {
          // switchToOpenTab synchronously resets all document owners; destination reveal comes after that reset.
          origin.switchToOpenTab(target); setFmgRevealRequest(null); origin.setParamRevealRowId(request.id);
        }
      }
      return result;
    }
    let catalog = catalogRef.current;
    if (!catalog && bridge && typeof bridge.readTextCatalog === 'function') {
      try {
        const fetched = await bridge.readTextCatalog();
        if (!isCurrent()) return stale();
        if (fetched.ok) { catalog = fetched; catalogRef.current = fetched; setTextCatalog(fetched); }
      } catch { if (!isCurrent()) return stale(); /* Empty metadata remains insufficient evidence. */ }
    }
    if (!isCurrent()) return stale();
    const openText = origin.openTabs.filter(shouldLoadFmg);
    const containers: TextContainerRef[] = openText.map(tab => ({ sourceUri: tab.sourceUri,
      title: libraryDisplayName(tab.relativePath), tables: (catalog ? findCatalogContainer(catalog, tab.sourceUri) : null)?.tables ?? [] }));
    const result = resolveFmgJump(request.semantic, request.id, containers);
    if (result.kind === 'hit' && result.tableId !== undefined) {
      const target = openText.find(tab => tab.sourceUri === result.resourceUri);
      if (target) {
        origin.switchToOpenTab(target); origin.setParamRevealRowId(null);
        setFmgRevealRequest({ tableId: result.tableId, entryId: request.id });
      }
    }
    return result;
  }, [ownsContext, bridge]);

  const domainCommands: NavigationCommand[] = domainSummaries.filter(entry => entry.visibility !== 'hidden').map(entry => ({
    id: `domain-${entry.domain}`, icon: '◧', label: `切换到 ${entry.label} 工作域`, run: () => {
      if (!ownsContext()) return;
      portsRef.current.setSidebarCollapsed(false); setSidebarView('explorer'); selectDomain(entry.domain);
    }
  }));
  return { query, setQuery, activeDomain, centerView, bnd4Forced, sidebarView, textCatalog, fmgRevealRequest, resourceMode,
    indexedFiles, domainSummaries, domainLibraries, domainGroups, preferredParamContainer, preferredAnimationContainer,
    physicalBrowseFiles, searchHits, cmdkNormalized, cmdkAllResourceMatches, domainCommands,
    selectDomain, restoreLastShellState, installWorkspaceNavigation, activateSearchResults, search,
    activateSidebarView, showSidebarView, openOperationsView, openBnd4ForSelection, jumpToResource,
    resetNavigationTextState, onResourceSelectionActivated, clearFmgRevealRequest };
}
export type NavigationController = ReturnType<typeof useNavigationController>;
