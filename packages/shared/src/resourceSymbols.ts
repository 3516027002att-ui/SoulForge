import type { Diagnostic, ParseStatus, ResourceKind } from './types.js';

export interface BridgeResult<T = unknown> {
  sourceUri: string;
  sourcePath: string;
  game: string;
  resourceKind: ResourceKind;
  parseStatus: ParseStatus;
  diagnostics: Diagnostic[];
  data?: T;
}

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
  position?: [number, number, number];
  rotation?: [number, number, number];
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
}

export interface SymbolBundle {
  events?: EventExport[];
  maps?: MapExport[];
  params?: ParamExport[];
  msgs?: MsgExport[];
}
