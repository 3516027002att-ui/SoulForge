/**
 * EMEDF schema coverage analysis over a real (or synthetic) instruction
 * distribution emitted by the Bridge `read-emevd-document` envelope.
 *
 * The distribution is aggregate-only (bank/id -> count and args-length
 * histogram), so this analysis never sees instruction payload content.
 * Coverage claims are length-consistency checked: an instruction kind only
 * counts as cleanly covered when the schema-claimed encoded length matches
 * every observed args length in the corpus.
 */

import {
  encodedEmedfArgsLength,
  findInstructionDef,
  hasVararg,
  varargCount,
  type EmedfRegistry,
  type EmedfInstructionDef
} from './emedfSchema.js';

export interface EmevdInstructionDistributionEntry {
  bank: number;
  id: number;
  count: number;
  /** args length (bytes) -> observed frequency. Keys are decimal strings from JSON. */
  argsLengths: Record<string, number>;
}

export interface EmevdCoverageAnalysis {
  totalKinds: number;
  coveredKinds: number;
  /** Kinds whose observed lengths all match the schema-claimed encoded length. */
  cleanKinds: number;
  /** Vararg kinds whose observed lengths are all valid vararg multiples. */
  varargKinds: number;
  coveredInstances: number;
  totalInstances: number;
  /** Instances whose observed length matches the schema-claimed length (or is a valid vararg multiple). */
  cleanInstances: number;
  /** Instances whose observed length does not match the schema-claimed length. */
  mismatchInstances: number;
  /** Instances of kinds with no schema definition. */
  unknownInstances: number;
  kindCoverageRatio: number;
  instanceCoverageRatio: number;
  lengthMismatches: Array<{
    bank: number;
    id: number;
    count: number;
    schemaLength: number;
    observedLengths: number[];
    /** True when the definition has a vararg tail but some observed lengths are invalid. */
    vararg: boolean;
  }>;
  unknownKinds: Array<{ bank: number; id: number; count: number }>;
  registryOrigin: EmedfRegistry['origin'];
  truncated: boolean;
}

const UNKNOWN_KIND_LIMIT = 500;

/**
 * Analyze a distribution against a registry. Never throws on odd corpus data —
 * it reports structural facts (unknown kinds, length mismatches) instead.
 */
export function analyzeEmedfCoverage(
  registry: EmedfRegistry,
  distribution: EmevdInstructionDistributionEntry[],
  truncated = false
): EmevdCoverageAnalysis {
  let coveredInstances = 0;
  let totalInstances = 0;
  let coveredKinds = 0;
  let cleanKinds = 0;
  let varargKinds = 0;
  let cleanInstances = 0;
  let mismatchInstances = 0;
  let unknownInstances = 0;
  const lengthMismatches: EmevdCoverageAnalysis['lengthMismatches'] = [];
  const unknownKinds: EmevdCoverageAnalysis['unknownKinds'] = [];

  for (const entry of distribution) {
    const def = findInstructionDef(registry, entry.bank, entry.id);
    const observedLengths = Object.keys(entry.argsLengths)
      .map(Number)
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b);
    totalInstances += entry.count;
    if (!def) {
      unknownKinds.push({ bank: entry.bank, id: entry.id, count: entry.count });
      unknownInstances += entry.count;
      continue;
    }
    coveredKinds += 1;
    coveredInstances += entry.count;

    const isVararg = hasVararg(def);
    let kindClean: boolean;
    if (isVararg) {
      kindClean = observedLengths.length > 0
        && observedLengths.every((length) => varargCount(def, length) >= 0);
      if (kindClean) varargKinds += 1;
    } else {
      const schemaLength = encodedEmedfArgsLength(def);
      kindClean = observedLengths.length > 0
        && observedLengths.every((length) => length === schemaLength);
    }

    if (kindClean) {
      cleanKinds += 1;
      cleanInstances += entry.count;
    } else {
      // Kind is not clean: split instances by length signature so a kind with a
      // mix of matching and mismatching lengths reports both buckets exactly.
      for (const [lengthText, frequency] of Object.entries(entry.argsLengths)) {
        const length = Number(lengthText);
        const matches = isVararg
          ? varargCount(def, length) >= 0
          : length === encodedEmedfArgsLength(def);
        if (matches) cleanInstances += frequency;
        else mismatchInstances += frequency;
      }
      lengthMismatches.push({
        bank: entry.bank,
        id: entry.id,
        count: entry.count,
        schemaLength: encodedEmedfArgsLength(def),
        observedLengths,
        vararg: isVararg
      });
    }
  }

  return {
    totalKinds: distribution.length,
    coveredKinds,
    cleanKinds,
    varargKinds,
    coveredInstances,
    totalInstances,
    cleanInstances,
    mismatchInstances,
    unknownInstances,
    kindCoverageRatio: distribution.length === 0 ? 0 : coveredKinds / distribution.length,
    instanceCoverageRatio: totalInstances === 0 ? 0 : coveredInstances / totalInstances,
    lengthMismatches,
    unknownKinds: unknownKinds.slice(0, UNKNOWN_KIND_LIMIT),
    registryOrigin: registry.origin,
    truncated
  };
}

/* ------------------------------------------------------------------ */
/*  Cross-corpus distribution comparison                               */
/* ------------------------------------------------------------------ */

export interface CorpusDistributionInput {
  label: string;
  distribution: EmevdInstructionDistributionEntry[];
}

export interface CorpusFamilyPresence {
  bank: number;
  id: number;
  /** Total instances across all corpora. */
  totalCount: number;
  /** Per-corpus instance counts (label -> count). */
  counts: Record<string, number>;
  /** Corpora (labels) where this family appears. */
  presentIn: string[];
  /** Corpora (labels) where this family is absent. */
  absentIn: string[];
}

export interface CorpusFamilyDifferenceSummary {
  corpusLabels: string[];
  unionFamilyCount: number;
  /** Instruction families present in every corpus. */
  familiesInAllCorpora: CorpusFamilyPresence[];
  /** Instruction families present in a strict subset (>=1 but not all corpora). */
  familiesInSubset: CorpusFamilyPresence[];
  /** Per-corpus kind/instance totals. */
  perCorpus: Array<{ label: string; kinds: number; instances: number }>;
}

/**
 * Compare instruction distributions across multiple corpora and report which
 * instruction families appear only in a subset of them (cross-corpus
 * distribution differences). Pure aggregate analysis: never touches payload
 * content. Deterministic: sorted by bank:id, then totalCount desc.
 */
export function summarizeCorpusFamilyDifferences(
  corpora: CorpusDistributionInput[]
): CorpusFamilyDifferenceSummary {
  const presence = new Map<string, CorpusFamilyPresence>();
  const perCorpus = corpora.map((corpus) => ({
    label: corpus.label,
    kinds: corpus.distribution.length,
    instances: corpus.distribution.reduce((sum, entry) => sum + entry.count, 0)
  }));
  for (const corpus of corpora) {
    for (const entry of corpus.distribution) {
      const key = `${entry.bank}:${entry.id}`;
      const existing = presence.get(key);
      if (existing) {
        existing.counts[corpus.label] = entry.count;
        existing.presentIn.push(corpus.label);
        existing.totalCount += entry.count;
      } else {
        presence.set(key, {
          bank: entry.bank,
          id: entry.id,
          totalCount: entry.count,
          counts: { [corpus.label]: entry.count },
          presentIn: [corpus.label],
          absentIn: []
        });
      }
    }
  }
  for (const family of presence.values()) {
    family.absentIn = corpora
      .filter((corpus) => !family.presentIn.includes(corpus.label))
      .map((corpus) => corpus.label);
  }
  const byKey = [...presence.values()].sort((a, b) => a.bank - b.bank || a.id - b.id);
  const familiesInAllCorpora = byKey
    .filter((family) => family.presentIn.length === corpora.length)
    .sort((a, b) => b.totalCount - a.totalCount);
  const familiesInSubset = byKey
    .filter((family) => family.presentIn.length > 0 && family.presentIn.length < corpora.length)
    .sort((a, b) => b.totalCount - a.totalCount);
  return {
    corpusLabels: corpora.map((corpus) => corpus.label),
    unionFamilyCount: presence.size,
    familiesInAllCorpora,
    familiesInSubset,
    perCorpus
  };
}

/**
 * Length consistency of a single schema definition against every distribution
 * entry with that bank/id. Returns the schema-claimed length and the observed
 * lengths, or null when the definition never appears.
 */
export function schemaLengthVsObserved(
  def: EmedfInstructionDef,
  distribution: EmevdInstructionDistributionEntry[]
): { schemaLength: number; observedLengths: number[] } | null {
  const entry = distribution.find((item) => item.bank === def.bank && item.id === def.id);
  if (!entry) return null;
  return {
    schemaLength: encodedEmedfArgsLength(def),
    observedLengths: Object.keys(entry.argsLengths).map(Number).sort((a, b) => a - b)
  };
}
