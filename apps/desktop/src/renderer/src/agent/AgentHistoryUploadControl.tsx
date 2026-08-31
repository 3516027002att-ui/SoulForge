import { useEffect, useState, type ReactElement } from 'react';
import { getRendererBridge } from '../runtime/rendererRuntime.js';

/** 设置页里的全量会话上传入口；具体读取、脱敏、分批和网络请求均在 main。 */
export function AgentHistoryUploadControl(): ReactElement {
  const bridge = getRendererBridge();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (bridge === null || typeof bridge.getFeedbackStatus !== 'function') return undefined;
    let cancelled = false;
    void bridge.getFeedbackStatus()
      .then((result) => {
        if (!cancelled) setConfigured(result.configured);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function submitAllHistory(): Promise<void> {
    if (bridge === null || typeof bridge.submitAllHistory !== 'function') {
      setStatus({ kind: 'error', text: '历史上传仅在完整的 SoulForge 桌面版可用。' });
      return;
    }
    setSubmitting(true);
    setStatus({ kind: 'ok', text: '正在逐会话上传历史，请稍候…' });
    try {
      const result = await bridge.submitAllHistory();
      if (result.ok) {
        setStatus({ kind: 'ok', text: `已上传 ${result.uploadedSessions} 个会话。` });
      } else {
        setStatus({
          kind: 'error',
          text: `历史上传部分完成：成功 ${result.uploadedSessions} 个，失败 ${result.failedSessions.length} 个。`
        });
      }
    } catch (error) {
      setStatus({ kind: 'error', text: `历史上传失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="agent-history-upload" data-testid="agent-history-upload">
      <div className="agent-history-upload__head">
        <strong>反馈与会话记录</strong>
        <span className="muted">上传前会自动清洗凭据，保留工具与资源证据。</span>
      </div>
      <p className="agent-history-upload__endpoint" data-testid="agent-feedback-status">
        {bridge === null
          ? '浏览器预览：未连接反馈服务'
          : configured === null
            ? '正在检查反馈服务…'
            : configured
              ? '反馈服务已配置'
              : '反馈服务未配置'}
      </p>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        data-testid="agent-feedback-submit-all"
        disabled={bridge === null || typeof bridge.submitAllHistory !== 'function' || submitting || configured === false}
        title={configured === false ? '反馈 endpoint 尚未配置' : '逐会话提交全部历史'}
        onClick={() => void submitAllHistory()}
      >
        {submitting ? '上传全部历史中…' : '提交全部会话历史'}
      </button>
      {status !== null && (
        <p className={status.kind === 'ok' ? 'agent-history-upload__status is-ok' : 'agent-history-upload__status is-error'} role="status">
          {status.text}
        </p>
      )}
    </section>
  );
}
