import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import type { AnalyzeWorkspaceSummary, RendererWorkspaceScanResult } from '../../../main/ipc.js';
import { useWorkspaceController, type WorkspaceController, type WorkspaceOptions } from './useWorkspaceController.js';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => { while (mounted.length) { const renderer = mounted.pop()!; await act(async () => renderer.unmount()); } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function scanned(name: string): RendererWorkspaceScanResult {
  return { workspaceSessionId: name, workspaceLabel: name, files: [], countsByKind: { event: 0, map: 0, param: 0, msg: 0, menu: 0, script: 0, action: 0, ai: 0, sfx: 0, chr: 0, obj: 0, other: 0, unknown: 0 }, diagnostics: [], session: { workspaceSessionId: name, workspaceLabel: name, game: 'sekiro', openedAt: 'owned', baseMounted: false }, indexingStatus: { workspaceSessionId: name, phase: 'ready', current: 0, total: 0, message: 'owned' } };
}
const analysis: AnalyzeWorkspaceSummary = { parsedFiles: 2, inspectedFiles: 3, referenceStats: { high: 0, medium: 0, low: 0, suppressedAmbiguousNumbers: 0 }, diagnostics: [], events: [{ uri: 'event://owned', eventId: 1 }], tools: [] };
function ports() {
  const scans: unknown[] = [], installations: string[] = [], remounts: string[] = [], remountArgs: unknown[] = [], statuses: string[] = [], toasts: string[] = [], desktop: string[] = [];
  let histories = 0, searches = 0;
  const analyses: AnalyzeWorkspaceSummary[] = [];
  const options: WorkspaceOptions = { bridge: {
    scanWorkspace: async input => { scans.push(input); return scanned(input.overlaySelectionId); },
    analyzeWorkspace: async () => analysis,
    lastWorkspaceSelection: async () => ({ overlay: null, base: null }),
    openWorkspaceDialog: async () => ({ selectionId: 'manual', label: 'Owned' }),
    openBaseDialog: async () => ({ selectionId: 'base', label: 'Owned base' }),
    remountBase: async selectionId => { remountArgs.push(selectionId); return { workspaceSessionId: 'remounted', session: scanned('remounted').session }; },
    searchResources: async () => []
  }, setStatus: message => statuses.push(message), pushToast: text => toasts.push(text),
  announceDesktopOnly: operation => desktop.push(operation),
  onWorkspaceInstalled: result => installations.push(result.workspaceSessionId),
  onWorkspaceRemounted: result => remounts.push(result.workspaceSessionId),
  onSearchActivated: () => { searches++; }, onAnalysisLoaded: value => analyses.push(value), refreshOperationHistory: async () => { histories++; } };
  return { options, scans, installations, remounts, remountArgs, statuses, toasts, desktop, analyses, histories: () => histories, searches: () => searches };
}
async function mount(options: WorkspaceOptions) {
  let current!: WorkspaceController;
  function Host({ options }: { options: WorkspaceOptions }) { current = useWorkspaceController(options); return <span>{current.workspace?.workspaceLabel}</span>; }
  let renderer!: ReactTestRenderer; await act(async () => { renderer = TestRenderer.create(<Host options={options} />); }); mounted.push(renderer);
  return { current: () => current, update: async (options: WorkspaceOptions) => act(async () => renderer.update(<Host options={options} />)), unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); } };
}
it('manual mount forwards only existing selection credentials and owns scan/analysis/file state', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => h.current().mountWorkspace('overlay', 'base', 'manual'));
  assert.deepEqual(p.scans, [{ overlaySelectionId: 'overlay', baseSelectionId: 'base' }]);
  assert.equal(h.current().workspace?.workspaceSessionId, 'overlay'); assert.deepEqual(h.current().sessionMeta, scanned('overlay').session);
  assert.deepEqual(p.installations, ['overlay']); assert.equal(h.current().analysis, analysis); assert.deepEqual(p.analyses, [analysis]); assert.equal(p.histories(), 1);
  assert.equal(p.toasts.length, 2);
});
it('a late old scan cannot install after a later manual mount or after disposal', async () => {
  for (const change of ['new-mount', 'unmount', 'bridge'] as const) {
    const p = ports(), h = await mount(p.options), old = deferred<RendererWorkspaceScanResult>();
    p.options.bridge!.scanWorkspace = input => input.overlaySelectionId === 'old' ? old.promise : Promise.resolve(scanned('new'));
    let mounting!: Promise<void>; await act(async () => { mounting = h.current().mountWorkspace('old', undefined, 'manual'); });
    if (change === 'new-mount') await act(async () => h.current().mountWorkspace('new', undefined, 'manual'));
    else if (change === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
    else await h.unmount();
    const feedback = p.toasts.length;
    await act(async () => { old.resolve(scanned('old')); await mounting; });
    assert.equal(p.installations.includes('old'), false); assert.equal(p.toasts.length, feedback);
  }
});
it('late background analysis/history feedback cannot publish into a replacement mount', async () => {
  const p = ports(), h = await mount(p.options), history = deferred<void>();
  p.options.refreshOperationHistory = () => history.promise; await h.update({ ...p.options });
  await act(async () => h.current().mountWorkspace('old', undefined, 'manual'));
  const count = p.toasts.length;
  p.options.bridge!.analyzeWorkspace = () => new Promise(() => undefined);
  await act(async () => h.current().mountWorkspace('new', undefined, 'manual'));
  await act(async () => history.resolve());
  assert.equal(p.toasts.length, count + 1, 'Only the new mount toast may be added; obsolete analysis must not claim readiness');
});
it('startup restore cancellation and a user mount keep delayed last-selection from scanning', async () => {
  const p = ports(), last = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['lastWorkspaceSelection']>>>();
  p.options.bridge!.lastWorkspaceSelection = () => last.promise;
  const h = await mount(p.options); await act(async () => h.current().mountWorkspace('manual', undefined, 'manual'));
  await act(async () => last.resolve({ overlay: { selectionId: 'restore', label: 'Owned' }, base: null }));
  assert.equal(p.scans.length, 1); assert.equal(h.current().workspace?.workspaceSessionId, 'manual');
});
it('manual scan rejection keeps warning feedback while restored scan rejection stays quiet', async () => {
  const p = ports(), h = await mount(p.options); p.options.bridge!.scanWorkspace = async () => { throw new Error('owned scan failure'); };
  await act(async () => h.current().mountWorkspace('manual', undefined, 'manual')); assert.equal(p.toasts.length, 1);
  await act(async () => h.current().mountWorkspace('restore', undefined, 'restored')); assert.equal(p.toasts.length, 1);
});
it('late search results cannot replace a newer workspace file index', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['searchResources']>>>();
  p.options.bridge!.searchResources = () => pending.promise;
  let searching!: Promise<void>; await act(async () => { searching = h.current().search('owned'); });
  await act(async () => h.current().mountWorkspace('new', undefined, 'manual'));
  await act(async () => { pending.resolve([]); await searching; });
  assert.equal(p.searches(), 0);
});

it('a delayed startup selection cannot supersede a manually requested scan that is still pending', async () => {
  const p = ports(), last = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['lastWorkspaceSelection']>>>(), scan = deferred<RendererWorkspaceScanResult>();
  p.options.bridge!.lastWorkspaceSelection = () => last.promise;
  p.options.bridge!.scanWorkspace = input => { p.scans.push(input); return scan.promise; };
  const h = await mount(p.options); let mounting!: Promise<void>;
  await act(async () => { mounting = h.current().mountWorkspace('manual', undefined, 'manual'); });
  await act(async () => last.resolve({ overlay: { selectionId: 'restore', label: 'Owned' }, base: null }));
  assert.equal(p.scans.length, 1);
  await act(async () => { scan.resolve(scanned('manual')); await mounting; });
  assert.deepEqual(p.installations, ['manual']);
});

it('an old base remount completion cannot clear a replacement workspace or change its session metadata', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['remountBase']>>>();
  await act(async () => h.current().mountWorkspace('old', undefined, 'manual'));
  p.options.bridge!.remountBase = () => pending.promise;
  let selecting!: Promise<void>; await act(async () => { selecting = h.current().chooseBaseDirectory(); });
  await act(async () => h.current().mountWorkspace('new', undefined, 'manual'));
  const feedback = p.toasts.length;
  await act(async () => { pending.resolve({ workspaceSessionId: 'old-remounted', session: scanned('old-remounted').session }); await selecting; });
  assert.equal(h.current().sessionMeta?.workspaceSessionId, 'new'); assert.deepEqual(p.remounts, []); assert.equal(p.toasts.length, feedback);
});

it('base selection, scan and removal retain the existing credential and remount arguments', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => h.current().chooseBaseDirectory());
  assert.equal(h.current().baseRootChoice?.selectionId, 'base'); assert.deepEqual(p.remountArgs, []);
  await act(async () => h.current().openWorkspace());
  assert.deepEqual(p.scans, [{ overlaySelectionId: 'manual', baseSelectionId: 'base' }]); assert.equal(h.current().baseRootChoice, null);
  await act(async () => h.current().chooseBaseDirectory());
  assert.deepEqual(p.remountArgs, ['base']); assert.deepEqual(p.remounts, ['remounted']); assert.equal(h.current().sessionMeta?.workspaceSessionId, 'remounted');
  await act(async () => h.current().clearBaseDirectory());
  assert.deepEqual(p.remountArgs, ['base', null]); assert.equal(h.current().baseRootChoice, null);
});

it('cancelled directory dialogs remain quiet and browser-preview operations use the existing visible fallback', async () => {
  const p = ports(), h = await mount(p.options);
  p.options.bridge!.openWorkspaceDialog = async () => null; p.options.bridge!.openBaseDialog = async () => null;
  await act(async () => { await h.current().openWorkspace(); await h.current().chooseBaseDirectory(); });
  assert.deepEqual(p.scans, []); assert.deepEqual(p.statuses, []); assert.deepEqual(p.toasts, []);
  await h.update({ ...p.options, bridge: null });
  await act(async () => { await h.current().openWorkspace(); await h.current().chooseBaseDirectory(); await h.current().search('owned'); });
  assert.deepEqual(p.desktop, ['打开 Mod 工作区', '选择原版目录', '资源搜索']);
});

it('a replaced or disposed owner cannot accept a late directory selection or begin its native scan', async () => {
  for (const change of ['bridge', 'unmount'] as const) {
    const p = ports(), h = await mount(p.options), dialog = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['openWorkspaceDialog']>>>();
    p.options.bridge!.openWorkspaceDialog = () => dialog.promise;
    let opening!: Promise<void>; await act(async () => { opening = h.current().openWorkspace(); });
    if (change === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } }); else await h.unmount();
    await act(async () => { dialog.resolve({ selectionId: 'obsolete', label: 'Owned' }); await opening; });
    assert.deepEqual(p.scans, []); assert.deepEqual(p.installations, []);
  }
});

it('a delayed search cannot overwrite a newer query and preserves an original rejection identity', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['searchResources']>>>();
  const queries: string[] = [];
  p.options.bridge!.searchResources = query => { queries.push(query); return query === 'old' ? pending.promise : Promise.resolve([]); };
  let searching!: Promise<void>; await act(async () => { searching = h.current().search('old'); await h.current().search('new'); });
  await act(async () => { pending.resolve([]); await searching; });
  assert.deepEqual(queries, ['old', 'new']); assert.equal(p.searches(), 1);
  const error = new Error('owned search rejection'); p.options.bridge!.searchResources = async () => { throw error; };
  await assert.rejects(h.current().search('error'), received => received === error);
});

it('a newer base-remount request owns publication even when the older native completion arrives first', async () => {
  const p = ports(), h = await mount(p.options), first = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['remountBase']>>>(), second = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['remountBase']>>>();
  await act(async () => h.current().mountWorkspace('original', undefined, 'manual'));
  let requests = 0;
  p.options.bridge!.remountBase = () => ++requests === 1 ? first.promise : second.promise;
  let one!: Promise<void>, two!: Promise<void>;
  await act(async () => { one = h.current().chooseBaseDirectory(); });
  await act(async () => { two = h.current().chooseBaseDirectory(); });
  const statuses = p.statuses.length;
  await act(async () => { first.resolve({ workspaceSessionId: 'older', session: scanned('older').session }); await one; });
  assert.equal(h.current().workspace?.workspaceSessionId, 'original'); assert.deepEqual(p.remounts, []);
  assert.equal(p.statuses.length, statuses, 'An obsolete remount must not report that its base is mounted');
  await act(async () => { second.resolve({ workspaceSessionId: 'newer', session: scanned('newer').session }); await two; });
  assert.equal(h.current().workspace?.workspaceSessionId, 'newer'); assert.deepEqual(p.remounts, ['newer']);
});

it('a rejected current base remount retains its warning without a false mounted-success status', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => h.current().mountWorkspace('original', undefined, 'manual'));
  p.options.bridge!.remountBase = async () => { throw new Error('owned remount rejection'); };
  await act(async () => h.current().chooseBaseDirectory());
  assert.match(p.statuses.at(-1)!, /^重挂原版目录失败/); assert.match(p.toasts.at(-1)!, /owned remount rejection/);
});

it('base removal reports success only after its current native remount completes', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['remountBase']>>>();
  await act(async () => h.current().mountWorkspace('original', undefined, 'manual'));
  p.options.bridge!.remountBase = selectionId => { p.remountArgs.push(selectionId); return pending.promise; };
  const statuses = p.statuses.length, toasts = p.toasts.length;
  let clearing!: Promise<void>; await act(async () => { clearing = h.current().clearBaseDirectory(); });
  assert.deepEqual(p.remountArgs, [null]); assert.equal(p.statuses.length, statuses); assert.equal(p.toasts.length, toasts);
  await act(async () => { pending.resolve({ workspaceSessionId: 'cleared', session: scanned('cleared').session }); await clearing; });
  assert.deepEqual(p.remounts, ['cleared']); assert.equal(p.statuses.at(-1), '已卸载原版游戏目录（当前工作区保持打开）');
});

it('failed and superseded base removal never report an unload success', async () => {
  for (const terminal of ['failure', 'new-generation'] as const) {
    const p = ports(), h = await mount(p.options), pending = deferred<Awaited<ReturnType<NonNullable<WorkspaceOptions['bridge']>['remountBase']>>>();
    await act(async () => h.current().mountWorkspace('original', undefined, 'manual'));
    p.options.bridge!.remountBase = () => pending.promise;
    let clearing!: Promise<void>; await act(async () => { clearing = h.current().clearBaseDirectory(); });
    if (terminal === 'new-generation') await act(async () => h.current().mountWorkspace('new', undefined, 'manual'));
    const statuses = p.statuses.length, toasts = p.toasts.length;
    await act(async () => {
      if (terminal === 'failure') pending.reject(new Error('owned unload rejection'));
      else pending.resolve({ workspaceSessionId: 'obsolete', session: scanned('obsolete').session });
      await clearing;
    });
    assert.equal(p.statuses.some(message => message.startsWith('已卸载原版游戏目录')), false);
    if (terminal === 'failure') assert.match(p.statuses.at(-1)!, /^重挂原版目录失败/);
    else { assert.equal(p.statuses.length, statuses); assert.equal(p.toasts.length, toasts); assert.deepEqual(p.remounts, []); }
  }
});
