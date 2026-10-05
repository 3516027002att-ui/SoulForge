/** Bounded bridge-produced evidence projection. It never grants native authority from model text. */
import type { ContextEvidenceSource } from './types.js';
import { evidenceKey, evidenceResourceKey, type EvidenceClaim, type EvidenceRevision, type EvidenceVersion } from './evidenceSelection.js';
import { normalizeEvidenceVersion } from './evidenceIdentity.js';
import { expandEvidenceClaims } from './evidenceTransport.js';

function evidenceCandidatesFromToolContent(content: string): EvidenceClaim[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const evidence = (parsed as Record<string, unknown>).evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
    const claims = expandEvidenceClaims(evidence);
    const output: EvidenceClaim[] = [];
    for (const value of claims) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      const identity = candidate.identity;
      const version = candidate.version;
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)
        || typeof candidate.handle !== 'string'
        || typeof candidate.text !== 'string'
        || (version !== undefined
          && version !== null
          && typeof version !== 'string'
          && typeof version !== 'number'
          && (typeof version !== 'object' || Array.isArray(version)))) continue;
      const claim = candidate as unknown as EvidenceClaim;
      try {
        // Requiredness is host-plan state, so model/tool payloads cannot seed it.
        const normalizedVersion = normalizeEvidenceVersion(
          (version ?? {}) as EvidenceVersion | EvidenceRevision
        );
        output.push({
          ...claim,
          key: evidenceKey(claim.identity),
          resourceKey: evidenceResourceKey(claim.identity),
          version: normalizedVersion,
          required: false
        });
      } catch {
        // Invalid or incomplete claims remain in the raw transcript but do not
        // enter the structured evidence queue.
      }
    }
    return output;
  } catch {
    return [];
  }
}

export function makeToolEvidenceSource(
  toolName: string,
  content: string,
  meta?: Record<string, unknown>,
  allowStructuredClaims = false
): ContextEvidenceSource {
  const claims = allowStructuredClaims ? evidenceCandidatesFromToolContent(content) : [];
  return {
    kind: 'toolResult',
    uri: toolName,
    text: content,
    ...(meta ? { meta } : {}),
    ...(claims.length > 0 ? { evidenceCandidates: claims } : {})
  };
}

export function envelopeKnowledgeRefreshStatus(content: string): string | undefined {
  try {
    const root = JSON.parse(content) as Record<string, unknown>;
    const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? root.data as Record<string, unknown>
      : undefined;
    const record = data?.record && typeof data.record === 'object' && !Array.isArray(data.record)
      ? data.record as Record<string, unknown>
      : undefined;
    const candidates: unknown[] = [
      record?.lifecycle,
      record?.knowledgeRefresh,
      data?.lifecycle,
      data?.knowledgeRefresh,
      root.lifecycle,
      root.knowledgeRefresh
    ];
    const readStatus = (candidate: unknown, depth = 0): string | undefined => {
      if (depth > 3 || candidate === null || candidate === undefined) return undefined;
      if (typeof candidate === 'string') {
        const status = candidate.trim();
        return status.length > 0 ? status : undefined;
      }
      if (typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
      const value = candidate as Record<string, unknown>;
      const nested = readStatus(value.knowledgeRefresh, depth + 1);
      if (nested !== undefined) return nested;
      return readStatus(value.status, depth + 1);
    };
    for (const candidate of candidates) {
      const status = readStatus(candidate);
      if (status !== undefined) return status;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function isHealthyKnowledgeRefreshStatus(status: string): boolean {
  return status === 'completed' || status === 'converged' || status === 'preserved' || status === 'not_requested';
}
