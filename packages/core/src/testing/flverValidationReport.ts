export interface FlverValidationSample {
  id: string;
  meshCount: number;
  meshesChecked: number;
  meshesOk: number;
  decodeFailures: string[];
  emptyMeshIndices?: number[];
}

/** Empty native models have no renderable geometry to verify. */
export function summarizeFlverValidation<T extends FlverValidationSample>(reports: T[]) {
  const samples = reports.map(report => {
    const empty = report.emptyMeshIndices ?? [];
    const validEmpty = Array.isArray(empty) && new Set(empty).size === empty.length
      && empty.every(index => Number.isInteger(index) && index >= 0 && index < report.meshCount);
    const complete = validEmpty && report.meshesChecked === report.meshCount
      && report.meshesOk + empty.length === report.meshCount;
    const validationStatus = report.decodeFailures.length ? 'failed' as const
      : !validEmpty ? 'unverified' as const
      : report.meshCount === 0 || (complete && report.meshesOk === 0) ? 'empty' as const
      : complete ? 'passed' as const
      : 'unverified' as const;
    return { ...report, validationStatus };
  });
  const counts = { passed: 0, failed: 0, empty: 0, unverified: 0 };
  for (const sample of samples) counts[sample.validationStatus] += 1;
  const ok = counts.failed === 0 && counts.unverified === 0 && counts.passed > 0;
  const status = counts.failed > 0 ? 'failed' : ok ? 'verified' : 'unverified';
  const meshes = reports.reduce((sum, report) => sum + report.meshCount, 0);
  return { ok, status, counts, samples, independentReferenceVerified: false,
    evidenceScope: 'native structural self-consistency; independent-reference correctness requires separate field reports',
    failures: samples.filter(sample => sample.validationStatus === 'failed'),
    message: ok ? `FLVER 多样本原生验证通过（${counts.passed} verified samples, ${meshes} meshes; ${counts.empty} empty samples）`
      : counts.failed ? `FLVER 多样本原生验证失败（${counts.failed} failed samples; ${counts.empty} empty samples）`
      : `FLVER 多样本未验证（${counts.empty} empty samples; ${counts.unverified} incomplete samples）`
  };
}
