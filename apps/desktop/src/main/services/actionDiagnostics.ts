import type { Diagnostic } from '@soulforge/shared';

export function actionDiagnostic(
  code: string,
  message: string,
  sourceUri?: string,
  details?: unknown
): Diagnostic {
  return {
    severity: 'error',
    code,
    message,
    ...(sourceUri ? { sourceUri } : {}),
    ...(details === undefined ? {} : { details })
  };
}
