export interface EventExport {
  mapId?: string;
  events: EventSymbol[];
}

export interface EventSymbol {
  uri: string;
  sourceUri: string;
  mapId?: string;
  eventId: number;
  name?: string;
  instructions: EventInstruction[];
  raw?: unknown;
}

export interface EventInstruction {
  uri: string;
  index: number;
  name?: string;
  category?: string;
  args: EventArg[];
  raw?: unknown;
}

export interface EventArg {
  name?: string;
  value: string | number | boolean;
  role?: 'flag' | 'eventId' | 'entityId' | 'regionId' | 'paramId' | 'textId' | 'unknown';
  paramName?: string;
  confidence?: 'high' | 'medium' | 'low';
}

export interface MapExport {
  mapId: string;
  entities: MapEntitySymbol[];
  regions: MapRegionSymbol[];
}

export interface MapEntitySymbol {
  uri: string;
  sourceUri: string;
  mapId: string;
  entityId?: number;
  name: string;
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
  name: string;
  shape?: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  size?: unknown;
  raw?: unknown;
}

export interface ParamExport {
  paramName: string;
  rows: ParamRowSymbol[];
}

export interface ParamRowSymbol {
  uri: string;
  sourceUri: string;
  paramName: string;
  rowId: number;
  rowName?: string;
  fields?: ParamFieldSymbol[];
  raw?: unknown;
}

export interface ParamFieldSymbol {
  name: string;
  type?: string;
  value: string | number | boolean | null;
}

export interface MsgExport {
  category?: string;
  entries: TextEntrySymbol[];
}

export interface TextEntrySymbol {
  uri: string;
  sourceUri: string;
  category?: string;
  textId: number;
  text: string;
  confidence?: 'high' | 'medium' | 'low';
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
  animations: TaeAnimSymbol[];
}

export interface TaeAnimSymbol {
  animId: number;
  /** `formatAnimCode(animId)`，如 `A0200`。 */
  code: string;
  /** 合法 hkx 茎（如 `a000_020000`），检索别名，不是第二套主键。 */
  hkxName?: string;
  events: TaeEventSymbol[];
}

export interface TaeEventSymbol {
  /** `action://c1050/A0200/e0`。 */
  uri: string;
  /** 该动画 events[] 下标。 */
  index: number;
  eventTypeId: number;
  typeName?: string;
  startTime: number;
  endTime: number;
  /** 对外帧 = Math.round(seconds * 30)。 */
  startFrame: number;
  endFrame: number;
  /** 模板解码字段（name / value）；未解码时缺省。 */
  fields?: Array<{ name: string; value: string | number | boolean }>;
  /** 未解码参数体的有界 hex 预览（正文写 `undecoded hex=…`，不编造字段）。 */
  parameterBytesHex?: string;
}

export interface SymbolBundle {
  events?: EventExport[];
  maps?: MapExport[];
  params?: ParamExport[];
  msgs?: MsgExport[];
  tae?: TaeExport[];
}
