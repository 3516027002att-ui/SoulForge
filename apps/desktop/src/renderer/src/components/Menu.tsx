import { useLayoutEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { placePopover, stepMenuIndex, type Side } from './popoverPlacement.js';

export interface MenuProps {
  /** 读屏名，也用于区分同一窗口里的多个菜单。 */
  label: string;
  /** returnFocus：Esc 关闭时为 true（焦点已还给触发按钮）；Tab 和点外面关闭时为 false。 */
  onClose: (returnFocus: boolean) => void;
  /** 优先向下还是向上弹，放不下时自动翻到另一侧。 */
  prefer?: Side | undefined;
  className?: string | undefined;
  'data-testid'?: string | undefined;
  children: ReactNode;
}

const ITEM = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/**
 * 菜单：只在打开时渲染，放在触发按钮旁边（同一个定位父级里）。触发按钮要带 aria-haspopup="menu"，
 * Menu 靠它找回触发按钮来定位和归还焦点。打开后焦点在第一项；↑↓ Home End 移动，Enter / Space 由按钮自己执行；
 * Esc 关闭并把焦点还给触发按钮；Tab 和点外面关闭。
 */
export function Menu({ label, onClose, prefer = 'down', className, children, ...rest }: MenuProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const items = (): HTMLElement[] => (ref.current ? Array.from(ref.current.querySelectorAll<HTMLElement>(ITEM)) : []);
  const trigger = (): HTMLElement | null => ref.current?.parentElement?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? null;

  useLayoutEffect(() => {
    const menu = ref.current, anchor = trigger(), parent = menu?.offsetParent;
    if (!menu || !anchor || !parent) return;
    const doc = menu.ownerDocument, view = doc.defaultView;
    const t = anchor.getBoundingClientRect(), p = parent.getBoundingClientRect();
    const at = placePopover(t, { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: doc.documentElement.clientWidth, height: view?.innerHeight ?? doc.documentElement.clientHeight }, prefer);
    menu.style.left = `${at.x - p.left}px`;
    menu.style.top = `${at.y - p.top}px`;
    menu.dataset.side = at.side;
    items()[0]?.focus({ preventScroll: true });
  }, [prefer]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); trigger()?.focus(); onClose(true); return; }
    if (event.key === 'Tab') { onClose(false); return; }
    const list = items(), next = stepMenuIndex(event.key, list.indexOf(event.target as HTMLElement), list.length);
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  }

  return (
    <>
      <div className="ui-menu-backdrop" aria-hidden="true" onClick={() => onClose(false)} />
      <div
        {...rest}
        ref={ref}
        role="menu"
        aria-label={label}
        className={className ? `ui-menu ${className}` : 'ui-menu'}
        onKeyDown={onKeyDown}
        onMouseMove={(event) => { const item = (event.target as HTMLElement).closest<HTMLElement>(ITEM); if (item && item !== item.ownerDocument.activeElement) item.focus({ preventScroll: true }); }}
      >
        {children}
      </div>
    </>
  );
}
