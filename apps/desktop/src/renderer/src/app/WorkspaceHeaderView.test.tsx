import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import { WorkspaceHeaderView, type WorkspaceHeaderViewProps } from './WorkspaceHeaderView.js';
function props(): WorkspaceHeaderViewProps {
  return { workspace: { workspace: null, sessionMeta: null, baseRootChoice: null,
    openWorkspace: async () => {}, chooseBaseDirectory: async () => {}, clearBaseDirectory: async () => {} },
    shell: { workspaceSwitcherOpen: false, setWorkspaceSwitcherOpen: () => {}, openCmdk: () => {} },
    isBrowserPreview: false, iconUrl: 'owned-icon.png' };
}
function elements(node: ReactNode): ReactElement[] {
  const all: ReactElement[] = [];
  Children.forEach(node, child => { if (isValidElement<{children?:ReactNode}>(child)) { all.push(child); all.push(...elements(child.props.children)); } });
  return all;
}
it('header keeps default labels, shell classes, icon and permanent workspace/command entry points', () => {
  const html = renderToStaticMarkup(<WorkspaceHeaderView {...props()} />);
  assert.match(html, /class="titlebar"/); assert.match(html, /class="brand-mark" src="owned-icon.png"/);
  assert.match(html, /data-testid="workspace-switcher"/); assert.match(html, /未打开工作区/);
  assert.match(html, /sekiro/); assert.match(html, /搜索资源或命令/); assert.match(html, /Ctrl K/);
  assert.doesNotMatch(html, /role="menu"/);
});
it('menu forwards the same directory commands without args and closes before dispatching each', async () => {
  const p = props(), calls: unknown[] = [];
  p.shell = { workspaceSwitcherOpen: true, setWorkspaceSwitcherOpen: value => { calls.push(value); }, openCmdk: () => { calls.push('command'); } };
  p.workspace = { ...p.workspace, baseRootChoice: { selectionId: 'owned-selection', label: 'Owned base' },
    openWorkspace: async (...args) => { calls.push(['open', ...args]); }, chooseBaseDirectory: async (...args) => { calls.push(['base', ...args]); },
    clearBaseDirectory: async (...args) => { calls.push(['clear', ...args]); } };
  const nodes = elements(WorkspaceHeaderView(p));
  for (const id of ['switcher-open-workspace', 'switcher-choose-base-directory', 'switcher-clear-base-directory']) {
    const node = nodes.find(n => isValidElement<{'data-testid'?:string}>(n) && n.props['data-testid'] === id);
    assert.ok(node && isValidElement<{onClick():void}>(node)); await node.props.onClick();
  }
  assert.deepEqual(calls, [false, ['open'], false, ['base'], false, ['clear']]);
  const trigger = nodes.find(n => isValidElement<{title?:string}>(n) && n.props.title === '命令面板');
  assert.ok(trigger && isValidElement<{onClick():void}>(trigger)); assert.equal(trigger.props.onClick, p.shell.openCmdk);
});
it('preview exposes desktop-only menu state and clear remains tied to an actual base selection', () => {
  const p = props(); p.shell.workspaceSwitcherOpen = true; p.isBrowserPreview = true;
  let html = renderToStaticMarkup(<WorkspaceHeaderView {...p} />);
  assert.equal((html.match(/aria-disabled="true"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /switcher-clear-base-directory/);
  p.workspace.baseRootChoice = { selectionId: 'owned-selection', label: 'Owned base' };
  html = renderToStaticMarkup(<WorkspaceHeaderView {...p} />); assert.match(html, /switcher-clear-base-directory/); assert.match(html, /更换原版目录/);
});
