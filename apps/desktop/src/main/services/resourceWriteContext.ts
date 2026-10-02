import type { ConfirmationReceipt, SaveTextResourceResult } from '@soulforge/shared';
import type { RendererSaveResult } from '../rendererDto.js';

/** Sender/event binding belongs to the trusted transport. */
export type ResourceWriteConfirmation = (input: {
  resourceLabel: string;
  sourceUri: string;
  actionLabel: string;
  payloadHash: string;
  extraSubjects?: string[];
}) => Promise<ConfirmationReceipt | null>;

export function confirmationRequiredResult(sourceUri: string): SaveTextResourceResult {
  return {
    ok: false,
    changedFiles: [],
    requiresConfirmation: true,
    diagnostics: [{
      severity: 'warning',
      code: 'EDIT_CONFIRMATION_REQUIRED',
      message: '该脚本写回需要显式确认。',
      sourceUri
    }]
  };
}

export function cancelledWrite(sourceUri: string): RendererSaveResult {
  return {
    ok: false,
    changedFiles: [],
    requiresConfirmation: true,
    diagnostics: [
      {
        severity: 'warning',
        code: 'WRITE_CONFIRMATION_CANCELLED',
        message: '用户取消了高风险写入。',
        sourceUri
      }
    ]
  };
}
