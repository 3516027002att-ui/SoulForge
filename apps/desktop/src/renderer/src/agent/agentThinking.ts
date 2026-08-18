import type { ModelThinkingLevel } from '@soulforge/core';

/**
 * S32：思考强度档位（关/快/普通/深/极致，顺序即下拉顺序）。
 *
 * 8-B：这是**内部枚举的完整档位集合**，不代表任何协议下都能全给。UI 选表请用
 * thinkingLevelsForProtocol(protocol)：OpenAI 只有 3 档 effort（deep/extreme 都会
 * 发成 high，UI 不得同时给两档），Anthropic 四档 budget 全给。
 */
export const AGENT_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'fast',
  'normal',
  'deep',
  'extreme'
] as const;

/** OpenAI / Anthropic 两种服务协议的判别类型。 */
export type ThinkingProtocol = 'openai-compatible' | 'anthropic-compatible';

/**
 * 8-B：按协议给出当前服务可选档位表。
 *
 * OpenAI 只有 3 档 effort（reasoning_effort = low/medium/high）；deep/extreme 都会
 * 发成 high，所以 OpenAI 下拉不得同时给「深」和「极致」两个假档。Anthropic 四档
 * token budget 全给。
 */
export function thinkingLevelsForProtocol(
  protocol: ThinkingProtocol
): readonly ModelThinkingLevel[] {
  if (protocol === 'openai-compatible') return AGENT_THINKING_LEVELS.filter((level) => level !== 'extreme');
  return AGENT_THINKING_LEVELS;
}

/**
 * 8-B：思考强度的可见标签（英文）。
 *
 * OpenAI → Off/Low/Medium/High；Anthropic → Off/2048/4096/8192/16384（budget_tokens）。
 * 内部枚举 ModelThinkingLevel 不变，两条 resolve（resolveOpenAiReasoningEffort /
 * resolveAnthropicThinkingBudget）也不变——这里只是换表 + 换标签。
 */
export function thinkingLevelLabel(
  level: ModelThinkingLevel,
  protocol: ThinkingProtocol
): string {
  if (protocol === 'openai-compatible') {
    switch (level) {
      case 'off':
        return 'Off';
      case 'fast':
        return 'Low';
      case 'normal':
        return 'Medium';
      case 'deep':
        return 'High';
      default:
        return 'High';
    }
  }
  switch (level) {
    case 'off':
      return 'Off';
    case 'fast':
      return '2048';
    case 'normal':
      return '4096';
    case 'deep':
      return '8192';
    case 'extreme':
      return '16384';
  }
}

/**
 * 8-C：当前值不在新表的档位列表里时收敛到 'deep'（OpenAI 下对应 High；
 * Anthropic 下对应 8192，两表都是合法档）。
 */
export function convergeThinkingLevel(
  level: ModelThinkingLevel,
  protocol: ThinkingProtocol
): ModelThinkingLevel {
  const table = thinkingLevelsForProtocol(protocol);
  return (table as readonly ModelThinkingLevel[]).includes(level) ? level : 'deep';
}
