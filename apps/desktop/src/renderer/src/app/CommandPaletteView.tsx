import type { ReactElement } from 'react';
import type { RendererWorkspaceScanResult } from '../../../main/ipc.js';
import type { NavigationCommand, NavigationController } from './useNavigationController.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import type { ShellInteractionController, ShellInteractionOptions } from './useShellInteractionController.js';

export interface CommandPaletteViewProps {
  cmdkOpen: boolean;
  cmdkQuery: string;
  cmdkItemCount: number;
  selectedCmdkIndex: number;
  filteredCmdkCommands: readonly NavigationCommand[];
  cmdkAllResourceMatches: NavigationController['cmdkAllResourceMatches'];
  workspace: Pick<RendererWorkspaceScanResult, 'workspaceSessionId'> | null;
  selectFile: ResourceDocumentController['selectFile'];
  shell: Pick<ShellInteractionController, 'cmdkInputRef' | 'cmdkDialogRef' | 'setCmdkIndex' | 'closeCmdk' | 'trapTabWithin'>;
  setCmdkQuery: ShellInteractionOptions['setCmdkQuery'];
  runCmdkItem(index: number): void;
}

/** The shell supplies refs, focus trapping and keyboard setters; this view adds no state or effects. */
export function CommandPaletteView({ cmdkOpen, cmdkQuery, cmdkItemCount, selectedCmdkIndex, filteredCmdkCommands,
  cmdkAllResourceMatches, workspace, selectFile, shell, setCmdkQuery, runCmdkItem }: CommandPaletteViewProps): ReactElement {
  const { cmdkInputRef, cmdkDialogRef, setCmdkIndex, closeCmdk, trapTabWithin } = shell;
  return (
      <div
        className={`cmdk-overlay${cmdkOpen ? ' is-open' : ''}`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeCmdk();
        }}
      >
        <div
          className="cmdk"
          role="dialog"
          aria-modal="true"
          aria-label="命令面板"
          ref={cmdkDialogRef}
          onKeyDown={(event) => trapTabWithin(cmdkDialogRef.current, event)}
        >
          <div className="cmdk__input-wrap">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={cmdkInputRef}
              value={cmdkQuery}
              onChange={(event) => {
                setCmdkQuery(event.target.value);
                setCmdkIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setCmdkIndex((index) => (cmdkItemCount === 0 ? 0 : (index + 1) % cmdkItemCount));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setCmdkIndex((index) => (cmdkItemCount === 0 ? 0 : (index - 1 + cmdkItemCount) % cmdkItemCount));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  runCmdkItem(selectedCmdkIndex);
                }
              }}
              placeholder="输入命令或搜索资源…"
              autoComplete="off"
              aria-label="输入命令或搜索资源"
            />
          </div>
          <div className="cmdk__list">
            {cmdkItemCount === 0 && (
              <p className="empty-hint">
                {workspace ? '无匹配命令或资源。' : '请先打开 Mod 工作区；打开后可搜索资源。'}
              </p>
            )}
            {filteredCmdkCommands.map((command, index) => (
              <button
                key={command.id}
                type="button"
                className={index === selectedCmdkIndex ? 'cmdk-item is-selected' : 'cmdk-item'}
                onClick={() => {
                  closeCmdk();
                  command.run();
                }}
              >
                <span className="cmdk-item__icon" aria-hidden="true">{command.icon}</span>
                <span className="cmdk-item__label">{command.label}</span>
                {command.hint && <span className="cmdk-item__hint">{command.hint}</span>}
              </button>
            ))}
            {cmdkAllResourceMatches.map((file, index) => {
              const itemIndex = filteredCmdkCommands.length + index;
              return (
                <button
                  key={file.sourceUri}
                  type="button"
                  className={itemIndex === selectedCmdkIndex ? 'cmdk-item is-selected' : 'cmdk-item'}
                  onClick={() => {
                    closeCmdk();
                    void selectFile(file);
                  }}
                >
                  <span className="cmdk-item__icon" aria-hidden="true">⌘</span>
                  <span className="cmdk-item__label">{file.relativePath}</span>
                  <span className="cmdk-item__hint">{file.formatLabel}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
  );
}
