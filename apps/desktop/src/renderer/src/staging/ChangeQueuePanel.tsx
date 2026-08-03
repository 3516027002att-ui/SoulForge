import type { ReactElement } from 'react';
import type { CandidateChange, ChangeControlState, ChangeStatus } from './changeControl.js';

const KIND_LABEL: Record<CandidateChange['kind'], string> = {
  text: '文本',
  fmg: 'FMG 条目',
  'param-row': 'PARAM 行',
  'param-field': 'PARAM 字段'
};

const STATUS_LABEL: Record<ChangeStatus, string> = {
  draft: '待审查',
  staged: '已暂存',
  validating: '校验中',
  writing: '写入中',
  written: '已写入',
  failed: '写入失败',
  rejected: '已拒绝'
};

export interface ChangeQueueActions {
  approve: (id: string) => void;
  reject: (id: string) => void;
  undoToDraft: (id: string) => void;
  discard: (id: string) => void;
  clearTerminal: () => void;
  commit: () => void;
}

function ChangeRow({
  item,
  actions
}: {
  item: CandidateChange;
  actions: ChangeQueueActions;
}): ReactElement {
  return (
    <li className="cq-row" data-change-id={item.id} data-status={item.status}>
      <div className="cq-row-main">
        <span className="cq-kind">{KIND_LABEL[item.kind]}</span>
        <span className="cq-target mono" title={item.sourceUri}>{item.target}</span>
        <span className={`cq-status cq-status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
      </div>
      <div className="cq-summary">
        {item.oldValue !== '' && <s className="cq-old">{item.oldValue}</s>}
        {item.oldValue !== '' && <span aria-hidden="true"> → </span>}
        <span className="cq-new">{item.summary}</span>
      </div>
      {item.diagnostics.length > 0 && (
        <ul className="cq-diagnostics" role="alert">
          {item.diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}-${index}`}>
              <span className="mono">{diagnostic.code}</span>：{diagnostic.message}
            </li>
          ))}
        </ul>
      )}
      <div className="cq-actions">
        {(item.status === 'draft' || item.status === 'failed' || item.status === 'rejected') && (
          <button type="button" onClick={() => actions.approve(item.id)}>批准入暂存</button>
        )}
        {(item.status === 'draft' || item.status === 'failed') && (
          <button type="button" onClick={() => actions.reject(item.id)}>拒绝</button>
        )}
        {item.status === 'staged' && (
          <>
            <button type="button" onClick={() => actions.undoToDraft(item.id)}>撤回到候选</button>
            <button type="button" onClick={() => actions.discard(item.id)}>移除</button>
          </>
        )}
        {(item.status === 'written' || item.status === 'rejected') && (
          <button type="button" onClick={() => actions.discard(item.id)}>清除记录</button>
        )}
      </div>
    </li>
  );
}

export function ChangeQueuePanel({
  state,
  actions
}: {
  state: ChangeControlState;
  actions: ChangeQueueActions;
}): ReactElement {
  const drafts = state.items.filter((item) => item.status === 'draft');
  const staged = state.items.filter((item) => item.status === 'staged');
  const inFlight = state.items.filter(
    (item) => item.status === 'validating' || item.status === 'writing'
  );
  const terminal = state.items.filter(
    (item) => item.status === 'written' || item.status === 'rejected'
  );
  const failed = state.items.filter((item) => item.status === 'failed');

  return (
    <section className="change-queue" aria-label="变更审查与暂存">
      <div className="panel-header">
        <h2>变更队列</h2>
        <span className="cq-counts" data-testid="cq-counts">
          待审查 {drafts.length} · 已暂存 {staged.length}
          {failed.length > 0 ? ` · 失败 ${failed.length}` : ''}
        </span>
      </div>

      {state.items.length === 0 && (
        <p className="muted">
          没有候选变更。在文本编辑器或 FMG / PARAM 面板中的编辑会进入此队列，经审查批准后写入。
        </p>
      )}

      {drafts.length > 0 && (
        <>
          <h3 className="cq-section-title">待审查（候选）</h3>
          <ul className="cq-list">
            {drafts.map((item) => <ChangeRow key={item.id} item={item} actions={actions} />)}
          </ul>
        </>
      )}

      {staged.length > 0 && (
        <>
          <h3 className="cq-section-title">已暂存（等待写入）</h3>
          <ul className="cq-list">
            {staged.map((item) => <ChangeRow key={item.id} item={item} actions={actions} />)}
          </ul>
        </>
      )}

      {inFlight.length > 0 && (
        <>
          <h3 className="cq-section-title">执行中</h3>
          <ul className="cq-list">
            {inFlight.map((item) => <ChangeRow key={item.id} item={item} actions={actions} />)}
          </ul>
        </>
      )}

      {failed.length > 0 && (
        <>
          <h3 className="cq-section-title">失败（原因见诊断）</h3>
          <ul className="cq-list">
            {failed.map((item) => <ChangeRow key={item.id} item={item} actions={actions} />)}
          </ul>
        </>
      )}

      {terminal.length > 0 && (
        <>
          <h3 className="cq-section-title">已完成</h3>
          <ul className="cq-list">
            {terminal.map((item) => <ChangeRow key={item.id} item={item} actions={actions} />)}
          </ul>
        </>
      )}

      <div className="cq-footer">
        <button
          type="button"
          className="cq-commit"
          disabled={staged.length === 0 || state.committing}
          onClick={actions.commit}
          data-testid="cq-commit"
        >
          {state.committing
            ? '写入中…'
            : staged.length > 0
              ? `写入 ${staged.length} 项已暂存变更`
              : '写入（无已暂存变更）'}
        </button>
        <p className="muted">写入前自动备份原文件；已写入的变更可在操作历史回滚。</p>
        {terminal.length > 0 && (
          <button type="button" onClick={actions.clearTerminal}>清除已完成记录</button>
        )}
      </div>
    </section>
  );
}
