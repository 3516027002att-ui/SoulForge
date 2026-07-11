import type { ResourceKind } from '@soulforge/shared';
import type { ToolContext, ToolDescriptor } from './toolRegistry.js';

export type AiProvider = 'mock' | 'openai' | 'anthropic';
export type AiThinkingLevel = 'fast' | 'normal' | 'deep' | 'extreme';
export type AiPermissionMode = ToolContext['mode'];

export interface AiSidebarSettings {
  provider: AiProvider;
  thinking: AiThinkingLevel;
  mode: AiPermissionMode;
}

export interface AiSelectedResourceContext {
  sourceUri: string;
  relativePath: string;
  resourceKind: ResourceKind;
}

export interface AiWorkspaceContextSnapshot {
  workspaceSessionId?: string;
  selectedResource?: AiSelectedResourceContext;
  previewKind?: string;
  diagnosticsCount?: number;
  referenceStats?: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers?: number;
  };
  currentEventUri?: string;
}

export interface AiSidebarDraftRequest {
  settings: AiSidebarSettings;
  userPrompt: string;
  context: AiWorkspaceContextSnapshot;
  availableTools: ToolDescriptor[];
}

export interface AiToolRecommendation {
  toolName: string;
  reason: string;
  permission: string;
}

export interface AiSidebarDraft {
  provider: AiProvider;
  thinking: AiThinkingLevel;
  mode: AiPermissionMode;
  status: 'ready' | 'notConfigured';
  title: string;
  summary: string;
  contextFacts: string[];
  recommendedTools: AiToolRecommendation[];
  safetyRails: string[];
  nextActions: string[];
  promptPreview: string;
}

export function buildAiSidebarDraft(request: AiSidebarDraftRequest): AiSidebarDraft {
  const prompt = request.userPrompt.trim();
  const selected = request.context.selectedResource;
  const status: AiSidebarDraft['status'] = request.settings.provider === 'mock' ? 'ready' : 'notConfigured';
  const contextFacts = buildContextFacts(request.context);
  const recommendedTools = recommendTools(prompt, request.availableTools, request.settings.mode);
  const safetyRails = buildSafetyRails(request.settings);
  const nextActions = buildNextActions(prompt, request.settings, recommendedTools, status);

  const target = selected
    ? `${selected.resourceKind}:${selected.relativePath}`
    : request.context.workspaceSessionId
      ? '当前工作区'
      : '未打开工作区';

  return {
    provider: request.settings.provider,
    thinking: request.settings.thinking,
    mode: request.settings.mode,
    status,
    title: prompt.length > 0 ? 'AI 计划草稿' : 'AI 侧边栏待命',
    summary: buildSummary(prompt, target, status),
    contextFacts,
    recommendedTools,
    safetyRails,
    nextActions,
    promptPreview: renderPromptPreview(request, contextFacts, recommendedTools, safetyRails)
  };
}

function buildSummary(prompt: string, target: string, status: AiSidebarDraft['status']): string {
  if (status === 'notConfigured') {
    return '模型服务选择已经记录，但真实 API 通道尚未接入；当前只生成本地计划草稿，不会联网调用模型。';
  }

  if (prompt.length === 0) {
    return `已准备基于 ${target} 生成证据优先的 Mod 修改计划。`;
  }

  return `将围绕「${prompt}」分析 ${target}，优先使用只读工具收集证据，再进入补丁引擎计划。`;
}

function buildContextFacts(context: AiWorkspaceContextSnapshot): string[] {
  const facts: string[] = [];

  facts.push(context.workspaceSessionId ? '工作区：已打开' : '工作区：未打开');

  if (context.selectedResource) {
    facts.push(`已选择：${context.selectedResource.relativePath}`);
    facts.push(`资源类型：${context.selectedResource.resourceKind}`);
    facts.push(`资源 URI：${context.selectedResource.sourceUri}`);
  } else {
    facts.push('已选择：无');
  }

  if (context.previewKind) facts.push(`预览类型：${context.previewKind}`);
  if (context.currentEventUri) facts.push(`事件 URI：${context.currentEventUri}`);
  if (typeof context.diagnosticsCount === 'number') facts.push(`诊断数量：${context.diagnosticsCount}`);

  if (context.referenceStats) {
    facts.push(`引用：高 ${context.referenceStats.high} / 中 ${context.referenceStats.medium} / 低 ${context.referenceStats.low}`);
  }

  return facts;
}

function recommendTools(prompt: string, tools: ToolDescriptor[], mode: AiPermissionMode): AiToolRecommendation[] {
  const lower = prompt.toLowerCase();
  const names = new Set<string>();

  names.add('workspace_stats');

  if (lower.includes('event') || lower.includes('事件') || lower.includes('emevd')) {
    names.add('search_events');
    names.add('explain_event');
  }

  if (lower.includes('map') || lower.includes('地图') || lower.includes('msb') || lower.includes('entity') || lower.includes('区域')) {
    names.add('search_map_entities');
  }

  if (lower.includes('param') || lower.includes('参数') || lower.includes('speffect') || lower.includes('goods')) {
    names.add('search_param_rows');
  }

  if (lower.includes('text') || lower.includes('msg') || lower.includes('文本') || lower.includes('台词') || lower.includes('fmg')) {
    names.add('search_text_entries');
    names.add('lookup_text_id');
    names.add('find_text_references');
  }

  if (lower.includes('改') || lower.includes('patch') || lower.includes('修改') || lower.includes('替换')) {
    names.add('propose_text_patch');
    names.add('validate_patch');
  }

  if (names.size === 1) {
    names.add('search_resources');
    names.add('find_references');
  }

  return tools
    .filter((tool) => names.has(tool.name))
    .filter((tool) => isDescriptorAllowed(tool, mode))
    .map((tool) => ({
      toolName: tool.name,
      reason: reasonForTool(tool.name),
      permission: tool.permission
    }));
}

function isDescriptorAllowed(tool: ToolDescriptor, mode: AiPermissionMode): boolean {
  if (tool.permission === 'read') return true;
  if (tool.permission === 'plan') return mode === 'plan' || mode === 'normal' || mode === 'fullPermission';
  return mode === 'fullPermission';
}

function reasonForTool(name: string): string {
  const reasons: Record<string, string> = {
    workspace_stats: '先看索引规模，避免在空工作区里误判。',
    search_resources: '定位相关资源文件，建立最小上下文。',
    search_events: '查找候选事件入口。',
    explain_event: '生成证据优先的事件解释输入。',
    search_map_entities: '查找地图实体、区域和可见命名候选。',
    search_param_rows: '查找参数行候选或已确认行。',
    search_text_entries: '查找文本条目。',
    lookup_text_id: '按 textId 精确定位文本。',
    find_text_references: '找出文本被哪些事件或符号引用。',
    find_references: '查看证据图里的入边和出边。',
    propose_text_patch: '只生成补丁计划，不直接保存文件。',
    validate_patch: '在暂存区中验证补丁计划。'
  };

  return reasons[name] ?? '作为 AI 安全工具参与证据链。';
}

function buildSafetyRails(settings: AiSidebarSettings): string[] {
  const rails = [
    '所有写入必须先生成补丁提案，不能直接改用户 Mod 工作区。',
    'synthetic 测试样本只能证明处理链路，不代表原生格式权威。',
    '低置信候选必须保留置信等级，不允许伪装成已确认的解析输出。'
  ];

  if (settings.mode === 'plan') {
    rails.unshift('当前是计划模式：只允许读证据和生成计划。');
  } else if (settings.mode === 'normal') {
    rails.unshift('当前是普通模式：可以生成和验证补丁，但仍不允许越过补丁引擎。');
  } else {
    rails.unshift('当前是完全权限模式：高风险操作也必须经过备份、验证和回滚保护。');
  }

  if (settings.provider !== 'mock') {
    rails.push('真实模型服务需要后续安全配置 API key、请求日志和权限边界。');
  }

  return rails;
}

function buildNextActions(
  prompt: string,
  settings: AiSidebarSettings,
  recommendedTools: AiToolRecommendation[],
  status: AiSidebarDraft['status']
): string[] {
  const actions: string[] = [];

  if (status === 'notConfigured') {
    actions.push('先完成模型服务配置层：API key 来源、模型名、请求边界、日志脱敏。');
  }

  if (prompt.trim().length === 0) {
    actions.push('输入一个目标，例如“解释当前事件会影响哪些文本和参数”。');
  } else {
    actions.push('先运行只读工具收集证据。');
  }

  if (recommendedTools.length > 0) {
    actions.push(`建议优先工具：${recommendedTools.slice(0, 3).map((tool) => tool.toolName).join(' → ')}`);
  }

  if (settings.mode !== 'plan') {
    actions.push('进入补丁阶段前，必须先展示差异、验证结果和回滚计划。');
  }

  return actions;
}

function renderPromptPreview(
  request: AiSidebarDraftRequest,
  contextFacts: string[],
  recommendedTools: AiToolRecommendation[],
  safetyRails: string[]
): string {
  const lines = [
    '# SoulForge AI 侧边栏草稿',
    '',
    `模型服务：${request.settings.provider}`,
    `思考强度：${request.settings.thinking}`,
    `权限模式：${request.settings.mode}`,
    '',
    '## 用户目标',
    request.userPrompt.trim() || '（尚未输入目标）',
    '',
    '## 上下文事实',
    ...contextFacts.map((fact) => `- ${fact}`),
    '',
    '## 建议工具',
    ...(recommendedTools.length > 0
      ? recommendedTools.map((tool) => `- ${tool.toolName} (${tool.permission}): ${tool.reason}`)
      : ['- 暂无工具建议']),
    '',
    '## 安全边界',
    ...safetyRails.map((rail) => `- ${rail}`)
  ];

  return lines.join('\n');
}
