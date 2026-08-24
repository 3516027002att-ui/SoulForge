import { createTaskModel, isExactTarget } from './taskModel.js';
import type { QueryPlan, QueryPlanResult } from './types.js';

export type ResolverWorkflowPhase =
  | 'UNRESOLVED'
  | 'EXACT_ADDRESS'
  | 'DISCOVERY_ATTEMPTED'
  | 'CANDIDATES_AVAILABLE'
  | 'COVERAGE_INCOMPLETE';

export interface CachedDiscoveryResult {
  ok: boolean;
  content: string;
  code?: string;
}

export class ResolverWorkflowState {
  private phase: ResolverWorkflowPhase;
  private readonly initialPhase: ResolverWorkflowPhase;
  private lastCoverage: string | undefined;
  private readonly cache = new Map<string, CachedDiscoveryResult>();
  private readonly attemptedQueries = new Set<string>();
  private readonly queryResults: QueryPlanResult[] = [];

  constructor(externalTaskGoal?: string) {
    const task = createTaskModel(externalTaskGoal ?? '');
    this.phase = task.targets.some(isExactTarget) ? 'EXACT_ADDRESS' : 'UNRESOLVED';
    this.initialPhase = this.phase;
  }

  observeDiscovery(content: string, ok: boolean): void {
    this.phase = 'DISCOVERY_ATTEMPTED';
    const parsed = parseJsonRecord(content);
    const coverage = readString(parsed?.coverage && typeof parsed.coverage === 'object'
      ? (parsed.coverage as Record<string, unknown>).status
      : parsed?.status);
    if (coverage) this.lastCoverage = coverage;
    const itemCount = readItemCount(parsed);
    if (ok && itemCount > 0) this.phase = 'CANDIDATES_AVAILABLE';
    else if (coverage && coverage !== 'FOUND' && coverage !== 'NOT_FOUND_WITH_COMPLETE_COVERAGE') this.phase = 'COVERAGE_INCOMPLETE';
  }

  rememberDiscovery(
    tool: string,
    input: unknown,
    result: CachedDiscoveryResult
  ): void {
    const query = stableQuery(input);
    const key = `${tool}:${query}`;
    this.cache.set(key, result);
    this.attemptedQueries.add(key);
    const beforeCoverage = this.lastCoverage;
    this.observeDiscovery(result.content, result.ok);
    const parsed = parseJsonRecord(result.content);
    const coverage = readString(parsed?.coverage && typeof parsed.coverage === 'object'
      ? (parsed.coverage as Record<string, unknown>).status
      : parsed?.status);
    const count = readItemCount(parsed);
    this.queryResults.push({
      tool,
      query,
      resultFingerprint: fingerprint(result.content),
      ok: result.ok,
      informationGain: {
        newResolvedFacts: result.ok ? count : 0,
        eliminatedCandidates: 0,
        coverageChanged: beforeCoverage !== coverage,
        unknownsReduced: result.ok && count > 0 ? 1 : 0,
        newAuthoritativeEvidence: result.ok ? count : 0,
        stateChanged: beforeCoverage !== coverage || count > 0
      }
    });
  }

  getCachedDiscovery(tool: string, input: unknown): CachedDiscoveryResult | undefined {
    return this.cache.get(`${tool}:${stableQuery(input)}`);
  }

  invalidateDiscoveryCache(): void {
    this.cache.clear();
    this.attemptedQueries.clear();
    this.queryResults.length = 0;
    this.lastCoverage = undefined;
    this.phase = this.initialPhase;
  }

  canProceedToStructuredDiscovery(): boolean {
    return this.phase === 'EXACT_ADDRESS'
      || this.phase === 'DISCOVERY_ATTEMPTED'
      || this.phase === 'CANDIDATES_AVAILABLE'
      || this.phase === 'COVERAGE_INCOMPLETE';
  }

  snapshot(): { phase: ResolverWorkflowPhase; coverage?: string; queryPlan: QueryPlan } {
    const subgoalId = 'root';
    return {
      phase: this.phase,
      ...(this.lastCoverage ? { coverage: this.lastCoverage } : {}),
      queryPlan: {
        planId: 'resolver:root',
        subgoalId,
        purpose: 'resolve canonical entities with authoritative evidence',
        candidateTools: ['retrieve_evidence', 'search_text_entries', 'resolve_canonical_entities'],
        attemptedQueries: [...this.attemptedQueries],
        results: [...this.queryResults],
        unresolvedQuestions: this.phase === 'CANDIDATES_AVAILABLE' ? [] : ['canonical target / authoritative mapping']
      }
    };
  }
}

function parseJsonRecord(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readItemCount(value: Record<string, unknown> | null): number {
  if (!value) return 0;
  const items = value.items
    ?? value.hits
    ?? value.matches
    ?? value.candidates
    ?? value.nodes
    ?? value.facts;
  if (Array.isArray(items)) return items.length;
  if (value.status === 'RESOLVED') return 1;
  return typeof value.totalHits === 'number' && Number.isFinite(value.totalHits) ? value.totalHits : 0;
}

function stableQuery(value: unknown): string {
  return stableJson(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
