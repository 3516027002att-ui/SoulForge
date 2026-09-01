import { useEffect, useState, type ReactElement } from 'react';
import type { SessionFeedbackRating } from '@soulforge/shared';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import type { AgentTaskPhase } from './agentTaskState.js';

const RATING_OPTIONS: ReadonlyArray<{
  value: SessionFeedbackRating;
  icon: string;
  label: string;
}> = [
  { value: 'positive', icon: '👍', label: '评价为有帮助' },
  { value: 'negative', icon: '👎', label: '评价为没有帮助' },
  { value: 'incomplete', icon: '✕', label: '评价为未完成' }
];

export interface AgentFeedbackBarProps {
  sessionId: string | null;
  phase: AgentTaskPhase;
}

function isFinished(phase: AgentTaskPhase): boolean {
  return phase === 'done' || phase === 'error';
}

/**
 * 当前 Agent 会话的反馈入口。
 *
 * 评分按钮在没有展开评论框时单击即提交；展开「💬」后可补充评论，再由
 * 「提交反馈」提交。renderer 只把 sessionId/rating/comment 交给 preload，
 * 不读取 rollout 文件，也不接触 endpoint 或任何凭据。
 */
export function AgentFeedbackBar({ sessionId, phase }: AgentFeedbackBarProps): ReactElement | null {
  const bridge = getRendererBridge();
  const [rating, setRating] = useState<SessionFeedbackRating | null>(null);
  const [comment, setComment] = useState('');
  const [commentOpen, setCommentOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    setRating(null);
    setComment('');
    setCommentOpen(false);
    setSubmitting(false);
    setStatus(null);
  }, [sessionId]);

  if (sessionId === null) return null;

  const finished = isFinished(phase);
  const canSubmit = finished && bridge !== null && typeof bridge.submitSessionFeedback === 'function';

  async function submit(nextRating: SessionFeedbackRating | null = rating): Promise<void> {
    if (nextRating === null || sessionId === null) return;
    if (bridge === null || typeof bridge.submitSessionFeedback !== 'function') {
      setStatus({ kind: 'error', text: '反馈上传仅在完整的 SoulForge 桌面版可用。' });
      return;
    }
    setSubmitting(true);
    setStatus(null);
    try {
      const trimmedComment = comment.trim();
      const result = await bridge.submitSessionFeedback(trimmedComment.length > 0
        ? { sessionId, rating: nextRating, comment: trimmedComment }
        : { sessionId, rating: nextRating });
      if (result.ok) {
        setStatus({ kind: 'ok', text: '反馈已上传。' });
        setCommentOpen(false);
      } else {
        setStatus({ kind: 'error', text: `${result.code}：${result.message}` });
      }
    } catch (error) {
      setStatus({ kind: 'error', text: `反馈上传失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setSubmitting(false);
    }
  }

  function selectRating(nextRating: SessionFeedbackRating): void {
    setRating(nextRating);
    if (!commentOpen) void submit(nextRating);
  }

  return (
    <section className="agent-feedback" data-testid="agent-feedback" aria-label="本轮会话反馈">
      <div className="agent-feedback__head">
        <span>这次回答对你有帮助吗？</span>
        <span className="agent-feedback__hint">仅上传本轮脱敏会话记录</span>
      </div>
      <div className="agent-feedback__actions" role="group" aria-label="会话评价">
        {RATING_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`agent-feedback__button${rating === option.value ? ' is-selected' : ''}`}
            aria-label={option.label}
            aria-pressed={rating === option.value}
            disabled={!finished || !canSubmit || submitting}
            title={finished ? option.label : '任务结束后可评价'}
            onClick={() => selectRating(option.value)}
          >
            <span aria-hidden="true">{option.icon}</span>
          </button>
        ))}
        <button
          type="button"
          className={`agent-feedback__button${commentOpen ? ' is-selected' : ''}`}
          aria-label="添加反馈评论"
          aria-pressed={commentOpen}
          disabled={!finished || !canSubmit || submitting}
          title="添加反馈评论"
          onClick={() => setCommentOpen((open) => !open)}
        >
          <span aria-hidden="true">💬</span>
        </button>
      </div>
      {!finished && <p className="agent-feedback__note">任务结束后可以评价本轮结果。</p>}
      {bridge === null && <p className="agent-feedback__note">浏览器预览不提供反馈上传。</p>}
      {commentOpen && (
        <div className="agent-feedback__form">
          <textarea
            value={comment}
            maxLength={2_000}
            rows={3}
            placeholder="补充一条评论（可选）"
            aria-label="反馈评论"
            onChange={(event) => setComment(event.target.value)}
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={rating === null || !canSubmit || submitting}
            onClick={() => void submit()}
          >
            {submitting ? '上传中…' : '提交反馈'}
          </button>
        </div>
      )}
      {status !== null && (
        <p className={status.kind === 'ok' ? 'agent-feedback__status is-ok' : 'agent-feedback__status is-error'} role="status">
          {status.text}
        </p>
      )}
    </section>
  );
}

export { isFinished };
