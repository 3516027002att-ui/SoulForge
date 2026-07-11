/**
 * PARAM field structure definition (user-derived paramdef projection).
 * Official game profile packages are never rewritten; user defs are separate
 * signed packages (signing is a desktop concern).
 */

export type ParamFieldScalarType =
  | 'u8'
  | 's8'
  | 'u16'
  | 's16'
  | 'u32'
  | 's32'
  | 'f32'
  | 'f64'
  | 'bool'
  | 'fix'
  | 'bytes';

export interface ParamFieldDef {
  id: string;
  name: string;
  type: ParamFieldScalarType;
  /** Byte offset within the row data payload. */
  offset: number;
  /** Byte size; for fixed scalars must match type; for bytes/fix is capacity. */
  size: number;
  alignment?: number;
  defaultValue?: number | string | boolean;
  min?: number;
  max?: number;
  enumRef?: string;
  bitfield?: {
    bitOffset: number;
    bitWidth: number;
  };
  description?: string;
}

export interface ParamEnumDef {
  id: string;
  name: string;
  values: Array<{ value: number; label: string }>;
}

export interface ParamDefDocument {
  schemaVersion: 1;
  /** Matches PARAM type name (e.g. ACTION_GUIDE_PARAM_ST). */
  typeName: string;
  version: number;
  rowDataSize: number;
  fields: ParamFieldDef[];
  enums?: ParamEnumDef[];
  /** provenance: never claim official game package authority. */
  origin: 'user-derived' | 'fixture' | 'imported';
  notes?: string;
}

export interface ParamFieldValue {
  fieldId: string;
  name: string;
  type: ParamFieldScalarType;
  value: number | string | boolean | null;
  rawHex?: string;
  diagnostic?: string;
}
