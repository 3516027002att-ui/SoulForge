import type { ReactElement } from 'react';
import type { WorkspaceController } from './useWorkspaceController.js';
import type { ShellInteractionController } from './useShellInteractionController.js';

export interface WorkspaceHeaderViewProps {
  workspace: Pick<WorkspaceController, 'workspace' | 'sessionMeta' | 'baseRootChoice' | 'openWorkspace' | 'chooseBaseDirectory' | 'clearBaseDirectory'>;
  shell: Pick<ShellInteractionController, 'workspaceSwitcherOpen' | 'setWorkspaceSwitcherOpen' | 'openCmdk'>;
  isBrowserPreview: boolean; iconUrl: string;
}

export function WorkspaceHeaderView({ workspace: owner, shell, isBrowserPreview, iconUrl: SOULFORGE_ICON_URL }: WorkspaceHeaderViewProps): ReactElement {
  const { workspace, sessionMeta, baseRootChoice, openWorkspace, chooseBaseDirectory, clearBaseDirectory } = owner;
  const { workspaceSwitcherOpen, setWorkspaceSwitcherOpen, openCmdk } = shell;
  return <header className="titlebar">
        <div className="titlebar__brand">
          <img className="brand-mark" src={SOULFORGE_ICON_URL} width="16" height="16" alt="" aria-hidden="true" />
          <span className="brand-name">SoulForge</span>
          {/* 问题 1：不可点的品牌标签 → 壳层常驻的 workspace-switcher 按钮/菜单。
              有工作区后换 Mod 工作区 / 原版目录的任何领域入口都在这里（打开/更换
              Mod、选择/更换/清原版三件事与旧开始页同一套 handler）。 */}
          <div className="workspace-switcher" data-testid="workspace-switcher">
            <button
              type="button"
              className="workspace-switcher__trigger"
              onClick={() => setWorkspaceSwitcherOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={workspaceSwitcherOpen}
              title={sessionMeta?.workspaceLabel ?? workspace?.workspaceLabel ?? '未打开工作区'}
            >
              <span className="workspace-switcher__label">{workspace?.workspaceLabel ?? '未打开工作区'}</span>
              <span className="workspace-switcher__game"> · {sessionMeta?.game ?? 'sekiro'}</span>
              <span className="workspace-switcher__caret" aria-hidden="true">▾</span>
            </button>
            {workspaceSwitcherOpen && (
              <>
                <div
                  className="workspace-switcher__backdrop"
                  onClick={() => setWorkspaceSwitcherOpen(false)}
                  aria-hidden="true"
                />
                <div className="workspace-switcher__menu" role="menu" data-testid="workspace-switcher-menu">
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="switcher-open-workspace"
                    onClick={() => { setWorkspaceSwitcherOpen(false); void openWorkspace(); }}
                    {...(isBrowserPreview ? { 'aria-disabled': true } : {})}
                  >
                    {workspace ? '更换 Mod 工作区' : '打开 Mod 工作区'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="switcher-choose-base-directory"
                    onClick={() => { setWorkspaceSwitcherOpen(false); void chooseBaseDirectory(); }}
                    {...(isBrowserPreview ? { 'aria-disabled': true } : {})}
                  >
                    {baseRootChoice ? '更换原版目录' : '选择原版目录'}
                  </button>
                  {baseRootChoice && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="switcher-clear-base-directory"
                      onClick={() => { setWorkspaceSwitcherOpen(false); clearBaseDirectory(); }}
                    >
                      清除原版目录
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="titlebar__center">
          <button type="button" className="cmdk-trigger" onClick={openCmdk} title="命令面板">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16.5 16.5 L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>搜索资源或命令…</span>
            <kbd>Ctrl K</kbd>
          </button>
        </div>
      </header>;
}
