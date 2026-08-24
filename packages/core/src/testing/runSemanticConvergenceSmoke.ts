import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexedFile, RagChunk } from '@soulforge/shared';
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
import { parseRolloutLines } from '../model-services/rolloutRecorder.js';
import { OpenAiCompatibleAdapter } from '../model-services/openaiCompatibleAdapter.js';
import { createRagCorpus, mergeCatalogAndPersisted } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';
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

function indexedFileFor(input: {
  id: string;
  sourceUri: string;
  sourcePath: string;
  resourceKind: IndexedFile['resourceKind'];
  parseStatus: IndexedFile['parseStatus'];
  sha256: string;
}): IndexedFile {
  const base = indexedFile(input.parseStatus);
  return {
    ...base,
    id: input.id,
    sourceUri: input.sourceUri,
    sourcePath: input.sourcePath,
    resourceKind: input.resourceKind,
    relativePath: input.sourcePath,
    extension: '.fmg',
    compoundExtension: '.fmg',
    formatKind: 'fmg',
    formatLabel: 'FMG',
    sha256: input.sha256
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

/**
 * Agent-facing atomicity regression.  The low-level transaction smoke above
 * proves both commit and rollback; this wrapper proves the same failure is
 * visible through the actual tool-loop contract and cannot be mistaken for a
 * successful model turn.
 */
async function runAgentChangeSetAtomicitySmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-agent-change-set-'));
  const mapPath = join(root, 'map.txt');
  const eventPath = join(root, 'event.txt');
  const mapBefore = 'map-before\n';
  const eventBefore = 'event-before\n';
  const mapAfter = 'map-after\n';
  const eventAfter = 'event-after\n';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    await mkdir(join(root, '.staging'), { recursive: true });
    await mkdir(join(root, '.backups'), { recursive: true });
    await writeFile(mapPath, mapBefore);
    await writeFile(eventPath, eventBefore);

    const changeSet = createSemanticChangeSet({
      changeSetId: 'cs:agent-atomicity',
      baseRevision: 'agent-workspace-revision-1',
      operations: [
        {
          operationId: 'map:agent',
          domain: 'map',
          targetIdentity: 'file://map.txt',
          kind: 'replace',
          beforeRevision: hash(mapBefore),
          dependencies: [],
          payload: { value: mapAfter }
        },
        {
          operationId: 'event:agent',
          domain: 'event',
          targetIdentity: 'file://event.txt',
          kind: 'replace',
          beforeRevision: hash(eventBefore),
          dependencies: ['map:agent'],
          payload: { value: eventAfter }
        }
      ],
      postconditions: ['both domains reread after one atomic commit']
    });
    const contract = createCompletionContract({
      taskId: 'task:agent-atomicity',
      taskKind: 'modify',
      targetCount: 2,
      operationKeys: ['map:agent', 'event:agent'],
      postconditionKeys: ['map-reread', 'event-reread']
    });
    const scripted = scriptedAdapter((callNumber) => callNumber === 1
      ? toolCompletion('commit_semantic_change_set', 'agent-change-set', JSON.stringify({ changeSet }))
      : stopCompletion('已完成'));
    const run = await runAgentToolLoop(scripted.adapter, {
      config: smokeConfig('agent-atomicity'),
      apiKey: '',
      messages: [{ role: 'user', content: '同时修改地图和事件' }],
      externalTaskGoal: '同时修改地图和事件',
      tools: [toolDefinition('commit_semantic_change_set', 'commit')],
      permissionMode: 'full',
      completionContract: contract,
      maxSteps: 3,
      executeTool: async () => {
        const transaction = createWorkspaceTransaction({
          workspaceId: 'agent-atomicity',
          workspaceRoot: root,
          stagingBaseDir: join(root, '.staging'),
          backupBaseDir: join(root, '.backups')
        });
        const mapPatch = createPatchIr({
          workspaceId: 'agent-atomicity',
          title: 'agent map patch',
          author: 'ai',
          operations: [createTextEditOperation({
            targetUri: 'file://map.txt',
            targetPath: mapPath,
            newText: mapAfter,
            expectedHash: hash(mapBefore)
          })]
        });
        const eventPatch = createPatchIr({
          workspaceId: 'agent-atomicity',
          title: 'agent event patch',
          author: 'ai',
          operations: [createTextEditOperation({
            targetUri: 'file://event.txt',
            targetPath: eventPath,
            newText: eventAfter,
            expectedHash: hash(eventBefore)
          })]
        });
        const result = await executeSemanticWorkspaceTransaction({
          changeSet,
          currentRevisions: new Map([
            ['file://map.txt', hash(mapBefore)],
            ['file://event.txt', hash(eventBefore)]
          ]),
          transaction,
          domains: [
            {
              domain: 'map',
              operationIds: ['map:agent'],
              patch: mapPatch,
              rereadStaged: async () => ({
                ok: (await readFile(transaction.getCommitTargets()[0]!.stagingPath, 'utf8')) === mapAfter
              }),
              rereadCommitted: async () => ({ ok: (await readFile(mapPath, 'utf8')) === mapAfter }),
              verifyPostconditions: async () => ({ ok: true })
            },
            {
              domain: 'event',
              operationIds: ['event:agent'],
              patch: eventPatch,
              rereadStaged: async () => ({
                ok: (await readFile(transaction.getCommitTargets()[1]!.stagingPath, 'utf8')) === eventAfter
              }),
              rereadCommitted: async () => ({ ok: (await readFile(eventPath, 'utf8')) === eventAfter }),
              // Deliberate domain failure: the agent must see failure and the
              // already-staged map file must be rolled back with the event.
              verifyPostconditions: async () => ({ ok: false })
            }
          ]
        });
        return result.ok
          ? { ok: true, content: JSON.stringify(result) }
          : {
              ok: false,
              code: 'SEMANTIC_CHANGESET_ATOMICITY_FAILED',
              content: JSON.stringify(result)
            };
      }
    });
    assert.equal(run.finishReason, 'partial');
    assert.equal(run.completion?.status, 'incomplete');
    assert.equal(run.audit.toolCalls[0]?.ok, false);
    assert.equal(await readFile(mapPath, 'utf8'), mapBefore);
    assert.equal(await readFile(eventPath, 'utf8'), eventBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runSwitchModeSmoke(): Promise<void> {
  const registry = createDefaultToolRegistry();
  const modeContext: import('../ai/toolRegistry.js').ToolContext = {
    workspaceIndex: null,
    mode: 'plan'
  };
  const mutationModes: string[] = [];
  registry.register({
    name: 'commit_probe',
    description: 'semantic smoke commit probe',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {},
    run: (_input, context) => {
      mutationModes.push(context.mode);
      return { ok: true, data: { committed: true, mode: context.mode } };
    }
  });
  const scripted = scriptedAdapter((callNumber) => {
    if (callNumber === 1) {
      return toolCompletion('switch_mode', 'switch-full', JSON.stringify({ mode: 'fullPermission' }));
    }
    if (callNumber === 2) return toolCompletion('commit_probe', 'commit-after-switch');
    return stopCompletion('提交完成');
  });
  const run = await runAgentToolLoop(scripted.adapter, {
    config: smokeConfig('switch-mode'),
    apiKey: '',
    messages: [{ role: 'user', content: '先计划，再切换权限并提交' }],
    tools: registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: { type: 'object' },
      ...(tool.permissionLevel ? { permissionLevel: tool.permissionLevel } : {})
    })),
    permissionMode: 'plan',
    maxSteps: 4,
    executeTool: async (call, contextOverride) => {
      if (typeof contextOverride?.mode === 'string') {
        modeContext.mode = contextOverride.mode as typeof modeContext.mode;
      }
      let input: unknown = {};
      try {
        input = JSON.parse(call.argumentsJson);
      } catch {
        return { ok: false, code: 'INVALID_INPUT', content: 'invalid json' };
      }
      const result = await registry.run(call.name, input, modeContext);
      if (result.ok) return { ok: true, content: JSON.stringify(result.data ?? {}) };
      const code = result.error?.code;
      return code
        ? { ok: false, code, content: JSON.stringify(result.error ?? { code }) }
        : { ok: false, content: JSON.stringify(result.error ?? { code: 'TOOL_FAILED' }) };
    }
  });
  assert.equal(run.finishReason, 'stop');
  assert.deepEqual(mutationModes, ['fullPermission']);
  assert.equal(modeContext.mode, 'fullPermission');
  assert.equal(run.audit.toolCalls.every((call) => call.ok), true);
}

async function runProviderCapabilitySmoke(): Promise<void> {
  let requests = 0;
  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'capability-smoke-key',
    model: 'unsupported-reasoning-model',
    capabilityPolicy: 'explicit-or-fail-closed',
    capabilities: {
      tools: false,
      reasoningEffort: false,
      temperature: false,
      topP: false,
      maxTokens: false
    },
    fetchImpl: (async (_input, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // This local contract server models a provider that returns 400 for the
      // unsupported optional fields.  A correct capability-negotiated request
      // reaches the success response without any such field.
      if ('reasoning_effort' in body || 'tools' in body || 'temperature' in body
        || 'top_p' in body || 'max_tokens' in body) {
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () => 'unsupported optional field'
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
        text: async () => ''
      } as unknown as Response;
    }) as typeof fetch
  });
  const result = await adapter.complete({
    messages: [{ role: 'user', content: 'capability probe' }],
    tools: [toolDefinition('probe', 'read')],
    temperature: 0.2,
    topP: 0.8,
    maxTokens: 128,
    thinkingLevel: 'high'
  });
  assert.equal(requests, 1);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.diagnostics.length, 0);
  assert.equal(adapter.capabilityState.sources.reasoningEffort, 'explicit-config');
}

function ragSmokeCorpus(): ReturnType<typeof createRagCorpus> {
  const chunk = (chunkId: string, title: string, body: string): RagChunk => ({
    chunkId,
    workspaceId: 'semantic-agent-rag',
    sourceUri: 'file://semantic-agent-rag/notes.md',
    symbolUri: `note://${chunkId}`,
    family: 'file',
    title,
    body,
    numericIds: [],
    contentHash: `hash-${chunkId}`,
    sourceRevision: 'rag-revision-1'
  });
  return createRagCorpus({
    workspaceId: 'semantic-agent-rag',
    builtAt: '2026-08-25T00:00:00.000Z',
    chunks: [
      chunk('task-a', 'Task A', 'task A overview'),
      chunk('subgoal-b', 'Subgoal B', 'subgoal B authoritative fact')
    ],
    coverage: {
      status: 'FOUND',
      scope: 'rag',
      indexed: 2,
      expected: 2,
      successful: 2,
      failed: 0,
      completenessRatio: 1,
      resultCount: 0
    }
  });
}

async function runSubgoalRagSmoke(): Promise<void> {
  const corpus = ragSmokeCorpus();
  const queries: string[] = [];
  const injected: string[] = [];
  const adapter = scriptedAdapter((callNumber) => callNumber === 1
    ? toolCompletion('advance_subgoal', 'advance', JSON.stringify({}))
    : stopCompletion('subgoal B 已完成'));
  const run = await runAgentToolLoop(adapter.adapter, {
    config: smokeConfig('subgoal-rag'),
    apiKey: '',
    messages: [{ role: 'user', content: 'task A' }],
    externalTaskGoal: 'task A',
    tools: [toolDefinition('advance_subgoal', 'read')],
    permissionMode: 'plan',
    executeTool: async () => ({
      ok: true,
      content: JSON.stringify({ nextSubgoal: { subgoalId: 'subgoal:B', goal: 'subgoal B' } })
    }),
    ragSearch: {
      retrieve: async (query) => {
        queries.push(query);
        return retrieveEvidence(corpus, query);
      }
    },
  });
  for (const message of run.messages) {
    if (message.role === 'system' && message.content.startsWith('[rag-evidence')) injected.push(message.content);
  }
  assert.equal(run.finishReason, 'stop');
  assert.deepEqual(queries, ['task A', 'subgoal B']);
  assert.equal(injected.length, 0, 'ephemeral RAG messages must not enter durable run.messages');
}

async function runRagFreshnessSmoke(): Promise<void> {
  const sourceUri = 'file://semantic-freshness/param/game.param';
  const makeChunk = (revision: string, value: string): RagChunk => ({
    chunkId: `rag:param_row:fresh:${revision}`,
    workspaceId: 'semantic-freshness',
    sourceUri,
    symbolUri: 'param://Game/1',
    family: 'param_row',
    title: 'Game row 1',
    body: `row 1 value ${value}`,
    numericIds: [1],
    contentHash: `hash-${revision}`,
    sourceRevision: revision
  });
  const makeFileChunk = (revision: string): RagChunk => ({
    chunkId: `rag:file:fresh:${revision}`,
    workspaceId: 'semantic-freshness',
    sourceUri,
    symbolUri: sourceUri,
    family: 'file',
    title: 'game.param',
    body: `status parsed revision ${revision}`,
    numericIds: [],
    contentHash: `file-hash-${revision}`,
    sourceRevision: revision
  });
  const oldCorpus = createRagCorpus({
    workspaceId: 'semantic-freshness',
    builtAt: '2026-08-24T00:00:00.000Z',
    chunks: [makeFileChunk('rev-1'), makeChunk('rev-1', 'old')],
    coverage: {
      status: 'FOUND', scope: 'rag', indexed: 2, expected: 1, successful: 1,
      failed: 0, completenessRatio: 1, resultCount: 0, sourceRevision: 'rev-1'
    }
  });
  const currentCatalog = createRagCorpus({
    workspaceId: 'semantic-freshness',
    builtAt: '2026-08-25T00:00:00.000Z',
    chunks: [makeFileChunk('rev-2'), makeChunk('rev-2', 'new')],
    coverage: {
      status: 'FOUND', scope: 'rag', indexed: 2, expected: 1, successful: 1,
      failed: 0, completenessRatio: 1, resultCount: 0, sourceRevision: 'rev-2'
    }
  });
  const refreshed = mergeCatalogAndPersisted(currentCatalog, oldCorpus);
  assert.equal(refreshed.chunks.some((chunk) => chunk.body.includes('old')), false);
  assert.equal(refreshed.chunks.some((chunk) => chunk.body.includes('new')), true);
  assert.equal(refreshed.chunks.every((chunk) => chunk.sourceRevision === 'rev-2'), true);
  const newValue = retrieveEvidence(refreshed, 'new');
  assert.equal(newValue.ok, true);
  const oldValue = retrieveEvidence(refreshed, 'old');
  assert.equal(oldValue.ok, false);
  assert.equal(oldValue.code, 'insufficient_evidence');
}

async function runCompletionAndReplanSmoke(): Promise<void> {
  const evidence = (
    kind: import('../semantic/types.js').CompletionEvidence['kind'],
    key?: string
  ) => ({ kind, evidenceIds: [`evidence:${kind}`], ...(key ? { key } : {}) });
  const contract = createCompletionContract({
    taskId: 'task:premature',
    taskKind: 'modify',
    targetCount: 1,
    operationKeys: ['requested-mutations'],
    postconditionKeys: ['requested-postconditions']
  });
  const prematureAdapter = scriptedAdapter((callNumber) => {
    if (callNumber === 1) return toolCompletion('resolve_canonical_entities', 'premature-resolve');
    if (callNumber === 2) return toolCompletion('propose_text_patch', 'premature-propose');
    return stopCompletion('已完成');
  });
  const premature = await runAgentToolLoop(prematureAdapter.adapter, {
    config: smokeConfig('premature-completion'),
    apiKey: '',
    messages: [{ role: 'user', content: '修改一个参数并写回' }],
    externalTaskGoal: '修改一个参数并写回',
    tools: [
      toolDefinition('resolve_canonical_entities', 'analyze'),
      toolDefinition('propose_text_patch', 'propose')
    ],
    permissionMode: 'normal',
    completionContract: contract,
    maxSteps: 4,
    executeTool: async (call) => ({
      ok: true,
      content: JSON.stringify({ status: 'ok', tool: call.name }),
      completionEvidence: [call.name === 'resolve_canonical_entities'
        ? evidence('target_resolved')
        : evidence('mutations_planned', 'requested-mutations')]
    })
  });
  assert.equal(premature.finishReason, 'partial');
  assert.equal(premature.completion?.status, 'incomplete');
  assert.equal(premature.completion?.missing.some((item) => item.kind === 'committed'), true);
  assert.equal(premature.diagnostics.some((item) => item.code === 'COMPLETION_CONTRACT_INCOMPLETE'), true);

  const boundedAdapter = scriptedAdapter((callNumber) => callNumber <= 64
    ? toolCompletion('search_text_entries', `bounded-${callNumber}`, JSON.stringify({ query: `equivalent-${callNumber}` }))
    : stopCompletion('never reached'));
  const bounded = await runAgentToolLoop(boundedAdapter.adapter, {
    config: smokeConfig('bounded-replan'),
    apiKey: '',
    messages: [{ role: 'user', content: '反复搜索同一个未知实体' }],
    externalTaskGoal: '反复搜索同一个未知实体',
    tools: [toolDefinition('search_text_entries', 'read')],
    permissionMode: 'plan',
    maxSteps: 64,
    executeTool: async () => ({
      ok: true,
      content: JSON.stringify({ items: [], coverage: { status: 'PARTIALLY_INDEXED' } })
    })
  });
  assert.equal(bounded.steps < 64, true);
  assert.equal(bounded.finishReason, 'partial');
  assert.equal(bounded.diagnostics.some((item) => item.code === 'AGENT_REPLAN_EXHAUSTED'), true);
}

async function runContextResumeAndLogSmoke(): Promise<void> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'soulforge-agent-dod-session-'));
  try {
    const firstRequests: Array<readonly import('../model-services/types.js').ChatMessage[]> = [];
    let firstCalls = 0;
    const firstAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      complete: async (request) => {
        firstRequests.push(request.messages);
        firstCalls += 1;
        return firstCalls <= 10
          ? toolCompletion('context_probe', `context-${firstCalls}`)
          : stopCompletion('十步上下文完成');
      },
      async *stream() { /* complete path */ },
      listModels: async () => ({ ok: true, models: [] })
    };
    const first = await runAgentSession({
      sessionsDir: sessionDir,
      sessionId: 'context-ten-steps',
      adapter: firstAdapter,
      config: smokeConfig('context-ten-steps'),
      apiKey: '',
      prompt: '连续执行十步读取',
      systemPrompt: '旧运行时策略',
      systemPromptVersion: 'policy-v1',
      permissionMode: 'plan',
      tools: [toolDefinition('context_probe', 'read')],
      completionContract: { taskId: 'context-ten-steps', predicates: [] },
      maxSteps: 12,
      executeTool: async () => ({ ok: true, content: JSON.stringify({ observed: true }) }),
      ragSearch: {
        retrieve: async (query) => retrieveEvidence(ragSmokeCorpus(), query)
      }
    });
    const firstRollout = parseRolloutLines((await readFile(first.rolloutPath, 'utf8')).split(/\r?\n/));
    assert.equal(first.run.steps, 11);
    assert.equal(firstRequests.length, 11);
    assert.equal(firstRollout.messages.some((message) => message.content.startsWith('[rag-evidence')), false);
    assert.equal(firstRollout.meta?.systemPromptVersion, 'policy-v1');

    const oldResume = {
      ...firstRollout,
      messages: [
        { role: 'system' as const, content: '旧运行时策略' },
        ...firstRollout.messages
      ]
    };
    const resumeRequests: Array<readonly import('../model-services/types.js').ChatMessage[]> = [];
    const resumeAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      complete: async (request) => {
        resumeRequests.push(request.messages);
        return stopCompletion('resume done');
      },
      async *stream() { /* complete path */ },
      listModels: async () => ({ ok: true, models: [] })
    };
    const resumed = await runAgentSession({
      sessionsDir: sessionDir,
      sessionId: 'context-resumed-v2',
      adapter: resumeAdapter,
      config: smokeConfig('context-resumed-v2'),
      apiKey: '',
      prompt: '继续任务',
      systemPrompt: '当前运行时策略',
      systemPromptVersion: 'policy-v2',
      permissionMode: 'plan',
      tools: [],
      completionContract: { taskId: 'context-resumed-v2', predicates: [] },
      executeTool: async () => ({ ok: true, content: '' }),
      resumeFrom: oldResume
    });
    const resumedRequest = resumeRequests[0] ?? [];
    const systemMessages = resumedRequest.filter((message) => message.role === 'system');
    assert.deepEqual(systemMessages.map((message) => message.content), ['当前运行时策略']);
    assert.equal(resumedRequest.some((message) => message.content === '旧运行时策略'), false);
    const resumedRollout = parseRolloutLines((await readFile(resumed.rolloutPath, 'utf8')).split(/\r?\n/));
    assert.equal(resumedRollout.meta?.systemPromptVersion, 'policy-v2');

    const errorAdapter: ModelServiceAdapter = {
      protocol: 'openai-compatible',
      complete: async () => ({
        message: { role: 'assistant', content: '' },
        finishReason: 'error' as const,
        diagnostics: [{ severity: 'error' as const, code: 'MODEL_SERVICE_AUTH_ERROR', message: 'provider rejected request' }]
      }),
      async *stream() { /* complete path */ },
      listModels: async () => ({ ok: true, models: [] })
    };
    const errored = await runAgentSession({
      sessionsDir: sessionDir,
      sessionId: 'truthful-error',
      adapter: errorAdapter,
      config: smokeConfig('truthful-error'),
      apiKey: '',
      prompt: '验证错误日志',
      permissionMode: 'plan',
      tools: [],
      completionContract: { taskId: 'truthful-error', predicates: [] },
      maxSteps: 4,
      executeTool: async () => ({ ok: true, content: '' })
    });
    const errorRollout = parseRolloutLines((await readFile(errored.rolloutPath, 'utf8')).split(/\r?\n/));
    assert.equal(errored.run.finishReason, 'error');
    assert.equal(errored.run.steps, 1);
    assert.equal(errorRollout.terminal?.finishReason, 'error');
    assert.equal(errorRollout.terminal?.taskStatus, 'error');
    assert.equal(errorRollout.terminal?.steps, 1);
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
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
  index.setFiles([
    indexedFile('partial'),
    indexedFileFor({
      id: 'fmg-file',
      sourceUri: 'file://msg/Goods.fmg',
      sourcePath: 'msg/Goods.fmg',
      resourceKind: 'msg',
      parseStatus: 'parsed',
      sha256: 'fmg-revision-1'
    })
  ]);
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
  index.upsertMsgExport({
    category: 'Goods',
    entries: [{
      uri: 'msg://Goods/70000000',
      sourceUri: 'file://msg/Goods.fmg',
      category: 'Goods',
      textId: 70000000,
      text: '鬼形部的说明',
      confidence: 'high'
    }]
  });
  index.rebuildReferences();

  // 122: natural-language entity E2E.  The resolver consumes the indexed
  // symbol graph; the prompt contains no numeric ID and no system-prompt
  // lookup table is involved.
  const natural = new SemanticResolver(index).resolveTarget({
    text: 'Gyoubu',
    kind: 'param_row',
    exact: false
  });
  assert.equal(natural.status, 'RESOLVED');
  assert.equal(natural.value?.nodes[0]?.identity, rowUri);
  const resolverTool = await createDefaultToolRegistry().run(
    'resolve_canonical_entities',
    { query: 'Gyoubu', kind: 'param_row' },
    { workspaceIndex: index, mode: 'plan' }
  );
  assert.equal(resolverTool.ok, true);
  assert.equal((resolverTool.data as { status?: string } | undefined)?.status, 'RESOLVED');

  // 123: an FMG label alone is not an authoritative relation.  The graph is
  // allowed to expose the text entity, but it may not invent a Goods/param ID
  // or a relation edge that the index did not build.
  const textOnly = new SemanticResolver(index).resolveTarget({
    text: '鬼形部的说明',
    kind: 'text_entry',
    exact: false
  });
  assert.equal(textOnly.status, 'RESOLVED');
  assert.equal(textOnly.value?.nodes[0]?.identity, 'msg://Goods/70000000');
  assert.equal(textOnly.value?.edges.length, 0);
  assert.equal(textOnly.facts.some((fact) => fact.subject === rowUri), false);

  // 124: a zero-hit lookup in a partial index is unresolved, not a negative
  // fact and not permission to guess a neighboring row.
  const incompleteTool = await createDefaultToolRegistry().run(
    'resolve_canonical_entities',
    { query: '不存在的敌人', kind: 'param_row' },
    { workspaceIndex: index, mode: 'plan' }
  );
  assert.equal(incompleteTool.ok, true);
  const incompleteData = incompleteTool.data as { status?: string; value?: unknown; coverage?: { status?: string } };
  assert.equal(incompleteData.status, 'COVERAGE_INCOMPLETE');
  assert.equal(incompleteData.value, undefined);
  assert.equal(incompleteData.coverage?.status, 'PARTIALLY_INDEXED');

  // 125: an exact address bypasses natural-language ranking and reads the
  // requested canonical identity directly.
  const exactTool = await createDefaultToolRegistry().run(
    'resolve_canonical_entities',
    { query: rowUri, kind: 'param_row', address: rowUri },
    { workspaceIndex: index, mode: 'plan' }
  );
  assert.equal(exactTool.ok, true);
  assert.equal((exactTool.data as { status?: string } | undefined)?.status, 'RESOLVED');
  assert.equal((exactTool.data as { value?: { nodes?: Array<{ identity?: string }> } } | undefined)?.value?.nodes?.[0]?.identity, rowUri);
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

  // 129: weak diagnostic evidence cannot enter the observed canonical-read
  // projection. It must remain a hypothesis outside this boundary instead of
  // being silently promoted to a confirmed/derived fact.
  const hypothesisRegistration = index.registerDirtyCanonicalDocument({
    documentId: 'editor:param:hypothesis',
    sourceUri,
    baseRevision: 'revision-2',
    revision: 'working-hypothesis',
    observation: { kind: 'canonical-read', sourceUri, revision: 'working-hypothesis' },
    entities: [{
      ...resolved.value!.nodes[0]!,
      displayName: 'weakly suggested Gyoubu',
      revision: 'working-hypothesis',
      epistemic: 'hypothesized'
    }]
  });
  assert.equal(hypothesisRegistration.ok, false);
  assert.equal(hypothesisRegistration.code, 'DIRTY_CANONICAL_INVALID_INPUT');

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

  await runCompletionAndReplanSmoke();
  await runSwitchModeSmoke();
  await runSubgoalRagSmoke();
  await runRagFreshnessSmoke();
  await runContextResumeAndLogSmoke();
  await runProviderCapabilitySmoke();
  await runAgentChangeSetAtomicitySmoke();
  await runWorkspaceTransactionSmoke();
  await runProductionSemanticPatchBoundarySmoke();

  console.log(JSON.stringify({
    ok: true,
    status: 'PASS',
    checks: [
      'task-model', 'natural-language-entity', 'fmg-no-authoritative-join',
      'incomplete-coverage-zero-hit', 'exact-address', 'resolver-graph',
      'partial-coverage', 'resolver-cache', 'epistemic-boundary',
      'no-progress-replan', 'bounded-replan', 'completion-contract',
      'premature-completion', 'completion-evidence', 'switch-mode',
      'change-set-atomicity', 'collision-aware-id', 'ten-step-context',
      'subgoal-aware-rag', 'write-freshness-boundary', 'resume-prompt-version',
      'provider-capability', 'log-truthfulness', 'workspace-semantic-transaction',
      'production-semantic-patch-boundary'
    ]
  }));
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
