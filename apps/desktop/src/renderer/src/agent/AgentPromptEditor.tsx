import {
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react';

/**
 * Composer 输入状态机（纯逻辑，无 DOM / IPC）。
 *
 * 为什么单独成纯函数：§12.6 的三条硬性行为 —— Enter 发送 / Shift+Enter 换行 /
 * IME composing 禁止误发送、自动增高且整个 Composer 不超过 40vh、空输入发送
 * disabled、执行中发送变为停止 —— 全部可以被「纯函数 + 组件事件转发」两层覆盖。
 * 把判定留在组件里就只能靠真实 Electron 测（慢、且断言的是渲染结果），而「IME
 * composing 时 Enter 把消息发出去了」这类缺陷要在单测层就能报红。
 *
 * 硬约束 16（长任务异步、可取消）的落点是 send/stop 切换：streaming 时发送按钮
 * 让位给停止，Enter 也不再触发发送。
 */

/** §12.6：整个 Composer 不超过 40vh（与 --agent-composer-max-height 初值一致）。 */
export const COMPOSER_MAX_HEIGHT_VH = 40;
/** 40vh 在矮窗口下的像素下限（320px），与 --agent-composer-max-height 的 min() 一致。 */
export const COMPOSER_MAX_HEIGHT_PX = 320;

/** §12.6 固定占位文案：与旧实现逐字一致。 */
export const COMPOSER_PLACEHOLDER = '与 Agent 对话。输入 / 查看可用命令，例如 /plan、/explain。';

/** 发送 / 停止 / 等待审批 三种动作态（§12.6：执行中发送变为停止）。 */
export type ComposerAction = 'awaiting' | 'stop' | 'send';

export interface ComposerActionInput {
  prompt: string;
  streaming: boolean;
  awaitingApproval: boolean;
}

/** 动作状态机：等待审批 > 执行中(停止) > 可发送。 */
export function composerActionState(input: ComposerActionInput): ComposerAction {
  if (input.awaitingApproval) return 'awaiting';
  if (input.streaming) return 'stop';
  return 'send';
}

/** 空文本（或纯空白）时发送 disabled（§12.6）。 */
export function isComposerSendDisabled(prompt: string): boolean {
  return prompt.trim() === '';
}

/**
 * Enter 是否应消费为「发送」。
 *
 * 返回 true 时组件 preventDefault 并 onSend；返回 false 时交给默认行为（换行）。
 * 四个必须放行的场景：非 Enter、Shift+Enter（换行）、IME composing 中（禁止误发送）、
 * streaming 中（发送已让位给停止）。空文本也不发送，与发送按钮 disabled 一致。
 */
export function shouldConsumeEnterAsSend(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  prompt: string;
  streaming: boolean;
}): boolean {
  if (input.key !== 'Enter') return false;
  if (input.shiftKey || input.isComposing) return false;
  if (input.streaming) return false;
  return input.prompt.trim() !== '';
}

/** 40vh 上限换算成像素（grow cap）：矮窗口下取 min(320, 0.4*vh)。 */
export function composerGrowCapPx(viewportHeightPx: number): number {
  return Math.min(
    COMPOSER_MAX_HEIGHT_PX,
    Math.round(viewportHeightPx * COMPOSER_MAX_HEIGHT_VH / 100)
  );
}

/** textarea 高度不超过 cap；超出后由滚动承接（grow 到顶就内部滚）。 */
export function clampTextareaHeight(contentHeightPx: number, capPx: number): number {
  return Math.max(0, Math.min(contentHeightPx, capPx));
}

export interface AgentPromptEditorProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  /** 执行中：Enter 不再发送，发送按钮让位给停止。 */
  streaming: boolean;
  placeholder: string;
  ariaLabel: string;
}

/**
 * 自动增高输入区（§12.6）：最小 72px、随内容增长、不超过 40vh。
 * IME composing（compositionstart/end）期间 Enter 只换行不发送；
 * Shift+Enter 换行；Enter 发送；空输入时发送 disabled（由上层工具栏承担）。
 *
 * 高度用 scrollHeight 同步：content 超过 cap 后高度钉在 cap，overflow 转 auto。
 * SSR（renderToStaticMarkup）下 window 不存在，grow cap 退回固定 320px，effect 不跑。
 */
export function AgentPromptEditor(props: AgentPromptEditorProps): ReactElement {
  const { prompt, onPromptChange, onSend, streaming, placeholder, ariaLabel } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isComposing, setIsComposing] = useState(false);
  const growCapPx = typeof window === 'undefined'
    ? COMPOSER_MAX_HEIGHT_PX
    : composerGrowCapPx(window.innerHeight);

  function syncHeight(element: HTMLTextAreaElement): void {
    const next = clampTextareaHeight(element.scrollHeight, growCapPx);
    element.style.height = `${next}px`;
    element.style.overflowY = element.scrollHeight > growCapPx ? 'auto' : 'hidden';
  }

  // prompt 可能被外部改动（插入 @ / # 标记、清空后重开），height 需要跟随重算。
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (element !== null) syncHeight(element);
  });

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    const element = event.currentTarget;
    onPromptChange(element.value);
    syncHeight(element);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (shouldConsumeEnterAsSend({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: isComposing || event.nativeEvent.isComposing,
      prompt,
      streaming
    })) {
      event.preventDefault();
      onSend();
    }
  }

  return (
    <textarea
      ref={textareaRef}
      rows={2}
      value={prompt}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => setIsComposing(true)}
      onCompositionEnd={() => setIsComposing(false)}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );
}
