/**
 * Aggregate resource graph + workspace index health into structured diagnostics.
 * Does not invent native authority — only reports graph completeness signals.
 */

import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import type { MemoryResourceGraph } from './memoryResourceGraph.js';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';

export interface ResourceIndexHealthReport {
  workspaceId: string;
  nodeCount: number;
  edgeCount: number;
  nodesWithoutKind: number;
  orphanNodes: number;
  candidateReferenceEdges: number;
  confirmedReferenceEdges: number;
  indexFileCount: number;
  indexReferenceCount: number;
  diagnostics: StructuredDiagnostic[];
}

/**
 * Build a health report for graph/index dashboards and AI context.
 */
export function buildResourceIndexHealthReport(input: {
  workspaceId: string;
  graph?: MemoryResourceGraph;
  index?: WorkspaceIndex;
}): ResourceIndexHealthReport {
  const diagnostics: StructuredDiagnostic[] = [];
  let nodeCount = 0;
  let edgeCount = 0;
  let nodesWithoutKind = 0;
  let orphanNodes = 0;
  let candidateReferenceEdges = 0;
  let confirmedReferenceEdges = 0;

  if (input.graph) {
    const data = input.graph.toData();
    nodeCount = data.nodes.length;
    edgeCount = data.edges.length;
    const connected = new Set<string>();
    for (const edge of data.edges) {
      connected.add(edge.fromId);
      connected.add(edge.toId);
      if (edge.kind === 'references') {
        const level = edge.confidence?.level ?? 'low';
        if (level === 'low' || level === 'none') candidateReferenceEdges += 1;
        else confirmedReferenceEdges += 1;
      }
    }
    for (const node of data.nodes) {
      if (!node.resourceKind) nodesWithoutKind += 1;
      if (!connected.has(node.id) && node.kind !== 'file') orphanNodes += 1;
    }
    if (nodeCount === 0) {
      diagnostics.push(createDiagnostic({
        severity: 'info',
        code: 'RESOURCE_GRAPH_EMPTY',
        message: '资源图尚无节点；索引或 Bridge 摄取后将填充。'
      }));
    }
    if (candidateReferenceEdges > 0) {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        code: 'RESOURCE_GRAPH_CANDIDATE_REFERENCES',
        message: `存在 ${candidateReferenceEdges} 条候选引用边，AI 不得当作已确认证据。`,
        details: { candidateReferenceEdges }
      }));
    }
    if (orphanNodes > 0) {
      diagnostics.push(createDiagnostic({
        severity: 'info',
        code: 'RESOURCE_GRAPH_ORPHAN_NODES',
        message: `存在 ${orphanNodes} 个无边资源节点。`,
        details: { orphanNodes }
      }));
    }
  } else {
    diagnostics.push(createDiagnostic({
      severity: 'warning',
      code: 'RESOURCE_GRAPH_UNAVAILABLE',
      message: '当前工作区未挂载资源图。'
    }));
  }

  let indexFileCount = 0;
  let indexReferenceCount = 0;
  if (input.index) {
    const stats = input.index.getStats();
    indexFileCount = stats.files;
    indexReferenceCount = stats.references;
    if (stats.files === 0) {
      diagnostics.push(createDiagnostic({
        severity: 'info',
        code: 'WORKSPACE_INDEX_EMPTY',
        message: '工作区索引尚无文件。'
      }));
    }
  }

  return {
    workspaceId: input.workspaceId,
    nodeCount,
    edgeCount,
    nodesWithoutKind,
    orphanNodes,
    candidateReferenceEdges,
    confirmedReferenceEdges,
    indexFileCount,
    indexReferenceCount,
    diagnostics
  };
}
