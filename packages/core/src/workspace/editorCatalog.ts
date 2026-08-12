/**
 * CAT-05: EditorCatalog builder（§4.3 识别优先级 + §4.4 固定注册表）。
 *
 * 本模块只解释 packages/shared/src/editor-catalog.ts 的注册表
 * （ARTIFACT_ROLE_RULES / RESOURCE_CLASSIFICATION_RULES），不得另建自由分支：
 *
 *   1000 artifact role → history / projection / hidden（不再进入普通领域）
 *    900 Bridge-confirmed leaf → catalog 文档
 *    800 confirmed container child → 投影文档（与容器文档共存）
 *    600 compound suffix → Files candidate
 *    300 path hint / 0 Files fallback
 *
 * 输入：物理索引 + artifact 标记（scanner 产出）+ Bridge-confirmed 格式栈
 * （调用方 probe）+ projection manifest（调用方解析 sidecar）+ capability
 * 快照（调用方提供）。本模块不调用 renderer helper。
 *
 * overlay 与 base 是同一逻辑资源的 source variants：按 relativePath 合并为
 * 一个 CatalogDocument，effective variant 先比较 sourceLayer（overlay 高于
 * base，history 永不成为 effective），再比较 precedence；同层同 precedence
 * 但 hash 不同 → conflict，禁止按扫描顺序取最后一个。
 */

import type {
  ArtifactRole,
  CatalogBank,
  CatalogDocument,
  CatalogLibrary,
  ConfirmedFormatStack,
  ContainerRole,
  DomainSummary,
  EditorCatalogSnapshot,
  EditorCatalogSummary,
  EditorDomainId,
  LogicalDocumentRef,
  OperationCapability,
  PhysicalVariantRef,
  ProjectionRef,
  RecognitionState,
  ResourceClassificationRule
} from '@soulforge/shared';
import {
  ARTIFACT_ROLE_RULES,
  RESOURCE_CLASSIFICATION_RULES
} from '@soulforge/shared';
import type { IndexedFile } from '@soulforge/shared';

export interface ProjectionManifest {
  readonly nativeResourceId: string;
  readonly nativeSourceRevision: string;
  readonly nativeSourceHash: string;
  readonly provenanceDigest: string;
}

export interface BuildEditorCatalogInput {
  readonly files: readonly IndexedFile[];
  /** Bridge-confirmed 格式栈，key = sourceUri（overlay 物理文件）。 */
  readonly confirmedStacks?: ReadonlyMap<string, ConfirmedFormatStack>;
  /** projection sidecar 的 manifest，key = sidecar sourceUri。 */
  readonly projectionManifests?: ReadonlyMap<string, ProjectionManifest>;
  /** 已登记 recovery 关联（operation log 等权威来源），key = 备份文件 sourceUri。 */
  readonly registeredRecoveries?: ReadonlyMap<string, string>;
  /** 读能力快照，key = sourceUri；缺省按 read-contract-missing blocked（不伪造）。 */
  readonly capabilitySnapshot?: ReadonlyMap<string, OperationCapability>;
  readonly catalogRevision?: string;
}

interface ClassifiedFile {
  readonly file: IndexedFile;
  readonly role: ArtifactRole;
  readonly decision:
    | { kind: 'history'; recoveryOfResourceId: string }
    | { kind: 'projection'; manifest: ProjectionManifest }
    | { kind: 'hidden' }
    | { kind: 'files'; reasonCode: string }
    | { kind: 'catalog'; domain: EditorDomainId; integrationId: string; libraryKey: string; stack: ConfirmedFormatStack; semanticSubtype?: string };
}

const LIBRARY_LABELS: Record<string, string> = {
  'game-parameters': 'Game Parameters',
  'draw-graphics-parameters': 'Draw / Graphics Parameters',
  'drawparam-containers': 'DrawParam Containers',
  'drawparam-tables': 'DrawParam Tables',
  'loose-parameters': 'Loose Parameters',
  'game-text': 'Game Text',
  'loose-text': 'Loose Text',
  events: 'Events',
  maps: 'Maps',
  scripts: 'Scripts',
  'loose-scripts': 'Loose Scripts',
  containers: 'Containers',
  textures: 'Textures',
  materials: 'Materials',
  effects: 'Effects',
  behaviors: 'Behaviors',
  animations: 'Animations',
  models: 'Models'
};

const DOMAIN_LABELS: Record<EditorDomainId, string> = {
  project: 'Project',
  param: 'PARAM',
  gparam: 'GPARAM',
  text: 'Text',
  event: 'Event',
  map: 'Map',
  script: 'Script',
  behavior: 'Behavior',
  animation: 'Animation',
  model: 'Model',
  texture: 'Texture',
  material: 'Material',
  vfx: 'VFX',
  container: 'Container',
  files: 'Files'
};

/** 相对路径（去掉层与 artifact 后缀后的逻辑键）。 */
function logicalResourceKey(relativePath: string): string {
  return relativePath.replaceAll('\\', '/').toLowerCase();
}

/** 从备份名推导 primary：`gameparam.parambnd.dcx.bak` → `gameparam.parambnd.dcx`。 */
function primaryKeyFromBackup(relativePath: string): string {
  const lower = logicalResourceKey(relativePath);
  for (const suffix of ['.bak', '.prev']) {
    if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length);
  }
  return lower;
}

/** §4.4 规则要求 semanticSubtype 时由文件名推导（游戏惯例名，不单独确认格式）。 */
function deriveSemanticSubtype(file: IndexedFile, stack: ConfirmedFormatStack): string | undefined {
  const lower = logicalResourceKey(file.relativePath);
  if (stack.containerRole === 'gameparam-binder' && lower.startsWith('gameparam')) {
    return 'gameparam-primary';
  }
  if (stack.leafFormatId === 'gparam') return 'map-bank';
  return undefined;
}

function ruleMatchesStack(rule: ResourceClassificationRule, stack: ConfirmedFormatStack, file: IndexedFile): boolean {
  const matcher = rule.matcher;
  if (matcher.kind !== 'confirmed-leaf') return false;
  if (matcher.formatId !== stack.leafFormatId && !(matcher.formatId === 'bnd4' && stack.leafFormatId === 'bnd4')) {
    return false;
  }
  if (matcher.containerRole !== undefined && matcher.containerRole !== stack.containerRole) return false;
  if (matcher.semanticSubtype !== undefined && matcher.semanticSubtype !== deriveSemanticSubtype(file, stack)) {
    return false;
  }
  return true;
}

const CONFIRMED_CHILD_RULES: ReadonlyArray<{
  readonly parentRole: ContainerRole;
  readonly formatId: string;
  readonly domain: EditorDomainId;
  readonly integrationId: string;
  readonly libraryKey: string;
}> = [
  { parentRole: 'drawparam-binder', formatId: 'param', domain: 'param', integrationId: 'param-editor', libraryKey: 'drawparam-tables' },
  { parentRole: 'drawparam-binder', formatId: 'gparam', domain: 'gparam', integrationId: 'gparam-editor', libraryKey: 'draw-graphics-parameters' },
  { parentRole: 'msg-binder', formatId: 'fmg', domain: 'text', integrationId: 'text-editor', libraryKey: 'game-text' },
  { parentRole: 'script-binder', formatId: 'lua-source', domain: 'script', integrationId: 'script-editor', libraryKey: 'scripts' }
];

/** 调用方解析 sidecar manifest 后传入；缺 manifest 的 projection 标记不产生关联。 */
function matchProjectionManifest(
  file: IndexedFile,
  manifests: ReadonlyMap<string, ProjectionManifest> | undefined
): ProjectionManifest | null {
  const manifest = manifests?.get(file.sourceUri);
  if (!manifest) return null;
  // §4.3：只有 sidecar 内记录的 native identity 与 provenance digest 与
  // primary 一致时才关联。digest 由 scanner 标记（projectionProvenanceDigest），
  // 与 manifest 记录不一致 → 拒绝关联，绝不形成第二个普通文档。
  if (file.artifactMarkers?.projectionProvenanceDigest
    && manifest.provenanceDigest !== file.artifactMarkers.projectionProvenanceDigest) {
    return null;
  }
  return manifest;
}

/** effective variant：sourceLayer overlay > base；同层按 precedence；同层同 precedence 不同 hash → conflict。 */
function compareVariants(a: { sourceLayer: 'overlay' | 'base'; precedence: number; hash: string | null }, b: { sourceLayer: 'overlay' | 'base'; precedence: number; hash: string | null }): number {
  if (a.sourceLayer !== b.sourceLayer) return a.sourceLayer === 'overlay' ? -1 : 1;
  if (a.precedence !== b.precedence) return b.precedence - a.precedence;
  return 0;
}

export function buildEditorCatalog(input: BuildEditorCatalogInput): EditorCatalogSnapshot {
  const confirmedStacks = input.confirmedStacks ?? new Map();
  const manifests = input.projectionManifests ?? new Map();
  const recoveries = input.registeredRecoveries ?? new Map();
  const capabilities = input.capabilitySnapshot ?? new Map();
  const revision = input.catalogRevision ?? `catalog:${Date.now()}`;

  const libraries = new Map<string, CatalogLibrary>();
  const banks = new Map<string, CatalogBank>();
  const documents: CatalogDocument[] = [];
  const history: PhysicalVariantRef[] = [];
  const projections: ProjectionRef[] = [];

  // ── 物理 → 分类 ──
  const classified: ClassifiedFile[] = [];
  for (const file of input.files) {
    const markers = file.artifactMarkers;
    const role: ArtifactRole = markers?.artifactRole ?? 'primary';

    // 1000：artifact role 决定 history/projection/hidden，不能再进入普通领域。
    if (role === 'backup' || role === 'previous' || role === 'recovery') {
      const recoveryOfResourceId = recoveries.get(file.sourceUri) ?? primaryKeyFromBackup(file.relativePath);
      classified.push({ file, role, decision: { kind: 'history', recoveryOfResourceId } });
      continue;
    }
    if (role === 'projection') {
      const manifest = matchProjectionManifest(file, manifests);
      if (!manifest) {
        classified.push({ file, role, decision: { kind: 'files', reasonCode: 'projection-manifest-missing' } });
        continue;
      }
      classified.push({ file, role, decision: { kind: 'projection', manifest } });
      continue;
    }
    if (role === 'cache' || role === 'audit' || role === 'temporary') {
      classified.push({ file, role, decision: { kind: 'hidden' } });
      continue;
    }

    // 900：Bridge-confirmed leaf。
    const stack = confirmedStacks.get(file.sourceUri);
    if (stack) {
      const rule = RESOURCE_CLASSIFICATION_RULES.find(
        (candidate) => candidate.priority === 900 && ruleMatchesStack(candidate, stack, file)
      );
      if (rule && rule.decision.kind === 'catalog') {
        const semanticSubtype = deriveSemanticSubtype(file, stack);
        classified.push({
          file,
          role,
          decision: {
            kind: 'catalog',
            domain: rule.decision.domain,
            integrationId: rule.decision.integrationId,
            libraryKey: rule.decision.libraryKey,
            stack,
            ...(semanticSubtype ? { semanticSubtype } : {})
          }
        });
        continue;
      }
      // confirmed 但无 900 规则命中（如 generic-binder）→ container 域。
      if (stack.containerRole === 'generic-binder' || stack.leafFormatId === 'bnd4') {
        classified.push({
          file,
          role,
          decision: {
            kind: 'catalog',
            domain: 'container',
            integrationId: 'container-editor',
            libraryKey: stack.containerRole === 'generic-binder' ? 'containers' : 'drawparam-containers',
            stack
          }
        });
        continue;
      }
      classified.push({ file, role, decision: { kind: 'files', reasonCode: 'bridge-confirmation-required' } });
      continue;
    }

    // 600/300/0：suffix/path 只构成 candidate，留在 Files。
    const suffixRule = RESOURCE_CLASSIFICATION_RULES.find(
      (candidate) => candidate.priority === 600
        && candidate.matcher.kind === 'compound-suffix'
        && logicalResourceKey(file.relativePath).endsWith(candidate.matcher.suffix)
    );
    classified.push({
      file,
      role,
      decision: { kind: 'files', reasonCode: suffixRule && suffixRule.decision.kind === 'files' ? suffixRule.decision.reasonCode : 'unrecognized-format' }
    });
  }

  // ── projection：只输出，不成为普通文档 ──
  for (const entry of classified) {
    if (entry.decision.kind !== 'projection') continue;
    const manifest = entry.decision.manifest;
    projections.push({
      projectionId: `projection:${entry.file.sourceUri}`,
      projectionKind: entry.file.compoundExtension.endsWith('.js') ? 'source' : 'json',
      nativeResourceId: manifest.nativeResourceId,
      nativeSourceRevision: manifest.nativeSourceRevision,
      nativeSourceHash: manifest.nativeSourceHash,
      provenanceDigest: manifest.provenanceDigest
    });
  }

  // ── history：物理变体引用 ──
  for (const entry of classified) {
    if (entry.decision.kind !== 'history') continue;
    const role = entry.role;
    if (role !== 'backup' && role !== 'previous' && role !== 'recovery') continue;
    history.push({
      variantId: `variant:${entry.file.sourceUri}`,
      role,
      sourceLayer: 'history',
      precedence: 0,
      contentHash: entry.file.sha256 ?? null,
      sourceRevision: entry.file.mtimeMs.toString(),
      provenanceDigest: null,
      recoveryOfResourceId: entry.decision.recoveryOfResourceId
    });
  }

  // ── catalog 文档 + overlay/base effective variant 合并 ──
  const byLogicalKey = new Map<string, Array<{ entry: ClassifiedFile; stack: ConfirmedFormatStack }>>();
  for (const entry of classified) {
    if (entry.decision.kind !== 'catalog') continue;
    const key = logicalResourceKey(entry.file.relativePath);
    const group = byLogicalKey.get(key) ?? [];
    group.push({ entry, stack: entry.decision.stack });
    byLogicalKey.set(key, group);
  }

  for (const [key, group] of byLogicalKey) {
    // effective variant：overlay > base；同层同 precedence 不同 hash → conflict。
    const sorted = [...group].sort((a, b) => compareVariants(
      { sourceLayer: a.entry.file.artifactMarkers?.sourceLayer ?? 'overlay', precedence: a.entry.role === 'base' ? 0 : 100, hash: a.entry.file.sha256 ?? null },
      { sourceLayer: b.entry.file.artifactMarkers?.sourceLayer ?? 'overlay', precedence: b.entry.role === 'base' ? 0 : 100, hash: b.entry.file.sha256 ?? null }
    ));
    const effective = sorted[0]!;
    const effectiveLayer = effective.entry.file.artifactMarkers?.sourceLayer ?? 'overlay';
    const sameLayerSamePrecedence = group.filter((candidate) =>
      (candidate.entry.file.artifactMarkers?.sourceLayer ?? 'overlay') === effectiveLayer
      && (candidate.entry.role === 'base' ? 0 : 100) === (effective.entry.role === 'base' ? 0 : 100)
    );
    const conflicting = sameLayerSamePrecedence.filter((candidate) =>
      candidate.entry.file.sha256 && effective.entry.file.sha256 && candidate.entry.file.sha256 !== effective.entry.file.sha256
    );

    const decision = effective.entry.decision;
    if (decision.kind !== 'catalog') continue;
    const libraryId = `${decision.domain}:${decision.libraryKey}`;
    const logicalId = `logical:${key}`;

    const recognition: RecognitionState = conflicting.length > 0
      ? { kind: 'conflict', confirmedStackIds: conflicting.map((candidate) => candidate.stack.stackId) }
      : { kind: 'confirmed', stack: decision.stack };

    const capability = capabilities.get(effective.entry.file.sourceUri) ?? {
      read: { kind: 'blocked' as const, reasonCode: 'read-contract-missing' as const, missing: ['D3', 'D4', 'D5', 'D6'] as const },
      write: { kind: 'unavailable' as const, reasonCode: 'write-contract-missing' as const }
    };

    const ref: LogicalDocumentRef = {
      resourceId: effective.entry.file.sourceUri,
      domain: decision.domain,
      libraryId,
      bankId: null,
      documentId: logicalId,
      sourceVariant: effectiveLayer
    };

    documents.push({
      ref,
      label: effective.entry.file.relativePath.split('/').pop() ?? effective.entry.file.relativePath,
      recognition,
      capability,
      effectiveVariant: {
        variantId: `variant:${effective.entry.file.sourceUri}`,
        role: effective.entry.role === 'base' ? 'base' : 'primary',
        sourceLayer: effectiveLayer,
        precedence: effective.entry.role === 'base' ? 0 : 100,
        contentHash: effective.entry.file.sha256 ?? null,
        sourceRevision: effective.entry.file.mtimeMs.toString(),
        provenanceDigest: null,
        recoveryOfResourceId: null
      },
      alternateVariantIds: sorted.slice(1).map((candidate) => `variant:${candidate.entry.file.sourceUri}`)
    });

    // 库 / 银行登记（readonly 字段一律重建，不 push/赋值）
    const existing = libraries.get(libraryId);
    if (decision.domain === 'gparam' && decision.libraryKey === 'draw-graphics-parameters') {
      // 每个实测 GParam 一个 bank。
      const bankId = `${libraryId}:bank:${key}`;
      const bankRegistered = banks.get(bankId);
      if (!bankRegistered) {
        banks.set(bankId, {
          bankId,
          libraryId,
          label: effective.entry.file.relativePath.split('/').pop() ?? key,
          semanticKey: key,
          languageId: null,
          containerKind: null,
          documentIds: [logicalId]
        });
      }
      if (!existing) {
        libraries.set(libraryId, {
          libraryId,
          domain: decision.domain,
          label: LIBRARY_LABELS[decision.libraryKey] ?? decision.libraryKey,
          bankIds: [bankId],
          documentIds: [],
          counts: { banks: banks.size }
        });
      } else {
        libraries.set(libraryId, {
          ...existing,
          bankIds: existing.bankIds.includes(bankId) ? existing.bankIds : [...existing.bankIds, bankId],
          counts: { ...existing.counts, banks: existing.bankIds.length + (existing.bankIds.includes(bankId) ? 0 : 1) }
        });
      }
    } else {
      if (!existing) {
        libraries.set(libraryId, {
          libraryId,
          domain: decision.domain,
          label: LIBRARY_LABELS[decision.libraryKey] ?? decision.libraryKey,
          bankIds: [],
          documentIds: [logicalId],
          counts: { tables: 1 }
        });
      } else {
        libraries.set(libraryId, {
          ...existing,
          documentIds: existing.documentIds.includes(logicalId) ? existing.documentIds : [...existing.documentIds, logicalId],
          counts: { ...existing.counts, tables: existing.documentIds.length + (existing.documentIds.includes(logicalId) ? 0 : 1) }
        });
      }
    }
  }

  const snapshot: EditorCatalogSnapshot = {
    catalogRevision: revision,
    libraries: [...libraries.values()],
    banks: [...banks.values()],
    documents,
    history,
    projections
  };
  return snapshot;
}

export function buildEditorCatalogSummary(snapshot: EditorCatalogSnapshot): EditorCatalogSummary {
  const domains = new Map<EditorDomainId, DomainSummary>();
  for (const document of snapshot.documents) {
    if (domains.has(document.ref.domain)) continue;
    domains.set(document.ref.domain, {
      domain: document.ref.domain,
      label: DOMAIN_LABELS[document.ref.domain] ?? document.ref.domain,
      visibility: 'visible',
      capability: 'read-ready',
      defaultTarget: document.ref
    });
  }
  return {
    catalogRevision: snapshot.catalogRevision,
    domains: [...domains.values()],
    libraries: snapshot.libraries,
    banks: snapshot.banks,
    documents: snapshot.documents.map((document) => ({
      ref: document.ref,
      label: document.label,
      recognition: document.recognition,
      capability: document.capability,
      effectiveVariantId: document.effectiveVariant.variantId
    })),
    historyCount: snapshot.history.length
  };
}

/** 已确认 stack 的 child 层投影（§4.3 800：confirmed container child 与容器文档共存）。 */
export function collectConfirmedChildProjections(
  stack: ConfirmedFormatStack
): Array<{ childStableId: string; formatId: string; parentRole: ContainerRole }> {
  const children: Array<{ childStableId: string; formatId: string; parentRole: ContainerRole }> = [];
  for (const layer of stack.layers) {
    if (layer.childStableId === null) continue;
    const rule = CONFIRMED_CHILD_RULES.find(
      (candidate) => candidate.parentRole === stack.containerRole && candidate.formatId === layer.formatId
    );
    if (!rule) continue;
    children.push({ childStableId: layer.childStableId, formatId: layer.formatId, parentRole: stack.containerRole });
  }
  return children;
}
