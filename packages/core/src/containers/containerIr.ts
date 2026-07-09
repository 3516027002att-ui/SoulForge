/**
 * Unified container IR for DCX / BND3 / BND4 / nested trees.
 * Honesty: authority tiers are explicit; no fake native writers.
 */

import type { StructuredDiagnostic } from '@soulforge/shared';

export type ContainerFormat = 'dcx' | 'bnd3' | 'bnd4' | 'raw' | 'unknown';

export type ContainerAuthority =
  | 'none'
  | 'candidate'
  | 'partial'
  | 'fixture-confirmed'
  | 'authoritative';

export type CompressionKind = 'DFLT' | 'KRAK' | 'EDGE' | 'ZSTD' | 'unknown' | 'none';

export interface ContainerChild {
  childId: string;
  name?: string;
  pathHint?: string;
  offset: number;
  size: number;
  compressedSize?: number;
  hash: string;
  formatKind: string;
  sourceContainerUri: string;
  childUri: string;
  rawBytesAvailable: boolean;
  canReplace: boolean;
  diagnostics: StructuredDiagnostic[];
  /** Nested container format if this child itself is a container. */
  nestedFormat?: ContainerFormat;
}

export interface ContainerNode {
  uri: string;
  format: ContainerFormat;
  authority: ContainerAuthority;
  magic: string;
  size: number;
  hash: string;
  children: ContainerChild[];
  /** Nested payload node when format is DCX wrapping another container. */
  payload?: ContainerNode;
  metadata: Record<string, unknown>;
  diagnostics: StructuredDiagnostic[];
  containerRoundTripSafe: boolean;
  decompressionStatus: 'none' | 'supported' | 'unsupported' | 'failed';
  compressionStatus: 'none' | 'supported' | 'unsupported' | 'failed';
  canListChildren: boolean;
  canReadChild: boolean;
  canReplaceChild: boolean;
  canRepackContainer: boolean;
}

export interface ContainerTree {
  rootUri: string;
  rootPath: string;
  rootHash: string;
  root: ContainerNode;
  /** Flat list of all descendant children with stable childUri. */
  flatChildren: ContainerChild[];
  diagnostics: StructuredDiagnostic[];
}

export interface ContainerReadResult {
  ok: boolean;
  tree?: ContainerTree;
  diagnostics: StructuredDiagnostic[];
}

export interface ContainerWritePlan {
  containerUri: string;
  childUri: string;
  expectedContainerHash: string;
  expectedChildHash: string;
  newChildHash: string;
  format: ContainerFormat;
  nestedPath: string[];
  riskLevel: 'high' | 'blocked';
  requiresConfirmation: true;
  notes: string[];
}

export interface ContainerRoundTripReport {
  ok: boolean;
  byteIdentical: boolean;
  payloadEquivalent: boolean;
  originalHash: string;
  rebuiltHash: string;
  originalPayloadHash?: string;
  rebuiltPayloadHash?: string;
  childHashMatches: boolean;
  diagnostics: StructuredDiagnostic[];
  details?: Record<string, unknown>;
}

export interface ChildBytesResult {
  ok: boolean;
  childUri: string;
  bytes?: Buffer;
  hash?: string;
  diagnostics: StructuredDiagnostic[];
}

export interface ReplaceChildResult {
  ok: boolean;
  containerBytes?: Buffer;
  containerHash?: string;
  newChildHash?: string;
  report?: ContainerRoundTripReport;
  diagnostics: StructuredDiagnostic[];
}
