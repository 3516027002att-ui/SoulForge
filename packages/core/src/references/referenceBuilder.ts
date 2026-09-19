import type {
  Diagnostic,
  ReferenceEdge,
  SymbolBundle
} from '@soulforge/shared';
import { REFERENCE_PROVIDERS } from './referenceProviderRegistry.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';

export interface ReferenceBuildOptions {
  /**
   * Medium/low confidence numeric matching can create noisy edges.
   * Keep it enabled for exploration, but never label it high confidence.
   */
  enableNumericFallback?: boolean;
  /**
   * If a numeric value matches more targets than this, the builder suppresses low-confidence edges.
   */
  maxAmbiguousNumericMatches?: number;
  /**
   * Name-inference hypotheses are excluded from the graph unless this is true.
   * Even when included they stay low-confidence with an explicit rule name.
   */
  includeHypotheses?: boolean;
  /**
   * Trusted EMEDF registry. When supplied, unknown bank/id instructions are
   * surfaced as diagnostics instead of silently producing no reference.
   */
  registry?: EmedfRegistry;
}

export interface ReferenceBuildResult {
  edges: ReferenceEdge[];
  /**
   * Semantic gaps surfaced by the PARAM/EMEVD reference providers
   * (unresolved conditions, rejected Refs syntax, dangling targets, unknown
   * instructions, cross-file event id candidates). These must never collapse
   * into "no edges" — a missing relation is a finding.
   */
  diagnostics: Diagnostic[];
  stats: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers: number;
  };
}

const DEFAULT_MAX_AMBIGUOUS_NUMERIC_MATCHES = 12;

export function buildReferenceGraph(bundle: SymbolBundle, options: ReferenceBuildOptions = {}): ReferenceBuildResult {
  // All providers run through the registry so the graph and the query service
  // build edges from exactly one list (T08). The old inline loop that promoted
  // name inference straight to "high" is deleted (T05 step 12).
  const edges: ReferenceEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  let suppressedAmbiguousNumbers = 0;
  for (const provider of REFERENCE_PROVIDERS) {
    const shard = provider.build(bundle, {
      ...options,
      maxAmbiguousNumericMatches: options.maxAmbiguousNumericMatches ?? DEFAULT_MAX_AMBIGUOUS_NUMERIC_MATCHES
    });
    for (const edge of shard.edges) edges.push(edge);
    for (const diagnostic of shard.diagnostics) diagnostics.push(diagnostic);
    suppressedAmbiguousNumbers += shard.suppressedAmbiguousNumbers ?? 0;
  }

  const dedupedEdges = dedupeEdges(edges);
  return {
    edges: dedupedEdges,
    diagnostics,
    stats: {
      high: dedupedEdges.filter((edge) => edge.confidence === 'high').length,
      medium: dedupedEdges.filter((edge) => edge.confidence === 'medium').length,
      low: dedupedEdges.filter((edge) => edge.confidence === 'low').length,
      suppressedAmbiguousNumbers
    }
  };
}

function dedupeEdges(edges: ReferenceEdge[]): ReferenceEdge[] {
  const seen = new Set<string>();
  const output: ReferenceEdge[] = [];

  for (const edge of edges) {
    const evidenceKey = edge.evidence.map((item) => `${item.instructionUri ?? item.sourceUri}:${String(item.value ?? '')}`).join('|');
    const key = `${edge.fromUri}|${edge.toUri}|${edge.kind}|${edge.confidence}|${evidenceKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(edge);
  }

  return output;
}
