import {
  Children,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode
} from 'react';
import { Liquid } from 'liquid-gooey';
import { useReducedMotion } from './useReducedMotion.js';

export interface LiquidActionGroupProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  children: ReactNode;
  /** 方向：'vertical' 竖向展开（默认向下或向上），'horizontal' 横向展开 */
  direction?: 'vertical' | 'horizontal';
  /** 子按钮间距 (px)，默认 36 */
  spacing?: number;
  /** 液体背景填充色，默认半透明底 */
  fill?: string;
  /** Gooey 模糊半径，默认 5.5 */
  blur?: number;
  /** 边缘对比度，默认 18 */
  contrast?: number;
  /** 阴影 */
  shadow?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * LiquidActionGroup:
 * 展开式操作按钮组 / 悬浮小菜单的液体分裂与融合封装。
 * 在展开时，子按钮像小水滴一样从主按钮中心拉伸、分离并稳定；
 * 收起时反向融合吸附回主按钮。
 */
export function LiquidActionGroup({
  open,
  children,
  direction = 'vertical',
  spacing = 34,
  fill = 'var(--forge-2)',
  blur = 5.5,
  contrast = 18,
  shadow = '0 2px 8px rgba(0, 0, 0, 0.08)',
  className = '',
  style = {},
  ...rest
}: LiquidActionGroupProps): ReactElement {
  const reducedMotion = useReducedMotion();
  const childArray = Children.toArray(children);

  if (reducedMotion) {
    // 降级模式：无 liquid morph，使用普通显示/隐藏
    return (
      <div
        className={`liquid-action-group liquid-action-group--fallback ${open ? 'is-open' : 'is-closed'} ${className}`}
        style={{
          display: 'flex',
          flexDirection: direction === 'vertical' ? 'column' : 'row',
          gap: `${spacing / 3}px`,
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 150ms ease',
          ...style
        }}
        {...rest}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={`liquid-action-group ${open ? 'is-open' : 'is-closed'} ${className}`}
      style={{
        position: 'relative',
        pointerEvents: open ? 'auto' : 'none',
        ...style
      }}
      {...rest}
    >
      <Liquid
        blur={blur}
        contrast={contrast}
        fill={fill}
        shadow={shadow}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: direction === 'vertical' ? 'column' : 'row',
          alignItems: 'center'
        }}
      >
        {childArray.map((child, index) => {
          const offset = (index + 1) * spacing;
          const targetX = direction === 'horizontal' ? (open ? offset : 0) : 0;
          const targetY = direction === 'vertical' ? (open ? offset : 0) : 0;

          return (
            <Liquid.Item
              key={index}
              effect="morph"
              x={targetX}
              y={targetY}
              transition={{
                stiffness: 380,
                damping: 24,
                mass: 0.85
              }}
              delay={open ? index * 25 : (childArray.length - index) * 15}
            >
              <div
                style={{
                  opacity: open ? 1 : 0,
                  transition: `opacity ${open ? '180ms' : '100ms'} ease`,
                  pointerEvents: open ? 'auto' : 'none'
                }}
              >
                {child}
              </div>
            </Liquid.Item>
          );
        })}
      </Liquid>
    </div>
  );
}
