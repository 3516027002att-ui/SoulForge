import type { ParamFieldRefTarget } from './param-field-reference.js';

export interface EventExport {
  mapId?: string;
  /** Revision actually used to decode this export; never infer from the file catalog. */
  sourceHash?: string;
  /** SHA-256 of the packed/outer source file read by Bridge. */
  outerFileHash?: string;
  sourceRevision?: number;
  events: EventSymbol[];
}

export interface EventSymbol {
  uri: string;
  sourceUri: string;
  mapId?: string;
  eventId: number;
  name?: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  instructions: EventInstruction[];
  raw?: unknown;
}

export interface EventInstruction {
  uri: string;
  index: number;
  name?: string;
  category?: string;
  /** Native instruction bank; together with id addresses the real op code. */
  bank?: number;
  /** Native instruction id as decoded by the EMEDF registry. */
  id?: number;
  /** Native byte range of this instruction inside the unpacked payload. */
  byteRange?: [number, number];
  args: EventArg[];
  raw?: unknown;
}

export interface EventArg {
  name?: string;
  value: string | number | boolean;
  /** Zero-based position in the native argument list. */
  argIndex?: number;
  role?: 'flag' | 'eventId' | 'entityId' | 'regionId' | 'paramId' | 'textId' | 'unknown';
  /** Where the role came from: trusted registry metadata vs. name inference. */
  roleSource?: 'registry' | 'inferred';
  paramName?: string;
  confidence?: 'high' | 'medium' | 'low';
}

export interface MapExport {
  mapId: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  readerSchemaRevision?: number;
  derivedKey?: string;
  entities: MapEntitySymbol[];
  regions: MapRegionSymbol[];
}

export interface MapEntitySymbol {
  uri: string;
  sourceUri: string;
  mapId: string;
  entityId?: number;
  internalEntryId?: number;
  name: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  kind: 'character' | 'object' | 'asset' | 'collision' | 'mapPiece' | 'unknown';
  model?: string;
  /** FLVER 在 mapbnd 里的模型序号（read-msb-document parts[].modelIndex）。 */
  modelIndex?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /** 区域号，如 `M11`（问题 6：区域 = M + 块 ID 第一段两位数字）。 */
  areaId?: string;
  raw?: unknown;
}

export interface MapRegionSymbol {
  uri: string;
  sourceUri: string;
  mapId: string;
  entityId?: number;
  internalEntryId?: number;
  name: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  shape?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  size?: unknown;
  raw?: unknown;
}

export interface ParamExport {
  paramName: string;
  /** Native container identity; typeName alone is not unique across entries. */
  sourceUri?: string;
  entryIndex?: number;
  entryName?: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  rows: ParamRowSymbol[];
}

export interface ParamRowSymbol {
  uri: string;
  sourceUri: string;
  paramName: string;
  /** Physical BND4 child name; typeName/paramName is not unique in a container. */
  entryName?: string;
  entryIndex?: number;
  rowId: number;
  /** Zero-based physical row position; rowId alone cannot address duplicate rows. */
  rowIndex?: number;
  /** SHA-256 of the physical row bytes; write precondition, never replaces outer version. */
  dataHash?: string;
  rowName?: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  fields?: ParamFieldSymbol[];
  raw?: unknown;
}

export interface ParamFieldSymbol {
  /** Native PARAM definition id used by read_param_fields/mutate_param_fields. */
  fieldId?: string;
  name: string;
  type?: string;
  /** Human-readable field note from the trusted PARAM metadata package. */
  description?: string;
  value: string | number | boolean | null;
  /** Parsed Smithbox `Refs=` targets; only published from trusted metadata. */
  refs?: ParamFieldRefTarget[];
  /** Unrecognized raw fragments dropped by the parser (diagnostics, never silence). */
  refsRejected?: string[];
  /** Where the refs data came from; display-name construction is never trusted. */
  refsProvenance?: 'trusted-metadata' | 'unknown';
}

export interface MsgExport {
  category?: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  entries: TextEntrySymbol[];
}

export interface TextEntrySymbol {
  uri: string;
  sourceUri: string;
  category?: string;
  /** Physical entry ordinal in the native FMG/container projection. */
  entryIndex?: number;
  /** Language identity when the native reader exposes it. */
  language?: string;
  textId: number;
  text: string;
  confidence?: 'high' | 'medium' | 'low';
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  raw?: unknown;
}

/**
 * 动作（TAE）投影（问题 6-C）。source 'action' 资源经 read-tae-document 信封
 * 投影而来，chrId 从文件路径提取（cXXXX）。词条 symbolUri 为
 * `action://<chr>/<AXXXX>/<eN>`。
 */
export interface TaeExport {
  chrId: string;
  sourceUri: string;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  /** ANIBND 内原生 TAE 子项目录；裸 .tae 时可缺省。 */
  taeEntryCount?: number;
  taeEntries?: Array<{
    entryIndex: number;
    entryId: number;
    entryName: string;
    taeGroup: string;
    animationCount: number;
    sourceSize: number;
    sourceHash: string;
  }>;
  animations: TaeAnimSymbol[];
}

export interface TaeAnimSymbol {
  animId: number;
  /**
   * Bridge 解析出的实际动作引用 ID；缺省表示当前 wire 未能安全解析。
   * 生产写入方必须只发送非负 safe integer，消费方不得把缺省值猜测为 animId。
   */
  motionAnimId?: number;
  /** 同一 sourceUri 内的 TAE 子项身份；animId 不能单独寻址。 */
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
  /** `formatAnimCode(animId)`，如 `A0200`。 */
  code: string;
  /** 合法 hkx 茎（如 `a000_020000`），检索别名，不是第二套主键。 */
  hkxName?: string;
  events: TaeEventSymbol[];
}

export interface TaeEventSymbol {
  /** `action://c1050/A0200/e0`。 */
  uri: string;
  /** 事件继承所属 TAE 子项身份，避免跨 section 的相同 animId 串线。 */
  taeEntryIndex?: number;
  taeEntryId?: number;
  taeEntryName?: string;
  taeGroup?: string;
  /** 该动画 events[] 下标。 */
  index: number;
  eventTypeId: number;
  typeName?: string;
  startTime: number;
  endTime: number;
  /** 对外帧 = Math.round(seconds * 30)。 */
  startFrame: number;
  endFrame: number;
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  /** 模板解码字段（name / value）；未解码时缺省。 */
  fields?: Array<{ name: string; value: string | number | boolean }>;
  /** 未解码参数体的有界 hex 预览（正文写 `undecoded hex=…`，不编造字段）。 */
  parameterBytesHex?: string;
}

/**
 * Script projection (执行指令 T02 step 5). Distinguishes what the container
 * actually holds: real source text, a decompiled view, only a directory entry,
 * or opaque bytecode. Never collapse these — a bytecode child has no original
 * text and must not be decoded as UTF-8 mojibake to fake one.
 */
export type ScriptContentKind = 'source' | 'decompiled-view' | 'catalog-only' | 'bytecode';

export interface ScriptCallOccurrence {
  /** Zero-based index into the parsed statement list (bounded static subset). */
  statementIndex: number;
  callee: string;
  /** Literal argument values that resolved statically; dynamic slots stay absent. */
  literalArgs?: Array<string | number | boolean>;
  /** True when an argument could not be resolved to a literal (no code evaluation). */
  hasDynamicArg?: boolean;
  /** Source span of the call expression within the script text. */
  span?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  /** Whether the callee resolves to a known API or is shadowed/unknown. */
  resolution?: 'api' | 'local' | 'unknown';
}

export interface ScriptSymbol {
  uri: string;
  sourceUri: string;
  /** Full child chain inside the container; catalog name alone is not identity. */
  childChain: string[];
  entryIndex?: number;
  entryName?: string;
  contentKind: ScriptContentKind;
  /** Decoded source text; absent for bytecode/catalog-only children. */
  sourceText?: string;
  /** Encoding/bytecode diagnostics when sourceText is unavailable. */
  encodingDiagnostics?: string[];
  calls?: ScriptCallOccurrence[];
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
}

export interface ScriptExport {
  sourceUri: string;
  /** Container format that produced this export (LUABND, BND4, plaintext file). */
  containerKind: 'luabnd' | 'bnd4' | 'plaintext';
  childChain?: string[];
  sourceHash?: string;
  outerFileHash?: string;
  sourceRevision?: number;
  /** Whether all directory pages were read; a partial listing is not complete coverage. */
  catalogComplete?: boolean;
  scripts: ScriptSymbol[];
}

export interface SymbolBundle {
  events?: EventExport[];
  maps?: MapExport[];
  params?: ParamExport[];
  msgs?: MsgExport[];
  tae?: TaeExport[];
  scripts?: ScriptExport[];
}
