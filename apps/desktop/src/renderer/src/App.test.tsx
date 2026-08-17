/**
 * App 壳层源码断言（S33）：活动栏四图标已删，开始侧栏承接开始页功能。
 *
 * App.tsx 需要真实 bridge + Electron 才能 SSR 完整渲染，这里做源码级断言
 * （与 FmgWorkbenchPanel 的 Negative source tests 同一范式）：锁的是 DOM
 * 结构与入口的存在性，不是行为。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const appSource = readFileSync(
  join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'App.tsx'),
  'utf8'
);

describe('S33 壳层：活动栏四图标删除，开始侧栏承接开始页功能', () => {
  it('活动栏不再有 资源浏览器 / 搜索 / 暂存区 / 审计与回滚 四个按钮', () => {
    // 只检查活动栏区块（nav.activitybar 到侧栏 aside 之间）——侧栏面板本身的
    // aria-label 是面板标题，不属于活动栏按钮。
    const activitybarRegion = appSource.slice(
      appSource.indexOf('className="activitybar"'),
      appSource.indexOf('<aside')
    );
    assert.doesNotMatch(activitybarRegion, /aria-label="资源浏览器"/);
    assert.doesNotMatch(activitybarRegion, /aria-label="搜索"/);
    assert.doesNotMatch(activitybarRegion, /aria-label="暂存区/);
    assert.doesNotMatch(activitybarRegion, /aria-label="审计与回滚"/);
  });

  it('活动栏只剩 Agent 与设置（贴底），不残留 48px 空条', () => {
    assert.match(appSource, /aria-label="AI Agent 面板"/);
    assert.match(appSource, /aria-label="设置"/);
    // 四个 ab-item 按钮删除后,ab-spacer 直接顶到 Agent。
    const activitybar = appSource.slice(appSource.indexOf('className="activitybar"'));
    const agentIdx = activitybar.indexOf('aria-label="AI Agent 面板"');
    assert.ok(agentIdx > 0, '活动栏里仍有 Agent 入口');
  });

  it('开始态侧栏包含开始页四件事：打开/更换 Mod、选/换/清原版、工作区名、挂载状态', () => {
    assert.match(appSource, /data-testid="start-sidebar"/);
    assert.match(appSource, /data-testid="open-workspace"/);
    assert.match(appSource, /data-testid="choose-base-directory"/);
    assert.match(appSource, /工作区：\{workspace\?\.workspaceLabel/);
    assert.match(appSource, /原版：\{sessionMeta\?\.baseMounted/);
  });

  it('搜索/暂存/审计进开始侧栏折叠区，搜索仍只走 Ctrl+K', () => {
    assert.match(appSource, /data-testid="start-sidebar-tools"/);
    assert.match(appSource, /搜索（Ctrl\+K）/);
    assert.match(appSource, /activateSidebarView\('staging'\)/);
    assert.match(appSource, /activateSidebarView\('audit'\)/);
  });

  it('开始侧栏带资源树（工作区资源列表，单击打开）', () => {
    assert.match(appSource, /data-testid="start-sidebar-file-list"/);
    assert.match(appSource, /START_SIDEBAR_FILE_LIMIT/);
  });
});
