/**
 * 模态对话框的焦点管理（纯逻辑，可单测）。
 *
 * 为什么需要它：命令面板与 Agent 抽屉都是 role="dialog"，但两者都不拦 Tab——
 * 焦点可以 Tab 出模态、落到背后的主界面上。对键盘/屏幕阅读器用户来说，那意味着
 * 「对话框开着，但我在操作被它遮住的东西」，且没有任何提示。关闭时也不恢复打开
 * 前的焦点位置，焦点会掉回文档开头，用户丢失上下文。
 *
 * 这里只做纯计算：给定「可聚焦元素列表 + 当前焦点 + 按键」，算出下一个该聚焦的
 * 元素索引。DOM 查询与实际 focus() 调用留给调用方——那部分需要真实 DOM，属于
 * e2e 的覆盖范围。纯计算部分单测能锁住的恰恰是最容易写错的环绕逻辑。
 */

/** Tab 环绕的计算输入。 */
export interface TabWrapInput {
  /** 模态内可聚焦元素的数量。 */
  focusableCount: number;
  /** 当前焦点所在的索引；-1 表示焦点不在模态内（或尚未落入）。 */
  currentIndex: number;
  /** 是否按下了 Shift（反向 Tab）。 */
  shift: boolean;
}

/**
 * 算出 Tab / Shift+Tab 后应聚焦的索引。
 *
 * 环绕规则：正向到末尾回到 0，反向到 0 跳到末尾。焦点不在模态内时（-1），
 * 正向进第一个、反向进最后一个——这样「对话框刚打开、焦点还在外面」按 Tab 也能
 * 正确进入，而不是先跳到外部元素再被拉回来（那会产生一次可见的焦点闪跳）。
 *
 * @returns 下一个焦点索引；focusableCount 为 0 时返回 -1（无处可聚焦）。
 */
export function nextTrappedFocusIndex(input: TabWrapInput): number {
  const { focusableCount, currentIndex, shift } = input;
  if (focusableCount <= 0) return -1;
  if (currentIndex < 0) return shift ? focusableCount - 1 : 0;
  if (shift) {
    return currentIndex === 0 ? focusableCount - 1 : currentIndex - 1;
  }
  return currentIndex === focusableCount - 1 ? 0 : currentIndex + 1;
}

/**
 * 模态内可聚焦元素的选择器。
 *
 * 刻意排除 tabIndex="-1"：那是 roving tabindex 用来把元素移出 Tab 序列的手段
 * （见 selectableRow），把它们算进来会让 Tab 在几百个表格行之间打转。
 *
 * 也排除 disabled 与 aria-hidden 子树：前者不可聚焦，后者对辅助技术不可见，
 * 让焦点停在上面等于把用户送进一个「读不出来」的位置。
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

/** 该元素是否应参与模态内的 Tab 循环。 */
export function isTrappableElement(element: {
  hasAttribute: (name: string) => boolean;
  getAttribute: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}): boolean {
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.getAttribute('tabindex') === '-1') return false;
  // aria-hidden 祖先：焦点落在辅助技术读不到的位置，等于用户被困住。
  if (typeof element.closest === 'function' && element.closest('[aria-hidden="true"]')) return false;
  return true;
}
