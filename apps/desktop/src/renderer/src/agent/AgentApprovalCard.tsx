import type { ReactElement } from 'react';
import {
  approvalSeverity,
  classifyDiffLines,
  describeApprovalLevel,
  type AgentApprovalDiffView,
  type AgentApprovalPreview
} from './agentTaskState.js';

/** 提交失败的结构化诊断：必须说明失败阶段与是否已自动回滚（§12.9）。 */
export interface AgentApprovalCommitFailure {
  /** 失败阶段（stage/commit/verify/rollback…）。 */
  stage: string;
  /** 是否已自动回滚。 */
  rolledBack: boolean;
  /** 结构化诊断文案（不吞异常）。 */
  message: string;
}

export interface AgentApprovalCardProps {
  /** 审批 id（callId；消息流语境下即 reviewId）。 */
  id: string;
  toolName: string;
  permissionLevel: string;
  step: number;
  /** Redacted arguments as emitted by the model. */
  argumentsJson: string;
  /** 主进程算出的 unified diff；null = 主进程未能给出 diff。 */
  diff: AgentApprovalDiffView | null;
  /** 字段级预览（diff 缺失时的唯一具体内容）。 */
  preview: AgentApprovalPreview | null;
  /** 唯一主按钮「批准并提交」；走真实 IPC（renderer → preload → main）。 */
  onApprove: () => void;
  /** 拒绝；走真实 IPC。 */
  onReject: () => void;
  /** 提交中：按钮 disabled 防重复提交。 */
  submitting: boolean;
  /** 提交失败的结构化诊断；null = 无错误。 */
  commitFailure: AgentApprovalCommitFailure | null;
}

function unavailable(reason: string): ReactElement {
  return <span className="agent-approval-card__unavailable" data-testid="approval-unavailable">不可用（{reason}）</span>;
}

/**
 * §12.9 Change Review —— 消息流里**唯一**允许明显边界的审批卡（§12.5）。
 *
 * 必须显示七个要素：操作 / 逻辑目标 / diff / 影响范围 / 验证 / 备份 / 回滚。
 * 审批请求未携带的要素如实显示「不可用」，不编造（§12.9「缺的如实显示」）。
 * 「批准并提交」是唯一主按钮；提交失败必须说明失败阶段、是否已自动回滚与下一步。
 *
 * 本卡不替换侧栏：它是一个有界卡片（max-height + overflow），失败态同样折叠在
 * 卡内，不升级成全屏错误块。
 */
export function AgentApprovalCard(props: AgentApprovalCardProps): ReactElement {
  const {
    id,
    toolName,
    permissionLevel,
    step,
    argumentsJson,
    diff,
    preview,
    onApprove,
    onReject,
    submitting,
    commitFailure
  } = props;

  const operation = `${toolName} · ${permissionLevel} · ${describeApprovalLevel(permissionLevel)}`;
  const target = diff?.targetPath ?? preview?.targetPath ?? preview?.targetUri ?? null;
  const impactParts: string[] = [];
  if (diff !== null) {
    impactParts.push(`+${diff.addedLines} / -${diff.removedLines} 行`);
    if (diff.newFile) impactParts.push('新文件');
  } else if (preview?.changeCount !== null && preview?.changeCount !== undefined) {
    impactParts.push(`${preview.changeCount} 处改动`);
  }

  return (
    <section
      className={`agent-approval-card is-${approvalSeverity(permissionLevel)}`}
      data-testid="agent-approval-card"
      aria-label={`Change Review：${operation}`}
    >
      <div className="agent-approval-card__head">
        <strong>{toolName}</strong>
        <span className="agent-approval-card__level">{permissionLevel} · {describeApprovalLevel(permissionLevel)}</span>
      </div>
      <p className="agent-approval-card__step">请求执行。批准并提交后任务才会继续。</p>

      <dl className="agent-approval-card__review">
        <div className="agent-approval-card__row" data-testid="approval-row-operation">
          <dt>操作</dt>
          <dd>{operation}</dd>
        </div>
        <div className="agent-approval-card__row" data-testid="approval-row-target">
          <dt>目标</dt>
          <dd>{target === null ? unavailable('该审批未携带逻辑目标') : <code>{target}</code>}</dd>
        </div>
        <div className="agent-approval-card__row" data-testid="approval-row-diff">
          <dt>diff</dt>
          <dd>
            {diff === null
              ? (preview?.newText !== null && preview?.newText !== undefined
                ? (
                  <div className="agent-approval-card__diff">
                    <pre className="agent-approval-card__diff-body" data-testid="agent-approval-card-diff-body">
                      {preview.newText}
                    </pre>
                  </div>
                )
                : unavailable('主进程未能为该调用生成 diff'))
              : (
                <div className="agent-approval-card__diff">
                  <pre className="agent-approval-card__diff-body" data-testid="agent-approval-card-diff-body">
                    {classifyDiffLines(diff.unifiedDiff).map((line, index) => (
                      <span key={`${index}-${line.text}`} className={`diff-line is-${line.kind}`}>
                        {line.text === '' ? ' ' : line.text}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                  {diff.truncatedNote !== undefined && (
                    <p className="muted" data-testid="agent-approval-card-diff-truncation">{diff.truncatedNote}</p>
                  )}
                </div>
              )}
          </dd>
        </div>
        <div className="agent-approval-card__row" data-testid="approval-row-impact">
          <dt>影响范围</dt>
          <dd>
            {impactParts.length > 0
              ? impactParts.join(' · ')
              : unavailable('该审批未携带影响范围数据')}
          </dd>
        </div>
        <div className="agent-approval-card__row" data-testid="approval-row-validation">
          <dt>验证</dt>
          <dd>{unavailable('该审批未携带验证信息')}</dd>
        </div>
        <div className="agent-approval-card__row" data-testid="approval-row-backup">
          <dt>备份</dt>
          <dd>{unavailable('该审批未携带备份信息')}</dd>
        </div>
        <div className="agent-approval-card__row" data-testid="approval-row-rollback">
          <dt>回滚</dt>
          <dd>{unavailable('该审批未携带回滚信息')}</dd>
        </div>
      </dl>

      {/* 原始参数始终可查：预览是解读，原始值才是将要执行的东西。 */}
      <details className="agent-approval-card__args">
        <summary>原始参数</summary>
        <pre className="tool-output" data-testid="agent-approval-card-arguments">{argumentsJson}</pre>
      </details>

      <div className="row gap agent-approval-card__actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={submitting}
          data-testid="agent-approval-card-approve"
          onClick={onApprove}
        >
          批准并提交
        </button>
        <button
          type="button"
          className="btn btn--danger btn--sm"
          disabled={submitting}
          data-testid="agent-approval-card-reject"
          onClick={onReject}
        >
          拒绝
        </button>
      </div>

      {commitFailure !== null && (
        <div className="agent-approval-card__failure" data-testid="agent-approval-card-failure" role="alert">
          <strong>提交失败</strong>
          <p data-testid="agent-approval-card-failure-stage">失败阶段：{commitFailure.stage}</p>
          <p data-testid="agent-approval-card-failure-rollback">
            自动回滚：{commitFailure.rolledBack ? '已执行' : '未执行'}
          </p>
          <p className="muted">{commitFailure.message}</p>
          <p className="muted">下一步：检查 Problems 诊断；确认目标状态后重试，或先恢复备份。</p>
        </div>
      )}
    </section>
  );
}
