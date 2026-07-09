/**
 * In-memory temporal property graph scaffold.
 * SQLite-ready types live in @soulforge/shared; this is the runtime graph.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConfidenceAssessment,
  DiagnosticAttachmentRef,
  GraphMutation,
  GraphQuery,
  GraphSnapshot,
  GraphVersion,
  ProvenanceAttachmentRef,
  ProvenanceChain,
  ResourceEdge,
  ResourceGraphData,
  ResourceNode,
  ResourceProperty,
  StructuredDiagnostic
} from '@soulforge/shared';

export class MemoryResourceGraph {
  readonly workspaceId: string;
  private versionCounter = 0;
  private version: GraphVersion;
  private readonly nodes = new Map<string, ResourceNode>();
  private readonly edges = new Map<string, ResourceEdge>();
  private readonly mutations: GraphMutation[] = [];
  private readonly createdAt: string;
  private updatedAt: string;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.version = this.nextVersion();
  }

  getVersion(): GraphVersion {
    return this.version;
  }

  addNode(input: Omit<ResourceNode, 'createdAt' | 'updatedAt' | 'version' | 'properties'> & {
    properties?: ResourceProperty[];
    version?: GraphVersion;
  }): ResourceNode {
    if (this.nodes.has(input.id)) {
      throw new Error(`Node already exists: ${input.id}`);
    }
    const timestamp = nowIso();
    const node: ResourceNode = {
      ...input,
      properties: input.properties ?? [],
      version: input.version ?? this.version,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.nodes.set(node.id, node);
    this.recordMutation('add_node', {
      actor: 'system',
      payload: { nodeId: node.id },
      affectedNodeIds: [node.id],
      affectedEdgeIds: []
    });
    return node;
  }

  updateNode(nodeId: string, patch: Partial<Omit<ResourceNode, 'id' | 'createdAt'>>): ResourceNode {
    const existing = this.requireNode(nodeId);
    const updated: ResourceNode = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
      version: this.version
    };
    this.nodes.set(nodeId, updated);
    this.recordMutation('update_node', {
      actor: 'system',
      payload: { nodeId, patch },
      affectedNodeIds: [nodeId],
      affectedEdgeIds: []
    });
    return updated;
  }

  deleteNode(nodeId: string): void {
    this.requireNode(nodeId);
    this.nodes.delete(nodeId);
    for (const [edgeId, edge] of [...this.edges.entries()]) {
      if (edge.fromId === nodeId || edge.toId === nodeId) {
        this.edges.delete(edgeId);
      }
    }
    this.recordMutation('delete_node', {
      actor: 'system',
      payload: { nodeId },
      affectedNodeIds: [nodeId],
      affectedEdgeIds: []
    });
  }

  addEdge(input: Omit<ResourceEdge, 'createdAt' | 'updatedAt' | 'version' | 'properties'> & {
    properties?: ResourceProperty[];
  }): ResourceEdge {
    if (this.edges.has(input.id)) {
      throw new Error(`Edge already exists: ${input.id}`);
    }
    this.requireNode(input.fromId);
    this.requireNode(input.toId);
    const timestamp = nowIso();
    const edge: ResourceEdge = {
      ...input,
      properties: input.properties ?? [],
      version: this.version,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.edges.set(edge.id, edge);
    this.recordMutation('add_edge', {
      actor: 'system',
      payload: { edgeId: edge.id },
      affectedNodeIds: [edge.fromId, edge.toId],
      affectedEdgeIds: [edge.id]
    });
    return edge;
  }

  updateEdge(edgeId: string, patch: Partial<Omit<ResourceEdge, 'id' | 'createdAt'>>): ResourceEdge {
    const existing = this.requireEdge(edgeId);
    const updated: ResourceEdge = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
      version: this.version
    };
    this.edges.set(edgeId, updated);
    this.recordMutation('update_edge', {
      actor: 'system',
      payload: { edgeId, patch },
      affectedNodeIds: [updated.fromId, updated.toId],
      affectedEdgeIds: [edgeId]
    });
    return updated;
  }

  deleteEdge(edgeId: string): void {
    const edge = this.requireEdge(edgeId);
    this.edges.delete(edgeId);
    this.recordMutation('delete_edge', {
      actor: 'system',
      payload: { edgeId },
      affectedNodeIds: [edge.fromId, edge.toId],
      affectedEdgeIds: [edgeId]
    });
  }

  attachProvenance(attachment: ProvenanceAttachmentRef): void {
    if (attachment.targetKind === 'node') {
      const node = this.requireNode(attachment.targetId);
      this.updateNode(node.id, {
        provenance: mergeProvenance(node.provenance, attachment.chain)
      });
    } else if (attachment.targetKind === 'edge') {
      const edge = this.requireEdge(attachment.targetId);
      this.updateEdge(edge.id, {
        provenance: mergeProvenance(edge.provenance, attachment.chain)
      });
    }
    this.recordMutation('attach_provenance', {
      actor: 'system',
      payload: attachment,
      affectedNodeIds: attachment.targetKind === 'node' ? [attachment.targetId] : [],
      affectedEdgeIds: attachment.targetKind === 'edge' ? [attachment.targetId] : []
    });
  }

  attachDiagnostics(attachment: DiagnosticAttachmentRef): void {
    if (attachment.targetKind === 'node') {
      const node = this.requireNode(attachment.targetId);
      this.updateNode(node.id, {
        diagnostics: [...(node.diagnostics ?? []), ...attachment.diagnostics]
      });
    } else if (attachment.targetKind === 'edge') {
      const edge = this.requireEdge(attachment.targetId);
      this.updateEdge(edge.id, {
        diagnostics: [...(edge.diagnostics ?? []), ...attachment.diagnostics]
      });
    }
    this.recordMutation('attach_diagnostics', {
      actor: 'system',
      payload: { targetId: attachment.targetId, count: attachment.diagnostics.length },
      affectedNodeIds: attachment.targetKind === 'node' ? [attachment.targetId] : [],
      affectedEdgeIds: attachment.targetKind === 'edge' ? [attachment.targetId] : []
    });
  }

  setNodeConfidence(nodeId: string, confidence: ConfidenceAssessment): ResourceNode {
    return this.updateNode(nodeId, { confidence });
  }

  snapshot(): GraphSnapshot {
    return {
      version: this.version,
      createdAt: nowIso(),
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      mutations: [...this.mutations]
    };
  }

  /**
   * Bump graph version after a logical batch of mutations (index/patch/rollback).
   */
  bumpVersion(actor: GraphMutation['actor'] = 'system'): GraphVersion {
    this.version = this.nextVersion();
    this.updatedAt = nowIso();
    this.recordMutation('set_property', {
      actor,
      payload: { version: this.version },
      affectedNodeIds: [],
      affectedEdgeIds: [],
      bump: false
    });
    return this.version;
  }

  query(query: GraphQuery = {}): { nodes: ResourceNode[]; edges: ResourceEdge[] } {
    let nodes = [...this.nodes.values()];
    let edges = [...this.edges.values()];

    if (query.nodeIds?.length) {
      const set = new Set(query.nodeIds);
      nodes = nodes.filter((node) => set.has(node.id));
    }
    if (query.edgeIds?.length) {
      const set = new Set(query.edgeIds);
      edges = edges.filter((edge) => set.has(edge.id));
    }
    if (query.resourceKinds?.length) {
      const set = new Set(query.resourceKinds);
      nodes = nodes.filter((node) => node.resourceKind && set.has(node.resourceKind));
    }
    if (query.nodeKinds?.length) {
      const set = new Set(query.nodeKinds);
      nodes = nodes.filter((node) => set.has(node.kind));
    }
    if (query.edgeKinds?.length) {
      const set = new Set(query.edgeKinds);
      edges = edges.filter((edge) => set.has(edge.kind));
    }
    if (query.overlay) {
      nodes = nodes.filter((node) => node.overlay === query.overlay);
    }
    if (query.uriPrefix) {
      nodes = nodes.filter((node) => node.uri.startsWith(query.uriPrefix!));
    }

    const limit = query.limit ?? 1000;
    nodes = nodes.slice(0, limit);
    edges = edges.slice(0, limit);

    if (!query.includeDiagnostics) {
      nodes = nodes.map((node) => omitDiagnostics(node));
      edges = edges.map((edge) => omitEdgeDiagnostics(edge));
    }
    if (!query.includeProvenance) {
      nodes = nodes.map((node) => omitProvenance(node));
      edges = edges.map((edge) => omitEdgeProvenance(edge));
    }

    return { nodes, edges };
  }

  toData(): ResourceGraphData {
    return {
      workspaceId: this.workspaceId,
      version: this.version,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      mutations: [...this.mutations],
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  getNode(nodeId: string): ResourceNode | undefined {
    return this.nodes.get(nodeId);
  }

  getEdge(edgeId: string): ResourceEdge | undefined {
    return this.edges.get(edgeId);
  }

  private requireNode(nodeId: string): ResourceNode {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    return node;
  }

  private requireEdge(edgeId: string): ResourceEdge {
    const edge = this.edges.get(edgeId);
    if (!edge) throw new Error(`Edge not found: ${edgeId}`);
    return edge;
  }

  private nextVersion(): GraphVersion {
    this.versionCounter += 1;
    return `g${this.versionCounter}`;
  }

  private recordMutation(
    op: GraphMutation['op'],
    input: {
      actor: GraphMutation['actor'];
      payload: unknown;
      affectedNodeIds: string[];
      affectedEdgeIds: string[];
      bump?: boolean;
    }
  ): void {
    if (input.bump !== false) {
      this.version = this.nextVersion();
    }
    this.updatedAt = nowIso();
    this.mutations.push({
      id: randomUUID(),
      op,
      version: this.version,
      timestamp: this.updatedAt,
      actor: input.actor,
      payload: input.payload,
      affectedNodeIds: input.affectedNodeIds,
      affectedEdgeIds: input.affectedEdgeIds
    });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function mergeProvenance(existing: ProvenanceChain | undefined, next: ProvenanceChain): ProvenanceChain {
  if (!existing) return next;
  return {
    sources: [...existing.sources, ...next.sources],
    ...(existing.links || next.links
      ? { links: [...(existing.links ?? []), ...(next.links ?? [])] }
      : {})
  };
}

function omitDiagnostics(node: ResourceNode): ResourceNode {
  const { diagnostics: _diagnostics, ...rest } = node;
  return rest;
}

function omitEdgeDiagnostics(edge: ResourceEdge): ResourceEdge {
  const { diagnostics: _diagnostics, ...rest } = edge;
  return rest;
}

function omitProvenance(node: ResourceNode): ResourceNode {
  const { provenance: _provenance, ...rest } = node;
  return rest;
}

function omitEdgeProvenance(edge: ResourceEdge): ResourceEdge {
  const { provenance: _provenance, ...rest } = edge;
  return rest;
}

export function createEmptyResourceGraph(workspaceId: string): MemoryResourceGraph {
  return new MemoryResourceGraph(workspaceId);
}
