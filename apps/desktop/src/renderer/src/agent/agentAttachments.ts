/**
 * Agent 附件草稿：main 弹对话框签发 opaque token，renderer 只持有 token + 显示名。
 * 文件落在 userData/agent/attachments，不进 Mod 工作区，不把绝对路径交给 renderer。
 */
import type { AgentAttachmentReference } from '@soulforge/shared';
import type { SoulForgeApi } from '../../../preload/index.js';

/** 与 SubmitAgentRunRequest 解码上限一致。 */
export const AGENT_ATTACHMENT_MAX = 8;

export interface AgentAttachmentChip {
  token: string;
  label: string;
  mediaType: AgentAttachmentReference['mediaType'];
  byteLength: number;
  expiresAt: string;
}

export interface AgentAttachmentDraftState {
  readonly attachments: readonly AgentAttachmentChip[];
  readonly creating: boolean;
  readonly error: string | null;
}

export function createInitialAttachmentDraft(): AgentAttachmentDraftState {
  return { attachments: [], creating: false, error: null };
}

export type AgentAttachmentDraftEvent =
  | { type: 'create-requested' }
  | { type: 'create-succeeded'; chip: AgentAttachmentChip }
  | { type: 'create-failed'; message: string }
  | { type: 'create-cancelled' }
  | { type: 'remove'; token: string }
  | { type: 'reset' };

export function reduceAgentAttachmentDraft(
  state: AgentAttachmentDraftState,
  event: AgentAttachmentDraftEvent
): AgentAttachmentDraftState {
  switch (event.type) {
    case 'create-requested':
      return { ...state, creating: true, error: null };
    case 'create-cancelled':
      return { ...state, creating: false };
    case 'create-succeeded': {
      if (state.attachments.some((item) => item.token === event.chip.token)) {
        return { ...state, creating: false, error: null };
      }
      if (state.attachments.length >= AGENT_ATTACHMENT_MAX) {
        return {
          ...state,
          creating: false,
          error: `附件最多 ${AGENT_ATTACHMENT_MAX} 个。`
        };
      }
      return {
        attachments: [...state.attachments, event.chip],
        creating: false,
        error: null
      };
    }
    case 'create-failed':
      return { ...state, creating: false, error: event.message };
    case 'remove':
      return {
        ...state,
        attachments: state.attachments.filter((item) => item.token !== event.token)
      };
    case 'reset':
      return createInitialAttachmentDraft();
  }
}

export type CreateAgentAttachment = SoulForgeApi['createAgentAttachment'];

export async function createAgentAttachmentFlow(
  create: CreateAgentAttachment,
  dispatch: (event: AgentAttachmentDraftEvent) => void
): Promise<void> {
  dispatch({ type: 'create-requested' });
  let result: Awaited<ReturnType<CreateAgentAttachment>>;
  try {
    result = await create();
  } catch (error) {
    dispatch({
      type: 'create-failed',
      message: error instanceof Error ? error.message : '添加附件失败。'
    });
    return;
  }
  if (result.ok) {
    dispatch({
      type: 'create-succeeded',
      chip: {
        token: result.reference.token,
        label: result.label,
        mediaType: result.reference.mediaType,
        byteLength: result.reference.byteLength,
        expiresAt: result.reference.expiresAt
      }
    });
    return;
  }
  if (result.cancelled === true) {
    dispatch({ type: 'create-cancelled' });
    return;
  }
  dispatch({ type: 'create-failed', message: `${result.error.code}：${result.error.message}` });
}

export function toAgentAttachmentReferences(
  chips: readonly AgentAttachmentChip[]
): AgentAttachmentReference[] {
  return chips.map((chip) => ({
    token: chip.token,
    mediaType: chip.mediaType,
    byteLength: chip.byteLength,
    expiresAt: chip.expiresAt
  }));
}
