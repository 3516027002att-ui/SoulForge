/**
 * Semantic Workspace Index: VFS → ResourceGraph + snapshot persist/reload + reindex.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConfidenceAssessment,
  ProvenanceChain,
  ResourceNode,
  StructuredDiagnostic
} from '@soulforge/shared';
import {
  createDiagnostic,
  createSyntheticFixtureProvenance,
  syntheticFixtureConfidence
} from '@soulforge/shared';
import { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';
import { buildVfsFromWorkspace } from '../vfs/buildVfs.js';
import type { VfsNode, VfsTree } from '@soulforge/shared';
import { probeFile } from '../vfs/boundedFileProbe.js';

export interface SemanticSnapshot {
  workspaceId: string;
  createdAt: string;
  version: string;
  nodeCount: number;
  edgeCount: number;
  graph: ReturnType<MemoryResourceGraph['toData']>;
  vfsUriCount: number;
}

export interface SemanticWorkspaceIndex {
  workspaceId: string;
  workspaceRoot: string;
  graph: MemoryResourceGraph;
  vfs?: VfsTree;
  lastSnapshot?: SemanticSnapshot;
}

export async function buildSemanticWorkspaceIndex(input: {
  workspaceId: string;
  workspaceRoot: string;
  game?: string;
}): Promise<SemanticWorkspaceIndex> {
  const vfs = await buildVfsFromWorkspace({
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    game: input.game ?? 'unknown'
  });
  const graph = new MemoryResourceGraph(input.workspaceId);
  ingestVfsIntoGraph(graph, vfs);
  return {
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    graph,
    vfs
  };
}

export function ingestVfsIntoGraph(graph: MemoryResourceGraph, vfs: VfsTree): number {
  let count = 0;
  for (const node of Object.values(vfs.nodesByUri)) {
    if (node.kind === 'directory') continue;
    upsertVfsNode(graph, node);
    count += 1;
  }
  graph.bumpVersion('index');
  return count;
}

function upsertVfsNode(graph: MemoryResourceGraph, node: VfsNode): void {
  const existing = graph.getNode(node.id);
  const provenance: ProvenanceChain | undefined = node.provenance
    ?? (node.synthetic
      ? { sources: [createSyntheticFixtureProvenance(`vfs:${node.relativePath}`)] }
      : undefined);
  const confidence: ConfidenceAssessment | undefined = node.confidence
    ?? (node.synthetic ? syntheticFixtureConfidence() : undefined);

  const properties = [
    { key: 'relativePath', value: node.relativePath },
    { key: 'formatKind', value: node.formatKind },
    { key: 'hashStatus', value: node.hashStatus ?? 'unavailable' },
    { key: 'nativeFormatAuthority', value: false },
    { key: 'capabilities', value: node.capabilities }
  ];

  if (existing) {
    graph.updateNode(node.id, {
      label: node.name,
      uri: node.resourceUriString,
      resourceKind: node.resourceKind,
      overlay: node.overlay,
      properties,
      diagnostics: node.diagnostics,
      ...(node.contentHash ? { contentHash: node.contentHash } : {}),
      ...(provenance ? { provenance } : {}),
      ...(confidence ? { confidence } : {})
    });
    return;
  }

  graph.addNode({
    id: node.id,
    kind: node.kind === 'unsupported'
      ? 'unsupported'
      : node.synthetic
        ? 'synthetic'
        : node.kind === 'synthetic_resource'
          ? 'synthetic'
          : 'file',
    uri: node.resourceUriString,
    resourceUri: node.resourceUri,
    resourceKind: node.resourceKind,
    overlay: node.overlay,
    label: node.name,
    properties,
    diagnostics: node.diagnostics,
    ...(node.contentHash ? { contentHash: node.contentHash } : {}),
    ...(provenance ? { provenance } : {}),
    ...(confidence ? { confidence } : {})
  });
}

/**
 * Ingest synthetic high/low confidence reference edges for tests/fixtures.
 */
export function ingestSyntheticReferenceEdge(
  graph: MemoryResourceGraph,
  input: {
    fromId: string;
    toId: string;
    confidence: 'high' | 'low';
    reason: string;
  }
): void {
  if (!graph.getNode(input.fromId) || !graph.getNode(input.toId)) {
    throw new Error('Both endpoints must exist before attaching reference edge.');
  }
  const id = `ref:${input.fromId}->${input.toId}`;
  if (graph.getEdge(id)) return;
  graph.addEdge({
    id,
    kind: 'references',
    fromId: input.fromId,
    toId: input.toId,
    label: input.reason,
    confidence: input.confidence === 'high'
      ? { score: 0.85, level: 'high', reasons: [{ code: 'parser_confirmed', message: input.reason }] }
      : { score: 0.25, level: 'low', reasons: [{ code: 'heuristic', message: input.reason }] },
    provenance: {
      sources: [
        input.confidence === 'high'
          ? createSyntheticFixtureProvenance('confirmed-synthetic-ref')
          : createSyntheticFixtureProvenance('candidate-ref')
      ]
    }
  });
}

export function createSemanticSnapshot(index: SemanticWorkspaceIndex): SemanticSnapshot {
  const data = index.graph.toData();
  const snapshot: SemanticSnapshot = {
    workspaceId: index.workspaceId,
    createdAt: new Date().toISOString(),
    version: data.version,
    nodeCount: data.nodes.length,
    edgeCount: data.edges.length,
    graph: data,
    vfsUriCount: index.vfs ? Object.keys(index.vfs.nodesByUri).length : 0
  };
  index.lastSnapshot = snapshot;
  return snapshot;
}

export async function persistSemanticSnapshot(
  snapshot: SemanticSnapshot,
  filePath: string
): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export async function loadSemanticSnapshot(filePath: string): Promise<SemanticSnapshot> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as SemanticSnapshot;
}

export function restoreGraphFromSnapshot(snapshot: SemanticSnapshot): MemoryResourceGraph {
  const graph = new MemoryResourceGraph(snapshot.workspaceId);
  for (const node of snapshot.graph.nodes) {
    if (graph.getNode(node.id)) continue;
    graph.addNode({
      id: node.id,
      kind: node.kind,
      uri: node.uri,
      label: node.label,
      properties: node.properties ?? [],
      ...(node.resourceKind ? { resourceKind: node.resourceKind } : {}),
      ...(node.overlay ? { overlay: node.overlay } : {}),
      ...(node.diagnostics ? { diagnostics: node.diagnostics } : {}),
      ...(node.provenance ? { provenance: node.provenance } : {}),
      ...(node.confidence ? { confidence: node.confidence } : {}),
      ...(node.contentHash ? { contentHash: node.contentHash } : {})
    });
  }
  for (const edge of snapshot.graph.edges) {
    if (graph.getEdge(edge.id)) continue;
    graph.addEdge({
      id: edge.id,
      kind: edge.kind,
      fromId: edge.fromId,
      toId: edge.toId,
      properties: edge.properties ?? [],
      ...(edge.label ? { label: edge.label } : {}),
      ...(edge.confidence ? { confidence: edge.confidence } : {}),
      ...(edge.provenance ? { provenance: edge.provenance } : {})
    });
  }
  return graph;
}

export async function reindexChangedResources(input: {
  index: SemanticWorkspaceIndex;
  changedPaths: string[];
}): Promise<{ ok: boolean; updatedNodeIds: string[]; diagnostics: StructuredDiagnostic[] }> {
  const diagnostics: StructuredDiagnostic[] = [];
  const updatedNodeIds: string[] = [];
  if (!input.index.vfs) {
    return {
      ok: false,
      updatedNodeIds: [],
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'REINDEX_NO_VFS',
        message: 'Semantic index has no VFS tree to reindex against.'
      })]
    };
  }

  for (const absolutePath of input.changedPaths) {
    const node = Object.values(input.index.vfs.nodesByUri).find(
      (item) => item.absolutePath && resolveSafe(item.absolutePath) === resolveSafe(absolutePath)
    );
    if (!node || !node.absolutePath) {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        code: 'REINDEX_NODE_MISSING',
        message: `No VFS node for changed path ${absolutePath}`
      }));
      continue;
    }

    try {
      const probe = await probeFile(node.absolutePath, {
        deferHash: node.kind === 'unsupported' || node.formatKind !== 'text'
      });
      const { contentHash: _dropHash, ...nodeRest } = node;
      const next: VfsNode = {
        ...nodeRest,
        size: probe.size,
        hashStatus: probe.hashStatus,
        diagnostics: [
          ...node.diagnostics,
          createDiagnostic({
            severity: 'info',
            code: 'REINDEX_AFTER_PATCH',
            message: 'Resource metadata refreshed after Files Mode patch.',
            details: {
              hashStatus: probe.hashStatus,
              nativeFormatAuthority: false
            }
          })
        ],
        nativeFormatAuthority: false,
        ...(probe.contentHash ? { contentHash: probe.contentHash } : {})
      };
      // Update in-memory VFS map
      input.index.vfs.nodesByUri[node.resourceUriString] = next;
      upsertVfsNode(input.index.graph, next);
      updatedNodeIds.push(node.id);
    } catch (error) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'REINDEX_FAILED',
        message: error instanceof Error ? error.message : 'Reindex failed.',
        details: { absolutePath }
      }));
    }
  }

  if (updatedNodeIds.length > 0) input.index.graph.bumpVersion('index');
  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    updatedNodeIds,
    diagnostics
  };
}

function resolveSafe(pathValue: string): string {
  return pathValue.replaceAll('\\', '/').toLowerCase();
}
