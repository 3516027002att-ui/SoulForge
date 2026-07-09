/**
 * Scaffold ToolRegistry with policy gate and typed results.
 * Tools call core scaffold only — never write files directly.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  AgentPlan,
  AuditLogStore,
  EvidencePack,
  PatchIR,
  PolicyDecision,
  ToolDefinition,
  ToolPermission,
  TypedToolResult
} from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { createAuditEntry, MemoryAuditLogStore } from '../audit-log/memoryAuditLog.js';
import {
  createPatchIr,
  createTextEditOperation,
  validatePatchIr
} from '../patch-engine/patchIr.js';
import { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';
import {
  createWorkspaceTransaction,
  type WorkspaceTransaction
} from '../transactions/workspaceTransaction.js';
import { evaluatePolicyGate, maxPermissionFromMode } from './policyGate.js';

export interface ScaffoldToolContext {
  workspaceId: string;
  workspaceRoot: string;
  mode: 'plan' | 'normal' | 'fullPermission';
  graph?: MemoryResourceGraph;
  transaction?: WorkspaceTransaction;
  auditLog?: AuditLogStore;
  confirmationReceiptIds?: string[];
  /** Mutable bag for propose/stage/commit chain in tests. */
  state?: ScaffoldToolState;
}

export interface ScaffoldToolState {
  lastPatch?: PatchIR;
  lastTransaction?: WorkspaceTransaction;
  graph: MemoryResourceGraph;
}

type ToolHandler = (
  input: unknown,
  context: ScaffoldToolContext
) => Promise<TypedToolResult> | TypedToolResult;

interface RegisteredScaffoldTool extends ToolDefinition {
  run: ToolHandler;
}

export class ScaffoldToolRegistry {
  private readonly tools = new Map<string, RegisteredScaffoldTool>();

  registerTool(tool: RegisteredScaffoldTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  getTool(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    const { run: _run, ...definition } = tool;
    return definition;
  }

  listTools(): ToolDefinition[] {
    return [...this.tools.values()].map(({ run: _run, ...definition }) => definition);
  }

  async executeToolThroughPolicy(
    name: string,
    input: unknown,
    context: ScaffoldToolContext
  ): Promise<TypedToolResult> {
    const toolCallId = randomUUID();
    const startedAt = new Date().toISOString();
    const auditLog = context.auditLog ?? new MemoryAuditLogStore();
    const tool = this.tools.get(name);

    if (!tool) {
      const decision: PolicyDecision = {
        kind: 'deny',
        reason: `Unknown tool: ${name}`,
        code: 'TOOL_NOT_FOUND',
        requiredPermission: 'read',
        grantedPermission: maxPermissionFromMode(context.mode)
      };
      return denyResult(name, toolCallId, startedAt, decision, [
        createDiagnostic({
          severity: 'error',
          code: 'TOOL_NOT_FOUND',
          message: `Unknown tool: ${name}`
        })
      ]);
    }

    const decision = evaluatePolicyGate({
      mode: context.mode,
      maxPermission: maxPermissionFromMode(context.mode),
      toolName: name,
      requiredPermission: tool.permission,
      ...(context.confirmationReceiptIds
        ? { confirmationReceiptIds: context.confirmationReceiptIds }
        : {})
    });

    auditLog.append(createAuditEntry({
      actor: { kind: 'agent', id: 'scaffold-tool-registry' },
      eventKind: 'policy_decision',
      toolCallId,
      details: { toolName: name, decision },
      diagnostics: []
    }));

    if (decision.kind !== 'allow') {
      const result = denyResult(name, toolCallId, startedAt, decision, [
        createDiagnostic({
          severity: 'error',
          code: decision.code,
          message: decision.reason
        })
      ]);
      auditLog.append(createAuditEntry({
        actor: { kind: 'agent', id: 'scaffold-tool-registry' },
        eventKind: 'tool_call',
        toolCallId,
        diagnostics: result.diagnostics,
        details: { toolName: name, ok: false, decision }
      }));
      return result;
    }

    try {
      // Keep a shared mutable state bag across chained tool calls.
      const state = ensureState(context);
      const result = await tool.run(input, {
        ...context,
        auditLog,
        state
      });
      const finished: TypedToolResult = {
        ...result,
        toolCallId,
        policyDecision: decision,
        audit: {
          toolCallId,
          toolName: name,
          permission: tool.permission,
          decision,
          startedAt,
          finishedAt: new Date().toISOString(),
          ok: result.ok,
          diagnostics: result.diagnostics
        }
      };
      const patchId = typeof (result.data as { patchId?: string } | undefined)?.patchId === 'string'
        ? (result.data as { patchId: string }).patchId
        : undefined;
      auditLog.append(createAuditEntry({
        actor: { kind: 'agent', id: 'scaffold-tool-registry' },
        eventKind: 'tool_call',
        toolCallId,
        ...(patchId ? { patchId } : {}),
        diagnostics: result.diagnostics,
        details: { toolName: name, ok: result.ok }
      }));
      return finished;
    } catch (error) {
      const decisionFail = decision;
      return denyResult(name, toolCallId, startedAt, decisionFail, [
        createDiagnostic({
          severity: 'error',
          code: 'TOOL_EXCEPTION',
          message: error instanceof Error ? error.message : String(error)
        })
      ]);
    }
  }
}

export function createScaffoldToolRegistry(): ScaffoldToolRegistry {
  const registry = new ScaffoldToolRegistry();

  registry.registerTool({
    name: 'workspace.stats',
    description: 'Return scaffold workspace stats from resource graph.',
    permission: 'read',
    inputSchema: {
      schemaId: 'workspace.stats.input',
      schemaVersion: '1',
      shape: {}
    },
    resultSchema: {
      schemaId: 'workspace.stats.result',
      schemaVersion: '1',
      shape: { nodeCount: 'number', edgeCount: 'number' }
    },
    run: (_input, context) => {
      const graph = ensureGraph(context);
      const data = graph.toData();
      return okResult('workspace.stats', {
        workspaceId: context.workspaceId,
        nodeCount: data.nodes.length,
        edgeCount: data.edges.length,
        version: data.version
      }, [], [{ uri: `workspace://${context.workspaceId}`, kind: 'workspace' }]);
    }
  });

  registry.registerTool({
    name: 'resource.graph.query',
    description: 'Query the in-memory resource graph.',
    permission: 'analyze',
    inputSchema: {
      schemaId: 'resource.graph.query.input',
      schemaVersion: '1',
      shape: { limit: 'number' }
    },
    resultSchema: {
      schemaId: 'resource.graph.query.result',
      schemaVersion: '1',
      shape: { nodes: 'array', edges: 'array' }
    },
    run: (input, context) => {
      const graph = ensureGraph(context);
      const limit = asNumber((asRecord(input)).limit, 50);
      const result = graph.query({ limit, includeDiagnostics: true, includeProvenance: true });
      return okResult('resource.graph.query', result, [], result.nodes.map((node) => ({
        uri: node.uri,
        kind: node.kind
      })));
    }
  });

  registry.registerTool({
    name: 'patch.proposeTextEdit',
    description: 'Propose a text edit PatchIR without writing files.',
    permission: 'propose',
    inputSchema: {
      schemaId: 'patch.proposeTextEdit.input',
      schemaVersion: '1',
      shape: {
        targetUri: 'string',
        targetPath: 'string',
        newText: 'string',
        title: 'string'
      }
    },
    resultSchema: {
      schemaId: 'patch.proposeTextEdit.result',
      schemaVersion: '1',
      shape: { patch: 'PatchIR' }
    },
    run: (input, context) => {
      const value = asRecord(input);
      const targetUri = asString(value.targetUri, '');
      const targetPath = asString(value.targetPath, '');
      const newText = asString(value.newText, '');
      const title = asString(value.title, 'scaffold text edit');
      if (!targetUri || !targetPath) {
        return failTyped('patch.proposeTextEdit', 'INVALID_INPUT', 'targetUri and targetPath are required.');
      }
      const op = createTextEditOperation({ targetUri, targetPath, newText, resourceKind: 'msg' });
      const patch = createPatchIr({
        workspaceId: context.workspaceId,
        title,
        author: 'ai',
        operations: [op]
      });
      const validation = validatePatchIr(patch);
      ensureState(context).lastPatch = patch;
      return {
        ok: validation.ok,
        toolName: 'patch.proposeTextEdit',
        toolCallId: 'pending',
        data: { patch, validation },
        summary: validation.ok ? 'PatchIR proposed' : 'PatchIR invalid',
        diagnostics: validation.diagnostics,
        evidenceRefs: [{ uri: targetUri, kind: 'resource' }],
        policyDecision: allowPlaceholder('propose'),
        audit: placeholderAudit('patch.proposeTextEdit', 'propose')
      };
    }
  });

  registry.registerTool({
    name: 'patch.stage',
    description: 'Stage the last proposed patch via WorkspaceTransaction.',
    permission: 'stage',
    inputSchema: {
      schemaId: 'patch.stage.input',
      schemaVersion: '1',
      shape: { patch: 'PatchIR?' }
    },
    resultSchema: {
      schemaId: 'patch.stage.result',
      schemaVersion: '1',
      shape: { stagingRoot: 'string' }
    },
    run: async (input, context) => {
      const state = ensureState(context);
      const value = asRecord(input);
      const patch = (value.patch as PatchIR | undefined) ?? state.lastPatch;
      if (!patch) {
        return failTyped('patch.stage', 'NO_PATCH', 'No patch available to stage.');
      }
      const tx = createWorkspaceTransaction({
        workspaceId: context.workspaceId,
        workspaceRoot: context.workspaceRoot,
        actor: { kind: 'agent', id: 'patch.stage' },
        ...(context.auditLog ? { auditLog: context.auditLog } : {})
      });
      const added = tx.addPatch(patch);
      if (!added.ok) {
        return failTyped('patch.stage', 'PATCH_INVALID', 'Patch failed validation before stage.', added.diagnostics);
      }
      const staged = await tx.stage();
      state.lastTransaction = tx;
      state.lastPatch = patch;
      return {
        ok: staged.ok,
        toolName: 'patch.stage',
        toolCallId: 'pending',
        data: {
          transactionId: tx.transactionId,
          stagingRoot: staged.stagingRoot,
          status: tx.getStatus()
        },
        summary: staged.ok ? 'Patch staged' : 'Stage failed',
        diagnostics: staged.diagnostics,
        evidenceRefs: patch.affectedResources.map((uri) => ({ uri, kind: 'resource' })),
        policyDecision: allowPlaceholder('stage'),
        audit: placeholderAudit('patch.stage', 'stage')
      };
    }
  });

  registry.registerTool({
    name: 'patch.validate',
    description: 'Validate staged patch output.',
    permission: 'validate',
    inputSchema: {
      schemaId: 'patch.validate.input',
      schemaVersion: '1',
      shape: {}
    },
    resultSchema: {
      schemaId: 'patch.validate.result',
      schemaVersion: '1',
      shape: { ok: 'boolean' }
    },
    run: async (_input, context) => {
      const tx = ensureState(context).lastTransaction;
      if (!tx) return failTyped('patch.validate', 'NO_TRANSACTION', 'No staged transaction.');
      const result = await tx.validate();
      return {
        ok: result.ok,
        toolName: 'patch.validate',
        toolCallId: 'pending',
        data: { status: tx.getStatus() },
        summary: result.ok ? 'Validation passed' : 'Validation failed',
        diagnostics: result.diagnostics,
        evidenceRefs: [],
        policyDecision: allowPlaceholder('validate'),
        audit: placeholderAudit('patch.validate', 'validate')
      };
    }
  });

  registry.registerTool({
    name: 'patch.commit',
    description: 'Commit staged patch through WorkspaceTransaction (policy gated).',
    permission: 'commit',
    inputSchema: {
      schemaId: 'patch.commit.input',
      schemaVersion: '1',
      shape: {}
    },
    resultSchema: {
      schemaId: 'patch.commit.result',
      schemaVersion: '1',
      shape: { committedPaths: 'string[]' }
    },
    run: async (_input, context) => {
      const tx = ensureState(context).lastTransaction;
      if (!tx) return failTyped('patch.commit', 'NO_TRANSACTION', 'No transaction to commit.');
      const result = await tx.commit();
      return {
        ok: result.ok,
        toolName: 'patch.commit',
        toolCallId: 'pending',
        data: {
          transactionId: result.transactionId,
          committedPaths: result.committedPaths,
          status: tx.getStatus()
        },
        summary: result.ok ? 'Commit succeeded' : 'Commit failed',
        diagnostics: result.diagnostics,
        evidenceRefs: result.committedPaths.map((path) => ({ uri: path, kind: 'file' })),
        policyDecision: allowPlaceholder('commit'),
        audit: placeholderAudit('patch.commit', 'commit')
      };
    }
  });

  registry.registerTool({
    name: 'patch.rollback',
    description: 'Rollback last committed transaction (policy gated, audited).',
    permission: 'rollback',
    inputSchema: {
      schemaId: 'patch.rollback.input',
      schemaVersion: '1',
      shape: {}
    },
    resultSchema: {
      schemaId: 'patch.rollback.result',
      schemaVersion: '1',
      shape: { restoredPaths: 'string[]' }
    },
    run: async (_input, context) => {
      const tx = ensureState(context).lastTransaction;
      if (!tx) return failTyped('patch.rollback', 'NO_TRANSACTION', 'No transaction to rollback.');
      const result = await tx.rollback();
      return {
        ok: result.ok,
        toolName: 'patch.rollback',
        toolCallId: 'pending',
        data: {
          transactionId: result.transactionId,
          restoredPaths: result.restoredPaths,
          status: tx.getStatus()
        },
        summary: result.ok ? 'Rollback succeeded' : 'Rollback failed',
        diagnostics: result.diagnostics,
        evidenceRefs: result.restoredPaths.map((path) => ({ uri: path, kind: 'file' })),
        policyDecision: allowPlaceholder('rollback'),
        audit: placeholderAudit('patch.rollback', 'rollback')
      };
    }
  });

  return registry;
}

export function createMockEvidencePack(workspaceId: string, uris: string[]): EvidencePack {
  return {
    packId: randomUUID(),
    workspaceId,
    createdAt: new Date().toISOString(),
    resources: uris.map((uri) => ({ uri })),
    diagnostics: []
  };
}

export function createMockAgentPlan(goal: string): AgentPlan {
  return {
    planId: randomUUID(),
    title: 'Scaffold plan',
    goal,
    createdAt: new Date().toISOString(),
    mode: 'plan',
    steps: [
      {
        stepId: randomUUID(),
        title: 'Collect workspace stats',
        toolName: 'workspace.stats',
        requiredPermission: 'read',
        preconditions: [],
        expectedEvidence: ['workspace stats'],
        onFailure: 'abort',
        confirmationRequired: false
      },
      {
        stepId: randomUUID(),
        title: 'Propose text edit',
        toolName: 'patch.proposeTextEdit',
        requiredPermission: 'propose',
        preconditions: ['target exists'],
        expectedEvidence: ['PatchIR'],
        onFailure: 'ask_user',
        confirmationRequired: false
      }
    ]
  };
}

export async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

function ensureGraph(context: ScaffoldToolContext): MemoryResourceGraph {
  return ensureState(context).graph;
}

function ensureState(context: ScaffoldToolContext): ScaffoldToolState {
  if (!context.state) {
    context.state = {
      graph: context.graph ?? new MemoryResourceGraph(context.workspaceId),
      ...(context.transaction ? { lastTransaction: context.transaction } : {})
    };
  }
  return context.state;
}

function okResult(
  toolName: string,
  data: unknown,
  diagnostics: TypedToolResult['diagnostics'],
  evidenceRefs: TypedToolResult['evidenceRefs']
): TypedToolResult {
  return {
    ok: true,
    toolName,
    toolCallId: 'pending',
    data,
    summary: `${toolName} ok`,
    diagnostics,
    evidenceRefs,
    policyDecision: allowPlaceholder('read'),
    audit: placeholderAudit(toolName, 'read')
  };
}

function failTyped(
  toolName: string,
  code: string,
  message: string,
  diagnostics: TypedToolResult['diagnostics'] = []
): TypedToolResult {
  const all = [
    ...diagnostics,
    createDiagnostic({ severity: 'error', code, message })
  ];
  return {
    ok: false,
    toolName,
    toolCallId: 'pending',
    summary: message,
    diagnostics: all,
    evidenceRefs: [],
    policyDecision: {
      kind: 'deny',
      reason: message,
      code,
      requiredPermission: 'read',
      grantedPermission: 'read'
    },
    audit: placeholderAudit(toolName, 'read')
  };
}

function denyResult(
  toolName: string,
  toolCallId: string,
  startedAt: string,
  decision: PolicyDecision,
  diagnostics: TypedToolResult['diagnostics']
): TypedToolResult {
  return {
    ok: false,
    toolName,
    toolCallId,
    summary: decision.reason,
    diagnostics,
    evidenceRefs: [],
    policyDecision: decision,
    audit: {
      toolCallId,
      toolName,
      permission: decision.requiredPermission,
      decision,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      diagnostics
    }
  };
}

function allowPlaceholder(permission: ToolPermission): PolicyDecision {
  return {
    kind: 'allow',
    reason: 'placeholder',
    code: 'POLICY_ALLOW',
    requiredPermission: permission,
    grantedPermission: permission
  };
}

function placeholderAudit(toolName: string, permission: ToolPermission) {
  return {
    toolCallId: 'pending',
    toolName,
    permission,
    decision: allowPlaceholder(permission),
    startedAt: new Date().toISOString(),
    diagnostics: [] as TypedToolResult['diagnostics']
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
