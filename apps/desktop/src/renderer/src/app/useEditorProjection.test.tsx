import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act, createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { projectEditorSelection, projectIndexedAssets, useEditorProjection, type EditorProjection, type EditorProjectionOptions } from './useEditorProjection.js';

function file(relativePath: string, overrides: Partial<RendererIndexedFile> = {}): RendererIndexedFile {
  const extension = `.${relativePath.split('.').at(-1)}`;
  return { sourceUri: `resource://indexed/${relativePath}`, relativePath, resourceKind: 'other', game: 'sekiro',
    parseStatus: 'unparsed', diagnostics: [], extension, compoundExtension: extension, formatKind: 'unknown',
    formatLabel: extension, size: 80, mtimeMs: 1, ...overrides };
}
function options(overrides: Partial<EditorProjectionOptions> = {}): EditorProjectionOptions {
  return { navigation: { activeDomain: 'files', centerView: 'resource', resourceMode: 'all', bnd4Forced: false,
    preferredParamContainer: null }, document: { selectedFile: null, preview: null, canEditText: false, openTabs: [] },
    workspace: null, files: [], allFiles: [], fmgLive: false, bridge: null, ...overrides };
}

it('indexed assets preserve original index precedence, order, classification and bounded readonly projection', () => {
  const allFiles = Object.freeze([
    Object.freeze(file('param/z.GPARAM.DCX', { resourceKind: 'param' })),
    Object.freeze(file('texture/c.tpf.dcx')), Object.freeze(file('mtd/a.MTD')),
    Object.freeze(file('sfx/z.fxr')), Object.freeze(file('sfx/a.ffxbnd.dcx')),
    Object.freeze(file('texture/c.tpf.dcx.bak')), Object.freeze(file('mtd/a.mtd.dcx')),
    Object.freeze(file('sfx/a.fxr.bak')), Object.freeze(file('param/not-gparam.param'))
  ]);
  const files = Object.freeze([Object.freeze(file('fallback/visible.tpf'))]);
  const projection = projectIndexedAssets({ allFiles, files });
  assert.deepEqual(projection.gparamBanks, [{ sourceUri: allFiles[0]?.sourceUri, relativePath: 'param/z.GPARAM.DCX' }]);
  assert.deepEqual(projection.textureContainers.map(item => item.relativePath), ['texture/c.tpf.dcx']);
  assert.deepEqual(projection.materialFiles.map(item => item.relativePath), ['mtd/a.MTD']);
  assert.deepEqual(projection.vfxFiles.map(item => item.relativePath), ['sfx/z.fxr', 'sfx/a.ffxbnd.dcx']);
  for (const list of Object.values(projection)) for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ['relativePath', 'sourceUri']);
  }
  assert.deepEqual(projectIndexedAssets({ allFiles: [], files }).textureContainers,
    [{ sourceUri: files[0]?.sourceUri, relativePath: 'fallback/visible.tpf' }]);
});

it('selection preserves the original projected fields, explicit-open and preview precedence', () => {
  const selectedFile = Object.freeze(file('param/native.gparam.dcx', { formatKind: 'gparam',
    artifactMarkers: { artifactRole: 'backup' } }));
  const original = options({ document: { selectedFile, preview: null, canEditText: false, openTabs: [selectedFile] } });
  assert.equal(projectEditorSelection(original).activeEditor, 'gparam');
  assert.equal(projectEditorSelection(original).showBnd4Workbench, false);
  const forced = projectEditorSelection({ ...original, navigation: { ...original.navigation, bnd4Forced: true } });
  assert.equal(forced.activeEditor, 'container'); assert.equal(forced.showBnd4Workbench, true);
  for (const centerView of ['project', 'operations', 'settings']) {
    const navigation: EditorProjectionOptions['navigation'] = { ...original.navigation,
      centerView: centerView === 'project' ? 'project' : centerView === 'operations' ? 'operations' : 'settings' };
    assert.equal(projectEditorSelection({ ...original, navigation }).activeEditor, centerView);
  }
  const plain = file('notes/custom.txt');
  const preview: NonNullable<EditorProjectionOptions['document']['preview']> = {
    file: plain, previewKind: 'text', text: 'bounded preview', truncated: false, bytesRead: 15, diagnostics: []
  };
  assert.equal(projectEditorSelection(options({ document: { selectedFile: plain, preview, canEditText: true, openTabs: [] } })).activeEditor, 'plain-text');
  assert.equal(projectEditorSelection(options({ document: { selectedFile: plain, preview, canEditText: false, openTabs: [] } })).activeEditor, 'binary');
});

it('material and VFX filename corrections keep the declared classifier and exclude backups/compressed MTD', () => {
  const base = options();
  const cases = [
    { path: 'mtd/native.MTD', material: true, vfx: false },
    { path: 'mtd/native.mtd.dcx', material: false, vfx: false },
    { path: 'mtd/native.mtd.bak', material: false, vfx: false },
    { path: 'sfx/native.fxr.dcx', material: false, vfx: true },
    { path: 'sfx/native.ffxbnd.dcx', material: false, vfx: true },
    { path: 'sfx/native.fxr.bak', material: false, vfx: false }
  ];
  for (const item of cases) {
    const projection = projectEditorSelection({ ...base, document: { ...base.document, selectedFile: file(item.path) } });
    assert.equal(projection.isMaterialFile, item.material); assert.equal(projection.isVfxFile, item.vfx);
  }
  assert.equal(projectEditorSelection(base).isMaterialFile, false); assert.equal(projectEditorSelection(base).isVfxFile, false);
});

it('Param target keeps the selected container and limits preferred fallback to the empty Param domain', () => {
  const preferred = file('param/preferred.parambnd.dcx'), selectedFile = file('param/selected.parambnd.dcx');
  const base = options();
  const navigation: EditorProjectionOptions['navigation'] = { ...base.navigation, activeDomain: 'param', preferredParamContainer: preferred };
  assert.equal(projectEditorSelection({ ...base, navigation }).paramWorkbenchFile, preferred);
  assert.equal(projectEditorSelection({ ...base, navigation, document: { ...base.document, selectedFile } }).paramWorkbenchFile, selectedFile);
  assert.equal(projectEditorSelection({ ...base, navigation: { ...navigation, activeDomain: 'gparam' } }).paramWorkbenchFile, null);
  assert.equal(projectEditorSelection({ ...base, navigation: { ...navigation, centerView: 'settings' } }).paramWorkbenchFile, null);
});

it('text/event domain hosts and welcome flags retain workspace/tab and live capability guards without invoking ports', () => {
  const base = options();
  const workspace = { workspaceSessionId: 'mounted' };
  const textNavigation: EditorProjectionOptions['navigation'] = { ...base.navigation, activeDomain: 'text' };
  let calls = 0;
  const unavailable = async (): Promise<never> => { calls++; throw new Error('projection must not perform reads'); };
  const bridge: NonNullable<EditorProjectionOptions['bridge']> = { readTextCatalog: unavailable, readFmgTablePage: unavailable };
  assert.equal(projectEditorSelection({ ...base, navigation: textNavigation }).showTextWorkbench, false);
  const text = projectEditorSelection({ ...base, navigation: textNavigation, workspace, bridge });
  assert.equal(text.showTextWorkbench, true); assert.equal(text.fmgPanelLive, true); assert.equal(text.showEditorWelcome, false);
  assert.equal(projectEditorSelection({ ...base, navigation: textNavigation, bridge: { readTextCatalog: unavailable } }).fmgPanelLive, false);
  assert.equal(projectEditorSelection({ ...base, fmgLive: true }).fmgPanelLive, true);
  const eventNavigation: EditorProjectionOptions['navigation'] = { ...base.navigation, activeDomain: 'event' };
  assert.equal(projectEditorSelection({ ...base, navigation: eventNavigation, workspace }).showEventWorkbench, true);
  assert.equal(projectEditorSelection({ ...base, navigation: eventNavigation }).showEventWorkbench, false);
  assert.equal(projectEditorSelection(base).showEditorWelcome, true);
  assert.equal(projectEditorSelection({ ...base, navigation: { ...base.navigation, activeDomain: 'project' } }).showEditorWelcome, false);
  assert.equal(projectEditorSelection({ ...base, document: { ...base.document, openTabs: [file('open.txt')] } }).showEditorWelcome, false);
  assert.equal(calls, 0);
});

it('hook memoization retains indexed list references across document changes and refreshes on index replacement', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let current: EditorProjection | null = null;
  function Host({ input }: { input: EditorProjectionOptions }) { current = useEditorProjection(input); return null; }
  function read(): EditorProjection { assert.ok(current); return current; }
  const initial = options({ allFiles: Object.freeze([Object.freeze(file('param/a.gparam')), Object.freeze(file('texture/a.tpf'))]) });
  let renderer: ReturnType<typeof TestRenderer.create> | null = null;
  try {
    await act(async () => { renderer = TestRenderer.create(createElement(Host, { input: initial })); });
    const first = read();
    const switched = { ...initial, document: { ...initial.document, selectedFile: file('texture/a.tpf') } };
    await act(async () => { renderer?.update(createElement(Host, { input: switched })); });
    const second = read();
    assert.equal(second.activeEditor, 'tpf'); assert.equal(second.gparamBanks, first.gparamBanks);
    assert.equal(second.textureContainers, first.textureContainers); assert.equal(second.materialFiles, first.materialFiles);
    assert.equal(second.vfxFiles, first.vfxFiles);
    await act(async () => { renderer?.update(createElement(Host, { input: { ...switched, allFiles: [file('param/b.gparam')] } })); });
    assert.notEqual(read().gparamBanks, first.gparamBanks);
    assert.deepEqual(read().gparamBanks.map(item => item.relativePath), ['param/b.gparam']);
    assert.deepEqual(read().textureContainers, []);
  } finally {
    await act(async () => { renderer?.unmount(); });
  }
});
