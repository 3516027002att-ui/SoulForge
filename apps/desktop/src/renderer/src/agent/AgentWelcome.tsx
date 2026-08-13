import type { ReactElement } from 'react';

/**
 * 空闲欢迎态（§12.4 固定文案，唯一允许的欢迎文案，禁止自己发明）。
 *
 * 只在没有消息且没有活动任务时显示；禁止推荐问题按钮、四步教程、工具数量、
 * 会话数量和模型警告。勾选标记由 CSS 用 `var(--ok)` 渲染，不进入 DOM 文本。
 * 未对照 TRAE 实测：参考截图不在仓库内，图标容器与排版按 §12.2.1 初值。
 */
export function AgentWelcome(): ReactElement {
  return (
    <div className="agent-welcome" data-testid="agent-empty-state">
      <div className="agent-welcome__icon" aria-hidden="true">✦</div>
      <h2>Agent</h2>
      <p>面向 Sekiro Mod 的安全协作编辑</p>
      <ul>
        <li>理解当前参数、文本、事件与资源选区</li>
        <li>先分析与规划，再生成可审查的修改</li>
        <li>经 Patch Engine 提交，验证失败自动回滚</li>
      </ul>
    </div>
  );
}
