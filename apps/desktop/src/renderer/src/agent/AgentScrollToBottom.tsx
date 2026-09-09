import { useEffect, useState, type ReactElement, type RefObject } from 'react';
import { shouldAgentAutoScroll, type AgentScrollMetrics } from '@soulforge/shared';

export interface AgentScrollToBottomProps {
  /** 滚动容器引用（由父级持有，统一 scroll 状态）。 */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 点击回到底部后的回调（父级用于对齐消息窗口）。 */
  onScrollToBottom?: () => void;
  /** 测试/渲染注入：覆盖可见性判定。缺省按 60C 的 scroll threshold 实时判定。 */
  visibleOverride?: boolean;
}

/**
 * 纯判定：是否应显示「回到底部」。
 *
 * 与 §12.5「离底部超过 48px 后停止自动滚动并显示『回到底部』」对齐 —— 复用
 * AGENT-60C 的 shouldAgentAutoScroll（shared/agent-ui.ts，阈值 48px）取反。
 */
export function shouldRevealAgentScrollButton(metrics: AgentScrollMetrics): boolean {
  return !shouldAgentAutoScroll(metrics);
}

/** 滚动可见性 hook：订阅滚动容器 + 窗口 resize，贴底即隐藏。 */
export function useAgentScrollToBottom(
  scrollRef: RefObject<HTMLDivElement | null>
): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return undefined;
    const update = (): void => {
      setVisible(shouldRevealAgentScrollButton({
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight
      }));
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      element.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [scrollRef]);

  return visible;
}

/**
 * §12.10 组件树里的 AgentScrollToBottom：消息流「回到底部」浮动按钮。
 *
 * 贴底（距底部 ≤48px）时隐藏；向上滚动离开底部后出现，点击回到最新尾部。
 * 可见性由 60C 的 scroll threshold 驱动（useAgentScrollToBottom），
 * visibleOverride 供测试注入。
 */
export function AgentScrollToBottom(props: AgentScrollToBottomProps): ReactElement {
  const { scrollRef, onScrollToBottom, visibleOverride } = props;
  const scrolledAway = useAgentScrollToBottom(scrollRef);
  const visible = visibleOverride ?? scrolledAway;

  function scrollToBottom(): void {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
    onScrollToBottom?.();
  }

  return (
    <button
      type="button"
      className={`agent-scroll-to-bottom${visible ? ' is-visible' : ''}`}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={scrollToBottom}
      data-testid="agent-scroll-to-bottom"
    >
      回到底部
    </button>
  );
}
