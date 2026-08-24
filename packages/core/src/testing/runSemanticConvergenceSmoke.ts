import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexedFile } from '@soulforge/shared';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { SemanticResolver } from '../semantic/resolver.js';
import { ResolverWorkflowState } from '../semantic/resolverState.js';
import { createCompletionContract, evaluateCompletionContract, markPredicate } from '../semantic/completion.js';
import { createSemanticChangeSet, reserveCollisionAwareId, validateSemanticChangeSet } from '../semantic/changeSet.js';
import { NoProgressTracker } from '../semantic/progress.js';
import { selectEffectiveCanonicalProjection } from '../semantic/canonicalPrecedence.js';
import { createTaskModel } from '../semantic/taskModel.js';
import { executeSemanticWorkspaceTransaction } from '../semantic/workspaceTransaction.js';
import { executeSemanticPatchProposalTransaction } from '../semantic/patchProposalTransaction.js';
import { createWorkspaceTransaction } from '../transactions/workspaceTransaction.js';
import { createPatchIr, createTextEditOperation } from '../patch-engine/patchIr.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { createDefaultToolRegistry } from '../ai/toolRegistry.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import { runAgentSession } from '../model-services/agentSessionHost.js';
import type {
  ModelCompleteResult,
  ModelServiceAdapter,
  ModelServiceConfig,
  StreamEvent,
  ToolCall,
  ToolDefinition
} from '../model-services/types.js';

const sourceUri = 'file://param/gameparam.parambnd.dcx';
const rowUri = `${sourceUri}#NpcParam/50800000`;

function indexedFile(parseStatus: IndexedFile['parseStatus']): IndexedFile {
  return {
    id: 'param-file',
    workspaceId: 'semantic-smoke',
    sourceUri,
    sourcePath: 'param/gameparam.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    parseStatus,
    diagnostics: [],
    absolutePath: 'D:/semantic-smoke/param/gameparam.parambnd.dcx',
    relativePath: 'param/gameparam.parambnd.dcx',
    extension: '.dcx',
    compoundExtension: '.parambnd.dcx',
    formatKind: 'param',
    formatLabel: 'PARAMBND',
    size: 10,
    mtimeMs: 1,
    sha256: 'revision-1'
  };
}

function smokeConfig(id: string): ModelServiceConfig {
  return {
    id,
    displayName: 'Semantic convergence smoke',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1',
    model: 'semantic-smoke',
    hasCredential: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function toolDefinition(name: string, permissionLevel: string): ToolDefinition {
  return {
    name,
    description: name,
    parametersJsonSchema: { type: 'object' },
    permissionLevel
  };
}

function toolCompletion(name: string, id: string, argumentsJson = '{}'): ModelCompleteResult {
  return {
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name, argumentsJson }]
    },
    finishReason: 'tool_use',
    diagnostics: []
  };
}

function stopCompletion(content = 'done'): ModelCompleteResult {
  return {
    message: { role: 'assistant', content },
    finishReason: 'stop',
    diagnostics: []
  };
}

function scriptedAdapter(script: (callNumber: number) => ModelCompleteResult): {
  adapter: ModelServiceAdapter;
  calls: () => number;
} {
  let callNumber = 0;
  const emptyStream = async function* (): AsyncGenerator<StreamEvent, void, undefined> {
    return;
  };
  return {
    adapter: {
      protocol: 'openai-compatible',
      complete: async () => script(++callNumber),
      stream: emptyStream,
      listModels: async () => ({ ok: true, models: [] })
    },
    calls: () => callNumber
  };
}

async function runWorkspaceTransactionSmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-semantic-workspace-'));
  const firstPath = join(root, 'map.txt');
  const secondPath = join(root, 'event.txt');
  const firstBefore = 'map-before\n';
  const secondBefore = 'event-before\n';
  const firstAfter = 'map-after\n';
  const secondAfter = 'event-after\n';
  try {
    await mkdir(join(root, '.staging'), { recursive: true });
    await mkdir(join(root, '.backups'), { recursive: true });
    await writeFile(firstPath, firstBefore);
    await writeFile(secondPath, secondBefore);
    const run = async (shouldFailPostcondition: boolean) => {
      const transaction = createWorkspaceTransaction({
        workspaceId: 'semantic-workspace-smoke',
        workspaceRoot: root,
        stagingBaseDir: join(root, '.staging'),
        backupBaseDir: join(root, '.backups')
      });
      const firstPatch = createPatchIr({
        workspaceId: 'semantic-workspace-smoke',
        title: 'map domain patch',
        author: 'system',
        operations: [createTextEditOperation({
          targetUri: 'file://map.txt',
          targetPath: firstPath,
          newText: firstAfter,
          expectedHash: createHash('sha256').update(firstBefore).digest('hex')
        })]
      });
      const secondPatch = createPatchIr({
        workspaceId: 'semantic-workspace-smoke',
        title: 'event domain patch',
        author: 'system',
        operations: [createTextEditOperation({
          targetUri: 'file://event.txt',
          targetPath: secondPath,
          newText: secondAfter,
          expectedHash: createHash('sha256').update(secondBefore).digest('hex')
        })]
      });
      const changeSet = createSemanticChangeSet({
        changeSetId: shouldFailPostcondition ? 'cs:rollback' : 'cs:commit',
        baseRevision: 'revision-1',
        operations: [
          {
            operationId: 'map:1',
            domain: 'map',
            targetIdentity: 'file://map.txt',
            kind: 'replace',
            beforeRevision: 'revision-1',
            dependencies: [],
            payload: { value: firstAfter }
          },
          {
            operationId: 'event:1',
            domain: 'event',
            targetIdentity: 'file://event.txt',
            kind: 'replace',
            beforeRevision: 'revision-1',
            dependencies: ['map:1'],
            payload: { value: secondAfter }
          }
        ],
        postconditions: ['both domain files reread to the requested bytes']
      });
      const stagedText = async (targetPath: string, expected: string) => {
        const target = transaction.getCommitTargets().find((item) => item.targetPath === targetPath);
        if (!target) return { ok: false };
        return { ok: (await readFile(target.stagingPath, 'utf8')) === expected };
      };
      const committedText = async (targetPath: string, expected: string) => ({
        ok: (await readFile(targetPath, 'utf8')) === expected
      });
      return executeSemanticWorkspaceTransaction({
        changeSet,
        currentRevisions: new Map([
          ['file://map.txt', 'revision-1'],
          ['file://event.txt', 'revision-1']
        ]),
        transaction,
        domains: [
          {
            domain: 'map',
            operationIds: ['map:1'],
            patch: firstPatch,
            rereadStaged: () => stagedText(firstPath, firstAfter),
            rereadCommitted: () => committedText(firstPath, firstAfter),
            verifyPostconditions: async () => ({ ok: !shouldFailPostcondition })
          },
          {
            domain: 'event',
            operationIds: ['event:1'],
            patch: secondPatch,
            rereadStaged: () => stagedText(secondPath, secondAfter),
            rereadCommitted: () => committedText(secondPath, secondAfter),
            verifyPostconditions: () => committedText(secondPath, secondAfter)
          }
        ]
      });
    };

    const committed = await run(false);
    assert.equal(committed.ok, true);
    assert.equal(committed.phase, 'committed');
    assert.equal(await readFile(firstPath, 'utf8'), firstAfter);
    assert.equal(await readFile(secondPath, 'utf8'), secondAfter);

    await writeFile(firstPath, firstBefore);
    await writeFile(secondPath, secondBefore);
    const rolledBack = await run(true);
    assert.equal(rolledBack.ok, false);
    assert.equal(rolledBack.phase, 'rolled_back');
    assert.equal(rolledBack.committed, false);
    assert.equal(await readFile(firstPath, 'utf8'), firstBefore);
    assert.equal(await readFile(secondPath, 'utf8'), secondBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runProductionSemanticPatchBoundarySmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-semantic-patch-boundary-'));
  const backupRoot = join(root, '.backups');
  const mapPath = join(root, 'map.txt');
  const eventPath = join(root, 'event.txt');
  const mapBefore = 'map-before\n';
  const eventBefore = 'event-before\n';
  const mapAfter = 'map-after\n';
  const eventAfter = 'event-after\n';
  const mapUri = 'file://map.txt';
  const eventUri = 'file://event.txt';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const proposal = (input: {
    opId: string;
    targetUri: string;
    targetPath: string;
    before: string;
    after: string;
  }) => ({
    opId: input.opId,
    workspaceId: 'semantic-patch-boundary',
    title: input.opId,
    author: 'ai' as const,
    mode: 'fullPermission' as const,
    createdAt: new Date().toISOString(),
    changes: [{
      targetUri: input.targetUri,
      targetPath: input.targetPath,
      kind: 'text' as const,
      beforeHash: hash(input.before),
      afterHash: hash(input.after),
      structuredEdit: { newText: input.after }
    }]
  });
  try {
    await mkdir(backupRoot, { recursive: true });
    await writeFile(mapPath, mapBefore);
    await writeFile(eventPath, eventBefore);
    const changeSet = createSemanticChangeSet({
      changeSetId: 'cs:production-boundary',
      baseRevision: 'workspace-revision-1',
      operations: [
        {
          operationId: 'map:1',
          domain: 'map',
          targetIdentity: mapUri,
          kind: 'replace-text-fixture',
          beforeRevision: hash(mapBefore),
          dependencies: [],
          payload: { value: mapAfter }
        },
        {
          operationId: 'event:1',
          domain: 'event',
          targetIdentity: eventUri,
          kind: 'replace-text-fixture',
          beforeRevision: hash(eventBefore),
          dependencies: ['map:1'],
          payload: { value: eventAfter }
        }
      ],
      postconditions: ['committed_bytes_match_staged']
    });
    const committed = await executeSemanticPatchProposalTransaction({
      changeSet,
      proposals: [
        { proposal: proposal({ opId: 'proposal:map', targetUri: mapUri, targetPath: mapPath, before: mapBefore, after: mapAfter }), operationIds: ['map:1'] },
        { proposal: proposal({ opId: 'proposal:event', targetUri: eventUri, targetPath: eventPath, before: eventBefore, after: eventAfter }), operationIds: ['event:1'] }
      ],
      workspaceRoot: root,
      operationLog: new MemoryOperationLogStore(),
      backupBaseDir: backupRoot
    });
    assert.equal(committed.changedFiles.length, 2);
    assert.equal(committed.diagnostics.some((item) => item.severity === 'error'), false);
    assert.equal(await readFile(mapPath, 'utf8'), mapAfter);
    assert.equal(await readFile(eventPath, 'utf8'), eventAfter);

    await writeFile(mapPath, mapBefore);
    await writeFile(eventPath, eventBefore);
    const rolledBack = await executeSemanticPatchProposalTransaction({
      changeSet: { ...changeSet, changeSetId: 'cs:production-boundary-rollback' },
      proposals: [
        { proposal: proposal({ opId: 'proposal:rollback-map', targetUri: mapUri, targetPath: mapPath, before: mapBefore, after: mapAfter }), operationIds: ['map:1'] },
        { proposal: proposal({ opId: 'proposal:rollback-event', targetUri: eventUri, targetPath: eventPath, before: eventBefore, after: eventAfter }), operationIds: ['event:1'] }
      ],
      workspaceRoot: root,
      operationLog: new MemoryOperationLogStore(),
      backupBaseDir: backupRoot,
      onCommitted: async () => {
        throw new Error('knowledge finalize deliberately failed');
      }
    });
    assert.equal(rolledBack.changedFiles.length, 0);
    assert.equal(rolledBack.diagnostics.some((item) => item.code === 'SEMANTIC_KNOWLEDGE_FINALIZE_FAILED'), true);
    assert.equal(await readFile(mapPath, 'utf8'), mapBefore);
    assert.equal(await readFile(eventPath, 'utf8'), eventBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  const task = createTaskModel('把 param row 50800000 的值修改并写回。');
  assert.equal(task.kind, 'modify');
  assert.equal(task.subgoals[0]?.status, 'active');
  assert.equal(task.subgoals[0]?.queryPlan.candidateTools.includes('resolve_canonical_entities'), true);
  assert.deepEqual(task.subgoals.map((subgoal) => subgoal.subgoalId.split(':').at(-1)), [
    'resolve', 'plan', 'validate', 'commit', 'verify'
  ]);
  assert.equal(task.subgoals[0]?.nextSubgoalId, task.subgoals[1]?.subgoalId);
  assert.equal(task.completionContract.predicates.some((predicate) => predicate.kind === 'committed'), true);
  const createGuard = await createDefaultToolRegistry().run('mutate_param_fields', {}, {
    workspaceIndex: null,
    mode: 'fullPermission',
    taskKind: 'create',
    explicitCreate: true
  });
  assert.equal(createGuard.ok, false);
  assert.equal(createGuard.error?.code, 'CREATE_NATIVE_COVERAGE_REQUIRED');

  const index = new WorkspaceIndex('semantic-smoke');
  index.setFiles([indexedFile('partial')]);
  index.upsertParamExport({
    paramName: 'NpcParam',
    rows: [{
      uri: rowUri,
      sourceUri,
      paramName: 'NpcParam',
      rowId: 50800000,
      rowName: 'Gyoubu'
    }]
  });
  index.rebuildReferences();
  const resolved = new SemanticResolver(index).resolveTarget({
    text: rowUri,
    kind: 'param_row',
    address: rowUri,
    exact: true
  });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.value?.nodes[0]?.identity, rowUri);
  assert.equal(resolved.facts[0]?.provenance, rowUri);
  assert.equal(resolved.coverage.status, 'FOUND');

  const dirtyEntity = {
    ...resolved.value!.nodes[0]!,
    displayName: 'dirty working copy',
    revision: 'working-1',
    epistemic: 'observed' as const
  };
  const dirtyRegistration = index.registerDirtyCanonicalDocument({
    documentId: 'editor:param:1',
    sourceUri,
    baseRevision: 'revision-1',
    revision: 'working-1',
    observation: { kind: 'canonical-read', sourceUri, revision: 'working-1' },
    entities: [dirtyEntity],
    observedAt: '2026-08-24T01:00:00.000Z',
    updatedAt: '2026-08-24T01:00:00.000Z'
  });
  assert.equal(dirtyRegistration.ok, true);
  assert.equal(index.getDirtyCanonicalDocument('editor:param:1')?.baseRevision, 'revision-1');
  assert.equal(index.listEffectiveDirtyCanonicalEntities()[0]?.identity, rowUri);
  const duplicateDirty = index.registerDirtyCanonicalDocument({
    documentId: 'editor:param:1',
    sourceUri,
    baseRevision: 'revision-1',
    revision: 'working-duplicate',
    observation: { kind: 'canonical-read', sourceUri, revision: 'working-duplicate' },
    entities: [{ ...dirtyEntity, revision: 'working-duplicate' }]
  });
  assert.equal(duplicateDirty.ok, false);
  assert.equal(duplicateDirty.code, 'DIRTY_CANONICAL_DUPLICATE');
  const dirtyResolved = new SemanticResolver(index).resolveTarget({
    text: rowUri,
    kind: 'param_row',
    address: rowUri,
    exact: true
  });
  assert.equal(dirtyResolved.status, 'RESOLVED');
  assert.equal(dirtyResolved.value?.nodes[0]?.displayName, 'dirty working copy');
  assert.equal(index.selectCanonicalProjection(rowUri).status, 'resolved');
  const staleWorkingUpdate = index.updateDirtyCanonicalDocument('editor:param:1', 'wrong-working-revision', {
    sourceUri,
    baseRevision: 'revision-1',
    revision: 'working-2',
    observation: { kind: 'canonical-read', sourceUri, revision: 'working-2' },
    entities: [{ ...dirtyEntity, displayName: 'should not install', revision: 'working-2' }]
  });
  assert.equal(staleWorkingUpdate.ok, false);
  assert.equal(staleWorkingUpdate.code, 'DIRTY_CANONICAL_REVISION_CONFLICT');
  assert.equal(index.getDirtyCanonicalDocument('editor:param:1')?.revision, 'working-1');
  const updatedDirty = index.updateDirtyCanonicalDocument('editor:param:1', 'working-1', {
    sourceUri,
    baseRevision: 'revision-1',
    revision: 'working-2',
    observation: { kind: 'canonical-read', sourceUri, revision: 'working-2' },
    entities: [{ ...dirtyEntity, displayName: 'updated dirty working copy', revision: 'working-2' }]
  });
  assert.equal(updatedDirty.ok, true);
  const conflictingDirty = index.registerDirtyCanonicalDocument({
    documentId: 'editor:param:2',
    sourceUri,
    baseRevision: 'revision-1',
    revision: 'working-other',
    observation: { kind: 'canonical-read', sourceUri, revision: 'working-other' },
    entities: [{ ...dirtyEntity, displayName: 'second working copy', revision: 'working-other' }]
  });
  assert.equal(conflictingDirty.ok, true);
  assert.equal(index.selectCanonicalProjection(rowUri).status, 'conflict');
  assert.equal(index.listDirtyCanonicalEntities().length, 0, '冲突 snapshot 不能作为默认 observed dirty fact');
  const conflictResolved = new SemanticResolver(index).resolveTarget({
    text: rowUri,
    kind: 'param_row',
    address: rowUri,
    exact: true
  });
  assert.equal(conflictResolved.status, 'AMBIGUOUS');
  assert.equal(conflictResolved.value, undefined);
  const wrongConflictClear = index.clearDirtyCanonicalDocument({
    documentId: 'editor:param:2',
    expectedRevision: 'wrong-working-revision',
    mode: 'discarded'
  });
  assert.equal(wrongConflictClear.ok, false);
  assert.equal(wrongConflictClear.code, 'DIRTY_CANONICAL_REVISION_CONFLICT');
  const clearedConflict = index.clearDirtyCanonicalDocument({
    documentId: 'editor:param:2',
    expectedRevision: 'working-other',
    mode: 'discarded'
  });
  assert.equal(clearedConflict.ok, true);
  assert.equal(index.getEffectiveCanonicalEntity(rowUri)?.displayName, 'updated dirty working copy');
  index.upsertFile({ ...indexedFile('partial'), sha256: 'revision-2' });
  assert.equal(index.selectCanonicalProjection(rowUri).status, 'stale');
  assert.equal(index.listDirtyCanonicalEntities().length, 0, 'stale snapshot 不能作为默认 observed dirty fact');
  const staleResolved = new SemanticResolver(index).resolveTarget({
    text: rowUri,
    kind: 'param_row',
    address: rowUri,
    exact: true
  });
  assert.equal(staleResolved.status, 'STALE');
  assert.equal(staleResolved.value, undefined);
  const staleUpdate = index.updateDirtyCanonicalDocument('editor:param:1', 'working-2', {
    sourceUri,
    baseRevision: 'revision-1',
    revision: 'working-3',
    observation: { kind: 'canonical-read', sourceUri, revision: 'working-3' },
    entities: [{ ...dirtyEntity, displayName: 'must not cross source revision', revision: 'working-3' }]
  });
  assert.equal(staleUpdate.ok, false);
  assert.equal(staleUpdate.code, 'DIRTY_CANONICAL_BASE_REVISION_CONFLICT');
  const committedClear = index.clearDirtyCanonicalDocument({
    documentId: 'editor:param:1',
    expectedRevision: 'working-2',
    mode: 'committed',
    authoritativeRevision: 'revision-2'
  });
  assert.equal(committedClear.ok, true);
  assert.equal(index.listDirtyCanonicalDocuments().length, 0);
  const deletion = index.registerDirtyCanonicalDocument({
    documentId: 'editor:param:delete',
    sourceUri,
    baseRevision: 'revision-2',
    revision: 'working-delete',
    observation: { kind: 'canonical-read', sourceUri, revision: 'working-delete' },
    entities: [],
    removedIdentities: [rowUri]
  });
  assert.equal(deletion.ok, true);
  assert.equal(index.selectCanonicalProjection(rowUri).status, 'suppressed');
  const deletedResolved = new SemanticResolver(index).resolveTarget({
    text: rowUri,
    kind: 'param_row',
    address: rowUri,
    exact: true
  });
  assert.equal(deletedResolved.status, 'COVERAGE_INCOMPLETE');
  assert.equal(deletedResolved.value, undefined);
  assert.equal(index.listEffectiveDirtyCanonicalEntities().length, 0);
  assert.equal(index.clearDirtyCanonicalDocument({
    documentId: 'editor:param:delete',
    expectedRevision: 'working-delete',
    mode: 'discarded'
  }).ok, true);
  assert.equal(selectEffectiveCanonicalProjection([
    { identity: rowUri, revision: 'base', layer: 'base', value: 'base', updatedAt: '2026-01-01T00:00:00Z' },
    { identity: rowUri, revision: 'dirty', layer: 'dirty', value: 'dirty', updatedAt: '2026-01-02T00:00:00Z' }
  ]).status, 'resolved');
  assert.equal(selectEffectiveCanonicalProjection([
    { identity: rowUri, revision: 'pending', layer: 'pending', value: 'pending', updatedAt: '2026-01-03T00:00:00Z', observation: 'pending-plan' }
  ]).status, 'empty');
  assert.equal(selectEffectiveCanonicalProjection([
    { identity: rowUri, revision: 'pending', layer: 'pending', value: 'pending', updatedAt: '2026-01-03T00:00:00Z', observation: 'pending-plan' }
  ], { includePending: true }).status, 'intent');
  const pendingDirtyRegistration = index.registerDirtyCanonicalDocument({
    documentId: 'editor:param:pending-plan',
    sourceUri,
    baseRevision: 'revision-2',
    revision: 'working-plan',
    observation: { kind: 'pending-plan', sourceUri, revision: 'working-plan' } as never,
    entities: [{ ...dirtyEntity, revision: 'working-plan' }]
  });
  assert.equal(pendingDirtyRegistration.ok, false);
  assert.equal(pendingDirtyRegistration.code, 'DIRTY_CANONICAL_INVALID_INPUT');

  const missing = new SemanticResolver(index).resolveTarget({
    text: 'missing row',
    kind: 'param_row',
    exact: false
  });
  assert.equal(missing.status, 'COVERAGE_INCOMPLETE');
  assert.equal(missing.coverage.status, 'PARTIALLY_INDEXED');

  const workflow = new ResolverWorkflowState('查找鬼形部');
  assert.equal(workflow.canProceedToStructuredDiscovery(), false);
  const discovery = { ok: true, content: JSON.stringify({ items: [], coverage: { status: 'PARTIALLY_INDEXED' } }) };
  workflow.rememberDiscovery('search_text_entries', { query: '鬼形部' }, discovery);
  assert.equal(workflow.canProceedToStructuredDiscovery(), true);
  assert.equal(workflow.getCachedDiscovery('search_text_entries', { query: '鬼形部' })?.content, discovery.content);
  workflow.invalidateDiscoveryCache();
  assert.equal(workflow.getCachedDiscovery('search_text_entries', { query: '鬼形部' }), undefined);
  assert.equal(workflow.canProceedToStructuredDiscovery(), false);

  const tracker = new NoProgressTracker();
  const noHit = { items: [], coverage: { status: 'PARTIALLY_INDEXED' } };
  assert.equal(tracker.observe({ subgoalId: 'resolve', result: noHit, candidateIds: [], coverageStatus: 'PARTIALLY_INDEXED' }).action, 'CONTINUE');
  assert.equal(tracker.observe({ subgoalId: 'resolve', result: noHit, candidateIds: [], coverageStatus: 'PARTIALLY_INDEXED' }).action, 'CONTINUE');
  assert.equal(tracker.observe({ subgoalId: 'resolve', result: noHit, candidateIds: [], coverageStatus: 'PARTIALLY_INDEXED' }).action, 'REPLAN');
  assert.equal(tracker.observe({ subgoalId: 'resolve', result: noHit, candidateIds: [], coverageStatus: 'FOUND' }).action, 'CONTINUE');
  const semanticRepeat = new NoProgressTracker();
  assert.equal(semanticRepeat.observe({
    subgoalId: 'resolve', result: JSON.stringify({ query: 'a', items: [], coverage: { status: 'PARTIALLY_INDEXED' } }), candidateIds: [], coverageStatus: 'PARTIALLY_INDEXED'
  }).action, 'CONTINUE');
  assert.equal(semanticRepeat.observe({
    subgoalId: 'resolve', result: JSON.stringify({ query: 'b', items: [], coverage: { status: 'PARTIALLY_INDEXED' } }), candidateIds: [], coverageStatus: 'PARTIALLY_INDEXED'
  }).action, 'CONTINUE');
  assert.equal(semanticRepeat.observe({
    subgoalId: 'resolve', result: JSON.stringify({ query: 'c', items: [], coverage: { status: 'PARTIALLY_INDEXED' } }), candidateIds: [], coverageStatus: 'PARTIALLY_INDEXED'
  }).action, 'REPLAN');

  const changeSet = createSemanticChangeSet({
    changeSetId: 'cs:semantic-smoke',
    baseRevision: 'revision-1',
    operations: [
      {
        operationId: 'param:1',
        domain: 'param',
        targetIdentity: rowUri,
        kind: 'set-field',
        beforeRevision: 'revision-1',
        dependencies: [],
        payload: { fieldId: 1, value: 2 }
      },
      {
        operationId: 'event:1',
        domain: 'event',
        targetIdentity: 'file://event/common.emevd#100',
        kind: 'set-arg',
        beforeRevision: 'revision-1',
        dependencies: ['param:1'],
        payload: { instruction: 0, argument: 1 }
      }
    ],
    postconditions: ['committed reread matches requested fields']
  });
  assert.deepEqual(changeSet.targetIdentities, [rowUri, 'file://event/common.emevd#100']);
  assert.deepEqual(changeSet.dependencyOrder, ['param:1', 'event:1']);
  assert.equal(validateSemanticChangeSet(changeSet, new Map([
    [rowUri, 'revision-1'],
    ['file://event/common.emevd#100', 'revision-1']
  ])).ok, true);
  assert.equal(reserveCollisionAwareId({ namespace: 'goods', used: [1, 2], reserved: [3], preferred: 3, min: 1, max: 10 }).value, 4);
  assert.equal(reserveCollisionAwareId({
    namespace: 'goods',
    used: [],
    baseGameIds: [1],
    modOverlayIds: [2],
    workspaceCurrentIds: [3],
    dirtyCanonicalIds: [4],
    pendingChangeSetIds: [5],
    preferred: 1,
    min: 1,
    max: 10
  }).value, 6, 'allocator must reserve every canonical/pending collision source');

  let contract = createCompletionContract({
    taskId: 'task:smoke',
    taskKind: 'modify',
    targetCount: 1,
    operationKeys: ['param', 'event'],
    postconditionKeys: ['param-reread', 'event-reread']
  });
  assert.equal(evaluateCompletionContract(contract).status, 'incomplete');
  const unkeyedEvidence = markPredicate(contract, 'postconditions_verified', true, ['evidence:unkeyed']);
  assert.equal(evaluateCompletionContract(unkeyedEvidence).status, 'incomplete', 'unkeyed evidence must not satisfy keyed postconditions');
  for (const predicate of contract.predicates) {
    contract = markPredicate(contract, predicate.kind, true, ['evidence:smoke'], undefined, predicate.key);
  }
  assert.equal(evaluateCompletionContract(contract).status, 'succeeded');

  // The loop must not merely log AGENT_REPLAN_REQUIRED and stop. Three
  // identical semantic discovery results must insert a fresh replan turn,
  // after which the adapter gets another opportunity to choose a new query.
  const replanScript = scriptedAdapter((callNumber) => callNumber <= 3
    ? toolCompletion('search_text_entries', `replan-${callNumber}`, JSON.stringify({ query: '鬼形部' }))
    : stopCompletion('replanned'));
  const replanRun = await runAgentToolLoop(replanScript.adapter, {
    config: smokeConfig('semantic-replan'),
    apiKey: '',
    messages: [{ role: 'user', content: '查找鬼形部' }],
    externalTaskGoal: '查找鬼形部',
    tools: [toolDefinition('search_text_entries', 'read')],
    permissionMode: 'normal',
    executeTool: async () => ({
      ok: true,
      content: JSON.stringify({ items: [], coverage: { status: 'PARTIALLY_INDEXED' } })
    }),
    maxSteps: 8
  });
  assert.equal(replanScript.calls(), 4);
  assert.equal(replanRun.finishReason, 'stop');
  assert.equal(replanRun.messages.some((message) => message.role === 'system'
    && message.content.startsWith('[agent-replan]')), true);
  assert.equal(replanRun.diagnostics.some((diagnostic) => diagnostic.code === 'AGENT_REPLAN_REQUIRED'), true);

  // Session host owns the default contract for modify/create tasks. The model
  // cannot satisfy it with prose: only typed tool evidence advances predicates.
  const sessionScript = scriptedAdapter((callNumber) => {
    if (callNumber === 1) return toolCompletion('resolve_canonical_entities', 'contract-resolve');
    if (callNumber === 2) return toolCompletion('propose_text_patch', 'contract-propose');
    if (callNumber === 3) return toolCompletion('commit_patch', 'contract-commit');
    return stopCompletion('committed');
  });
  const sessionDir = await mkdtemp(join(tmpdir(), 'soulforge-semantic-session-'));
  const targetGoal = '修改 param:GameParam row:1 并写回';
  const completionEvidence = (kind: import('../semantic/types.js').CompletionEvidence['kind']) => ({
    kind,
    evidenceIds: [`smoke:${kind}`],
    ...(
      kind === 'mutations_planned'
        ? { key: 'requested-mutations' }
        : kind === 'postconditions_verified'
          ? { key: 'requested-postconditions' }
          : {}
    )
  });
  try {
    const session = await runAgentSession({
      sessionsDir: sessionDir,
      adapter: sessionScript.adapter,
      config: smokeConfig('semantic-contract'),
      apiKey: '',
      prompt: targetGoal,
      permissionMode: 'normal',
      tools: [
        toolDefinition('resolve_canonical_entities', 'analyze'),
        toolDefinition('propose_text_patch', 'propose'),
        toolDefinition('commit_patch', 'commit')
      ],
      executeTool: async (call: ToolCall) => {
        if (call.name === 'resolve_canonical_entities') {
          return {
            ok: true,
            content: JSON.stringify({ status: 'RESOLVED', value: { nodes: [{ identity: 'param:GameParam/1' }] } }),
            completionEvidence: [completionEvidence('target_resolved')]
          };
        }
        if (call.name === 'propose_text_patch') {
          return {
            ok: true,
            content: JSON.stringify({ status: 'validated' }),
            completionEvidence: [completionEvidence('mutations_planned')]
          };
        }
        return {
          ok: true,
          content: JSON.stringify({ changedFiles: ['overlay/param/gameparam.param'] }),
          completionEvidence: [
            completionEvidence('mutations_planned'),
            completionEvidence('staged'),
            completionEvidence('validators_passed'),
            completionEvidence('committed'),
            completionEvidence('reread_verified'),
            completionEvidence('postconditions_verified'),
            completionEvidence('index_refreshed'),
            completionEvidence('rag_refreshed')
          ]
        };
      },
      externalTaskGoal: targetGoal
    });
    assert.equal(sessionScript.calls(), 4);
    assert.equal(session.run.taskModel?.kind, 'modify');
    assert.equal(session.run.finishReason, 'stop');
    assert.equal(session.run.completion?.status, 'succeeded');
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }

  await runWorkspaceTransactionSmoke();
  await runProductionSemanticPatchBoundarySmoke();

  console.log(JSON.stringify({
    ok: true,
    status: 'PASS',
    checks: ['task-model', 'resolver-graph', 'partial-coverage', 'resolver-cache', 'no-progress-replan', 'agent-replan', 'change-set', 'completion-contract', 'completion-evidence', 'collision-aware-id', 'workspace-semantic-transaction', 'production-semantic-patch-boundary']
  }));
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
