/**
 * 可选中表格行的无障碍属性（纯函数，可单测）。
 *
 * 为什么需要它：多个编辑器面板用 `<div role="row" onClick={...}>` 做行选择，而
 * onClick 在 div 上对键盘用户完全不可达。其中两处**阻断整个编辑流程**——
 * FmgWorkbenchPanel 必须选行才出现编辑 textarea，ParamDefPanel 必须选行才出现
 * 字段表，键盘用户因此根本进不去编辑态。
 *
 * 不在每个面板里各写一遍 tabIndex + onKeyDown 的理由：那样漏一处不会有任何信号，
 * 而「漏的那一处正好是阻断编辑流程的那一处」是最可能的结果。这里把行为收敛成
 * 一个函数，由单测断言键盘契约，面板只负责调用。
 *
 * 键盘契约（遵循 ARIA grid 的通行做法）：
 *  - Enter 与 Space 都触发选择。只认 Enter 会让习惯 Space 的用户以为行不可选；
 *    Space 必须 preventDefault，否则页面会滚动。
 *  - roving tabindex：只有当前选中行（或无选中时的第一行）进 Tab 序列，其余行
 *    tabIndex=-1。否则几百行会各占一个 Tab 停靠点，键盘导航变成不可用。
 *  - aria-selected 反映选中态，让屏幕阅读器能播报「已选中」。
 */

export interface SelectableRowOptions {
  /** 本行是否为当前选中行。 */
  selected: boolean;
  /** 无选中项时，本行是否应作为 Tab 入口（通常是第一行）。 */
  isTabEntry: boolean;
  /** 选择本行。Enter / Space / 点击都走它。 */
  onSelect: () => void;
}

export interface SelectableRowAttributes {
  role: 'row';
  tabIndex: number;
  'aria-selected': boolean;
  onClick: () => void;
  onKeyDown: (event: {
    key: string;
    preventDefault: () => void;
  }) => void;
}

/** 触发选择的按键。区分大小写无关紧要——key 值已是规范名。 */
const ACTIVATION_KEYS = new Set([' ', 'Enter', 'Spacebar']);

export function selectableRowAttributes(options: SelectableRowOptions): SelectableRowAttributes {
  return {
    role: 'row',
    // roving tabindex：选中行永远可 Tab 到；无选中时由 isTabEntry 指定入口。
    tabIndex: options.selected || options.isTabEntry ? 0 : -1,
    'aria-selected': options.selected,
    onClick: options.onSelect,
    onKeyDown: (event) => {
      if (!ACTIVATION_KEYS.has(event.key)) return;
      // Space 不拦会滚动页面；Enter 不拦在某些容器里会触发表单提交。
      event.preventDefault();
      options.onSelect();
    }
  };
}

/**
 * 判断某一行是否应作为 Tab 入口。
 *
 * 规则：有选中项时入口就是选中行（由 selected 决定），因此本函数只在**无选中项**
 * 时返回第一行为真。把它单独提出来是为了让「几百行各占一个 Tab 停靠点」这种
 * 退化能被单测直接断言。
 */
export function isRowTabEntry(rowIndex: number, hasSelection: boolean): boolean {
  return !hasSelection && rowIndex === 0;
}
