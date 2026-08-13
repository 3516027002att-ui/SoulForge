/**
 * EMEVD four-view document controller — single revision, selection sync,
 * structured mutations only (no DSL parse pollution of valid mutations).
 */

import { randomUUID } from 'node:crypto';
import type {
  EmevdDslCompileRequest,
  EmevdDslCompileResult,
  EmevdEditorDocument,
  EmevdEditorMutation,
  EmevdEventIr,
  EmevdMutationPlan,
  EmevdSelection,
  EmevdViewId
} from '@soulforge/shared';
import type { OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { mutateInstructionArg } from '../emevd/emedfSchema.js';
import { compileEmevdPatchDsl } from '../emevd/dslCompiler.js';
import { attachEmevdStableIdentity, formatEmevdAnchor } from '../emevd/stableIdentity.js';
import { decodeStrictBase64 } from '../util/base64.js';
import {
  commitEmevdPlanViaPatchEngine,
  type EmevdPlanCommitResult
} from './emevdPlanCommit.js';

export interface EmevdFourViewState {
  document: EmevdEditorDocument;
  selection: EmevdSelection;
  dslText: string;
  tableRows: Array<{
    eventId: number;
    restBehavior: number;
    instructionCount: number;
    eventUri: string;
  }>;
}

export function createEmevdEditorDocument(input: {
  resourceUri: string;
  events: Array<{
    eventId: number;
    restBehavior: number;
    layer?: number;
    instructions?: Array<{ bank: number; id: number; argsBase64?: string; unknown?: boolean }>;
  }>;
  bytesBase64?: string;
  documentInstanceId?: string;
}): EmevdEditorDocument {
  const events: EmevdEventIr[] = input.events.map((event) => {
    const eventUri = `${input.resourceUri}#event/${event.eventId}`;
    return {
      eventUri,
      eventId: event.eventId,
      restBehavior: event.restBehavior,
      layer: event.layer ?? -1,
      instructions: (event.instructions ?? []).map((instr, index) => ({
        instructionUri: `${eventUri}/instr/${index}`,
        bank: instr.bank,
        id: instr.id,
        argsBase64: instr.argsBase64 ?? '',
        unknown: instr.unknown ?? true
      }))
    };
  });
  return attachEmevdStableIdentity({
    schemaVersion: 1,
    resourceUri: input.resourceUri,
    revision: 0,
    events,
    bytesBase64: input.bytesBase64 ?? '',
    diagnostics: events.some((e) => e.instructions.some((i) => i.unknown))
      ? [{
          severity: 'info',
          code: 'EMEVD_UNKNOWN_INSTRUCTIONS_PRESERVED',
          message: '未知 instruction 已保留为不透明 payload，禁止无 schema 的结构化修改。'
        }]
      : []
  }, input.documentInstanceId !== undefined
    ? { documentInstanceId: input.documentInstanceId }
    : undefined);
}

export function renderEmevdDsl(document: EmevdEditorDocument): string {
  const lines = ['// EMEVD structural DSL (read/write limited to supported mutations)', `$Resource ${document.resourceUri}`];
  for (const event of document.events) {
    const eventAnchor = event.anchor ? ` // ${formatEmevdAnchor('event', event.anchor)}` : '';
    lines.push(`$Event(${event.eventId}, Rest=${event.restBehavior}, Layer=${event.layer}) {${eventAnchor}`);
    for (const instr of event.instructions) {
      const tag = instr.unknown ? 'unknown' : 'typed';
      const instructionAnchor = instr.anchor
        ? ` // ${formatEmevdAnchor('instruction', instr.anchor)}`
        : '';
      lines.push(`  ${tag} bank=${instr.bank} id=${instr.id} args=${instr.argsBase64 || '""'};${instructionAnchor}`);
    }
    lines.push('}');
  }
  return lines.join('\n');
}

export function buildFourViewState(
  document: EmevdEditorDocument,
  selection: EmevdSelection
): EmevdFourViewState {
  return {
    document,
    selection,
    dslText: renderEmevdDsl(document),
    tableRows: document.events.map((event) => ({
      eventId: event.eventId,
      restBehavior: event.restBehavior,
      instructionCount: event.instructions.length,
      eventUri: event.eventUri
    }))
  };
}

export function selectEmevdView(
  selection: EmevdSelection,
  view: EmevdViewId,
  eventUri?: string,
  instructionUri?: string
): EmevdSelection {
  return {
    view,
    ...(eventUri ? { eventUri } : selection.eventUri ? { eventUri: selection.eventUri } : {}),
    ...(instructionUri
      ? { instructionUri }
      : selection.instructionUri && eventUri === selection.eventUri
        ? { instructionUri: selection.instructionUri }
        : {})
  };
}

/**
 * Apply a structured mutation. DSL text is never parsed for mutations here —
 * invalid DSL cannot pollute the document.
 */
export function applyEmevdEditorMutation(
  document: EmevdEditorDocument,
  mutation: EmevdEditorMutation
): { ok: true; document: EmevdEditorDocument } | { ok: false; code: string; message: string } {
  if (mutation.baseRevision !== document.revision) {
    return {
      ok: false,
      code: 'EDITOR_REVISION_CONFLICT',
      message: `EMEVD revision 冲突：expected ${document.revision}, got ${mutation.baseRevision}。`
    };
  }
  const events = document.events.map((event) => ({ ...event, instructions: [...event.instructions] }));
  if (mutation.kind === 'emevd_set_rest_behavior') {
    const index = events.findIndex((event) => event.eventUri === mutation.eventUri);
    if (index < 0) {
      return { ok: false, code: 'EMEVD_EVENT_NOT_FOUND', message: '找不到目标事件。' };
    }
    events[index] = { ...events[index]!, restBehavior: mutation.restBehavior };
  } else if (mutation.kind === 'emevd_update_id') {
    const index = events.findIndex((event) => event.eventUri === mutation.eventUri);
    if (index < 0) {
      return { ok: false, code: 'EMEVD_EVENT_NOT_FOUND', message: '找不到目标事件。' };
    }
    if (events.some((event) => event.eventId === mutation.newEventId)) {
      return { ok: false, code: 'EMEVD_EVENT_ID_DUPLICATE', message: '新事件 ID 已存在。' };
    }
    const previous = events[index]!;
    const eventUri = `${document.resourceUri}#event/${mutation.newEventId}`;
    events[index] = {
      ...previous,
      eventId: mutation.newEventId,
      eventUri,
      instructions: previous.instructions.map((instr, instrIndex) => ({
        ...instr,
        instructionUri: `${eventUri}/instr/${instrIndex}`
      }))
    };
  } else if (mutation.kind === 'emevd_set_instruction_args') {
    const eventIndex = events.findIndex((event) => event.eventUri === mutation.eventUri);
    if (eventIndex < 0) {
      return { ok: false, code: 'EMEVD_EVENT_NOT_FOUND', message: '找不到目标事件。' };
    }
    const event = events[eventIndex]!;
    const instrIndex = event.instructions.findIndex(
      (instr) => instr.instructionUri === mutation.instructionUri
    );
    if (instrIndex < 0) {
      return { ok: false, code: 'EMEVD_INSTRUCTION_NOT_FOUND', message: '找不到目标指令。' };
    }
    const previous = event.instructions[instrIndex]!;
    let nextArgs: Buffer;
    let previousArgs: Buffer;
    try {
      previousArgs = Buffer.from(previous.argsBase64 || '', 'base64');
      nextArgs = Buffer.from(mutation.argsBase64 || '', 'base64');
    } catch {
      return { ok: false, code: 'EMEVD_ARGS_BASE64_INVALID', message: 'argsBase64 非法。' };
    }
    if (nextArgs.length !== previousArgs.length) {
      return {
        ok: false,
        code: 'EMEVD_ARGS_LENGTH_MISMATCH',
        message: `指令 args 长度必须保持 ${previousArgs.length}，收到 ${nextArgs.length}。`
      };
    }
    const instructions = [...event.instructions];
    instructions[instrIndex] = {
      ...previous,
      argsBase64: mutation.argsBase64,
      unknown: previous.unknown
    };
    events[eventIndex] = { ...event, instructions };
  } else {
    return { ok: false, code: 'EMEVD_MUTATION_UNSUPPORTED', message: '不支持的 EMEVD mutation。' };
  }

  return {
    ok: true,
    document: {
      ...document,
      revision: document.revision + 1,
      events,
      diagnostics: [
        ...document.diagnostics,
        {
          severity: 'info',
          code: 'EMEVD_MUTATION_APPLIED',
          message: `已应用 ${mutation.kind}（mutation ${randomUUID().slice(0, 8)}）。`
        }
      ]
    }
  };
}

/** Parse DSL is intentionally non-authoritative: errors never mutate the document. */
export function tryParseEmevdDsl(_text: string): {
  ok: false;
  code: 'EMEVD_DSL_NON_AUTHORITATIVE';
  message: string;
} {
  return {
    ok: false,
    code: 'EMEVD_DSL_NON_AUTHORITATIVE',
    message: 'DSL 文本仅供显示；结构化 mutation 必须走事件表/属性面板，解析错误不会污染文档。'
  };
}

/**
 * Apply a compiled DSL plan to the editor document (revision +1).
 * Used after a successful commit so the four-view layer stays in sync.
 * An empty plan returns the document unchanged (nothing consumed).
 */
export function applyEmevdPlanToDocument(
  document: EmevdEditorDocument,
  plan: EmevdMutationPlan,
  registry: EmedfRegistry
): { ok: true; document: EmevdEditorDocument } | { ok: false; code: string; message: string } {
  if (plan.documentInstanceId !== document.documentInstanceId) {
    return {
      ok: false,
      code: 'EMEVD_PLAN_INSTANCE_MISMATCH',
      message: '计划属于另一个文档实例，拒绝应用。'
    };
  }
  if (plan.baseRevision !== document.revision) {
    return {
      ok: false,
      code: 'EMEVD_PLAN_STALE_REVISION',
      message: `计划基于 revision ${plan.baseRevision}，当前为 ${document.revision}。`
    };
  }
  if (plan.operations.length === 0) {
    return { ok: true, document };
  }

  const events = document.events.map((event) => ({ ...event, instructions: [...event.instructions] }));
  for (const operation of plan.operations) {
    if (operation.kind === 'set_event_id') {
      const index = events.findIndex(
        (event) => event.anchor && formatEmevdAnchor('event', event.anchor) === operation.eventAnchor
      );
      if (index < 0) {
        return { ok: false, code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND', message: '计划引用的事件锚不存在。' };
      }
      if (events.some((event) => event.eventId === operation.after)) {
        return { ok: false, code: 'EMEVD_EVENT_ID_DUPLICATE', message: '计划产生重复事件 ID。' };
      }
      const previous = events[index]!;
      const eventUri = `${document.resourceUri}#event/${operation.after}`;
      events[index] = {
        ...previous,
        eventId: operation.after,
        eventUri,
        instructions: previous.instructions.map((instr, instrIndex) => ({
          ...instr,
          instructionUri: `${eventUri}/instr/${instrIndex}`
        }))
      };
    } else if (operation.kind === 'set_event_rest_behavior') {
      const index = events.findIndex(
        (event) => event.anchor && formatEmevdAnchor('event', event.anchor) === operation.eventAnchor
      );
      if (index < 0) {
        return { ok: false, code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND', message: '计划引用的事件锚不存在。' };
      }
      events[index] = { ...events[index]!, restBehavior: operation.after };
    } else if (operation.kind === 'set_instruction_arg') {
      const eventIndex = events.findIndex(
        (event) => event.anchor && formatEmevdAnchor('event', event.anchor) === operation.eventAnchor
      );
      const event = eventIndex >= 0 ? events[eventIndex] : undefined;
      const instrIndex = event?.instructions.findIndex(
        (instr) => instr.anchor
          && formatEmevdAnchor('instruction', instr.anchor) === operation.instructionAnchor
      );
      if (event === undefined || instrIndex === undefined || instrIndex < 0) {
        return { ok: false, code: 'EMEVD_PLAN_ANCHOR_NOT_FOUND', message: '计划引用的指令锚不存在。' };
      }
      const previous = event.instructions[instrIndex]!;
      let currentArgs: Buffer;
      try {
        currentArgs = decodeStrictBase64(previous.argsBase64, { allowEmpty: true });
      } catch {
        return { ok: false, code: 'EMEVD_PLAN_ARGS_DECODE_FAILED', message: '指令 argsBase64 无效。' };
      }
      const mutated = mutateInstructionArg(
        registry, previous.bank, previous.id, currentArgs, operation.argument, operation.after
      );
      if (!mutated.ok) {
        return { ok: false, code: mutated.code, message: mutated.message };
      }
      const instructions = [...event.instructions];
      instructions[instrIndex] = {
        ...previous,
        argsBase64: mutated.args.toString('base64')
      };
      events[eventIndex] = { ...event, instructions };
    }
  }

  return {
    ok: true,
    document: {
      ...document,
      revision: document.revision + 1,
      events,
      diagnostics: [
        ...document.diagnostics,
        {
          severity: 'info',
          code: 'EMEVD_PLAN_APPLIED',
          message: `已应用 DSL 计划（${plan.operations.length} 个操作）。`
        }
      ]
    }
  };
}

export interface EmevdDslPlanSubmitRequest {
  compileRequest: EmevdDslCompileRequest;
  document: EmevdEditorDocument;
  registry: EmedfRegistry;
  /** Absolute path of the EMEVD file on the writable overlay. */
  sourcePath: string;
  /** SHA-256 of the source file bytes (commit precondition). */
  expectedDocumentHash: string;
  /**
   * SHA-256 of the outer source resource bytes (the .dcx wrapper). When the
   * source is a .dcx, the file_replace precondition compares against these.
   */
  expectedOuterFileHash?: string;
  allowedRoots: string[];
  workspaceId: string;
  /** Overlay root; the commit target must stay inside it. */
  workspaceRoot: string;
  /** Root where Bridge staging temp dirs are created. */
  stagingRoot: string;
  targetUri?: string;
  title?: string;
  session?: WorkspaceSession;
  operationLog?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  timeoutMs?: number;
}

export interface EmevdDslPlanSubmitResult {
  ok: boolean;
  plan?: EmevdMutationPlan;
  nextDocument?: EmevdEditorDocument;
  commit?: EmevdPlanCommitResult;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
}

/**
 * Production DSL submit entry for the four-view editing layer:
 * compile → typed plan → Bridge batch staging → file_replace PatchIR →
 * WorkspaceTransaction (stage/validate/commit/backup/re-read/rollback).
 * Returns the next editor document (revision +1) on success.
 */
export async function submitEmevdDslPlanViaFourView(
  input: EmevdDslPlanSubmitRequest
): Promise<EmevdDslPlanSubmitResult> {
  const compiled: EmevdDslCompileResult = compileEmevdPatchDsl(
    input.compileRequest,
    input.document,
    input.registry
  );
  if (!compiled.ok || !compiled.plan) {
    return {
      ok: false,
      diagnostics: compiled.diagnostics.map((d) => ({
        severity: d.severity,
        code: d.code,
        message: d.message
      }))
    };
  }

  const commit = await commitEmevdPlanViaPatchEngine({
    plan: compiled.plan,
    document: input.document,
    registry: input.registry,
    sourcePath: input.sourcePath,
    expectedDocumentHash: input.expectedDocumentHash,
    ...(input.expectedOuterFileHash !== undefined
      ? { expectedOuterFileHash: input.expectedOuterFileHash }
      : {}),
    allowedRoots: input.allowedRoots,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    stagingRoot: input.stagingRoot,
    ...(input.targetUri !== undefined ? { targetUri: input.targetUri } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.session !== undefined ? { session: input.session } : {}),
    ...(input.operationLog !== undefined ? { operationLog: input.operationLog } : {}),
    ...(input.backupBaseDir !== undefined ? { backupBaseDir: input.backupBaseDir } : {}),
    ...(input.recoveryDir !== undefined ? { recoveryDir: input.recoveryDir } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {})
  });
  if (!commit.ok) {
    return { ok: false, plan: compiled.plan, commit, diagnostics: commit.diagnostics };
  }

  const applied = applyEmevdPlanToDocument(input.document, compiled.plan, input.registry);
  if (!applied.ok) {
    return {
      ok: false,
      plan: compiled.plan,
      commit,
      diagnostics: [{ severity: 'error', code: applied.code, message: applied.message }]
    };
  }
  return {
    ok: true,
    plan: compiled.plan,
    nextDocument: applied.document,
    commit,
    diagnostics: commit.diagnostics
  };
}
