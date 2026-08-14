/**
 * DarkScript3-style EMEVD source renderer smoke.
 *
 * Covers: $Event header (Default/Restart/unknown), instruction call rendering
 * with EMEDF-derived PascalCase names, condition folding into `WaitFor(A && B)`,
 * unknown-instruction comments, decode-failure comments, empty event bodies,
 * and truncation at event-block boundaries.
 *
 * All EMEDF data here is synthetic and self-authored; the registry is built
 * through parseDs3EmedfJson so the real sanitization rules (space-cased
 * instruction names → PascalCase, arg names → camelCase) are exercised.
 */
import { createEmevdEditorDocument } from '../editing/emevdFourViewController.js';
import { parseDs3EmedfJson } from '../emevd/emedfExternalAdapter.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { renderEmevdDarkScript, renderEmevdDarkScriptBounded } from '../emevd/darkScriptRenderer.js';

/**
 * Synthetic DarkScript3-format EMEDF JSON covering the instructions this smoke
 * needs. Layouts are self-authored; lengths are chosen to be decodable.
 *   - 0:0      IF Condition Group             {s8 result, u8 state, s8 target}
 *   - 1000:0   WAIT For Condition Group State  {u8 state, s8 target}
 *   - 2000:0   Initialize Event                {s32 slot, u32 eventId, u32 vararg}
 *   - 4:10     IF Player Has Item              {s8 result, u32 itemType, u32 itemId}
 *   - 4:11     IF Character Has SpEffect       {s8 result, u32 chr, u32 spEffect}
 * All explicitly synthetic — never a dump of any real EMEDF file.
 */
function createSyntheticRegistry(): EmedfRegistry {
  const json = JSON.stringify({
    unknown: 0,
    main_classes: [
      {
        name: 'Condition - System',
        index: 0,
        instrs: [
          {
            name: 'IF Condition Group',
            index: 0,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Desired Condition Group State', type: 0 },
              { name: 'Target Condition Group', type: 3 }
            ]
          }
        ]
      },
      {
        name: 'Control Flow - System',
        index: 1000,
        instrs: [
          {
            name: 'WAIT For Condition Group State',
            index: 0,
            args: [
              { name: 'Desired Condition Group State', type: 0 },
              { name: 'Target Condition Group', type: 3 }
            ]
          }
        ]
      },
      {
        name: 'System',
        index: 2000,
        instrs: [
          {
            name: 'Initialize Event',
            index: 0,
            args: [
              { name: 'Event Slot ID', type: 5 },
              { name: 'Event ID', type: 2 },
              { name: 'Parameters', type: 2, vararg: true }
            ]
          }
        ]
      },
      {
        name: 'Condition - Character',
        index: 4,
        instrs: [
          {
            name: 'IF Player Has Item',
            index: 10,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Item Type', type: 2 },
              { name: 'Item ID', type: 2 }
            ]
          },
          {
            name: 'IF Character Has SpEffect',
            index: 11,
            args: [
              { name: 'Result Condition Group', type: 3 },
              { name: 'Character', type: 2 },
              { name: 'SpEffect ID', type: 2 }
            ]
          }
        ]
      }
    ],
    enums: [],
    darkscript: {}
  });
  const result = parseDs3EmedfJson(json);
  if (!result.ok) throw new Error(`synthetic registry import failed: ${result.message}`);
  return result.registry;
}

/** Encode an IfConditionGroup / WaitFor payload (3 args, 4 bytes, s8/u8/s8). */
function condGroupArgs(result: number, state: number, target: number): string {
  const buf = Buffer.alloc(4);
  buf.writeInt8(result, 0);
  buf.writeUInt8(state, 1);
  buf.writeInt8(target, 2);
  buf.writeUInt8(0, 3); // alignment padding
  return buf.toString('base64');
}

/** Encode a WAIT payload (2 args, 4 bytes, u8/s8). */
function waitArgs(state: number, target: number): string {
  const buf = Buffer.alloc(4);
  buf.writeUInt8(state, 0);
  buf.writeInt8(target, 1);
  return buf.toString('base64');
}

/** InitializeEvent payload: s32 slot + u32 eventId + one u32 parameter. */
function initEventArgs(slot: number, eventId: number, param: number): string {
  const buf = Buffer.alloc(12);
  buf.writeInt32LE(slot, 0);
  buf.writeUInt32LE(eventId, 4);
  buf.writeUInt32LE(param, 8);
  return buf.toString('base64');
}

/** Predicate payload: s8 result + u32 a + u32 b (4-byte aligned → 12 bytes). */
function predicateArgs(result: number, a: number, b: number): string {
  const buf = Buffer.alloc(12);
  buf.writeInt8(result, 0);
  buf.writeUInt32LE(a, 4);
  buf.writeUInt32LE(b, 8);
  return buf.toString('base64');
}

function main(): void {
  const registry = createSyntheticRegistry();

  const document = createEmevdEditorDocument({
    resourceUri: 'file://event/common.emevd',
    documentInstanceId: 'darkscript-smoke-document',
    events: [
      {
        eventId: 0,
        restBehavior: 0,
        instructions: [
          { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770001, 0), unknown: false },
          { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770002, 0), unknown: false }
        ]
      },
      {
        eventId: 965672,
        restBehavior: 1,
        instructions: [
          // Predicates sharing result group 1 (AND), terminating in an
          // IF Condition Group join whose result group is MAIN (0).
          { bank: 4, id: 10, argsBase64: predicateArgs(1, 6, 2498), unknown: false },
          { bank: 4, id: 11, argsBase64: predicateArgs(1, 10000, 127800), unknown: false },
          { bank: 4, id: 11, argsBase64: predicateArgs(1, 10000, 110140), unknown: false },
          { bank: 0, id: 0, argsBase64: condGroupArgs(0, 1, 1), unknown: false },
          // Ordinary instruction after the wait block.
          { bank: 2000, id: 0, argsBase64: initEventArgs(0, 77770003, 0), unknown: false },
          // Unknown instruction → comment.
          { bank: 9999, id: 7, argsBase64: '', unknown: true }
        ]
      },
      { eventId: 42, restBehavior: 2, instructions: [] }
    ]
  });

  const text = renderEmevdDarkScript(document, registry);

  // Event headers.
  if (!text.includes('$Event(0, Default, function() {')) throw new Error('event 0 header missing');
  if (!text.includes('$Event(965672, Restart, function() {')) throw new Error('event 965672 header missing');
  if (!text.includes('$Event(42, 2 /* unknown restBehavior */, function() {')) {
    throw new Error('unknown restBehavior must be rendered verbatim with a comment');
  }

  // Instruction names come from EMEDF, PascalCased.
  if (!text.includes('InitializeEvent(0, 77770001, 0);')) throw new Error('InitializeEvent call missing');
  if (!text.includes('InitializeEvent(0, 77770002, 0);')) throw new Error('second InitializeEvent call missing');

  // Condition folding → WaitFor(A && B && C), 8-space inner indent, hidden group args.
  if (!/WaitFor\(\n        IfPlayerHasItem\(6, 2498\)\n        && IfCharacterHasSpEffect\(10000, 127800\)\n        && IfCharacterHasSpEffect\(10000, 110140\)\);/.test(text)) {
    throw new Error(`WaitFor && fold mismatch:\n${text}`);
  }

  // Unknown instruction → honest comment.
  if (!text.includes('// unknown bank=9999 id=7')) throw new Error('unknown comment missing');

  // Empty event body → `$Event(id, ...) { ... });` on its own, nothing inside.
  if (!text.includes('$Event(42, 2 /* unknown restBehavior */, function() {\n});')) {
    throw new Error('empty event body must render as header + });');
  }

  // No hash-DSL leakage: the forbidden shape must never appear.
  if (text.includes('instruction @') || text.includes('set arg')) {
    throw new Error('hash DSL leaked into DarkScript output');
  }

  // Decode failure → `// <code> bank=... id=...` comment.
  const badDecode = createEmevdEditorDocument({
    resourceUri: 'file://event/bad.emevd',
    events: [
      {
        eventId: 7,
        restBehavior: 0,
        instructions: [
          // 0:0 IfConditionGroup expects 4 bytes; give it a wrong-length payload.
          { bank: 0, id: 0, argsBase64: Buffer.from([1, 2, 3, 4, 5]).toString('base64'), unknown: false }
        ]
      }
    ]
  });
  const badText = renderEmevdDarkScript(badDecode, registry);
  if (!badText.includes('// EMEDF_ARGS_LENGTH_MISMATCH bank=0 id=0')) {
    throw new Error(`decode failure must render as comment:\n${badText}`);
  }

  // Truncation must end at an event-block boundary, not mid-block.
  const bounded = renderEmevdDarkScriptBounded(document, registry, 8);
  if (!bounded.truncated) throw new Error('bounded render must truncate under the cap');
  if (!bounded.text.includes('$Event(0, Default, function() {\n    InitializeEvent(0, 77770001, 0);\n    InitializeEvent(0, 77770002, 0);\n});')) {
    throw new Error('truncation must keep whole event blocks intact:\n' + bounded.text);
  }
  if (bounded.text.includes('$Event(965672')) {
    throw new Error('truncated text must not include a partially-rendered later event');
  }
  if (!bounded.text.includes('// DARKSCRIPT_TRUNCATED')) {
    throw new Error('truncation marker comment missing');
  }

  const unbounded = renderEmevdDarkScriptBounded(document, registry, 1_000_000);
  if (unbounded.truncated || unbounded.totalLines !== unbounded.shownLines) {
    throw new Error('unbounded-cap render must not truncate');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'DarkScript3 源码渲染器验证通过',
    eventHeaders: ['Default', 'Restart', 'unknown'],
    conditionFold: 'WaitFor(A && B && C)',
    unknownComment: true,
    decodeFailureComment: true,
    truncationAtEventBoundary: true,
    totalLines: unbounded.totalLines
  }, null, 2));
}

main();
