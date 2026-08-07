import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';

/**
 * 面板级错误边界。
 *
 * 为什么必须有：renderer 此前**完全没有** ErrorBoundary（全仓搜
 * ErrorBoundary / componentDidCatch / getDerivedStateFromError 零命中）。
 * React 的默认行为是卸载整棵树，所以任何一个面板在渲染或 effect 里抛出的异常
 * 都会让整个界面消失——不是那个面板坏掉，是应用白屏。
 *
 * 实测事故：点资源栏的 `map` 目录时，MsbScenePanel 用空 sourceUri 调场景投影，
 * 校验抛 SCENE_URI_INVALID，界面全部元素随即消失（按钮不在 DOM、其余 tab 点不动、
 * Tab 键无任何停靠点）。根因已在 MsbScenePanel 修掉，但同类风险遍布 8 个资源族面板：
 * 任何一处未预期的空值、越界、格式不符都会复现同样的全局崩溃。
 *
 * 边界的职责是**降级而不是掩盖**：
 *  · 只隔离渲染子树，不吞诊断——错误照样进 console.error 供排查；
 *  · 呈现结构化可读信息（面板名 + 错误消息），而不是空白；
 *  · 提供重试，让用户不必重启整个应用；
 *  · 不自动重试，避免在稳定失败上打转。
 */
interface Props {
  /** 面板名，出现在降级提示里，便于用户与日志对应。 */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PanelErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 不吞异常：诊断必须可查。componentStack 指出是哪个子组件抛的。
    console.error(`[PanelErrorBoundary] ${this.props.label} 渲染失败`, {
      message: error.message,
      componentStack: info.componentStack
    });
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactElement | ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="panel-error" role="alert">
        <div className="panel-error__title">{this.props.label}加载失败</div>
        <p className="panel-error__message">{error.message}</p>
        <p className="muted">
          其余界面仍可使用。诊断已写入开发者控制台。
        </p>
        <button type="button" onClick={this.retry}>重试</button>
      </div>
    );
  }
}
