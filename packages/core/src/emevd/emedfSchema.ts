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
  /** True when this arg repeats zero or more times (vararg tail). */
  vararg?: boolean;
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

export type EmedfArgsValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type EmedfRegistryValidationResult = EmedfArgsValidationResult;

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
  const matches = registry.instructions.filter((item) => item.bank === bank && item.id === id);
  return matches.length === 1 ? matches[0] : undefined;
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
  const registryValidation = validateEmedfRegistry(registry);
  if (!registryValidation.ok) return registryValidation;
  const def = findInstructionDef(registry, bank, id);
  if (!def) {
    return {
      ok: false,
      code: 'EMEDF_UNKNOWN_INSTRUCTION',
      message: `无 schema：bank=${bank} id=${id}`
    };
  }
  return decodeEmedfArgs(def, args);
}

export function decodeEmedfArgs(
  def: EmedfInstructionDef,
  args: Buffer
): DecodeResult {
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

/**
 * Collect decoded integer arg values that match a schema-driven predicate.
 * Unknown instructions (no def) return undefined so callers can skip silently.
 */
function collectEmedfIntegerReferences(
  registry: EmedfRegistry,
  bank: number,
  id: number,
  decodedArgs: DecodedArg[],
  matches: (name: string, description: string | undefined) => boolean
): number[] | undefined {
  const def = findInstructionDef(registry, bank, id);
  if (!def) return undefined;
  const argDefs = new Map(def.args.map((arg) => [arg.name, arg]));
  const references: number[] = [];
  for (const decoded of decodedArgs) {
    if (typeof decoded.value !== 'number' || !Number.isInteger(decoded.value)) continue;
    if (!matches(decoded.name, argDefs.get(decoded.name)?.description)) continue;
    references.push(decoded.value);
  }
  return references;
}

/**
 * Collect event ID references from decoded instruction args.
 *
 * An arg is treated as an event ID reference when its name contains "eventId"
 * (DarkScript3-style naming, e.g. GotoEvent.eventId) or its description
 * mentions "event", and its decoded value is an integer. Schema-driven: any
 * imported EMEDF instruction with such an arg is covered automatically without
 * hardcoding bank/id. Returns undefined when the instruction has no schema.
 */
export function extractEventIdReferences(
  registry: EmedfRegistry,
  bank: number,
  id: number,
  decodedArgs: DecodedArg[]
): number[] | undefined {
  return collectEmedfIntegerReferences(
    registry,
    bank,
    id,
    decodedArgs,
    (name, description) => /eventid/i.test(name) || /event/i.test(description ?? '')
  );
}

/**
 * Collect condition group references from decoded instruction args.
 *
 * An arg is treated as a condition group reference when its name contains
 * "conditionGroup" (e.g. conditionGroup, conditionGroupId,
 * resultConditionGroup, targetConditionGroup) or its description mentions
 * "condition group". Returns undefined when the instruction has no schema.
 */
export function extractConditionGroupReferences(
  registry: EmedfRegistry,
  bank: number,
  id: number,
  decodedArgs: DecodedArg[]
): number[] | undefined {
  return collectEmedfIntegerReferences(
    registry,
    bank,
    id,
    decodedArgs,
    (name, description) => /conditiongroup/i.test(name) || /condition group/i.test(description ?? '')
  );
}

/**
 * Collect condition group *result* references — the condition groups that an
 * instruction (e.g. IfConditionGroup's resultConditionGroup) defines for later
 * instructions to consume. These values form the "initialized" set in
 * control-flow validation. Returns undefined when the instruction has no schema.
 */
export function extractConditionGroupResults(
  registry: EmedfRegistry,
  bank: number,
  id: number,
  decodedArgs: DecodedArg[]
): number[] | undefined {
  return collectEmedfIntegerReferences(
    registry,
    bank,
    id,
    decodedArgs,
    (name) => /resultconditiongroup/i.test(name)
  );
}

export function encodeInstructionArgs(
  registry: EmedfRegistry,
  bank: number,
  id: number,
  values: Record<string, number | boolean>
): EncodeResult {
  const registryValidation = validateEmedfRegistry(registry);
  if (!registryValidation.ok) return registryValidation;
  const def = findInstructionDef(registry, bank, id);
  if (!def) {
    return {
      ok: false,
      code: 'EMEDF_UNKNOWN_INSTRUCTION',
      message: `无 schema：bank=${bank} id=${id}`
    };
  }
  return encodeEmedfArgs(def, values);
}

export function encodeEmedfArgs(
  def: EmedfInstructionDef,
  values: Record<string, number | boolean>
): EncodeResult {
  const validation = validateEmedfArgs(def, values);
  if (!validation.ok) return validation;
  try {
    const buf = Buffer.alloc(encodedSize(def.args));
    let offset = 0;
    for (const arg of def.args) {
      offset = align(offset, arg.type);
      offset = writeArg(buf, offset, arg.type, values[arg.name]!);
    }
    return { ok: true, args: buf };
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
  if (!decoded.args.some((arg) => arg.name === argName)) {
    return {
      ok: false,
      code: 'EMEDF_ARG_NOT_FOUND',
      message: `schema 中不存在参数 ${argName}`
    };
  }
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

export function validateEmedfArgs(
  def: EmedfInstructionDef,
  values: Record<string, number | boolean>
): EmedfArgsValidationResult {
  const expected = new Set(def.args.map((arg) => arg.name));
  for (const name of Object.keys(values)) {
    if (!expected.has(name)) {
      return {
        ok: false,
        code: 'EMEDF_EXTRA_ARG',
        message: `schema 中不存在参数 ${name}`
      };
    }
  }
  for (const arg of def.args) {
    if (!(arg.name in values)) {
      return {
        ok: false,
        code: 'EMEDF_MISSING_ARG',
        message: `缺少参数 ${arg.name}`
      };
    }
    const value = values[arg.name]!;
    if (arg.type === 'bool') {
      if (typeof value !== 'boolean') {
        return {
          ok: false,
          code: 'EMEDF_ARG_TYPE_MISMATCH',
          message: `参数 ${arg.name} 必须是 bool。`
        };
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        ok: false,
        code: 'EMEDF_ARG_TYPE_MISMATCH',
        message: `参数 ${arg.name} 必须是有限数值。`
      };
    }
    if (arg.type !== 'f32' && !Number.isInteger(value)) {
      return {
        ok: false,
        code: 'EMEDF_ARG_TYPE_MISMATCH',
        message: `参数 ${arg.name} 必须是整数。`
      };
    }
    const [min, max] = numericRange(arg.type);
    if (value < min || value > max) {
      return {
        ok: false,
        code: 'EMEDF_ARG_OUT_OF_RANGE',
        message: `参数 ${arg.name} 超出 ${arg.type} 范围。`
      };
    }
  }
  return { ok: true };
}

/** Schema-claimed encoded length (with alignment and trailing padding) for a definition.
 *  For vararg instructions this is the *minimum* length (zero vararg repetitions). */
export function encodedEmedfArgsLength(def: EmedfInstructionDef): number {
  return encodedSize(def.args);
}

/** True when the instruction has a trailing vararg parameter. */
export function hasVararg(def: EmedfInstructionDef): boolean {
  return def.args.length > 0 && def.args[def.args.length - 1]!.vararg === true;
}

/** Number of vararg repetitions that fit in `totalLength` bytes, or -1 if the length
 *  is invalid for this definition (too short or not a multiple of the vararg stride). */
export function varargCount(def: EmedfInstructionDef, totalLength: number): number {
  if (!hasVararg(def)) return totalLength === encodedSize(def.args) ? 0 : -1;
  const baseArgs = def.args.slice(0, -1);
  const varargType = def.args[def.args.length - 1]!.type;
  const baseSize = encodedSize(baseArgs);
  const stride = byteLengthOf(varargType);
  const remaining = totalLength - baseSize;
  if (remaining < 0 || remaining % stride !== 0) return -1;
  return remaining / stride;
}

export function validateEmedfRegistry(
  registry: EmedfRegistry
): EmedfRegistryValidationResult {
  if (!registry || registry.schemaVersion !== 1 || registry.game !== 'sekiro'
    || !['fixture', 'user-derived', 'imported'].includes(registry.origin)
    || !Array.isArray(registry.instructions)) {
    return {
      ok: false,
      code: 'EMEDF_REGISTRY_INVALID',
      message: 'EMEDF registry schemaVersion/game/instructions 无效。'
    };
  }
  const instructionKeys = new Set<string>();
  const validTypes = new Set<EmedfArgType>([
    'u8', 's8', 'u16', 's16', 'u32', 's32', 'f32', 'bool'
  ]);
  for (const instruction of registry.instructions) {
    if (!instruction || !Number.isSafeInteger(instruction.bank) || instruction.bank < 0
      || !Number.isSafeInteger(instruction.id) || instruction.id < 0
      || typeof instruction.name !== 'string' || !instruction.name.trim()
      || !Array.isArray(instruction.args)) {
      return {
        ok: false,
        code: 'EMEDF_INSTRUCTION_DEF_INVALID',
        message: 'EMEDF instruction definition 无效。'
      };
    }
    const key = `${instruction.bank}:${instruction.id}`;
    if (instructionKeys.has(key)) {
      return {
        ok: false,
        code: 'EMEDF_DUPLICATE_INSTRUCTION',
        message: `EMEDF instruction 重复：bank=${instruction.bank} id=${instruction.id}`
      };
    }
    instructionKeys.add(key);
    const argNames = new Set<string>();
    for (let argIndex = 0; argIndex < instruction.args.length; argIndex++) {
      const arg = instruction.args[argIndex]!;
      if (!arg || typeof arg.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.name)
        || !validTypes.has(arg.type)) {
        return {
          ok: false,
          code: 'EMEDF_ARG_DEF_INVALID',
          message: `EMEDF 参数定义无效：bank=${instruction.bank} id=${instruction.id}`
        };
      }
      if (argNames.has(arg.name)) {
        return {
          ok: false,
          code: 'EMEDF_DUPLICATE_ARG',
          message: `EMEDF 参数名重复：${arg.name}`
        };
      }
      argNames.add(arg.name);
      if (arg.vararg && argIndex !== instruction.args.length - 1) {
        return {
          ok: false,
          code: 'EMEDF_VARARG_NOT_LAST',
          message: `EMEDF vararg 参数必须是最后一个：${arg.name}`
        };
      }
    }
  }
  return { ok: true };
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

function encodedSize(args: EmedfArgDef[]): number {
  let offset = 0;
  for (const arg of args) {
    if (arg.vararg) continue;
    offset = align(offset, arg.type) + byteLengthOf(arg.type);
  }
  return Math.ceil(offset / 4) * 4;
}

function byteLengthOf(type: EmedfArgType): number {
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

function numericRange(type: Exclude<EmedfArgType, 'bool'>): [number, number] {
  switch (type) {
    case 'u8': return [0, 0xff];
    case 's8': return [-0x80, 0x7f];
    case 'u16': return [0, 0xffff];
    case 's16': return [-0x8000, 0x7fff];
    case 'u32': return [0, 0xffff_ffff];
    case 's32': return [-0x8000_0000, 0x7fff_ffff];
    case 'f32': return [-3.4028234663852886e38, 3.4028234663852886e38];
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
