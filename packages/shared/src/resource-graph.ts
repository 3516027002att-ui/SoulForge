/**
 * Temporal property graph types (architecture fork #101).
 * In-memory scaffold; SQLite-ready shapes. Not a graph database.
 */

import type { ConfidenceAssessment } from './confidence.js';
import type { StructuredDiagnostic } from './diagnostics.js';
import type { ProvenanceChain } from './provenance.js';
import type { ContentHash, OverlayLayerId, ResourceURI } from './resource-uri.js';
import type { ReferenceEdge, ResourceKind } from './types.js';

export type GraphVersion = string;

export type ResourceNodeKind =
  | 'file'
  | 'container'
  | 'container_child'
  | 'resource'
  | 'symbol'
  | 'field'
  | 'synthetic'
  | 'generated'
  | 'unsupported';

export type ResourceEdgeKind =
  | 'contains'
  | 'references'
  | 'derived_from'
  | 'overlays'
  | 'affects'
  | 'depends_on'
  | 'validates'
  | 'rewrites'
  | 'same_as';

export interface ResourceProperty {
  key: string;
  value: unknown;
  confidence?: ConfidenceAssessment;
  provenance?: ProvenanceChain;
}

export interface ResourceNode {
  id: string;
  kind: ResourceNodeKind;
  uri: string;
  resourceUri?: ResourceURI;
  resourceKind?: ResourceKind;
  overlay?: OverlayLayerId;
  label: string;
  properties: ResourceProperty[];
  confidence?: ConfidenceAssessment;
  provenance?: ProvenanceChain;
  diagnostics?: StructuredDiagnostic[];
  contentHash?: ContentHash;
  version?: GraphVersion;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceEdge {
  id: string;
  kind: ResourceEdgeKind;
  fromId: string;
  toId: string;
  uri?: string;
  label?: string;
  properties: ResourceProperty[];
  confidence?: ConfidenceAssessment;
  provenance?: ProvenanceChain;
  diagnostics?: StructuredDiagnostic[];
  version?: GraphVersion;
  createdAt: string;
  updatedAt: string;
}

/** Legacy reference edge can project into the graph. */
export type GraphReferenceEdge = ReferenceEdge;

export interface ProvenanceAttachmentRef {
  targetId: string;
  targetKind: 'node' | 'edge' | 'property';
  chain: ProvenanceChain;
}

export interface DiagnosticAttachmentRef {
  targetId: string;
  targetKind: 'node' | 'edge' | 'property';
  diagnostics: StructuredDiagnostic[];
}

export type GraphMutationOp =
  | 'add_node'
  | 'update_node'
  | 'delete_node'
  | 'add_edge'
  | 'update_edge'
  | 'delete_edge'
  | 'attach_provenance'
  | 'attach_diagnostics'
  | 'set_property';

export interface GraphMutation {
  id: string;
  op: GraphMutationOp;
  version: GraphVersion;
  timestamp: string;
  actor: 'user' | 'system' | 'agent' | 'index' | 'parser';
  payload: unknown;
  affectedNodeIds: string[];
  affectedEdgeIds: string[];
}

export interface GraphSnapshot {
  version: GraphVersion;
  createdAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: ResourceNode[];
  edges: ResourceEdge[];
  mutations: GraphMutation[];
}

export interface GraphQuery {
  nodeIds?: string[];
  edgeIds?: string[];
  resourceKinds?: ResourceKind[];
  nodeKinds?: ResourceNodeKind[];
  edgeKinds?: ResourceEdgeKind[];
  uriPrefix?: string;
  overlay?: OverlayLayerId;
  includeDiagnostics?: boolean;
  includeProvenance?: boolean;
  limit?: number;
}

export interface ResourceGraphData {
  workspaceId: string;
  version: GraphVersion;
  nodes: ResourceNode[];
  edges: ResourceEdge[];
  mutations: GraphMutation[];
  createdAt: string;
  updatedAt: string;
}

/**
 * SQLite-ready row shapes (no driver required).
 */
export interface ResourceGraphNodeRow {
  node_id: string;
  workspace_id: string;
  kind: string;
  uri: string;
  resource_kind: string | null;
  overlay: string | null;
  label: string;
  properties_json: string;
  confidence_json: string | null;
  provenance_json: string | null;
  diagnostics_json: string;
  content_hash: string | null;
  version: string;
  created_at: string;
  updated_at: string;
}

export interface ResourceGraphEdgeRow {
  edge_id: string;
  workspace_id: string;
  kind: string;
  from_id: string;
  to_id: string;
  uri: string | null;
  label: string | null;
  properties_json: string;
  confidence_json: string | null;
  provenance_json: string | null;
  diagnostics_json: string;
  version: string;
  created_at: string;
  updated_at: string;
}
