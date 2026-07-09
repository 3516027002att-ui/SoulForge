/**
 * Provenance chain model (architecture fork #105).
 * Every field, reference, diagnostic, and patch should be able to attach provenance.
 *
 * Synthetic fixtures must never claim native format authority.
 */

import type { ContentHash } from './resource-uri.js';

export type ProvenanceSourceKind =
  | 'evidence'
  | 'parser'
  | 'synthetic_fixture'
  | 'user_confirmation'
  | 'validator'
  | 'tool_call'
  | 'index'
  | 'user_edit'
  | 'system';

export interface ProvenanceSource {
  kind: ProvenanceSourceKind;
  /** Stable id of the producer (parser name, tool name, fixture id, etc.). */
  id: string;
  label?: string;
  /** When this provenance was recorded (ISO-8601). */
  recordedAt?: string;
  /** Optional content hash of the source blob. */
  contentHash?: ContentHash;
  /**
   * True only when a real native format parser produced this claim.
   * Synthetic fixtures and heuristics must set this to false.
   */
  nativeFormatAuthority: boolean;
  /** True when this came from a synthetic test fixture. */
  syntheticFixture: boolean;
  details?: Record<string, unknown>;
}

export interface ProvenanceLink {
  fromSourceId: string;
  toSourceId: string;
  relation: 'derived_from' | 'confirmed_by' | 'validated_by' | 'contradicted_by' | 'superseded_by';
}

/**
 * Ordered provenance chain. First entry is typically the origin.
 */
export interface ProvenanceChain {
  sources: ProvenanceSource[];
  links?: ProvenanceLink[];
}

export interface ProvenanceAttachment {
  targetUri: string;
  chain: ProvenanceChain;
}

export function createProvenanceSource(
  partial: Omit<ProvenanceSource, 'nativeFormatAuthority' | 'syntheticFixture'> & {
    nativeFormatAuthority?: boolean;
    syntheticFixture?: boolean;
  }
): ProvenanceSource {
  const syntheticFixture = partial.syntheticFixture ?? partial.kind === 'synthetic_fixture';
  const nativeFormatAuthority = syntheticFixture
    ? false
    : (partial.nativeFormatAuthority ?? false);

  const source: ProvenanceSource = {
    kind: partial.kind,
    id: partial.id,
    nativeFormatAuthority,
    syntheticFixture
  };
  if (partial.label !== undefined) source.label = partial.label;
  if (partial.recordedAt !== undefined) source.recordedAt = partial.recordedAt;
  if (partial.contentHash !== undefined) source.contentHash = partial.contentHash;
  if (partial.details !== undefined) source.details = partial.details;
  return source;
}

export function createSyntheticFixtureProvenance(fixtureId: string, label?: string): ProvenanceSource {
  return createProvenanceSource({
    kind: 'synthetic_fixture',
    id: fixtureId,
    label: label ?? `Synthetic fixture ${fixtureId}`,
    recordedAt: new Date().toISOString(),
    syntheticFixture: true,
    nativeFormatAuthority: false
  });
}

export function createParserProvenance(parserId: string, options?: {
  nativeFormatAuthority?: boolean;
  syntheticFixture?: boolean;
  label?: string;
  details?: Record<string, unknown>;
}): ProvenanceSource {
  return createProvenanceSource({
    kind: 'parser',
    id: parserId,
    label: options?.label ?? parserId,
    recordedAt: new Date().toISOString(),
    nativeFormatAuthority: options?.nativeFormatAuthority ?? false,
    syntheticFixture: options?.syntheticFixture ?? false,
    ...(options?.details ? { details: options.details } : {})
  });
}

export function assertNoSyntheticNativeAuthority(source: ProvenanceSource): void {
  if (source.syntheticFixture && source.nativeFormatAuthority) {
    throw new Error(
      `Provenance source ${source.id} marks syntheticFixture=true with nativeFormatAuthority=true, which is forbidden.`
    );
  }
}

export function provenanceClaimsNativeAuthority(chain: ProvenanceChain): boolean {
  return chain.sources.some((source) => source.nativeFormatAuthority && !source.syntheticFixture);
}
