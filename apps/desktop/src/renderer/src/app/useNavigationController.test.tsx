import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act, useState } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import { EDITOR_DOMAIN_IDS, type EditorDomainId } from '@soulforge/shared';
import type { RendererWorkspaceScanResult, TextCatalogResponse } from '../../../main/ipc.js';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { useResourceDocumentController, type ResourceDocumentController } from './useResourceDocumentController.js';
import type { ResourceJumpResult } from '../emevd/eventSourceNavigate.js';
import { shellUiStorageKey, useNavigationController, type NavigationController, type NavigationOptions } from './useNavigationController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
const storage = new Map<string, string>();
let confirmResult = true;
const confirmations: string[] = [];
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  confirm: (message: string) => { confirmations.push(message); return confirmResult; }
} });
afterEach(async () => {
  while (mounted.length) { const renderer = mounted.pop()!; await act(async () => renderer.unmount()); }
  storage.clear(); confirmations.length = 0; confirmResult = true;
});
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function file(path: string, kind: RendererIndexedFile['resourceKind'] = 'other'): RendererIndexedFile {
  const extension = `.${path.split('.').at(-1)}`;
  return { sourceUri: `resource://indexed/${path}`, relativePath: path, resourceKind: kind, game: 'sekiro',
    parseStatus: 'parsed', diagnostics: [], extension, compoundExtension: extension, formatKind: 'unknown',
    formatLabel: extension, size: 80, mtimeMs: 1 };
}
const param = file('param/gameparam.parambnd.dcx', 'param');
const paramRow = file('param/SpEffectParam.param', 'param');
const text = file('msg/eng/ItemName.fmg', 'msg');
const event = file('event/common.emevd.dcx', 'event');
const hks = file('action/script/first.hks', 'action');
const animation = file('chr/c0000.anibnd.dcx', 'chr');
const gparam = file('param/a.gparam', 'param');
function workspace(id = 'workspace'): RendererWorkspaceScanResult {
  return { workspaceSessionId: id, workspaceLabel: id, files: [], diagnostics: [] } as unknown as RendererWorkspaceScanResult;
}
function catalog(target = text, name = 'ItemName.fmg', tableId = 'native-table'): TextCatalogResponse {
  return { ok: true, libraryId: 'game-text', title: 'Native text', diagnostics: [], languages: [{ languageId: 'eng', containers: [{
    containerId: 'native-container', containerKind: 'item', sourceUri: target.sourceUri, relativePath: target.relativePath,
    parseStatus: 'confirmed', tableCount: 1, diagnostics: [], tables: [{ tableId, entryName: name, entryCount: 10,
      sourceUri: target.sourceUri, entryIndex: 0 }] }] }] };
}
function ports() {
  const statuses: string[] = [], selects: RendererIndexedFile[] = [], switches: RendererIndexedFile[] = [], sequence: string[] = [];
  const reveals: Array<number | null> = [], searches: string[] = [];
  let reads = 0;
  const options: NavigationOptions = {
    bridge: { readTextCatalog: async () => { reads++; return catalog(); } }, isBrowserPreview: false, workspace: workspace(),
    selectedFile: event, openTabs: [event, text], editDirty: false, allFiles: [param, text, event, hks, animation, gparam], files: [],
    sidebarCollapsed: false, setSidebarCollapsed: () => {}, cmdkOpen: false, cmdkQuery: '',
    selectFile: async target => { selects.push(target); }, switchToOpenTab: target => { switches.push(target); },
    clearResourceSelection: () => sequence.push('clear-selection'), clearResourcePreview: () => sequence.push('clear-preview'),
    setParamRevealRowId: row => { reveals.push(row); sequence.push(`param-reveal:${row}`); },
    setStatus: value => statuses.push(value), searchWorkspaceResources: async query => { searches.push(query); }
  };
  return { options, statuses, selects, switches, sequence, reveals, searches, reads: () => reads };
}
async function mount(options: NavigationOptions, strict = false) {
  let current!: NavigationController, collapsed = options.sidebarCollapsed;
  function Host({ options }: { options: NavigationOptions }) {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(options.sidebarCollapsed); collapsed = sidebarCollapsed;
    current = useNavigationController({ ...options, sidebarCollapsed, setSidebarCollapsed,
      selectFile: async target => { current.resetNavigationTextState(); current.onResourceSelectionActivated(); await options.selectFile(target); },
      switchToOpenTab: target => {
        current.resetNavigationTextState(); options.setParamRevealRowId(null); current.onResourceSelectionActivated(); options.switchToOpenTab(target);
      }
    });
    return <span>{current.activeDomain}:{current.centerView}:{current.fmgRevealRequest?.tableId}</span>;
  }
  const element = (value: NavigationOptions) => strict ? <React.StrictMode><Host options={value} /></React.StrictMode> : <Host options={value} />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(options)); }); mounted.push(renderer);
  return { current: () => current, collapsed: () => collapsed,
    update: async (next: NavigationOptions) => act(async () => renderer.update(element(next))),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); },
    domain: async (domain: EditorDomainId) => act(async () => current.selectDomain(domain)) };
}

it('cold start and project-with-workspace preserve resource pane toggle before the exact dirty prompt', async () => {
  const p = ports(), h = await mount({ ...p.options, editDirty: true });
  assert.equal(h.current().activeDomain, 'project'); assert.equal(h.current().centerView, 'project');
  await act(async () => h.current().onResourceSelectionActivated()); await h.domain('project');
  assert.equal(h.collapsed(), true); assert.equal(h.current().centerView, 'resource'); assert.deepEqual(confirmations, []);
  await h.domain('project'); assert.equal(h.collapsed(), false);
  confirmResult = false; await h.domain('param'); assert.equal(h.current().activeDomain, 'project'); assert.deepEqual(p.selects, []);
  assert.deepEqual(confirmations, ['当前文本有未生成变更的修改，切换工作域将保留草稿但可能离开编辑视图。继续？']);
});
it('project without a workspace clears the selection and opens the start pane', async () => {
  const p = ports(), h = await mount({ ...p.options, workspace: null, selectedFile: null });
  await h.domain('files'); await h.domain('project');
  assert.equal(h.current().centerView, 'project'); assert.equal(h.current().sidebarView, 'explorer'); assert.equal(h.collapsed(), false);
  assert.equal(p.statuses.at(-1), '开始页'); assert.equal(p.sequence.at(-1), 'clear-selection');
});
it('PARAM/event/action default selections use the actual index and preserve the active domain', async () => {
  const p = ports(), h = await mount(p.options);
  for (const [domain, target] of [['param', param], ['event', event], ['behavior', animation]] as const) {
    await h.domain(domain); assert.equal(h.current().activeDomain, domain); assert.equal(h.current().centerView, 'resource');
    assert.equal(p.selects.at(-1), target);
  }
  assert.equal(p.selects.includes(hks), false); assert.deepEqual(h.current().domainGroups?.map(group => group.id), ['animation', 'action-script']);
  assert.equal(h.current().domainGroups?.[1]?.defaultCollapsed, true);
});
it('text entry preserves prior resource selection and clears preview without choosing a container', async () => {
  const p = ports(), h = await mount(p.options); await h.domain('text');
  assert.deepEqual(p.selects, []); assert.deepEqual(p.sequence, ['clear-preview']); assert.equal(h.current().centerView, 'resource');
  assert.deepEqual(h.current().domainLibraries, [text]); assert.equal(p.statuses.at(-1), '文本：已打开文本工作台');
});
it('every domain retains the current-domain early return and indexed-empty capability branches', async () => {
  const p = ports(), h = await mount({ ...p.options, allFiles: [], files: [] });
  for (const domain of EDITOR_DOMAIN_IDS.filter(domain => domain !== 'project' && domain !== 'text')) {
    await h.domain(domain); assert.equal(h.current().activeDomain, domain); assert.equal(h.current().centerView, 'resource');
    const count = p.sequence.length; await h.domain(domain); assert.equal(p.sequence.length, count); assert.deepEqual(p.selects, []);
  }
  await h.domain('files'); assert.equal(p.statuses.at(-1), '文件：物理浏览');
  await h.domain('map'); assert.equal(p.statuses.at(-1), '地图：暂未提供读取能力');
});
it('registered read methods alone drive capability, with hidden domains and blocked runtime preserved', async () => {
  const p = ports(), h = await mount({ ...p.options, bridge: { readMsbDocument: async () => ({ ok: false, diagnostics: [] }) } });
  assert.equal(h.current().domainSummaries.find(entry => entry.domain === 'map')?.capability, 'read-ready');
  await h.domain('map'); assert.equal(p.statuses.at(-1), '地图：等待成熟工作台接线');
  assert.equal(h.current().domainCommands.some(command => /GPARAM|动画|文件/.test(command.label)), false);
  await h.update({ ...p.options, bridge: p.options.bridge, isBrowserPreview: true });
  assert.equal(h.current().domainSummaries.find(entry => entry.domain === 'text')?.capability, 'deferred');
  await h.update({ ...p.options, bridge: { readMsbDocument: async () => ({ ok: false, diagnostics: [] }) }, isBrowserPreview: true });
  await h.domain('files'); await h.domain('map'); assert.equal(p.statuses.at(-1), '地图：当前条件不满足');
});
it('operations and forced BND navigation retain messages and never maximize the workbench', async () => {
  const p = ports(), h = await mount({ ...p.options, selectedFile: null });
  await act(async () => h.current().openBnd4ForSelection()); assert.equal(h.current().bnd4Forced, false);
  assert.equal(p.statuses.at(-1), '先选择一个容器资源，再以 BND4 容器打开。');
  await h.update(p.options); await act(async () => h.current().openBnd4ForSelection());
  assert.equal(h.current().bnd4Forced, true); assert.equal(h.current().centerView, 'resource');
  await act(async () => h.current().openOperationsView()); assert.equal(h.current().centerView, 'operations');
  assert.equal(p.statuses.at(-1), '任务与历史：写入、回滚与诊断记录');
  await act(async () => h.current().onResourceSelectionActivated()); assert.equal(h.current().bnd4Forced, false);
  assert.equal(h.current().centerView, 'resource');
});
it('sidebar commands preserve repeated-click collapse and explicit settings/search/staging opens', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => h.current().activateSidebarView('audit')); assert.equal(h.current().sidebarView, 'audit');
  await act(async () => h.current().activateSidebarView('audit')); assert.equal(h.collapsed(), true);
  for (const view of ['search', 'settings', 'staging'] as const) {
    await act(async () => h.current().showSidebarView(view)); assert.equal(h.current().sidebarView, view); assert.equal(h.collapsed(), false);
  }
  await act(async () => { h.current().setQuery('native search'); }); await act(async () => h.current().search());
  assert.deepEqual(p.searches, ['native search']); await act(async () => h.current().activateSearchResults());
  assert.equal(h.current().activeDomain, 'files'); assert.equal(h.current().centerView, 'resource');
});
it('restore reads exact shell keys, accepts only legal non-project domains, and only selects indexed URIs', async () => {
  const p = ports(), h = await mount(p.options);
  storage.set(shellUiStorageKey('saved', 'domain'), 'param'); storage.set(shellUiStorageKey('saved', 'sourceUri'), 'resource://not-indexed');
  storage.set(shellUiStorageKey('saved', 'sidebarCollapsed'), 'true');
  let restored = false; await act(async () => { restored = h.current().restoreLastShellState('saved', [param]); });
  assert.equal(restored, true); assert.equal(h.collapsed(), true); assert.equal(h.current().activeDomain, 'param'); assert.deepEqual(p.selects, [param]);
  storage.set(shellUiStorageKey('saved', 'domain'), 'text'); storage.set(shellUiStorageKey('saved', 'sourceUri'), text.sourceUri);
  await act(async () => { restored = h.current().restoreLastShellState('saved', [text]); }); assert.equal(restored, true); assert.equal(p.selects.at(-1), text);
  for (const invalid of ['project', 'invalid', '']) {
    storage.set(shellUiStorageKey('saved', 'domain'), invalid); await act(async () => { restored = h.current().restoreLastShellState('saved', [param]); }); assert.equal(restored, false);
  }
  assert.equal(shellUiStorageKey(undefined, 'domain'), 'soulforge.ui.shell.v1.preview.domain');
});
it('workspace install restores text empty state or defaults to PARAM using the supplied new index', async () => {
  const p = ports(), h = await mount({ ...p.options, workspace: null, allFiles: [] });
  storage.set(shellUiStorageKey('new', 'domain'), 'text');
  await act(async () => h.current().installWorkspaceNavigation('new', [param]));
  assert.equal(h.current().activeDomain, 'text'); assert.deepEqual(p.selects, []); assert.equal(p.sequence.at(-1), 'clear-preview');
  await act(async () => h.current().installWorkspaceNavigation('empty', []));
  assert.equal(h.current().activeDomain, 'param'); assert.equal(h.current().centerView, 'resource'); assert.equal(p.sequence.at(-1), 'clear-selection');
  await act(async () => h.current().installWorkspaceNavigation('default', [param])); assert.equal(p.selects.at(-1), param);
});
it('shell persistence never writes project as a saved workspace domain', async () => {
  const p = ports(), h = await mount(p.options);
  assert.equal(storage.has(shellUiStorageKey('workspace', 'domain')), false);
  assert.equal(storage.get(shellUiStorageKey('workspace', 'sourceUri')), event.sourceUri);
  await h.domain('map'); assert.equal(storage.get(shellUiStorageKey('workspace', 'domain')), 'map');
  await h.domain('project'); assert.equal(storage.get(shellUiStorageKey('workspace', 'domain')), 'map');
  assert.equal(storage.get(shellUiStorageKey('workspace', 'sidebarCollapsed')), 'true');
});
it('file browse, global search and command projections never add files outside the native index', async () => {
  const p = ports(), h = await mount({ ...p.options, allFiles: [animation, text], files: [param], cmdkOpen: true, cmdkQuery: 'ItemName' });
  await h.domain('files'); await act(async () => h.current().setQuery('itemname'));
  assert.deepEqual(h.current().physicalBrowseFiles, [text]); assert.deepEqual(h.current().searchHits, [text]);
  assert.deepEqual(h.current().cmdkAllResourceMatches, [text]); assert.deepEqual(h.current().indexedFiles, [animation, text]);
  await h.domain('map'); assert.deepEqual(h.current().physicalBrowseFiles, []); assert.deepEqual(h.current().searchHits, [text]);
  await h.update({ ...p.options, allFiles: [], files: [text], cmdkOpen: false, cmdkQuery: 'ItemName' });
  assert.deepEqual(h.current().indexedFiles, [text]); assert.deepEqual(h.current().cmdkAllResourceMatches, []);
});
it('jump resets existing document owners before reveal, uses native metadata, and never opens a file', async () => {
  const p = ports(), h = await mount(p.options); let result!: ResourceJumpResult;
  await act(async () => { result = await h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 40 }); });
  assert.equal(result?.kind, 'hit'); assert.deepEqual(p.switches, [text]); assert.deepEqual(p.selects, []);
  assert.deepEqual(h.current().fmgRevealRequest, { tableId: 'native-table', entryId: 40 });
  assert.equal(h.current().textCatalog, null); assert.deepEqual(p.reveals, [null, null]);
  await h.update({ ...p.options, openTabs: [event, paramRow] });
  await act(async () => { result = await h.current().jumpToResource({ kind: 'param', id: 60 }); });
  assert.equal(result?.kind, 'hit'); assert.equal(p.switches.at(-1), paramRow); assert.deepEqual(p.reveals.slice(-2), [null, 60]);
  assert.equal(h.current().fmgRevealRequest, null); assert.equal(p.reads(), 1); assert.deepEqual(p.selects, []);
});
it('PARAM and FMG empty, unindexed, wrong-family, ambiguous and failed-catalog outcomes stay insufficient evidence', async () => {
  const p = ports(), h = await mount(p.options);
  for (const tabs of [[], [param], [paramRow, file('param/second.param', 'param')]]) {
    await h.update({ ...p.options, openTabs: tabs });
    await act(async () => assert.equal((await h.current().jumpToResource({ kind: 'param', id: 10 })).kind, 'insufficient_evidence'));
  }
  await h.update({ ...p.options, openTabs: [event] });
  await act(async () => assert.equal((await h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 10 })).kind, 'insufficient_evidence'));
  const second = file('msg/jpn/ItemName.fmg', 'msg');
  const ambiguous = catalog(); ambiguous.languages[0]!.containers.push(catalog(second).languages[0]!.containers[0]!);
  const failed = { ...catalog(), ok: false };
  for (const fetched of [ambiguous, failed]) {
    await h.update({ ...p.options, openTabs: [text, second], bridge: { readTextCatalog: async () => fetched } });
    await act(async () => assert.equal((await h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 10 })).kind, 'insufficient_evidence'));
  }
  assert.deepEqual(p.switches, []); assert.deepEqual(p.selects, []); assert.equal(h.current().fmgRevealRequest, null);
});
it('readonly catalog cache is reused only within its reset boundary and native failure stays uncached', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => { await h.current().jumpToResource({ kind: 'fmg', semantic: 'place-name', id: 1 });
    await h.current().jumpToResource({ kind: 'fmg', semantic: 'place-name', id: 2 }); });
  assert.equal(p.reads(), 1); assert.equal(h.current().textCatalog?.ok, true);
  await act(async () => h.current().resetNavigationTextState());
  await act(async () => { await h.current().jumpToResource({ kind: 'fmg', semantic: 'place-name', id: 3 }); }); assert.equal(p.reads(), 2);
  let failedReads = 0;
  await h.update({ ...p.options, bridge: { readTextCatalog: async () => { failedReads++; throw new Error('native unavailable'); } } });
  await act(async () => { await h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 1 });
    await h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 2 }); });
  assert.equal(failedReads, 2); assert.equal(h.current().textCatalog, null);
});
it('deferred catalog completion cannot publish or switch after reset, selection, tabs, domain, operations, workspace, bridge or disposal', async () => {
  for (const change of ['reset', 'selection', 'tabs', 'domain', 'operations', 'workspace', 'bridge', 'disposal'] as const) {
    const p = ports(), read = deferred<TextCatalogResponse>(); p.options.bridge!.readTextCatalog = () => read.promise;
    const h = await mount(p.options); let jumping!: Promise<unknown>;
    await act(async () => { jumping = h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 1 }); });
    if (change === 'reset') await act(async () => h.current().resetNavigationTextState());
    else if (change === 'selection') await act(async () => h.current().onResourceSelectionActivated());
    else if (change === 'tabs') await h.update({ ...p.options, openTabs: [event] });
    else if (change === 'domain') await h.domain('text');
    else if (change === 'operations') await act(async () => h.current().openOperationsView());
    else if (change === 'workspace') await h.update({ ...p.options, workspace: workspace('new') });
    else if (change === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge } });
    else await h.unmount();
    await act(async () => { read.resolve(catalog()); assert.equal((await jumping as { kind: string }).kind, 'insufficient_evidence'); });
    assert.deepEqual(p.switches, []); assert.deepEqual(p.reveals, []);
    if (change !== 'disposal') { assert.equal(h.current().textCatalog, null); assert.equal(h.current().fmgRevealRequest, null); }
  }
});
it('a newer resource jump owns completion when older native catalogs resolve in reverse order', async () => {
  const p = ports(), older = deferred<TextCatalogResponse>(), newer = deferred<TextCatalogResponse>(); let reads = 0;
  p.options.bridge!.readTextCatalog = () => ++reads === 1 ? older.promise : newer.promise;
  const h = await mount(p.options); let first!: Promise<unknown>, second!: Promise<unknown>;
  await act(async () => { first = h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 1 });
    second = h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 2 }); });
  await act(async () => { newer.resolve(catalog(text, 'ItemName.fmg', 'new-table')); assert.equal((await second as { kind: string }).kind, 'hit'); });
  await act(async () => { older.resolve(catalog(text, 'ItemName.fmg', 'old-table')); assert.equal((await first as { kind: string }).kind, 'insufficient_evidence'); });
  assert.deepEqual(h.current().fmgRevealRequest, { tableId: 'new-table', entryId: 2 }); assert.deepEqual(p.switches, [text]);
});
it('obsolete catalog rejection and retained bridge commands settle without effects', async () => {
  const p = ports(), read = deferred<TextCatalogResponse>(); p.options.bridge!.readTextCatalog = () => read.promise;
  const h = await mount(p.options), retained = h.current(); let jumping!: Promise<unknown>;
  await act(async () => { jumping = retained.jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 1 }); });
  await h.update({ ...p.options, bridge: { ...p.options.bridge } });
  await act(async () => { read.reject(new Error('late failure')); assert.equal((await jumping as { kind: string }).kind, 'insufficient_evidence');
    retained.selectDomain('param'); retained.openOperationsView(); retained.openBnd4ForSelection();
    assert.equal((await retained.jumpToResource({ kind: 'param', id: 1 })).kind, 'insufficient_evidence'); });
  assert.deepEqual(p.switches, []); assert.deepEqual(p.selects, []); assert.deepEqual(p.statuses, []);
});
it('strict lifecycle and status rerenders keep native jump reads single and registry resets stable', async () => {
  const p = ports(), h = await mount(p.options, true), reset = h.current().resetNavigationTextState;
  await h.update({ ...p.options, setStatus: () => {} }); assert.equal(h.current().resetNavigationTextState, reset); assert.equal(p.reads(), 0);
  await act(async () => { await h.current().jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 1 }); });
  assert.equal(p.reads(), 1); assert.deepEqual(h.current().fmgRevealRequest, { tableId: 'native-table', entryId: 1 });
  await act(async () => reset()); assert.equal(h.current().fmgRevealRequest, null);
});

it('actual Resource owner resets documents before Navigation reveals an already-open tab without preview I/O', async () => {
  const p = ports(), previewReads: string[] = [], resetOrder: string[] = [];
  let navigation!: NavigationController, resource!: ResourceDocumentController;
  let paramReveal: number | null = null;
  const resourceBridge = {
      openResourcePreview: async (sourceUri: string) => { previewReads.push(sourceUri); return null; },
      saveTextResource: async () => ({ ok: false, changedFiles: [], diagnostics: [] }),
      readTaeDocument: async () => ({ ok: false, diagnostics: [] }), readEsdDocument: async () => ({ ok: false, diagnostics: [] }),
      readFlverDocument: async () => ({ ok: false, diagnostics: [] }), applyFlverMutation: async () => ({ ok: false, changedFiles: [], diagnostics: [] })
  };
  function Host() {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    resource = useResourceDocumentController({ bridge: resourceBridge, setStatus: p.options.setStatus, pushToast: () => {}, refreshOperationHistory: async () => {}, describeBridgeAbsence: value => value,
      onSelectionActivated: () => {
        resetOrder.push('registry'); navigation.resetNavigationTextState(); paramReveal = null;
        resource.resetTaeDocument(); resource.resetEsdDocument(); resource.resetFlverDocument();
        navigation.onResourceSelectionActivated(); resetOrder.push('resource-view');
      }
    });
    navigation = useNavigationController({ ...p.options, ...resource, sidebarCollapsed, setSidebarCollapsed,
      setParamRevealRowId: value => { paramReveal = value; resetOrder.push(`param-reveal:${value}`); }
    });
    return <span>{resource.selectedFile?.sourceUri}:{navigation.fmgRevealRequest?.tableId}</span>;
  }
  let renderer!: ReactTestRenderer; await act(async () => { renderer = TestRenderer.create(<Host />); }); mounted.push(renderer);
  await act(async () => { await resource.selectFile(text); });
  await act(async () => { await resource.selectFile(paramRow); });
  await act(async () => { await resource.selectFile(event); });
  const reads = previewReads.length, tabs = resource.openTabs;
  resetOrder.length = 0;
  await act(async () => assert.equal((await navigation.jumpToResource({ kind: 'fmg', semantic: 'item-name', id: 42 })).kind, 'hit'));
  assert.equal(resource.selectedFile, text); assert.equal(resource.openTabs, tabs); assert.equal(previewReads.length, reads);
  assert.deepEqual(navigation.fmgRevealRequest, { tableId: 'native-table', entryId: 42 });
  assert.deepEqual(resetOrder, ['registry', 'resource-view', 'param-reveal:null']); assert.equal(paramReveal, null);
  resetOrder.length = 0;
  await act(async () => assert.equal((await navigation.jumpToResource({ kind: 'param', id: 64 })).kind, 'hit'));
  assert.equal(resource.selectedFile, paramRow); assert.equal(resource.openTabs, tabs); assert.equal(previewReads.length, reads);
  assert.equal(navigation.fmgRevealRequest, null); assert.equal(paramReveal, 64);
  assert.deepEqual(resetOrder, ['registry', 'resource-view', 'param-reveal:64']);
});
