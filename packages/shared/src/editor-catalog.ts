/**
 * EditorCatalog 语义目录契约（front-end.md §4.2 / §4.4）与
 * DocumentStore mutation IPC 闭合契约（§14.4，shared 可见部分）。
 *
 * 本文件是 shared 侧唯一权威：
 * - §4.2 的全部 closed union 与 fixed registry 形状；
 * - §14.4 中 renderer 可消费的 mutation/请求/响应 DTO；
 * - 所有 DTO 的 runtime decoder。decoder 拒绝绝对路径与 unknown extra
 *   fields；renderer 不得用 `as` 强转绕过 decoder。
 *
 * 命名说明：§14.4 的 `EditorMutation` 与 editor-protocol.ts 中 legacy
 * `EditorMutation`（patchIR 计划，仍被 core/editorDocumentStore.ts 引用，
 * 且该文件不在 SCHEMA-02 Allowed 内）重名，因此新契约整体放在本文件，
 * 名字与字段保持 §14.4 逐字不变。
 */

// ---------------------------------------------------------------------------
// §3.2 一级领域
// ---------------------------------------------------------------------------

export type EditorDomainId =
  | 'project'
  | 'param'
  | 'gparam'
  | 'text'
  | 'event'
  | 'map'
  | 'script'
  | 'behavior'
  | 'animation'
  | 'model'
  | 'texture'
  | 'material'
  | 'vfx'
  | 'container'
  | 'files';

export const EDITOR_DOMAIN_IDS = [
  'project',
  'param',
  'gparam',
  'text',
  'event',
  'map',
  'script',
  'behavior',
  'animation',
  'model',
  'texture',
  'material',
  'vfx',
  'container',
  'files'
] as const satisfies readonly EditorDomainId[];

// ---------------------------------------------------------------------------
// §4.2 基础 closed unions
// ---------------------------------------------------------------------------

export type ArtifactRole =
  | 'primary'
  | 'base'
  | 'backup'
  | 'previous'
  | 'recovery'
  | 'projection'
  | 'cache'
  | 'audit'
  | 'temporary';

export type NativeFormatId =
  | 'dcx-dflt'
  | 'dcx-krak'
  | 'bnd4'
  | 'param'
  | 'gparam'
  | 'fmg'
  | 'emevd'
  | 'msb'
  | 'lua-source'
  | 'lua-bytecode'
  | 'hks-bytecode'
  | 'esd'
  | 'tae'
  | 'flver'
  | 'tpf'
  | 'dds'
  | 'mtd'
  | 'matbin'
  | 'fxr'
  | 'unknown';

export type ContainerRole =
  | 'none'
  | 'gameparam-binder'
  | 'drawparam-binder'
  | 'msg-binder'
  | 'script-binder'
  | 'behavior-binder'
  | 'animation-binder'
  | 'texture-binder'
  | 'vfx-binder'
  | 'generic-binder';

export interface FormatCandidate {
  readonly formatId: NativeFormatId;
  readonly source: 'content-probe' | 'compound-suffix' | 'path-hint';
  readonly ruleId: string;
}

export interface FormatLayer {
  readonly layerIndex: number;
  readonly formatId: Exclude<NativeFormatId, 'unknown'>;
  readonly confirmedBy: 'bridge';
  readonly childStableId: string | null;
}

export interface ConfirmedFormatStack {
  readonly stackId: string;
  readonly layers: readonly FormatLayer[];
  readonly leafFormatId: Exclude<NativeFormatId, 'unknown'>;
  readonly containerRole: ContainerRole;
}

interface PhysicalVariantCommon {
  readonly variantId: string;
  readonly precedence: number;
  readonly contentHash: string | null;
  readonly sourceRevision: string | null;
  readonly provenanceDigest: string | null;
}

export type PhysicalVariantRef =
  | (PhysicalVariantCommon & {
      readonly role: 'primary' | 'base';
      readonly sourceLayer: 'overlay' | 'base';
      readonly recoveryOfResourceId: null;
    })
  | (PhysicalVariantCommon & {
      readonly role: 'backup' | 'previous' | 'recovery';
      readonly sourceLayer: 'history';
      readonly recoveryOfResourceId: string;
    });

export type RecognitionState =
  | { kind: 'candidate'; evidence: readonly FormatCandidate[] }
  | { kind: 'confirmed'; stack: ConfirmedFormatStack }
  | { kind: 'conflict'; confirmedStackIds: readonly string[] }
  | { kind: 'unsupported'; reasonCode: string };

export interface ProjectionRef {
  readonly projectionId: string;
  readonly projectionKind: 'source' | 'text' | 'json';
  readonly nativeResourceId: string;
  readonly nativeSourceRevision: string;
  readonly nativeSourceHash: string;
  readonly provenanceDigest: string;
}

// ---------------------------------------------------------------------------
// §4.2 能力 DTO
// ---------------------------------------------------------------------------

export type ReadOperationId =
  | 'catalog-open' | 'page-tables' | 'page-rows' | 'page-fields'
  | 'page-banks' | 'page-groups' | 'page-entries' | 'read-source'
  | 'read-outline' | 'read-preview' | 'read-metadata' | 'read-properties';

export type WriteOperationId =
  | 'param-field-set' | 'param-row-upsert' | 'param-row-delete'
  | 'gparam-field-set' | 'fmg-entry-upsert' | 'fmg-entry-delete'
  | 'emevd-source-change' | 'bnd4-child-replace' | 'script-plaintext-change'
  | 'map-entity-upsert' | 'map-entity-delete' | 'flver-material-slot-set'
  | 'tpf-texture-replace' | 'material-property-set' | 'vfx-field-set'
  | 'behavior-transition-upsert' | 'tae-event-upsert';

export type CapabilityReasonCode =
  | 'read-contract-missing' | 'write-contract-missing' | 'operation-not-allowed'
  | 'runtime-unavailable' | 'oodle-unavailable' | 'metadata-mismatch'
  | 'bridge-authority-insufficient' | 'writer-unverified'
  | 'outer-rebuild-unavailable' | 'native-reread-unavailable'
  | 'unknown-region-unverifiable' | 'sibling-verification-unavailable';

export type ReadCapabilityStage = 'D3' | 'D4' | 'D5' | 'D6';
export type WriteCapabilityStage = 'D7' | 'D8' | 'D9' | 'D10';

export type ReadCapability =
  | { kind: 'ready'; operationIds: readonly ReadOperationId[]; verifiedStages: readonly ['D3', 'D4', 'D5', 'D6']; resolverSnapshotId: string }
  | { kind: 'blocked'; reasonCode: CapabilityReasonCode; missing: readonly ReadCapabilityStage[] }
  | { kind: 'unavailable'; reasonCode: CapabilityReasonCode };

export type WriteCapability =
  | { kind: 'ready'; operationIds: readonly WriteOperationId[]; verifiedStages: readonly ['D7', 'D8', 'D9', 'D10']; resolverSnapshotId: string }
  | { kind: 'blocked'; reasonCode: CapabilityReasonCode; missingStages: readonly WriteCapabilityStage[] }
  | { kind: 'unavailable'; reasonCode: CapabilityReasonCode };

export interface OperationCapability {
  readonly read: ReadCapability;
  readonly write: WriteCapability;
}

// ---------------------------------------------------------------------------
// §4.2 catalog 结构
// ---------------------------------------------------------------------------

export type CatalogDecision =
  | { kind: 'catalog'; domain: EditorDomainId; integrationId: string }
  | { kind: 'history'; recoveryOfResourceId: string | null }
  | { kind: 'projection'; requireMatchingProvenance: true }
  | { kind: 'hidden'; reason: 'cache' | 'audit' | 'temporary' }
  | { kind: 'files'; reasonCode: string };

export interface LogicalDocumentRef {
  readonly resourceId: string;
  readonly domain: EditorDomainId;
  readonly libraryId: string;
  readonly bankId: string | null;
  readonly documentId: string;
  readonly sourceVariant: 'overlay' | 'base';
}

export interface CatalogLibrary {
  readonly libraryId: string;
  readonly domain: EditorDomainId;
  readonly label: string;
  readonly bankIds: readonly string[];
  readonly documentIds: readonly string[];
  readonly counts: Readonly<Partial<Record<'libraries' | 'banks' | 'tables' | 'rows' | 'entries' | 'events' | 'files', number>>>;
}

export interface CatalogBank {
  readonly bankId: string;
  readonly libraryId: string;
  readonly label: string;
  readonly semanticKey: string;
  readonly languageId: string | null;
  readonly containerKind: 'item' | 'menu' | null;
  readonly documentIds: readonly string[];
}

export interface CatalogDocument {
  readonly ref: LogicalDocumentRef;
  readonly label: string;
  readonly recognition: RecognitionState;
  readonly capability: OperationCapability;
  readonly effectiveVariant: PhysicalVariantRef;
  readonly alternateVariantIds: readonly string[];
}

export interface EditorCatalogSnapshot {
  readonly catalogRevision: string;
  readonly libraries: readonly CatalogLibrary[];
  readonly banks: readonly CatalogBank[];
  readonly documents: readonly CatalogDocument[];
  readonly history: readonly PhysicalVariantRef[];
  readonly projections: readonly ProjectionRef[];
}

export interface CatalogDocumentSummary {
  readonly ref: LogicalDocumentRef;
  readonly label: string;
  readonly recognition: RecognitionState;
  readonly capability: OperationCapability;
  readonly effectiveVariantId: string;
}

export interface EditorCatalogSummary {
  readonly catalogRevision: string;
  readonly domains: readonly DomainSummary[];
  readonly libraries: readonly CatalogLibrary[];
  readonly banks: readonly CatalogBank[];
  readonly documents: readonly CatalogDocumentSummary[];
  readonly historyCount: number;
}

export interface DomainSummary {
  readonly domain: EditorDomainId;
  readonly label: string;
  readonly visibility: 'visible' | 'hidden' | 'disabled';
  readonly capability: 'read-ready' | 'runtime-blocked' | 'deferred';
  readonly defaultTarget: LogicalDocumentRef | null;
}

// ---------------------------------------------------------------------------
// §4.4 固定注册表（只解释此注册表，不得另建自由分支）
// ---------------------------------------------------------------------------

export type ArtifactRoleMatcher =
  | { kind: 'registered-recovery' }
  | { kind: 'case-insensitive-suffix'; suffix: '.bak' | '.prev' }
  | { kind: 'verified-projection-manifest' }
  | { kind: 'main-storage-class'; storageClass: 'cache' | 'audit' | 'temporary' }
  | { kind: 'source-root'; sourceLayer: 'overlay' | 'base' };

export interface ArtifactRoleRule {
  readonly ruleId: string;
  readonly matcher: ArtifactRoleMatcher;
  readonly role: ArtifactRole;
}

export const ARTIFACT_ROLE_RULES = [
  { ruleId: 'registered-recovery', matcher: { kind: 'registered-recovery' }, role: 'recovery' },
  { ruleId: 'backup-suffix', matcher: { kind: 'case-insensitive-suffix', suffix: '.bak' }, role: 'backup' },
  { ruleId: 'previous-suffix', matcher: { kind: 'case-insensitive-suffix', suffix: '.prev' }, role: 'previous' },
  { ruleId: 'verified-projection', matcher: { kind: 'verified-projection-manifest' }, role: 'projection' },
  { ruleId: 'main-cache', matcher: { kind: 'main-storage-class', storageClass: 'cache' }, role: 'cache' },
  { ruleId: 'main-audit', matcher: { kind: 'main-storage-class', storageClass: 'audit' }, role: 'audit' },
  { ruleId: 'main-temporary', matcher: { kind: 'main-storage-class', storageClass: 'temporary' }, role: 'temporary' },
  { ruleId: 'overlay-source', matcher: { kind: 'source-root', sourceLayer: 'overlay' }, role: 'primary' },
  { ruleId: 'base-source', matcher: { kind: 'source-root', sourceLayer: 'base' }, role: 'base' },
] as const satisfies readonly ArtifactRoleRule[];

export type RuleMatcher =
  | { kind: 'artifact-role'; roles: readonly ArtifactRole[] }
  | { kind: 'confirmed-leaf'; formatId: NativeFormatId; containerRole?: ContainerRole; semanticSubtype?: string }
  | { kind: 'confirmed-child'; formatId: NativeFormatId; parentRole: ContainerRole; semanticSubtype?: string }
  | { kind: 'content-probe' }
  | { kind: 'compound-suffix'; suffix: string }
  | { kind: 'path-hint'; firstSegment: string }
  | { kind: 'always' };

export interface ResourceClassificationRule {
  readonly ruleId: string;
  readonly priority: 1000 | 900 | 800 | 700 | 600 | 300 | 0;
  readonly matcher: RuleMatcher;
  readonly decision:
    | { kind: 'catalog'; domain: EditorDomainId; integrationId: string; libraryKey: string }
    | { kind: 'history' }
    | { kind: 'projection'; requireMatchingProvenance: true }
    | { kind: 'hidden' }
    | { kind: 'files'; reasonCode: string };
}

export const RESOURCE_CLASSIFICATION_RULES = [
  { ruleId: 'artifact-backup-history', priority: 1000, matcher: { kind: 'artifact-role', roles: ['backup','previous','recovery'] }, decision: { kind: 'history' } },
  { ruleId: 'artifact-generated-projection', priority: 1000, matcher: { kind: 'artifact-role', roles: ['projection'] }, decision: { kind: 'projection', requireMatchingProvenance: true } },
  { ruleId: 'artifact-internal-hidden', priority: 1000, matcher: { kind: 'artifact-role', roles: ['cache','audit','temporary'] }, decision: { kind: 'hidden' } },
  { ruleId: 'gameparam-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'gameparam-binder', semanticSubtype: 'gameparam-primary' }, decision: { kind: 'catalog', domain: 'param', integrationId: 'param-editor', libraryKey: 'game-parameters' } },
  { ruleId: 'drawparam-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'drawparam-binder' }, decision: { kind: 'catalog', domain: 'container', integrationId: 'container-editor', libraryKey: 'drawparam-containers' } },
  { ruleId: 'gparam-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'gparam', semanticSubtype: 'map-bank' }, decision: { kind: 'catalog', domain: 'gparam', integrationId: 'gparam-editor', libraryKey: 'draw-graphics-parameters' } },
  { ruleId: 'loose-param-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'param', semanticSubtype: 'loose-table' }, decision: { kind: 'catalog', domain: 'param', integrationId: 'param-editor', libraryKey: 'loose-parameters' } },
  { ruleId: 'loose-fmg-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'fmg', semanticSubtype: 'loose-table' }, decision: { kind: 'catalog', domain: 'text', integrationId: 'text-editor', libraryKey: 'loose-text' } },
  { ruleId: 'msgbnd-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'msg-binder' }, decision: { kind: 'catalog', domain: 'text', integrationId: 'text-editor', libraryKey: 'game-text' } },
  { ruleId: 'emevd-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'emevd' }, decision: { kind: 'catalog', domain: 'event', integrationId: 'event-editor', libraryKey: 'events' } },
  { ruleId: 'msb-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'msb' }, decision: { kind: 'catalog', domain: 'map', integrationId: 'map-editor', libraryKey: 'maps' } },
  { ruleId: 'script-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'script-binder' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' } },
  { ruleId: 'lua-source-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'lua-source' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'loose-scripts' } },
  { ruleId: 'lua-bytecode-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'lua-bytecode' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'loose-scripts' } },
  { ruleId: 'hks-bytecode-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'hks-bytecode' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'loose-scripts' } },
  { ruleId: 'behavior-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'behavior-binder' }, decision: { kind: 'catalog', domain: 'behavior', integrationId: 'behavior-editor', libraryKey: 'behaviors' } },
  { ruleId: 'animation-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'animation-binder' }, decision: { kind: 'catalog', domain: 'animation', integrationId: 'animation-editor', libraryKey: 'animations' } },
  { ruleId: 'texture-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'texture-binder' }, decision: { kind: 'catalog', domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' } },
  { ruleId: 'vfx-binder-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'vfx-binder' }, decision: { kind: 'catalog', domain: 'vfx', integrationId: 'vfx-editor', libraryKey: 'effects' } },
  { ruleId: 'loose-esd-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'esd' }, decision: { kind: 'catalog', domain: 'behavior', integrationId: 'behavior-editor', libraryKey: 'loose-behaviors' } },
  { ruleId: 'loose-tae-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'tae' }, decision: { kind: 'catalog', domain: 'animation', integrationId: 'animation-editor', libraryKey: 'loose-animations' } },
  { ruleId: 'flver-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'flver' }, decision: { kind: 'catalog', domain: 'model', integrationId: 'model-editor', libraryKey: 'models' } },
  { ruleId: 'tpf-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'tpf' }, decision: { kind: 'catalog', domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' } },
  { ruleId: 'dds-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'dds' }, decision: { kind: 'catalog', domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' } },
  { ruleId: 'mtd-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'mtd' }, decision: { kind: 'catalog', domain: 'material', integrationId: 'material-editor', libraryKey: 'materials' } },
  { ruleId: 'matbin-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'matbin' }, decision: { kind: 'catalog', domain: 'material', integrationId: 'material-editor', libraryKey: 'materials' } },
  { ruleId: 'fxr-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'fxr' }, decision: { kind: 'catalog', domain: 'vfx', integrationId: 'vfx-editor', libraryKey: 'effects' } },
  { ruleId: 'generic-bnd4-confirmed', priority: 900, matcher: { kind: 'confirmed-leaf', formatId: 'bnd4', containerRole: 'generic-binder' }, decision: { kind: 'catalog', domain: 'container', integrationId: 'container-editor', libraryKey: 'containers' } },
  { ruleId: 'drawparam-param-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'param', parentRole: 'drawparam-binder' }, decision: { kind: 'catalog', domain: 'param', integrationId: 'param-editor', libraryKey: 'drawparam-tables' } },
  { ruleId: 'drawparam-gparam-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'gparam', parentRole: 'drawparam-binder' }, decision: { kind: 'catalog', domain: 'gparam', integrationId: 'gparam-editor', libraryKey: 'draw-graphics-parameters' } },
  { ruleId: 'fmg-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'fmg', parentRole: 'msg-binder' }, decision: { kind: 'catalog', domain: 'text', integrationId: 'text-editor', libraryKey: 'game-text' } },
  { ruleId: 'lua-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'lua-source', parentRole: 'script-binder' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' } },
  { ruleId: 'lua-bytecode-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'lua-bytecode', parentRole: 'script-binder' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' } },
  { ruleId: 'hks-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'hks-bytecode', parentRole: 'script-binder' }, decision: { kind: 'catalog', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' } },
  { ruleId: 'esd-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'esd', parentRole: 'behavior-binder' }, decision: { kind: 'catalog', domain: 'behavior', integrationId: 'behavior-editor', libraryKey: 'behaviors' } },
  { ruleId: 'tae-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'tae', parentRole: 'animation-binder' }, decision: { kind: 'catalog', domain: 'animation', integrationId: 'animation-editor', libraryKey: 'animations' } },
  { ruleId: 'tpf-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'tpf', parentRole: 'texture-binder' }, decision: { kind: 'catalog', domain: 'texture', integrationId: 'texture-editor', libraryKey: 'textures' } },
  { ruleId: 'fxr-child', priority: 800, matcher: { kind: 'confirmed-child', formatId: 'fxr', parentRole: 'vfx-binder' }, decision: { kind: 'catalog', domain: 'vfx', integrationId: 'vfx-editor', libraryKey: 'effects' } },
  { ruleId: 'bounded-content-probe', priority: 700, matcher: { kind: 'content-probe' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'parambnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.parambnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'drawparambnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.drawparambnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'msgbnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.msgbnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'gparam-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.gparam.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'emevd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.emevd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'luabnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.luabnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'talkesdbnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.talkesdbnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'anibnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.anibnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'msb-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.msb.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'flver-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.flver.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'tpf-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.tpf.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'ffxbnd-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.ffxbnd.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'fxr-dcx-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.fxr.dcx' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'param-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.param' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'gparam-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.gparam' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'fmg-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.fmg' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'lua-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.lua' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'hks-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.hks' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'esd-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.esd' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'tae-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.tae' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'flver-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.flver' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'tpf-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.tpf' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'dds-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.dds' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'mtd-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.mtd' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'matbin-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.matbin' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'fxr-suffix-candidate', priority: 600, matcher: { kind: 'compound-suffix', suffix: '.fxr' }, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } },
  { ruleId: 'physical-path-hint', priority: 300, matcher: { kind: 'path-hint', firstSegment: '*' }, decision: { kind: 'files', reasonCode: 'path-hint-only' } },
  { ruleId: 'files-fallback', priority: 0, matcher: { kind: 'always' }, decision: { kind: 'files', reasonCode: 'unrecognized-format' } },
] as const satisfies readonly ResourceClassificationRule[];

// ---------------------------------------------------------------------------
// §5.1 路由：confirmed leaf → EditorIntegration（ROUTE-06）
//
// 只解释 RESOURCE_CLASSIFICATION_RULES 的 priority-900 confirmed-leaf 规则，
// 不得另建自由分支。confirmed container-child projection（priority 800）不在
// 这里解析：child 由容器编辑器的条目导航呈现，不是独立路由。
// ---------------------------------------------------------------------------

export interface ConfirmedLeafResolution {
  readonly domain: EditorDomainId;
  readonly integrationId: string;
  readonly libraryKey: string;
}

export function resolveIntegrationForConfirmedLeaf(
  leafFormatId: Exclude<NativeFormatId, 'unknown'>,
  containerRole: ContainerRole,
  semanticSubtype: string | null
): ConfirmedLeafResolution | null {
  for (const rule of RESOURCE_CLASSIFICATION_RULES) {
    if (rule.priority !== 900) continue;
    const matcher = rule.matcher as RuleMatcher; // 注册表是 as-const 字面量联合；按 RuleMatcher 读取可选键
    if (matcher.kind !== 'confirmed-leaf') continue;
    if (matcher.formatId !== leafFormatId) continue;
    if (matcher.containerRole !== undefined && matcher.containerRole !== containerRole) continue;
    if (matcher.semanticSubtype !== undefined && matcher.semanticSubtype !== semanticSubtype) continue;
    if (rule.decision.kind !== 'catalog') continue;
    return {
      domain: rule.decision.domain,
      integrationId: rule.decision.integrationId,
      libraryKey: rule.decision.libraryKey
    };
  }
  return null;
}

export interface EditorIntegration {
  readonly integrationId: string;
  readonly domain: EditorDomainId;
  readonly editorId: string;
  readonly visibleWhen: 'always' | 'read-ready';
}

export const EDITOR_INTEGRATIONS = [
  { integrationId: 'project-editor', domain: 'project', editorId: 'project', visibleWhen: 'always' },
  { integrationId: 'param-editor', domain: 'param', editorId: 'param', visibleWhen: 'read-ready' },
  { integrationId: 'gparam-editor', domain: 'gparam', editorId: 'gparam', visibleWhen: 'read-ready' },
  { integrationId: 'text-editor', domain: 'text', editorId: 'fmg', visibleWhen: 'read-ready' },
  { integrationId: 'event-editor', domain: 'event', editorId: 'emevd-source', visibleWhen: 'read-ready' },
  { integrationId: 'map-editor', domain: 'map', editorId: 'msb', visibleWhen: 'read-ready' },
  { integrationId: 'script-editor', domain: 'script', editorId: 'script', visibleWhen: 'read-ready' },
  { integrationId: 'behavior-editor', domain: 'behavior', editorId: 'esd', visibleWhen: 'read-ready' },
  { integrationId: 'animation-editor', domain: 'animation', editorId: 'tae', visibleWhen: 'read-ready' },
  { integrationId: 'model-editor', domain: 'model', editorId: 'flver', visibleWhen: 'read-ready' },
  { integrationId: 'texture-editor', domain: 'texture', editorId: 'tpf', visibleWhen: 'read-ready' },
  { integrationId: 'material-editor', domain: 'material', editorId: 'material', visibleWhen: 'read-ready' },
  { integrationId: 'vfx-editor', domain: 'vfx', editorId: 'vfx', visibleWhen: 'read-ready' },
  { integrationId: 'container-editor', domain: 'container', editorId: 'bnd4', visibleWhen: 'read-ready' },
  { integrationId: 'files-editor', domain: 'files', editorId: 'files', visibleWhen: 'always' },
] as const satisfies readonly EditorIntegration[];

type AssertNever<T extends never> = T;
type RegisteredIntegrationId = typeof EDITOR_INTEGRATIONS[number]['integrationId'];
type RuleCatalogDecision = Extract<typeof RESOURCE_CLASSIFICATION_RULES[number]['decision'], { kind: 'catalog' }>;
type _NoUnknownIntegrationId = AssertNever<Exclude<RuleCatalogDecision['integrationId'], RegisteredIntegrationId>>;
type _EveryDomainHasIntegration = AssertNever<Exclude<EditorDomainId, typeof EDITOR_INTEGRATIONS[number]['domain']>>;

// ---------------------------------------------------------------------------
// §14.1 / §14.2 状态模型
// ---------------------------------------------------------------------------

export type DocumentLoadPhase =
  | 'catalog-resolve' | 'locator-resolve' | 'bridge-open'
  | 'native-parse' | 'document-store' | 'first-page';

export type DocumentLoadReasonCode =
  | 'document-not-found' | 'history-only' | 'bridge-runtime-unavailable'
  | 'compression-runtime-unavailable' | 'native-format-unconfirmed'
  | 'native-parse-failed' | 'partial-native-document' | 'capability-blocked'
  | 'request-cancelled' | 'request-expired' | 'unknown-format';

export type DocumentLoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; phase: DocumentLoadPhase }
  | { kind: 'ready' }
  | { kind: 'empty'; reason: 'true-empty' }
  | { kind: 'no-match'; query: string }
  | { kind: 'partial'; reasonCode: DocumentLoadReasonCode }
  | { kind: 'blocked'; reasonCode: DocumentLoadReasonCode; retryable: boolean }
  | { kind: 'unsupported'; reasonCode: DocumentLoadReasonCode }
  | { kind: 'error'; reasonCode: DocumentLoadReasonCode; retryable: boolean };

export type EditTransactionState =
  | { kind: 'clean' }
  | { kind: 'dirty'; revision: string }
  | { kind: 'staging'; operationId: string }
  | { kind: 'staged'; operationId: string }
  | { kind: 'awaiting-approval'; operationId: string }
  | { kind: 'committing'; operationId: string }
  | { kind: 'verifying'; operationId: string; phase: string }
  | { kind: 'committed'; operationId: string; committedRevision: string }
  | { kind: 'rolling-back'; operationId: string }
  | { kind: 'rolled-back'; operationId: string; restoredRevision: string }
  | { kind: 'rollback-failed'; operationId: string; reasonCode: string }
  | { kind: 'failed'; operationId: string; phase: string; reasonCode: string };

// ---------------------------------------------------------------------------
// §14.4 DocumentStore 与 mutation IPC 闭合契约（shared 可见部分）
// ---------------------------------------------------------------------------

export type EditorScalar = null | boolean | number | string | readonly number[];

export interface TypedFieldChange {
  readonly fieldId: string;
  readonly value: EditorScalar;
}

export type EditorMutation =
  | { kind: 'param-field-set'; tableId: string; rowId: string; fieldId: string; value: EditorScalar }
  | { kind: 'param-row-upsert'; tableId: string; rowId: string; fields: readonly TypedFieldChange[] }
  | { kind: 'param-row-delete'; tableId: string; rowId: string }
  | { kind: 'gparam-field-set'; bankId: string; groupId: string; fieldId: string; value: EditorScalar }
  | { kind: 'fmg-entry-upsert'; tableId: string; entryId: string; text: string }
  | { kind: 'fmg-entry-delete'; tableId: string; entryId: string }
  | { kind: 'emevd-source-change'; sourceText: string }
  | { kind: 'bnd4-child-replace'; childStableId: string; stagedPayloadToken: string }
  | { kind: 'script-plaintext-change'; childStableId: string; text: string; encoding: string; newline: 'crlf' | 'lf' | 'preserve' }
  | { kind: 'map-entity-upsert'; entityStableId: string; fields: readonly TypedFieldChange[] }
  | { kind: 'map-entity-delete'; entityStableId: string }
  | { kind: 'flver-material-slot-set'; meshStableId: string; slotIndex: number; materialStableId: string }
  | { kind: 'tpf-texture-replace'; textureStableId: string; attachmentToken: string }
  | { kind: 'material-property-set'; propertyId: string; value: EditorScalar }
  | { kind: 'vfx-field-set'; nodeStableId: string; fieldId: string; value: EditorScalar }
  | { kind: 'behavior-transition-upsert'; stateStableId: string; transitionStableId: string; fields: readonly TypedFieldChange[] }
  | { kind: 'tae-event-upsert'; animationStableId: string; eventStableId: string; fields: readonly TypedFieldChange[] };

export interface OpenEditorDocumentRequest {
  readonly document: LogicalDocumentRef;
}

export type EditorPageQuery =
  | { kind: 'param-tables'; search: string }
  | { kind: 'param-rows'; tableId: string; search: string }
  | { kind: 'param-fields'; tableId: string; rowId: string }
  | { kind: 'gparam-groups'; bankId: string; search: string }
  | { kind: 'gparam-fields'; bankId: string; groupId: string }
  | { kind: 'fmg-entries'; tableId: string; search: string }
  | { kind: 'event-outline'; search: string }
  | { kind: 'container-entries'; parentStableId: string | null; search: string }
  | { kind: 'script-symbols'; search: string }
  | { kind: 'resource-tree'; parentStableId: string | null; search: string }
  | { kind: 'properties'; targetStableId: string; groupId: string | null };

export interface PageEditorDocumentRequest {
  readonly documentHandle: string;
  readonly expectedRevision: string;
  readonly query: EditorPageQuery;
  readonly cursor: string | null;
  readonly limit: number;
}

export type EditorContentQuery =
  | { kind: 'fmg-content'; tableId: string; entryId: string }
  | { kind: 'event-source' }
  | { kind: 'script-source'; childStableId: string }
  | { kind: 'resource-preview'; targetStableId: string };

export interface ReadEditorContentRequest {
  readonly documentHandle: string;
  readonly expectedRevision: string;
  readonly query: EditorContentQuery;
}

export interface ApplyEditorMutationRequest {
  readonly documentHandle: string;
  readonly expectedRevision: string;
  readonly mutation: EditorMutation;
}

export type EditorDocumentErrorCode =
  | 'invalid-request' | 'not-found' | 'owner-mismatch' | 'stale-revision'
  | 'capability-blocked' | 'runtime-blocked' | 'native-open-failed'
  | 'mutation-rejected' | 'cancelled' | 'expired';

export interface OpenEditorDocumentValue {
  readonly documentHandle: string;
  readonly revision: string;
  readonly loadState: DocumentLoadState;
  readonly readOperations: readonly ReadOperationId[];
  readonly writeOperations: readonly WriteOperationId[];
}

export type EditorPageItemDto =
  | { kind: 'param-table'; tableId: string; name: string; localizedName: string | null }
  | { kind: 'param-row'; tableId: string; rowId: string; name: string | null; change: 'none' | 'added' | 'modified' | 'deleted' }
  | { kind: 'param-field'; tableId: string; rowId: string; fieldId: string; name: string; value: EditorScalar; compareValue: EditorScalar; enumLabel: string | null; valueType: string; description: string | null; editable: boolean }
  | { kind: 'gparam-group'; bankId: string; groupId: string; name: string }
  | { kind: 'gparam-field'; bankId: string; groupId: string; fieldId: string; name: string; value: EditorScalar; compareValue: EditorScalar; editable: boolean }
  | { kind: 'fmg-entry'; tableId: string; entryId: string; preview: string; change: 'none' | 'added' | 'modified' | 'deleted' }
  | { kind: 'event-outline'; eventId: string; displayName: string; startLine: number; endLine: number }
  | { kind: 'container-entry'; stableId: string; name: string; formatId: NativeFormatId; byteLength: number; childCount: number }
  | { kind: 'script-symbol'; symbolId: string; name: string; symbolKind: 'function' | 'variable' | 'label'; line: number }
  | { kind: 'resource-node'; stableId: string; parentStableId: string | null; label: string; nodeKind: string; hasChildren: boolean }
  | { kind: 'property'; targetStableId: string; groupId: string | null; propertyId: string; label: string; value: EditorScalar; compareValue: EditorScalar; editable: boolean };

export interface EditorDocumentPageValue {
  readonly documentHandle: string;
  readonly revision: string;
  readonly queryKind: EditorPageQuery['kind'];
  readonly items: readonly EditorPageItemDto[];
  readonly nextCursor: string | null;
  readonly totalKnown: number | null;
}

export type EditorContentValue =
  | { kind: 'fmg-content'; tableId: string; entryId: string; text: string }
  | { kind: 'event-source'; sourceText: string; sourceDigest: string }
  | { kind: 'script-source'; childStableId: string; text: string; editable: boolean; encoding: string; newline: 'crlf' | 'lf' | 'mixed' }
  | { kind: 'resource-preview'; targetStableId: string; previewToken: string; mediaType: string; byteLength: number };

export interface ApplyEditorMutationValue {
  readonly documentHandle: string;
  readonly revision: string;
  readonly transactionState: EditTransactionState;
}

export type EditorDocumentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: EditorDocumentErrorCode; retryable: boolean };

// ---------------------------------------------------------------------------
// Runtime decoders（§4.2：所有请求/响应必须有 runtime decoder；拒绝绝对
// 路径与 unknown extra fields；不得用 `as` 强转绕过）
// ---------------------------------------------------------------------------

export class EditorCatalogDecodeError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EditorCatalogDecodeError';
    this.path = path;
  }
}

const ABSOLUTE_PATH_PATTERNS = [
  /^[a-zA-Z]:[\\/]/,   // Windows drive
  /^\\\\/,             // UNC
  /^\//                // POSIX root
] as const;

export function isAbsolutePathLike(value: string): boolean {
  return ABSOLUTE_PATH_PATTERNS.some((re) => re.test(value));
}

export function fail(path: string, message: string): never {
  throw new EditorCatalogDecodeError(path, message);
}

export function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, `expected object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, `expected string, got ${typeof value}`);
  return value;
}

export function expectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, `expected finite number`);
  return value;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, `expected boolean`);
  return value;
}

export function expectStringOrNull(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectString(value, path);
}

export function expectNumberOrNull(value: unknown, path: string): number | null {
  if (value === null) return null;
  return expectNumber(value, path);
}

export function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(path, `unknown field "${key}"`);
  }
}

export function rejectAbsolutePath(value: string, path: string): void {
  if (isAbsolutePathLike(value)) fail(path, `absolute path forbidden in renderer DTO`);
}

export function expectEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  const s = expectString(value, path);
  if (!(allowed as readonly string[]).includes(s)) fail(path, `invalid enum value "${s}"`);
  return s as T;
}

export function expectStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) fail(path, `expected array`);
  return value.map((v, i) => expectString(v, `${path}[${i}]`));
}

export function expectNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return expectString(value, path);
}

export function expectNullableRecord(value: unknown, path: string): Record<string, unknown> | null {
  if (value === null) return null;
  return expectRecord(value, path);
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `expected array`);
  return value;
}

/** 校验稳定标识符字段：非空字符串且不含绝对路径/`..` 逃逸。 */
export function expectStableId(value: unknown, path: string): string {
  const s = expectString(value, path);
  rejectAbsolutePath(s, path);
  if (/\.\.([\\/])/.test(s)) fail(path, `path traversal forbidden`);
  return s;
}

/** 从 DTO record 取值；缺字段即失败。 */
export function valueOf(record: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in record)) fail(path, `missing field "${key}"`);
  return record[key];
}

// --- 基础枚举 ---

export function decodeEditorDomainId(value: unknown, path = 'EditorDomainId'): EditorDomainId {
  return expectEnum(value, EDITOR_DOMAIN_IDS, path);
}

export function decodeArtifactRole(value: unknown, path = 'ArtifactRole'): ArtifactRole {
  return expectEnum(
    value,
    ['primary', 'base', 'backup', 'previous', 'recovery', 'projection', 'cache', 'audit', 'temporary'],
    path
  );
}

export function decodeNativeFormatId(value: unknown, path = 'NativeFormatId'): NativeFormatId {
  return expectEnum(
    value,
    [
      'dcx-dflt', 'dcx-krak', 'bnd4', 'param', 'gparam', 'fmg', 'emevd', 'msb',
      'lua-source', 'lua-bytecode', 'hks-bytecode', 'esd', 'tae', 'flver', 'tpf',
      'dds', 'mtd', 'matbin', 'fxr', 'unknown'
    ],
    path
  );
}

export function decodeContainerRole(value: unknown, path = 'ContainerRole'): ContainerRole {
  return expectEnum(
    value,
    [
      'none', 'gameparam-binder', 'drawparam-binder', 'msg-binder', 'script-binder',
      'behavior-binder', 'animation-binder', 'texture-binder', 'vfx-binder', 'generic-binder'
    ],
    path
  );
}

// --- §4.2 结构 ---

export function decodeFormatCandidate(value: unknown, path = 'FormatCandidate'): FormatCandidate {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['formatId', 'source', 'ruleId'], path);
  const source = expectEnum(valueOf(r, 'source', path), ['content-probe', 'compound-suffix', 'path-hint'], `${path}.source`);
  const ruleId = expectString(r.ruleId, `${path}.ruleId`);
  rejectAbsolutePath(ruleId, `${path}.ruleId`);
  return {
    formatId: decodeNativeFormatId(r.formatId, `${path}.formatId`),
    source,
    ruleId
  };
}

export function decodeConfirmedFormatStack(value: unknown, path = 'ConfirmedFormatStack'): ConfirmedFormatStack {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['stackId', 'layers', 'leafFormatId', 'containerRole'], path);
  const stackId = expectString(r.stackId, `${path}.stackId`);
  rejectAbsolutePath(stackId, `${path}.stackId`);
  const layers = expectArray(r.layers, `${path}.layers`).map((l, i) => decodeFormatLayer(l, `${path}.layers[${i}]`));
  const leaf = decodeNativeFormatId(r.leafFormatId, `${path}.leafFormatId`);
  if (leaf === 'unknown') fail(`${path}.leafFormatId`, `leaf cannot be "unknown" in confirmed stack`);
  return { stackId, layers, leafFormatId: leaf as Exclude<NativeFormatId, 'unknown'>, containerRole: decodeContainerRole(r.containerRole, `${path}.containerRole`) };
}

export function decodeFormatLayer(value: unknown, path = 'FormatLayer'): FormatLayer {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['layerIndex', 'formatId', 'confirmedBy', 'childStableId'], path);
  const formatId = decodeNativeFormatId(r.formatId, `${path}.formatId`);
  if (formatId === 'unknown') fail(`${path}.formatId`, `layer formatId cannot be "unknown"`);
  const confirmedBy = expectEnum(valueOf(r, 'confirmedBy', path), ['bridge'], `${path}.confirmedBy`);
  const childStableId = expectNullableString(r.childStableId, `${path}.childStableId`);
  if (childStableId !== null) rejectAbsolutePath(childStableId, `${path}.childStableId`);
  return { layerIndex: expectNumber(r.layerIndex, `${path}.layerIndex`), formatId: formatId as Exclude<NativeFormatId, 'unknown'>, confirmedBy, childStableId };
}

function decodePhysicalVariantCommon(r: Record<string, unknown>, path: string): {
  variantId: string;
  precedence: number;
  contentHash: string | null;
  sourceRevision: string | null;
  provenanceDigest: string | null;
} {
  rejectUnknownFields(r, ['variantId', 'precedence', 'contentHash', 'sourceRevision', 'provenanceDigest', 'role', 'sourceLayer', 'recoveryOfResourceId'], path);
  const variantId = expectString(r.variantId, `${path}.variantId`);
  rejectAbsolutePath(variantId, `${path}.variantId`);
  return {
    variantId,
    precedence: expectNumber(r.precedence, `${path}.precedence`),
    contentHash: expectNullableString(r.contentHash, `${path}.contentHash`),
    sourceRevision: expectNullableString(r.sourceRevision, `${path}.sourceRevision`),
    provenanceDigest: expectNullableString(r.provenanceDigest, `${path}.provenanceDigest`)
  };
}

export function decodePhysicalVariantRef(value: unknown, path = 'PhysicalVariantRef'): PhysicalVariantRef {
  const r = expectRecord(value, path);
  const role = expectEnum(
    valueOf(r, 'role', path),
    ['primary', 'base', 'backup', 'previous', 'recovery'],
    `${path}.role`
  );
  const common = decodePhysicalVariantCommon(r, path);
  if (role === 'primary' || role === 'base') {
    const sourceLayer = expectEnum(valueOf(r, 'sourceLayer', path), ['overlay', 'base'], `${path}.sourceLayer`);
    if (r.recoveryOfResourceId !== null && r.recoveryOfResourceId !== undefined) {
      fail(`${path}.recoveryOfResourceId`, `primary/base must have null recoveryOfResourceId`);
    }
    return { ...common, role, sourceLayer, recoveryOfResourceId: null };
  }
  const sourceLayer = expectEnum(valueOf(r, 'sourceLayer', path), ['history'], `${path}.sourceLayer`);
  const recoveryOfResourceId = expectString(r.recoveryOfResourceId, `${path}.recoveryOfResourceId`);
  rejectAbsolutePath(recoveryOfResourceId, `${path}.recoveryOfResourceId`);
  return { ...common, role, sourceLayer, recoveryOfResourceId };
}

export function decodeRecognitionState(value: unknown, path = 'RecognitionState'): RecognitionState {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), ['candidate', 'confirmed', 'conflict', 'unsupported'], `${path}.kind`);
  switch (kind) {
    case 'candidate': {
      rejectUnknownFields(r, ['kind', 'evidence'], path);
      return { kind, evidence: expectArray(r.evidence, `${path}.evidence`).map((v, i) => decodeFormatCandidate(v, `${path}.evidence[${i}]`)) };
    }
    case 'confirmed': {
      rejectUnknownFields(r, ['kind', 'stack'], path);
      return { kind, stack: decodeConfirmedFormatStack(r.stack, `${path}.stack`) };
    }
    case 'conflict': {
      rejectUnknownFields(r, ['kind', 'confirmedStackIds'], path);
      return { kind, confirmedStackIds: expectStringArray(r.confirmedStackIds, `${path}.confirmedStackIds`) };
    }
    case 'unsupported': {
      rejectUnknownFields(r, ['kind', 'reasonCode'], path);
      return { kind, reasonCode: expectString(r.reasonCode, `${path}.reasonCode`) };
    }
  }
}

// --- 能力 ---

export function decodeReadOperationId(value: unknown, path = 'ReadOperationId'): ReadOperationId {
  return expectEnum(
    value,
    ['catalog-open', 'page-tables', 'page-rows', 'page-fields', 'page-banks', 'page-groups', 'page-entries', 'read-source', 'read-outline', 'read-preview', 'read-metadata', 'read-properties'],
    path
  );
}

export function decodeWriteOperationId(value: unknown, path = 'WriteOperationId'): WriteOperationId {
  return expectEnum(
    value,
    [
      'param-field-set', 'param-row-upsert', 'param-row-delete', 'gparam-field-set',
      'fmg-entry-upsert', 'fmg-entry-delete', 'emevd-source-change', 'bnd4-child-replace',
      'script-plaintext-change', 'map-entity-upsert', 'map-entity-delete',
      'flver-material-slot-set', 'tpf-texture-replace', 'material-property-set',
      'vfx-field-set', 'behavior-transition-upsert', 'tae-event-upsert'
    ],
    path
  );
}

export function decodeCapabilityReasonCode(value: unknown, path = 'CapabilityReasonCode'): CapabilityReasonCode {
  return expectEnum(
    value,
    [
      'read-contract-missing', 'write-contract-missing', 'operation-not-allowed',
      'runtime-unavailable', 'oodle-unavailable', 'metadata-mismatch',
      'bridge-authority-insufficient', 'writer-unverified',
      'outer-rebuild-unavailable', 'native-reread-unavailable',
      'unknown-region-unverifiable', 'sibling-verification-unavailable'
    ],
    path
  );
}

export function decodeReadCapability(value: unknown, path = 'ReadCapability'): ReadCapability {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), ['ready', 'blocked', 'unavailable'], `${path}.kind`);
  if (kind === 'ready') {
    rejectUnknownFields(r, ['kind', 'operationIds', 'verifiedStages', 'resolverSnapshotId'], path);
    const stages = expectArray(r.verifiedStages, `${path}.verifiedStages`).map((s, i) =>
      expectEnum(s, ['D3', 'D4', 'D5', 'D6'], `${path}.verifiedStages[${i}]`)
    );
    if (stages.length !== 4) fail(`${path}.verifiedStages`, `ready capability requires exactly D3-D6`);
    const resolverSnapshotId = expectString(r.resolverSnapshotId, `${path}.resolverSnapshotId`);
    rejectAbsolutePath(resolverSnapshotId, `${path}.resolverSnapshotId`);
    return {
      kind,
      operationIds: expectArray(r.operationIds, `${path}.operationIds`).map((v, i) => decodeReadOperationId(v, `${path}.operationIds[${i}]`)),
      verifiedStages: [stages[0] as 'D3', stages[1] as 'D4', stages[2] as 'D5', stages[3] as 'D6'],
      resolverSnapshotId
    };
  }
  if (kind === 'blocked') {
    rejectUnknownFields(r, ['kind', 'reasonCode', 'missing'], path);
    return {
      kind,
      reasonCode: decodeCapabilityReasonCode(r.reasonCode, `${path}.reasonCode`),
      missing: expectArray(r.missing, `${path}.missing`).map((s, i) => expectEnum(s, ['D3', 'D4', 'D5', 'D6'], `${path}.missing[${i}]`))
    };
  }
  rejectUnknownFields(r, ['kind', 'reasonCode'], path);
  return { kind, reasonCode: decodeCapabilityReasonCode(r.reasonCode, `${path}.reasonCode`) };
}

export function decodeWriteCapability(value: unknown, path = 'WriteCapability'): WriteCapability {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), ['ready', 'blocked', 'unavailable'], `${path}.kind`);
  if (kind === 'ready') {
    rejectUnknownFields(r, ['kind', 'operationIds', 'verifiedStages', 'resolverSnapshotId'], path);
    const stages = expectArray(r.verifiedStages, `${path}.verifiedStages`).map((s, i) =>
      expectEnum(s, ['D7', 'D8', 'D9', 'D10'], `${path}.verifiedStages[${i}]`)
    );
    if (stages.length !== 4) fail(`${path}.verifiedStages`, `ready capability requires exactly D7-D10`);
    const resolverSnapshotId = expectString(r.resolverSnapshotId, `${path}.resolverSnapshotId`);
    rejectAbsolutePath(resolverSnapshotId, `${path}.resolverSnapshotId`);
    return {
      kind,
      operationIds: expectArray(r.operationIds, `${path}.operationIds`).map((v, i) => decodeWriteOperationId(v, `${path}.operationIds[${i}]`)),
      verifiedStages: [stages[0] as 'D7', stages[1] as 'D8', stages[2] as 'D9', stages[3] as 'D10'],
      resolverSnapshotId
    };
  }
  if (kind === 'blocked') {
    rejectUnknownFields(r, ['kind', 'reasonCode', 'missingStages'], path);
    return {
      kind,
      reasonCode: decodeCapabilityReasonCode(r.reasonCode, `${path}.reasonCode`),
      missingStages: expectArray(r.missingStages, `${path}.missingStages`).map((s, i) => expectEnum(s, ['D7', 'D8', 'D9', 'D10'], `${path}.missingStages[${i}]`))
    };
  }
  rejectUnknownFields(r, ['kind', 'reasonCode'], path);
  return { kind, reasonCode: decodeCapabilityReasonCode(r.reasonCode, `${path}.reasonCode`) };
}

export function decodeOperationCapability(value: unknown, path = 'OperationCapability'): OperationCapability {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['read', 'write'], path);
  return { read: decodeReadCapability(r.read, `${path}.read`), write: decodeWriteCapability(r.write, `${path}.write`) };
}

// --- catalog 结构 ---

export function decodeLogicalDocumentRef(value: unknown, path = 'LogicalDocumentRef'): LogicalDocumentRef {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['resourceId', 'domain', 'libraryId', 'bankId', 'documentId', 'sourceVariant'], path);
  return {
    resourceId: expectStableId(r.resourceId, `${path}.resourceId`),
    domain: decodeEditorDomainId(r.domain, `${path}.domain`),
    libraryId: expectStableId(r.libraryId, `${path}.libraryId`),
    bankId: r.bankId === null ? null : expectStableId(r.bankId, `${path}.bankId`),
    documentId: expectStableId(r.documentId, `${path}.documentId`),
    sourceVariant: expectEnum(valueOf(r, 'sourceVariant', path), ['overlay', 'base'], `${path}.sourceVariant`)
  };
}

export function decodeCatalogLibrary(value: unknown, path = 'CatalogLibrary'): CatalogLibrary {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['libraryId', 'domain', 'label', 'bankIds', 'documentIds', 'counts'], path);
  const libraryId = expectString(r.libraryId, `${path}.libraryId`);
  rejectAbsolutePath(libraryId, `${path}.libraryId`);
  const counts = expectNullableRecord(r.counts, `${path}.counts`);
  const decodedCounts: Partial<Record<'libraries' | 'banks' | 'tables' | 'rows' | 'entries' | 'events' | 'files', number>> = {};
  if (counts !== null) {
    rejectUnknownFields(counts, ['libraries', 'banks', 'tables', 'rows', 'entries', 'events', 'files'], `${path}.counts`);
    for (const key of ['libraries', 'banks', 'tables', 'rows', 'entries', 'events', 'files'] as const) {
      if (counts[key] !== undefined) decodedCounts[key] = expectNumber(counts[key], `${path}.counts.${key}`);
    }
  }
  return {
    libraryId,
    domain: decodeEditorDomainId(r.domain, `${path}.domain`),
    label: expectString(r.label, `${path}.label`),
    bankIds: expectStringArray(r.bankIds, `${path}.bankIds`),
    documentIds: expectStringArray(r.documentIds, `${path}.documentIds`),
    counts: decodedCounts
  };
}

export function decodeCatalogBank(value: unknown, path = 'CatalogBank'): CatalogBank {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['bankId', 'libraryId', 'label', 'semanticKey', 'languageId', 'containerKind', 'documentIds'], path);
  const bankId = expectString(r.bankId, `${path}.bankId`);
  rejectAbsolutePath(bankId, `${path}.bankId`);
  const libraryId = expectString(r.libraryId, `${path}.libraryId`);
  rejectAbsolutePath(libraryId, `${path}.libraryId`);
  return {
    bankId,
    libraryId,
    label: expectString(r.label, `${path}.label`),
    semanticKey: expectString(r.semanticKey, `${path}.semanticKey`),
    languageId: expectNullableString(r.languageId, `${path}.languageId`),
    containerKind: r.containerKind === null
      ? null
      : (expectEnum(valueOf(r, 'containerKind', path), ['item', 'menu'], `${path}.containerKind`) as 'item' | 'menu'),
    documentIds: expectStringArray(r.documentIds, `${path}.documentIds`)
  };
}

export function decodeCatalogDocument(value: unknown, path = 'CatalogDocument'): CatalogDocument {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['ref', 'label', 'recognition', 'capability', 'effectiveVariant', 'alternateVariantIds'], path);
  return {
    ref: decodeLogicalDocumentRef(r.ref, `${path}.ref`),
    label: expectString(r.label, `${path}.label`),
    recognition: decodeRecognitionState(r.recognition, `${path}.recognition`),
    capability: decodeOperationCapability(r.capability, `${path}.capability`),
    effectiveVariant: decodePhysicalVariantRef(r.effectiveVariant, `${path}.effectiveVariant`),
    alternateVariantIds: expectStringArray(r.alternateVariantIds, `${path}.alternateVariantIds`)
  };
}

export function decodeCatalogDocumentSummary(value: unknown, path = 'CatalogDocumentSummary'): CatalogDocumentSummary {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['ref', 'label', 'recognition', 'capability', 'effectiveVariantId'], path);
  const effectiveVariantId = expectString(r.effectiveVariantId, `${path}.effectiveVariantId`);
  rejectAbsolutePath(effectiveVariantId, `${path}.effectiveVariantId`);
  return {
    ref: decodeLogicalDocumentRef(r.ref, `${path}.ref`),
    label: expectString(r.label, `${path}.label`),
    recognition: decodeRecognitionState(r.recognition, `${path}.recognition`),
    capability: decodeOperationCapability(r.capability, `${path}.capability`),
    effectiveVariantId
  };
}

export function decodeDomainSummary(value: unknown, path = 'DomainSummary'): DomainSummary {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['domain', 'label', 'visibility', 'capability', 'defaultTarget'], path);
  return {
    domain: decodeEditorDomainId(r.domain, `${path}.domain`),
    label: expectString(r.label, `${path}.label`),
    visibility: expectEnum(valueOf(r, 'visibility', path), ['visible', 'hidden', 'disabled'], `${path}.visibility`),
    capability: expectEnum(valueOf(r, 'capability', path), ['read-ready', 'runtime-blocked', 'deferred'], `${path}.capability`),
    defaultTarget: r.defaultTarget === null ? null : decodeLogicalDocumentRef(r.defaultTarget, `${path}.defaultTarget`)
  };
}

export function decodeEditorCatalogSummary(value: unknown, path = 'EditorCatalogSummary'): EditorCatalogSummary {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['catalogRevision', 'domains', 'libraries', 'banks', 'documents', 'historyCount'], path);
  const catalogRevision = expectString(r.catalogRevision, `${path}.catalogRevision`);
  rejectAbsolutePath(catalogRevision, `${path}.catalogRevision`);
  return {
    catalogRevision,
    domains: expectArray(r.domains, `${path}.domains`).map((v, i) => decodeDomainSummary(v, `${path}.domains[${i}]`)),
    libraries: expectArray(r.libraries, `${path}.libraries`).map((v, i) => decodeCatalogLibrary(v, `${path}.libraries[${i}]`)),
    banks: expectArray(r.banks, `${path}.banks`).map((v, i) => decodeCatalogBank(v, `${path}.banks[${i}]`)),
    documents: expectArray(r.documents, `${path}.documents`).map((v, i) => decodeCatalogDocumentSummary(v, `${path}.documents[${i}]`)),
    historyCount: expectNumber(r.historyCount, `${path}.historyCount`)
  };
}

export function decodeEditorCatalogSnapshot(value: unknown, path = 'EditorCatalogSnapshot'): EditorCatalogSnapshot {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['catalogRevision', 'libraries', 'banks', 'documents', 'history', 'projections'], path);
  return {
    catalogRevision: expectString(r.catalogRevision, `${path}.catalogRevision`),
    libraries: expectArray(r.libraries, `${path}.libraries`).map((v, i) => decodeCatalogLibrary(v, `${path}.libraries[${i}]`)),
    banks: expectArray(r.banks, `${path}.banks`).map((v, i) => decodeCatalogBank(v, `${path}.banks[${i}]`)),
    documents: expectArray(r.documents, `${path}.documents`).map((v, i) => decodeCatalogDocument(v, `${path}.documents[${i}]`)),
    history: expectArray(r.history, `${path}.history`).map((v, i) => decodePhysicalVariantRef(v, `${path}.history[${i}]`)),
    projections: expectArray(r.projections, `${path}.projections`).map((v, i) => {
      const pr = expectRecord(v, `${path}.projections[${i}]`);
      rejectUnknownFields(pr, ['projectionId', 'projectionKind', 'nativeResourceId', 'nativeSourceRevision', 'nativeSourceHash', 'provenanceDigest'], `${path}.projections[${i}]`);
      return {
        projectionId: expectString(pr.projectionId, `${path}.projections[${i}].projectionId`),
        projectionKind: expectEnum(valueOf(pr, 'projectionKind', path), ['source', 'text', 'json'], `${path}.projections[${i}].projectionKind`),
        nativeResourceId: expectString(pr.nativeResourceId, `${path}.projections[${i}].nativeResourceId`),
        nativeSourceRevision: expectString(pr.nativeSourceRevision, `${path}.projections[${i}].nativeSourceRevision`),
        nativeSourceHash: expectString(pr.nativeSourceHash, `${path}.projections[${i}].nativeSourceHash`),
        provenanceDigest: expectString(pr.provenanceDigest, `${path}.projections[${i}].provenanceDigest`)
      };
    })
  };
}

// --- §14.4 mutation IPC DTO decoders ---

export function decodeEditorScalar(value: unknown, path = 'EditorScalar'): EditorScalar {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail(path, `expected finite number`);
    return value as EditorScalar;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}[${i}]`, `expected number`);
    return v;
  });
  fail(path, `invalid EditorScalar`);
}

export function decodeTypedFieldChange(value: unknown, path = 'TypedFieldChange'): TypedFieldChange {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['fieldId', 'value'], path);
  const fieldId = expectString(r.fieldId, `${path}.fieldId`);
  rejectAbsolutePath(fieldId, `${path}.fieldId`);
  return { fieldId, value: decodeEditorScalar(r.value, `${path}.value`) };
}

const MUTATION_KINDS = [
  'param-field-set', 'param-row-upsert', 'param-row-delete', 'gparam-field-set',
  'fmg-entry-upsert', 'fmg-entry-delete', 'emevd-source-change', 'bnd4-child-replace',
  'script-plaintext-change', 'map-entity-upsert', 'map-entity-delete',
  'flver-material-slot-set', 'tpf-texture-replace', 'material-property-set',
  'vfx-field-set', 'behavior-transition-upsert', 'tae-event-upsert'
] as const;

export function decodeEditorMutation(value: unknown, path = 'EditorMutation'): EditorMutation {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), MUTATION_KINDS, `${path}.kind`);
  switch (kind) {
    case 'param-field-set': {
      rejectUnknownFields(r, ['kind', 'tableId', 'rowId', 'fieldId', 'value'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), rowId: expectStableId(r.rowId, `${path}.rowId`), fieldId: expectStableId(r.fieldId, `${path}.fieldId`), value: decodeEditorScalar(r.value, `${path}.value`) };
    }
    case 'param-row-upsert': {
      rejectUnknownFields(r, ['kind', 'tableId', 'rowId', 'fields'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), rowId: expectStableId(r.rowId, `${path}.rowId`), fields: expectArray(r.fields, `${path}.fields`).map((v, i) => decodeTypedFieldChange(v, `${path}.fields[${i}]`)) };
    }
    case 'param-row-delete': {
      rejectUnknownFields(r, ['kind', 'tableId', 'rowId'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), rowId: expectStableId(r.rowId, `${path}.rowId`) };
    }
    case 'gparam-field-set': {
      rejectUnknownFields(r, ['kind', 'bankId', 'groupId', 'fieldId', 'value'], path);
      return { kind, bankId: expectStableId(r.bankId, `${path}.bankId`), groupId: expectStableId(r.groupId, `${path}.groupId`), fieldId: expectStableId(r.fieldId, `${path}.fieldId`), value: decodeEditorScalar(r.value, `${path}.value`) };
    }
    case 'fmg-entry-upsert': {
      rejectUnknownFields(r, ['kind', 'tableId', 'entryId', 'text'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), entryId: expectStableId(r.entryId, `${path}.entryId`), text: expectString(r.text, `${path}.text`) };
    }
    case 'fmg-entry-delete': {
      rejectUnknownFields(r, ['kind', 'tableId', 'entryId'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), entryId: expectStableId(r.entryId, `${path}.entryId`) };
    }
    case 'emevd-source-change': {
      rejectUnknownFields(r, ['kind', 'sourceText'], path);
      return { kind, sourceText: expectString(r.sourceText, `${path}.sourceText`) };
    }
    case 'bnd4-child-replace': {
      rejectUnknownFields(r, ['kind', 'childStableId', 'stagedPayloadToken'], path);
      const stagedPayloadToken = expectString(r.stagedPayloadToken, `${path}.stagedPayloadToken`);
      rejectAbsolutePath(stagedPayloadToken, `${path}.stagedPayloadToken`);
      return { kind, childStableId: expectStableId(r.childStableId, `${path}.childStableId`), stagedPayloadToken };
    }
    case 'script-plaintext-change': {
      rejectUnknownFields(r, ['kind', 'childStableId', 'text', 'encoding', 'newline'], path);
      return {
        kind,
        childStableId: expectStableId(r.childStableId, `${path}.childStableId`),
        text: expectString(r.text, `${path}.text`),
        encoding: expectString(r.encoding, `${path}.encoding`),
        newline: expectEnum(valueOf(r, 'newline', path), ['crlf', 'lf', 'preserve'], `${path}.newline`)
      };
    }
    case 'map-entity-upsert': {
      rejectUnknownFields(r, ['kind', 'entityStableId', 'fields'], path);
      return { kind, entityStableId: expectStableId(r.entityStableId, `${path}.entityStableId`), fields: expectArray(r.fields, `${path}.fields`).map((v, i) => decodeTypedFieldChange(v, `${path}.fields[${i}]`)) };
    }
    case 'map-entity-delete': {
      rejectUnknownFields(r, ['kind', 'entityStableId'], path);
      return { kind, entityStableId: expectStableId(r.entityStableId, `${path}.entityStableId`) };
    }
    case 'flver-material-slot-set': {
      rejectUnknownFields(r, ['kind', 'meshStableId', 'slotIndex', 'materialStableId'], path);
      return { kind, meshStableId: expectStableId(r.meshStableId, `${path}.meshStableId`), slotIndex: expectNumber(r.slotIndex, `${path}.slotIndex`), materialStableId: expectStableId(r.materialStableId, `${path}.materialStableId`) };
    }
    case 'tpf-texture-replace': {
      rejectUnknownFields(r, ['kind', 'textureStableId', 'attachmentToken'], path);
      const attachmentToken = expectString(r.attachmentToken, `${path}.attachmentToken`);
      rejectAbsolutePath(attachmentToken, `${path}.attachmentToken`);
      return { kind, textureStableId: expectStableId(r.textureStableId, `${path}.textureStableId`), attachmentToken };
    }
    case 'material-property-set': {
      rejectUnknownFields(r, ['kind', 'propertyId', 'value'], path);
      return { kind, propertyId: expectStableId(r.propertyId, `${path}.propertyId`), value: decodeEditorScalar(r.value, `${path}.value`) };
    }
    case 'vfx-field-set': {
      rejectUnknownFields(r, ['kind', 'nodeStableId', 'fieldId', 'value'], path);
      return { kind, nodeStableId: expectStableId(r.nodeStableId, `${path}.nodeStableId`), fieldId: expectStableId(r.fieldId, `${path}.fieldId`), value: decodeEditorScalar(r.value, `${path}.value`) };
    }
    case 'behavior-transition-upsert': {
      rejectUnknownFields(r, ['kind', 'stateStableId', 'transitionStableId', 'fields'], path);
      return { kind, stateStableId: expectStableId(r.stateStableId, `${path}.stateStableId`), transitionStableId: expectStableId(r.transitionStableId, `${path}.transitionStableId`), fields: expectArray(r.fields, `${path}.fields`).map((v, i) => decodeTypedFieldChange(v, `${path}.fields[${i}]`)) };
    }
    case 'tae-event-upsert': {
      rejectUnknownFields(r, ['kind', 'animationStableId', 'eventStableId', 'fields'], path);
      return { kind, animationStableId: expectStableId(r.animationStableId, `${path}.animationStableId`), eventStableId: expectStableId(r.eventStableId, `${path}.eventStableId`), fields: expectArray(r.fields, `${path}.fields`).map((v, i) => decodeTypedFieldChange(v, `${path}.fields[${i}]`)) };
    }
  }
}

export function decodeOpenEditorDocumentRequest(value: unknown, path = 'OpenEditorDocumentRequest'): OpenEditorDocumentRequest {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['document'], path);
  return { document: decodeLogicalDocumentRef(r.document, `${path}.document`) };
}

export function decodeEditorPageQuery(value: unknown, path = 'EditorPageQuery'): EditorPageQuery {
  const r = expectRecord(value, path);
  const kind = expectEnum(
    valueOf(r, 'kind', path),
    ['param-tables', 'param-rows', 'param-fields', 'gparam-groups', 'gparam-fields', 'fmg-entries', 'event-outline', 'container-entries', 'script-symbols', 'resource-tree', 'properties'],
    `${path}.kind`
  );
  switch (kind) {
    case 'param-tables': {
      rejectUnknownFields(r, ['kind', 'search'], path);
      return { kind, search: expectString(r.search, `${path}.search`) };
    }
    case 'param-rows': {
      rejectUnknownFields(r, ['kind', 'tableId', 'search'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), search: expectString(r.search, `${path}.search`) };
    }
    case 'param-fields': {
      rejectUnknownFields(r, ['kind', 'tableId', 'rowId'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), rowId: expectStableId(r.rowId, `${path}.rowId`) };
    }
    case 'gparam-groups': {
      rejectUnknownFields(r, ['kind', 'bankId', 'search'], path);
      return { kind, bankId: expectStableId(r.bankId, `${path}.bankId`), search: expectString(r.search, `${path}.search`) };
    }
    case 'gparam-fields': {
      rejectUnknownFields(r, ['kind', 'bankId', 'groupId'], path);
      return { kind, bankId: expectStableId(r.bankId, `${path}.bankId`), groupId: expectStableId(r.groupId, `${path}.groupId`) };
    }
    case 'fmg-entries': {
      rejectUnknownFields(r, ['kind', 'tableId', 'search'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), search: expectString(r.search, `${path}.search`) };
    }
    case 'event-outline': {
      rejectUnknownFields(r, ['kind', 'search'], path);
      return { kind, search: expectString(r.search, `${path}.search`) };
    }
    case 'container-entries': {
      rejectUnknownFields(r, ['kind', 'parentStableId', 'search'], path);
      return { kind, parentStableId: r.parentStableId === null ? null : expectStableId(r.parentStableId, `${path}.parentStableId`), search: expectString(r.search, `${path}.search`) };
    }
    case 'script-symbols': {
      rejectUnknownFields(r, ['kind', 'search'], path);
      return { kind, search: expectString(r.search, `${path}.search`) };
    }
    case 'resource-tree': {
      rejectUnknownFields(r, ['kind', 'parentStableId', 'search'], path);
      return { kind, parentStableId: r.parentStableId === null ? null : expectStableId(r.parentStableId, `${path}.parentStableId`), search: expectString(r.search, `${path}.search`) };
    }
    case 'properties': {
      rejectUnknownFields(r, ['kind', 'targetStableId', 'groupId'], path);
      return { kind, targetStableId: expectStableId(r.targetStableId, `${path}.targetStableId`), groupId: r.groupId === null ? null : expectString(r.groupId, `${path}.groupId`) };
    }
  }
}

export function decodePageEditorDocumentRequest(value: unknown, path = 'PageEditorDocumentRequest'): PageEditorDocumentRequest {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['documentHandle', 'expectedRevision', 'query', 'cursor', 'limit'], path);
  const limit = expectNumber(r.limit, `${path}.limit`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail(`${path}.limit`, `limit must be integer 1..500`);
  const documentHandle = expectString(r.documentHandle, `${path}.documentHandle`);
  rejectAbsolutePath(documentHandle, `${path}.documentHandle`);
  return {
    documentHandle,
    expectedRevision: expectString(r.expectedRevision, `${path}.expectedRevision`),
    query: decodeEditorPageQuery(r.query, `${path}.query`),
    cursor: expectNullableString(r.cursor, `${path}.cursor`),
    limit
  };
}

export function decodeEditorContentQuery(value: unknown, path = 'EditorContentQuery'): EditorContentQuery {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), ['fmg-content', 'event-source', 'script-source', 'resource-preview'], `${path}.kind`);
  switch (kind) {
    case 'fmg-content': {
      rejectUnknownFields(r, ['kind', 'tableId', 'entryId'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), entryId: expectStableId(r.entryId, `${path}.entryId`) };
    }
    case 'event-source': {
      rejectUnknownFields(r, ['kind'], path);
      return { kind };
    }
    case 'script-source': {
      rejectUnknownFields(r, ['kind', 'childStableId'], path);
      return { kind, childStableId: expectStableId(r.childStableId, `${path}.childStableId`) };
    }
    case 'resource-preview': {
      rejectUnknownFields(r, ['kind', 'targetStableId'], path);
      return { kind, targetStableId: expectStableId(r.targetStableId, `${path}.targetStableId`) };
    }
  }
}

export function decodeReadEditorContentRequest(value: unknown, path = 'ReadEditorContentRequest'): ReadEditorContentRequest {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['documentHandle', 'expectedRevision', 'query'], path);
  const documentHandle = expectString(r.documentHandle, `${path}.documentHandle`);
  rejectAbsolutePath(documentHandle, `${path}.documentHandle`);
  return {
    documentHandle,
    expectedRevision: expectString(r.expectedRevision, `${path}.expectedRevision`),
    query: decodeEditorContentQuery(r.query, `${path}.query`)
  };
}

export function decodeApplyEditorMutationRequest(value: unknown, path = 'ApplyEditorMutationRequest'): ApplyEditorMutationRequest {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['documentHandle', 'expectedRevision', 'mutation'], path);
  const documentHandle = expectString(r.documentHandle, `${path}.documentHandle`);
  rejectAbsolutePath(documentHandle, `${path}.documentHandle`);
  return {
    documentHandle,
    expectedRevision: expectString(r.expectedRevision, `${path}.expectedRevision`),
    mutation: decodeEditorMutation(r.mutation, `${path}.mutation`)
  };
}

export function decodeEditorDocumentErrorCode(value: unknown, path = 'EditorDocumentErrorCode'): EditorDocumentErrorCode {
  return expectEnum(
    value,
    ['invalid-request', 'not-found', 'owner-mismatch', 'stale-revision', 'capability-blocked', 'runtime-blocked', 'native-open-failed', 'mutation-rejected', 'cancelled', 'expired'],
    path
  );
}

// --- §14.1 / §14.2 状态 decoder ---

export function decodeDocumentLoadState(value: unknown, path = 'DocumentLoadState'): DocumentLoadState {
  const r = expectRecord(value, path);
  const kind = expectEnum(
    valueOf(r, 'kind', path),
    ['idle', 'loading', 'ready', 'empty', 'no-match', 'partial', 'blocked', 'unsupported', 'error'],
    `${path}.kind`
  );
  switch (kind) {
    case 'idle': {
      rejectUnknownFields(r, ['kind'], path);
      return { kind };
    }
    case 'loading': {
      rejectUnknownFields(r, ['kind', 'phase'], path);
      return { kind, phase: expectEnum(
        valueOf(r, 'phase', path),
        ['catalog-resolve', 'locator-resolve', 'bridge-open', 'native-parse', 'document-store', 'first-page'],
        `${path}.phase`
      ) };
    }
    case 'ready': {
      rejectUnknownFields(r, ['kind'], path);
      return { kind };
    }
    case 'empty': {
      rejectUnknownFields(r, ['kind', 'reason'], path);
      return { kind, reason: expectEnum(valueOf(r, 'reason', path), ['true-empty'], `${path}.reason`) };
    }
    case 'no-match': {
      rejectUnknownFields(r, ['kind', 'query'], path);
      return { kind, query: expectString(r.query, `${path}.query`) };
    }
    case 'partial': {
      rejectUnknownFields(r, ['kind', 'reasonCode'], path);
      return { kind, reasonCode: decodeDocumentLoadReasonCode(r.reasonCode, `${path}.reasonCode`) };
    }
    case 'blocked': {
      rejectUnknownFields(r, ['kind', 'reasonCode', 'retryable'], path);
      return { kind, reasonCode: decodeDocumentLoadReasonCode(r.reasonCode, `${path}.reasonCode`), retryable: expectBoolean(r.retryable, `${path}.retryable`) };
    }
    case 'unsupported': {
      rejectUnknownFields(r, ['kind', 'reasonCode'], path);
      return { kind, reasonCode: decodeDocumentLoadReasonCode(r.reasonCode, `${path}.reasonCode`) };
    }
    case 'error': {
      rejectUnknownFields(r, ['kind', 'reasonCode', 'retryable'], path);
      return { kind, reasonCode: decodeDocumentLoadReasonCode(r.reasonCode, `${path}.reasonCode`), retryable: expectBoolean(r.retryable, `${path}.retryable`) };
    }
  }
}

export function decodeDocumentLoadReasonCode(value: unknown, path = 'DocumentLoadReasonCode'): DocumentLoadReasonCode {
  return expectEnum(
    value,
    [
      'document-not-found', 'history-only', 'bridge-runtime-unavailable',
      'compression-runtime-unavailable', 'native-format-unconfirmed',
      'native-parse-failed', 'partial-native-document', 'capability-blocked',
      'request-cancelled', 'request-expired', 'unknown-format'
    ],
    path
  );
}

export function decodeEditTransactionState(value: unknown, path = 'EditTransactionState'): EditTransactionState {
  const r = expectRecord(value, path);
  const kind = expectEnum(
    valueOf(r, 'kind', path),
    [
      'clean', 'dirty', 'staging', 'staged', 'awaiting-approval', 'committing',
      'verifying', 'committed', 'rolling-back', 'rolled-back', 'rollback-failed', 'failed'
    ],
    `${path}.kind`
  );
  switch (kind) {
    case 'clean': {
      rejectUnknownFields(r, ['kind'], path);
      return { kind };
    }
    case 'dirty': {
      rejectUnknownFields(r, ['kind', 'revision'], path);
      return { kind, revision: expectString(r.revision, `${path}.revision`) };
    }
    case 'staging':
    case 'staged':
    case 'awaiting-approval':
    case 'committing':
    case 'rolling-back': {
      rejectUnknownFields(r, ['kind', 'operationId'], path);
      return { kind, operationId: expectStableId(r.operationId, `${path}.operationId`) };
    }
    case 'verifying': {
      rejectUnknownFields(r, ['kind', 'operationId', 'phase'], path);
      return { kind, operationId: expectStableId(r.operationId, `${path}.operationId`), phase: expectString(r.phase, `${path}.phase`) };
    }
    case 'committed': {
      rejectUnknownFields(r, ['kind', 'operationId', 'committedRevision'], path);
      return { kind, operationId: expectStableId(r.operationId, `${path}.operationId`), committedRevision: expectString(r.committedRevision, `${path}.committedRevision`) };
    }
    case 'rolled-back': {
      rejectUnknownFields(r, ['kind', 'operationId', 'restoredRevision'], path);
      return { kind, operationId: expectStableId(r.operationId, `${path}.operationId`), restoredRevision: expectString(r.restoredRevision, `${path}.restoredRevision`) };
    }
    case 'rollback-failed': {
      rejectUnknownFields(r, ['kind', 'operationId', 'reasonCode'], path);
      return { kind, operationId: expectStableId(r.operationId, `${path}.operationId`), reasonCode: expectString(r.reasonCode, `${path}.reasonCode`) };
    }
    case 'failed': {
      rejectUnknownFields(r, ['kind', 'operationId', 'phase', 'reasonCode'], path);
      return { kind, operationId: expectStableId(r.operationId, `${path}.operationId`), phase: expectString(r.phase, `${path}.phase`), reasonCode: expectString(r.reasonCode, `${path}.reasonCode`) };
    }
  }
}

// --- §14.4 响应 DTO decoder ---

export function decodeOpenEditorDocumentValue(value: unknown, path = 'OpenEditorDocumentValue'): OpenEditorDocumentValue {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['documentHandle', 'revision', 'loadState', 'readOperations', 'writeOperations'], path);
  const documentHandle = expectString(r.documentHandle, `${path}.documentHandle`);
  rejectAbsolutePath(documentHandle, `${path}.documentHandle`);
  return {
    documentHandle,
    revision: expectString(r.revision, `${path}.revision`),
    loadState: decodeDocumentLoadState(r.loadState, `${path}.loadState`),
    readOperations: expectArray(r.readOperations, `${path}.readOperations`).map((v, i) => decodeReadOperationId(v, `${path}.readOperations[${i}]`)),
    writeOperations: expectArray(r.writeOperations, `${path}.writeOperations`).map((v, i) => decodeWriteOperationId(v, `${path}.writeOperations[${i}]`))
  };
}

export function decodeEditorDocumentPageValue(value: unknown, path = 'EditorDocumentPageValue'): EditorDocumentPageValue {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['documentHandle', 'revision', 'queryKind', 'items', 'nextCursor', 'totalKnown'], path);
  const documentHandle = expectString(r.documentHandle, `${path}.documentHandle`);
  rejectAbsolutePath(documentHandle, `${path}.documentHandle`);
  const queryKind = expectEnum(
    valueOf(r, 'queryKind', path),
    ['param-tables', 'param-rows', 'param-fields', 'gparam-groups', 'gparam-fields', 'fmg-entries', 'event-outline', 'container-entries', 'script-symbols', 'resource-tree', 'properties'],
    `${path}.queryKind`
  );
  const items = expectArray(r.items, `${path}.items`).map((v, i) => decodeEditorPageItemDto(v, `${path}.items[${i}]`, queryKind));
  return {
    documentHandle,
    revision: expectString(r.revision, `${path}.revision`),
    queryKind,
    items,
    nextCursor: expectNullableString(r.nextCursor, `${path}.nextCursor`),
    totalKnown: r.totalKnown === null ? null : expectNumber(r.totalKnown, `${path}.totalKnown`)
  };
}

export function decodeEditorPageItemDto(value: unknown, path: string, queryKind: EditorPageQuery['kind']): EditorPageItemDto {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), [
    'param-table', 'param-row', 'param-field', 'gparam-group', 'gparam-field',
    'fmg-entry', 'event-outline', 'container-entry', 'script-symbol', 'resource-node', 'property'
  ], `${path}.kind`);
  switch (kind) {
    case 'param-table': {
      if (queryKind !== 'param-tables') fail(path, `item kind "param-table" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'tableId', 'name', 'localizedName'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), name: expectString(r.name, `${path}.name`), localizedName: expectNullableString(r.localizedName, `${path}.localizedName`) };
    }
    case 'param-row': {
      if (queryKind !== 'param-rows') fail(path, `item kind "param-row" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'tableId', 'rowId', 'name', 'change'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), rowId: expectStableId(r.rowId, `${path}.rowId`), name: expectNullableString(r.name, `${path}.name`), change: expectEnum(valueOf(r, 'change', path), ['none', 'added', 'modified', 'deleted'], `${path}.change`) };
    }
    case 'param-field': {
      if (queryKind !== 'param-fields') fail(path, `item kind "param-field" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'tableId', 'rowId', 'fieldId', 'name', 'value', 'compareValue', 'enumLabel', 'valueType', 'description', 'editable'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), rowId: expectStableId(r.rowId, `${path}.rowId`), fieldId: expectStableId(r.fieldId, `${path}.fieldId`), name: expectString(r.name, `${path}.name`), value: decodeEditorScalar(r.value, `${path}.value`), compareValue: decodeEditorScalar(r.compareValue, `${path}.compareValue`), enumLabel: expectNullableString(r.enumLabel, `${path}.enumLabel`), valueType: expectString(r.valueType, `${path}.valueType`), description: expectNullableString(r.description, `${path}.description`), editable: expectBoolean(r.editable, `${path}.editable`) };
    }
    case 'gparam-group': {
      if (queryKind !== 'gparam-groups') fail(path, `item kind "gparam-group" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'bankId', 'groupId', 'name'], path);
      return { kind, bankId: expectStableId(r.bankId, `${path}.bankId`), groupId: expectStableId(r.groupId, `${path}.groupId`), name: expectString(r.name, `${path}.name`) };
    }
    case 'gparam-field': {
      if (queryKind !== 'gparam-fields') fail(path, `item kind "gparam-field" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'bankId', 'groupId', 'fieldId', 'name', 'value', 'compareValue', 'editable'], path);
      return { kind, bankId: expectStableId(r.bankId, `${path}.bankId`), groupId: expectStableId(r.groupId, `${path}.groupId`), fieldId: expectStableId(r.fieldId, `${path}.fieldId`), name: expectString(r.name, `${path}.name`), value: decodeEditorScalar(r.value, `${path}.value`), compareValue: decodeEditorScalar(r.compareValue, `${path}.compareValue`), editable: expectBoolean(r.editable, `${path}.editable`) };
    }
    case 'fmg-entry': {
      if (queryKind !== 'fmg-entries') fail(path, `item kind "fmg-entry" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'tableId', 'entryId', 'preview', 'change'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), entryId: expectStableId(r.entryId, `${path}.entryId`), preview: expectString(r.preview, `${path}.preview`), change: expectEnum(valueOf(r, 'change', path), ['none', 'added', 'modified', 'deleted'], `${path}.change`) };
    }
    case 'event-outline': {
      if (queryKind !== 'event-outline') fail(path, `item kind "event-outline" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'eventId', 'displayName', 'startLine', 'endLine'], path);
      return { kind, eventId: expectStableId(r.eventId, `${path}.eventId`), displayName: expectString(r.displayName, `${path}.displayName`), startLine: expectNumber(r.startLine, `${path}.startLine`), endLine: expectNumber(r.endLine, `${path}.endLine`) };
    }
    case 'container-entry': {
      if (queryKind !== 'container-entries') fail(path, `item kind "container-entry" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'stableId', 'name', 'formatId', 'byteLength', 'childCount'], path);
      return { kind, stableId: expectStableId(r.stableId, `${path}.stableId`), name: expectString(r.name, `${path}.name`), formatId: decodeNativeFormatId(r.formatId, `${path}.formatId`), byteLength: expectNumber(r.byteLength, `${path}.byteLength`), childCount: expectNumber(r.childCount, `${path}.childCount`) };
    }
    case 'script-symbol': {
      if (queryKind !== 'script-symbols') fail(path, `item kind "script-symbol" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'symbolId', 'name', 'symbolKind', 'line'], path);
      return { kind, symbolId: expectStableId(r.symbolId, `${path}.symbolId`), name: expectString(r.name, `${path}.name`), symbolKind: expectEnum(valueOf(r, 'symbolKind', path), ['function', 'variable', 'label'], `${path}.symbolKind`), line: expectNumber(r.line, `${path}.line`) };
    }
    case 'resource-node': {
      if (queryKind !== 'resource-tree') fail(path, `item kind "resource-node" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'stableId', 'parentStableId', 'label', 'nodeKind', 'hasChildren'], path);
      return { kind, stableId: expectStableId(r.stableId, `${path}.stableId`), parentStableId: r.parentStableId === null ? null : expectStableId(r.parentStableId, `${path}.parentStableId`), label: expectString(r.label, `${path}.label`), nodeKind: expectString(r.nodeKind, `${path}.nodeKind`), hasChildren: expectBoolean(r.hasChildren, `${path}.hasChildren`) };
    }
    case 'property': {
      if (queryKind !== 'properties') fail(path, `item kind "property" incompatible with query "${queryKind}"`);
      rejectUnknownFields(r, ['kind', 'targetStableId', 'groupId', 'propertyId', 'label', 'value', 'compareValue', 'editable'], path);
      return { kind, targetStableId: expectStableId(r.targetStableId, `${path}.targetStableId`), groupId: expectNullableString(r.groupId, `${path}.groupId`), propertyId: expectStableId(r.propertyId, `${path}.propertyId`), label: expectString(r.label, `${path}.label`), value: decodeEditorScalar(r.value, `${path}.value`), compareValue: decodeEditorScalar(r.compareValue, `${path}.compareValue`), editable: expectBoolean(r.editable, `${path}.editable`) };
    }
  }
}

export function decodeEditorContentValue(value: unknown, path = 'EditorContentValue'): EditorContentValue {
  const r = expectRecord(value, path);
  const kind = expectEnum(valueOf(r, 'kind', path), ['fmg-content', 'event-source', 'script-source', 'resource-preview'], `${path}.kind`);
  switch (kind) {
    case 'fmg-content': {
      rejectUnknownFields(r, ['kind', 'tableId', 'entryId', 'text'], path);
      return { kind, tableId: expectStableId(r.tableId, `${path}.tableId`), entryId: expectStableId(r.entryId, `${path}.entryId`), text: expectString(r.text, `${path}.text`) };
    }
    case 'event-source': {
      rejectUnknownFields(r, ['kind', 'sourceText', 'sourceDigest'], path);
      return { kind, sourceText: expectString(r.sourceText, `${path}.sourceText`), sourceDigest: expectString(r.sourceDigest, `${path}.sourceDigest`) };
    }
    case 'script-source': {
      rejectUnknownFields(r, ['kind', 'childStableId', 'text', 'editable', 'encoding', 'newline'], path);
      return { kind, childStableId: expectStableId(r.childStableId, `${path}.childStableId`), text: expectString(r.text, `${path}.text`), editable: expectBoolean(r.editable, `${path}.editable`), encoding: expectString(r.encoding, `${path}.encoding`), newline: expectEnum(valueOf(r, 'newline', path), ['crlf', 'lf', 'mixed'], `${path}.newline`) };
    }
    case 'resource-preview': {
      rejectUnknownFields(r, ['kind', 'targetStableId', 'previewToken', 'mediaType', 'byteLength'], path);
      const previewToken = expectString(r.previewToken, `${path}.previewToken`);
      rejectAbsolutePath(previewToken, `${path}.previewToken`);
      return { kind, targetStableId: expectStableId(r.targetStableId, `${path}.targetStableId`), previewToken, mediaType: expectString(r.mediaType, `${path}.mediaType`), byteLength: expectNumber(r.byteLength, `${path}.byteLength`) };
    }
  }
}

export function decodeApplyEditorMutationValue(value: unknown, path = 'ApplyEditorMutationValue'): ApplyEditorMutationValue {
  const r = expectRecord(value, path);
  rejectUnknownFields(r, ['documentHandle', 'revision', 'transactionState'], path);
  const documentHandle = expectString(r.documentHandle, `${path}.documentHandle`);
  rejectAbsolutePath(documentHandle, `${path}.documentHandle`);
  return {
    documentHandle,
    revision: expectString(r.revision, `${path}.revision`),
    transactionState: decodeEditTransactionState(r.transactionState, `${path}.transactionState`)
  };
}

export function decodeEditorDocumentResult(value: unknown, path = 'EditorDocumentResult'): EditorDocumentResult<unknown> {
  const r = expectRecord(value, path);
  const ok = expectBoolean(r.ok, `${path}.ok`);
  if (ok) {
    rejectUnknownFields(r, ['ok', 'value'], path);
    return { ok: true, value: r.value };
  }
  rejectUnknownFields(r, ['ok', 'code', 'retryable'], path);
  return { ok: false, code: decodeEditorDocumentErrorCode(r.code, `${path}.code`), retryable: expectBoolean(r.retryable, `${path}.retryable`) };
}
