/**
 * App 壳层源码断言（问题 1）：开始页只在首次打开（无工作区）出现；换文件夹
 * 走标题栏 workspace-switcher；暂存/审计入口回到活动栏。
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
// buildDomainSummaries 的 visibility 逻辑在 domainNavigation.ts（App.tsx 只传 hasWorkspace）。
const domainNavigationSource = readFileSync(
  join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'navigation', 'domainNavigation.ts'),
  'utf8'
);

describe('问题 1 壳层：开始页只在首次打开；换文件夹走 workspace-switcher；暂存/审计回活动栏', () => {
  it('活动栏包含 暂存区 / 审计与回滚（ab-item），搜索仍只走 Ctrl+K，不残留「开始」式资源栏开关', () => {
    // 只检查活动栏区块（nav.activitybar 到侧栏 aside 之间）——侧栏面板本身的
    // aria-label 是面板标题，不属于活动栏按钮。
    const activitybarRegion = appSource.slice(
      appSource.indexOf('className="activitybar"'),
      appSource.indexOf('<aside')
    );
    assert.match(activitybarRegion, /aria-label="暂存区"/);
    assert.match(activitybarRegion, /aria-label="审计与回滚"/);
    assert.match(activitybarRegion, /aria-label="AI Agent 面板"/);
    assert.match(activitybarRegion, /aria-label="设置"/);
    // 搜索不进活动栏（走 Ctrl+K，不加第四个图标）。
    assert.doesNotMatch(activitybarRegion, /aria-label="搜索"/);
    // 活动栏与 Agent 之间不再有任何「开始」图标残留。
    assert.doesNotMatch(activitybarRegion, /aria-label="开始"/);
  });

  it('有工作区后「开始」不是页：project 从顶栏隐藏，selectDomain 不再有「召唤资源栏」旁路', () => {
    // App.tsx 把 hasWorkspace 传给 buildDomainSummaries（有工作区后 project 的
    // visibility 隐藏在 domainNavigation.ts 判定；无工作区仍 visible）。
    assert.match(appSource, /hasWorkspace: workspace !== null/);
    assert.match(domainNavigationSource, /domain === 'project' && input\.hasWorkspace === true/);
    // 点「开始」不再以 resourceSidebarOpen 当选中态（DomainNavigationBar 已删该 prop）。
    assert.doesNotMatch(appSource, /resourceSidebarOpen/);
    // 旧的「有工作区 + project 提前 return 只折资源栏」整段已删除。
    assert.doesNotMatch(appSource, /召唤资源栏/);
  });

  it('标题栏不可点品牌标签换成 workspace-switcher 按钮/菜单（打开/更换 Mod、选/换/清原版）', () => {
    assert.match(appSource, /data-testid="workspace-switcher"/);
    assert.match(appSource, /data-testid="switcher-open-workspace"/);
    assert.match(appSource, /data-testid="switcher-choose-base-directory"/);
    assert.match(appSource, /data-testid="switcher-clear-base-directory"/);
    assert.match(appSource, /void openWorkspace\(\)/);
    assert.match(appSource, /void chooseBaseDirectory\(\)/);
    assert.match(appSource, /clearBaseDirectory\(\)/);
    // 旧的不可点品牌标签已移除。
    assert.doesNotMatch(appSource, /className="brand-tag"/);
  });

  it('开始态侧栏已拆：源码不得再有 start-sidebar / start-sidebar-tools / start-sidebar-file-list', () => {
    assert.doesNotMatch(appSource, /data-testid="start-sidebar"/);
    assert.doesNotMatch(appSource, /data-testid="start-sidebar-tools"/);
    assert.doesNotMatch(appSource, /data-testid="start-sidebar-file-list"/);
    assert.doesNotMatch(appSource, /START_SIDEBAR_FILE_LIMIT/);
  });

  it('mountWorkspace 不把 activeDomain 落回 project：恢复失败时默认进 param', () => {
    // 有工作区后挂载不得「先写回 project 再指望恢复」——旧实现
    // `setActiveDomain('project'); setCenterView('project');` 的顺序已删除。
    assert.doesNotMatch(appSource, /setActiveDomain\('project'\)/);
    // restore 返回 boolean；没有合法上次领域 → 默认 param。
    assert.match(appSource, /const restoredDomain = restoreLastShellState/);
    assert.match(appSource, /if \(!restoredDomain\)/);
    assert.match(appSource, /setActiveDomain\('param'\)/);
  });

  it('12-E：侧栏不再拼「XX · 逻辑库」（所有语义域都删，Files 数量与 project「开始」仍在）', () => {
    // 用户点名的是侧栏头那句「XX · 逻辑库」：这一句所有域都删，且不留空 hint span。
    assert.doesNotMatch(appSource, /\$\{domainLabel\(activeDomain\)\} · 逻辑库/);
    assert.doesNotMatch(appSource, /逻辑库工作域/);
    assert.doesNotMatch(appSource, /逻辑库工作台/);
    // Files 数量保留。
    assert.match(appSource, /formatFilesCount\(physicalBrowseFiles\.length\)/);
  });
});
