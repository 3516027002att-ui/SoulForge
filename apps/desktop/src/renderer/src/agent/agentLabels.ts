import type { AiPermissionMode, AiProvider, AiThinkingLevel } from '@soulforge/core';

/** mock 是离线规则计划器，不得显示为真实本地模型。 */
export function modelServiceLabel(provider: AiProvider): string {
  if (provider === 'mock') return '离线计划';
  return provider === 'openai' ? 'OpenAI 模型服务' : 'Anthropic 模型服务';
}

export function thinkingLabel(level: AiThinkingLevel): string {
  return ({
    off: '关闭',
    none: 'none',
    minimal: 'minimal',
    low: '低',
    medium: '普通',
    high: '高',
    xhigh: 'xhigh',
    max: '极致'
  } as const)[level];
}

export function permissionModeLabel(mode: AiPermissionMode): string {
  return ({ plan: '计划模式', normal: '普通模式', fullPermission: '完全权限' } as const)[mode];
}
