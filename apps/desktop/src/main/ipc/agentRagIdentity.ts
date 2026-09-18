export interface AgentRagSearchIdentity {
  activeIndex: unknown;
  activeSession: unknown;
  workspaceSessionId: string | null;
  workspaceSessionGeneration: number;
  ragEpoch?: number | undefined;
  ragScope?: string | undefined;
  ragSessionId?: string | undefined;
  ragGeneration?: number | undefined;
  ragIndexedFilesRevision?: number | undefined;
}

/** One host-owned identity check for every Agent RAG return path. */
export function isAgentRagSearchIdentityCurrent(
  expected: AgentRagSearchIdentity,
  current: AgentRagSearchIdentity
): boolean {
  return expected.activeIndex === current.activeIndex
    && expected.activeSession === current.activeSession
    && expected.workspaceSessionId === current.workspaceSessionId
    && expected.workspaceSessionGeneration === current.workspaceSessionGeneration
    && expected.ragEpoch === current.ragEpoch
    && expected.ragScope === current.ragScope
    && expected.ragSessionId === current.ragSessionId
    && expected.ragGeneration === current.ragGeneration
    && expected.ragIndexedFilesRevision === current.ragIndexedFilesRevision;
}
