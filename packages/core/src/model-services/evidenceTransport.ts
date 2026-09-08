import { evidenceKey, evidenceResourceKey, type EvidenceClaim, type EvidenceIdentity } from './evidenceIdentity.js';

/** Lossless envelope-local defaults; omitted keys are derivable, never truncated. */
export type TransportClaim = Omit<Partial<EvidenceClaim>, 'identity'> & { identity?: Partial<EvidenceIdentity> };
export interface EvidenceClaimsTransport {
  claims?: TransportClaim[];
  claimDefaults?: TransportClaim;
}

export function encodeEvidenceClaims(claims: EvidenceClaim[]): EvidenceClaimsTransport {
  if (!claims.length) return {};
  const rows: TransportClaim[] = claims.map(({ key: _key, resourceKey: _resourceKey, handle, ...claim }) => ({
    ...claim,
    identity: { ...claim.identity },
    ...(handle === `${claim.identity.canonicalOuterId}#${claim.identity.objectHandle}` ? {} : { handle })
  }));
  const defaults: Record<string, unknown> = {};
  const identityDefaults: Record<string, unknown> = {};
  if (rows.length > 1) {
    for (const key of Object.keys(rows[0]!.identity!)) {
      const first = (rows[0]!.identity as Record<string, unknown>)[key];
      if (rows.every(row => JSON.stringify((row.identity as Record<string, unknown>)[key]) === JSON.stringify(first))) {
        identityDefaults[key] = first;
        for (const row of rows) delete (row.identity as Record<string, unknown>)[key];
      }
    }
    for (const key of Object.keys(rows[0]!)) {
      if (key === 'identity') continue;
      const first = (rows[0] as Record<string, unknown>)[key];
      if (rows.every(row => JSON.stringify((row as Record<string, unknown>)[key]) === JSON.stringify(first))) {
        defaults[key] = first;
        for (const row of rows) delete (row as Record<string, unknown>)[key];
      }
    }
  }
  if (Object.keys(identityDefaults).length) defaults.identity = identityDefaults;
  return { claims: rows, ...(Object.keys(defaults).length ? { claimDefaults: defaults as TransportClaim } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Also accepts historical full claims. Validation/requiredness stays with the host. */
export function expandEvidenceClaims(evidence: unknown): unknown[] {
  const envelope = record(evidence);
  if (!Array.isArray(envelope.claims)) return [];
  const defaults = record(envelope.claimDefaults);
  return envelope.claims.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const row = record(value);
    const identity = { ...record(defaults.identity), ...record(row.identity) } as unknown as EvidenceIdentity;
    const expanded: Record<string, unknown> = { ...defaults, ...row, identity };
    try {
      return {
        ...expanded,
        key: evidenceKey(identity),
        resourceKey: evidenceResourceKey(identity),
        handle: expanded.handle ?? `${identity.canonicalOuterId}#${identity.objectHandle}`
      };
    } catch {
      return null;
    }
  });
}
