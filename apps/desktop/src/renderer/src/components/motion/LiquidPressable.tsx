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
  /** 按压时的缩放比例，默认 0.95 (克制微压缩) */
  pressScale?: number;
  /** 悬浮时的缩放比例，默认 1.02 */
  hoverScale?: number;
  className?: string;
  style?: CSSProperties;
  /** 是否禁用弹性动画，仅保留普通交互 */
  disableAnimation?: boolean;
}

/**
 * LiquidPressable:
 * SoulForge 基础物理反馈按钮。
 * 提供类似 Apple 风格的轻微材质按压（scale 0.95~0.97）与快速 Spring 回弹（~120ms），
 * 绝不过度晃动或果冻化。
 */
export const LiquidPressable = forwardRef<HTMLButtonElement, LiquidPressableProps>(function LiquidPressable(
  props,
  ref
): ReactElement {
  const {
    children,
    pressScale = 0.95,
    hoverScale = 1.02,
    className = '',
    style = {},
    disabled = false,
    disableAnimation = false,
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
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
          ? 'transform 90ms cubic-bezier(0.2, 0, 0, 1)'
          : 'transform 240ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        willChange: isPressed || isHovered ? 'transform' : 'auto',
        ...style
      };

  return (
    <button
      ref={ref}
      disabled={disabled}
      className={`liquid-pressable ${isPressed ? 'is-pressed' : ''} ${className}`}
      style={springStyle}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      onMouseEnter={() => !disabled && setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      {...rest}
    >
      {children}
    </button>
  );
});
