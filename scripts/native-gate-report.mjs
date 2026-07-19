const nonPassingStatuses = new Set([
  'blocked',
  'candidate',
  'failed',
  'partial',
  'skipped',
  'unsupported',
  'unverified'
]);

export function extractLastJsonObject(output) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let last;

  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(output.slice(start, index + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) last = parsed;
        } catch {
          // Ignore console text that happens to contain braces.
        }
        start = -1;
      }
    }
  }
  return last;
}

export function assessNativeGateStep(exitCode, report) {
  const reasons = [];
  if (exitCode !== 0) reasons.push(`exit-code-${exitCode}`);
  if (!report) return { ok: false, reasons: [...reasons, 'structured-report-missing'] };
  if (report.ok !== true) reasons.push('report-ok-false');

  const status = typeof report.status === 'string' ? report.status.toLowerCase() : undefined;
  if (status && nonPassingStatuses.has(status)) reasons.push(`status-${status}`);
  const authority = typeof report.authority === 'string' ? report.authority.toLowerCase() : undefined;
  if (authority && nonPassingStatuses.has(authority)) reasons.push(`authority-${authority}`);

  for (const field of ['corpusFailed', 'failed', 'failuresCount', 'krakBlocked']) {
    if (typeof report[field] === 'number' && report[field] > 0) {
      reasons.push(`${field}-${report[field]}`);
    }
  }
  if (Array.isArray(report.failures) && report.failures.length > 0) {
    reasons.push(`failures-${report.failures.length}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function summarizeNativeGateReport(report) {
  if (!report) return undefined;
  const fields = [
    'ok', 'status', 'authority', 'files', 'dfltVerified', 'krakVerified', 'krakBlocked',
    'nestedBnd4Verified', 'nestedBnd4Entries', 'corpusSampled', 'corpusVerified',
    'corpusFailed', 'corpusFmgVerified', 'eventCount', 'instructionCount', 'modelCount',
    'partCount', 'regionCount', 'totalEvents', 'totalInstructions', 'layerCountZero',
    'layerCountNonZero', 'duplicateIdFixtureCount', 'dfltWrapperCount',
    'containerByteIdenticalCount', 'stagingRereadVerified', 'patchIrCommitVerified',
    'operationRollbackVerified', 'rollbackRestoredOuterBytes', 'originalFixtureUntouched'
  ];
  const summary = Object.fromEntries(
    fields.filter((field) => report[field] !== undefined).map((field) => [field, report[field]])
  );
  if (report.fieldMutation && typeof report.fieldMutation === 'object') {
    summary.fieldMutation = {
      origin: report.fieldMutation.origin,
      changedByteCount: Array.isArray(report.fieldMutation.changedByteOffsets)
        ? report.fieldMutation.changedByteOffsets.length
        : 0,
      stagingRereadVerified: report.fieldMutation.stagingRereadVerified === true,
      nativeParamdefSemanticsVerified: false
    };
  }
  return summary;
}
