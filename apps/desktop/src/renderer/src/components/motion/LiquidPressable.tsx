import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode
} from 'react';
import { useReducedMotion } from './useReducedMotion.js';

export interface LiquidPressableProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
  /** 按压时的缩放比例，默认 0.96 (克制微压缩) */
  pressScale?: number;
  /** 悬浮时的缩放比例，默认 1.01 */
  hoverScale?: number;
  className?: string;
  style?: CSSProperties;
  /** 是否禁用弹性动画，仅保留普通交互 */
  disableAnimation?: boolean;
}

/**
 * LiquidPressable:
 * SoulForge 基础物理感按钮封装。
 * 提供轻微物理触感按压（scale 0.95~0.97）与柔和回弹（~200ms），
 * 绝不过度晃动或果冻化。
 *
 * 完整组合内部 hover/active 状态与调用方传入的所有事件处理器，
 * 绝不覆盖或吞掉 consumer 的 event handlers。
 */
export const LiquidPressable = forwardRef<HTMLButtonElement, LiquidPressableProps>(function LiquidPressable(
  props,
  ref
): ReactElement {
  const {
    children,
    pressScale = 0.96,
    hoverScale = 1.01,
    className = '',
    style = {},
    disabled = false,
    disableAnimation = false,
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
    onMouseEnter,
    onMouseLeave,
    ...rest
  } = props;

  const [isPressed, setIsPressed] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const reducedMotion = useReducedMotion();

  const handlePointerDown = (e: PointerEvent<HTMLButtonElement>): void => {
    if (!disabled && !disableAnimation) {
      setIsPressed(true);
    }
    onPointerDown?.(e);
  };

  const handlePointerUp = (e: PointerEvent<HTMLButtonElement>): void => {
    if (!disabled) {
      setIsPressed(false);
    }
    onPointerUp?.(e);
  };

  const handlePointerLeave = (e: PointerEvent<HTMLButtonElement>): void => {
    setIsPressed(false);
    setIsHovered(false);
    onPointerLeave?.(e);
  };

  const handlePointerCancel = (e: PointerEvent<HTMLButtonElement>): void => {
    setIsPressed(false);
    setIsHovered(false);
    onPointerCancel?.(e);
  };

  const handleMouseEnter = (e: MouseEvent<HTMLButtonElement>): void => {
    if (!disabled && !disableAnimation) {
      setIsHovered(true);
    }
    onMouseEnter?.(e);
  };

  const handleMouseLeave = (e: MouseEvent<HTMLButtonElement>): void => {
    setIsHovered(false);
    setIsPressed(false);
    onMouseLeave?.(e);
  };

  const scale = disabled || disableAnimation || reducedMotion
    ? 1
    : isPressed
      ? pressScale
      : isHovered
        ? hoverScale
        : 1;

  const springStyle: CSSProperties = reducedMotion || disableAnimation
    ? style
    : {
        transform: `scale(${scale}) translateZ(0)`,
        transition: isPressed
          ? 'transform 85ms cubic-bezier(0.25, 1, 0.5, 1)'
          : 'transform 200ms cubic-bezier(0.25, 1, 0.5, 1)',
        willChange: isPressed || isHovered ? 'transform' : 'auto',
        ...style
      };

  return (
    <button
      ref={ref}
      disabled={disabled}
      className={`liquid-pressable ${isPressed ? 'is-pressed' : ''} ${className}`}
      style={springStyle}
      {...rest}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </button>
  );
});
