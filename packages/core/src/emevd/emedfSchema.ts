/**
 * Minimal EMEDF-style instruction argument schema.
 * Not a full Sekiro EMEDF dump — fixture/user schemas bind bank+id → arg layout.
 * Unknown instructions stay opaque (argsBase64 only).
 */

export type EmedfArgType =
  | 'u8'
  | 's8'
  | 'u16'
  | 's16'
  | 'u32'
  | 's32'
  | 'f32'
  | 'bool';

export interface EmedfArgDef {
  name: string;
  type: EmedfArgType;
  /** Optional docs for UI. */
  description?: string;
}

export interface EmedfInstructionDef {
  bank: number;
  id: number;
  name: string;
  args: EmedfArgDef[];
}

export interface EmedfRegistry {
  schemaVersion: 1;
  game: 'sekiro';
  origin: 'fixture' | 'user-derived' | 'imported';
  instructions: EmedfInstructionDef[];
}

export interface DecodedArg {
  name: string;
  type: EmedfArgType;
  value: number | boolean;
}

export type DecodeResult =
  | { ok: true; def: EmedfInstructionDef; args: DecodedArg[] }
  | { ok: false; code: string; message: string };

export type EncodeResult =
  | { ok: true; args: Buffer }
  | { ok: false; code: string; message: string };

/** Small built-in fixture covering common bank 2000 / 1000 patterns for smoke. */
export function createSekiroFixtureEmedf(): EmedfRegistry {
  return {
    schemaVersion: 1,
    game: 'sekiro',
    origin: 'fixture',
    instructions: [
      {
        bank: 2000,
        id: 0,
        name: 'IfConditionGroup',
        args: [
          { name: 'resultConditionGroup', type: 's8' },
          { name: 'desiredComparisonType', type: 'u8' },
          { name: 'targetConditionGroup', type: 's8' },
          // pad to observed 12-byte payload in common.emevd samples
          { name: 'pad0', type: 'u8' },
          { name: 'pad1', type: 'u32' },
          { name: 'pad2', type: 'u32' }
        ]
      },
      {
        bank: 1000,
        id: 0,
        name: 'WaitFor',
        args: [
          { name: 'conditionGroup', type: 's8' },
          { name: 'pad0', type: 'u8' },
          { name: 'pad1', type: 'u16' },
          { name: 'unknown', type: 'u32' }
        ]
      },
      {
        bank: 2003,
        id: 1,
        name: 'EndEvent',
        args: []
      }
    ]
  };
}

export function findInstructionDef(
  registry: EmedfRegistry,
  bank: number,
  id: number
): EmedfInstructionDef | undefined {
  return registry.instructions.find((item) => item.bank === bank && item.id === id);
}

/**
 * Decode raw instruction args with EMEDF layout.
 * Alignment: u16/s16 pad to 2, u32/s32/f32 pad to 4 (SoulsFormats style).
 */
export function decodeInstructionArgs(
  registry: EmedfRegistry,
  bank: number,
  id: number,
  args: Buffer
): DecodeResult {
  const def = findInstructionDef(registry, bank, id);
  if (!def) {
    return {
      ok: false,
      code: 'EMEDF_UNKNOWN_INSTRUCTION',
      message: `无 schema：bank=${bank} id=${id}`
    };
  }
  try {
    let offset = 0;
    const decoded: DecodedArg[] = [];
    for (const arg of def.args) {
      offset = align(offset, arg.type);
      const value = readArg(args, offset, arg.type);
      decoded.push({ name: arg.name, type: arg.type, value: value.value });
      offset = value.nextOffset;
    }
    return { ok: true, def, args: decoded };
  } catch (error) {
    return {
      ok: false,
      code: 'EMEDF_DECODE_FAILED',
      message: error instanceof Error ? error.message : '解码失败'
    };
  }
}

export function encodeInstructionArgs(
  registry: EmedfRegistry,
  bank: number,
  id: number,
  values: Record<string, number | boolean>
): EncodeResult {
  const def = findInstructionDef(registry, bank, id);
  if (!def) {
    return {
      ok: false,
      code: 'EMEDF_UNKNOWN_INSTRUCTION',
      message: `无 schema：bank=${bank} id=${id}`
    };
  }
  try {
    // Worst-case size bound
    const buf = Buffer.alloc(256);
    let offset = 0;
    for (const arg of def.args) {
      offset = align(offset, arg.type);
      if (!(arg.name in values)) {
        return {
          ok: false,
          code: 'EMEDF_MISSING_ARG',
          message: `缺少参数 ${arg.name}`
        };
      }
      offset = writeArg(buf, offset, arg.type, values[arg.name]!);
    }
    // Pad to 4 like SoulsFormats PackArgs
    const padded = Math.ceil(offset / 4) * 4;
    return { ok: true, args: Buffer.from(buf.subarray(0, padded)) };
  } catch (error) {
    return {
      ok: false,
      code: 'EMEDF_ENCODE_FAILED',
      message: error instanceof Error ? error.message : '编码失败'
    };
  }
}

/**
 * Apply a single named arg mutation onto existing raw args, preserving length when possible.
 */
export function mutateInstructionArg(
  registry: EmedfRegistry,
  bank: number,
  id: number,
  args: Buffer,
  argName: string,
  value: number | boolean
): EncodeResult {
  const decoded = decodeInstructionArgs(registry, bank, id, args);
  if (!decoded.ok) return decoded;
  const map: Record<string, number | boolean> = {};
  for (const arg of decoded.args) map[arg.name] = arg.value;
  map[argName] = value;
  const encoded = encodeInstructionArgs(registry, bank, id, map);
  if (!encoded.ok) return encoded;
  if (encoded.args.length !== args.length) {
    return {
      ok: false,
      code: 'EMEDF_LENGTH_CHANGED',
      message: `编码后长度 ${encoded.args.length} ≠ 原 ${args.length}；等长替换才能走 Bridge 就地写。`
    };
  }
  return encoded;
}

function align(offset: number, type: EmedfArgType): number {
  const a = alignmentOf(type);
  return Math.ceil(offset / a) * a;
}

function alignmentOf(type: EmedfArgType): number {
  switch (type) {
    case 'u8':
    case 's8':
    case 'bool':
      return 1;
    case 'u16':
    case 's16':
      return 2;
    default:
      return 4;
  }
}

function readArg(
  buf: Buffer,
  offset: number,
  type: EmedfArgType
): { value: number | boolean; nextOffset: number } {
  switch (type) {
    case 'u8':
      return { value: buf.readUInt8(offset), nextOffset: offset + 1 };
    case 's8':
      return { value: buf.readInt8(offset), nextOffset: offset + 1 };
    case 'bool':
      return { value: buf.readUInt8(offset) !== 0, nextOffset: offset + 1 };
    case 'u16':
      return { value: buf.readUInt16LE(offset), nextOffset: offset + 2 };
    case 's16':
      return { value: buf.readInt16LE(offset), nextOffset: offset + 2 };
    case 'u32':
      return { value: buf.readUInt32LE(offset), nextOffset: offset + 4 };
    case 's32':
      return { value: buf.readInt32LE(offset), nextOffset: offset + 4 };
    case 'f32':
      return { value: buf.readFloatLE(offset), nextOffset: offset + 4 };
    default:
      throw new Error(`未知 arg 类型`);
  }
}

function writeArg(
  buf: Buffer,
  offset: number,
  type: EmedfArgType,
  value: number | boolean
): number {
  switch (type) {
    case 'u8':
      buf.writeUInt8(Number(value), offset);
      return offset + 1;
    case 's8':
      buf.writeInt8(Number(value), offset);
      return offset + 1;
    case 'bool':
      buf.writeUInt8(value ? 1 : 0, offset);
      return offset + 1;
    case 'u16':
      buf.writeUInt16LE(Number(value), offset);
      return offset + 2;
    case 's16':
      buf.writeInt16LE(Number(value), offset);
      return offset + 2;
    case 'u32':
      buf.writeUInt32LE(Number(value), offset);
      return offset + 4;
    case 's32':
      buf.writeInt32LE(Number(value), offset);
      return offset + 4;
    case 'f32':
      buf.writeFloatLE(Number(value), offset);
      return offset + 4;
    default:
      throw new Error(`未知 arg 类型`);
  }
}
