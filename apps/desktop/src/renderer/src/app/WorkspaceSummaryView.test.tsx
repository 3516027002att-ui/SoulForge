import assert from 'node:assert/strict';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { WorkspaceSummaryView, type WorkspaceSummaryViewProps } from './WorkspaceSummaryView.js';

function props(): WorkspaceSummaryViewProps {
  return {
    workspace: { workspace: null, sessionMeta: null },
    operations: { draftChanges: [], lastOperation: null },
    document: { openTabs: [], selectFile: async () => {} },
    navigation: { showSidebarView: () => {} },
    setSidebarCollapsed: () => {},
    showEditorWelcome: true,
    welcomeStats: '未打开 Mod 工作区 · 从左侧资源浏览器打开',
    iconUrl: 'owned-icon.png'
  };
}

function elements(node: ReactNode): ReactElement[] {
  const result: ReactElement[] = [];
  Children.forEach(node, child => {
    if (isValidElement<{ children?: ReactNode }>(child)) {
      result.push(child, ...elements(child.props.children));
    }
  });
  return result;
}

function file(index: number): RendererIndexedFile {
  return {
    sourceUri: `resource://owned/recent-${index}`,
    relativePath: `event/recent-${index}.emevd.dcx`,
    resourceKind: 'event', game: 'sekiro', parseStatus: 'parsed', diagnostics: [],
    extension: '.dcx', compoundExtension: '.emevd.dcx', formatKind: 'emevd',
    formatLabel: 'EMEVD', size: 80, mtimeMs: index
  };
}

function draft(index: number): WorkspaceSummaryViewProps['operations']['draftChanges'][number] {
  return {
    id: `draft-${index}`, kind: 'text', sourceUri: `resource://owned/draft-${index}`,
    target: `event/draft-${index}.emevd.dcx`, summary: `Draft ${index}: old → new`,
    oldValue: 'old', newValue: 'new', status: 'draft', diagnostics: [], payload: {},
    createdAt: index, updatedAt: index
  };
}

it('summary preserves the default workspace, empty sections, icon, classes and keyboard shortcuts', () => {
  const html = renderToStaticMarkup(<WorkspaceSummaryView {...props()} />);
  assert.match(html, /<div class="editor-welcome"><div class="welcome">/);
  assert.match(html, /src="owned-icon.png" width="26" height="26" class="welcome-mark" alt="" aria-hidden="true"/);
  assert.match(html, /<h1>SoulForge<\/h1>/);
  assert.match(html, /<span class="welcome__ws">未打开工作区 · sekiro<\/span>/);
  assert.match(html, /<p class="welcome__stats">未打开 Mod 工作区 · 从左侧资源浏览器打开<\/p>/);
  assert.match(html, /<section class="welcome__section" aria-label="待审查变更">/);
  assert.match(html, /<p class="empty-hint welcome-empty">没有待审查的变更。<\/p>/);
  assert.match(html, /<section class="welcome__section" aria-label="最近打开">/);
  assert.match(html, /暂无最近打开。从左侧资源树选择资源，或按 Ctrl K 搜索。/);
  assert.match(html, /class="welcome-meta"/);
  assert.match(html, /本工作区尚无写入记录/);
  assert.match(html, /class="welcome-shortcuts"/);
  assert.match(html, /<kbd>Ctrl K<\/kbd> 命令面板/);
  assert.match(html, /<kbd>Ctrl J<\/kbd> AI Agent/);
  assert.match(html, /<kbd>Ctrl B<\/kbd> 侧栏/);
  assert.doesNotMatch(html, /class="review-row"|class="quick-item"/);
});

it('summary keeps the hidden welcome mounted and renders the owner workspace/session and projected stats', () => {
  const p = props();
  const session = { workspaceSessionId: 'owned-workspace', workspaceLabel: 'Session label', game: 'eldenring',
    openedAt: 'owned-time', baseMounted: false };
  p.workspace = { sessionMeta: session, workspace: {
    workspaceSessionId: 'owned-workspace', workspaceLabel: 'Mod <owned>', files: [], diagnostics: [], session,
    countsByKind: { event: 0, map: 0, param: 0, msg: 0, menu: 0, script: 0, action: 0, ai: 0,
      sfx: 0, chr: 0, obj: 0, other: 0, unknown: 0 },
    indexingStatus: { workspaceSessionId: 'owned-workspace', phase: 'ready', current: 0, total: 0, message: '' }
  } };
  p.showEditorWelcome = false;
  p.welcomeStats = '已索引 42 个资源 · Mod <owned> · 已解析 7';
  const html = renderToStaticMarkup(<WorkspaceSummaryView {...p} />);
  assert.match(html, /<div class="editor-welcome is-hidden"><div class="welcome">/);
  assert.match(html, /<span class="welcome__ws">Mod &lt;owned&gt; · eldenring<\/span>/);
  assert.match(html, /<p class="welcome__stats">已索引 42 个资源 · Mod &lt;owned&gt; · 已解析 7<\/p>/);
  assert.match(html, /没有待审查的变更。/);
  assert.doesNotMatch(html, /Session label/);
});

it('summary shows every owner-projected draft and review expands the sidebar before opening staging without identifiers', () => {
  const p = props(), calls: unknown[][] = [];
  p.operations.draftChanges = Array.from({ length: 9 }, (_, index) => draft(index));
  p.setSidebarCollapsed = (...args) => { calls.push(['expand', ...args]); };
  p.navigation.showSidebarView = (...args) => { calls.push(['sidebar', ...args]); };
  const tree = WorkspaceSummaryView(p);
  const rows = elements(tree).filter(node => isValidElement<{ className?: string }>(node) && node.props.className === 'review-row');
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.map(row => row.key), p.operations.draftChanges.map(item => item.id));
  const html = renderToStaticMarkup(tree);
  for (const item of p.operations.draftChanges) {
    assert.ok(html.includes(`<span class="review-row__target" title="${item.sourceUri}">${item.target}</span>`));
    assert.ok(html.includes(`<span class="review-row__delta">${item.summary}</span>`));
  }
  for (const row of rows) {
    const review = elements(row).find(node => node.type === 'button');
    assert.ok(review && isValidElement<{ onClick(): void; children: ReactNode; className: string }>(review));
    assert.equal(review.props.children, '审查');
    assert.equal(review.props.className, 'btn btn--ghost btn--sm');
    review.props.onClick();
  }
  assert.deepEqual(calls, p.operations.draftChanges.flatMap(() => [['expand', false], ['sidebar', 'staging']]));
});

it('summary limits recent files to the last six in reverse order and selects the exact owner objects without mutating tabs', () => {
  const p = props(), calls: unknown[][] = [];
  const tabs = Array.from({ length: 8 }, (_, index) => file(index));
  p.document.openTabs = tabs;
  p.document.selectFile = async (...args) => { calls.push(args); };
  const originalTabs = [...tabs];
  const tree = WorkspaceSummaryView(p);
  const buttons = elements(tree).filter(node => isValidElement<{ className?: string }>(node) && node.props.className === 'quick-item');
  const expected = [tabs[7]!, tabs[6]!, tabs[5]!, tabs[4]!, tabs[3]!, tabs[2]!];
  assert.deepEqual(buttons.map(button => button.key), expected.map(tab => tab.sourceUri));
  const html = renderToStaticMarkup(tree);
  assert.match(html, /class="welcome-quick__grid"/);
  assert.doesNotMatch(html, /event\/recent-[01]\.emevd\.dcx/);
  for (const tab of expected) {
    assert.ok(html.includes(`<span class="quick-item__name">${tab.relativePath}</span>`));
    assert.ok(html.includes(`<span class="quick-item__desc">${tab.resourceKind} · ${tab.formatLabel}</span>`));
    assert.ok(html.includes(`<span class="quick-item__ext">${tab.formatLabel}</span>`));
  }
  for (const button of buttons) {
    assert.ok(isValidElement<{ onClick(): void }>(button));
    button.props.onClick();
  }
  assert.equal(calls.length, 6);
  expected.forEach((tab, index) => { assert.equal(calls[index]!.length, 1); assert.equal(calls[index]![0], tab); });
  assert.deepEqual(tabs, originalTabs);
  originalTabs.forEach((tab, index) => assert.equal(tabs[index], tab));
});

it('summary retains all recent files below the cap and uses the supplied last operation with nullish timestamp fallback', () => {
  const p = props();
  p.document.openTabs = [file(0), file(1)];
  p.operations.lastOperation = { opId: 'owned-op', title: 'Owned write', author: 'user', mode: 'normal',
    status: 'committed', createdAt: 'created-time', committedAt: 'committed-time', fileCount: 1, changedPaths: [] };
  let html = renderToStaticMarkup(<WorkspaceSummaryView {...p} />);
  assert.equal((html.match(/class="quick-item"/g) ?? []).length, 2);
  assert.ok(html.indexOf('event/recent-1.emevd.dcx') < html.indexOf('event/recent-0.emevd.dcx'));
  assert.match(html, /最近写入 Owned write · committed-time/);
  delete p.operations.lastOperation.committedAt;
  html = renderToStaticMarkup(<WorkspaceSummaryView {...p} />);
  assert.match(html, /最近写入 Owned write · created-time/);
  p.operations.lastOperation.committedAt = '';
  html = renderToStaticMarkup(<WorkspaceSummaryView {...p} />);
  assert.match(html, /最近写入 Owned write · <\/span>/);
  assert.doesNotMatch(html, /created-time/);
});
