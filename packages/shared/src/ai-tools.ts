/**
 * AI tool permission model (architecture forks #126–#129).
 * Tools never write files directly; commit/rollback go through policy + transaction.
 */

import type { StructuredDiagnostic } from './diagnostics.js';
import type { ConfidenceAssessment } from './confidence.js';
import type { ProvenanceChain } from './provenance.js';
import type { AiToolPermissionLevel, ConfirmationReceipt, PatchMode } from './types.js';

export type { ConfirmationReceipt };

export type ToolPermission = AiToolPermissionLevel;

export type PolicyDecisionKind = 'allow' | 'deny' | 'require_confirmation';

export interface ToolInputSchema {
  schemaId: string;
  schemaVersion: string;
  description?: string;
  /** JSON-schema-like freeform description for scaffold. */
  shape: Record<string, unknown>;
}

export interface ToolResultSchema {
  schemaId: string;
  schemaVersion: string;
  description?: string;
  shape: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  permission: ToolPermission;
  inputSchema: ToolInputSchema;
  resultSchema: ToolResultSchema;
}

export interface PolicyGateContext {
  mode: PatchMode | 'plan' | 'normal' | 'fullPermission';
  maxPermission: ToolPermission;
  toolName: string;
  requiredPermission: ToolPermission;
  confirmationReceiptIds?: string[];
  actorId?: string;
}

export interface PolicyDecision {
  kind: PolicyDecisionKind;
  reason: string;
  code: string;
  requiredPermission: ToolPermission;
  grantedPermission: ToolPermission;
  confirmationRequired?: boolean;
}

export interface ToolCallAudit {
  toolCallId: string;
  toolName: string;
  permission: ToolPermission;
  decision: PolicyDecision;
  startedAt: string;
  finishedAt?: string;
  ok?: boolean;
  diagnostics: StructuredDiagnostic[];
}

export interface EvidenceRef {
  uri: string;
  kind?: string;
  excerpt?: string;
  confidence?: ConfidenceAssessment;
  provenance?: ProvenanceChain;
}

export interface EvidencePack {
  packId: string;
  workspaceId: string;
  createdAt: string;
  resources: EvidenceRef[];
  diagnostics: StructuredDiagnostic[];
  notes?: string[];
}

export interface AgentStep {
  stepId: string;
  title: string;
  toolName?: string;
  requiredPermission: ToolPermission;
  preconditions: string[];
  expectedEvidence: string[];
  onFailure: 'abort' | 'retry' | 'ask_user' | 'continue';
  confirmationRequired: boolean;
}

export interface AgentPlan {
  planId: string;
  title: string;
  goal: string;
  steps: AgentStep[];
  createdAt: string;
  mode: PatchMode | 'plan' | 'normal' | 'fullPermission';
}

export interface TypedToolResult<T = unknown> {
  ok: boolean;
  toolName: string;
  toolCallId: string;
  data?: T;
  /** Natural language summary is optional and never the only result. */
  summary?: string;
  diagnostics: StructuredDiagnostic[];
  evidenceRefs: EvidenceRef[];
  confidence?: ConfidenceAssessment;
  provenance?: ProvenanceChain[];
  policyDecision: PolicyDecision;
  audit: ToolCallAudit;
}

export const AI_TOOL_PERMISSION_LEVELS: readonly ToolPermission[] = [
  'read',
  'analyze',
  'propose',
  'stage',
  'validate',
  'commit',
  'rollback'
] as const;
