import type { IdReservation, SemanticChangeOperation, SemanticChangeSet } from './types.js';

export function createSemanticChangeSet(input: {
  changeSetId: string;
  baseRevision: string;
  operations: readonly SemanticChangeOperation[];
  postconditions?: readonly string[];
  conflictPolicy?: SemanticChangeSet['conflictPolicy'];
}): SemanticChangeSet {
  const operations = [...input.operations];
  const byId = new Set<string>();
  const diagnostics: string[] = [];
  for (const operation of operations) {
    if (byId.has(operation.operationId)) {
      diagnostics.push(`SEMANTIC_CHANGESET_DUPLICATE_OPERATION: ${operation.operationId}`);
    }
    byId.add(operation.operationId);
  }
  diagnostics.push(...operations.flatMap((operation) => operation.dependencies
    .filter((dependency) => !byId.has(dependency))
    .map((dependency) => `${operation.operationId} 依赖不存在的操作 ${dependency}`)));
  const dependencyOrder = topologicalOrder(operations, diagnostics);
  const targetIdentities = [...new Set(operations.map((operation) => operation.targetIdentity))];
  const expectedBaseRevisions = Object.fromEntries(targetIdentities.map((target) => {
    const operation = operations.find((candidate) => candidate.targetIdentity === target);
    return [target, operation?.beforeRevision ?? input.baseRevision];
  }));
  return {
    changeSetId: input.changeSetId,
    baseRevision: input.baseRevision,
    targetIdentities,
    expectedBaseRevisions,
    operations,
    dependencyOrder,
    postconditions: [...(input.postconditions ?? [])],
    conflictPolicy: input.conflictPolicy ?? 'fail_closed',
    diagnostics
  };
}

/**
 * Validate the plan boundary before a domain transaction is allowed to stage.
 * This is deliberately independent of native writers: a malformed or
 * conflicted cross-domain plan must fail before any one domain can commit.
 */
export function validateSemanticChangeSet(changeSet: SemanticChangeSet, currentRevisions?: ReadonlyMap<string, string>): {
  ok: boolean;
  diagnostics: string[];
} {
  const diagnostics = [...changeSet.diagnostics];
  if (changeSet.operations.length === 0) diagnostics.push('SEMANTIC_CHANGESET_EMPTY');
  if (changeSet.dependencyOrder.length !== new Set(changeSet.dependencyOrder).size) {
    diagnostics.push('SEMANTIC_CHANGESET_ORDER_DUPLICATE');
  }
  if (changeSet.dependencyOrder.length !== changeSet.operations.length) {
    diagnostics.push('SEMANTIC_CHANGESET_ORDER_INCOMPLETE');
  }
  if (currentRevisions) {
    for (const target of changeSet.targetIdentities) {
      const expected = changeSet.expectedBaseRevisions[target];
      const current = currentRevisions.get(target);
      if (current !== undefined && expected !== current) {
        diagnostics.push(`SEMANTIC_CHANGESET_REVISION_CONFLICT: ${target}`);
      }
    }
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function reserveCollisionAwareId(input: {
  namespace: string;
  used: readonly number[];
  /** IDs present in the shipped/base-game source for this namespace. */
  baseGameIds?: readonly number[];
  /** IDs present in the writable mod overlay for this namespace. */
  modOverlayIds?: readonly number[];
  /** IDs observed in the current workspace canonical projection. */
  workspaceCurrentIds?: readonly number[];
  /** IDs held by dirty canonical documents that have not been committed yet. */
  dirtyCanonicalIds?: readonly number[];
  /** IDs reserved by pending semantic ChangeSets. */
  pendingChangeSetIds?: readonly number[];
  reserved?: readonly number[];
  preferred?: number;
  min?: number;
  max?: number;
}): IdReservation {
  const used = new Set([
    ...input.used,
    ...(input.baseGameIds ?? []),
    ...(input.modOverlayIds ?? []),
    ...(input.workspaceCurrentIds ?? []),
    ...(input.dirtyCanonicalIds ?? []),
    ...(input.pendingChangeSetIds ?? []),
    ...(input.reserved ?? [])
  ]);
  const min = input.min ?? 1;
  const max = input.max ?? 2_147_483_647;
  const preferred = input.preferred;
  if (preferred !== undefined && Number.isInteger(preferred) && preferred >= min && preferred <= max && !used.has(preferred)) {
    return { value: preferred, namespace: input.namespace, source: 'reserved' };
  }
  for (let candidate = min; candidate <= max; candidate += 1) {
    if (!used.has(candidate)) return { value: candidate, namespace: input.namespace, source: 'reserved' };
  }
  throw new Error(`ID_ALLOCATOR_EXHAUSTED: namespace=${input.namespace}`);
}

function topologicalOrder(operations: readonly SemanticChangeOperation[], diagnostics: string[]): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: string[] = [];
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      diagnostics.push(`SEMANTIC_CHANGESET_CYCLE: ${id}`);
      return;
    }
    const operation = byId.get(id);
    if (!operation) return;
    visiting.add(id);
    for (const dependency of operation.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const operation of operations) visit(operation.operationId);
  return ordered;
}
