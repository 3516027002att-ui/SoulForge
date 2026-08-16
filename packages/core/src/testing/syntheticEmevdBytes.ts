/**
 * Minimal synthetic Sekiro EMEVD binary builder for smoke fixtures.
 *
 * Layout mirrors bridge/SoulForge.Bridge/EmevdNativeDocument.cs:
 * - header 0x90 (EVD\0 + 00 FF 01 FF + version 0xCD + i64 varints)
 * - event table 0x30/entry, instruction table 0x20/entry
 * - args bank: 4-byte aligned blobs, then 0x10-padded
 * - parameters/linked/strings empty
 *
 * Explicitly synthetic and tiny; never a game asset and never claims
 * native corpus authority.
 */

import { createHash } from 'node:crypto';
import { parseDs3EmedfJson } from '../emevd/emedfExternalAdapter.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';

export interface SyntheticEmevdInstructionSpec {
  bank: number;
  id: number;
  args: Buffer;
}

export interface SyntheticEmevdEventSpec {
  id: number;
  restBehavior: number;
  instructions: SyntheticEmevdInstructionSpec[];
}

const HEADER_SIZE = 0x90;
const EVENT_SIZE = 0x30;
const INSTRUCTION_SIZE = 0x20;

export function buildSyntheticEmevd(events: SyntheticEmevdEventSpec[]): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('EVD\0', 0, 'ascii');
  header.writeUInt8(0x00, 4);
  header.writeUInt8(0xff, 5);
  header.writeUInt8(0x01, 6);
  header.writeUInt8(0xff, 7);
  header.writeUInt32LE(0xcd, 0x08);

  const totalInstructions = events.reduce((sum, event) => sum + event.instructions.length, 0);
  const instructionsOffset = HEADER_SIZE + events.length * EVENT_SIZE;
  const argsBankOffset = instructionsOffset + totalInstructions * INSTRUCTION_SIZE;

  // Instruction table with args-offset placeholders.
  const instructionTable = Buffer.alloc(totalInstructions * INSTRUCTION_SIZE);
  const argBlobs: Buffer[] = [];
  const argOffsets: number[] = [];
  let argsCursor = 0;
  let instructionIndex = 0;
  for (const event of events) {
    for (const instr of event.instructions) {
      const o = instructionIndex * INSTRUCTION_SIZE;
      instructionTable.writeInt32LE(instr.bank, o);
      instructionTable.writeInt32LE(instr.id, o + 4);
      instructionTable.writeBigInt64LE(BigInt(instr.args.length), o + 8);
      if (instr.args.length === 0) {
        argOffsets.push(-1);
      } else {
        argOffsets.push(argsCursor);
        argBlobs.push(instr.args);
        argsCursor += instr.args.length + ((4 - (instr.args.length % 4)) % 4);
      }
      instructionIndex++;
    }
  }
  for (let i = 0; i < totalInstructions; i++) {
    instructionTable.writeBigInt64LE(BigInt(argOffsets[i] ?? -1), i * INSTRUCTION_SIZE + 16);
  }

  // Args bank: blobs + 4-byte padding, then 0x10 padding.
  const argsBank = Buffer.alloc(argsCursor + ((0x10 - (argsCursor % 0x10)) % 0x10));
  let argsPos = 0;
  for (const blob of argBlobs) {
    blob.copy(argsBank, argsPos);
    argsPos += blob.length + ((4 - (blob.length % 4)) % 4);
  }
  const argumentsLength = argsBank.length;

  // Event table.
  const eventTable = Buffer.alloc(events.length * EVENT_SIZE);
  let instrCursor = 0;
  events.forEach((event, eventIndex) => {
    const o = eventIndex * EVENT_SIZE;
    eventTable.writeBigInt64LE(BigInt(event.id), o);
    eventTable.writeBigInt64LE(BigInt(event.instructions.length), o + 8);
    eventTable.writeBigInt64LE(
      event.instructions.length > 0 ? BigInt(instrCursor * INSTRUCTION_SIZE) : -1n,
      o + 16
    );
    eventTable.writeBigInt64LE(0n, o + 24); // parameterCount
    eventTable.writeBigInt64LE(-1n, o + 32); // parametersOffset
    eventTable.writeUInt32LE(event.restBehavior, o + 40);
    eventTable.writeUInt32LE(0, o + 44); // pad
    instrCursor += event.instructions.length;
  });

  const parametersOffset = argsBankOffset + argumentsLength;
  const linkedFilesOffset = parametersOffset;
  const stringsOffset = linkedFilesOffset;
  const fileSize = stringsOffset;

  header.writeUInt32LE(fileSize, 0x0c);
  header.writeBigInt64LE(BigInt(events.length), 0x10);
  header.writeBigInt64LE(BigInt(HEADER_SIZE), 0x18);
  header.writeBigInt64LE(BigInt(totalInstructions), 0x20);
  header.writeBigInt64LE(BigInt(instructionsOffset), 0x28);
  header.writeBigInt64LE(0n, 0x30); // unk count
  header.writeBigInt64LE(BigInt(argsBankOffset), 0x38); // unk offset
  header.writeBigInt64LE(0n, 0x40); // layer count
  header.writeBigInt64LE(BigInt(argsBankOffset), 0x48); // layers offset
  header.writeBigInt64LE(0n, 0x50); // parameter count
  header.writeBigInt64LE(BigInt(parametersOffset), 0x58);
  header.writeBigInt64LE(0n, 0x60); // linked count
  header.writeBigInt64LE(BigInt(linkedFilesOffset), 0x68);
  header.writeBigInt64LE(BigInt(argumentsLength), 0x70);
  header.writeBigInt64LE(BigInt(argsBankOffset), 0x78);
  header.writeBigInt64LE(0n, 0x80); // strings length
  header.writeBigInt64LE(BigInt(stringsOffset), 0x88);

  return Buffer.concat([header, eventTable, instructionTable, argsBank]);
}

/** Baseline args bank of instruction 0 (WaitFor fixture, conditionGroup = -1). */
function baselineWaitForArgs(): Buffer {
  // s8 conditionGroup=-1, u8 pad0, u16 pad1, u32 unknown
  return Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

/**
 * Standard two-event fixture spec, parameterized only by instruction 0's args.
 *
 * 只有这一处参数化：缓存身份回归要两份**字节长度完全相同**、只差一个 arg 字节的文件，
 * 用来模拟外部工具的等长改写。共用同一份 spec 才能保证长度相同这件事是构造出来的，
 * 而不是两份手抄常量恰好一样。
 */
function standardSyntheticEmevdSpec(waitForArgs: Buffer): SyntheticEmevdEventSpec[] {
  return [
    {
      id: 50,
      restBehavior: 0,
      instructions: [
        { bank: 1000, id: 0, args: waitForArgs },
        // bank 2000 id 0 (IfConditionGroup fixture): resultConditionGroup=1, desiredComparisonType=0,
        // targetConditionGroup=2, u8 pad0, u32 pad1, u32 pad2
        {
          bank: 2000,
          id: 0,
          args: Buffer.from([0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        },
        // unknown instruction: opaque, empty args, never re-encoded
        { bank: 9999, id: 1, args: Buffer.alloc(0) }
      ]
    },
    { id: 100, restBehavior: 0, instructions: [] }
  ];
}

/** Standard two-event smoke fixture used by EMEVD plan commit smokes. */
export function standardSyntheticEmevd(): Buffer {
  return buildSyntheticEmevd(standardSyntheticEmevdSpec(baselineWaitForArgs()));
}

/**
 * {@link standardSyntheticEmevd} 的等长变体：instruction 0 的 args 换成
 * {@link mutatedWaitForArgs}（-1 → -2），只差一个字节，文件长度不变。
 *
 * 缓存身份回归用它模拟外部工具「等长改写 + 回写原 mtime」：mtime 与 length 两个字段
 * 都不动，只有内容变了。旧的 (path, mtime, length) 键在这一形态下会命中旧内容。
 */
export function standardSyntheticEmevdEqualLengthVariant(): Buffer {
  return buildSyntheticEmevd(standardSyntheticEmevdSpec(mutatedWaitForArgs()));
}

/**
 * 大体积 synthetic EMEVD：并发行为回归专用。
 *
 * 「两个不同文件不得在全局锁上串行」要观测到两次解析的**时间窗口重叠**。
 * 368 字节的标准 fixture 解析加往返校验不到 1 ms，重叠靠碰运气；两份都放大到
 * 数万条指令，解析窗口才宽到必然重叠，判据也才能只看峰值计数、不看时钟。
 *
 * `salt` 只改 arg 字节，不改任何长度或表结构：两份文件因此内容不同（各自独立的
 * 缓存身份、必须各解析一次），但规模完全一致 —— 不会出现一份大一份小、
 * 小的那份先跑完导致窗口不重叠。
 */
export function largeSyntheticEmevd(options: {
  events: number;
  instructionsPerEvent: number;
  salt: number;
}): Buffer {
  const specs: SyntheticEmevdEventSpec[] = [];
  for (let event = 0; event < options.events; event += 1) {
    const instructions: SyntheticEmevdInstructionSpec[] = [];
    for (let index = 0; index < options.instructionsPerEvent; index += 1) {
      const args = Buffer.alloc(8);
      // s8 conditionGroup：留在 [-128,-1]，与 baseline 同族的合法取值。
      args.writeInt8(-1 - ((index + options.salt) % 100), 0);
      args.writeUInt32LE((event * 131 + index * 17 + options.salt) >>> 0, 4);
      instructions.push({ bank: 1000, id: 0, args });
    }
    specs.push({ id: 1000 + event, restBehavior: 0, instructions });
  }
  return buildSyntheticEmevd(specs);
}

/** Args bank of instruction 0 after the canonical plan-commit DSL patch (conditionGroup -1 → -2). */
export function mutatedWaitForArgs(): Buffer {
  return Buffer.from([0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

/** Args bank of instruction 1 after the canonical plan-commit DSL patch (resultConditionGroup=5, desiredComparisonType=1). */
export function mutatedIfCondArgs(): Buffer {
  return Buffer.from([0x05, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

/* ------------------------------------------------------------------ */
/*  Synthetic DarkScript3-format EMEDF JSON (imported-registry smoke)  */
/*                                                                     */
/*  DarkScript3 EMEDF data is All Rights Reserved and is never bundled  */
/*  or redistributed. This is a tiny, self-authored sample that only   */
/*  mimics the JSON container shape; the instruction layouts are our   */
/*  own and match the real Sekiro corpus by observed args length.      */
/* ------------------------------------------------------------------ */

/**
 * Minimal DarkScript3-format EMEDF JSON constructed by us for smoke tests.
 * Three instructions:
 *   - 0:0   IfConditionGroup   {s8, u8, s8}  → 4-byte payload
 *   - 2000:0 InitializeEvent    {s32, u32, u32 vararg} → 8-byte base + 4-byte stride
 *   - 2003:1 EndEvent           {}            → 0-byte payload
 * The claimed lengths match the real corpus distribution (0:0 → 4 bytes,
 * 2000:0 → 12/16/20/24/32 all valid vararg multiples), so the imported
 * registry can drive typed mutations against real documents.
 */
export function createSyntheticDs3EmedfJson(): string {
  return JSON.stringify({
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
        name: 'Entity',
        index: 2003,
        instrs: [
          { name: 'End Event', index: 1, args: [] }
        ]
      }
    ],
    enums: [],
    darkscript: {}
  });
}

/** Import the synthetic DarkScript3-format JSON through the external adapter. */
export function createSyntheticImportedEmedf(): EmedfRegistry {
  const result = parseDs3EmedfJson(createSyntheticDs3EmedfJson());
  if (!result.ok) throw new Error(`synthetic DS3 EMEDF import failed: ${result.message}`);
  return result.registry;
}

/** Expected args bank of the 0:0 instruction after the imported-registry DSL patch. */
export function mutatedIfCondArgsForImported(): Buffer {
  // desiredConditionGroupState 0 → 1
  return Buffer.from([0x01, 0x01, 0x02, 0x00]);
}

/** Expected args bank of the 2000:0 instruction after the imported-registry DSL patch. */
export function mutatedInitEventArgsForImported(): Buffer {
  // eventId 100 → 200; vararg tail byte (0x07) preserved exactly
  return Buffer.from([0x0a, 0x00, 0x00, 0x00, 0xc8, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00]);
}

/** Synthetic EMEVD matching the imported synthetic DS3 schema (see above). */
export function importedRegistrySyntheticEmevd(): Buffer {
  return buildSyntheticEmevd([
    {
      id: 50,
      restBehavior: 0,
      instructions: [
        // 0:0 IfConditionGroup: resultConditionGroup=1, desiredConditionGroupState=0, targetConditionGroup=2
        { bank: 0, id: 0, args: Buffer.from([0x01, 0x00, 0x02, 0x00]) },
        // 2000:0 InitializeEvent (vararg): eventSlotId=10, eventId=100, parameters=[7]
        {
          bank: 2000,
          id: 0,
          args: Buffer.from([0x0a, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00])
        },
        // unknown instruction: opaque, empty args, never re-encoded
        { bank: 9999, id: 1, args: Buffer.alloc(0) }
      ]
    },
    { id: 100, restBehavior: 0, instructions: [] }
  ]);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
