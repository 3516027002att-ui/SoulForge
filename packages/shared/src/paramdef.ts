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
  /**
   * 跨表引用：这个字段的整数值是哪些 param 的行 id。
   *
   * 语法与语义见 core 的 `paramFieldReference.ts`（两种实测形态：无条件
   * `Target`、条件 `Target(siblingField=value)`）。这里存原始字符串而不是解析后的
   * 结构：`ParamDefDocument` 参与包摘要与信任判定，字段集越简单越不容易在
   * 摘要口径上出现歧义；解析是纯函数，随时可算。
   *
   * 目标名是**容器条目名**（如 `SpEffectParam`），不是 ParamType。
   */
  refs?: string;
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
  /** Native PARAM data version. Package matching treats this as dataVersion. */
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

/** Lowercase SHA-256 digest with an explicit algorithm prefix. */
export type ParamMetadataDigest = `sha256:${string}`;

export interface ParamMetadataDefinitionKey {
  game: string;
  gameBuild: string;
  typeName: string;
  dataVersion: number;
  rowDataSize: number;
}

export interface ParamMetadataSource {
  /** Describes compatibility only; it does not grant authority or redistribution rights. */
  kind: 'paramdex-compatible' | 'user-supplied' | 'synthetic-fixture';
  /** Stable repository URL or user-controlled source identifier. */
  identity: string;
  /** Immutable `git:<commit>` or `sha256:<digest>` revision. */
  revision: string;
  /** Digest of the exact external source payload used to build this package. */
  contentDigest: ParamMetadataDigest;
}

export interface ParamMetadataLicense {
  spdxExpression: string;
  /** Digest of the exact license text reviewed by the user. */
  textDigest: ParamMetadataDigest;
  redistribution: 'external-only' | 'permitted';
}

export interface ParamMetadataDefinition {
  key: ParamMetadataDefinitionKey;
  definitionDigest: ParamMetadataDigest;
  document: ParamDefDocument;
}

export interface ParamMetadataPackage {
  schemaVersion: 1;
  packageId: string;
  packageVersion: string;
  packageDigest: ParamMetadataDigest;
  source: ParamMetadataSource;
  license: ParamMetadataLicense;
  definitions: ParamMetadataDefinition[];
}

/**
 * User-owned allowlist. Trust is exact and content-addressed; package metadata
 * alone never makes an external source trusted.
 */
export interface ParamMetadataTrustPolicy {
  schemaVersion: 1;
  policyId: string;
  trustedPackages: Array<{
    packageId: string;
    packageVersion: string;
    packageDigest: ParamMetadataDigest;
    sourceIdentity: string;
    sourceRevision: string;
    sourceContentDigest: ParamMetadataDigest;
    licenseSpdxExpression: string;
    licenseTextDigest: ParamMetadataDigest;
  }>;
}

export type ParamMetadataOverlayOperation =
  | { kind: 'set-definition-notes'; value: string }
  | { kind: 'set-field-display-name'; fieldId: string; value: string }
  | { kind: 'set-field-description'; fieldId: string; value: string }
  | { kind: 'set-enum-display-name'; enumId: string; value: string }
  | { kind: 'set-enum-value-label'; enumId: string; valueId: number; label: string };

/** User overlay operations may change display metadata only. */
export interface ParamMetadataOverlay {
  schemaVersion: 1;
  overlayId: string;
  overlayVersion: string;
  origin: 'user';
  basePackageDigest: ParamMetadataDigest;
  target: ParamMetadataDefinitionKey;
  expectedBaseDefinitionDigest: ParamMetadataDigest;
  operations: ParamMetadataOverlayOperation[];
}
