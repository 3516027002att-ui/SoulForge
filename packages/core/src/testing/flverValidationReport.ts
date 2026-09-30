export interface FlverValidationSample {
  id: string;
  meshCount: number;
  meshesChecked: number;
  meshesOk: number;
  decodeFailures: string[];
}

/** Empty native models have no renderable geometry to verify. */
export function summarizeFlverValidation<T extends FlverValidationSample>(reports: T[]) {
  const samples = reports.map(report => ({ ...report,
    validationStatus: report.decodeFailures.length ? 'failed' as const
      : report.meshCount === 0 ? 'empty' as const
      : report.meshesChecked === report.meshCount && report.meshesOk === report.meshCount ? 'passed' as const
      : 'unverified' as const
  }));
  const counts = { passed: 0, failed: 0, empty: 0, unverified: 0 };
  for (const sample of samples) counts[sample.validationStatus] += 1;
  const ok = counts.failed === 0 && counts.unverified === 0 && counts.passed > 0;
  const status = counts.failed > 0 ? 'failed' : ok ? 'verified' : 'unverified';
  const meshes = reports.reduce((sum, report) => sum + report.meshCount, 0);
  return { ok, status, counts, samples, failures: samples.filter(sample => sample.validationStatus === 'failed'),
    message: ok ? `FLVER 多样本原生验证通过（${counts.passed} verified samples, ${meshes} meshes; ${counts.empty} empty samples）`
      : counts.failed ? `FLVER 多样本原生验证失败（${counts.failed} failed samples; ${counts.empty} empty samples）`
      : `FLVER 多样本未验证（${counts.empty} empty samples; ${counts.unverified} incomplete samples）`
  };
}
