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

export interface EmedfEnumMember {
  value: number;
  name: string;
  label?: string;
}

export interface EmedfEnumDef {
  name: string;
  members: EmedfEnumMember[];
}

export interface EmedfArgDef {
  name: string;
  type: EmedfArgType;
  /** Optional docs for UI. */
  description?: string;
  /** True when this arg repeats zero or more times (vararg tail). */
  vararg?: boolean;
  /** Name of the associated enum (e.g. "Comparison Type" or "ComparisonType"). */
  enumName?: string;
  default?: number;
  min?: number;
  max?: number;
  increment?: number;
  formatString?: string;
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
  enums?: Record<string, EmedfEnumDef>;
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

/* ------------------------------------------------------------------ */
/*  Registry 索引（每个 registry 对象一次，之后 O(1)）                 */
/* ------------------------------------------------------------------ */

/**
 * 一个 registry 对象的派生索引：校验结论 + bank→id→def 查表。
 *
 * 为什么需要它：`decodeInstructionArgs` 原本每次调用都跑一遍
 * `validateEmedfRegistry`（O(指令数 × 参数数)，正则 + Set）再跑一遍
 * `instructions.filter`（O(指令数)）。反汇编 common.emevd 要解码 33266 条指令，
 * 实测这两项占反汇编总耗时 9.0 s 中的 ~9.5 s（双重解码各付一次），
 * 即整个「打开事件文件」的 83%。索引化后同样 33266 次解码实测 3.9 ms。
 *
 * 缓存键是 registry 对象本身（WeakMap，registry 不可达即回收）。语义前提：
 * registry 交给本模块后不再原地改写 —— 仓库内所有构造点（emedfExternalAdapter
 * 的 parse、createSekiroFixtureEmedf、以及 smoke 里的 duplicate 负例）都是
 * 新建对象，没有 push/splice 改已交出的 registry。若将来出现原地改写，
 * 索引会滞后，必须改成新建 registry 对象。
 */
interface EmedfRegistryIndex {
  validation: EmedfRegistryValidationResult;
  /** bank → id → def；仅当 validation.ok 时填充（校验保证 bank:id 唯一）。 */
  byBankId: Map<number, Map<number, EmedfInstructionDef>>;
}

const registryIndexCache = new WeakMap<EmedfRegistry, EmedfRegistryIndex>();

function buildRegistryIndex(registry: EmedfRegistry): EmedfRegistryIndex {
  const validation = validateEmedfRegistryUncached(registry);
  const byBankId = new Map<number, Map<number, EmedfInstructionDef>>();
  if (validation.ok) {
    // 校验已保证 bank:id 不重复，所以这里直接建表即可保持
    // findInstructionDef 的「恰好一条匹配才返回」语义。
    for (const instruction of registry.instructions) {
      let byId = byBankId.get(instruction.bank);
      if (!byId) {
        byId = new Map<number, EmedfInstructionDef>();
        byBankId.set(instruction.bank, byId);
      }
      byId.set(instruction.id, instruction);
    }
  }
  return { validation, byBankId };
}

/** 取（或建）registry 索引。非对象 registry 不进 WeakMap，退化为每次重建。 */
function registryIndexOf(registry: EmedfRegistry): EmedfRegistryIndex {
  if (!registry || typeof registry !== 'object') return buildRegistryIndex(registry);
  const cached = registryIndexCache.get(registry);
  if (cached) return cached;
  const built = buildRegistryIndex(registry);
  registryIndexCache.set(registry, built);
  return built;
}

export function findInstructionDef(
  registry: EmedfRegistry,
  bank: number,
  id: number
): EmedfInstructionDef | undefined {
  const index = registryIndexOf(registry);
  // registry 非法（含 bank:id 重复）时索引为空表，与原实现「重复即 undefined」
  // 一致：调用方会拿到 EMEDF_UNKNOWN_INSTRUCTION 或上游的校验错误码。
  return index.byBankId.get(bank)?.get(id);
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
  // 校验与查表都走 registryIndexOf 的缓存：热路径（反汇编 33266 条指令）里
  // 这两项原本各自 O(registry)，现在是一次 WeakMap 命中 + 两次 Map.get。
  const index = registryIndexOf(registry);
  if (!index.validation.ok) return index.validation;
  const def = index.byBankId.get(bank)?.get(id);
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
  // Length-signature gate: a payload whose byte length does not match the
  // schema-claimed layout must stay opaque. Same bank:id multi-length variants
  // (e.g. real corpus 2000:0 observed at 12/16/20/24/32) are distinguished by
  // length signature and never conflated: decode fails structurally instead of
  // fabricating arg values from a prefix. Mutation paths inherit this gate via
  // mutateInstructionArg, so a mismatched-length payload can never be re-encoded.
  if (hasVararg(def)) {
    if (varargCount(def, args.length) < 0) {
      return {
        ok: false,
        code: 'EMEDF_ARGS_LENGTH_MISMATCH',
        message: `${def.name} (${def.bank}:${def.id}) args 长度 ${args.length} 不是合法 vararg 长度（base=${encodedSize(def.args)}，stride=${byteLengthOf(def.args[def.args.length - 1]!.type)}）。`
      };
    }
  } else if (args.length !== encodedSize(def.args)) {
    return {
      ok: false,
      code: 'EMEDF_ARGS_LENGTH_MISMATCH',
      message: `${def.name} (${def.bank}:${def.id}) args 长度 ${args.length} ≠ schema 声明长度 ${encodedSize(def.args)}；同 bank:id 多长度变体按长度签名区分，不混同解码。`
    };
  }
  try {
    let offset = 0;
    const decoded: DecodedArg[] = [];
    for (const arg of def.args) {
      offset = align(offset, arg.type);
      if (arg.vararg) {
        // Only materialize a vararg element when the payload actually contains
        // one. The value is display-only: encode always preserves the original
        // tail bytes (see mutateInstructionArg), so nothing is fabricated here.
        const count = varargCount(def, args.length);
        decoded.push({
          name: arg.name,
          type: arg.type,
          value: count > 0 ? readArg(args, offset, arg.type).value : 0
        });
        continue;
      }
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
  const index = registryIndexOf(registry);
  if (!index.validation.ok) return index.validation;
  const def = index.byBankId.get(bank)?.get(id);
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
      if (arg.vararg) continue; // vararg tail is preserved separately, never re-encoded here
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
 *
 * Vararg instructions: only fixed (non-vararg) arguments can be mutated. The
 * original vararg tail bytes are preserved exactly (opaque-tail policy) and the
 * combined payload must stay equal-length, so Bridge in-place writes stay valid.
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
  const def = findInstructionDef(registry, bank, id);
  if (!def) {
    return {
      ok: false,
      code: 'EMEDF_UNKNOWN_INSTRUCTION',
      message: `无 schema：bank=${bank} id=${id}`
    };
  }
  if (hasVararg(def) && def.args[def.args.length - 1]!.name === argName) {
    return {
      ok: false,
      code: 'EMEDF_VARARG_TAIL_READONLY',
      message: `vararg 尾部参数 ${argName} 的数量由观察长度决定，不支持按名称改写；固定参数可写，尾部原样保留。`
    };
  }
  const map: Record<string, number | boolean> = {};
  for (const arg of decoded.args) map[arg.name] = arg.value;
  map[argName] = value;
  if (hasVararg(def)) {
    // Preserve the original vararg tail byte-for-byte, then append it to the
    // re-encoded fixed prefix. Total length must equal the original payload.
    const baseSize = encodedSize(def.args);
    const tail = args.subarray(baseSize);
    const encoded = encodeInstructionArgs(registry, bank, id, map);
    if (!encoded.ok) return encoded;
    const combined = Buffer.concat([encoded.args, tail]);
    if (combined.length !== args.length) {
      return {
        ok: false,
        code: 'EMEDF_LENGTH_CHANGED',
        message: `编码后长度 ${combined.length} ≠ 原 ${args.length}；等长替换才能走 Bridge 就地写。`
      };
    }
    return { ok: true, args: combined };
  }
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

/**
 * 校验 registry。结果按 registry 对象缓存（见 EmedfRegistryIndex 的语义前提）：
 * 同一个 registry 对象反复校验只付一次全量遍历成本。判据本身在
 * `validateEmedfRegistryUncached` 里，缓存不改变任何结论。
 */
export function validateEmedfRegistry(
  registry: EmedfRegistry
): EmedfRegistryValidationResult {
  return registryIndexOf(registry).validation;
}

function validateEmedfRegistryUncached(
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
