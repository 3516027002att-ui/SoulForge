import type { ToolContext } from '@soulforge/core';

/**
 * Keep only run-stable policy in the long-lived bridge closure. Workspace
 * indexes, RAG corpora and session services come from contextProvider so a
 * native refresh can release the superseded snapshot during an Agent run.
 */
export function createAgentBridgeBaseContext(
  mode: ToolContext['mode']
): ToolContext {
  return {
    workspaceIndex: null,
    mode,
    modeCeiling: mode,
    allowMemoryWrite: false
  };
}

/** Rebind an Agent's session-owned snapshot immediately after host refreshes. */
export function wrapAgentToolContextRefreshCallbacks(
  context: ToolContext,
  onRefreshComplete: () => void
): ToolContext {
  const wrapped = { ...context };
  const onNativeWriteCommitted = context.onNativeWriteCommitted;
  if (onNativeWriteCommitted) {
    wrapped.onNativeWriteCommitted = async (changedSources) => {
      try {
        return await onNativeWriteCommitted(changedSources);
      } finally {
        onRefreshComplete();
      }
    };
  }
  const onSemanticEvidenceUpdated = context.onSemanticEvidenceUpdated;
  if (onSemanticEvidenceUpdated) {
    wrapped.onSemanticEvidenceUpdated = async (sourceUris) => {
      try {
        return await onSemanticEvidenceUpdated(sourceUris);
      } finally {
        onRefreshComplete();
      }
    };
  }
  return wrapped;
}
