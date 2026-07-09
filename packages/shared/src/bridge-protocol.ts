/**
 * Bridge protocol scaffold (architecture forks #119–#122).
 * Protocol/schema only — no native parser/writer implementation.
 */

import type { ConfidenceAssessment } from './confidence.js';
import type { StructuredDiagnostic } from './diagnostics.js';
import type { ProvenanceSource } from './provenance.js';
import type { ResourceKind } from './types.js';

export const BRIDGE_SCHEMA_VERSION = '0.5.0-scaffold';
export const BRIDGE_PROTOCOL_VERSION = '0.5.0';

export type BridgeFailureKind =
  | 'unsupported'
  | 'failed'
  | 'partial'
  | 'timeout'
  | 'cancelled'
  | 'unsafe'
  | 'schemaMismatch';

export type BridgeCommandName =
  | 'inspect'
  | 'export-event'
  | 'export-map'
  | 'export-param'
  | 'export-msg'
  | 'validate'
  | 'capabilities'
  | 'health';

export interface BridgeCommandInputMeta {
  command: BridgeCommandName;
  schemaVersion: string;
  protocolVersion: string;
  filePath?: string;
  timeoutMs?: number;
  cancelToken?: string;
  options?: Record<string, unknown>;
}

export interface BridgeCommandOutputMeta {
  command: BridgeCommandName;
  schemaVersion: string;
  protocolVersion: string;
  durationMs?: number;
  partial: boolean;
}

export interface BridgeTypedFailure {
  kind: BridgeFailureKind;
  code: string;
  message: string;
  retryable: boolean;
  diagnostics: StructuredDiagnostic[];
  details?: Record<string, unknown>;
}

export interface BridgeProtocolEnvelope<T = unknown> {
  schemaVersion: string;
  protocolVersion: string;
  command: BridgeCommandName;
  ok: boolean;
  partial: boolean;
  data?: T;
  failure?: BridgeTypedFailure;
  diagnostics: StructuredDiagnostic[];
  /**
   * True only for real native format authority.
   * Synthetic fixtures must set this false.
   */
  nativeFormatAuthority: boolean;
  /** True when payload originates from synthetic fixtures. */
  syntheticFixture: boolean;
  confidence?: ConfidenceAssessment;
  provenance?: ProvenanceSource[];
  capabilityHints?: string[];
}

export interface BridgeCommandDescriptor {
  name: BridgeCommandName;
  description: string;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  supportsCancellation: boolean;
  supportsProgress: boolean;
  resourceKinds: ResourceKind[] | ['*'];
}

export interface BridgeCapabilityCell {
  resourceKind: ResourceKind | '*';
  command: BridgeCommandName;
  supported: boolean;
  nativeFormatAuthority: boolean;
  syntheticFixtureOnly: boolean;
  notes?: string;
}

export interface BridgeCapabilityMatrix {
  schemaVersion: string;
  protocolVersion: string;
  bridgeId: string;
  commands: BridgeCommandDescriptor[];
  cells: BridgeCapabilityCell[];
  generatedAt: string;
}

export function createBridgeEnvelope<T>(
  partial: Omit<BridgeProtocolEnvelope<T>, 'schemaVersion' | 'protocolVersion'> & {
    schemaVersion?: string;
    protocolVersion?: string;
  }
): BridgeProtocolEnvelope<T> {
  const envelope: BridgeProtocolEnvelope<T> = {
    schemaVersion: partial.schemaVersion ?? BRIDGE_SCHEMA_VERSION,
    protocolVersion: partial.protocolVersion ?? BRIDGE_PROTOCOL_VERSION,
    command: partial.command,
    ok: partial.ok,
    partial: partial.partial,
    diagnostics: partial.diagnostics,
    nativeFormatAuthority: partial.syntheticFixture ? false : partial.nativeFormatAuthority,
    syntheticFixture: partial.syntheticFixture
  };
  if (partial.data !== undefined) envelope.data = partial.data;
  if (partial.failure !== undefined) envelope.failure = partial.failure;
  if (partial.confidence !== undefined) envelope.confidence = partial.confidence;
  if (partial.provenance !== undefined) envelope.provenance = partial.provenance;
  if (partial.capabilityHints !== undefined) envelope.capabilityHints = partial.capabilityHints;
  return envelope;
}

export function createSyntheticBridgeFailure(
  code: string,
  message: string,
  kind: BridgeFailureKind = 'unsupported'
): BridgeTypedFailure {
  return {
    kind,
    code,
    message,
    retryable: false,
    diagnostics: [{
      severity: kind === 'partial' ? 'warning' : 'error',
      code,
      message,
      recordedAt: new Date().toISOString()
    }]
  };
}
