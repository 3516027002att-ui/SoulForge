import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import type { RagLocalModelStatus, UpdatePublicState } from '@soulforge/shared';
import { presetForMode } from '../theme/themeConfig.js';
import { SettingsPanelView, type SettingsPanelViewProps } from './SettingsPanelView.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => {
  while (mounted.length) {
    const renderer = mounted.pop()!;
    await act(async () => renderer.unmount());
  }
});

const idle: UpdatePublicState = { status: 'idle', currentVersion: 'test-version', channel: 'prerelease' };
const info = {
  version: 'next-version', tag: 'next-tag', channel: 'prerelease' as const,
  releaseName: 'Owned release', releaseNotes: 'Owned release notes', publishedAt: null,
  releaseUrl: 'https://example.invalid/owned-release', installerName: 'owned-installer.exe',
  installerSize: 1, installerSha256: 'owned-hash'
};
const diagnostic = { code: 'UPDATE_NETWORK_FAILED' as const, phase: 'check' as const, message: 'Owned update diagnostic', retryable: true };
const session = { workspaceSessionId: 'owned-session', workspaceLabel: 'Owned workspace', game: 'owned-game', openedAt: 'owned-time', baseMounted: false };

function props(): SettingsPanelViewProps {
  const command = async () => ({ ok: true, state: idle });
  return {
    active: true,
    closeButton: <button type="button" className="sidebar__close" aria-label="收起侧栏">close</button>,
    isBrowserPreview: false,
    workspace: { sessionMeta: null, baseRootChoice: null, chooseBaseDirectory: async () => {}, clearBaseDirectory: async () => {} },
    spectralTheme: { manifest: presetForMode('opal'), setMode: () => {}, setIntensity: () => {}, reset: () => {} },
    runtimeSettings: { updateState: idle, updateActionBusy: false, ragModelStatus: null,
      currentUpdateAction: { label: '检查更新', run: command }, runUpdateCommand: async () => {}, changeUpdateChannel: () => {} },
    bridge: { openUpdateRelease: command }
  };
}

async function mount(value: SettingsPanelViewProps) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<SettingsPanelView {...value} />); });
  mounted.push(renderer);
  return renderer;
}

it('keeps mount authority distinct from the selected directory while preserving the settings shell and theme/runtime panels', () => {
  const value = props();
  const cases = [
    { sessionMeta: null, baseRootChoice: null, label: '尚未选择原版游戏目录', status: '未选择', pill: 'pill', change: false },
    { sessionMeta: null, baseRootChoice: { selectionId: 'opaque-selected', label: 'Selected base' }, label: 'Selected base（已选择，待工作区挂载）', status: '已选择，待挂载', pill: 'pill pill--accent', change: true },
    { sessionMeta: { ...session, baseLabel: 'Session base' }, baseRootChoice: { selectionId: 'opaque-selected', label: 'Selected base' }, label: 'Session base（未挂载到当前工作区）', status: '未挂载到当前工作区', pill: 'pill', change: true },
    { sessionMeta: session, baseRootChoice: null, label: '当前工作区未挂载原版游戏目录', status: '未挂载到当前工作区', pill: 'pill', change: false },
    { sessionMeta: { ...session, baseMounted: true }, baseRootChoice: null, label: '原版游戏目录已挂载到当前工作区', status: '已挂载到当前工作区', pill: 'pill pill--ok', change: true },
    { sessionMeta: { ...session, baseMounted: true, baseLabel: 'Mounted base' }, baseRootChoice: null, label: 'Mounted base', status: '已挂载到当前工作区', pill: 'pill pill--ok', change: true }
  ];
  for (const entry of cases) {
    for (const mode of ['opal', 'obsidian'] as const) {
      const html = renderToStaticMarkup(<SettingsPanelView {...value}
        workspace={{ ...value.workspace, sessionMeta: entry.sessionMeta, baseRootChoice: entry.baseRootChoice }}
        spectralTheme={{ ...value.spectralTheme, manifest: presetForMode(mode) }} />);
      assert.match(html, /<section class="panel is-active" data-panel-id="settings" aria-label="设置">/);
      assert.ok(html.includes(entry.label));
      assert.ok(html.includes(`<span class="${entry.pill}">${entry.status}</span>`));
      assert.ok(html.includes(entry.change ? '更换原版游戏目录' : '选择原版游戏目录'));
      assert.equal(html.includes('>清除</button>'), entry.change);
      assert.match(html, /class="sidebar__close"/);
      assert.match(html, /写入路径/); assert.match(html, /强制/); assert.match(html, /回滚/); assert.match(html, /可用/);
      assert.match(html, /流光溢彩白/); assert.match(html, /五彩斑斓黑/);
      assert.ok(html.includes(`value="${mode}" selected=""`));
      assert.match(html, /<section class="panel me3-runtime" aria-label="me3 运行时">/);
      assert.doesNotMatch(html, /思考强度|模型服务|运行 \/ 权限模式/);
    }
  }
  assert.match(renderToStaticMarkup(<SettingsPanelView {...value} active={false} />), /<section class="panel" data-panel-id="settings"/);
});

it('retains every update status label, release metadata, diagnostics and available-only notes', () => {
  const value = props();
  const cases: Array<[UpdatePublicState, string]> = [
    [idle, '尚未检查'], [{ ...idle, status: 'checking' }, '检查中…'],
    [{ ...idle, status: 'up-to-date' }, '已是最新版本'],
    [{ ...idle, status: 'available', info }, '发现 next-version'],
    [{ ...idle, status: 'downloading', info, progress: { downloadedBytes: 1, totalBytes: 4, percent: 25 } }, '下载中 25%'],
    [{ ...idle, status: 'pending-install', info }, '已下载，等待安装'],
    [{ ...idle, status: 'installing', info }, '正在启动安装器…'],
    [{ ...idle, status: 'installed', info }, '已启动安装器'],
    [{ ...idle, status: 'cancelled', diagnostic }, '已取消'],
    [{ ...idle, status: 'blocked', diagnostic }, '暂缓安装'],
    [{ ...idle, status: 'error', diagnostic }, '更新失败']
  ];
  for (const [updateState, label] of cases) {
    const html = renderToStaticMarkup(<SettingsPanelView {...value} runtimeSettings={{ ...value.runtimeSettings, updateState }} />);
    assert.ok(html.includes(`当前版本 test-version · ${label}`));
    assert.equal(html.includes('Owned release · owned-installer.exe'), 'info' in updateState);
    assert.equal(html.includes('Owned update diagnostic'), 'diagnostic' in updateState);
    assert.equal(html.includes('<details class="update-notes">'), updateState.status === 'available');
  }
  const html = renderToStaticMarkup(<SettingsPanelView {...value} runtimeSettings={{ ...value.runtimeSettings,
    updateState: { ...idle, status: 'available', info: { ...info, releaseNotes: '   ' } } }} />);
  assert.doesNotMatch(html, /class="update-notes"/);
});

it('retains RAG readiness, revision/source labels and preview fallback without starting native work', () => {
  const value = props();
  const statuses: Array<[RagLocalModelStatus['state'], string]> = [
    ['local-ready', '本地模型已就绪'], ['model-id-mismatch', '模型 ID 不匹配'],
    ['revision-mismatch', '版本不匹配'], ['local-files-missing', '本地文件缺失或损坏'],
    ['unavailable', '未安装本地模型']
  ];
  const sources: Array<[RagLocalModelStatus['source'], string]> = [
    ['explicit', '显式本地目录'], ['managed', 'SoulForge 受管目录'],
    ['embedding-cache', '已有 embedding 缓存'], ['huggingface-cache', 'Hugging Face 本地缓存'],
    [undefined, '未发现本地来源']
  ];
  for (const [state, label] of statuses) {
    for (const [source, sourceLabel] of sources) {
      const ragModelStatus: RagLocalModelStatus = { state, modelId: 'owned-model', revision: '123456789abc', dimension: 4,
        diagnostic: 'Owned model diagnostic', ...(source ? { source } : {}) };
      const html = renderToStaticMarkup(<SettingsPanelView {...value} runtimeSettings={{ ...value.runtimeSettings, ragModelStatus }} />);
      assert.ok(html.includes(`owned-model · revision 12345678 · ${sourceLabel}`));
      assert.ok(html.includes(`<span class="${state === 'local-ready' ? 'pill pill--ok' : 'pill pill--warn'}">${label}</span>`));
      assert.match(html, /role="status">Owned model diagnostic/);
      assert.match(html, /不会下载模型/);
    }
  }
  assert.match(renderToStaticMarkup(<SettingsPanelView {...value} />), /读取中…/);
  const preview = renderToStaticMarkup(<SettingsPanelView {...value} isBrowserPreview />);
  assert.match(preview, /桌面版运行时可用/);
  assert.match(preview, /aria-disabled="true">选择原版游戏目录/);
});

it('forwards directory/theme/channel callbacks and exact update command identities and manual-download feedback', async () => {
  const value = props();
  const calls: unknown[][] = [];
  value.workspace = { ...value.workspace, baseRootChoice: { selectionId: 'opaque-selected', label: 'Selected base' },
    chooseBaseDirectory: async (...args) => { calls.push(['choose', ...args]); },
    clearBaseDirectory: async (...args) => { calls.push(['clear', ...args]); } };
  value.closeButton = <button type="button" aria-label="收起侧栏" onClick={() => calls.push(['close'])}>close</button>;
  value.spectralTheme = { ...value.spectralTheme,
    setMode: mode => calls.push(['mode', mode]), setIntensity: (id, intensity) => calls.push(['intensity', id, intensity]),
    reset: () => calls.push(['reset']) };
  value.runtimeSettings = { ...value.runtimeSettings,
    runUpdateCommand: async (...args) => { calls.push(['update', ...args]); },
    changeUpdateChannel: channel => calls.push(['channel', channel]) };
  const renderer = await mount(value);
  const button = (text: string) => renderer.root.findAllByType('button').find(entry => entry.children.includes(text))!;
  await act(async () => {
    button('更换原版游戏目录').props.onClick(); button('清除').props.onClick();
    button('close').props.onClick(); button('检查更新').props.onClick(); button('手动下载').props.onClick();
    renderer.root.findByProps({ 'aria-label': '更新频道' }).props.onChange({ currentTarget: { value: 'stable' } });
    renderer.root.findByProps({ 'aria-label': '更新频道' }).props.onChange({ currentTarget: { value: 'prerelease' } });
    renderer.root.findByProps({ 'aria-label': '更新频道' }).props.onChange({ currentTarget: { value: 'unrecognized' } });
    renderer.root.findByProps({ id: 'spectral-theme-mode' }).props.onChange({ currentTarget: { value: 'obsidian' } });
    renderer.root.findByProps({ 'aria-label': '总体彩色强度' }).props.onChange({ currentTarget: { value: '0.37' } });
    button('恢复预设').props.onClick();
  });
  assert.deepEqual(calls, [
    ['choose'], ['clear'], ['close'], ['update', value.runtimeSettings.currentUpdateAction.run],
    ['update', value.bridge!.openUpdateRelease, '已打开 GitHub Release 下载页面'],
    ['channel', 'stable'], ['channel', 'prerelease'], ['mode', 'obsidian'], ['intensity', 'overall', 0.37], ['reset']
  ]);
});

it('keeps browser, busy and missing-command update controls disabled and hides unavailable manual download', async () => {
  const value = props();
  for (const condition of ['preview', 'busy', 'missing'] as const) {
    const current = { ...value, isBrowserPreview: condition === 'preview', bridge: null,
      runtimeSettings: { ...value.runtimeSettings, updateActionBusy: condition === 'busy',
        currentUpdateAction: { ...value.runtimeSettings.currentUpdateAction, run: condition === 'missing' ? null : value.runtimeSettings.currentUpdateAction.run } } };
    const renderer = await mount(current);
    const channel = renderer.root.findByProps({ 'aria-label': '更新频道' });
    assert.equal(channel.props.disabled, condition !== 'missing');
    const updateButton = renderer.root.findAllByType('button').find(entry => entry.children.includes(condition === 'busy' ? '处理中…' : '检查更新'))!;
    assert.equal(updateButton.props.disabled, true);
    assert.equal(renderer.root.findAllByType('button').some(entry => entry.children.includes('手动下载')), false);
    if (condition === 'missing') {
      let calls = 0;
      current.runtimeSettings.runUpdateCommand = async () => { calls++; };
      await act(async () => renderer.update(<SettingsPanelView {...current} />));
      await act(async () => updateButton.props.onClick());
      assert.equal(calls, 0);
    }
  }
});
