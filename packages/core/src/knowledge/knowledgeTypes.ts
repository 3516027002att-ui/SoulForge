export type KnowledgeClaimKind = 'observed_native' | 'derived_relation' | 'external_documentation' | 'tested_procedure' | 'hypothesis';
export type KnowledgePublicationState = 'draft' | 'accepted' | 'stale' | 'contradicted' | 'superseded' | 'quarantined';
export type KnowledgeEvidenceStrength = 'native_read' | 'independent_oracle' | 'executed_test' | 'external_summary' | 'hypothesis';

export interface KnowledgeScope {
  gameProfile: string;
  version: string;
  visibility: 'global' | 'project';
  workspaceId?: string;
  namespace?: string;
}

export interface KnowledgeSourceRef {
  sourceId: string;
  storedContentHash: string;
  excerpt?: string;
  nativeFieldHandle?: string;
  observedVersion: string;
  readerSchemaHash: string;
  licence?: string;
  accessScope: 'local' | 'project' | 'public';
}

export interface KnowledgeClaim {
  claimId: string;
  semanticKey: string;
  pageId: string;
  subjectKey: string;
  predicateKey: string;
  value?: unknown;
  text?: string;
  scope: KnowledgeScope;
  kind: KnowledgeClaimKind;
  publicationState: KnowledgePublicationState;
  evidenceStrength: KnowledgeEvidenceStrength;
  sourceRefs: KnowledgeSourceRef[];
  dependencies: string[];
  readerSchemaHash: string;
  createdFrom: string;
  contentHash: string;
  staleReason?: string;
}

export interface KnowledgePage {
  pageId: string;
  path: string;
  body: string;
  contentHash: string;
  revision: number;
  scope: KnowledgeScope;
  claims: string[];
}

export interface KnowledgeGeneration {
  generationId: string;
  parentGeneration: string | null;
  schemaVersion: string;
  pages: Record<string, KnowledgePage>;
  claims: Record<string, KnowledgeClaim>;
  sourceRevisions: Record<string, string>;
  createdAt: string;
}

export interface KnowledgePatchPage {
  pageId: string;
  path: string;
  body: string;
  expectedRevision: number | null;
  scope: KnowledgeScope;
  claims?: KnowledgeClaim[];
}

export interface KnowledgePatch {
  expectedGeneration: string;
  sourceRevisions: KnowledgeSourceRef[];
  pages: KnowledgePatchPage[];
  claims?: KnowledgeClaim[];
  prompt?: string;
}

export interface KnowledgeLintFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  claimId?: string;
  pageId?: string;
}

export interface KnowledgeQueryOptions {
  workspaceId: string;
  gameProfile?: string;
  namespace?: string;
  includeHistorical?: boolean;
  kinds?: readonly KnowledgeClaimKind[];
  limit?: number;
}
