import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

export type AgentInteractionMode = 'ask' | 'plan' | 'edit';

export const AGENT_INTERACTION_MODES: ReadonlyArray<{
  id: AgentInteractionMode;
  label: string;
  description: string;
}> = [
  { id: 'ask', label: 'Ask', description: '只读问答与解释' },
  { id: 'plan', label: 'Plan', description: '形成提案，不直接写入' },
  { id: 'edit', label: 'Edit', description: '在权限约束内提出编辑' }
];

export function interactionModeLabel(mode: AgentInteractionMode): string {
  return AGENT_INTERACTION_MODES.find((item) => item.id === mode)?.label ?? 'Ask';
}

export interface AgentParticipantBarProps {
  mode: AgentInteractionMode;
  /** 真实回调：交互模式（Ask/Plan/Edit）由 App 持有，这里是 mode 菜单的入口。 */
  onModeChange: (mode: AgentInteractionMode) => void;
}

/**
 * 三层 Composer 的第一层「模式选择」（§12.6）：`[Ask / Plan / Edit]` 下拉。
 * 模式选择只做本地开合状态；选中的模式回传给 App（60B 只保证按钮按真实 callback
 * 存在，真实能力接线由后续卡片承担）。
 *
 * 2-B：已删除「权限：计划模式（主进程锁定）」说明段——交互模式（Ask/Plan/Edit）与
 * 主进程锁死的 permissionMode 是两套东西，那段字永远显示「计划模式」且与交互意图
 * 无关；2-C：已删除 @Agent 占位 span。
 *
 * S9：菜单用 portal 挂到 `document.body` + `position:fixed`。旧实现是
 * `position:absolute; bottom: calc(100% + 5px)` 挂在 composer 内，父级 `.agent` /
 * composer 都是 `overflow:hidden`，菜单往上长就被裁掉（「点 Ask 弹窗被挡住」）。
 * Esc / 点外侧关闭；不做独立 BrowserWindow。
 */
export function AgentParticipantBar(props: AgentParticipantBarProps): ReactElement {
  const { mode, onModeChange } = props;
  const [modeOpen, setModeOpen] = useState(false);
  /** 菜单锚点（trigger 按钮的 viewport 坐标），打开时取一次。 */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modeOpen) {
      // 关闭时清掉锚点：重开不再用旧位置渲染一帧（S9 回放测试抓到的 stale top）。
      setMenuPos(null);
      return;
    }
    const measure = (): void => {
      const trigger = triggerRef.current;
      if (trigger === null) return;
      const rect = trigger.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 5, left: rect.left });
    };
    measure();
    // 窗口尺寸变化时菜单重锚（fixed 定位不随布局走）。
    window.addEventListener('resize', measure);
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setModeOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onPointerDown(event: globalThis.PointerEvent): void {
      const target = event.target instanceof Node ? event.target : null;
      if (target === null) return;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setModeOpen(false);
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', measure);
    };
  }, [modeOpen]);

  // 视口太矮时菜单向下放会越出窗口底：量一次实际高度，翻到 trigger 上方（留 10px 缝）。
  useEffect(() => {
    if (!modeOpen || menuPos === null) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (menu === null || trigger === null) return;
    const rect = menu.getBoundingClientRect();
    const overflowBottom = rect.bottom - window.innerHeight;
    if (overflowBottom <= 0) return;
    const triggerTop = trigger.getBoundingClientRect().top;
    const newTop = triggerTop - rect.height - 10;
    if (newTop < 0) return; // 上翻也放不下：保持原位，不出顶。
    setMenuPos((pos) => (pos !== null ? { top: newTop, left: pos.left } : pos));
  }, [modeOpen, menuPos]);

  return (
    <div className="agent-composer__participant">
      <div className="agent-mode-select">
        <button
          type="button"
          ref={triggerRef}
          className="agent-mode-trigger"
          aria-haspopup="listbox"
          aria-expanded={modeOpen}
          onClick={() => setModeOpen((open) => !open)}
        >
          {interactionModeLabel(mode)}
          <span aria-hidden="true">⌄</span>
        </button>
        {modeOpen && menuPos !== null && createPortal(
          <div
            className="agent-mode-menu"
            ref={menuRef}
            role="listbox"
            aria-label="Agent 交互模式"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {AGENT_INTERACTION_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={mode === item.id}
                onClick={() => {
                  onModeChange(item.id);
                  setModeOpen(false);
                }}
              >
                <strong>{item.label}</strong><span>{item.description}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
      </div>
    </div>
  );
}
