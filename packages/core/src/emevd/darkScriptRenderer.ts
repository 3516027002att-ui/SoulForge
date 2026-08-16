/**
 * DarkScript3-style EMEVD source renderer.
 *
 * Renders an EmevdEditorDocument (bound to an EMEDF registry) into the
 * DarkScript3 / MattScript source shape the user ruled for the event
 * workbench (R3/P4):
 *
 *   $Event(0, Default, function() {
 *       InitializeEvent(0, 77770001, 0);
 *       ...
 *   });
 *
 *   $Event(965672, Restart, function() {
 *       WaitFor(
 *           PlayerHasItem(ItemType.Goods, 2498)
 *           && CharacterHasSpEffect(10000, 127800)
 *           && CharacterHasSpEffect(10000, 110140));
 *       WaitFixedTimeFrames(3);
 *       ...
 *   });
 *
 * Instruction names come from EMEDF (never the raw bank:id hash), and every
 * name is PascalCased. When the bound registry has no definition for an
 * instruction, or the payload does not decode, the renderer fails closed into
 * an honest `// unknown ...` / `// <code> ...` comment instead of fabricating
 * a function call. This module is a pure function of (document, registry):
 * no filesystem, no mutation, no side effects.
 *
 * Condition folding (see `splitIntoSpans` / `predicatesBefore` below for the
 * full rule):
 *
 * Real Sekiro EMEDF has no "IF OR Condition Group"-style instruction — every
 * condition predicate (bank 0..13, e.g. "IF Player Has Item",
 * "IF Character Has SpEffect") carries a `Result Condition Group` slot, and the
 * logical operators are expressed only through *which* condition group each
 * predicate writes to, plus the group-join instruction that plugs a sub-group
 * into the MAIN group (0). DarkScript3's own decompiler reconstructs `&&` / `||`
 * from a full control-flow-graph + condition-group data-flow analysis; the
 * AND/OR distinction is encoded in the group *numbering convention* (and## /
 * or##) which is lost in the binary. We therefore only fold the one case that
 * is decidable from linear structure alone, and fall back to plain per-
 * instruction calls in every other case:
 *
 *   - a "wait block" is anchored by `IF Condition Group` (bank 0, id 0) whose
 *     result group is MAIN (0), or by `WAIT For Condition Group State`
 *     (bank 1000, id 0) whose target group is MAIN (0);
 *   - every predicate immediately preceding the anchor that writes to *the same
 *     non-MAIN* result condition group is joined with `&&`;
 *   - anything else (multiple distinct sub-groups, interleaved non-predicate
 *     instructions, predicates writing back to an Or-group) is NOT folded — the
 *     instructions are rendered as ordinary calls, which never fabricates
 *     boolean structure.
 */

import type { EmevdEditorDocument, EmevdEventIr, EmevdInstructionIr } from '@soulforge/shared';
import { decodeStrictBase64 } from '../util/base64.js';
import { decodeInstructionArgs, findInstructionDef, type DecodedArg, type EmedfRegistry } from './emedfSchema.js';
import type { BoundedEmevdPatchDsl } from './dslRenderer.js';

const INDENT = '    '; // 4 spaces for instruction bodies

/**
 * Render a full DarkScript3 source view (unbounded).
 */
export function renderEmevdDarkScript(document: EmevdEditorDocument, registry: EmedfRegistry): string {
  return renderEmevdDarkScriptBounded(document, registry, undefined).text;
}

/**
 * Bounded DarkScript3 renderer. Truncation happens only at an event-block
 * boundary (`});`), mirroring the dslRenderer approach, so the visible text
 * stays a well-formed prefix of the source. The trailing marker is a comment.
 */
export function renderEmevdDarkScriptBounded(
  document: EmevdEditorDocument,
  registry: EmedfRegistry,
  lineLimit: number | undefined
): BoundedEmevdPatchDsl {
  const lines: string[] = [];
  for (const event of document.events) {
    lines.push(...renderEventLines(event, registry));
  }

  const totalLines = lines.length;
  if (lineLimit === undefined || totalLines <= lineLimit) {
    return finalizeUntruncated(lines, totalLines);
  }

  // Back up to the last completed event block (a `});` line) at or below the
  // cap; if the cap lands inside the first event, extend forward to its `});`.
  let safeBreak = -1;
  for (let i = 0; i < lineLimit; i += 1) {
    if (lines[i] === '});') safeBreak = i + 1;
  }
  if (safeBreak <= 0) {
    for (let i = lineLimit; i < lines.length; i += 1) {
      if (lines[i] === '});') {
        safeBreak = i + 1;
        break;
      }
    }
  }
  const shownLines = safeBreak > 0 ? safeBreak : lines.length;
  const shown = lines.slice(0, shownLines);
  shown.push(
    '',
    `// DARKSCRIPT_TRUNCATED: 完整源码共 ${totalLines} 行，已显示 ${shownLines} 行。`,
    '// 源码仅作查看/导出；截断不影响解码，剩余事件可提升行数上限后重看。'
  );
  return { text: shown.join('\n'), truncated: true, totalLines, shownLines };
}

/**
 * 未截断结果的唯一收尾规则：一次 join，一次 trimEnd。
 *
 * 同步与异步两条路径都从这里出结果，`pieces` 的粒度不同（同步是逐行，异步是逐
 * 事件的整块），但 `join('\n')` 对两种粒度等价 —— 每个事件块内部已含自己的换行，
 * 块间那一个换行由 join 补上。收敛成一个函数是为了不出现第二套输出规则：
 * 尾部换行、空文档、trimEnd 的行为只在这一处定义。
 */
function finalizeUntruncated(pieces: string[], totalLines: number): BoundedEmevdPatchDsl {
  return {
    text: pieces.join('\n').trimEnd(),
    truncated: false,
    totalLines,
    shownLines: totalLines
  };
}

export interface RenderEmevdDarkScriptAsyncOptions {
  /** 取消信号。每次让出前后各查一次；取消不返回半成品源码。 */
  signal?: AbortSignal;
  /** 单个同步切片的软预算（毫秒），缺省 8。 */
  sliceBudgetMs?: number;
  /** 至多连续渲染多少个事件才强制查一次时钟，缺省 64。 */
  eventsPerClockCheck?: number;
}

export interface RenderEmevdDarkScriptAsyncResult extends BoundedEmevdPatchDsl {
  /** 被取消。取消时 `text` 恒为空串，不返回半成品。 */
  cancelled: boolean;
}

/**
 * 分片异步反汇编。输出与 `renderEmevdDarkScriptBounded(document, registry, undefined)`
 * 逐字节相同。
 *
 * 为什么需要它：真实 common.emevd（1730 事件 / 33266 指令）同步渲染约 75 ms，
 * 这 75 ms 里主进程事件循环完全停摆 —— 期间到达的 IPC、定时器、取消信号都排队等着。
 * 打开事件文档正是用户最可能马上切走的时刻，而那一刻的取消信号恰好被这段同步任务
 * 堵在队列里，等它跑完才被看见，于是「取消」变成「取消不掉」。
 *
 * 做法是协作式让出：按事件（不是按行、不是按指令）累积字符串块，每约
 * `sliceBudgetMs` 毫秒 `setImmediate` 让一次，让出前后各查一次 signal。事件是最小
 * 不可分单位 —— 折叠判定要看整段指令流，切在事件中间会改变输出。
 *
 * 复用同步侧的 `renderEventLines` 与 `finalizeUntruncated`，没有第二套输出规则：
 * 失败注释、unknown 指令、WaitFor 折叠、行数、尾换行都由同一份代码决定。
 *
 * 只做无界渲染：production 入口（ipc.ts）T4 之后就传 undefined 行上限，截断路径
 * 只剩同步调用方（core smoke）在用，没必要复制一份截断逻辑。
 */
export async function renderEmevdDarkScriptAsync(
  document: EmevdEditorDocument,
  registry: EmedfRegistry,
  options: RenderEmevdDarkScriptAsyncOptions = {}
): Promise<RenderEmevdDarkScriptAsyncResult> {
  const signal = options.signal;
  const sliceBudgetMs = Math.max(1, options.sliceBudgetMs ?? 8);
  const eventsPerClockCheck = Math.max(1, options.eventsPerClockCheck ?? 64);
  if (signal?.aborted) return cancelledRender();

  const chunks: string[] = [];
  let totalLines = 0;
  let sinceCheck = 0;
  let sliceStart = performance.now();

  for (const event of document.events) {
    const lines = renderEventLines(event, registry);
    totalLines += lines.length;
    chunks.push(lines.join('\n'));
    sinceCheck += 1;
    if (sinceCheck < eventsPerClockCheck && performance.now() - sliceStart < sliceBudgetMs) {
      continue;
    }
    sinceCheck = 0;
    if (performance.now() - sliceStart < sliceBudgetMs) continue;
    // 让出前查一次：已取消就不必再付一次 setImmediate 往返。
    if (signal?.aborted) return cancelledRender();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    // 让出后再查一次：signal 恰好在这次让出期间被触发是最常见的取消时机 ——
    // 主进程事件循环空出来的这一瞬间，正是排队的取消信号被处理的时候。
    if (signal?.aborted) return cancelledRender();
    sliceStart = performance.now();
  }

  if (signal?.aborted) return cancelledRender();
  return { ...finalizeUntruncated(chunks, totalLines), cancelled: false };
}

/** 取消结果。text 恒为空串：半成品源码比没有源码更糟，它看起来像一份完整文档。 */
function cancelledRender(): RenderEmevdDarkScriptAsyncResult {
  return { text: '', truncated: false, totalLines: 0, shownLines: 0, cancelled: true };
}

/**
 * Render one event into `$Event(<id>, <Default|Restart>, function() { ... });`.
 * The event header line is NOT indented (DarkScript3 top-level style); the
 * closing `});` is a standalone line at column 0.
 *
 * 导出给 darkScriptCompiler：编译器按「反汇编形状」把用户编辑后的 `$Event`
 * 文本与文档逐事件逐行对齐，必须与渲染侧共用同一份行切分与折叠判定。
 */
export function renderEventLines(event: EmevdEventIr, registry: EmedfRegistry): string[] {
  const header = `$Event(${event.eventId}, ${formatRestBehavior(event.restBehavior)}, function() {`;
  const body: string[] = [];

  // Group the linear instruction stream into folded wait-blocks first, then
  // render whatever remains as ordinary calls.
  const spans = splitIntoSpans(event.instructions, registry);
  for (const span of spans) {
    if (span.kind === 'wait-block') {
      body.push(...renderWaitBlock(span));
    } else {
      for (const item of span.instructions) body.push(renderInstructionLine(item));
    }
  }

  if (body.length === 0) {
    return [header, '});'];
  }
  return [header, ...body.map((line) => `${INDENT}${line}`), '});'];
}

/**
 * restBehavior 0 → Default, 1 → Restart; any other value is rendered verbatim
 * with a comment flagging it as an unrecognized rest behavior.
 */
export function formatRestBehavior(restBehavior: number): string {
  if (restBehavior === 0) return 'Default';
  if (restBehavior === 1) return 'Restart';
  return `${restBehavior} /* unknown restBehavior */`;
}

/**
 * Render one decodable instruction as `Name(arg1, arg2, ...);`.
 * Unknown instructions and decode failures become honest comments.
 *
 * 输入是 decodeForRender 的结果（每条指令只解码一次），三种失败态的注释文本与
 * 单次解码前逐字相同：unknown / BASE64_INVALID / <原始 code>。
 *
 * 导出给 darkScriptCompiler：普通指令行的 canonical 形状由这里决定。
 */
export function renderInstructionLine(item: DecodedInstruction): string {
  switch (item.status.kind) {
    case 'unknown':
      return `// unknown bank=${item.bank} id=${item.id}`;
    case 'base64-invalid':
      return `// BASE64_INVALID bank=${item.bank} id=${item.id}`;
    case 'decode-failed':
      return `// ${item.status.code} bank=${item.bank} id=${item.id}`;
    default:
      return `${toPascalCase(item.name)}(${item.args.map(formatArgLiteral).join(', ')});`;
  }
}

/** Render an individual predicate or ordinary argument list entry. */
function formatArgLiteral(arg: DecodedArg): string {
  if (typeof arg.value === 'boolean') return arg.value ? 'true' : 'false';
  if (!Number.isFinite(arg.value)) throw new Error('DARKSCRIPT_RENDER_NON_FINITE_VALUE');
  return Object.is(arg.value, -0) ? '-0' : String(arg.value);
}

/* ------------------------------------------------------------------ */
/*  Condition folding                                                  */
/* ------------------------------------------------------------------ */

export type Span =
  | { kind: 'ordinary'; instructions: DecodedInstruction[] }
  | { kind: 'wait-block'; predicates: DecodedInstruction[]; anchor: DecodedInstruction };

/**
 * 解码一条指令的结果。`status` 让渲染阶段不必重新解码就能写出与失败原因一致的
 * 注释：
 *   'unknown'        → instruction.unknown 或 registry 无该 bank:id 定义
 *   'base64-invalid' → argsBase64 不是严格 base64
 *   'decode-failed'  → 结构性解码失败（长度签名不符等），code 是原始错误码
 *   'ok'             → args 可用
 *
 * 折叠判定（isPredicate / isWaitAnchor / firstNamedArg）只看 args，失败态 args
 * 恒为空数组，因此三种失败态都自然地不可折叠 —— 与单次解码前的行为一致。
 */
type DecodeStatus =
  | { kind: 'ok' }
  | { kind: 'unknown' }
  | { kind: 'base64-invalid' }
  | { kind: 'decode-failed'; code: string };

export interface DecodedInstruction {
  instruction: EmevdInstructionIr;
  bank: number;
  id: number;
  /** EMEDF 原始指令名（未 PascalCase）；失败态为空串。 */
  name: string;
  args: DecodedArg[];
  status: DecodeStatus;
}

/**
 * Split a linear event body into ordinary runs and folded wait-blocks.
 *
 * Anchors and predicates are recognized structurally from the EMEDF *argument
 * names*, so the rule holds for any imported Sekiro EMEDF without hardcoding
 * bank:id beyond the two anchor instructions whose semantics are fixed by the
 * file format:
 *
 *   anchor A — `IF Condition Group` (bank 0, id 0): first arg is the result
 *     condition group, last arg is the target condition group. A wait folds the
 *     MAIN group when result group === 0.
 *   anchor B — `WAIT For Condition Group State` (bank 1000, id 0): its target
 *     condition group === 0 evaluates the MAIN group (WaitFor).
 *
 * A predicate is any decoded instruction whose FIRST argument name matches
 * /resultconditiongroup/i (e.g. `resultConditionGroup`, `resultConditionGroupId`).
 * Predicates write to the same non-MAIN group and are joined with `&&`.
 */
export function splitIntoSpans(instructions: EmevdInstructionIr[], registry: EmedfRegistry): Span[] {
  const decoded = instructions.map((instruction) => decodeForRender(instruction, registry));
  const spans: Span[] = [];
  let ordinaryBuffer: DecodedInstruction[] = [];

  const flushOrdinary = (): void => {
    if (ordinaryBuffer.length > 0) {
      spans.push({ kind: 'ordinary', instructions: ordinaryBuffer });
      ordinaryBuffer = [];
    }
  };

  let index = 0;
  while (index < decoded.length) {
    const item = decoded[index]!;
    if (isWaitAnchor(item)) {
      // Collect the maximal run of same-group predicates immediately before
      // the anchor. Only a single, unambiguous group is foldable.
      const group = predicatesBefore(decoded, index);
      if (group) {
        // Those predicates were already pushed onto `ordinaryBuffer` while this
        // loop walked forward; rewind them so they render only inside the fold.
        for (let k = 0; k < group.predicates.length; k += 1) ordinaryBuffer.pop();
        flushOrdinary();
        spans.push({ kind: 'wait-block', predicates: group.predicates, anchor: group.anchor });
        index += 1;
        continue;
      }
    }
    // Not part of a foldable block: render this instruction ordinarily.
    ordinaryBuffer.push(item);
    index += 1;
  }

  flushOrdinary();
  return spans;
}

/**
 * True when a decoded instruction is one of the two wait anchors targeting MAIN.
 */
function isWaitAnchor(item: DecodedInstruction): boolean {
  if (item.bank === 0 && item.id === 0) {
    // "IF Condition Group": result condition group (index 0) + target (last).
    const result = firstNamedArg(item, /resultconditiongroup/i);
    const target = lastNamedArg(item, /targetconditiongroup/i);
    return result !== undefined && target !== undefined && result === 0;
  }
  if (item.bank === 1000 && item.id === 0) {
    // "WAIT For Condition Group State": target condition group only.
    const target = lastNamedArg(item, /targetconditiongroup/i);
    return target !== undefined && target === 0;
  }
  return false;
}

/**
 * Walk backwards from `anchorIndex` collecting the contiguous predicate
 * instructions that write to a single, shared, non-MAIN result condition group.
 * Returns null when there is no such unambiguous group (zero predicates, mixed
 * groups, a gap caused by a non-predicate, or a group number of 0).
 */
function predicatesBefore(
  decoded: DecodedInstruction[],
  anchorIndex: number
): { anchor: DecodedInstruction; predicates: DecodedInstruction[] } | null {
  const predicates: DecodedInstruction[] = [];
  let sharedGroup: number | undefined;
  for (let i = anchorIndex - 1; i >= 0; i -= 1) {
    const item = decoded[i]!;
    // Stop the run at the first non-predicate; intervening ordinary
    // instructions make the block ambiguous and non-foldable.
    if (!isPredicate(item)) break;
    const result = firstNamedArg(item, /resultconditiongroup/i);
    if (result === undefined || result === 0) break; // MAIN write is not a predicate group
    if (sharedGroup === undefined) {
      sharedGroup = result;
    } else if (result !== sharedGroup) {
      // Mixed sub-groups before one anchor: could be an Or/And combination that
      // linear structure alone cannot distinguish. Fail closed (no fold).
      return null;
    }
    predicates.push(item);
  }
  if (predicates.length === 0) return null;
  // Reorder back to source order.
  predicates.reverse();
  return { anchor: decoded[anchorIndex]!, predicates };
}

/**
 * True when the instruction is a condition predicate: a decoded instruction
 * whose first argument is a result condition group reference. The anchor
 * `IF Condition Group` itself also has a result-condition-group first arg, so
 * it is excluded explicitly — it is a group-join, not a predicate.
 */
function isPredicate(item: DecodedInstruction): boolean {
  if (item.bank === 0 && item.id === 0) return false; // IF Condition Group join
  if (item.bank === 1000 && item.id === 0) return false; // WAIT anchor
  if (item.args.length === 0) return false;
  return /resultconditiongroup/i.test(item.args[0]!.name);
}

/**
 * Render a folded wait-block as `WaitFor(p1 && p2 && ...)`. The anchor itself —
 * `IF Condition Group` / `WAIT For Condition Group State` — is the low-level
 * spelling of `WaitFor(MAIN)`, so it becomes the `WaitFor(` wrapper instead of
 * a standalone line. Predicate condition-group bookkeeping args are hidden
 * (their purpose is expressed by the fold); remaining args render as values.
 *
 * Returns one element per source line; `renderEventLines` applies the shared
 * 4-space event-body indent, so a line carrying an extra `INDENT` lands at the
 * 8-space continuation column that matches the DarkScript3 example.
 */
export function renderWaitBlock(
  span: { predicates: DecodedInstruction[]; anchor: DecodedInstruction }
): string[] {
  const calls = span.predicates.map((predicate) =>
    `${toPascalCase(predicate.name)}(${predicate.args
      .filter((arg) => !isConditionGroupArg(arg))
      .map(formatArgLiteral)
      .join(', ')})`
  );
  if (calls.length === 1) {
    return [`WaitFor(${calls[0]});`];
  }
  const lines: string[] = ['WaitFor('];
  calls.forEach((call, i) => {
    lines.push(`${INDENT}${i === 0 ? call : `&& ${call}`}${i === calls.length - 1 ? ');' : ''}`);
  });
  return lines;
}

/** True for the bookkeeping args expressed by the fold itself. */
function isConditionGroupArg(arg: DecodedArg): boolean {
  return /conditiongroup/i.test(arg.name);
}

/* ------------------------------------------------------------------ */
/*  Name casing                                                       */
/* ------------------------------------------------------------------ */

/**
 * PascalCase an EMEDF instruction name.
 *
 * The external adapter (`sanitizeInstructionName`) removes spaces and
 * uppercases each word's first letter but leaves all-caps words (the IF/WAIT/
 * END/SKIP/GOTO control-flow prefixes) intact, producing `IFConditionGroup`,
 * `WAITForConditionGroupState`, `ENDIFConditionGroupStateCompiled`, ... The
 * user-ruled DarkScript3 shape wants true PascalCase (`IfConditionGroup`).
 *
 * This is done *here*, as a pure function of the already-sanitized name, so the
 * adapter (and its locked smoke assertions) are untouched. Rules:
 *   1. Expand the EMEDF compound control-flow prefixes `END IF`/`SKIP IF`/
 *      `GOTO IF`, which the adapter concatenates as `ENDIF`/`SKIPIF`/`GOTOIF`
 *      (two consecutive all-caps words with no lowercase boundary between
 *      them, hence invisible to the generic word split below).
 *   2. Split on camelCase boundaries (lowercase/digit→Uppercase and a run of
 *      capitals followed by a Titlecase word).
 *   3. Title-case only words that are ALL-CAPS (an acronym like IF/WAIT/END);
 *      every other word is already a correctly-cased word (or itself an
 *      already-camelCased compound) and is left as-is, so the transform is
 *      idempotent on names the fixture already writes in final form.
 */
/**
 * 结果按名字缓存：转换是纯函数，而 EMEDF 只有几百个不同指令名，反汇编却要渲染
 * 数万行 —— 每行重跑 6 条正则 + split/map/join 是纯浪费。缓存不改变任何输出。
 */
const pascalCaseCache = new Map<string, string>();

export function toPascalCase(name: string): string {
  const cached = pascalCaseCache.get(name);
  if (cached !== undefined) return cached;
  const converted = toPascalCaseUncached(name);
  pascalCaseCache.set(name, converted);
  return converted;
}

function toPascalCaseUncached(name: string): string {
  let s = name;
  s = s
    .replace(/^ENDIF/, 'EndIf')
    .replace(/^SKIPIF/, 'SkipIf')
    .replace(/^GOTOIF/, 'GotoIf');
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word === word.toUpperCase() && /[A-Z]/.test(word)
        ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        : word
    )
    .join('');
}

/* ------------------------------------------------------------------ */
/*  Decode helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * 每条指令只解码一次。折叠判定与行渲染共用同一份结果 —— 之前 splitIntoSpans 与
 * renderInstructionLine 各自解码一遍（base64 + decodeInstructionArgs），
 * 33266 条指令等于付两倍成本。
 */
export function decodeForRender(instruction: EmevdInstructionIr, registry: EmedfRegistry): DecodedInstruction {
  const bank = instruction.bank;
  const id = instruction.id;
  if (instruction.unknown) {
    return { instruction, bank, id, name: '', args: [], status: { kind: 'unknown' } };
  }
  const definition = findInstructionDef(registry, bank, id);
  if (!definition) {
    return { instruction, bank, id, name: '', args: [], status: { kind: 'unknown' } };
  }
  let rawArgs: Buffer;
  try {
    rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
  } catch {
    return {
      instruction, bank, id, name: definition.name, args: [], status: { kind: 'base64-invalid' }
    };
  }
  const result = decodeInstructionArgs(registry, bank, id, rawArgs);
  if (!result.ok) {
    return {
      instruction, bank, id, name: definition.name, args: [],
      status: { kind: 'decode-failed', code: result.code }
    };
  }
  return { instruction, bank, id, name: definition.name, args: result.args, status: { kind: 'ok' } };
}

function firstNamedArg(item: DecodedInstruction, pattern: RegExp): number | undefined {
  for (const arg of item.args) {
    if (typeof arg.value === 'number' && Number.isInteger(arg.value) && pattern.test(arg.name)) {
      return arg.value;
    }
  }
  return undefined;
}

function lastNamedArg(item: DecodedInstruction, pattern: RegExp): number | undefined {
  for (let i = item.args.length - 1; i >= 0; i -= 1) {
    const arg = item.args[i]!;
    if (typeof arg.value === 'number' && Number.isInteger(arg.value) && pattern.test(arg.name)) {
      return arg.value;
    }
  }
  return undefined;
}
