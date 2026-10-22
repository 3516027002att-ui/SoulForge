import assert from 'node:assert/strict';
import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { it } from 'node:test';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import type { EditorId } from '../workbench/selectEditor.js';
import { AssetEditorView, type AssetEditorViewProps } from './AssetEditorView.js';
import { GparamWorkbench } from '../workbench/GparamWorkbench.js';
import { TpfWorkbenchPanel } from '../editors/TpfWorkbenchPanel.js';
import { MaterialWorkbenchPanel } from '../editors/MaterialWorkbenchPanel.js';
import { VfxWorkbenchPanel } from '../editors/VfxWorkbenchPanel.js';
import { TaeWorkbenchPanel } from '../editors/TaeWorkbenchPanel.js';
import { EsdWorkbenchPanel } from '../editors/EsdWorkbenchPanel.js';
import { FlverWorkbenchPanel } from '../editors/FlverWorkbenchPanel.js';

function elements(node: ReactNode): ReactElement[] {
  const result: ReactElement[] = [];
  Children.forEach(node, child => {
    if (isValidElement<{ children?: ReactNode }>(child)) { result.push(child); result.push(...elements(child.props.children)); }
  });
  return result;
}
function text(node: ReactNode): string {
  let result = '';
  Children.forEach(node, child => {
    if (typeof child === 'string' || typeof child === 'number') result += child;
    else if (isValidElement<{ children?: ReactNode }>(child)) result += text(child.props.children);
  });
  return result;
}
function file(relativePath: string): RendererIndexedFile {
  const extension = `.${relativePath.split('.').at(-1)}`;
  return { sourceUri: `resource://indexed/${relativePath}`, relativePath, resourceKind: 'other', game: 'sekiro',
    parseStatus: 'unparsed', diagnostics: [], extension, compoundExtension: extension, formatKind: 'unknown',
    formatLabel: extension, size: 80, mtimeMs: 1 };
}
function props(overrides: Partial<AssetEditorViewProps> = {}): AssetEditorViewProps {
  return { activeEditor: 'empty', activeDomain: 'files', selectedFile: null, isMaterialFile: false, isVfxFile: false,
    gparamBanks: [], textureContainers: [], materialFiles: [], vfxFiles: [], paramWorkbenchFile: null,
    showTextWorkbench: false, showEventWorkbench: false, domainLibraries: [],
    document: { taeData: null, esdData: null, flverData: null, applyFlverMaterialSlotSetAndReload: async () => ({ ok: false, changedFiles: [], diagnostics: [] }) },
    ...overrides };
}

it('GPARAM and TPF selected views retain original keys, list identity and conditional initial URI', () => {
  const selectedFile = Object.freeze(file('owned/resource.gparam'));
  const gparamBanks = [{ sourceUri: selectedFile.sourceUri, relativePath: selectedFile.relativePath }];
  const textureContainers = [{ sourceUri: 'resource://owned/textures', relativePath: 'owned/textures.tpf' }];
  const base = props({ selectedFile, gparamBanks, textureContainers });
  const gparam = elements(AssetEditorView({ ...base, activeEditor: 'gparam' })).find(node => node.type === GparamWorkbench);
  assert.ok(gparam && isValidElement<ComponentProps<typeof GparamWorkbench>>(gparam));
  assert.equal(gparam.key, `gparam-wb:${selectedFile.sourceUri}`); assert.equal(gparam.props.banks, gparamBanks);
  assert.equal(gparam.props.initialUri, selectedFile.sourceUri);
  const tpf = elements(AssetEditorView({ ...base, activeEditor: 'tpf' })).find(node => node.type === TpfWorkbenchPanel);
  assert.ok(tpf && isValidElement<ComponentProps<typeof TpfWorkbenchPanel>>(tpf));
  assert.equal(tpf.key, `tpf-wb:${selectedFile.sourceUri}`); assert.equal(tpf.props.containers, textureContainers);
  assert.equal(tpf.props.initialUri, selectedFile.sourceUri);
  for (const activeEditor of ['gparam', 'tpf']) {
    const noSelection = props({ activeEditor: activeEditor === 'gparam' ? 'gparam' : 'tpf' });
    const panel = elements(AssetEditorView(noSelection)).find(node => node.type === GparamWorkbench || node.type === TpfWorkbenchPanel);
    assert.ok(panel && isValidElement<{ initialUri?: string }>(panel));
    assert.equal(panel.key, `${activeEditor === 'gparam' ? 'gparam' : 'tpf'}-wb:none`);
    assert.equal(Object.hasOwn(panel.props, 'initialUri'), false);
  }
});

it('empty asset domains retain original indexed keys, list references and no initial selection', () => {
  const first = { sourceUri: 'resource://owned/first', relativePath: 'first' }, second = { sourceUri: 'resource://owned/second', relativePath: 'second' };
  const list = [first, second];
  const cases: Array<{ activeDomain: AssetEditorViewProps['activeDomain']; panel: unknown; prefix: string; listProp: string }> = [
    { activeDomain: 'gparam', panel: GparamWorkbench, prefix: 'gparam', listProp: 'banks' },
    { activeDomain: 'texture', panel: TpfWorkbenchPanel, prefix: 'tpf', listProp: 'containers' },
    { activeDomain: 'material', panel: MaterialWorkbenchPanel, prefix: 'mtd', listProp: 'files' },
    { activeDomain: 'vfx', panel: VfxWorkbenchPanel, prefix: 'vfx', listProp: 'files' }
  ];
  for (const item of cases) {
    const nodes = elements(AssetEditorView(props({ activeDomain: item.activeDomain, gparamBanks: list, textureContainers: list, materialFiles: list, vfxFiles: list })));
    const panel = nodes.find(node => node.type === item.panel);
    assert.ok(panel && isValidElement<Record<string, unknown>>(panel));
    assert.equal(panel.key, `${item.prefix}-wb:${first.sourceUri},${second.sourceUri}`);
    assert.equal(panel.props[item.listProp], list); assert.equal(Object.hasOwn(panel.props, 'initialUri'), false);
    assert.equal(nodes.some(node => node.type === 'section' || node.type === 'p'), false);
  }
});

it('empty asset placeholders retain original class, accessible label, test ID and copy', () => {
  const cases: Array<{ activeDomain: AssetEditorViewProps['activeDomain']; id: string; label: string; heading: string; message: string }> = [
    { activeDomain: 'gparam', id: 'gparam-placeholder', label: 'GPARAM 工作域', heading: 'GPARAM 工作台', message: '工作区中没有 GPARAM 文件。挂载包含 drawparam 的 Mod 工作区后这里会列出所有 bank。' },
    { activeDomain: 'texture', id: 'texture-placeholder', label: '纹理工作域', heading: 'Texture 工作台', message: '工作区中没有 TPF 文件。挂载包含纹理包的 Mod 工作区后这里会列出所有容器。' },
    { activeDomain: 'material', id: 'material-placeholder', label: '材质工作域', heading: 'Material 工作台', message: '工作区中没有 MTD 文件。挂载包含材质定义的 Mod 工作区后这里会列出所有文件。' },
    { activeDomain: 'vfx', id: 'vfx-placeholder', label: 'VFX 工作域', heading: 'VFX 工作台', message: '工作区中没有 FXR 文件。挂载包含特效文件（.fxr）的 Mod 工作区后这里会列出所有特效条目。' }
  ];
  for (const item of cases) {
    const nodes = elements(AssetEditorView(props({ activeDomain: item.activeDomain })));
    const section = nodes.find(node => node.type === 'section');
    assert.ok(section && isValidElement<{ className: string; 'data-testid': string; 'aria-label': string }>(section));
    assert.equal(section.props.className, 'domain-placeholder'); assert.equal(section.props['data-testid'], item.id);
    assert.equal(section.props['aria-label'], item.label);
    assert.equal(text(nodes.find(node => node.type === 'h2')), item.heading); assert.equal(text(nodes.find(node => node.type === 'p')), item.message);
  }
});

it('TAE/ESD/FLVER preserve unvalidated legacy data identity, exact remount and material mutation input', () => {
  const selectedFile = Object.freeze(file('chr/native.flver'));
  const native = Object.freeze({ authority: 'partial', ownedLegacyProjection: true });
  const calls: unknown[] = [];
  const document: AssetEditorViewProps['document'] = { taeData: native, esdData: native, flverData: native,
    applyFlverMaterialSlotSetAndReload: async input => { calls.push(input); return { ok: false, changedFiles: [], diagnostics: [] }; } };
  const editors: EditorId[] = ['tae', 'esd', 'flver'];
  for (const activeEditor of editors) {
    const nodes = elements(AssetEditorView(props({ activeEditor, selectedFile, document })));
    const panel = nodes.find(node => node.type === TaeWorkbenchPanel || node.type === EsdWorkbenchPanel || node.type === FlverWorkbenchPanel);
    assert.ok(panel && isValidElement<{ resourceUri: string; data: unknown; onMaterialSlotSet?: (input: { meshStableId: string; materialStableId: string }) => void }>(panel));
    assert.equal(panel.props.resourceUri, selectedFile.sourceUri); assert.equal(panel.props.data, native);
    assert.equal(panel.key, activeEditor === 'flver' ? `flver-wb:${selectedFile.sourceUri}:true` : null);
    if (activeEditor === 'flver') {
      const input = Object.freeze({ meshStableId: 'mesh:7', materialStableId: 'material:2' });
      panel.props.onMaterialSlotSet?.(input); assert.equal(calls[0], input);
    }
  }
  const unloaded = elements(AssetEditorView(props({ activeEditor: 'flver', selectedFile }))).find(node => node.type === FlverWorkbenchPanel);
  assert.ok(unloaded && isValidElement<ComponentProps<typeof FlverWorkbenchPanel>>(unloaded));
  assert.equal(unloaded.key, `flver-wb:${selectedFile.sourceUri}:false`); assert.equal(unloaded.props.data, null);
  for (const activeEditor of editors) {
    const nodes = elements(AssetEditorView(props({ activeEditor })));
    assert.equal(nodes.some(node => node.type === TaeWorkbenchPanel || node.type === EsdWorkbenchPanel || node.type === FlverWorkbenchPanel), false);
  }
});

it('selected VFX and binary material/VFX corrections preserve keys, props and exclude generic fallback', () => {
  const selectedFile = file('sfx/selected.fxr'), list = [{ sourceUri: selectedFile.sourceUri, relativePath: selectedFile.relativePath }];
  const cases: Array<Partial<AssetEditorViewProps>> = [
    { activeEditor: 'vfx' }, { activeEditor: 'binary', isVfxFile: true }, { activeEditor: 'binary', isMaterialFile: true }
  ];
  for (const item of cases) {
    const nodes = elements(AssetEditorView(props({ ...item, selectedFile, materialFiles: list, vfxFiles: list })));
    const panel = nodes.find(node => node.type === MaterialWorkbenchPanel || node.type === VfxWorkbenchPanel);
    assert.ok(panel && isValidElement<ComponentProps<typeof MaterialWorkbenchPanel>>(panel));
    assert.equal(panel.key, `${item.isMaterialFile ? 'mtd' : 'vfx'}-wb:${selectedFile.sourceUri}`);
    assert.equal(panel.props.files, list); assert.equal(panel.props.initialUri, selectedFile.sourceUri);
    assert.equal(nodes.some(node => node.type === 'p'), false);
  }
});

it('binary fallback retains scope/parser explanations and hides history artifacts', () => {
  const cases = [
    ['chr/animation.behbnd.dcx', '当前版本暂不支持 HKX 语义解析。'],
    ['data/unknown.btl.dcx', '这个格式还没有确认过的 parser，不能声称已经读懂。'],
    ['data/unknown.bin', '这个格式还没有专用编辑器。']
  ];
  for (const item of cases) {
    const [path, expected] = item; assert.ok(path);
    const nodes = elements(AssetEditorView(props({ activeEditor: 'binary', selectedFile: file(path) })));
    const fallback = nodes.find(node => node.type === 'p'); assert.ok(fallback && isValidElement<{ className: string }>(fallback));
    assert.equal(fallback.props.className, 'muted'); assert.equal(text(fallback), expected);
  }
  assert.equal(text(AssetEditorView(props({ activeEditor: 'binary' }))), '这个格式还没有专用编辑器。');
  assert.equal(text(AssetEditorView(props({ activeEditor: 'binary', selectedFile: file('data/old.bin.bak') }))), '');
});

it('generic empty fallback keeps file/library copy and respects Param/Text/Event host ownership', () => {
  assert.equal(text(AssetEditorView(props())), '在左侧选择一个文件开始编辑。');
  const animation = elements(AssetEditorView(props({ activeDomain: 'animation' })));
  const section = animation.find(node => node.type === 'section');
  assert.ok(section && isValidElement<{ 'data-testid': string; 'aria-label': string }>(section));
  assert.equal(section.props['data-testid'], 'domain-editor-placeholder'); assert.equal(section.props['aria-label'], '动画 工作域');
  assert.equal(text(animation.find(node => node.type === 'p')), '从左侧选择一个文件开始编辑，可到「文件」领域按路径浏览。');
  const withLibrary = elements(AssetEditorView(props({ activeDomain: 'animation', domainLibraries: [file('chr/a.anibnd.dcx')] })));
  assert.equal(text(withLibrary.find(node => node.type === 'p')), '从左侧选择已打开的资源，或按 Ctrl K 搜索。');
  for (const override of [{ paramWorkbenchFile: file('param/a.parambnd.dcx') }, { showTextWorkbench: true }, { showEventWorkbench: true }]) {
    assert.equal(text(AssetEditorView(props(override))), '');
  }
  const outsideEditors: EditorId[] = ['plain-text', 'map', 'text', 'event', 'param-container', 'param-rows', 'project', 'operations', 'settings', 'script', 'container'];
  const ownedPanels = new Set<unknown>([GparamWorkbench, TpfWorkbenchPanel, MaterialWorkbenchPanel, VfxWorkbenchPanel, TaeWorkbenchPanel, EsdWorkbenchPanel, FlverWorkbenchPanel]);
  for (const activeEditor of outsideEditors) {
    const nodes = elements(AssetEditorView(props({ activeEditor })));
    assert.equal(nodes.some(node => typeof node.type === 'function' && ownedPanels.has(node.type)), false);
    assert.equal(nodes.some(node => node.type === 'p' || node.type === 'section'), false);
  }
});
