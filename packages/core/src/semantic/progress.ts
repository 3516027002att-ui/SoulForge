import { createHash } from 'node:crypto';
import type { ProgressDecision, ProgressObservation } from './types.js';

export class NoProgressTracker {
  private readonly history = new Map<string, {
    fingerprint: string;
    candidateIds: Set<string>;
    factKeys: Set<string>;
    evidenceIds: Set<string>;
    unknowns: Set<string>;
    coverageStatus?: ProgressObservation['coverageStatus'];
    repeated: number;
  }>();

  observe(input: Omit<ProgressObservation, 'resultFingerprint'> & { result: unknown }): ProgressDecision {
    const resultFingerprint = fingerprint(input.result);
    const previous = this.history.get(input.subgoalId);
    const candidateIds = new Set(input.candidateIds);
    const signals = extractSignals(input.result);
    if (!previous) {
      this.history.set(input.subgoalId, {
        fingerprint: resultFingerprint,
        candidateIds,
        factKeys: signals.factKeys,
        evidenceIds: signals.evidenceIds,
        unknowns: signals.unknowns,
        ...(input.coverageStatus ? { coverageStatus: input.coverageStatus } : {}),
        repeated: 0
      });
      return {
        action: 'CONTINUE',
        repeated: 0,
        newCandidateCount: candidateIds.size,
        newFactCount: signals.factKeys.size,
        newEvidenceCount: signals.evidenceIds.size
      };
    }
    const newCandidateCount = [...candidateIds].filter((id) => !previous.candidateIds.has(id)).length;
    const newFactCount = [...signals.factKeys].filter((key) => !previous.factKeys.has(key)).length;
    const newEvidenceCount = [...signals.evidenceIds].filter((id) => !previous.evidenceIds.has(id)).length;
    const unknownsReduced = [...previous.unknowns].filter((unknown) => !signals.unknowns.has(unknown)).length;
    const coverageChanged = previous.coverageStatus !== input.coverageStatus;
    const repeated = newCandidateCount === 0
      && newFactCount === 0
      && newEvidenceCount === 0
      && unknownsReduced === 0
      && previous.fingerprint === resultFingerprint
      && !coverageChanged
      ? previous.repeated + 1
      : 0;
    this.history.set(input.subgoalId, {
      fingerprint: resultFingerprint,
      candidateIds: new Set([...previous.candidateIds, ...candidateIds]),
      factKeys: new Set([...previous.factKeys, ...signals.factKeys]),
      evidenceIds: new Set([...previous.evidenceIds, ...signals.evidenceIds]),
      unknowns: signals.unknowns,
      ...(input.coverageStatus ? { coverageStatus: input.coverageStatus } : {}),
      repeated
    });
    return repeated >= 2
      ? {
          action: 'REPLAN',
          repeated,
          newCandidateCount,
          newFactCount,
          newEvidenceCount,
          reason: '同一子目标连续获得相同语义结果，且没有新的候选、事实、证据或未知项收敛。'
        }
      : { action: 'CONTINUE', repeated, newCandidateCount, newFactCount, newEvidenceCount };
  }

  reset(subgoalId?: string): void {
    if (subgoalId) this.history.delete(subgoalId);
    else this.history.clear();
  }
}

function fingerprint(value: unknown): string {
  const normalized = typeof value === 'string' ? parseJson(value) ?? value : value;
  return createHash('sha256').update(stableJson(normalized)).digest('hex').slice(0, 24);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => !/^(?:query|q|tool|cursor|nextCursor|pageToken)$/i.test(key))
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function progressObservation(input: Omit<ProgressObservation, 'resultFingerprint'> & { result: unknown }): ProgressObservation {
  return {
    subgoalId: input.subgoalId,
    resultFingerprint: fingerprint(input.result),
    candidateIds: [...input.candidateIds],
    ...(input.coverageStatus ? { coverageStatus: input.coverageStatus } : {})
  };
}

interface ProgressSignals {
  factKeys: Set<string>;
  evidenceIds: Set<string>;
  unknowns: Set<string>;
}

function extractSignals(value: unknown): ProgressSignals {
  const factKeys = new Set<string>();
  const evidenceIds = new Set<string>();
  const unknowns = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 128)) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const target = key.toLowerCase();
      if (typeof child === 'string') {
        if (/(?:factkey|resolvedfact|factid)/i.test(target)) factKeys.add(child);
        if (/(?:evidenceid|evidenceuri|sourceuri)/i.test(target)) evidenceIds.add(child);
        if (/(?:unknown|unresolved|remainingquestion)/i.test(target)) unknowns.add(child);
      } else if (/(?:facts|resolvedfacts|evidence|evidenceids|unknowns|unresolved|remainingquestions)/i.test(target)) {
        visit(child, depth + 1);
      } else {
        visit(child, depth + 1);
      }
    }
  };
  visit(typeof value === 'string' ? parseJson(value) ?? value : value, 0);
  return { factKeys, evidenceIds, unknowns };
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
