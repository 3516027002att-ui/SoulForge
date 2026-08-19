import type { ModelThinkingLevel } from '@soulforge/core';

/**
 * 2-A：思考强度锁官方 effort 档（2026-08-19 对照 OpenAI / Anthropic 文档核实）。
 *
 * OpenAI 官方 effort 全档：off(none/minimal/low/medium/high/xhigh/max)。
 * Anthropic 官方 effort：off/low/medium/high/xhigh/max（没有 none/minimal，
 * 也没有 budget_tokens 数字）。注意 `off` 是产品语义（字段不下发），不是官方档。
 *
 * 这套表是 UI 的唯一来源；旧档 fast/normal/deep/extreme 已从产品移除，只在读
 * 旧配置时按 fast→low / normal→medium / deep→high / extreme→max 兼容映射
 * （见 types.ts 的 migrateThinkingLevel），这里不再单独翻译。
 */
export const AGENT_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const;

/** OpenAI / Anthropic 两种服务协议的判别类型。 */
export type ThinkingProtocol = 'openai-compatible' | 'anthropic-compatible';

/**
 * 按协议给出当前服务可选档位表。
 *
 * OpenAI 兼容：官方全档 `off, none, minimal, low, medium, high, xhigh, max`。
 * Anthropic 兼容：官方表 `off, low, medium, high, xhigh, max`（none/minimal 是
 * OpenAI 专有，Anthropic 官方表没有）。某个具体模型是否支持某一档由服务端决定，
 * 适配器在请求失败时会降档并在 diagnostics 说明——UI 始终显示完整官方阶梯，
 * 不能因为怕 400 就把 max 从下拉拿掉（用户点名 max 不见了）。
 */
export function thinkingLevelsForProtocol(
  protocol: ThinkingProtocol
): readonly ModelThinkingLevel[] {
  if (protocol === 'openai-compatible') return AGENT_THINKING_LEVELS;
  return AGENT_THINKING_LEVELS.filter((level) => level !== 'none' && level !== 'minimal');
}

/**
 * 思考强度的可见标签：英文官方值（不翻译成「极致」）。`off` 显示成 `Off`，
 * 其余原样显示（`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）。
 */
export function thinkingLevelLabel(
  level: ModelThinkingLevel,
  _protocol: ThinkingProtocol
): string {
  return level === 'off' ? 'Off' : level;
}

/**
 * 2-A：当前值不在新表的档位列表里时收敛到合法默认档 'medium'（OpenAI 与
 * Anthropic 两表都有 medium）。旧档值在进入 UI 前已被读路径 migrateThinkingLevel
 * 映射成官方值，这里不再处理 legacy。
 */
export function convergeThinkingLevel(
  level: ModelThinkingLevel,
  protocol: ThinkingProtocol
): ModelThinkingLevel {
  const table = thinkingLevelsForProtocol(protocol);
  return (table as readonly ModelThinkingLevel[]).includes(level) ? level : 'medium';
}
