import type { Diagnostic } from '@soulforge/shared';

export type MapStaticReadDecision =
  | { action: 'fallback' }
  | { action: 'return'; result: { ok: false; sourceUri: string; diagnostics: Diagnostic[] } };

const MODEL_NOT_FOUND = 'MAPBND_MODEL_NOT_FOUND';
const NO_DATA = 'MAP_STATIC_GEOMETRY_NO_DATA';
const INVALID_DATA = 'MAP_STATIC_GEOMETRY_INVALID_DATA';
const FAILED_WITHOUT_DIAGNOSTIC = 'MAP_STATIC_GEOMETRY_FAILED';

export function isMapStaticGeometryData(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnosticCode(value: unknown): string | null {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string'
    ? (value as { code: string }).code
    : null;
}

/**
 * Keep native read failures visible to the renderer. Only an explicit native
 * absence permits trying another container; parse/session/Oodle/budget and
 * missing-data outcomes must not be rewritten as NOT_FOUND.
 */
export function decideMapStaticReadFailure(input: {
  sourceUri: string;
  parseStatus?: string | undefined;
  data?: unknown;
  diagnostics?: readonly Diagnostic[] | undefined;
}): MapStaticReadDecision {
  const diagnostics = [...(input.diagnostics ?? [])];
  const hasData = input.data !== null && input.data !== undefined;
  const malformedData = hasData && !isMapStaticGeometryData(input.data);
  if (input.parseStatus !== 'failed' && hasData && !malformedData) {
    throw new Error('MAP_STATIC_FAILURE_DECISION_REQUIRES_FAILURE');
  }
  if (malformedData && !diagnostics.some((item) => diagnosticCode(item) === INVALID_DATA)) {
    diagnostics.push({
      severity: 'error',
      code: INVALID_DATA,
      message: 'native MAP static geometry read returned a non-object data payload.',
      sourceUri: input.sourceUri
    });
  }
  const hasModelNotFound = diagnostics.some((item) => diagnosticCode(item) === MODEL_NOT_FOUND);
  const hasOtherError = diagnostics.some((item) => (
    item.severity === 'error' && diagnosticCode(item) !== MODEL_NOT_FOUND
  ));
  const hasUnknownWarning = diagnostics.some((item) => item.severity === 'warning');
  if (hasModelNotFound && !hasOtherError && !hasUnknownWarning) return { action: 'fallback' };
  let hasError = diagnostics.some((item) => item.severity === 'error');
  if (!hasData && !hasError && !diagnostics.some((item) => diagnosticCode(item) === NO_DATA)) {
    diagnostics.push({
      severity: 'error',
      code: NO_DATA,
      message: 'native MAP static geometry read returned no data without a diagnostic.',
      sourceUri: input.sourceUri
    });
    hasError = true;
  }
  if (input.parseStatus === 'failed' && !hasError && !diagnostics.some((item) => diagnosticCode(item) === FAILED_WITHOUT_DIAGNOSTIC)) {
    diagnostics.push({
      severity: 'error',
      code: FAILED_WITHOUT_DIAGNOSTIC,
      message: 'native MAP static geometry read failed without a diagnostic.',
      sourceUri: input.sourceUri
    });
  }
  return { action: 'return', result: { ok: false, sourceUri: input.sourceUri, diagnostics } };
}
