/**
 * 通用多栏工作台骨架。
 *
 * ── 守的问题 ──
 *
 * 用户报「param 等所有工作页面都是重证据、无工作、不可用、不可编辑」。实测三张
 * 截图的共同形态是：打开任何二进制资源，主视图顶部先是「只读 Hex 证据」卡，
 * 然后才是被挤到滚动区外的行表——因为 App.tsx 的 `previewKind === 'hex'` 是所有
 * FromSoftware 二进制格式的默认分支，HexEditorPanel 无条件排在全部工作台面板之前。
 *
 * 参照物是 Smithbox 2.2.4：左侧类别列表 → 中间条目列表 → 右侧属性表 → 最右工具栏，
 * 每栏各自独立滚动，栏宽可拖。工作台占满视图，字节与证据收进折叠区。
 *
 * ── 为什么是布局组件而不是每个面板各写一遍 ──
 *
 * 有 15 个编辑器面板。每个面板各写一套栅格 + 拖拽 + 滚动容器，结果必然是 15 种
 * 略有差异的栏宽行为，而「哪一处漏了独立滚动」不会有任何自动信号——只会让某个
 * 页面在长列表下把整页顶出滚动条。这里把栏结构收敛成一个组件，面板只提供内容。
 *
 * ── 硬约束 17（大规模访问必须分页/虚拟化）──
 *
 * 本组件只做布局，不持有数据，因此不会自己违约；但它给每栏一个独立的
 * `overflow-y: auto` 容器，让面板的分页列表有确定的滚动宿主。栏内是否分页由
 * 面板负责（PARAM 走 shared 的 PARAM_PAGE_SIZE，见 ParamTablePanel）。
 *
 * ── 无障碍 ──
 *
 * 每栏是 `<section>` 带可访问名（栏标题），而不是裸 div：屏幕阅读器需要能在栏
 * 之间跳转并知道当前在哪一栏。栏标题用 `<h3>` 保持与既有 `.panel-header` 一致的
 * 层级，避免同一页面出现两套标题层级。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

/** 一栏的内容与元信息。 */
export interface WorkbenchColumnSpec {
  /** 稳定标识，用于 React key 与栏宽持久化。 */
  id: string;
  /** 栏标题（同时作为该栏的可访问名）。 */
  title: string;
  /** 标题右侧的次要说明，例如条目数。 */
  hint?: string;
  /** 栏内容。 */
  children: ReactNode;
  /**
   * 初始栏宽（px）。缺省时该栏自适应剩余空间。
   *
   * 属性栏通常给固定初值、条目栏吃剩余空间——这与 Smithbox 的观感一致，
   * 也避免长字段名把属性栏压成两字宽。
   */
  initialWidth?: number;
  /** 最小栏宽（px），拖拽不得越过。缺省 120。 */
  minWidth?: number;
}

export interface WorkbenchLayoutProps {
  /** 工作台的可访问名，例如「PARAM 工作台」。 */
  label: string;
  /** 各栏，从左到右。 */
  columns: WorkbenchColumnSpec[];
  /**
   * 工作台顶部工具条（可选）：面包屑、筛选、提交入口。
   *
   * 放在栏之上而不是某一栏内：它作用于整个工作台，塞进某栏会让该栏在窄宽下
   * 把工具条压掉。
   */
  toolbar?: ReactNode;
  /**
   * 工作台底部区域（可选）：诊断、提交结果。
   *
   * 不用于证据投影——证据归 App.tsx 末尾的折叠区，这里只放与当前编辑动作
   * 直接相关的反馈。
   */
  footer?: ReactNode;
}

const DEFAULT_MIN_WIDTH = 120;

/**
 * 栏宽状态：只记录被显式指定过初值的栏。
 *
 * 没有 initialWidth 的栏保持 flex 自适应——给它一个数值会让「剩余空间归谁」
 * 变成隐式约定，窗口缩放时出现空白列。
 */
type ColumnWidths = Record<string, number>;

export function WorkbenchLayout(props: WorkbenchLayoutProps): ReactElement {
  const [widths, setWidths] = useState<ColumnWidths>(() => {
    const initial: ColumnWidths = {};
    for (const column of props.columns) {
      if (typeof column.initialWidth === 'number') initial[column.id] = column.initialWidth;
    }
    return initial;
  });

  /**
   * 栏集合变化时补齐新栏的初值。
   *
   * 不整体重置：用户拖过的栏宽不该因为某一栏出现/消失而回到默认值。
   */
  useEffect(() => {
    setWidths((current) => {
      let changed = false;
      const next = { ...current };
      for (const column of props.columns) {
        if (typeof column.initialWidth === 'number' && !(column.id in next)) {
          next[column.id] = column.initialWidth;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [props.columns]);

  const dragState = useRef<{ columnId: string; startX: number; startWidth: number; minWidth: number } | null>(null);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragState.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const nextWidth = Math.max(drag.minWidth, drag.startWidth + delta);
    setWidths((current) => ({ ...current, [drag.columnId]: nextWidth }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragState.current = null;
  }, []);

  /**
   * 拖拽监听挂在 window 而不是分隔条上。
   *
   * 挂在分隔条上时，指针稍快移出条宽（4px）就丢事件，表现为「拖一下就断」。
   */
  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  function startResize(column: WorkbenchColumnSpec, event: React.PointerEvent): void {
    const measured = widths[column.id];
    if (typeof measured !== 'number') return;
    dragState.current = {
      columnId: column.id,
      startX: event.clientX,
      startWidth: measured,
      minWidth: column.minWidth ?? DEFAULT_MIN_WIDTH
    };
  }

  /**
   * 键盘调整栏宽。
   *
   * 拖拽对键盘用户不可达，而栏宽直接决定「字段名会不会被截断到看不出是哪个字段」。
   * 分隔条用 ARIA separator + 方向键，步长 16px。
   */
  function onSeparatorKeyDown(column: WorkbenchColumnSpec, event: React.KeyboardEvent): void {
    const step = 16;
    const measured = widths[column.id];
    if (typeof measured !== 'number') return;
    const minWidth = column.minWidth ?? DEFAULT_MIN_WIDTH;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setWidths((current) => ({ ...current, [column.id]: Math.max(minWidth, measured - step) }));
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setWidths((current) => ({ ...current, [column.id]: measured + step }));
    }
  }

  return (
    <div className="workbench" aria-label={props.label}>
      {props.toolbar && <div className="workbench__toolbar">{props.toolbar}</div>}
      <div className="workbench__columns">
        {props.columns.map((column, index) => {
          const width = widths[column.id];
          const isLast = index === props.columns.length - 1;
          return (
            <div
              key={column.id}
              className="workbench__column-slot"
              style={typeof width === 'number'
                ? { flex: '0 0 auto', width: `${width}px` }
                : { flex: '1 1 0', minWidth: `${column.minWidth ?? DEFAULT_MIN_WIDTH}px` }}
            >
              <section className="workbench__column" aria-label={column.title}>
                <header className="workbench__column-header">
                  <h3 className="workbench__column-title">{column.title}</h3>
                  {column.hint && <span className="workbench__column-hint">{column.hint}</span>}
                </header>
                <div className="workbench__column-body">{column.children}</div>
              </section>
              {!isLast && typeof width === 'number' && (
                <div
                  className="workbench__resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`调整${column.title}栏宽`}
                  tabIndex={0}
                  onPointerDown={(event) => startResize(column, event)}
                  onKeyDown={(event) => onSeparatorKeyDown(column, event)}
                ></div>
              )}
            </div>
          );
        })}
      </div>
      {props.footer && <div className="workbench__footer">{props.footer}</div>}
    </div>
  );
}
