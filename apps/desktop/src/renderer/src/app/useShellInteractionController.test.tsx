import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import React, { act, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import {
  useShellInteractionController,
  type ShellInteractionController,
  type ShellInteractionOptions
} from './useShellInteractionController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// These are deliberately small synthetic DOM ports. They exercise the mounted hook's
// actual callbacks, not browser layout, Electron, IPC, native parsing or provider setup.
type SyntheticEvent = { prevented: number; preventDefault(): void };
type Listener = (event: any) => void;
class SyntheticEventTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly additions: Array<{ type: string; listener: Listener; options: unknown }> = [];
  readonly removals: Array<{ type: string; listener: Listener }> = [];
  addEventListener(type: string, listener: Listener, options?: unknown): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
    this.additions.push({ type, listener, options });
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
    this.removals.push({ type, listener });
  }
  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
  count(type: string): number { return this.listeners.get(type)?.size ?? 0; }
}
class SyntheticElement extends SyntheticEventTarget {
  scrollLeft = 0;
  connected = true;
  focusCount = 0;
  isContentEditable = false;
  composerAncestor = false;
  hiddenAncestor = false;
  readonly attributes = new Map<string, string>();
  children: SyntheticElement[] = [];
  queriedSelector: string | null = null;
  constructor(readonly tagName = 'DIV') { super(); }
  focus(): void { this.focusCount++; syntheticDocument.activeElement = this; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  closest(selector: string): SyntheticElement | null {
    return (selector === '.agent__composer' && this.composerAncestor)
      || (selector === '[aria-hidden="true"]' && this.hiddenAncestor) ? this : null;
  }
  querySelectorAll(selector: string): SyntheticElement[] { this.queriedSelector = selector; return this.children; }
}
class SyntheticWindow extends SyntheticEventTarget {
  now = 0;
  private nextTimer = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delay: number): number {
    const id = ++this.nextTimer;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  advance(milliseconds: number): void {
    const end = this.now + milliseconds;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.now = end;
  }
}
let syntheticWindow: SyntheticWindow;
let syntheticDocument: { activeElement: SyntheticElement | null; contains(element: SyntheticElement): boolean };
const mounted: ReactTestRenderer[] = [];
beforeEach(() => {
  syntheticWindow = new SyntheticWindow();
  syntheticDocument = { activeElement: null, contains: element => element.connected };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: syntheticWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: syntheticDocument });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: SyntheticElement });
});
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});
function event<T extends object>(values: T): T & SyntheticEvent {
  return { ...values, prevented: 0, preventDefault() { this.prevented++; } };
}
function keyboard(key: string, values: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; target: unknown }> = {}) {
  return event({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null, ...values });
}
function pointer(target: SyntheticElement, clientX: number, button = 0): ReactPointerEvent<HTMLDivElement> & SyntheticEvent {
  return event({ currentTarget: target, clientX, button }) as unknown as ReactPointerEvent<HTMLDivElement> & SyntheticEvent;
}
type InputOptions = Pick<ShellInteractionOptions, 'activeDomain' | 'pendingChangeCount' | 'hasUncommittedChanges' | 'showSidebarView'> & {
  sidebarCollapsed?: boolean; cmdkOpen?: boolean; cmdkQuery?: string;
};
function ports() {
  const sidebarViews: string[] = [];
  const options: InputOptions = { activeDomain: 'project', pendingChangeCount: 0, hasUncommittedChanges: false,
    showSidebarView: view => sidebarViews.push(view) };
  return { options, sidebarViews };
}
async function mount(options: InputOptions, strict = false) {
  let current!: ShellInteractionController;
  let layout!: { sidebarCollapsed: boolean; cmdkOpen: boolean; cmdkQuery: string; agentOpen: boolean };
  const shell = new SyntheticElement(), tabbar = new SyntheticElement(), search = new SyntheticElement('INPUT');
  const cmdkInput = new SyntheticElement('INPUT'), cmdkDialog = new SyntheticElement();
  function Host({ options }: { options: InputOptions }) {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(options.sidebarCollapsed ?? false);
    const [cmdkOpen, setCmdkOpen] = useState(options.cmdkOpen ?? false);
    const [cmdkQuery, setCmdkQuery] = useState(options.cmdkQuery ?? '');
    const [agentOpen, setAgentOpen] = useState(false);
    current = useShellInteractionController({ ...options, sidebarCollapsed, setSidebarCollapsed, cmdkOpen,
      setCmdkOpen, cmdkQuery, setCmdkQuery, setAgentOpen });
    layout = { sidebarCollapsed, cmdkOpen, cmdkQuery, agentOpen };
    return <div ref={current.shellRef}><div id="tabbar" ref={current.tabbarRef} />
      <input id="search" ref={current.searchInputRef} /><div id="cmdk-dialog" ref={current.cmdkDialogRef}>
        <input id="cmdk-input" ref={current.cmdkInputRef} /></div></div>;
  }
  const element = (value: InputOptions) => strict ? <React.StrictMode><Host options={value} /></React.StrictMode> : <Host options={value} />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(options), { createNodeMock: element => {
    switch ((element.props as { id?: string }).id) {
      case 'tabbar': return tabbar;
      case 'search': return search;
      case 'cmdk-dialog': return cmdkDialog;
      case 'cmdk-input': return cmdkInput;
      default: return shell;
    }
  } }); });
  mounted.push(renderer);
  return { current: () => current, layout: () => layout, shell, tabbar, search, cmdkInput, cmdkDialog,
    update: async (next: InputOptions) => act(async () => renderer.update(element(next))),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); } };
}
async function advance(milliseconds: number): Promise<void> { await act(async () => syntheticWindow.advance(milliseconds)); }
async function dispatch(key: ReturnType<typeof keyboard>): Promise<void> { await act(async () => syntheticWindow.emit('keydown', key)); }

it('preserves shell defaults and command opening reset with the 30ms input focus and deferred return focus', async () => {
  const p = ports(), h = await mount({ ...p.options, cmdkQuery: 'previous' });
  assert.equal(h.current().sidebarWidth, 264);
  assert.equal(h.current().workspaceSwitcherOpen, false);
  assert.equal(h.current().cmdkIndex, 0);
  assert.deepEqual(h.current().toasts, []);
  assert.equal(h.current().shellRef.current, h.shell);
  assert.equal(h.current().cmdkDialogRef.current, h.cmdkDialog);
  const trigger = new SyntheticElement('BUTTON'); trigger.focus();
  await act(async () => { h.current().setCmdkIndex(5); h.current().setWorkspaceSwitcherOpen(true); });
  await act(async () => h.current().openCmdk());
  assert.equal(h.layout().cmdkOpen, true); assert.equal(h.layout().cmdkQuery, '');
  assert.equal(h.current().cmdkIndex, 0); assert.equal(h.current().workspaceSwitcherOpen, true);
  await advance(29); assert.equal(h.cmdkInput.focusCount, 0);
  await advance(1); assert.equal(syntheticDocument.activeElement, h.cmdkInput);
  await act(async () => h.current().closeCmdk());
  assert.equal(h.layout().cmdkOpen, false); assert.equal(trigger.focusCount, 1);
  await advance(0); assert.equal(syntheticDocument.activeElement, trigger); assert.equal(trigger.focusCount, 2);
});

it('returns focus only to a connected opening target and tolerates an absent opening target', async () => {
  const h = await mount(ports().options), trigger = new SyntheticElement('BUTTON'); trigger.focus();
  await act(async () => h.current().openCmdk()); await advance(30); trigger.connected = false;
  await act(async () => h.current().closeCmdk()); await advance(0); assert.equal(trigger.focusCount, 1);
  syntheticDocument.activeElement = null;
  await act(async () => h.current().openCmdk()); await advance(30);
  await act(async () => h.current().closeCmdk()); await advance(0);
  assert.equal(h.layout().cmdkOpen, false);
});

it('mounted keyboard listener owns Ctrl/Meta shell keys in editable targets and leaves domain keys to workbenches', async () => {
  const p = ports(), h = await mount(p.options), trigger = new SyntheticElement('TEXTAREA'); trigger.focus();
  assert.equal(syntheticWindow.count('keydown'), 1);
  const open = keyboard('K', { ctrlKey: true, target: trigger }); await dispatch(open);
  assert.equal(open.prevented, 1); assert.equal(h.layout().cmdkOpen, true); await advance(30);
  const close = keyboard('k', { metaKey: true, target: h.cmdkInput }); await dispatch(close);
  assert.equal(close.prevented, 1); assert.equal(h.layout().cmdkOpen, false); await advance(0);
  assert.equal(syntheticDocument.activeElement, trigger);
  const composer = new SyntheticElement(); composer.composerAncestor = true;
  const agent = keyboard('j', { ctrlKey: true, target: composer }); await dispatch(agent);
  assert.equal(agent.prevented, 1); assert.equal(h.layout().agentOpen, true);
  const sidebar = keyboard('b', { metaKey: true, target: trigger }); await dispatch(sidebar);
  assert.equal(sidebar.prevented, 1); assert.equal(h.layout().sidebarCollapsed, true);
  await h.update({ ...p.options, activeDomain: 'event' });
  const save = keyboard('s', { ctrlKey: true }), find = keyboard('f', { ctrlKey: true, target: trigger });
  await dispatch(save); await dispatch(find); assert.equal(save.prevented, 0); assert.equal(find.prevented, 0);
  await dispatch(keyboard('k', { ctrlKey: true })); await advance(30);
  const escape = keyboard('Escape'); await dispatch(escape); await advance(0);
  assert.equal(h.layout().cmdkOpen, false); assert.equal(escape.prevented, 0);
  await h.unmount(); assert.equal(syntheticWindow.count('keydown'), 0);
});

it('trap callback filters disabled and hidden descendants and wraps Tab focus through the actual element ports', async () => {
  const h = await mount(ports().options), first = new SyntheticElement('INPUT'), last = new SyntheticElement('BUTTON');
  const disabled = new SyntheticElement('BUTTON'); disabled.attributes.set('disabled', '');
  const hidden = new SyntheticElement('BUTTON'); hidden.hiddenAncestor = true;
  const excluded = new SyntheticElement('DIV'); excluded.attributes.set('tabindex', '-1');
  h.cmdkDialog.children = [first, disabled, hidden, excluded, last]; last.focus();
  const tab = keyboard('Tab'); h.current().trapTabWithin(h.current().cmdkDialogRef.current, tab as unknown as ReactKeyboardEvent);
  assert.equal(tab.prevented, 1); assert.equal(syntheticDocument.activeElement, first);
  const reverse = keyboard('Tab', { shiftKey: true }); h.current().trapTabWithin(h.current().cmdkDialogRef.current, reverse as unknown as ReactKeyboardEvent);
  assert.equal(reverse.prevented, 1); assert.equal(syntheticDocument.activeElement, last);
  assert.match(h.cmdkDialog.queriedSelector!, /input:not\(\[disabled\]\)/);
  syntheticDocument.activeElement = null;
  const enter = keyboard('Enter'); h.current().trapTabWithin(h.current().cmdkDialogRef.current, enter as unknown as ReactKeyboardEvent);
  assert.equal(enter.prevented, 0);
  h.cmdkDialog.children = [disabled, hidden];
  const empty = keyboard('Tab'); h.current().trapTabWithin(h.current().cmdkDialogRef.current, empty as unknown as ReactKeyboardEvent);
  h.current().trapTabWithin(null, empty as unknown as ReactKeyboardEvent); assert.equal(empty.prevented, 0);
});

it('focus-search opens the sidebar and search view before the 0ms focus callback', async () => {
  const p = ports(), h = await mount({ ...p.options, sidebarCollapsed: true });
  await act(async () => h.current().focusSearchPanel());
  assert.equal(h.layout().sidebarCollapsed, false); assert.deepEqual(p.sidebarViews, ['search']);
  assert.equal(h.search.focusCount, 0); await advance(0); assert.equal(h.search.focusCount, 1);
});

it('sidebar resize preserves the latest starting width and the 44..480 clamp until pointerup removes listeners', async () => {
  const h = await mount(ports().options);
  await act(async () => h.current().startSidebarResize(pointer(h.shell, 100)));
  assert.equal(syntheticWindow.count('pointermove'), 1); assert.equal(syntheticWindow.count('pointerup'), 1);
  await act(async () => syntheticWindow.emit('pointermove', { clientX: 180 })); assert.equal(h.current().sidebarWidth, 344);
  await act(async () => syntheticWindow.emit('pointermove', { clientX: -1000 })); assert.equal(h.current().sidebarWidth, 44);
  await act(async () => syntheticWindow.emit('pointermove', { clientX: 2000 })); assert.equal(h.current().sidebarWidth, 480);
  await act(async () => syntheticWindow.emit('pointerup', {}));
  assert.equal(syntheticWindow.count('pointermove'), 0); assert.equal(syntheticWindow.count('pointerup'), 0);
  await act(async () => h.current().setSidebarWidth(200));
  await act(async () => h.current().startSidebarResize(pointer(h.shell, 50)));
  await act(async () => syntheticWindow.emit('pointermove', { clientX: 80 })); assert.equal(h.current().sidebarWidth, 230);
  await act(async () => syntheticWindow.emit('pointerup', {}));
});

it('tabbar binds a nonpassive wheel listener and preserves left-button drag, pointer end and horizontal delta behavior', async () => {
  const h = await mount(ports().options);
  const addition = h.tabbar.additions.find(item => item.type === 'wheel')!;
  assert.deepEqual(addition.options, { passive: false }); assert.equal(h.tabbar.count('wheel'), 1);
  const wheel = event({ deltaY: 50, deltaX: -7 }); h.tabbar.emit('wheel', wheel);
  assert.equal(h.tabbar.scrollLeft, 43); assert.equal(wheel.prevented, 1);
  h.current().startTabbarDrag(pointer(h.tabbar, 100, 2));
  const ignored = pointer(h.tabbar, 140); h.current().moveTabbarDrag(ignored);
  assert.equal(h.tabbar.scrollLeft, 43); assert.equal(ignored.prevented, 0);
  h.current().startTabbarDrag(pointer(h.tabbar, 100));
  const moved = pointer(h.tabbar, 140); h.current().moveTabbarDrag(moved);
  assert.equal(h.tabbar.scrollLeft, 3); assert.equal(moved.prevented, 1);
  h.current().endTabbarDrag();
  const ended = pointer(h.tabbar, 180); h.current().moveTabbarDrag(ended);
  assert.equal(h.tabbar.scrollLeft, 3); assert.equal(ended.prevented, 0);
  await h.unmount(); assert.equal(h.tabbar.count('wheel'), 0);
  assert.equal(h.tabbar.removals.at(-1)?.listener, addition.listener);
});

it('toast deduplication keeps the original kind and 4200ms expiry while later distinct toasts retain their own lifetime', async () => {
  const h = await mount(ports().options);
  await act(async () => h.current().pushToast('first'));
  await advance(1000);
  await act(async () => { h.current().pushToast('first', 'warn'); h.current().pushToast('second', 'warn'); });
  assert.deepEqual(h.current().toasts, [{ id: 1, text: 'first', kind: 'ok' }, { id: 3, text: 'second', kind: 'warn' }]);
  await advance(3199); assert.equal(h.current().toasts.length, 2);
  await advance(1); assert.deepEqual(h.current().toasts.map(toast => toast.text), ['second']);
  await advance(999); assert.equal(h.current().toasts.length, 1);
  await advance(1); assert.deepEqual(h.current().toasts, []);
});

it('first pending change reveals staging on each zero-to-positive transition and beforeunload follows dirty state', async () => {
  const p = ports(), h = await mount({ ...p.options, sidebarCollapsed: true });
  assert.equal(syntheticWindow.count('beforeunload'), 0);
  await h.update({ ...p.options, pendingChangeCount: 1, hasUncommittedChanges: true });
  assert.equal(h.layout().sidebarCollapsed, false); assert.deepEqual(p.sidebarViews, ['staging']);
  assert.equal(syntheticWindow.count('beforeunload'), 1);
  const unload = event({}); syntheticWindow.emit('beforeunload', unload); assert.equal(unload.prevented, 1);
  await h.update({ ...p.options, pendingChangeCount: 4, hasUncommittedChanges: true });
  assert.deepEqual(p.sidebarViews, ['staging']); assert.equal(syntheticWindow.count('beforeunload'), 1);
  await h.update(p.options); assert.equal(syntheticWindow.count('beforeunload'), 0);
  const currentViews: string[] = [];
  await h.update({ ...p.options, pendingChangeCount: 2, hasUncommittedChanges: true, showSidebarView: view => currentViews.push(view) });
  assert.deepEqual(currentViews, ['staging']); await h.unmount(); assert.equal(syntheticWindow.count('beforeunload'), 0);
});

it('StrictMode leaves one mounted shortcut, wheel and unload listener and cleans each on unmount', async () => {
  const p = ports(), h = await mount({ ...p.options, pendingChangeCount: 1, hasUncommittedChanges: true }, true);
  assert.equal(syntheticWindow.count('keydown'), 1); assert.equal(syntheticWindow.count('beforeunload'), 1);
  assert.equal(h.tabbar.count('wheel'), 1); assert.deepEqual(p.sidebarViews, ['staging']);
  await dispatch(keyboard('j', { ctrlKey: true })); assert.equal(h.layout().agentOpen, true);
  await h.unmount(); assert.equal(syntheticWindow.count('keydown'), 0); assert.equal(syntheticWindow.count('beforeunload'), 0);
  assert.equal(h.tabbar.count('wheel'), 0);
});

it('unmount removes an unfinished resize and cancels pending focus and toast callbacks', async () => {
  const h = await mount(ports().options), trigger = new SyntheticElement('BUTTON'); trigger.focus();
  await act(async () => { h.current().startSidebarResize(pointer(h.shell, 0)); h.current().pushToast('pending'); h.current().openCmdk(); });
  await act(async () => { h.current().closeCmdk(); h.current().focusSearchPanel(); });
  assert.equal(syntheticWindow.count('pointermove'), 1); assert.equal(syntheticWindow.timers.size, 4);
  await h.unmount();
  const listenersAfterUnmount = syntheticWindow.count('pointermove') + syntheticWindow.count('pointerup');
  const timersAfterUnmount = syntheticWindow.timers.size;
  await advance(4200);
  assert.deepEqual({ listenersAfterUnmount, timersAfterUnmount, focusAfterUnmount: trigger.focusCount },
    { listenersAfterUnmount: 0, timersAfterUnmount: 0, focusAfterUnmount: 1 });
});

it('retained shell commands cannot recreate timers/listeners or focus after owner unmount, including StrictMode', async () => {
  for (const strict of [false, true]) {
    const p = ports(), h = await mount(p.options, strict), trigger = new SyntheticElement('BUTTON'); trigger.focus();
    const commands = h.current(); await h.unmount();
    await act(async () => {
      commands.pushToast('late'); commands.openCmdk(); commands.closeCmdk(); commands.focusSearchPanel();
      commands.startSidebarResize(pointer(h.shell, 0));
    });
    const listeners = syntheticWindow.count('pointermove') + syntheticWindow.count('pointerup');
    const timers = syntheticWindow.timers.size; await advance(4200);
    assert.deepEqual({ listeners, timers, focus: trigger.focusCount, views: p.sidebarViews },
      { listeners: 0, timers: 0, focus: 1, views: [] });
  }
});
