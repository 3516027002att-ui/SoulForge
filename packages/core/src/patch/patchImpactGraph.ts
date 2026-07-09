/**
 * Patch impact computation (core only — no UI).
 */

import type {
  PatchIR,
  PatchIrOperation,
  StructuredDiagnostic
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import type { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';

export interface PatchImpactGraph {
  patchId: string;
  changedResources: string[];
  changedFieldsOrRanges: Array<{
    targetUri: string;
    kind: string;
    detail: string;
  }>;
  directReferenceImpact: string[];
  reverseReferenceImpact: string[];
  candidateRiskEdges: Array<{ edgeId: string; reason: string }>;
  confirmedEdges: Array<{ edgeId: string; reason: string }>;
  validatorsToRun: string[];
  confidenceBreakdown: {
    candidateCount: number;
    confirmedCount: number;
  };
  rollbackScope: string[];
  operationLogScope: string[];
  reindexTargets: string[];
  diagnostics: StructuredDiagnostic[];
}

export function buildPatchImpactGraph(
  patch: PatchIR,
  graph?: MemoryResourceGraph
): PatchImpactGraph {
  const changedResources = [...new Set(patch.operations.map((op) => op.targetUri))];
  const changedFieldsOrRanges = patch.operations.map((op) => describeOp(op));
  const validatorsToRun = [
    ...new Set(
      patch.operations.flatMap((op) => op.validatorRequirements.map((v) => v.validatorId))
    )
  ];

  const directReferenceImpact: string[] = [];
  const reverseReferenceImpact: string[] = [];
  const candidateRiskEdges: Array<{ edgeId: string; reason: string }> = [];
  const confirmedEdges: Array<{ edgeId: string; reason: string }> = [];

  if (graph) {
    const data = graph.toData();
    const nodeIds = new Set(
      data.nodes
        .filter((node) => resourceTouchesNode(changedResources, node))
        .map((node) => node.id)
    );
    for (const edge of data.edges) {
      if (edge.kind !== 'references') continue;
      const level = edge.confidence?.level ?? 'low';
      const touches = nodeIds.has(edge.fromId) || nodeIds.has(edge.toId);
      if (!touches) continue;
      if (nodeIds.has(edge.fromId)) {
        const to = data.nodes.find((n) => n.id === edge.toId);
        if (to) directReferenceImpact.push(to.uri);
      }
      if (nodeIds.has(edge.toId)) {
        const from = data.nodes.find((n) => n.id === edge.fromId);
        if (from) reverseReferenceImpact.push(from.uri);
      }
      if (level === 'low') {
        candidateRiskEdges.push({
          edgeId: edge.id,
          reason: 'candidate reference — not confirmed impact'
        });
      } else {
        confirmedEdges.push({
          edgeId: edge.id,
          reason: edge.label ?? 'confirmed reference'
        });
      }
    }
  }

  const diagnostics: StructuredDiagnostic[] = [];
  for (const op of patch.operations) {
    if (op.riskLevel === 'high' || op.riskLevel === 'blocked') {
      diagnostics.push(createDiagnostic({
        severity: op.riskLevel === 'blocked' ? 'error' : 'warning',
        code: op.riskLevel === 'blocked' ? 'PATCH_IMPACT_BLOCKED' : 'PATCH_IMPACT_HIGH_RISK',
        message: `Patch operation ${op.kind} is ${op.riskLevel} risk.`,
        targetUri: op.targetUri,
        details: { kind: op.kind, nativeFormatAuthority: false }
      }));
    }
  }

  const targetPaths = patch.operations
    .map((op) => op.targetPath)
    .filter((p): p is string => Boolean(p));

  return {
    patchId: patch.patchId,
    changedResources,
    changedFieldsOrRanges,
    directReferenceImpact: [...new Set(directReferenceImpact)],
    reverseReferenceImpact: [...new Set(reverseReferenceImpact)],
    candidateRiskEdges,
    confirmedEdges,
    validatorsToRun,
    confidenceBreakdown: {
      candidateCount: candidateRiskEdges.length,
      confirmedCount: confirmedEdges.length
    },
    rollbackScope: targetPaths,
    operationLogScope: changedResources,
    reindexTargets: targetPaths,
    diagnostics
  };
}

function resourceTouchesNode(
  changedResources: string[],
  node: { uri: string; properties: Array<{ key: string; value: unknown }> }
): boolean {
  if (changedResources.includes(node.uri)) return true;
  const relativePath = String(node.properties.find((p) => p.key === 'relativePath')?.value ?? '');
  if (!relativePath) return false;
  const posix = relativePath.replaceAll('\\', '/');
  return changedResources.some((uri) => {
    if (uri === `file://${posix}`) return true;
    if (uri.endsWith(posix)) return true;
    if (uri.includes(`/${posix}`) || uri.includes(posix)) return true;
    return false;
  });
}

function describeOp(op: PatchIrOperation): {
  targetUri: string;
  kind: string;
  detail: string;
} {
  if (op.kind === 'text_edit') {
    return {
      targetUri: op.targetUri,
      kind: op.kind,
      detail: `text_edit length=${op.newText.length}`
    };
  }
  if (op.kind === 'raw_byte_range_edit') {
    return {
      targetUri: op.targetUri,
      kind: op.kind,
      detail: `bytes[${op.offset}..${op.offset + op.length})`
    };
  }
  if (op.kind === 'file_replace') {
    return {
      targetUri: op.targetUri,
      kind: op.kind,
      detail: 'whole file replace'
    };
  }
  return {
    targetUri: op.targetUri,
    kind: op.kind,
    detail: op.kind
  };
}
