import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Children, isValidElement, type ReactElement, type ReactNode, type ChangeEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { CommandPaletteView, type CommandPaletteViewProps } from './CommandPaletteView.js';

// The real view is called/rendered; event and HTMLElement inputs are synthetic
// identity sentinels. This is not mounted DOM/focus/keyboard or native coverage.
interface NodeProps {
  children?: ReactNode; className?: string; ref?: unknown; role?: string;
  'aria-modal'?: string; 'aria-label'?: string; value?: string;
  onClick?(): void; onChange?(event: ChangeEvent<HTMLInputElement>): void;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
  onMouseDown?(event: MouseEvent<HTMLDivElement>): void;
}
function elements(node: ReactNode): ReactElement<NodeProps>[] {
  const all: ReactElement<NodeProps>[] = [];
  Children.forEach(node, child => { if (isValidElement<NodeProps>(child)) { all.push(child); all.push(...elements(child.props.children)); } });
  return all;
}
function file(index: number): RendererIndexedFile {
  return { sourceUri: `resource://index/${index}`, relativePath: `event/shared-${index % 3}.emevd.dcx`,
    resourceKind: 'event', game: 'sekiro', parseStatus: 'partial', diagnostics: [], extension: '.dcx',
    compoundExtension: '.emevd.dcx', formatKind: 'emevd', formatLabel: 'EMEVD', size: 2048, mtimeMs: 1 };
}
function fixture() {
  const calls: unknown[][] = [], files = Array.from({ length: 81 }, (_, index) => file(index));
  let index = 1, query = 'owned';
  const props: CommandPaletteViewProps = {
    cmdkOpen: true, cmdkQuery: query, cmdkItemCount: 83, selectedCmdkIndex: 2,
    filteredCmdkCommands: [{ id: 'command-1', icon: '◧', label: 'Owned domain', run: (...args) => { calls.push(['command', ...args]); } },
      { id: 'command-2', icon: '⌕', label: 'Owned search', hint: '搜索', run: (...args) => { calls.push(['search', ...args]); } }],
    cmdkAllResourceMatches: files, workspace: { workspaceSessionId: 'owned' },
    selectFile: async (...args) => { calls.push(['select', ...args]); },
    shell: { cmdkInputRef: { current: null }, cmdkDialogRef: { current: null },
      setCmdkIndex: value => { index = typeof value === 'function' ? value(index) : value; calls.push(['index', index]); },
      closeCmdk: (...args) => { calls.push(['close', ...args]); },
      trapTabWithin: (...args) => { calls.push(['trap', ...args]); } },
    setCmdkQuery: value => { query = typeof value === 'function' ? value(query) : value; calls.push(['query', query]); },
    runCmdkItem: (...args) => { calls.push(['run-item', ...args]); }
  };
  return { props, calls, files, setIndex: (value: number) => { index = value; }, getIndex: () => index };
}
function node(props: CommandPaletteViewProps, className: string) {
  const found = elements(CommandPaletteView(props)).find(item => item.props.className === className);
  assert.ok(found, className); return found;
}
function input(props: CommandPaletteViewProps) {
  const found = elements(CommandPaletteView(props)).find(item => item.props['aria-label'] === '输入命令或搜索资源');
  assert.ok(found); return found;
}

it('preserves overlay/dialog/input props and every indexed match in supplied order without mutating frozen input', () => {
  const { props, files } = fixture(); Object.freeze(files); Object.freeze(props.filteredCmdkCommands);
  Object.freeze(props.workspace); Object.freeze(props.shell); Object.freeze(props);
  const dialog = node(props, 'cmdk'); assert.equal(dialog.props.role, 'dialog');
  assert.equal(dialog.props['aria-modal'], 'true'); assert.equal(dialog.props['aria-label'], '命令面板');
  assert.equal(dialog.props.ref, props.shell.cmdkDialogRef);
  assert.equal(input(props).props.ref, props.shell.cmdkInputRef); assert.equal(input(props).props.value, props.cmdkQuery);
  const rows = elements(CommandPaletteView(props)).filter(item => item.type === 'button');
  assert.equal(rows.length, 83); assert.deepEqual(rows.slice(2).map(item => item.key), files.map(item => item.sourceUri));
  assert.deepEqual(rows.slice(0, 2).map(item => item.key), ['command-1', 'command-2']);
  assert.equal(rows[2]!.props.className, 'cmdk-item is-selected');
  assert.equal(rows[82]!.props.className, 'cmdk-item');
  const html = renderToStaticMarkup(<CommandPaletteView {...props} />);
  assert.match(html, /class="cmdk-overlay is-open"/); assert.match(html, /autoComplete="off"/);
  assert.equal((html.match(/cmdk-item__hint/g) ?? []).length, 82);
  assert.doesNotMatch(html, /无匹配命令或资源/);
});

it('resets the actual index port after query change and wraps arrow keys against the full item count', () => {
  const { props, calls, setIndex, getIndex } = fixture(); let prevented = 0;
  const change = input(props).props.onChange!; change({ target: { value: 'next query' } } as ChangeEvent<HTMLInputElement>);
  assert.deepEqual(calls, [['query', 'next query'], ['index', 0]]); calls.length = 0;
  const key = (value: string) => input(props).props.onKeyDown!({ key: value, preventDefault: () => { prevented++; } } as KeyboardEvent<HTMLInputElement>);
  setIndex(82); key('ArrowDown'); assert.equal(getIndex(), 0);
  key('ArrowUp'); assert.equal(getIndex(), 82);
  key('Enter'); key('Tab');
  assert.deepEqual(calls, [['index', 0], ['index', 82], ['run-item', 2]]); assert.equal(prevented, 3);
  props.cmdkItemCount = 0; calls.length = 0;
  setIndex(82); key('ArrowDown'); key('ArrowUp'); assert.deepEqual(calls, [['index', 0], ['index', 0]]);
});

it('command and resource clicks close before forwarding unchanged no-argument/native-object actions', () => {
  const { props, calls, files } = fixture(), rows = elements(CommandPaletteView(props)).filter(item => item.type === 'button');
  rows[0]!.props.onClick!(); rows[1]!.props.onClick!(); rows[82]!.props.onClick!();
  assert.deepEqual(calls, [['close'], ['command'], ['close'], ['search'], ['close'], ['select', files[80]]]);
});

it('only backdrop self-click closes and dialog delegates the current shell ref and event to its existing trap', () => {
  const { props, calls } = fixture(), overlay = node(props, 'cmdk-overlay is-open');
  const backdrop = {} as HTMLDivElement, child = {} as HTMLDivElement;
  overlay.props.onMouseDown!({ target: child, currentTarget: backdrop } as unknown as MouseEvent<HTMLDivElement>);
  assert.deepEqual(calls, []);
  overlay.props.onMouseDown!({ target: backdrop, currentTarget: backdrop } as unknown as MouseEvent<HTMLDivElement>);
  const keyEvent = { key: 'Tab' } as KeyboardEvent<HTMLInputElement>;
  props.shell.cmdkDialogRef.current = child; node(props, 'cmdk').props.onKeyDown!(keyEvent);
  assert.deepEqual(calls, [['close'], ['trap', child, keyEvent]]);
});

it('keeps the hidden overlay mounted and preserves both empty-state hints and supplied selection clamp', () => {
  const { props } = fixture(); props.cmdkOpen = false; props.cmdkItemCount = 0;
  props.filteredCmdkCommands = []; props.cmdkAllResourceMatches = [];
  let html = renderToStaticMarkup(<CommandPaletteView {...props} />);
  assert.match(html, /class="cmdk-overlay"/); assert.match(html, /role="dialog"/); assert.match(html, /无匹配命令或资源/);
  props.workspace = null;
  html = renderToStaticMarkup(<CommandPaletteView {...props} />); assert.match(html, /请先打开 Mod 工作区；打开后可搜索资源/);
  props.filteredCmdkCommands = [{ id: 'last', icon: '⌘', label: 'Last command', run: () => {} }];
  props.cmdkItemCount = 1; props.selectedCmdkIndex = 0;
  assert.equal(elements(CommandPaletteView(props)).find(item => item.type === 'button')!.props.className, 'cmdk-item is-selected');
});
