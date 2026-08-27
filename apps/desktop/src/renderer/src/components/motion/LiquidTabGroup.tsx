import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode
} from 'react';
import { Liquid } from 'liquid-gooey';
import { useReducedMotion } from './useReducedMotion.js';

interface TabRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TabRegistry {
  register: (id: string, element: HTMLElement) => () => void;
}

const TabContext = createContext<TabRegistry | null>(null);

export interface LiquidTabGroupProps extends HTMLAttributes<HTMLDivElement> {
  activeId: string;
  children: ReactNode;
  /** 液体表面填充颜色，默认使用 SoulForge 当前选中底色 */
  fill?: string;
  /** Gooey 模糊半径（px），控制桥接距离。默认 5px（克制优雅） */
  blur?: number;
  /** 边缘对比度，默认 18 */
  contrast?: number;
  /** 阴影 */
  shadow?: string;
  /** 圆角大小（px），默认 4 */
  radius?: number;
  className?: string;
  style?: CSSProperties;
  /** 自定义指示器样式 */
  indicatorClassName?: string;
}

/**
 * LiquidTabGroup:
 * SoulForge 顶层/次级 Tab 液体选中状态迁移封装。
 * 处于背景层的 liquid blob 负责液体桥拉伸与融合，前景文本/图标保持 crisp DOM。
 * 当用户启用 prefers-reduced-motion 时，自动退化为标准 CSS 定位。
 */
export function LiquidTabGroup({
  activeId,
  children,
  fill = 'var(--forge-active)',
  blur = 5,
  contrast = 18,
  shadow = '0 1px 3px rgba(0, 0, 0, 0.05)',
  radius = 4,
  className = '',
  style = {},
  indicatorClassName = '',
  ...rest
}: LiquidTabGroupProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementsMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const activeIdRef = useRef<string>(activeId);
  activeIdRef.current = activeId;

  const [activeRect, setActiveRect] = useState<TabRect | null>(null);
  const [prevRect, setPrevRect] = useState<TabRect | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = useReducedMotion();

  const measureActive = useCallback((): void => {
    const container = containerRef.current;
    const currentActiveId = activeIdRef.current;
    const activeEl = elementsMapRef.current.get(currentActiveId);
    if (!container || !activeEl) {
      setActiveRect(null);
      return;
    }
    const cRect = container.getBoundingClientRect();
    const aRect = activeEl.getBoundingClientRect();
    const nextRect: TabRect = {
      left: aRect.left - cRect.left + container.scrollLeft,
      top: aRect.top - cRect.top + container.scrollTop,
      width: aRect.width,
      height: aRect.height
    };
    setActiveRect((prev) => {
      if (
        prev &&
        prev.left === nextRect.left &&
        prev.top === nextRect.top &&
        prev.width === nextRect.width &&
        prev.height === nextRect.height
      ) {
        return prev;
      }
      return nextRect;
    });
  }, []);

  const register = useCallback((id: string, element: HTMLElement): (() => void) => {
    elementsMapRef.current.set(id, element);
    if (id === activeIdRef.current) {
      measureActive();
    }
    return () => {
      elementsMapRef.current.delete(id);
    };
  }, [measureActive]);

  const contextValue = useMemo<TabRegistry>(() => ({ register }), [register]);

  const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

  useIsoLayoutEffect(() => {
    const activeEl = elementsMapRef.current.get(activeId);
    const container = containerRef.current;
    if (activeEl && container) {
      const cRect = container.getBoundingClientRect();
      const aRect = activeEl.getBoundingClientRect();
      const newRect: TabRect = {
        left: aRect.left - cRect.left + container.scrollLeft,
        top: aRect.top - cRect.top + container.scrollTop,
        width: aRect.width,
        height: aRect.height
      };

      if (activeRect && (activeRect.left !== newRect.left || activeRect.width !== newRect.width || activeRect.top !== newRect.top)) {
        if (transitionTimerRef.current) {
          clearTimeout(transitionTimerRef.current);
        }
        setPrevRect(activeRect);
        setIsTransitioning(true);
        transitionTimerRef.current = setTimeout(() => {
          setIsTransitioning(false);
          setPrevRect(null);
          transitionTimerRef.current = null;
        }, 280);
        setActiveRect(newRect);
      } else {
        setActiveRect(newRect);
      }
    } else {
      setActiveRect(null);
    }
  }, [activeId]);

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    measureActive();
    const container = containerRef.current;
    const activeEl = elementsMapRef.current.get(activeId);
    if (!container) return;

    const observer = new ResizeObserver(() => {
      measureActive();
    });
    observer.observe(container);
    if (activeEl) {
      observer.observe(activeEl);
    }
    return () => observer.disconnect();
  }, [activeId, measureActive]);

  return (
    <TabContext.Provider value={contextValue}>
      <div
        ref={containerRef}
        className={`liquid-tab-group ${className}`}
        style={{
          position: 'relative',
          ...style
        }}
        {...rest}
      >
        {/* 背景 Liquid 指示器层 */}
        {activeRect && !reducedMotion && (
          <div
            className="liquid-tab-group__liquid-layer"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              pointerEvents: 'none',
              zIndex: 0
            }}
            aria-hidden="true"
          >
            <Liquid
              blur={blur}
              contrast={contrast}
              fill={fill}
              shadow={shadow}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%'
              }}
            >
              {/* 主选中块 */}
              <Liquid.Item
                effect="morph"
                x={activeRect.left}
                y={activeRect.top}
                radius={radius}
                transition={{
                  stiffness: 420,
                  damping: 28,
                  mass: 0.9
                }}
              >
                <div
                  className={`liquid-tab-indicator ${indicatorClassName}`}
                  style={{
                    width: activeRect.width,
                    height: activeRect.height,
                    borderRadius: radius
                  }}
                />
              </Liquid.Item>

              {/* 迁移过程中的尾随微团，用于在 A 到 B 之间形成短暂表面张力液体桥 */}
              {isTransitioning && prevRect && (
                <Liquid.Item
                  effect="morph"
                  x={prevRect.left}
                  y={prevRect.top}
                  radius={radius}
                  transition={{
                    duration: 280,
                    ease: 'cubic-bezier(0.4, 0, 0.2, 1)'
                  }}
                >
                  <div
                    className="liquid-tab-indicator-ghost"
                    style={{
                      width: prevRect.width,
                      height: prevRect.height,
                      borderRadius: radius,
                      opacity: 0.6
                    }}
                  />
                </Liquid.Item>
              )}
            </Liquid>
          </div>
        )}

        {/* 降级模式（Reduced Motion 或静态备选） */}
        {activeRect && reducedMotion && (
          <div
            className={`liquid-tab-indicator-fallback ${indicatorClassName}`}
            style={{
              position: 'absolute',
              left: activeRect.left,
              top: activeRect.top,
              width: activeRect.width,
              height: activeRect.height,
              borderRadius: radius,
              background: fill,
              boxShadow: shadow,
              pointerEvents: 'none',
              zIndex: 0,
              transition: 'left 0.15s ease, width 0.15s ease'
            }}
            aria-hidden="true"
          />
        )}

        {/* 前景 DOM 内容层（继承父容器的 gap 与 align-items，保证布局 100% 一致） */}
        <div
          className="liquid-tab-group__content"
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            alignItems: 'inherit',
            gap: 'inherit',
            width: '100%',
            height: '100%',
            minWidth: 0
          }}
        >
          {children}
        </div>
      </div>
    </TabContext.Provider>
  );
}

export interface LiquidTabItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  id: string;
  as?: ElementType;
  children: ReactNode;
  className?: string;
  selected?: boolean;
}

/**
 * LiquidTabItem:
 * 包装具体 Tab 按钮项，自动向父级注册位置尺寸，以便背景 Liquid 准确吸附。
 */
export const LiquidTabItem = forwardRef<HTMLElement, LiquidTabItemProps>(function LiquidTabItem(
  props,
  forwardedRef
): ReactElement {
  const { id, as: Component = 'div', children, className = '', selected = false, ...rest } = props;
  const ctx = useContext(TabContext);
  const internalRef = useRef<HTMLElement | null>(null);

  const setRef = (node: HTMLElement | null): void => {
    internalRef.current = node;
    if (typeof forwardedRef === 'function') {
      forwardedRef(node);
    } else if (forwardedRef) {
      (forwardedRef as { current: HTMLElement | null }).current = node;
    }
  };

  useEffect(() => {
    if (ctx && internalRef.current) {
      return ctx.register(id, internalRef.current);
    }
  }, [ctx, id]);

  const Comp = Component as ElementType;

  return (
    <Comp
      ref={setRef}
      className={`liquid-tab-item ${selected ? 'is-selected' : ''} ${className}`}
      data-tab-id={id}
      {...rest}
    >
      {children}
    </Comp>
  );
});
