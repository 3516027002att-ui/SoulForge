import type { ReactElement } from 'react';
import { formatBytes } from '../format/uiText.js';
import {
  approvalSeverity,
  classifyDiffLines,
  describeApprovalLevel,
  type AgentApprovalDecisionView,
  type AgentApprovalView
} from './agentTaskState.js';

export interface AgentApprovalPanelProps {
  pending: AgentApprovalView[];
  decisions: AgentApprovalDecisionView[];
  /** 回答一条审批。四档语义见 ApprovalDecision。 */
  onRespond: (callId: string, decision: 'once' | 'always' | 'reject' | 'never') => void;
  /** 正在发送回答的 callId；期间禁用该卡片按钮，避免重复提交。 */
  respondingCallId: string | null;
  /** 上一次回答失败的原因；null 表示无错误。 */
  respondError: string | null;
}

function severityClass(level: string): string {
  return `agent-approval is-${approvalSeverity(level)}`;
}

function decisionLabel(decision: AgentApprovalDecisionView['decision']): string {
  return ({
    once: '已批准（仅这一次）',
    always: '已批准（本会话内不再询问）',
    reject: '已拒绝',
    never: '已拒绝（本会话内不再询问）'
  } as const)[decision];
}

/**
 * 审批面板：待批准的写类操作、改动预览、四档决定，以及已回答记录。
 *
 * 为什么审批必须是**独立且置顶**的区块：等待审批是唯一一种「不操作就永远不会
 * 推进」的进行中状态。把它混在进度日志里，用户会当成普通的「模型在想」而一直
 * 等下去，而主进程那边的 loop 正停在工具阶段等回答，十分钟后按拒绝结算。
 *
 * 为什么不做「全部批准」按钮：一次点击放行一批未逐条看过的写操作，等于把审批
 * 降级成一个确认框。每条审批对应一个具体动作（写哪个文件、写成什么），逐条回答
 * 是这层设计的意义所在。always 已经覆盖了「同一工具不想被反复问」的诉求，
 * 且它的作用域限于本会话。
 *
 * ── 关于「按 Codex VSCode 插件形态」这条要求 ──
 *
 * 任务要求照 Codex 插件的审批形态来做。实际依据**不是**对该插件的调研：
 * 两次派出的界面调研都没有返回结论，本组件的形态是从本项目自己的权限阶梯
 * （ai/toolPermissions.ts 的七级 read→rollback）与 agentLoop 的审批门推出来的：
 *
 *   - 三档危险度来自等级语义，不是抄来的配色：commit/rollback 不可能靠再跑
 *     一次撤销，stage/write 可以，read/analyze 不该弹窗；
 *   - 四档决定（once/always/reject/never）对应 loop 的 ApprovalDecision，
 *     会话内记忆的作用域也由那一层决定；
 *   - 改动预览是真正的 before/after unified diff，由主进程读当前文件后用
 *     packages/core/src/patch/textDiff.ts 的 createUnifiedDiff 算出。
 *
 * 这里更正过一次错误判断：我起初写的是「审批发生在执行之前，磁盘上还没有改动
 * 可读，所以只能显示将要写什么」，并据此做了单侧预览。那个理由站不住——原文件
 * 现在就能读，新内容也在参数里，两侧都齐；而 createUnifiedDiff 早已存在于
 * 仓库中，PatchChange 也一直有 diff 字段。缺的不是条件，是我没去找。
 *
 * 所以这些选择都能在本仓库内被检验，但**不声称与 Codex 逐项一致**。若日后
 * 拿到该插件的实际形态而与此处冲突，冲突点应重新裁定，而不是默认本处正确。
 *
 * 全部状态由上层以受控 props 下发；本组件不持有全局状态、不直接调 IPC。
 */
export function AgentApprovalPanel({
  pending,
  decisions,
  onRespond,
  respondingCallId,
  respondError
}: AgentApprovalPanelProps): ReactElement | null {
  if (pending.length === 0 && decisions.length === 0) return null;

  return (
    <div className="agent-block" data-testid="agent-approval-panel">
      <div className="agent-block__label">
        {pending.length > 0 ? `等待批准 ${pending.length} 项` : '审批记录'}
      </div>

      {respondError !== null && (
        <p className="danger" data-testid="agent-approval-error">{respondError}</p>
      )}

      {pending.map((entry) => (
        <div key={entry.callId} className={severityClass(entry.permissionLevel)} data-testid="agent-approval-card">
          <div className="agent-approval__head">
            <strong>{entry.toolName}</strong>
            <span className="agent-approval__level" data-testid="agent-approval-level">
              {entry.permissionLevel} · {describeApprovalLevel(entry.permissionLevel)}
            </span>
          </div>
          <p className="agent-approval__step">第 {entry.step} 步请求执行。批准或拒绝后任务才会继续。</p>

          {/* 改动 diff 预览。
              主进程读当前文件、用 createUnifiedDiff 算出 before/after 两侧的
              unified diff（apps/desktop/src/main/ipc.ts 的 resolveApprovalDiff）；
              renderer 没有文件系统访问，算不了。
              diff 为 null 时**明说**主进程没能给出 diff，并退回字段级预览——
              空着或显示一个空 diff 面板会让用户以为「没有改动」。 */}
          {entry.diff !== null && (
            <div className="agent-approval__diff" data-testid="agent-approval-diff">
              <div className="agent-approval__diff-head">
                <code>{entry.diff.targetPath}</code>
                <span className="agent-approval__diff-stat">
                  {entry.diff.newFile ? '新文件 · ' : ''}
                  <span className="is-add">+{entry.diff.addedLines}</span>
                  {' / '}
                  <span className="is-remove">-{entry.diff.removedLines}</span>
                </span>
              </div>
              <pre className="agent-approval__diff-body" data-testid="agent-approval-diff-body">
                {classifyDiffLines(entry.diff.unifiedDiff).map((line, index) => (
                  <span key={`${index}-${line.text}`} className={`diff-line is-${line.kind}`}>
                    {line.text === '' ? ' ' : line.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
              {entry.diff.truncatedNote !== undefined && (
                <p className="muted" data-testid="agent-approval-diff-truncation">
                  {entry.diff.truncatedNote}
                </p>
              )}
            </div>
          )}
          {entry.diff === null && (
            <p className="muted" data-testid="agent-approval-no-diff">
              主进程未能为这次调用生成 diff（可能是该工具不写文件、目标路径无法解析，
              或参数里没有新内容）。下方是能解析出的字段与原始参数。
            </p>
          )}

          {/* 字段级预览：diff 在手时它是辅助信息，diff 缺失时它是唯一的具体内容。 */}
          {entry.preview !== null ? (
            <div className="agent-approval__preview" data-testid="agent-approval-preview">
              {entry.preview.targetPath !== null && (
                <div className="agent-approval__target">
                  <span className="agent-approval__target-label">目标文件</span>
                  <code>{entry.preview.targetPath}</code>
                </div>
              )}
              {entry.preview.targetPath === null && entry.preview.targetUri !== null && (
                <div className="agent-approval__target">
                  <span className="agent-approval__target-label">目标 URI</span>
                  <code>{entry.preview.targetUri}</code>
                </div>
              )}
              {entry.preview.changeCount !== null && (
                <p className="muted">该提案声明了 {entry.preview.changeCount} 处改动。</p>
              )}
              {entry.preview.newText !== null && (
                // diff 在手时默认折叠：两者内容重叠，展开两份会让卡片翻倍。
                // diff 缺失时展开——那时它是唯一能看到的内容。
                <details open={entry.diff === null}>
                  <summary>将写入的完整内容</summary>
                  <pre className="tool-output" data-testid="agent-approval-newtext">{entry.preview.newText}</pre>
                  {entry.preview.truncatedBytes > 0 && (
                    <p className="muted" data-testid="agent-approval-truncation">
                      预览已截断，另有 {formatBytes(entry.preview.truncatedBytes)} 未显示。
                      完整内容会在提交前经 Patch Engine 校验。
                    </p>
                  )}
                </details>
              )}
              {entry.preview.targetPath === null
                && entry.preview.targetUri === null
                && entry.preview.newText === null && (
                <p className="muted">参数里没有可识别的目标路径或内容，下方是原始参数。</p>
              )}
            </div>
          ) : (
            <p className="muted" data-testid="agent-approval-no-preview">
              参数不是有效 JSON 或不含可识别的改动字段，无法生成预览。下方是原始参数。
            </p>
          )}

          {/* 原始参数始终可查：预览是解读，原始值才是将要执行的东西。
              默认折叠，避免把长参数顶在决定按钮之前。 */}
          <details>
            <summary>原始参数</summary>
            <pre className="tool-output" data-testid="agent-approval-arguments">{entry.argumentsJson}</pre>
          </details>

          <div className="row gap agent-approval__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={respondingCallId !== null}
              data-testid="agent-approval-once"
              onClick={() => onRespond(entry.callId, 'once')}
            >
              批准这一次
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={respondingCallId !== null}
              data-testid="agent-approval-reject"
              onClick={() => onRespond(entry.callId, 'reject')}
            >
              拒绝
            </button>
            {/* always / never 放在次级位置：它们的影响超出当前这一次调用，
                不该和「批准这一次」一样容易点到。 */}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={respondingCallId !== null}
              title={`本会话内不再询问 ${entry.toolName}，直接放行`}
              data-testid="agent-approval-always"
              onClick={() => onRespond(entry.callId, 'always')}
            >
              总是批准此工具
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={respondingCallId !== null}
              title={`本会话内不再询问 ${entry.toolName}，直接拒绝`}
              data-testid="agent-approval-never"
              onClick={() => onRespond(entry.callId, 'never')}
            >
              总是拒绝此工具
            </button>
          </div>
          <p className="muted agent-approval__scope">
            「总是」只在当前会话内生效，不会写入配置、也不会带到下一个会话。
          </p>
        </div>
      ))}

      {decisions.length > 0 && (
        <details data-testid="agent-approval-history">
          <summary>已回答 {decisions.length} 项</summary>
          <div className="agent-log">
            {decisions.map((entry) => (
              <div
                key={entry.callId}
                className={entry.decision === 'reject' || entry.decision === 'never'
                  ? 'agent-log__row is-danger'
                  : 'agent-log__row is-ok'}
              >
                <span>
                  {entry.toolName} · {decisionLabel(entry.decision)}
                  {/* fromMemory 必须显式标注：否则「按上次决定自动放行」会被
                      读成「用户刚刚批准了这一次」。 */}
                  {entry.fromMemory ? ' · 按本会话既有决定自动处理' : ''}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
