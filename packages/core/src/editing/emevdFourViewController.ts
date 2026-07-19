/**
 * EMEVD four-view document controller — single revision, selection sync,
 * structured mutations only (no DSL parse pollution of valid mutations).
 */

import { randomUUID } from 'node:crypto';
import type {
  EmevdEditorDocument,
  EmevdEditorMutation,
  EmevdEventIr,
  EmevdSelection,
  EmevdViewId
} from '@soulforge/shared';

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
}): EmevdEditorDocument {
  const events: EmevdEventIr[] = input.events.map((event, eventIndex) => {
    const eventUri = `${input.resourceUri}#event/${event.eventId}/index/${eventIndex}`;
    return {
      eventUri,
      eventId: event.eventId,
      eventIndex,
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
  return {
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
  };
}

export function renderEmevdDsl(document: EmevdEditorDocument): string {
  const lines = ['// EMEVD structural DSL (read/write limited to supported mutations)', `$Resource ${document.resourceUri}`];
  for (const event of document.events) {
    lines.push(`$Event(${event.eventId}, Rest=${event.restBehavior}, Layer=${event.layer}) {`);
    for (const instr of event.instructions) {
      const tag = instr.unknown ? 'unknown' : 'typed';
      lines.push(`  ${tag} bank=${instr.bank} id=${instr.id} args=${instr.argsBase64 || '""'};`);
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
    const eventUri = `${document.resourceUri}#event/${mutation.newEventId}/index/${previous.eventIndex ?? index}`;
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


export function findEmevdEvent(document: EmevdEditorDocument, eventUri: string): EmevdEventIr | undefined {
  return document.events.find((event) => event.eventUri === eventUri);
}

export function findEmevdInstruction(
  document: EmevdEditorDocument,
  eventUri: string,
  instructionUri: string
): { event: EmevdEventIr; instructionIndex: number } | undefined {
  const event = findEmevdEvent(document, eventUri);
  if (!event) return undefined;
  const instructionIndex = event.instructions.findIndex((item) => item.instructionUri === instructionUri);
  if (instructionIndex < 0) return undefined;
  return { event, instructionIndex };
}

export function selectEmevdEvent(selection: EmevdSelection, eventUri: string): EmevdSelection {
  return selectEmevdView(selection, selection.view, eventUri, undefined);
}

export function selectEmevdInstruction(
  selection: EmevdSelection,
  eventUri: string,
  instructionUri: string
): EmevdSelection {
  return selectEmevdView(selection, selection.view, eventUri, instructionUri);
}

export function navigateEmevdSelection(
  document: EmevdEditorDocument,
  selection: EmevdSelection,
  direction: "next" | "prev"
): EmevdSelection {
  if (document.events.length === 0) return selection;
  let eventIndex = selection.eventUri
    ? document.events.findIndex((event) => event.eventUri === selection.eventUri)
    : 0;
  if (eventIndex < 0) eventIndex = 0;
  const event = document.events[eventIndex]!;
  if (selection.instructionUri) {
    let instructionIndex = event.instructions.findIndex((item) => item.instructionUri === selection.instructionUri);
    if (instructionIndex < 0) instructionIndex = 0;
    if (direction === "next") {
      if (instructionIndex + 1 < event.instructions.length) {
        return selectEmevdInstruction(selection, event.eventUri, event.instructions[instructionIndex + 1]!.instructionUri);
      }
      if (eventIndex + 1 < document.events.length) {
        const nextEvent = document.events[eventIndex + 1]!;
        const first = nextEvent.instructions[0];
        return first
          ? selectEmevdInstruction(selection, nextEvent.eventUri, first.instructionUri)
          : selectEmevdEvent(selection, nextEvent.eventUri);
      }
      return selection;
    }
    if (instructionIndex > 0) {
      return selectEmevdInstruction(selection, event.eventUri, event.instructions[instructionIndex - 1]!.instructionUri);
    }
    if (eventIndex > 0) {
      const prevEvent = document.events[eventIndex - 1]!;
      const last = prevEvent.instructions[prevEvent.instructions.length - 1];
      return last
        ? selectEmevdInstruction(selection, prevEvent.eventUri, last.instructionUri)
        : selectEmevdEvent(selection, prevEvent.eventUri);
    }
    return selection;
  }
  if (direction === "next") {
    if (eventIndex + 1 < document.events.length) return selectEmevdEvent(selection, document.events[eventIndex + 1]!.eventUri);
    return selection;
  }
  if (eventIndex > 0) return selectEmevdEvent(selection, document.events[eventIndex - 1]!.eventUri);
  return selection;
}



export function applyEmevdEditorMutations(
  document: EmevdEditorDocument,
  mutations: readonly EmevdEditorMutation[]
): {
  ok: boolean;
  document: EmevdEditorDocument;
  applied: number;
  failedCode?: string;
  failedMessage?: string;
} {
  let current = document;
  let applied = 0;
  for (const mutation of mutations) {
    const result = applyEmevdEditorMutation(current, mutation);
    if (!result.ok) {
      return {
        ok: false,
        document: current,
        applied,
        failedCode: result.code,
        failedMessage: result.message
      };
    }
    current = result.document;
    applied += 1;
  }
  return { ok: true, document: current, applied };
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
