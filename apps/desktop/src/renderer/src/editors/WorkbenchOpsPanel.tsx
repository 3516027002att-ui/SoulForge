import { useMemo, useState, type ReactElement } from 'react';

export interface WorkbenchJobRow {
  id: string;
  title: string;
  status: string;
  progressCurrent: number;
  progressTotal?: number;
  progressMessage?: string;
  error?: string;
}

export interface WorkbenchHistoryRow {
  opId: string;
  status: string;
  mode: string;
  summary: string;
  createdAt: string;
  fileCount: number;
  canRollback: boolean;
}

export interface WorkbenchDiagnosticRow {
  severity: string;
  code: string;
  message: string;
  resourceUri?: string;
}

export interface WorkbenchPatchImpactView {
  patchId: string;
  changedResources: string[];
  directReferenceImpact: string[];
  reverseReferenceImpact: string[];
  validatorsToRun: string[];
  candidateRiskCount: number;
  confirmedEdgeCount: number;
  reindexTargets: string[];
}

export interface WorkbenchOpsPanelProps {
  jobs: WorkbenchJobRow[];
  history: WorkbenchHistoryRow[];
  diagnostics: WorkbenchDiagnosticRow[];
  patchImpact?: WorkbenchPatchImpactView | null;
  onCancelJob?: (jobId: string) => void;
  onRollback?: (opId: string) => void;
}

type TabId = 'jobs' | 'history' | 'diagnostics' | 'patch';

/**
 * 任务 / 历史 / 诊断 / 补丁影响 统一工作台。
 * 数据由 main/core 投影后注入；不持有绝对路径或密钥。
 */
export function WorkbenchOpsPanel(props: WorkbenchOpsPanelProps): ReactElement {
  const [tab, setTab] = useState<TabId>('jobs');
  const tabs: Array<{ id: TabId; label: string }> = useMemo(() => [
    { id: 'jobs', label: '任务' },
    { id: 'history', label: '历史' },
    { id: 'diagnostics', label: '诊断' },
    { id: 'patch', label: '补丁影响' }
  ], []);

  return (
    <section className="panel" aria-label="工作台运维">
      <header className="panel-header">
        <h3>工作台：任务 / 历史 / 诊断</h3>
        <span className="muted">
          {props.jobs.length} 任务 · {props.history.length} 历史 · {props.diagnostics.length} 诊断
        </span>
      </header>
      <div className="row gap" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'jobs' && (
        <div className="binder-child-table" role="table">
          <div className="binder-child-row binder-child-header" role="row">
            <span>标题</span>
            <span>状态</span>
            <span>进度</span>
            <span>操作</span>
          </div>
          {props.jobs.length === 0 && (
            <p className="muted">暂无任务。索引、Bridge 与验证任务会出现在此。</p>
          )}
          {props.jobs.map((job) => (
            <div key={job.id} className="binder-child-row" role="row">
              <span>{job.title}</span>
              <span>{statusLabel(job.status)}</span>
              <span className="muted">
                {job.progressCurrent}
                {job.progressTotal !== undefined ? `/${job.progressTotal}` : ''}
                {job.progressMessage ? ` · ${job.progressMessage}` : ''}
                {job.error ? ` · ${job.error}` : ''}
              </span>
              <span>
                {(job.status === 'queued' || job.status === 'running') && (
                  <button type="button" onClick={() => props.onCancelJob?.(job.id)}>
                    取消
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'history' && (
        <div className="binder-child-table" role="table">
          <div className="binder-child-row binder-child-header" role="row">
            <span>摘要</span>
            <span>状态</span>
            <span>文件</span>
            <span>操作</span>
          </div>
          {props.history.length === 0 && (
            <p className="muted">暂无补丁历史。提交后可在此回滚。</p>
          )}
          {props.history.map((row) => (
            <div key={row.opId} className="binder-child-row" role="row">
              <span title={row.opId}>{row.summary}</span>
              <span>{row.status}</span>
              <span className="muted">{row.fileCount}</span>
              <span>
                {row.canRollback && (
                  <button type="button" onClick={() => props.onRollback?.(row.opId)}>
                    回滚
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'diagnostics' && (
        <div className="binder-child-table" role="table">
          <div className="binder-child-row binder-child-header" role="row">
            <span>级别</span>
            <span>代码</span>
            <span>消息</span>
          </div>
          {props.diagnostics.length === 0 && (
            <p className="muted">暂无诊断。</p>
          )}
          {props.diagnostics.map((d, index) => (
            <div key={`${d.code}-${index}`} className="binder-child-row" role="row">
              <span className={d.severity === 'error' ? 'danger' : undefined}>{d.severity}</span>
              <span>{d.code}</span>
              <span title={d.resourceUri}>{d.message}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'patch' && (
        <div>
          {!props.patchImpact && (
            <p className="muted">尚无待提交补丁影响图。生成 PatchIR 后显示引用与验证范围。</p>
          )}
          {props.patchImpact && (
            <div className="stack gap">
              <p>
                补丁 <code>{props.patchImpact.patchId}</code>
              </p>
              <p className="muted">
                变更 {props.patchImpact.changedResources.length} ·
                正向引用 {props.patchImpact.directReferenceImpact.length} ·
                反向引用 {props.patchImpact.reverseReferenceImpact.length} ·
                已确认边 {props.patchImpact.confirmedEdgeCount} ·
                候选风险 {props.patchImpact.candidateRiskCount}
              </p>
              <div>
                <strong>变更资源</strong>
                <ul>
                  {props.patchImpact.changedResources.map((uri) => (
                    <li key={uri}><code>{uri}</code></li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>将运行的验证器</strong>
                <ul>
                  {props.patchImpact.validatorsToRun.map((id) => (
                    <li key={id}>{id}</li>
                  ))}
                  {props.patchImpact.validatorsToRun.length === 0 && (
                    <li className="muted">（无）</li>
                  )}
                </ul>
              </div>
              <div>
                <strong>重索引目标</strong>
                <ul>
                  {props.patchImpact.reindexTargets.map((uri) => (
                    <li key={uri}><code>{uri}</code></li>
                  ))}
                  {props.patchImpact.reindexTargets.length === 0 && (
                    <li className="muted">（无）</li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'queued':
      return '排队';
    case 'running':
      return '运行中';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}
