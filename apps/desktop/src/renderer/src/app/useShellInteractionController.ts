import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { resolveKeybinding } from '../keybindings/applyKeybinding.js';
import { FOCUSABLE_SELECTOR, isTrappableElement, nextTrappedFocusIndex } from '../a11y/focusTrap.js';

/** App owns the three layout ports because Navigation consumes them before shell setup. */
export interface ShellInteractionOptions {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  cmdkOpen: boolean;
  setCmdkOpen: Dispatch<SetStateAction<boolean>>;
  cmdkQuery: string;
  setCmdkQuery: Dispatch<SetStateAction<string>>;
  activeDomain: string;
  setAgentOpen: Dispatch<SetStateAction<boolean>>;
  pendingChangeCount: number;
  hasUncommittedChanges: boolean;
  showSidebarView: (view: 'search' | 'staging') => void;
}

/** UI interactions only: no document, domain request, native or permission authority. */
export function useShellInteractionController(options: ShellInteractionOptions) {
  const { setSidebarCollapsed, cmdkOpen, setCmdkOpen, setCmdkQuery, activeDomain, setAgentOpen,
    pendingChangeCount, hasUncommittedChanges, showSidebarView } = options;
  const [sidebarWidth, setSidebarWidth] = useState(264);
  const shellRef = useRef<HTMLDivElement>(null);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [cmdkIndex, setCmdkIndex] = useState(0);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; kind: 'ok' | 'warn' }>>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cmdkInputRef = useRef<HTMLInputElement>(null);
  const cmdkDialogRef = useRef<HTMLDivElement>(null);
  const cmdkReturnFocusRef = useRef<HTMLElement | null>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const tabbarDragRef = useRef<{ startX: number; startScrollLeft: number } | null>(null);
  const toastIdRef = useRef(0);
  const prevPendingCountRef = useRef(0);
  const mountedRef = useRef(false);
  const timeoutIdsRef = useRef(new Set<number>());
  const resizeCleanupsRef = useRef(new Set<() => void>());

  // An App unmount during a drag or before a deferred focus/notification left the
  // original callbacks alive. Only owner teardown changes; mounted delays stay intact.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const cleanup of resizeCleanupsRef.current) cleanup();
      resizeCleanupsRef.current.clear();
      for (const id of timeoutIdsRef.current) window.clearTimeout(id);
      timeoutIdsRef.current.clear();
      };
  }, []);

  function scheduleShellTimeout(callback: () => void, delay: number): void {
    if (!mountedRef.current) return;
    const id = window.setTimeout(() => {
      timeoutIdsRef.current.delete(id);
      if (mountedRef.current) callback();
    }, delay);
    timeoutIdsRef.current.add(id);
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      // 三条关闭路径之一：Escape 关闭命令面板，走统一出口保证焦点归还。
      //（路径：Escape、Ctrl+K 再按、点遮罩，都用 closeCmdk，否则焦点归还变成随机的。）
      if (event.key === 'Escape' && cmdkOpen) {
        closeCmdk();
        return;
      }
      // T7：壳层/工作台键统一走键位表（keybindings/keymapTable.ts + applyKeybinding.ts）。
      // Ctrl 与 Meta 等价（沿用既有 handler 的行为）；输入框/textarea/contenteditable/
      // Agent composer 内由 resolveKeybinding 的 editable-target 守卫放行原生编辑键，
      // 壳层三键始终命中（守卫前置）。
      const target = event.target;
      const targetIsEditable = target instanceof HTMLElement && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable === true
        || target.closest('.agent__composer') !== null
      );
      const outcome = resolveKeybinding(
        {
          key: event.key,
          ctrlKey: event.ctrlKey || event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: false
        },
        activeDomain,
        { targetIsEditable, viewportPointerActive: false }
      );
      // App 只接管壳层三键；edit/domain 键由各工作台组件自己处理，这里不 preventDefault。
      if (!outcome.hit || outcome.entry.scope !== 'shell') return;
      event.preventDefault();
      switch (outcome.entry.id) {
        case 'shell.command-palette':
          if (cmdkOpen) closeCmdk(); else openCmdk();
          break;
        case 'shell.agent':
          setAgentOpen((open) => !open);
          break;
        case 'shell.sidebar':
          setSidebarCollapsed((collapsed) => !collapsed);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [cmdkOpen, activeDomain]);

  // 首个候选变更出现时自动切到暂存面板，保证审查动作可见可达。
  useEffect(() => {
    const previous = prevPendingCountRef.current;
    prevPendingCountRef.current = pendingChangeCount;
    if (previous === 0 && pendingChangeCount > 0) {
      setSidebarCollapsed(false);
      showSidebarView('staging');
    }
  }, [pendingChangeCount]);

  useEffect(() => {
    if (!hasUncommittedChanges) return undefined;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUncommittedChanges]);

  function openCmdk(): void {
    if (!mountedRef.current) return;
    // 记住打开前的焦点：关闭时要还回去，否则焦点掉回文档开头，键盘用户丢失
    // 上下文（刚才在哪一行、哪个按钮上，全部要重新 Tab 找回）。
    cmdkReturnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setCmdkQuery('');
    setCmdkIndex(0);
    setCmdkOpen(true);
    scheduleShellTimeout(() => cmdkInputRef.current?.focus(), 30);
  }

  function closeCmdk(): void {
    if (!mountedRef.current) return;
    setCmdkOpen(false);
    // 焦点归还。用 setTimeout 让它排在 React 卸载模态之后：卸载时浏览器会把焦点
    // 打回 body，先 focus 再卸载等于白做。
    const target = cmdkReturnFocusRef.current;
    cmdkReturnFocusRef.current = null;
    if (target !== null && document.contains(target)) {
      scheduleShellTimeout(() => target.focus(), 0);
    }
  }

  /** DOM 查询与 focus() 留在壳层，环绕计算复用 a11y/focusTrap。 */
  function trapTabWithin(container: HTMLElement | null, event: ReactKeyboardEvent): void {
    if (container === null || event.key !== 'Tab') return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => isTrappableElement(element));
    if (focusable.length === 0) return;
    const currentIndex = focusable.findIndex((element) => element === document.activeElement);
    const nextIndex = nextTrappedFocusIndex({
      focusableCount: focusable.length,
      currentIndex,
      shift: event.shiftKey
    });
    if (nextIndex < 0) return;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  function focusSearchPanel(): void {
    if (!mountedRef.current) return;
    setSidebarCollapsed(false);
    showSidebarView('search');
    scheduleShellTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!mountedRef.current) return;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handleMove = (moveEvent: PointerEvent): void => {
      // R5 裁定：侧栏下限与其他工作台栏一致——几乎能拖没，只留一条不让整列消失。
      setSidebarWidth(Math.min(480, Math.max(44, startWidth + moveEvent.clientX - startX)));
    };
    const handleUp = (): void => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      resizeCleanupsRef.current.delete(handleUp);
    };
    resizeCleanupsRef.current.add(handleUp);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  /** 左键按住拖动 tabbar，换算成横向滚动；点击选择行为保持原样。 */
  function startTabbarDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    const el = event.currentTarget;
    tabbarDragRef.current = { startX: event.clientX, startScrollLeft: el.scrollLeft };
  }

  function moveTabbarDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = tabbarDragRef.current;
    if (!drag) return;
    event.currentTarget.scrollLeft = drag.startScrollLeft - (event.clientX - drag.startX);
    event.preventDefault();
  }

  function endTabbarDrag(): void {
    tabbarDragRef.current = null;
  }

  // 原生非被动监听允许 preventDefault，避免滚轮落到下方工作台。
  useEffect(() => {
    const el = tabbarRef.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent): void => {
      el.scrollLeft += event.deltaY + event.deltaX;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function pushToast(text: string, kind: 'ok' | 'warn' = 'ok'): void {
    if (!mountedRef.current) return;
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((list) => {
      if (list.some((toast) => toast.text === text)) return list;
      return [...list, { id, text, kind }];
    });
    scheduleShellTimeout(() => {
      setToasts((list) => list.filter((toast) => toast.id !== id));
    }, 4200);
  }

  return {
    sidebarWidth, setSidebarWidth, shellRef, workspaceSwitcherOpen, setWorkspaceSwitcherOpen,
    cmdkIndex, setCmdkIndex, toasts, searchInputRef, cmdkInputRef, cmdkDialogRef, cmdkReturnFocusRef,
    tabbarRef, tabbarDragRef, openCmdk, closeCmdk, trapTabWithin, focusSearchPanel,
    startSidebarResize, startTabbarDrag, moveTabbarDrag, endTabbarDrag, pushToast
  };
}

export type ShellInteractionController = ReturnType<typeof useShellInteractionController>;
