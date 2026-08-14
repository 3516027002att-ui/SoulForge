import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react';

/** dock 左缘拖拽手柄宽度（§12.2 初值，未对照 TRAE 实测）。 */
export const AGENT_DOCK_RESIZER_WIDTH = 4;
/** 键盘一次 resize 的像素步长（§12.2：鼠标拖动或键盘每次 16px）。 */
export const AGENT_DOCK_KEYBOARD_STEP = 16;

/** 键盘 resize 支持的按键；Home/End 直接跳到最小/最大。 */
export type AgentDockResizeKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/**
 * 宽度收敛到 [minWidth, maxWidth]，并取整。
 *
 * 独立成纯函数：reload 恢复、拖拽、键盘三处共用同一个口径，任何一处绕过
 * 这个收敛都会让 340/620 边界在界面上不一致。
 */
export function clampAgentDockWidth(value: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
}

/**
 * 键盘按一次后的目标宽度（纯函数，便于单测锁定 16px 步长与边界）。
 *
 * 方向约定与拖拽一致：ArrowLeft 把 dock 左缘向左移（变宽），ArrowRight 变窄。
 */
export function dockWidthForResizeKey(
  key: AgentDockResizeKey,
  currentWidth: number,
  minWidth: number,
  maxWidth: number
): number {
  if (key === 'ArrowLeft') {
    return clampAgentDockWidth(currentWidth + AGENT_DOCK_KEYBOARD_STEP, minWidth, maxWidth);
  }
  if (key === 'ArrowRight') {
    return clampAgentDockWidth(currentWidth - AGENT_DOCK_KEYBOARD_STEP, minWidth, maxWidth);
  }
  if (key === 'Home') return minWidth;
  return maxWidth; // 'End'
}

export interface AgentDockResizerProps {
  /** dock 收起时隐藏且不可聚焦（仍是 4px 分隔线语义，但不可拖拽）。 */
  overlay: boolean;
  currentWidth: number;
  minWidth: number;
  maxWidth: number;
  onWidthChange: (width: number) => void;
}

/**
 * Agent dock 左缘的 4px 拖拽/键盘 resizer（§12.2 组件树的根级子项）。
 *
 * 常驻主窗口右侧稳定 pane 的左边缘，不是可拆停靠手柄：拖拽只改宽度，不产生
 * 停靠/浮动。宽度状态由 App 持有（App 要拿它算中央编辑器余量与 workspace 持久化），
 * 这里只回报收敛后的新宽度。
 */
export function AgentDockResizer(props: AgentDockResizerProps): ReactElement {
  const { overlay, currentWidth, minWidth, maxWidth, onWidthChange } = props;
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: currentWidth };
    const handleMove = (moveEvent: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      onWidthChange(clampAgentDockWidth(
        drag.startWidth - (moveEvent.clientX - drag.startX),
        minWidth,
        maxWidth
      ));
    };
    const handleUp = (): void => {
      dragRef.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const key = event.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    onWidthChange(dockWidthForResizeKey(key, currentWidth, minWidth, maxWidth));
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整 Agent 面板宽度"
      aria-valuenow={overlay ? undefined : currentWidth}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      className={overlay ? 'agent-dock-resizer is-hidden' : 'agent-dock-resizer'}
      tabIndex={overlay ? -1 : 0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
