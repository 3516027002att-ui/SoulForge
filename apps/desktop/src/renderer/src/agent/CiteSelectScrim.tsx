import { useEffect, useRef, useState, type ReactElement, type MouseEvent as ReactMouseEvent } from 'react';
import type { CiteHit } from '@soulforge/shared';
import { collectCiteHits, normalizeRect, type Point, type Rect } from './citeSelection.js';

export interface CiteSelectScrimProps {
  /**
   * 框选结算：把命中的 data-cite 节点交给宿主（宿主合并后经 agent.citation.create
   * 签 opaque token）。松开鼠标且框面积非零时触发。
   */
  onSettle: (hits: CiteHit[]) => void;
  /** Esc 取消框选（组件自己监听 window keydown，宿主只负责关模式）。 */
  onCancel: () => void;
}

/**
 * S10 引用框选暗幕。
 *
 * 只盖**中央编辑区**（宿主把本组件渲染在 editor-area 内，该容器已有
 * position:relative）；Agent dock 是 editor-area 之外的 flex 兄弟，天然保持明亮，
 * 用户看得到对话。「点下去整块编辑器变暗，鼠标拉框，松开结算」：
 *  - mousedown 记起点；mousemove 更新选区矩形；mouseup 结算 → onSettle(hits)。
 *  - 只按一下（矩形近零）不算框选，直接退出。
 *  - Esc 取消；组件卸载时清理 window keydown 监听。
 *
 * 结算的几何与收集在 citeSelection.ts（纯函数，可单测）；本组件只做事件接线。
 */
export function CiteSelectScrim(props: CiteSelectScrimProps): ReactElement {
  const { onSettle, onCancel } = props;
  const [selection, setSelection] = useState<Rect | null>(null);
  const startRef = useRef<Point | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
    startRef.current = { x: event.clientX, y: event.clientY };
    setSelection({ left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY });
  }

  function handleMouseMove(event: ReactMouseEvent<HTMLDivElement>): void {
    const start = startRef.current;
    if (start === null) return;
    setSelection(normalizeRect(start, { x: event.clientX, y: event.clientY }));
  }

  function handleMouseUp(event: ReactMouseEvent<HTMLDivElement>): void {
    const start = startRef.current;
    startRef.current = null;
    setSelection(null);
    if (start === null) return;
    const final = normalizeRect(start, { x: event.clientX, y: event.clientY });
    // 只按一下（矩形近零）不算框选：不打扰、不提示。
    if (final.right - final.left < 2 && final.bottom - final.top < 2) return;
    onSettle(collectCiteHits(scrimRef.current?.parentElement ?? null, final));
  }

  const boxStyle = selection !== null
    ? {
        left: selection.left,
        top: selection.top,
        width: selection.right - selection.left,
        height: selection.bottom - selection.top
      }
    : undefined;

  return (
    <div
      ref={scrimRef}
      className="cite-scrim"
      data-testid="cite-scrim"
      role="presentation"
      aria-label="引用框选：拖拽框住要引用的行或字段，Esc 取消"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <span className="cite-scrim__hint">拖拽框住要引用的行或字段 · 松开完成 · Esc 取消</span>
      {boxStyle !== undefined && (
        <div className="cite-select-box" style={boxStyle} data-testid="cite-select-box" aria-hidden="true" />
      )}
    </div>
  );
}
