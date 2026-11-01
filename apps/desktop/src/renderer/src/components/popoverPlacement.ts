/**
 * 弹出层定位与菜单方向键的纯函数。坐标都是视口坐标；Menu 再换算成相对定位父级的偏移。
 */
export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export type Side = 'up' | 'down';

/** 离窗口边缘、离触发按钮的留白。 */
const EDGE = 8, GAP = 6;

/**
 * 优先放在 prefer 一侧；那一侧放不下而另一侧放得下时翻过去；两侧都放不下时取空间大的一侧并贴边。
 * 水平方向左对齐触发按钮，收在窗口内。
 */
export function placePopover(trigger: Rect, popover: Size, viewport: Size, prefer: Side = 'down'): { x: number; y: number; side: Side } {
  const below = viewport.height - (trigger.top + trigger.height) - GAP - EDGE;
  const above = trigger.top - GAP - EDGE;
  const fits = (s: Side): boolean => popover.height <= (s === 'down' ? below : above);
  const other: Side = prefer === 'down' ? 'up' : 'down';
  const side: Side = fits(prefer) ? prefer : fits(other) ? other : below >= above ? 'down' : 'up';
  const rawY = side === 'down' ? trigger.top + trigger.height + GAP : trigger.top - GAP - popover.height;
  const y = Math.max(EDGE, Math.min(viewport.height - EDGE - popover.height, rawY));
  const x = Math.max(EDGE, Math.min(viewport.width - EDGE - popover.width, trigger.left));
  return { x, y, side };
}

/** 菜单里的方向键：↑↓ 循环，Home / End 到两端；其他键返回 null。 */
export function stepMenuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current < 0 ? count - 1 : (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
