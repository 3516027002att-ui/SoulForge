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

/** Standard two-event smoke fixture used by EMEVD plan commit smokes. */
export function standardSyntheticEmevd(): Buffer {
  return buildSyntheticEmevd([
    {
      id: 50,
      restBehavior: 0,
      instructions: [
        // bank 1000 id 0 (WaitFor fixture): s8 conditionGroup=-1, u8 pad0, u16 pad1, u32 unknown
        { bank: 1000, id: 0, args: Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) },
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
  ]);
}

/** Args bank of instruction 0 after the canonical plan-commit DSL patch (conditionGroup -1 → -2). */
export function mutatedWaitForArgs(): Buffer {
  return Buffer.from([0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

/** Args bank of instruction 1 after the canonical plan-commit DSL patch (resultConditionGroup=5, desiredComparisonType=1). */
export function mutatedIfCondArgs(): Buffer {
  return Buffer.from([0x05, 0x01, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
