import { MASKED_PATH_PLACEHOLDER, type Diagnostic } from '@soulforge/shared';
import { appendPostCommitFailureDiagnostic } from './knowledgeRefreshOwnership.js';
import { sanitizeDiagnostics } from './rendererDto.js';

/** Project only a newly appended postcommit warning, retaining the carrier and
 * transaction facts. Error details contain physical I/O context; logical DTOs
 * retain their existing projection rules. */
export function appendRendererPostCommitFailureDiagnostic(
  result: { diagnostics: Diagnostic[] },
  code: string,
  sourceUri: string,
  error: unknown,
  message?: string
): void {
  const warningIndex = result.diagnostics.length;
  appendPostCommitFailureDiagnostic(result, code, sourceUri, error, message);
  const warning = sanitizeDiagnostics([result.diagnostics[warningIndex]!])[0]!;
  const details = warning.details as Record<string, unknown>;
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      details[key] = value.replace(/(^|[\s'"(（:：])\/(?!\/)[^\s'"()（）<>|，。、；：！？]+/g,
        (_span, prefix: string) => `${prefix}${MASKED_PATH_PLACEHOLDER}`);
    }
  }
  result.diagnostics[warningIndex] = warning;
}
