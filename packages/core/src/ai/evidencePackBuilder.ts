/**
 * Workspace-backed AI Evidence Pack builder (core only, no UI).
 */

import { randomUUID } from 'node:crypto';
import type {
  EvidencePack,
  EvidenceRef,
  StructuredDiagnostic
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import type { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';
import type { OperationLogStore } from '../patch/operationLog.js';
import { getFileCapabilities } from '../files/fileCapabilities.js';
import type { SemanticWorkspaceIndex } from '../workspace/semanticWorkspaceIndex.js';

export type EvidencePackScope =
  | 'current_resource'
  | 'direct_references'
  | 'reverse_references'
  | 'diagnostics'
  | 'provenance'
  | 'confidence'
  | 'patch_history'
  | 'supported_operations'
  | 'write_risk'
  | 'unsupported_warnings';

export interface BuiltEvidencePack extends EvidencePack {
  resourceUri: string;
  nativeFormatAuthority: false;
  supportedOperations: string[];
  writeRisk: string;
  candidateRefCount: number;
  confirmedRefCount: number;
  patchHistoryOpIds: string[];
  scope: EvidencePackScope[];
  autoCommitAllowed: boolean;
}

export function buildEvidencePack(input: {
  workspaceId: string;
  resourceUri: string;
  index: SemanticWorkspaceIndex;
  operationLog?: OperationLogStore;
  scope?: EvidencePackScope[];
  absolutePath?: string;
  relativePath?: string;
}): BuiltEvidencePack {
  const scope = input.scope ?? [
    'current_resource',
    'direct_references',
    'reverse_references',
    'diagnostics',
    'provenance',
    'confidence',
    'patch_history',
    'supported_operations',
    'write_risk',
    'unsupported_warnings'
  ];

  const graph = input.index.graph;
  const node = findNodeByUri(graph, input.resourceUri);
  const resources: EvidenceRef[] = [];
  const diagnostics: StructuredDiagnostic[] = [];
  let candidateRefCount = 0;
  let confirmedRefCount = 0;

  if (scope.includes('current_resource') && node) {
    resources.push({
      uri: node.uri,
      kind: node.kind,
      ...(node.confidence ? { confidence: node.confidence } : {}),
      ...(node.provenance ? { provenance: node.provenance } : {})
    });
  }

  if (node && (scope.includes('direct_references') || scope.includes('reverse_references'))) {
    const data = graph.toData();
    for (const edge of data.edges) {
      if (edge.kind !== 'references') continue;
      const isDirect = edge.fromId === node.id;
      const isReverse = edge.toId === node.id;
      if (scope.includes('direct_references') && isDirect) {
        const target = graph.getNode(edge.toId);
        const level = edge.confidence?.level ?? 'low';
        if (level === 'low') candidateRefCount += 1;
        else confirmedRefCount += 1;
        resources.push({
          uri: target?.uri ?? edge.toId,
          kind: level === 'low' ? 'candidate_ref' : 'confirmed_ref',
          ...(edge.confidence ? { confidence: edge.confidence } : {}),
          ...(edge.provenance ? { provenance: edge.provenance } : {})
        });
      }
      if (scope.includes('reverse_references') && isReverse) {
        const source = graph.getNode(edge.fromId);
        const level = edge.confidence?.level ?? 'low';
        if (level === 'low') candidateRefCount += 1;
        else confirmedRefCount += 1;
        resources.push({
          uri: source?.uri ?? edge.fromId,
          kind: level === 'low' ? 'candidate_ref' : 'confirmed_ref',
          ...(edge.confidence ? { confidence: edge.confidence } : {}),
          ...(edge.provenance ? { provenance: edge.provenance } : {})
        });
      }
    }
  }

  if (scope.includes('diagnostics') && node?.diagnostics) {
    diagnostics.push(...node.diagnostics);
  }

  if (scope.includes('unsupported_warnings') && node?.kind === 'unsupported') {
    diagnostics.push(createDiagnostic({
      severity: 'warning',
      code: 'UNSUPPORTED_STRUCTURED_WRITE_BLOCKED',
      message: 'Unsupported/packed resource: structured native write is blocked. Files Mode raw/replace only with high risk.',
      targetUri: node.uri,
      details: { nativeFormatAuthority: false }
    }));
  }

  const relativePath = input.relativePath
    ?? String(node?.properties.find((p) => p.key === 'relativePath')?.value ?? '');
  const absolutePath = input.absolutePath ?? relativePath;
  const caps = relativePath
    ? getFileCapabilities({ absolutePath, relativePath })
    : null;

  const supportedOperations = caps
    ? caps.capabilities.filter((c) => c !== 'none')
    : ['read'];
  const writeRisk = caps?.writeRiskDefault ?? 'blocked';

  const patchHistoryOpIds: string[] = [];
  if (scope.includes('patch_history') && input.operationLog) {
    for (const entry of input.operationLog.history(input.workspaceId)) {
      if (entry.changedPaths.some((p) => p.replaceAll('\\', '/').endsWith(relativePath))) {
        patchHistoryOpIds.push(entry.opId);
      }
    }
  }

  const autoCommitAllowed = writeRisk === 'safe'
    && !supportedOperations.includes('structured_edit')
    && node?.kind !== 'unsupported';

  return {
    packId: randomUUID(),
    workspaceId: input.workspaceId,
    createdAt: new Date().toISOString(),
    resources,
    diagnostics,
    resourceUri: input.resourceUri,
    nativeFormatAuthority: false,
    supportedOperations,
    writeRisk,
    candidateRefCount,
    confirmedRefCount,
    patchHistoryOpIds,
    scope,
    autoCommitAllowed,
    notes: [
      `nativeFormatAuthority=false`,
      `writeRisk=${writeRisk}`,
      autoCommitAllowed
        ? 'auto-commit eligible only for safe Files Mode text writes through Patch Engine'
        : 'auto-commit blocked for high-risk/unsupported/structured paths'
    ]
  };
}

function findNodeByUri(graph: MemoryResourceGraph, uri: string) {
  return graph.toData().nodes.find((node) => node.uri === uri || node.id === uri);
}
