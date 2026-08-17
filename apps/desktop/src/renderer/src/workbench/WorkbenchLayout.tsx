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
   * 属性栏通常给固定初值、条目栏吃剩余空间，避免长字段名把属性栏压成两字宽。
   */
  initialWidth?: number;
  /**
   * 初始栏宽比例（与同一工作台内其他 initialFlex 栏按比例分配）。
   *
   * 与 initialWidth 互斥，优先级低于它。用于「按比例切分」的工作台 ——
   * 对照参照工具，它的地图数据编辑器是全仓唯一写死栏宽比例的地方
   * （0.2 / 0.4 / 0.4，可拖拽），其余编辑器交给 docking 运行时。
   * 比例在窗口缩放时按比例跟随，固定像素不会。
   */
  initialFlex?: number;
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
/** 分隔条宽度（与 styles.css `.workbench__resizer` 的 width 保持一致）。 */
const RESIZER_WIDTH = 4;

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
  /** 栏容器，用于量「其余栏 minWidth 之和」给拖拽上限（P1 裁定）。 */
  const columnsRef = useRef<HTMLDivElement | null>(null);
  /**
   * 栏集合的最新值经 ref 提供给拖拽闭包。
   *
   * 拖拽监听挂在 window 上，回调必须稳定：TaeWorkbenchPanel 等面板每次渲染都新建
   * `columns={[...]}` 数组，若 onPointerMove 依赖 props.columns，每次渲染都会拆装
   * window 监听——拖拽中途一松手监听就被换掉，表现为「拖一下就断、松手后像假的」。
   */
  const columnsForDragRef = useRef(props.columns);
  columnsForDragRef.current = props.columns;

  /**
   * 量该栏的实际内容宽（不含分隔条）。
   *
   * slot 的 getBoundingClientRect 包含 4px `.workbench__resizer`：首拖把含分隔条的
   * 宽度写回像素模式后，该栏每从比例/自适应切进像素模式就多吃 4px，下一轮命中区
   * 与上限全部偏移。量 section（slot 第一个子元素）才是不含分隔条的真实内容宽。
   */
  function measureColumnWidth(slot: HTMLElement | null | undefined): number | undefined {
    const section = slot?.firstElementChild as HTMLElement | null;
    const measured = section?.getBoundingClientRect().width;
    return typeof measured === 'number' && measured > 0 ? measured : undefined;
  }

  /**
   * 拖拽/键盘右移的上限：容器宽度 − 其余栏 minWidth 之和 − 分隔条总宽。
   *
   * P1 裁定：此前拖拽只做 `Math.max(minWidth, start+delta)`，没有上限；被拖的栏
   * 写成 `flex: 0 0 auto; width: Npx` 后可以大于可视区，把整栏（含它的分隔条）
   * 挤出窗口右缘，鼠标和键盘都选不回来。这个上限保证任何栏最多把其余栏压到各自
   * 的 minWidth，永远拖不出可视区。
   *
   * 分隔条总宽（(N-1)×4px）必须从上限里留出：全部栏都进像素模式后，总视觉宽 =
   * Σ栏内容宽 + (N-1)×4，不留余量会把最右栏的分隔条挤出容器。
   */
  function maxWidthFor(columnId: string): number {
    const container = columnsRef.current;
    // S27：容器尚未布局（clientWidth 0）时不得把栏写成 0 —— 点选换 hint / 换虚拟
    // 列表后第一次拖分隔条，若此时量到 0 会把栏塌成一条缝且拖不回来。
    if (!container || container.clientWidth <= 0) return Number.POSITIVE_INFINITY;
    const columns = columnsForDragRef.current;
    const othersMin = columns
      .filter((column) => column.id !== columnId)
      .reduce((sum, column) => sum + (column.minWidth ?? DEFAULT_MIN_WIDTH), 0);
    const resizerTotal = (columns.length - 1) * RESIZER_WIDTH;
    return Math.max(0, container.clientWidth - othersMin - resizerTotal);
  }

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragState.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    const nextWidth = Math.min(
      maxWidthFor(drag.columnId),
      Math.max(drag.minWidth, drag.startWidth + delta)
    );
    setWidths((current) => ({ ...current, [drag.columnId]: nextWidth }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * 开始拖拽。
   *
   * 比例模式（initialFlex）或自适应模式下 widths 里还没有值，此时从 DOM 量出
   * 当前实际宽度作为起点 —— 否则那些栏的分隔条拖不动。量到之后该栏即转为
   * 像素模式（见 column-slot 的 style 注释）。
   */
  function startResize(column: WorkbenchColumnSpec, event: React.PointerEvent): void {
    let startWidth = widths[column.id];
    if (typeof startWidth !== 'number') {
      // 量内容宽（不含分隔条），否则首拖会把 4px 分隔条宽度也写进像素模式。
      const slot = (event.currentTarget as HTMLElement).parentElement;
      const measured = measureColumnWidth(slot);
      if (measured === undefined) return;
      // S27：量出的宽度同样不得低于该栏 minWidth（栏被其它栏挤窄时）。
      const clamped = Math.max(column.minWidth ?? DEFAULT_MIN_WIDTH, measured);
      startWidth = clamped;
      setWidths((current) => ({ ...current, [column.id]: clamped }));
    }
    dragState.current = {
      columnId: column.id,
      startX: event.clientX,
      startWidth,
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
    // 与 startResize 同理：比例/自适应模式下先从 DOM 量出当前宽度（不含分隔条），
    // 否则键盘用户在这些栏上按方向键没有任何反应。
    let measured = widths[column.id];
    if (typeof measured !== 'number') {
      const slot = (event.currentTarget as HTMLElement).parentElement;
      const fromDom = measureColumnWidth(slot);
      if (fromDom === undefined) return;
      measured = Math.max(column.minWidth ?? DEFAULT_MIN_WIDTH, fromDom);
    }
    const minWidth = column.minWidth ?? DEFAULT_MIN_WIDTH;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setWidths((current) => ({ ...current, [column.id]: Math.max(minWidth, measured - step) }));
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      // 与拖拽同一上限：不能把右侧栏挤出可视区（P1 裁定），但任何情况下
      // 不得把当前栏压到低于自身 minWidth（窄窗口下其余栏 minWidth 之和可能
      // 超过容器宽，此时上限为负也要守住本栏下限）。
      setWidths((current) => ({
        ...current,
        [column.id]: Math.max(minWidth, Math.min(maxWidthFor(column.id), measured + step))
      }));
    }
  }

  /** P1 裁定：恢复初始栏宽（initialWidth 回到声明值，其余回到比例/自适应模式）。 */
  function resetWidths(): void {
    const initial: ColumnWidths = {};
    for (const column of props.columns) {
      if (typeof column.initialWidth === 'number') initial[column.id] = column.initialWidth;
    }
    setWidths(initial);
  }

  const hasCustomWidths = Object.keys(widths).length > 0;

  return (
    <div className="workbench" aria-label={props.label}>
      {props.toolbar && <div className="workbench__toolbar">{props.toolbar}</div>}
      {/* P1 裁定：栏宽被拖过（进入像素模式）时提供恢复入口；被旧版本拖出窗口的
          栏也能由此拉回默认比例。只在确实需要时出现，不常驻占空间。 */}
      {hasCustomWidths && (
        <div className="workbench__layout-actions">
          <button
            type="button"
            className="secondary-action"
            onClick={resetWidths}
            title="把全部栏宽恢复为初始比例/初值"
          >
            恢复默认栏宽
          </button>
        </div>
      )}
      <div className="workbench__columns" ref={columnsRef}>
        {props.columns.map((column, index) => {
          const width = widths[column.id];
          const isLast = index === props.columns.length - 1;
          return (
            <div
              key={column.id}
              className="workbench__column-slot"
              /*
               * 三种宽度模式，优先级从上到下：
               *   ① 已被拖拽过（widths 里有值）→ 固定像素；
               *   ② 声明了 initialFlex → 按比例分配（窗口缩放时跟随）；
               *   ③ 都没有 → 吃满剩余空间。
               * 拖拽会把该栏写进 widths，于是从 ②/③ 切到 ①。这是必需的：
               * 比例模式下拖拽无法表达「就这么宽」。
               */
              style={typeof width === 'number'
                // S27：像素模式也必须守 minWidth —— 否则拖拽/写入把栏压到只显示
                // 「除…」一个字，且写入时已 Math.max(minWidth, …) 钳住。
                ? {
                    flex: '0 0 auto',
                    width: `${width}px`,
                    minWidth: `${column.minWidth ?? DEFAULT_MIN_WIDTH}px`
                  }
                : {
                    flex: `${column.initialFlex ?? 1} 1 0`,
                    minWidth: `${column.minWidth ?? DEFAULT_MIN_WIDTH}px`
                  }}
            >
              <section className="workbench__column" aria-label={column.title}>
                <header className="workbench__column-header">
                  <h3 className="workbench__column-title">{column.title}</h3>
                  {column.hint && <span className="workbench__column-hint">{column.hint}</span>}
                </header>
                <div className="workbench__column-body">{column.children}</div>
              </section>
              {/* 分隔条对所有非末栏都出现，不再要求该栏已是像素模式 ——
                  否则比例模式与自适应模式的栏永远拖不动。首次拖拽时
                  startResize 会从 DOM 量出当前宽度并转入像素模式。 */}
              {!isLast && (
                <div
                  className="workbench__resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`调整${column.title}栏宽`}
                  tabIndex={0}
                  /* separator 的当前值要报给辅助技术，否则键盘调宽时用户听不到
                     任何变化反馈。未进入像素模式（尚未拖过）时无确切数值，
                     此时不报 —— 报一个猜的数字比不报更糟。
                     aria-valuemin 用该栏的实际下限，与拖拽/键盘的钳制一致。 */
                  {...(typeof width === 'number'
                    ? {
                        'aria-valuenow': Math.round(width),
                        'aria-valuemin': column.minWidth ?? DEFAULT_MIN_WIDTH,
                        'aria-valuetext': `${Math.round(width)} 像素`
                      }
                    : {})}
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
