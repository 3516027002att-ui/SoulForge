/**
 * S10 引用框选的 renderer 侧纯几何 / 收集逻辑（无 React 依赖，可单测）。
 *
 * 框选 = 与带 `data-cite` 的 DOM 做矩形相交（用户裁定 2026-08-16：不做 OCR、
 * 不做截图像素识别）。本模块只负责：
 *  - `normalizeRect`：两个鼠标点 → 左上/右下规整的矩形；
 *  - `rectsIntersect`：相交面积 > 0 才算中；
 *  - `collectCiteHits`：从容器内所有 `[data-cite]` 元素收集命中并解码。
 *
 * data-cite 的 JSON 结构解码在 shared 的 decodeCiteHit（main 与 renderer 共用），
 * 本模块不重复实现；坏 data-cite 静默跳过（不因个别脏节点炸掉整次框选）。
 */
import { decodeCiteHit, type CiteHit } from '@soulforge/shared';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 两个鼠标点 → 规整矩形（任意拖拽方向）。 */
export function normalizeRect(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y)
  };
}

/** 相交面积 > 0 才算中（贴边不算）。 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** 从容器内所有 `[data-cite]` 元素收集与框相交的命中（按 DOM 顺序）。 */
export function collectCiteHits(container: ParentNode | null, selection: Rect): CiteHit[] {
  if (container === null) return [];
  const hits: CiteHit[] = [];
  container.querySelectorAll<HTMLElement>('[data-cite]').forEach((element) => {
    const bounds = element.getBoundingClientRect();
    if (!rectsIntersect(selection, {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom
    })) return;
    const raw = element.getAttribute('data-cite');
    if (raw === null) return;
    try {
      hits.push(decodeCiteHit(JSON.parse(raw)));
    } catch {
      // 坏 data-cite 静默跳过：框选收集不是校验边界，main 侧还会再解码一遍。
    }
  });
  return hits;
}
