import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Children, isValidElement, type ReactElement, type ReactNode, type KeyboardEvent, type ChangeEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { DomainLibraryList, type DomainLibraryListProps } from '../navigation/DomainLibraryList.js';
import { NavigationSidebarViews, type NavigationSidebarViewsProps } from './NavigationSidebarViews.js';

// Real component element projection and server-rendered markup; event objects are
// synthetic. These checks do not claim mounted DOM, browser focus or native IPC.
interface NodeProps {
  children?: ReactNode; className?: string; ref?: unknown; 'data-panel-id'?: string;
  'aria-label'?: string; onClick?(): void; onChange?(event: ChangeEvent<HTMLInputElement>): void;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
}
function elements(node: ReactNode): ReactElement<NodeProps>[] {
  const all: ReactElement<NodeProps>[] = [];
  Children.forEach(node, child => { if (isValidElement<NodeProps>(child)) { all.push(child); all.push(...elements(child.props.children)); } });
  return all;
}
function file(index: number, source = 'index'): RendererIndexedFile {
  return { sourceUri: `resource://${source}/${index}`, relativePath: `event/shared-${index % 3}.emevd.dcx`,
    resourceKind: 'event', game: 'sekiro', parseStatus: 'partial', diagnostics: [], extension: '.dcx',
    compoundExtension: '.emevd.dcx', formatKind: 'emevd', formatLabel: 'EMEVD', size: 2048, mtimeMs: 1 };
}
function fixture() {
  const calls: unknown[][] = [], files = Array.from({ length: 81 }, (_, index) => file(index));
  const props: NavigationSidebarViewsProps = {
    navigation: { sidebarView: 'explorer', activeDomain: 'files', query: 'shared', setQuery: value => { calls.push(['query', value]); },
      physicalBrowseFiles: files, domainLibraries: files, domainGroups: undefined, indexedFiles: files, searchHits: files,
      search: async (...args) => { calls.push(['search', ...args]); } },
    resource: { selectedFile: files[1]!, selectFile: async (...args) => { calls.push(['select', ...args]); } },
    workspace: { workspaceSessionId: 'owned' }, isBrowserPreview: false,
    closeButton: <button className="owned-close" onClick={() => { calls.push(['close']); }}>Close</button>, searchInputRef: { current: null }
  };
  return { props, calls, files };
}
function node(props: NavigationSidebarViewsProps, label: string) {
  const found = elements(NavigationSidebarViews(props)).find(item => item.props['aria-label'] === label);
  assert.ok(found, label); return found;
}

it('keeps both panels mounted with existing classes and renders every physical and search row by logical source URI', () => {
  const { props, files } = fixture(), nodes = elements(NavigationSidebarViews(props));
  assert.equal(node(props, '资源浏览器').props.className, 'panel is-active');
  assert.equal(node(props, '搜索').props.className, 'panel');
  const physical = nodes.filter(item => item.props.className?.startsWith('file-item ') || item.props.className === 'file-item');
  const hits = nodes.filter(item => item.props.className === 'search-hit');
  assert.equal(physical.length, files.length); assert.equal(hits.length, files.length);
  assert.deepEqual(physical.map(item => item.key), files.map(item => item.sourceUri));
  assert.deepEqual(hits.map(item => item.key), files.map(item => item.sourceUri));
  assert.equal(physical[1]!.props.className, 'file-item selected');
  const html = renderToStaticMarkup(<NavigationSidebarViews {...props} />);
  assert.match(html, /文件 81 个/); assert.match(html, /EMEVD \| 2\.0 KB/);
  assert.equal((html.match(/class="owned-close"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /runtime-notice/);
});

it('forwards query, explicit close control and search ref; Enter prevents default and calls the original no-argument search', () => {
  const { props, calls, files } = fixture(), nodes = elements(NavigationSidebarViews(props));
  node(props, '过滤资源列表').props.onChange!({ target: { value: 'param' } } as ChangeEvent<HTMLInputElement>);
  const input = node(props, '在资源中搜索'); assert.equal(input.props.ref, props.searchInputRef);
  input.props.onChange!({ target: { value: 'event' } } as ChangeEvent<HTMLInputElement>);
  let prevented = 0;
  input.props.onKeyDown!({ key: 'Tab', preventDefault: () => { prevented++; } } as KeyboardEvent<HTMLInputElement>);
  input.props.onKeyDown!({ key: 'Enter', preventDefault: () => { prevented++; } } as KeyboardEvent<HTMLInputElement>);
  nodes.find(item => item.props.className === 'btn btn--ghost btn--sm')!.props.onClick!();
  const physical = nodes.find(item => item.key === files[80]!.sourceUri && item.props.className === 'file-item')!;
  const hit = nodes.find(item => item.key === files[80]!.sourceUri && item.props.className === 'search-hit')!;
  physical.props.onClick!(); hit.props.onClick!();
  const closes = nodes.filter(item => item.props.className === 'owned-close');
  assert.equal(closes[0], props.closeButton); assert.equal(closes[1], props.closeButton); closes[0]!.props.onClick!();
  assert.equal(prevented, 1);
  assert.deepEqual(calls, [['query', 'param'], ['query', 'event'], ['search'], ['search'], ['select', files[80]], ['select', files[80]], ['close']]);
});

it('preserves semantic list facts by identity and only resolves selection against the existing index', () => {
  const { props, calls, files } = fixture(); props.navigation = { ...props.navigation, activeDomain: 'event',
    domainGroups: [{ id: 'event', label: 'Events', files }] };
  Object.freeze(files); Object.freeze(props.navigation.domainGroups); Object.freeze(props.navigation);
  Object.freeze(props.resource.selectedFile); Object.freeze(props.resource); Object.freeze(props);
  const library = elements(NavigationSidebarViews(props)).find(item => item.type === DomainLibraryList);
  assert.ok(library && isValidElement<DomainLibraryListProps>(library));
  assert.equal(library.props.files, files); assert.equal(library.props.groups, props.navigation.domainGroups);
  assert.equal(library.props.selectedUri, files[1]!.sourceUri);
  assert.equal(library.props.emptyHint, '事件 工作区里还没有可打开的文件。可到「文件」领域按路径浏览。');
  library.props.onSelect({ ...files[1]!, formatLabel: 'Projected row label' });
  library.props.onSelect(file(1, 'unindexed'));
  assert.deepEqual(calls, [['select', files[1]]]);
  assert.doesNotMatch(renderToStaticMarkup(<NavigationSidebarViews {...props} />), /panel__hint/);
});

it('retains cold-start, workspace, preview, blank-query and no-hit hints without fabricating authority', () => {
  const { props } = fixture(); props.navigation = { ...props.navigation, physicalBrowseFiles: [], searchHits: [], query: '  ' };
  props.isBrowserPreview = true;
  let html = renderToStaticMarkup(<NavigationSidebarViews {...props} />);
  assert.match(html, /role="note"/); assert.match(html, /浏览器预览：文件系统功能仅在 SoulForge 桌面版可用/);
  assert.match(html, /当前目录没有匹配资源/); assert.match(html, /输入关键字，按路径/); assert.doesNotMatch(html, /无匹配结果/);
  props.navigation = { ...props.navigation, sidebarView: 'search', query: 'missing' };
  assert.equal(node(props, '搜索').props.className, 'panel is-active');
  html = renderToStaticMarkup(<NavigationSidebarViews {...props} />); assert.match(html, /无匹配结果/);
  props.navigation = { ...props.navigation, activeDomain: 'project' }; props.workspace = null;
  html = renderToStaticMarkup(<NavigationSidebarViews {...props} />);
  assert.match(html, /panel__hint">开始/); assert.match(html, /打开 Mod 工作区后，这里会列出该领域的可打开资源/);
  props.navigation = { ...props.navigation, activeDomain: 'text', domainLibraries: [], domainGroups: undefined };
  html = renderToStaticMarkup(<NavigationSidebarViews {...props} />); assert.match(html, /打开 Mod 工作区后，这里会列出该领域可打开的资源/);
  const library = elements(NavigationSidebarViews(props)).find(item => item.type === DomainLibraryList);
  assert.ok(library && isValidElement<DomainLibraryListProps>(library)); assert.equal(Object.hasOwn(library.props, 'groups'), false);
});
