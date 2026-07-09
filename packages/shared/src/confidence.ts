/**
 * Multi-evidence confidence model (architecture fork #106).
 */

import type { ProvenanceSourceKind } from './provenance.js';
import type { ReferenceConfidence } from './types.js';

/** Numeric score in [0, 1]. */
export type ConfidenceScore = number;

export type ConfidenceLevel = 'none' | 'low' | 'medium' | 'high' | 'confirmed';

export type ConfidenceReasonCode =
  | 'parser_confirmed'
  | 'schema_confirmed'
  | 'profile_match'
  | 'user_confirmed'
  | 'validator_passed'
  | 'synthetic_fixture'
  | 'heuristic'
  | 'numeric_match'
  | 'insufficient_evidence'
  | 'conflicting_evidence'
  | 'unsupported_format';

export interface ConfidenceReason {
  code: ConfidenceReasonCode;
  message: string;
  weight?: number;
  sourceKind?: ProvenanceSourceKind;
}

export interface ConfidenceAssessment {
  score: ConfidenceScore;
  level: ConfidenceLevel;
  reasons: ConfidenceReason[];
  /** When fused from multiple sources. */
  fusedFrom?: ConfidenceAssessment[];
}

/**
 * Map legacy reference confidence to the richer model.
 */
export function referenceConfidenceToLevel(value: ReferenceConfidence): ConfidenceLevel {
  if (value === 'high') return 'high';
  if (value === 'medium') return 'medium';
  return 'low';
}

export function levelToScore(level: ConfidenceLevel): ConfidenceScore {
  switch (level) {
    case 'none':
      return 0;
    case 'low':
      return 0.25;
    case 'medium':
      return 0.55;
    case 'high':
      return 0.8;
    case 'confirmed':
      return 0.95;
    default:
      return 0;
  }
}

export function scoreToLevel(score: ConfidenceScore): ConfidenceLevel {
  if (score >= 0.9) return 'confirmed';
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

export function createConfidence(
  level: ConfidenceLevel,
  reasons: ConfidenceReason[],
  score?: ConfidenceScore
): ConfidenceAssessment {
  return {
    score: score ?? levelToScore(level),
    level,
    reasons
  };
}

/**
 * Simple weighted fusion — scaffold, not a full Bayesian model.
 * Synthetic fixture evidence is capped at medium unless user/validator upgrades it.
 */
export function fuseConfidence(parts: ConfidenceAssessment[]): ConfidenceAssessment {
  if (parts.length === 0) {
    return createConfidence('none', [{
      code: 'insufficient_evidence',
      message: 'No confidence evidence provided.'
    }]);
  }

  let weighted = 0;
  let totalWeight = 0;
  let hasSyntheticOnly = true;

  for (const part of parts) {
    const weight = part.reasons.reduce((sum, reason) => sum + (reason.weight ?? 1), 0) || 1;
    weighted += part.score * weight;
    totalWeight += weight;
    if (!part.reasons.some((reason) => reason.code === 'synthetic_fixture')) {
      hasSyntheticOnly = false;
    }
  }

  let score = totalWeight > 0 ? weighted / totalWeight : 0;
  if (hasSyntheticOnly) {
    score = Math.min(score, levelToScore('medium'));
  }

  return {
    score,
    level: scoreToLevel(score),
    reasons: parts.flatMap((part) => part.reasons),
    fusedFrom: parts
  };
}

export function syntheticFixtureConfidence(message?: string): ConfidenceAssessment {
  return createConfidence('medium', [{
    code: 'synthetic_fixture',
    message: message ?? 'Evidence originates from a synthetic fixture (not native authority).',
    weight: 1,
    sourceKind: 'synthetic_fixture'
  }]);
}
