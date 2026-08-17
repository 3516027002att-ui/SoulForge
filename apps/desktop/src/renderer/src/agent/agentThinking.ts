import type { ModelThinkingLevel } from '@soulforge/core';

/** S32：思考强度档位（关/快/普通/深/极致，顺序即下拉顺序）。 */
export const AGENT_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'fast',
  'normal',
  'deep',
  'extreme'
] as const;

/** 思考强度档位的中文标签（输入条下拉与设置页共用）。 */
export function thinkingLevelLabel(level: ModelThinkingLevel): string {
  switch (level) {
    case 'off':
      return '关';
    case 'fast':
      return '快';
    case 'deep':
      return '深';
    case 'extreme':
      return '极致';
    default:
      return '普通';
  }
}
