/**
 * App 壳层源码断言：开始页只在首次打开（无工作区）出现；有工作区后顶栏
 * 「开始」仍在，只召唤资源栏；换文件夹走标题栏 workspace-switcher；
 * 暂存/审计入口在活动栏。
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
// buildDomainSummaries 的 visibility 逻辑在 domainNavigation.ts。
const domainNavigationSource = readFileSync(
  join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'navigation', 'domainNavigation.ts'),
  'utf8'
);
// IPC 物理拆分后，回滚域 handler 位于 ipc/operations.ts（断言语义不变）。
const ipcSource = readFileSync(
  join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'ipc', 'operations.ts'),
  'utf8'
);
const workspaceIpcSource = readFileSync(
  join(process.cwd(), 'apps', 'desktop', 'src', 'main', 'ipc', 'workspace.ts'),
  'utf8'
);
const workbenchOpsSource = readFileSync(
  join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', 'editors', 'WorkbenchOpsPanel.tsx'),
  'utf8'
);

describe('问题 1 壳层：开始页只在首次打开；顶栏「开始」召唤资源栏；换文件夹走 workspace-switcher', () => {
  it('活动栏包含 暂存区 / 审计与回滚（ab-item），搜索仍只走 Ctrl+K，资源栏开关不在活动栏', () => {
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
    // 资源栏开关在顶栏「开始」，活动栏不得再放一个「开始」图标。
    assert.doesNotMatch(activitybarRegion, /aria-label="开始"/);
  });

  it('有工作区后「开始」留在顶栏：点它只召唤资源栏，不按 hasWorkspace 隐藏 project', () => {
    // 不得再按工作区挂载把 project 从顶栏藏掉（那是 grok.txt 写偏后的实现）。
    assert.doesNotMatch(domainNavigationSource, /domain === 'project' && input\.hasWorkspace === true/);
    assert.doesNotMatch(appSource, /hasWorkspace: workspace !== null,\s*\n\s*runtimeReady/);
    // 点「开始」的选中态 = 资源栏开着。
    assert.match(appSource, /resourceSidebarOpen/);
    assert.match(appSource, /domain === 'project' && workspace !== null/);
    assert.match(appSource, /召唤资源栏/);
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

  it('启动恢复只落地一次：过时挂载丢弃，不得叠两套 toast', () => {
    assert.match(appSource, /let cancelled = false/);
    assert.match(appSource, /mountGenerationRef/);
    assert.match(appSource, /if \(generation !== mountGenerationRef\.current\) return/);
    assert.doesNotMatch(appSource, /restoreAttemptedRef/);
  });

  it('workspace.analyze 不得把目录扫描当成已解析并回报 parsedFiles:0', () => {
    assert.doesNotMatch(workspaceIpcSource, /if \(activeIndex && indexedFiles\.length > 0\)/);
    assert.match(workspaceIpcSource, /await analyzeWorkspace\(/);
    assert.match(workspaceIpcSource, /workspaceAnalyzeInFlight/);
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

describe('P0 回滚与会话续接防线', () => {
  it('历史只投影逻辑操作，后端拒绝逆事务再次回滚', () => {
    assert.match(ipcSource, /filter\(\(entry\) => !entry\.inverseOfOpId && !entry\.rollbackScope\)/);
    assert.match(ipcSource, /ROLLBACK_OF_ROLLBACK_FORBIDDEN/);
    assert.match(ipcSource, /ROLLBACK_IN_PROGRESS/);
  });

  it('回滚只锁定当前入口，历史刷新按最新请求落地，快速多击不会重复提交', () => {
    assert.match(appSource, /rollbackInFlightRef/);
    assert.match(appSource, /operationHistoryRefreshRef/);
    assert.match(appSource, /operationHistoryRequestRef/);
    assert.doesNotMatch(appSource, /disabled=\{rollbackInFlight !== null\}/);
    assert.doesNotMatch(workbenchOpsSource, /rollbackBusy\?: boolean/);
    assert.doesNotMatch(workbenchOpsSource, /disabled=\{props\.rollbackBusy === true\}/);
    assert.match(workbenchOpsSource, /rollbackBusyOpId\?: string \| null/);
    assert.match(workbenchOpsSource, /props\.rollbackBusyOpId === row\.opId/);
    assert.match(appSource, /已有回滚正在处理中，请等待当前操作完成/);
    assert.match(appSource, /rollbackInFlight === `operation:\$\{entry\.opId\}`/);
    assert.match(appSource, /rollbackInFlight === `file:\$\{entry\.opId\}:\$\{path\}`/);
    assert.match(appSource, /reloadSelectedResourceAfterRollback/);
    assert.match(appSource, /selectFile\(\{ \.\.\.selectedFile \}\)/);
  });

  it('partial/max_steps 不会被普通发送隐式续接', () => {
    assert.match(appSource, /canAutoResumeAgentTask\(agentTask\)/);
    assert.doesNotMatch(appSource, /agentTask\.phase === 'done' \|\| agentTask\.phase === 'error'/);
  });
});
