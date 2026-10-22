import {
  buildAiSidebarDraft,
  type AiSidebarDraftRequest,
  type MemoryStore,
  type ToolContext,
  type ToolRegistry,
  type ToolResult,
  type WorkspaceSession
} from '@soulforge/core';

export interface AgentLocalServicePorts {
  getMemoryStore(): Pick<MemoryStore, 'list' | 'save' | 'delete'>;
  toolRegistry: Pick<ToolRegistry, 'list' | 'run'>;
  getActiveSession(): WorkspaceSession | null;
  getActiveWorkspaceSessionId(): string | null;
  getActiveWorkspaceSessionGeneration(): number;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<unknown>;
  currentToolContext(): ToolContext;
}

/** Explicit local memory maintenance and tool requests; no model credentials or sender authority. */
export function createAgentLocalService(deps: AgentLocalServicePorts) {
  const ports = Object.freeze({
    getMemoryStore: deps.getMemoryStore, toolRegistry: deps.toolRegistry,
    getActiveSession: deps.getActiveSession, getActiveWorkspaceSessionId: deps.getActiveWorkspaceSessionId,
    getActiveWorkspaceSessionGeneration: deps.getActiveWorkspaceSessionGeneration,
    ensureActiveOperationLog: deps.ensureActiveOperationLog, currentToolContext: deps.currentToolContext
  });
  const activeAiMode: ToolContext['mode'] = 'plan';

  function listMemories() {
    try {
      return { ok: true, entries: ports.getMemoryStore().list() } as const;
    } catch {
      return { ok: false, error: { code: 'MEMORY_LIST_FAILED', message: '无法读取长期记忆。' } } as const;
    }
  }

  function saveMemory(rawEntry: unknown) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      return { ok: false, error: { code: 'MEMORY_ENTRY_INVALID', message: '长期记忆条目格式无效。' } } as const;
    }
    const input = rawEntry as Record<string, unknown>;
    const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    const details = input.details === undefined ? undefined : typeof input.details === 'string' ? input.details.trim() : null;
    const id = input.id === undefined ? undefined : typeof input.id === 'string' ? input.id.trim() : null;
    const tags = input.tags === undefined
      ? undefined
      : Array.isArray(input.tags) && input.tags.every((tag) => typeof tag === 'string')
        ? input.tags.map((tag) => tag.trim()).filter(Boolean)
        : null;
    const invalidTags = tags === null || (tags !== undefined && (tags.length > 32 || tags.some((tag) => tag.length > 128)));
    if (!topic || topic.length > 256 || !summary || summary.length > 10_000 || details === null || id === null || invalidTags) {
      return { ok: false, error: { code: 'MEMORY_ENTRY_INVALID', message: '长期记忆条目字段无效或超出长度限制。' } } as const;
    }
    try {
      const entry = ports.getMemoryStore().save({
        ...(id ? { id } : {}),
        topic,
        summary,
        ...(details !== undefined ? { details } : {}),
        ...(tags !== undefined ? { tags } : {})
      });
      return { ok: true, entry } as const;
    } catch {
      return { ok: false, error: { code: 'MEMORY_SAVE_FAILED', message: '无法保存长期记忆。' } } as const;
    }
  }

  function deleteMemory(idOrTopic: unknown) {
    if (typeof idOrTopic !== 'string' || !idOrTopic.trim() || idOrTopic.length > 256) {
      return { ok: false, error: { code: 'MEMORY_KEY_INVALID', message: '长期记忆标识无效。' } } as const;
    }
    try {
      return { ok: true, deleted: ports.getMemoryStore().delete(idOrTopic.trim()) } as const;
    } catch {
      return { ok: false, error: { code: 'MEMORY_DELETE_FAILED', message: '无法删除长期记忆。' } } as const;
    }
  }

  function sidebarDraft(request: AiSidebarDraftRequest) {
    return buildAiSidebarDraft({
      ...request,
      settings: { ...request.settings, mode: activeAiMode },
      availableTools: request.availableTools.length > 0 ? request.availableTools : ports.toolRegistry.list()
    });
  }

  async function runTool(name: string, input: unknown): Promise<ToolResult> {
    // T6：无工作区时由工具层按工具守卫（WORKSPACE_REQUIRED），不整次拒绝。
    const session = ports.getActiveSession();
    const sessionId = ports.getActiveWorkspaceSessionId();
    const generation = ports.getActiveWorkspaceSessionGeneration();
    if (session) await ports.ensureActiveOperationLog(session);
    if (ports.getActiveSession() !== session
      || ports.getActiveWorkspaceSessionId() !== sessionId
      || ports.getActiveWorkspaceSessionGeneration() !== generation) {
      return { ok: false, state: 'cancelled', error: {
        code: 'AGENT_WORKSPACE_REPLACED', message: '工作区已更换，旧工具请求未执行。'
      } };
    }
    return ports.toolRegistry.run(name, input, ports.currentToolContext());
  }

  return Object.freeze({ listMemories, saveMemory, deleteMemory, sidebarDraft, runTool });
}
