import type {
  GraphPatch,
  GraphPatchEdge,
  GraphPatchNode,
  PatchChange,
  PatchProposal,
  ResourceKind
} from '@soulforge/shared';

export interface BuildGraphPatchOptions {
  resourceKindByUri?: ReadonlyMap<string, ResourceKind>;
}

/**
 * Project a PatchProposal into the v0.5 graph patch IR.
 * This is the visual/impact model for AI review and future patch-graph UI.
 */
export function buildGraphPatchFromProposal(
  proposal: PatchProposal,
  options: BuildGraphPatchOptions = {}
): GraphPatch {
  const nodes: GraphPatchNode[] = [];
  const edges: GraphPatchEdge[] = [];

  const operationNode: GraphPatchNode = {
    id: `op:${proposal.opId}`,
    kind: 'operation',
    uri: `op://${proposal.opId}`,
    label: proposal.title,
    meta: {
      author: proposal.author,
      mode: proposal.mode,
      createdAt: proposal.createdAt
    }
  };
  nodes.push(operationNode);

  for (const [index, change] of proposal.changes.entries()) {
    const fileNodeId = `file:${change.targetUri}`;
    const resourceKind = change.resourceKind ?? options.resourceKindByUri?.get(change.targetUri);
    const fileNode: GraphPatchNode = {
      id: fileNodeId,
      kind: 'file',
      uri: change.targetUri,
      label: change.targetPath,
      layer: change.layer ?? 'overlay',
      ...(resourceKind ? { resourceKind } : {}),
      meta: {
        changeKind: change.kind,
        beforeHash: change.beforeHash,
        afterHash: change.afterHash
      }
    };
    nodes.push(fileNode);

    edges.push({
      id: `edge:op-file:${index}`,
      fromId: operationNode.id,
      toId: fileNodeId,
      kind: 'rewrites',
      reason: `Operation rewrites ${change.targetUri}`
    });

    if (resourceKind) {
      const resourceNodeId = `resource:${change.targetUri}`;
      nodes.push({
        id: resourceNodeId,
        kind: 'resource',
        uri: change.targetUri,
        label: `${resourceKind}:${change.targetUri}`,
        resourceKind,
        layer: change.layer ?? 'overlay'
      });
      edges.push({
        id: `edge:file-resource:${index}`,
        fromId: fileNodeId,
        toId: resourceNodeId,
        kind: 'affects',
        reason: 'File change affects resource symbols'
      });
    }

    if (change.kind === 'structured') {
      const fieldNodeId = `field:${change.targetUri}:${index}`;
      nodes.push({
        id: fieldNodeId,
        kind: 'field',
        uri: `${change.targetUri}#structured`,
        label: 'structured edit',
        ...(resourceKind ? { resourceKind } : {})
      });
      edges.push({
        id: `edge:file-field:${index}`,
        fromId: fileNodeId,
        toId: fieldNodeId,
        kind: 'affects',
        reason: 'Structured edit touches typed fields'
      });
    }
  }

  const uniqueNodes = dedupeNodes(nodes);
  return {
    opId: proposal.opId,
    title: proposal.title,
    nodes: uniqueNodes,
    edges,
    summary: {
      fileCount: proposal.changes.length,
      resourceCount: uniqueNodes.filter((node) => node.kind === 'resource').length,
      edgeCount: edges.length
    }
  };
}

export function attachGraphToProposal(
  proposal: PatchProposal,
  options: BuildGraphPatchOptions = {}
): PatchProposal {
  return {
    ...proposal,
    graph: buildGraphPatchFromProposal(proposal, options)
  };
}

export function summarizeGraphPatch(graph: GraphPatch): string {
  return [
    `op=${graph.opId}`,
    `files=${graph.summary.fileCount}`,
    `resources=${graph.summary.resourceCount}`,
    `edges=${graph.summary.edgeCount}`
  ].join(' ');
}

function dedupeNodes(nodes: GraphPatchNode[]): GraphPatchNode[] {
  const seen = new Set<string>();
  const output: GraphPatchNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    output.push(node);
  }
  return output;
}

export function collectAffectedUris(changes: readonly PatchChange[]): string[] {
  return [...new Set(changes.map((change) => change.targetUri))];
}
