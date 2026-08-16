/**
 * DarkScript3-style EMEVD source compiler (S14).
 *
 * Compiles the user-edited `$Event(...)` source back into a typed
 * `EmevdMutationPlan` by aligning the edited text against the *rendered shape*
 * of the authority document — the same per-event line split and wait-block
 * folding that `darkScriptRenderer` produces. There is deliberately no
 * DarkScript → binary full re-compiler: instruction insertion/deletion and
 * edits inside a folded `WaitFor(...)` block (whose condition-group bookkeeping
 * args are hidden by the renderer) cannot be expressed as typed mutations, so
 * those cases fail closed with a per-line structured diagnostic — never by
 * locking the whole document read-only, never by pretending a write happened.
 *
 * Alignment is positional: event blocks are matched by order, and within an
 * event each rendered line (canonicalized) is matched by order. A structural
 * change in one event (line count differs) skips only that event's instruction
 * writes; its header (`$Event(id, rest, ...)`) still compiles when unchanged
 * in shape. This keeps a single-event edit applyable without demanding the
 * whole file be identical to the last render.
 *
 * This module is a pure function of (sourceText, document, registry): no
 * filesystem, no side effects.
 */
import { createHash } from 'node:crypto';
import type {
  EmevdDslCompileRequest,
  EmevdDslCompileResult,
  EmevdDslDiagnostic,
  EmevdDslDocument,
  EmevdDslLiteral,
  EmevdDslSourceSpan,
  EmevdEditorDocument,
  EmevdMutationPlan,
  EmevdPlannedMutation
} from '@soulforge/shared';
import type { EmedfRegistry } from './emedfSchema.js';
import {
  decodeForRender,
  renderInstructionLine,
  renderWaitBlock,
  splitIntoSpans,
  toPascalCase,
  type DecodedInstruction
} from './darkScriptRenderer.js';
import { findInstructionDef } from './emedfSchema.js';
import { createEmevdDslDiagnostic as diagnostic } from './dslTokenizer.js';
import { validateTypedLiteral } from './dslCompiler.js';
import {
  computeEmevdEventFingerprint,
  computeEmevdInstructionFingerprint,
  formatEmevdAnchor
} from './stableIdentity.js';

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/* ------------------------------------------------------------------ */
/*  Event block splitting                                             */
/* ------------------------------------------------------------------ */

interface ParsedEventBlock {
  /** 1-based 行号（用户文本）。 */
  headerLine: number;
  eventId: number;
  restBehavior: number;
  /** 规范化后的指令行（不含注释/空白行；WaitFor 多行块已合并为单行）。 */
  body: string[];
  /** 每条 body 行的原始行号范围（诊断定位用）。 */
  bodyLines: Array<{ start: number; end: number }>;
}

/**
 * 切出 `$Event(id, rest, function() {` … `});` 块。返回的 body 是规范化
 * 指令行序列：trim + 压缩空白；`//` 注释行与空行丢弃；从 `WaitFor(` 到 `);`
 * 的多行块合并为单行。解析失败的块不进结果（调用方按块号对不齐给诊断）。
 */
export function splitDarkScriptEventBlocks(text: string): {
  blocks: ParsedEventBlock[];
  diagnostics: EmevdDslDiagnostic[];
} {
  const diagnostics: EmevdDslDiagnostic[] = [];
  const blocks: ParsedEventBlock[] = [];
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const header = /^\s*\$Event\(\s*(\d+)\s*,\s*([^,]+?)\s*,\s*function\s*\(\s*\)\s*\{\s*$/.exec(line);
    if (!header) {
      index += 1;
      continue;
    }
    const headerLine = index + 1;
    const eventId = Number(header[1]);
    const restText = header[2]!.trim();
    const restMatch = /^\s*(\d+)\s*(?:\/\*.*?\*\/)?\s*$/.exec(restText);
    const restBehavior = restMatch
      ? Number(restMatch[1])
      : (restText === 'Default' ? 0 : restText === 'Restart' ? 1 : Number.NaN);

    const body: string[] = [];
    const bodyLines: Array<{ start: number; end: number }> = [];
    index += 1;
    let blockText: string[] = [];
    let blockStart = 0;
    let closed = false;
    while (index < lines.length) {
      const bodyLine = lines[index]!;
      if (/^\s*\}\);\s*$/.test(bodyLine)) {
        closed = true;
        index += 1;
        break;
      }
      const trimmed = bodyLine.trim();
      if (trimmed === '' || trimmed.startsWith('//')) {
        index += 1;
        continue;
      }
      // 普通调用单行即完；WaitFor( 折叠块累积到以 `);` 结尾的末行。
      if (blockText.length === 0) blockStart = index + 1;
      blockText.push(trimmed);
      if (/\);\s*$/.test(trimmed)) {
        body.push(canonicalizeCall(blockText.join(' ')));
        bodyLines.push({ start: blockStart, end: index + 1 });
        blockText = [];
      }
      index += 1;
    }
    if (!closed) {
      diagnostics.push(diagnostic(
        'EMEVD_DSL_UNTERMINATED_EVENT',
        `$Event( 块在行 ${headerLine} 没有闭合的 });。`,
        spanFor(headerLine, headerLine, text)
      ));
      continue;
    }
    if (Number.isNaN(restBehavior)) {
      diagnostics.push(diagnostic(
        'EMEVD_DSL_REST_BEHAVIOR_UNPARSEABLE',
        `行 ${headerLine} 的 rest behavior「${restText}」无法解析（只认 Default / Restart / 数字）。`,
        spanFor(headerLine, headerLine, text)
      ));
      continue;
    }
    blocks.push({ headerLine, eventId, restBehavior, body, bodyLines });
  }
  return { blocks, diagnostics };
}

/** 调用文本规范化：去所有空白（含换行折叠），便于跨格式比对。 */
function canonicalizeCall(text: string): string {
  return text.replace(/\s+/g, '');
}

/** 0-based 行号 → 源 span。 */
function spanFor(startLine: number, endLine: number, source: string): EmevdDslSourceSpan {
  const lines = source.split('\n');
  const startOffset = lines.slice(0, startLine - 1).reduce((n, l) => n + l.length + 1, 0);
  const endOffset = lines.slice(0, endLine).reduce((n, l) => n + l.length + 1, 0);
  return {
    start: { offset: startOffset, line: startLine, column: 1 },
    end: { offset: endOffset, line: endLine, column: 1 }
  };
}

/* ------------------------------------------------------------------ */
/*  Document-side canonical shape                                     */
/* ------------------------------------------------------------------ */

/** 文档侧每个事件的「规范指令行」：与渲染输出同构，供逐行对齐。 */
function documentEventShape(event: EmevdEditorDocument['events'][number], registry: EmedfRegistry): {
  eventId: number;
  restBehavior: number;
  lines: Array<{
    canonical: string;
    /** 普通指令行对应的 DecodedInstruction；WaitFor 折叠块为 null。 */
    decoded: DecodedInstruction | null;
    wait?: { predicates: DecodedInstruction[]; anchor: DecodedInstruction };
    instruction: EmevdEditorDocument['events'][number]['instructions'][number] | null;
  }>;
} {
  const lines: Array<{
    canonical: string;
    decoded: DecodedInstruction | null;
    wait?: { predicates: DecodedInstruction[]; anchor: DecodedInstruction };
    instruction: EmevdEditorDocument['events'][number]['instructions'][number] | null;
  }> = [];
  const spans = splitIntoSpans(event.instructions, registry);
  for (const span of spans) {
    if (span.kind === 'ordinary') {
      for (const item of span.instructions) {
        // 失败态（unknown / base64-invalid / decode-failed）渲染成注释行，
        // 用户侧解析同样丢弃注释——两侧都不计，行数才对得上。
        if (item.status.kind !== 'ok') continue;
        lines.push({
          canonical: canonicalizeCall(renderInstructionLine(item)),
          decoded: item,
          instruction: item.instruction
        });
      }
    } else {
      lines.push({
        canonical: canonicalizeCall(renderWaitBlock(span).join(' ')),
        decoded: null,
        wait: span,
        instruction: null
      });
    }
  }
  return { eventId: event.eventId, restBehavior: event.restBehavior, lines };
}

/* ------------------------------------------------------------------ */
/*  User-side line parsing                                            */
/* ------------------------------------------------------------------ */

interface ParsedCall {
  name: string;
  args: EmevdDslLiteral[];
}

/**
 * 解析 `Name(a, b, true);` 调用行。数字（含负零/小数）与 true/false 之外
 * 的参数返回 null（调用方诊断「参数无法解析」）。
 */
export function parseDarkScriptCall(canonical: string): ParsedCall | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*;?$/.exec(canonical);
  if (!match) return null;
  const name = match[1]!;
  const raw = match[2]!.trim();
  if (raw === '') return { name, args: [] };
  const args: EmevdDslLiteral[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token === 'true') {
      args.push(true);
    } else if (token === 'false') {
      args.push(false);
    } else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) return null;
      args.push(value);
    } else {
      return null;
    }
  }
  return { name, args };
}

/* ------------------------------------------------------------------ */
/*  Compiler                                                          */
/* ------------------------------------------------------------------ */

export function compileEmevdDarkScript(
  request: EmevdDslCompileRequest,
  document: EmevdEditorDocument,
  registry?: EmedfRegistry
): EmevdDslCompileResult {
  const { blocks, diagnostics: parseDiagnostics } = splitDarkScriptEventBlocks(request.sourceText);
  const diagnostics = [...parseDiagnostics];

  const add = (item: EmevdDslDiagnostic): void => { diagnostics.push(item); };
  if (request.mode !== 'dark-script') {
    add(diagnostic('EMEVD_DSL_MODE_UNSUPPORTED', 'Only dark-script mode is supported.', zeroSpan()));
  }
  if (request.resourceUri !== document.resourceUri) {
    add(diagnostic('EMEVD_DSL_RESOURCE_MISMATCH', 'Resource URI does not match the opened document.', zeroSpan(), {
      resourceUri: request.resourceUri
    }));
  }
  if (document.documentInstanceId === undefined || request.documentInstanceId !== document.documentInstanceId) {
    add(diagnostic(
      'EMEVD_DSL_DOCUMENT_INSTANCE_MISMATCH',
      'Document instance is missing or stale.',
      zeroSpan(),
      { resourceUri: request.resourceUri }
    ));
  }
  if (request.baseRevision !== document.revision) {
    add(diagnostic('EMEVD_DSL_STALE_REVISION', 'Base revision is stale.', zeroSpan(), {
      resourceUri: request.resourceUri
    }));
  }
  if (!registry) {
    add(diagnostic('EMEVD_DSL_SCHEMA_REQUIRED', 'EMEDF schema is required.', zeroSpan(), {
      resourceUri: request.resourceUri
    }));
    return { ok: false, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const operations: EmevdPlannedMutation[] = [];
  const eventByAnchor = new Map<string, EmevdEditorDocument['events'][number]>();
  for (const event of document.events) {
    if (event.anchor) eventByAnchor.set(formatEmevdAnchor('event', event.anchor), event);
  }

  // 按顺序对齐事件块。块数不一致只影响对不上的块（诊断），其余照常编译。
  const eventCount = Math.max(document.events.length, blocks.length);
  for (let i = 0; i < eventCount; i += 1) {
    const docEvent = document.events[i];
    const userBlock = blocks[i];
    if (docEvent && !userBlock) {
      add(diagnostic(
        'EMEVD_DSL_EVENT_BLOCK_REMOVED',
        `事件 #${i + 1}（${docEvent.eventId}）的 $Event 块被删除；增量写链不支持删除事件。`,
        zeroSpan(),
        docEvent.anchor
          ? { resourceUri: request.resourceUri, targetAnchor: formatEmevdAnchor('event', docEvent.anchor) }
          : { resourceUri: request.resourceUri }
      ));
      continue;
    }
    if (!docEvent && userBlock) {
      add(diagnostic(
        'EMEVD_DSL_EVENT_BLOCK_ADDED',
        `新增的 $Event 块（行 ${userBlock.headerLine}，id ${userBlock.eventId}）无法写入；增量写链不支持新增事件。`,
        spanFor(userBlock.headerLine, userBlock.headerLine, request.sourceText),
        { resourceUri: request.resourceUri }
      ));
      continue;
    }
    if (!docEvent || !userBlock) continue;

    compileEventHeader(
      docEvent,
      userBlock,
      operations,
      diagnostics,
      request.sourceText,
      request.resourceUri
    );

    // 指令体：按反汇编形状逐行对齐。行数不同 = 结构变化，整事件指令跳过。
    const docShape = documentEventShape(docEvent, registry);
    if (docShape.lines.length !== userBlock.body.length) {
      add(diagnostic(
        'EMEVD_DSL_INSTRUCTION_COUNT_CHANGED',
        `事件 ${docEvent.eventId}（行 ${userBlock.headerLine}）的指令条数变了（文档 ${docShape.lines.length} 行 → 编辑 ${userBlock.body.length} 行）；`
          + '增量写链不支持新增/删除指令，该事件的指令改动未写入。',
        spanFor(userBlock.headerLine, userBlock.headerLine, request.sourceText),
        { resourceUri: request.resourceUri }
      ));
      continue;
    }
    for (let j = 0; j < docShape.lines.length; j += 1) {
      const docLine = docShape.lines[j]!;
      const userCanonical = userBlock.body[j]!;
      const userSpan = spanFor(userBlock.bodyLines[j]!.start, userBlock.bodyLines[j]!.end, request.sourceText);
      if (docLine.canonical === userCanonical) continue;
      compileLineChange(
        docLine,
        userCanonical,
        userSpan,
        docEvent,
        registry,
        operations,
        diagnostics,
        request.resourceUri
      );
    }
  }

  if (diagnostics.some((item) => item.severity === 'error')) {
    return { ok: false, diagnostics: diagnostics.sort(compareDiagnostics) };
  }

  const touchedEvents = unique(operations.map((operation) => operation.eventAnchor));
  const touchedInstructions = unique(operations.flatMap((operation) =>
    operation.kind === 'set_instruction_arg' ? [operation.instructionAnchor] : []
  ));
  const sourceFingerprint = hashText(stableJson({
    mode: 'dark-script',
    blocks: blocks.map((block) => ({ eventId: block.eventId, restBehavior: block.restBehavior, body: block.body }))
  }));
  const planWithoutFingerprint = {
    schemaVersion: 1 as const,
    resourceUri: request.resourceUri,
    documentInstanceId: request.documentInstanceId,
    baseRevision: request.baseRevision,
    sourceFingerprint,
    schemaFingerprint: fingerprint(registry),
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
    planFingerprint: hashText(stableJson({
      ...planWithoutFingerprint,
      operations: planWithoutFingerprint.operations.map(({ sourceSpan: _span, ...op }) => op)
    }))
  };
  // 编译结果的 ast 是事件块摘要（编译器按位置对齐，没有 patch-DSL 的 anchor 语义）。
  const ast: EmevdDslDocument = {
    schemaVersion: 1,
    resourceUri: request.resourceUri,
    baseRevision: request.baseRevision,
    emedfSchemaFingerprint: request.emedfSchemaFingerprint,
    events: blocks.map((block) => ({
      anchor: '',
      operations: [],
      instructions: [],
      span: spanFor(block.headerLine, block.headerLine, request.sourceText)
    })),
    span: zeroSpan()
  };
  return { ok: true, ast, diagnostics: diagnostics.sort(compareDiagnostics), plan };
}

function fingerprint(registry: EmedfRegistry): string {
  const normalized = {
    schemaVersion: registry.schemaVersion,
    game: registry.game,
    origin: registry.origin,
    instructions: [...registry.instructions]
      .sort((a, b) => a.bank - b.bank || a.id - b.id || a.name.localeCompare(b.name))
      .map((instruction) => ({
        bank: instruction.bank,
        id: instruction.id,
        name: instruction.name,
        args: instruction.args.map((arg) => ({ name: arg.name, type: arg.type }))
      }))
  };
  return hashText(stableJson(normalized));
}

function compileEventHeader(
  docEvent: EmevdEditorDocument['events'][number],
  userBlock: ParsedEventBlock,
  operations: EmevdPlannedMutation[],
  diagnostics: EmevdDslDiagnostic[],
  sourceText: string,
  resourceUri: string
): void {
  const add = (item: EmevdDslDiagnostic): void => { diagnostics.push(item); };
  const anchor = docEvent.anchor;
  if (!anchor) {
    add(diagnostic(
      'EMEVD_DSL_ANCHOR_NOT_FOUND',
      `事件 ${docEvent.eventId} 没有稳定锚，无法写入事件头。`,
      spanFor(userBlock.headerLine, userBlock.headerLine, sourceText),
      { resourceUri }
    ));
    return;
  }
  const eventAnchor = formatEmevdAnchor('event', anchor);
  const precondition = computeEmevdEventFingerprint(docEvent);
  if (!Number.isSafeInteger(userBlock.eventId) || userBlock.eventId < 0) {
    add(diagnostic('EMEVD_DSL_INTEGER_OUT_OF_RANGE', 'Event ID must be a non-negative safe integer.', spanFor(userBlock.headerLine, userBlock.headerLine, sourceText), { resourceUri }));
  } else if (userBlock.eventId !== docEvent.eventId) {
    operations.push({
      kind: 'set_event_id',
      eventAnchor,
      target: anchor,
      targetPreconditionHash: precondition,
      sourceSpan: spanFor(userBlock.headerLine, userBlock.headerLine, sourceText),
      before: docEvent.eventId,
      after: userBlock.eventId
    });
  }
  if (!Number.isInteger(userBlock.restBehavior) || userBlock.restBehavior < 0 || userBlock.restBehavior > 255) {
    add(diagnostic('EMEVD_DSL_INTEGER_OUT_OF_RANGE', 'Rest behavior must fit u8.', spanFor(userBlock.headerLine, userBlock.headerLine, sourceText), { resourceUri }));
  } else if (userBlock.restBehavior !== docEvent.restBehavior) {
    operations.push({
      kind: 'set_event_rest_behavior',
      eventAnchor,
      target: anchor,
      targetPreconditionHash: precondition,
      sourceSpan: spanFor(userBlock.headerLine, userBlock.headerLine, sourceText),
      before: docEvent.restBehavior,
      after: userBlock.restBehavior
    });
  }
}

function compileLineChange(
  docLine: Awaited<ReturnType<typeof documentEventShape>>['lines'][number],
  userCanonical: string,
  userSpan: EmevdDslSourceSpan,
  docEvent: EmevdEditorDocument['events'][number],
  registry: EmedfRegistry,
  operations: EmevdPlannedMutation[],
  diagnostics: EmevdDslDiagnostic[],
  resourceUri: string
): void {
  const add = (item: EmevdDslDiagnostic): void => { diagnostics.push(item); };

  // WaitFor 折叠块：condition group 簿记参数在渲染时被隐藏，无法还原。
  if (docLine.wait) {
    add(diagnostic(
      'EMEVD_DSL_WAITFOR_READONLY',
      `WaitFor( 折叠块被修改（${userCanonical}）。折叠块的条件组参数在源码里不可见，`
        + '无法写回；请保持折叠块原样，直接修改其外部的普通指令。',
      userSpan,
      { resourceUri }
    ));
    return;
  }
  const decoded = docLine.decoded;
  const instruction = docLine.instruction;
  if (!decoded || !instruction) return;
  if (decoded.status.kind !== 'ok') {
    add(diagnostic(
      'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
      `行 ${userCanonical}：文档里这条指令（bank=${decoded.bank} id=${decoded.id}）未解码，无法写回。`,
      userSpan,
      { resourceUri }
    ));
    return;
  }
  const userCall = parseDarkScriptCall(userCanonical);
  if (!userCall) {
    add(diagnostic(
      'EMEVD_DSL_LINE_UNPARSEABLE',
      `行 ${userCanonical} 无法解析为调用（参数必须是数字或 true/false）。`,
      userSpan,
      { resourceUri }
    ));
    return;
  }
  if (userCall.name !== toPascalCase(decoded.name)) {
    add(diagnostic(
      'EMEVD_DSL_INSTRUCTION_NAME_CHANGED',
      `指令名从 ${toPascalCase(decoded.name)} 改成了 ${userCall.name}；增量写链不支持替换指令。`,
      userSpan,
      { resourceUri }
    ));
    return;
  }
  if (userCall.args.length !== decoded.args.length) {
    add(diagnostic(
      'EMEVD_DSL_ARG_COUNT_MISMATCH',
      `${userCall.name} 参数个数不对（文档 ${decoded.args.length} 个，编辑 ${userCall.args.length} 个）。`,
      userSpan,
      { resourceUri }
    ));
    return;
  }
  const anchor = instruction.anchor;
  if (!anchor) {
    add(diagnostic(
      'EMEVD_DSL_ANCHOR_NOT_FOUND',
      `指令 ${userCall.name}（行内位置 ${userSpan.start.line}）没有稳定锚，无法写回。`,
      userSpan,
      { resourceUri }
    ));
    return;
  }
  const def = findInstructionDef(registry, decoded.bank, decoded.id);
  if (!def) {
    add(diagnostic(
      'EMEVD_DSL_UNKNOWN_INSTRUCTION_READONLY',
      `指令 ${userCall.name} 没有 EMEDF schema，无法写回。`,
      userSpan,
      { resourceUri }
    ));
    return;
  }
  const eventAnchor = docEvent.anchor ? formatEmevdAnchor('event', docEvent.anchor) : '';
  if (!eventAnchor) {
    add(diagnostic(
      'EMEVD_DSL_ANCHOR_PRECONDITION_FAILED',
      `事件 ${docEvent.eventId} 没有稳定锚。`,
      userSpan,
      { resourceUri }
    ));
    return;
  }
  const precondition = computeEmevdInstructionFingerprint(instruction);
  for (let k = 0; k < decoded.args.length; k += 1) {
    const arg = decoded.args[k]!;
    const userValue = userCall.args[k]!;
    // vararg 尾部是整体不透明载荷，与 patch-DSL 同一把尺子：只读。
    const argDef = def.args[k];
    if (argDef?.vararg) {
      if (!Object.is(arg.value, userValue)) {
        add(diagnostic(
          'EMEVD_DSL_VARARG_ARG_READONLY',
          `参数 ${arg.name} 是变长尾部，只能整体保留；请改固定参数。`,
          userSpan,
          { resourceUri }
        ));
      }
      continue;
    }
    const valueError = validateTypedLiteral(arg.type, userValue);
    if (valueError) {
      add(diagnostic(valueError.code, valueError.message, userSpan, {
        resourceUri,
        targetAnchor: formatEmevdAnchor('instruction', anchor)
      }));
      continue;
    }
    if (Object.is(arg.value, userValue)) continue;
    operations.push({
      kind: 'set_instruction_arg',
      eventAnchor,
      instructionAnchor: formatEmevdAnchor('instruction', anchor),
      target: anchor,
      targetPreconditionHash: precondition,
      sourceSpan: userSpan,
      bank: decoded.bank,
      id: decoded.id,
      argument: arg.name,
      before: arg.value,
      after: userValue
    });
  }
}

function zeroSpan(): EmevdDslSourceSpan {
  return {
    start: { offset: 0, line: 0, column: 0 },
    end: { offset: 0, line: 0, column: 0 }
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareDiagnostics(a: EmevdDslDiagnostic, b: EmevdDslDiagnostic): number {
  return a.span.start.offset - b.span.start.offset || a.code.localeCompare(b.code) || a.message.localeCompare(b.message);
}
