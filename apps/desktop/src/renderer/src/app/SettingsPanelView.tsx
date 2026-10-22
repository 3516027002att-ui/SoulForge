import type { ReactElement } from 'react';
import type { RagLocalModelStatus, UpdatePublicState } from '@soulforge/shared';
import { ThemeSettings } from '../theme/ThemeSettings.js';
import type { useSpectralTheme } from '../theme/useSpectralTheme.js';
import { Me3RuntimePanel } from '../runtime/Me3RuntimePanel.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import type { WorkspaceController } from './useWorkspaceController.js';
import type { RuntimeSettingsController } from './useRuntimeSettingsController.js';

export interface SettingsPanelViewProps {
  active: boolean;
  closeButton: ReactElement;
  isBrowserPreview: boolean;
  workspace: Pick<WorkspaceController, 'sessionMeta' | 'baseRootChoice' | 'chooseBaseDirectory' | 'clearBaseDirectory'>;
  spectralTheme: Pick<ReturnType<typeof useSpectralTheme>, 'manifest' | 'setMode' | 'setIntensity' | 'reset'>;
  runtimeSettings: RuntimeSettingsController;
  bridge: Pick<NonNullable<RendererRuntime['bridge']>, 'openUpdateRelease'> | null;
}

function updateStateLabel(state: UpdatePublicState): string {
  switch (state.status) {
    case 'idle': return '尚未检查';
    case 'checking': return '检查中…';
    case 'up-to-date': return '已是最新版本';
    case 'available': return `发现 ${state.info.version}`;
    case 'downloading': return `下载中 ${state.progress.percent}%`;
    case 'pending-install': return '已下载，等待安装';
    case 'installing': return '正在启动安装器…';
    case 'installed': return '已启动安装器';
    case 'cancelled': return '已取消';
    case 'blocked': return '暂缓安装';
    case 'error': return '更新失败';
  }
}

function ragLocalModelStateLabel(state: RagLocalModelStatus['state']): string {
  switch (state) {
    case 'local-ready': return '本地模型已就绪';
    case 'model-id-mismatch': return '模型 ID 不匹配';
    case 'revision-mismatch': return '版本不匹配';
    case 'local-files-missing': return '本地文件缺失或损坏';
    case 'unavailable': return '未安装本地模型';
  }
}

function ragLocalModelSourceLabel(source: RagLocalModelStatus['source']): string {
  switch (source) {
    case 'explicit': return '显式本地目录';
    case 'managed': return 'SoulForge 受管目录';
    case 'embedding-cache': return '已有 embedding 缓存';
    case 'huggingface-cache': return 'Hugging Face 本地缓存';
    default: return '未发现本地来源';
  }
}


/** Settings presentation only; workspace and runtime controllers retain request and native authority. */
export function SettingsPanelView({
  active, closeButton, isBrowserPreview, workspace, spectralTheme, runtimeSettings, bridge
}: SettingsPanelViewProps): ReactElement {
  const { sessionMeta, baseRootChoice, chooseBaseDirectory, clearBaseDirectory } = workspace;
  const { updateState, updateActionBusy, ragModelStatus, currentUpdateAction, runUpdateCommand, changeUpdateChannel } = runtimeSettings;
  // 原版目录展示只从这一份派生状态生成，避免把「已选择路径」误显示成
  // 「已挂载到当前 workspace」。baseMounted 是主进程 session 的权威值。
  const baseMountPresentation = sessionMeta
    ? sessionMeta.baseMounted
      ? {
          label: sessionMeta.baseLabel ?? '原版游戏目录已挂载到当前工作区',
          status: '已挂载到当前工作区',
          className: 'pill pill--ok'
        }
      : {
          label: sessionMeta.baseLabel
            ? `${sessionMeta.baseLabel}（未挂载到当前工作区）`
            : '当前工作区未挂载原版游戏目录',
          status: '未挂载到当前工作区',
          className: 'pill'
        }
    : baseRootChoice
      ? {
          label: `${baseRootChoice.label}（已选择，待工作区挂载）`,
          status: '已选择，待挂载',
          className: 'pill pill--accent'
        }
      : {
          label: '尚未选择原版游戏目录',
          status: '未选择',
          className: 'pill'
        };


  return (
    <section className={active ? 'panel is-active' : 'panel'} data-panel-id="settings" aria-label="设置">
      <div className="panel__header">
        <h2 className="panel__title">设置</h2>
        {closeButton}
      </div>
      <div className="panel__body panel__body--pad">
        {/* 模型、思考强度与权限模式已迁入右侧 Agent 面板；此处只保留工作区与安全基础设施设置。 */}
        <div className="setting-row">
          <div>
            <div className="setting-name">原版游戏目录</div>
            <div className="setting-desc">
              {baseMountPresentation.label}
            </div>
          </div>
          <span className={baseMountPresentation.className}>{baseMountPresentation.status}</span>
        </div>
        <div className="row gap setting-actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void chooseBaseDirectory()}
            {...(isBrowserPreview ? { 'aria-disabled': true } : {})}
          >
            {sessionMeta?.baseMounted || baseRootChoice ? '更换原版游戏目录' : '选择原版游戏目录'}
          </button>
          {(sessionMeta?.baseMounted || baseRootChoice) && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void clearBaseDirectory()}>清除</button>
          )}
        </div>
        <div className="setting-row">
          <div className="setting-name">写入路径</div>
          <span className="pill pill--ok">强制</span>
        </div>
        <div className="setting-row">
          <div className="setting-name">回滚</div>
          <span className="pill pill--ok">可用</span>
        </div>
        <ThemeSettings manifest={spectralTheme.manifest} onModeChange={spectralTheme.setMode}
          onIntensityChange={spectralTheme.setIntensity} onReset={spectralTheme.reset} />
    
        <div className="setting-row setting-row--update" data-testid="update-settings">
          <div className="setting-row__content">
            <div className="setting-name">软件更新</div>
            <div className="setting-desc">
              当前版本 {updateState.currentVersion} · {updateStateLabel(updateState)}
            </div>
            {('info' in updateState) && (
              <div className="setting-desc setting-desc--update">
                {updateState.info.releaseName} · {updateState.info.installerName}
              </div>
            )}
            {('diagnostic' in updateState) && (
              <div className="setting-desc setting-desc--error" role="status">
                {updateState.diagnostic.message}
              </div>
            )}
            {updateState.status === 'available' && updateState.info.releaseNotes.trim() !== '' && (
              <details className="update-notes">
                <summary>查看更新说明</summary>
                <p>{updateState.info.releaseNotes}</p>
              </details>
            )}
          </div>
          <div className="setting-row__controls">
            <label className="update-channel-label">
              <span>频道</span>
              <select
                value={updateState.channel}
                disabled={isBrowserPreview || updateActionBusy}
                onChange={(event) => {
                  const channel = event.currentTarget.value;
                  if (channel === 'stable' || channel === 'prerelease') changeUpdateChannel(channel);
                }}
                aria-label="更新频道"
              >
                <option value="prerelease">预发布</option>
                <option value="stable">稳定版</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={isBrowserPreview || updateActionBusy || currentUpdateAction.run === null}
              onClick={() => {
                if (currentUpdateAction.run) void runUpdateCommand(currentUpdateAction.run);
              }}
            >
              {updateActionBusy ? '处理中…' : currentUpdateAction.label}
            </button>
            {bridge && typeof bridge.openUpdateRelease === 'function' && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={updateActionBusy}
                onClick={() => void runUpdateCommand(
                  bridge.openUpdateRelease,
                  '已打开 GitHub Release 下载页面'
                )}
              >
                手动下载
              </button>
            )}
          </div>
        </div>
    
        <div className="setting-row setting-row--rag" data-testid="rag-local-model-settings">
          <div className="setting-row__content">
            <div className="setting-name">RAG 语义模型</div>
            <div className="setting-desc">
              只使用本机已有的完全匹配模型；缺失时保留词法与结构化检索，不会下载模型。
            </div>
            {ragModelStatus && (
              <div className="setting-desc setting-desc--update">
                {ragModelStatus.modelId} · revision {ragModelStatus.revision.slice(0, 8)} · {ragLocalModelSourceLabel(ragModelStatus.source)}
              </div>
            )}
            {ragModelStatus?.diagnostic && (
              <div className="setting-desc setting-desc--error" role="status">
                {ragModelStatus.diagnostic}
              </div>
            )}
          </div>
          <span className={ragModelStatus?.state === 'local-ready' ? 'pill pill--ok' : 'pill pill--warn'}>
            {isBrowserPreview
              ? '桌面版运行时可用'
              : ragModelStatus
                ? ragLocalModelStateLabel(ragModelStatus.state)
                : '读取中…'}
          </span>
        </div>
    
        {/*
          me3 运行时挂在设置面板：它是工作区级的运行基础设施，不属任何单个资源。
          放这里不违反本面板的 e2e 约束（renderer.spec.mjs:354-356 只禁
          「思考强度」「模型服务」「运行 / 权限模式」三个词，那些属 Agent 面板）。
    
          启动按钮默认禁用，门槛走 me3LaunchGuard 的纯判定——scope.json 的
          SCOPE-RUNTIME 明禁 launch-with-missing-or-ambiguous-capability，
          而 launchMe3 会真实启动零售游戏。
        */}
        <Me3RuntimePanel />
      </div>
    </section>
  );
}
