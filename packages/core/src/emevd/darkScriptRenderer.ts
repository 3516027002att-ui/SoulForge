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
    return {
      text: lines.join('\n').trimEnd(),
      truncated: false,
      totalLines,
      shownLines: totalLines
    };
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
 * Render one event into `$Event(<id>, <Default|Restart>, function() { ... });`.
 * The event header line is NOT indented (DarkScript3 top-level style); the
 * closing `});` is a standalone line at column 0.
 */
function renderEventLines(event: EmevdEventIr, registry: EmedfRegistry): string[] {
  const header = `$Event(${event.eventId}, ${formatRestBehavior(event.restBehavior)}, function() {`;
  const body: string[] = [];

  // Group the linear instruction stream into folded wait-blocks first, then
  // render whatever remains as ordinary calls.
  const spans = splitIntoSpans(event.instructions, registry);
  for (const span of spans) {
    if (span.kind === 'wait-block') {
      body.push(...renderWaitBlock(span));
    } else {
      body.push(...span.instructions.map((instruction) => renderInstructionLine(instruction, registry)));
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
function formatRestBehavior(restBehavior: number): string {
  if (restBehavior === 0) return 'Default';
  if (restBehavior === 1) return 'Restart';
  return `${restBehavior} /* unknown restBehavior */`;
}

/**
 * Render one decodable instruction as `Name(arg1, arg2, ...);`.
 * Unknown instructions and decode failures become honest comments.
 */
function renderInstructionLine(instruction: EmevdInstructionIr, registry: EmedfRegistry): string {
  if (instruction.unknown) {
    return `// unknown bank=${instruction.bank} id=${instruction.id}`;
  }
  const definition = findInstructionDef(registry, instruction.bank, instruction.id);
  if (!definition) {
    return `// unknown bank=${instruction.bank} id=${instruction.id}`;
  }

  let rawArgs: Buffer;
  try {
    rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
  } catch {
    return `// BASE64_INVALID bank=${instruction.bank} id=${instruction.id}`;
  }

  const decoded = decodeInstructionArgs(registry, instruction.bank, instruction.id, rawArgs);
  if (!decoded.ok) {
    return `// ${decoded.code} bank=${instruction.bank} id=${instruction.id}`;
  }

  return `${toPascalCase(definition.name)}(${decoded.args.map(formatArgLiteral).join(', ')});`;
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

type Span =
  | { kind: 'ordinary'; instructions: EmevdInstructionIr[] }
  | { kind: 'wait-block'; predicates: DecodedInstruction[]; anchor: DecodedInstruction };

interface DecodedInstruction {
  instruction: EmevdInstructionIr;
  bank: number;
  id: number;
  name: string;
  args: DecodedArg[];
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
function splitIntoSpans(instructions: EmevdInstructionIr[], registry: EmedfRegistry): Span[] {
  const decoded = instructions.map((instruction) => decodeForRender(instruction, registry));
  const spans: Span[] = [];
  let ordinaryBuffer: EmevdInstructionIr[] = [];

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
    ordinaryBuffer.push(item.instruction);
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
function renderWaitBlock(
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
function toPascalCase(name: string): string {
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

function decodeForRender(instruction: EmevdInstructionIr, registry: EmedfRegistry): DecodedInstruction {
  if (instruction.unknown) {
    return { instruction, bank: instruction.bank, id: instruction.id, name: '', args: [] };
  }
  const definition = findInstructionDef(registry, instruction.bank, instruction.id);
  const decoded: DecodedArg[] = [];
  let name = '';
  if (definition) {
    name = definition.name;
    try {
      const rawArgs = decodeStrictBase64(instruction.argsBase64, { allowEmpty: true });
      const result = decodeInstructionArgs(registry, instruction.bank, instruction.id, rawArgs);
      if (result.ok) {
        for (const arg of result.args) decoded.push(arg);
      }
    } catch {
      // leave args empty — treated as non-foldable, rendered via comment path
    }
  }
  return { instruction, bank: instruction.bank, id: instruction.id, name, args: decoded };
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
