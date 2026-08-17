/**
 * DarkScript3 式源码 → 现有 typed mutation plan。
 *
 * 只编译能对齐到权威文档的改动：改事件 id / rest、改已有指令的固定参数。
 * 新增/删除/重排事件或指令、编不回的行：该行 warning「未解码」，不写盘、
 * 不把整份文件锁死。空改动是成功（没有 mutation）。
 */

import { createHash } from 'node:crypto';
import type {
  EmevdDslCompileRequest,
  EmevdDslCompileResult,
  EmevdDslDiagnostic,
  EmevdDslDocument,
  EmevdDslLiteral,
  EmevdDslSourcePosition,
  EmevdDslSourceSpan,
  EmevdEditorDocument,
  EmevdMutationPlan,
  EmevdPlannedMutation
} from '@soulforge/shared';
import {
  analyzeDarkScriptEvent,
  type DarkScriptEventItem
} from './darkScriptRenderer.js';
import { fingerprintEmedfRegistry } from './dslCompiler.js';
import type { DecodedArg, EmedfRegistry } from './emedfSchema.js';
import {
  computeEmevdEventFingerprint,
  computeEmevdInstructionFingerprint,
  formatEmevdAnchor
} from './stableIdentity.js';

export function looksLikeDarkScript(source: string): boolean {
  return /\$Event\s*\(/.test(source);
}

interface ParsedArg {
  value: EmevdDslLiteral;
  span: EmevdDslSourceSpan;
}

interface ParsedCall {
  name: string;
  args: ParsedArg[];
  span: EmevdDslSourceSpan;
}

type ParsedStatement =
  | { kind: 'call'; call: ParsedCall; span: EmevdDslSourceSpan }
  | { kind: 'wait-for'; predicates: ParsedCall[]; span: EmevdDslSourceSpan }
  | { kind: 'comment'; text: string; span: EmevdDslSourceSpan };

interface ParsedEvent {
  eventId: number;
  restBehavior: number;
  statements: ParsedStatement[];
  span: EmevdDslSourceSpan;
}

interface SourceIndex {
  positionAt(offset: number): EmevdDslSourcePosition;
  span(from: number, to: number): EmevdDslSourceSpan;
}

export function compileEmevdDarkScript(
  request: EmevdDslCompileRequest,
  document: EmevdEditorDocument,
  registry?: EmedfRegistry
): EmevdDslCompileResult {
  const source = request.sourceText;
  const index = makeSourceIndex(source);
  const fileSpan = index.span(0, source.length);
  const diagnostics: EmevdDslDiagnostic[] = [];
  const add = (item: EmevdDslDiagnostic): void => { diagnostics.push(item); };

  if (request.mode !== 'patch') {
    add(error('EMEVD_DSL_MODE_UNSUPPORTED', 'Only patch mode is supported.', fileSpan));
  }
  if (request.resourceUri !== document.resourceUri) {
    add(error('EMEVD_DSL_RESOURCE_MISMATCH', 'Resource URI does not match the opened document.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }
  if (document.documentInstanceId === undefined || request.documentInstanceId !== document.documentInstanceId) {
    add(error('EMEVD_DSL_DOCUMENT_INSTANCE_MISMATCH', 'Document instance is missing or stale.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }
  if (request.baseRevision !== document.revision) {
    add(error('EMEVD_DSL_STALE_REVISION', 'Base revision is stale.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }
  if (!registry) {
    add(error('EMEVD_DSL_SCHEMA_REQUIRED', 'EMEDF schema is required.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }

  const actualSchemaFingerprint = registry ? fingerprintEmedfRegistry(registry) : undefined;
  if (
    actualSchemaFingerprint !== undefined
    && request.emedfSchemaFingerprint !== actualSchemaFingerprint
  ) {
    add(error('EMEVD_DSL_SCHEMA_CHANGED', 'EMEDF schema fingerprint changed.', fileSpan, {
      resourceUri: request.resourceUri
    }));
  }

  const parsed = parseDarkScriptEvents(source, index, add);
  const ast = emptyAst(request, fileSpan);

  if (diagnostics.some((item) => item.severity === 'error') || !registry || !actualSchemaFingerprint) {
    return { ok: false, ast, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const operations: EmevdPlannedMutation[] = [];
  const paired = pairEvents(parsed, document.events, add, request.resourceUri);
  for (const pair of paired) {
    compilePairedEvent(pair.parsed, pair.documentEvent, registry, operations, add, request.resourceUri);
  }

  if (diagnostics.some((item) => item.severity === 'error')) {
    return { ok: false, ast, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const hasUndecoded = diagnostics.some((item) => item.code === 'DARKSCRIPT_LINE_UNDECODED');
  if (operations.length === 0 && hasUndecoded) {
    return { ok: false, ast, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const touchedEvents = unique(operations.map((operation) => operation.eventAnchor));
  const touchedInstructions = unique(operations.flatMap((operation) =>
    operation.kind === 'set_instruction_arg' ? [operation.instructionAnchor] : []
  ));
  const sourceFingerprint = hashText(source);
  const planWithoutFingerprint = {
    schemaVersion: 1 as const,
    resourceUri: request.resourceUri,
    documentInstanceId: request.documentInstanceId,
    baseRevision: request.baseRevision,
    sourceFingerprint,
    schemaFingerprint: actualSchemaFingerprint,
    operations,
    impact: {
      touchedEvents,
      touchedInstructions,
      inserts: 0,
      deletes: 0,
      argumentWrites: operations.filter((operation) => operation.kind === 'set_instruction_arg').length
    }
  };
  const plan: EmevdMutationPlan = {
    ...planWithoutFingerprint,
    planFingerprint: hashText(stableJson(planWithoutFingerprint))
  };
  return { ok: true, ast, plan, diagnostics: diagnostics.sort(compareDiagnostics) };
}

function compilePairedEvent(
  parsed: ParsedEvent,
  event: EmevdEditorDocument['events'][number],
  registry: EmedfRegistry,
  operations: EmevdPlannedMutation[],
  add: (item: EmevdDslDiagnostic) => void,
  resourceUri: string
): void {
  if (!event.anchor) {
    add(warn('DARKSCRIPT_LINE_UNDECODED', '事件没有稳定锚，不能写入。', parsed.span, {
      resourceUri
    }));
    return;
  }
  const eventAnchor = formatEmevdAnchor('event', event.anchor);
  const eventHash = computeEmevdEventFingerprint(event);

  if (parsed.eventId !== event.eventId) {
    operations.push({
      kind: 'set_event_id',
      eventAnchor,
      target: event.anchor,
      targetPreconditionHash: eventHash,
      sourceSpan: parsed.span,
      before: event.eventId,
      after: parsed.eventId
    });
  }
  if (parsed.restBehavior !== event.restBehavior) {
    operations.push({
      kind: 'set_event_rest_behavior',
      eventAnchor,
      target: event.anchor,
      targetPreconditionHash: eventHash,
      sourceSpan: parsed.span,
      before: event.restBehavior,
      after: parsed.restBehavior
    });
  }

  const shape = analyzeDarkScriptEvent(event, registry);
  if (parsed.statements.length !== shape.length) {
    add(warn(
      'DARKSCRIPT_LINE_UNDECODED',
      `事件 ${event.eventId} 的指令条数对不上权威文档（源码 ${parsed.statements.length}，文档 ${shape.length}），整段未解码。`,
      parsed.span,
      { resourceUri, targetAnchor: eventAnchor }
    ));
    return;
  }

  for (let i = 0; i < shape.length; i += 1) {
    compileStatement(parsed.statements[i]!, shape[i]!, eventAnchor, operations, add, resourceUri);
  }
}

function compileStatement(
  statement: ParsedStatement,
  item: DarkScriptEventItem,
  eventAnchor: string,
  operations: EmevdPlannedMutation[],
  add: (item: EmevdDslDiagnostic) => void,
  resourceUri: string
): void {
  if (statement.kind === 'comment' && item.kind === 'opaque') {
    if (normalizeComment(statement.text) !== normalizeComment(item.comment)) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', '未解码指令只能保持原注释，不能改写成别的内容。', statement.span, {
        resourceUri,
        targetAnchor: eventAnchor
      }));
    }
    return;
  }
  if (statement.kind === 'wait-for' && item.kind === 'wait-for') {
    if (statement.predicates.length !== item.predicates.length) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', 'WaitFor 谓词数量对不上，该行未解码。', statement.span, {
        resourceUri,
        targetAnchor: eventAnchor
      }));
      return;
    }
    for (let i = 0; i < item.predicates.length; i += 1) {
      emitCallArgMutations(
        statement.predicates[i]!,
        item.predicates[i]!.displayName,
        item.predicates[i]!.visibleArgs,
        item.predicates[i]!.instruction,
        eventAnchor,
        operations,
        add,
        resourceUri
      );
    }
    return;
  }
  if (statement.kind === 'call' && item.kind === 'call') {
    emitCallArgMutations(
      statement.call,
      item.displayName,
      item.args,
      item.instruction,
      eventAnchor,
      operations,
      add,
      resourceUri
    );
    return;
  }
  add(warn('DARKSCRIPT_LINE_UNDECODED', '这一行对不上权威文档里的指令，未解码。', statement.span, {
    resourceUri,
    targetAnchor: eventAnchor
  }));
}

function emitCallArgMutations(
  call: ParsedCall,
  expectedName: string,
  expectedArgs: readonly DecodedArg[],
  instruction: EmevdEditorDocument['events'][number]['instructions'][number],
  eventAnchor: string,
  operations: EmevdPlannedMutation[],
  add: (item: EmevdDslDiagnostic) => void,
  resourceUri: string
): void {
  if (call.name !== expectedName) {
    add(warn(
      'DARKSCRIPT_LINE_UNDECODED',
      `指令名 ${call.name} 对不上 ${expectedName}，该行未解码。`,
      call.span,
      { resourceUri, targetAnchor: eventAnchor }
    ));
    return;
  }
  if (!instruction.anchor) {
    add(warn('DARKSCRIPT_LINE_UNDECODED', '指令没有稳定锚，不能写入。', call.span, {
      resourceUri,
      targetAnchor: eventAnchor
    }));
    return;
  }
  if (call.args.length !== expectedArgs.length) {
    add(warn(
      'DARKSCRIPT_LINE_UNDECODED',
      `参数个数对不上（源码 ${call.args.length}，文档 ${expectedArgs.length}），该行未解码。`,
      call.span,
      { resourceUri, targetAnchor: eventAnchor }
    ));
    return;
  }
  const instructionAnchor = formatEmevdAnchor('instruction', instruction.anchor);
  const hash = computeEmevdInstructionFingerprint(instruction);
  for (let i = 0; i < expectedArgs.length; i += 1) {
    const expected = expectedArgs[i]!;
    const got = call.args[i]!;
    if (typeof expected.value !== typeof got.value) {
      add(error(
        'DARKSCRIPT_ARG_TYPE',
        `参数 ${expected.name} 类型不匹配。`,
        got.span,
        { resourceUri, targetAnchor: instructionAnchor }
      ));
      continue;
    }
    if (!Object.is(expected.value, got.value)) {
      operations.push({
        kind: 'set_instruction_arg',
        eventAnchor,
        instructionAnchor,
        target: instruction.anchor,
        targetPreconditionHash: hash,
        sourceSpan: got.span,
        bank: instruction.bank,
        id: instruction.id,
        argument: expected.name,
        before: expected.value,
        after: got.value
      });
    }
  }
}

function pairEvents(
  parsed: ParsedEvent[],
  documentEvents: readonly EmevdEditorDocument['events'][number][],
  add: (item: EmevdDslDiagnostic) => void,
  resourceUri: string
): Array<{ parsed: ParsedEvent; documentEvent: EmevdEditorDocument['events'][number] }> {
  const remaining = [...documentEvents];
  const pairs: Array<{ parsed: ParsedEvent; documentEvent: EmevdEditorDocument['events'][number] }> = [];
  const leftovers: ParsedEvent[] = [];
  for (const event of parsed) {
    const index = remaining.findIndex((item) => item.eventId === event.eventId);
    if (index >= 0) {
      pairs.push({ parsed: event, documentEvent: remaining.splice(index, 1)[0]! });
    } else {
      leftovers.push(event);
    }
  }
  while (leftovers.length > 0 && remaining.length > 0) {
    pairs.push({ parsed: leftovers.shift()!, documentEvent: remaining.shift()! });
  }
  for (const extra of leftovers) {
    add(warn(
      'DARKSCRIPT_LINE_UNDECODED',
      `新增事件 ${extra.eventId} 本版不能写入，该块未解码。`,
      extra.span,
      { resourceUri }
    ));
  }
  for (const missing of remaining) {
    add(warn(
      'DARKSCRIPT_LINE_UNDECODED',
      `权威文档里的事件 ${missing.eventId} 在源码里被删了，删除事件本版不能写入。`,
      extraOrFileSpan(parsed),
      { resourceUri }
    ));
  }
  return pairs;
}

function extraOrFileSpan(parsed: ParsedEvent[]): EmevdDslSourceSpan {
  const last = parsed[parsed.length - 1];
  return last?.span ?? {
    start: { offset: 0, line: 1, column: 1 },
    end: { offset: 0, line: 1, column: 1 }
  };
}

function parseDarkScriptEvents(
  source: string,
  index: SourceIndex,
  add: (item: EmevdDslDiagnostic) => void
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let offset = 0;
  const header = /\$Event\(\s*(-?\d+)\s*,\s*(Default|Restart|-?\d+)(?:\s*\/\*[\s\S]*?\*\/)?\s*,\s*function\s*\(\s*\)\s*\{/g;
  while (offset <= source.length) {
    header.lastIndex = offset;
    const match = header.exec(source);
    if (!match) break;
    const headerStart = match.index;
    const headerEnd = header.lastIndex;
    const close = findEventClose(source, headerEnd);
    if (close < 0) {
      add(error('DARKSCRIPT_PARSE', '事件块没有对应的 `});`。', index.span(headerStart, source.length)));
      break;
    }
    const restRaw = match[2]!;
    const restBehavior = restRaw === 'Default' ? 0 : restRaw === 'Restart' ? 1 : Number(restRaw);
    const body = source.slice(headerEnd, close);
    const statements = parseStatements(body, headerEnd, index, add);
    events.push({
      eventId: Number(match[1]),
      restBehavior,
      statements,
      span: index.span(headerStart, close + 3)
    });
    offset = close + 3;
  }
  if (events.length === 0 && /\$Event\s*\(/.test(source)) {
    add(error('DARKSCRIPT_PARSE', '没有解析到完整的 $Event 块。', index.span(0, source.length)));
  }
  return events;
}

function findEventClose(source: string, from: number): number {
  const needle = '\n});';
  let search = from;
  while (search < source.length) {
    const at = source.indexOf(needle, search);
    if (at < 0) {
      return source.startsWith('});', from) ? from : source.endsWith('\n});') ? source.lastIndexOf('\n});') + 1 : -1;
    }
    return at + 1;
  }
  return -1;
}

function parseStatements(
  body: string,
  bodyStart: number,
  index: SourceIndex,
  add: (item: EmevdDslDiagnostic) => void
): ParsedStatement[] {
  const statements: ParsedStatement[] = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i += 1;
    if (i >= body.length) break;
    if (body.startsWith('//', i)) {
      const nl = body.indexOf('\n', i);
      const end = nl < 0 ? body.length : nl;
      const text = body.slice(i, end).trim();
      statements.push({
        kind: 'comment',
        text,
        span: index.span(bodyStart + i, bodyStart + end)
      });
      i = end;
      continue;
    }
    const start = i;
    const sliced = scanBalancedStatement(body, i);
    if (!sliced) {
      add(error('DARKSCRIPT_PARSE', '无法解析的语句。', index.span(bodyStart + i, bodyStart + body.length)));
      break;
    }
    i = sliced.end;
    const raw = body.slice(start, sliced.end).trim();
    const span = index.span(bodyStart + start, bodyStart + sliced.end);
    const wait = parseWaitFor(raw, span, bodyStart + start, index, add);
    if (wait) {
      statements.push(wait);
      continue;
    }
    const call = parseCall(raw, span);
    if (call) {
      statements.push({ kind: 'call', call, span });
      continue;
    }
    add(warn('DARKSCRIPT_LINE_UNDECODED', '无法识别的语句，未解码。', span));
  }
  return statements;
}

function scanBalancedStatement(body: string, start: number): { end: number } | null {
  let depth = 0;
  let i = start;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) return { end: i + 1 };
    i += 1;
  }
  return null;
}

function parseWaitFor(
  raw: string,
  span: EmevdDslSourceSpan,
  absoluteStart: number,
  index: SourceIndex,
  add: (item: EmevdDslDiagnostic) => void
): ParsedStatement | null {
  const match = /^WaitFor\s*\(([\s\S]*)\)\s*;$/.exec(raw);
  if (!match) return null;
  const inner = match[1]!.trim();
  if (/^[A-Z][A-Za-z0-9_]*\s*\(/.test(inner) && !inner.includes('&&')) {
    const call = parseCall(`${inner};`, span);
    if (!call) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', 'WaitFor 里的谓词无法解析，未解码。', span));
      return { kind: 'wait-for', predicates: [], span };
    }
    return { kind: 'wait-for', predicates: [call], span };
  }
  const parts = splitTopLevel(inner, '&&');
  const predicates: ParsedCall[] = [];
  let cursor = raw.indexOf('(') + 1;
  for (const part of parts) {
    const local = part.trim();
    const rel = raw.indexOf(local, cursor);
    const callSpan = rel >= 0
      ? index.span(absoluteStart + rel, absoluteStart + rel + local.length)
      : span;
    const call = parseCall(`${local};`, callSpan);
    if (!call) {
      add(warn('DARKSCRIPT_LINE_UNDECODED', 'WaitFor 里的谓词无法解析，未解码。', callSpan));
      return { kind: 'wait-for', predicates: [], span };
    }
    predicates.push(call);
    cursor = rel >= 0 ? rel + local.length : cursor;
  }
  return { kind: 'wait-for', predicates, span };
}

function parseCall(raw: string, span: EmevdDslSourceSpan): ParsedCall | null {
  const match = /^([A-Z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*;$/.exec(raw.trim());
  if (!match) return null;
  const argsRaw = match[2]!.trim();
  if (argsRaw.length === 0) return { name: match[1]!, args: [], span };
  const parts = splitTopLevel(argsRaw, ',');
  const args: ParsedArg[] = [];
  for (const part of parts) {
    const literal = parseLiteral(part.trim());
    if (literal === undefined) return null;
    args.push({ value: literal, span });
  }
  return { name: match[1]!, args, span };
}

function parseLiteral(text: string): EmevdDslLiteral | undefined {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === '-0') return -0;
  if (/^-?\d+$/.test(text)) {
    const value = Number(text);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (/^-?\d+\.\d+(?:e[+-]?\d+)?$/i.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim().length > 0);
}

function normalizeComment(text: string): string {
  return text.replace(/^\s*\/\/\s*/, '').trim();
}

function makeSourceIndex(source: string): SourceIndex {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  const positionAt = (offset: number): EmevdDslSourcePosition => {
    const clamped = Math.max(0, Math.min(offset, source.length));
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high + 1) / 2);
      if (starts[mid]! <= clamped) low = mid;
      else high = mid - 1;
    }
    return { offset: clamped, line: low + 1, column: clamped - starts[low]! + 1 };
  };
  return {
    positionAt,
    span(from: number, to: number) {
      return { start: positionAt(from), end: positionAt(to) };
    }
  };
}

function emptyAst(request: EmevdDslCompileRequest, span: EmevdDslSourceSpan): EmevdDslDocument {
  return {
    schemaVersion: 1,
    resourceUri: request.resourceUri,
    baseRevision: request.baseRevision,
    emedfSchemaFingerprint: request.emedfSchemaFingerprint,
    events: [],
    span
  };
}

function error(
  code: string,
  message: string,
  span: EmevdDslSourceSpan,
  extra?: { resourceUri?: string; targetAnchor?: string }
): EmevdDslDiagnostic {
  return {
    severity: 'error',
    code,
    message,
    span,
    ...(extra?.resourceUri !== undefined ? { resourceUri: extra.resourceUri } : {}),
    ...(extra?.targetAnchor !== undefined ? { targetAnchor: extra.targetAnchor } : {})
  };
}

function warn(
  code: string,
  message: string,
  span: EmevdDslSourceSpan,
  extra?: { resourceUri?: string; targetAnchor?: string }
): EmevdDslDiagnostic {
  return {
    severity: 'warning',
    code,
    message,
    span,
    ...(extra?.resourceUri !== undefined ? { resourceUri: extra.resourceUri } : {}),
    ...(extra?.targetAnchor !== undefined ? { targetAnchor: extra.targetAnchor } : {})
  };
}

function compareDiagnostics(left: EmevdDslDiagnostic, right: EmevdDslDiagnostic): number {
  return left.span.start.offset - right.span.start.offset || left.code.localeCompare(right.code);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
