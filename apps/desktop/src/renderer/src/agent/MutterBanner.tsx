import { useEffect, useRef, useState, type ReactElement } from 'react';
import { getRendererBridge } from '../runtime/rendererRuntime.js';

const MUTTER_MIN_DELAY_MS = 4_000;
const MUTTER_MAX_DELAY_MS = 9_000;
const MUTTER_FADE_MS = 140;

function nextMutterDelay(random: () => number = Math.random): number {
  const sampled = random();
  const value = Number.isFinite(sampled) ? sampled : 0;
  return MUTTER_MIN_DELAY_MS + Math.floor(Math.max(0, Math.min(0.999999, value)) * (
    MUTTER_MAX_DELAY_MS - MUTTER_MIN_DELAY_MS + 1
  ));
}

/**
 * Agent 输入框上方的 UI-only 碎碎念。
 *
 * 这里不接收 prompt、资源引用或任务上下文，也不把文本写入任何 Agent
 * 请求；唯一数据来源是 main 侧的 MutterService。桌面桥不可用时保持静默，
 * 不用一块“假装可用”的占位文案污染浏览器预览。
 */
export function MutterBanner(): ReactElement | null {
  const bridge = getRendererBridge();
  const [text, setText] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const currentTextRef = useRef<string | null>(null);

  useEffect(() => {
    if (bridge === null || typeof bridge.getMutterNext !== 'function') return undefined;

    let cancelled = false;
    let nextTimer: number | null = null;
    let fadeTimer: number | null = null;

    const scheduleNext = (): void => {
      if (cancelled) return;
      nextTimer = window.setTimeout(() => {
        void loadNext();
      }, nextMutterDelay());
    };

    const loadNext = async (): Promise<void> => {
      try {
        const result = await bridge.getMutterNext();
        if (cancelled) return;
        const nextText = result.text?.trim() ?? '';
        if (nextText.length > 0 && nextText !== currentTextRef.current) {
          setVisible(false);
          if (fadeTimer !== null) window.clearTimeout(fadeTimer);
          fadeTimer = window.setTimeout(() => {
            if (cancelled) return;
            currentTextRef.current = nextText;
            setText(nextText);
            setVisible(true);
          }, MUTTER_FADE_MS);
        }
      } catch {
        // 碎碎念是装饰功能；读取失败不能影响 Agent 或输入框。
      } finally {
        scheduleNext();
      }
    };

    void loadNext();
    return () => {
      cancelled = true;
      if (nextTimer !== null) window.clearTimeout(nextTimer);
      if (fadeTimer !== null) window.clearTimeout(fadeTimer);
    };
  }, [bridge]);

  if (text === null) return null;
  return (
    <div
      className={`agent-mutter${visible ? ' is-visible' : ''}`}
      data-testid="agent-mutter"
      aria-live="polite"
      aria-label="碎碎念"
    >
      <span className="agent-mutter__mark" aria-hidden="true">✦</span>
      <span className="agent-mutter__text">{text}</span>
    </div>
  );
}

export { MUTTER_MAX_DELAY_MS, MUTTER_MIN_DELAY_MS, nextMutterDelay };
