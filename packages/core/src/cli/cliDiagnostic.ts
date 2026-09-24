export interface CliToolDiagnosticInput {
  ok?: boolean;
  code?: string;
}

export interface CliToolDiagnosticDetails {
  ok: boolean;
  code?: string;
  cancelled?: boolean;
  underlyingCode?: string;
}

/**
 * Normalize the tool-level outcome at the session boundary.
 *
 * A tool may return an ordinary failure after its AbortSignal was observed
 * (for example, a reference scan can report REFERENCE_QUERY_FAILED while the
 * underlying scan is unwinding).  The CLI diagnostic describes the session
 * lifecycle, so cancellation must be the public code while retaining the
 * tool failure as an underlying diagnostic.
 */
export function normalizeCliToolDiagnostic(
  result: CliToolDiagnosticInput,
  signal?: AbortSignal
): CliToolDiagnosticDetails {
  const underlyingCode = typeof result.code === 'string' && result.code.length > 0
    ? result.code
    : undefined;
  if (signal?.aborted) {
    return {
      ok: false,
      code: 'CLI_REQUEST_CANCELLED',
      cancelled: true,
      ...(underlyingCode && underlyingCode !== 'CLI_REQUEST_CANCELLED' ? { underlyingCode } : {})
    };
  }
  return {
    ok: Boolean(result.ok),
    ...(underlyingCode ? { code: underlyingCode } : {})
  };
}
