/**
 * Metadata-only registry contract for the REL-B release corpus.
 *
 * The registry never contains sample bytes or local paths. Validation only
 * proves that metadata is classifiable; it does not grant native authority.
 */

export const RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION = '1.1.0' as const;

/**
 * registry 的 schemaVersion 是否可被本实现读取。
 *
 * 规则（spec §3）：同 MAJOR 且 MINOR/PATCH 不超过当前版本即可读。
 * 同一 MAJOR 内的提升都是兼容扩展（新增枚举、放宽约束、新增可选字段），
 * 所以旧 registry 必须继续合法；而来自**更高**版本的 registry 要拒绝，
 * 因为它可能携带本实现不认识的枚举值，放行等于静默接受未知约束。
 */
export function isReadableSchemaVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const parse = (text: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const got = parse(version);
  const current = parse(RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION);
  if (got === null || current === null) return false;
  if (got[0] !== current[0]) return false;
  if (got[1] !== current[1]) return got[1] < current[1];
  return got[2] <= current[2];
}
/** Maximum entry count for one registry shard. Larger corpora must be split out of repo. */
export const RELEASE_CORPUS_MAX_ENTRIES = 10_000;
export const RELEASE_CORPUS_GAMES = ['sekiro'] as const;
export const RELEASE_CORPUS_FORMATS = ['DFLT', 'BND4', 'KRAK'] as const;
export const RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT = {
  DFLT: [
    'DCX_DFLT_10000_24_9',
    'DCX_DFLT_10000_24_9_0',
    'DCX_DFLT_10000_44_9',
    'DCX_DFLT_10000_44_9_0',
    'DCX_DFLT_11000_44_8',
    'DCX_DFLT_11000_44_9',
    'DCX_DFLT_11000_44_9_0',
    'DCX_DFLT_11000_44_9_15'
  ],
  BND4: ['BND4_40_24'],
  KRAK: ['DCX_KRAK_6', 'DCX_KRAK_9', 'DCX_KRAK_11000_44_6_0']
} as const;
/**
 * Frozen machine-readable spec authority: packages/core/src/bridge/releaseCorpusRegistry.schema.json.
 * The constants below must match the schema's `x-constants` block value-for-value;
 * test:release-corpus-registry enforces that sync gate. Changing an enum here without
 * bumping the schema (or vice versa) fails closed.
 */
export const RELEASE_CORPUS_OPERATIONS = [
  'classify',
  'read',
  'no-op-roundtrip',
  'mutate',
  'repack',
  'reread',
  'preserve-unknown-fields'
] as const;
export const RELEASE_CORPUS_PRIVACY_CLASSES = [
  'private-game-asset',
  'private-user-mod',
  'public-redistributable'
] as const;
export const RELEASE_CORPUS_EXPECTED_AUTHORITIES = [
  'unsupported',
  'candidate',
  'partial',
  'native-verified',
  'unverified'
] as const;
export const RELEASE_CORPUS_RESOURCE_KINDS = [
  'event',
  'map',
  'param',
  'msg',
  'menu',
  'script',
  'action',
  'ai',
  'sfx',
  'chr',
  'obj',
  'other'
] as const;

/**
 * Bridge `read-dcx-document` `data.variant` 输出的冻结闭集，由 observedVariant
 * 闭集按约定（DFLT/KRAK 去掉 `DCX_` 前缀）推导。native 对账门禁用它判定任何
 * Bridge 输出的信封变体都必须是已冻结分类，未识别变体即失败关闭。
 */
export const RELEASE_CORPUS_BRIDGE_ENVELOPE_VARIANTS: readonly string[] = [
  ...RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT.DFLT.map((variant) => variant.slice('DCX_'.length)),
  ...RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT.KRAK.map((variant) => variant.slice('DCX_'.length))
];

/**
 * registry `observedVariant` → Bridge `data.variant`（DCX 信封变体）。
 * `BND4` 的 `observedVariant`（`BND4_40_24`）来自内嵌 BND4 header 布局而非 DCX
 * 信封，没有对应的 envelope variant，返回 null。
 */
export function observedVariantToBridgeVariant(
  format: ReleaseCorpusFormat,
  observedVariant: ReleaseCorpusObservedVariant
): string | null {
  if (format === 'BND4') return null;
  if (!observedVariant.startsWith('DCX_')) return null;
  return observedVariant.slice('DCX_'.length);
}

/** Bridge 信封变体是否属于已冻结闭集（native 对账门禁的判定函数）。 */
export function isBridgeEnvelopeVariant(bridgeVariant: string): boolean {
  return RELEASE_CORPUS_BRIDGE_ENVELOPE_VARIANTS.includes(bridgeVariant);
}

export type ReleaseCorpusGame = (typeof RELEASE_CORPUS_GAMES)[number];
export type ReleaseCorpusFormat = (typeof RELEASE_CORPUS_FORMATS)[number];
export type ReleaseCorpusObservedVariant =
  (typeof RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT)[ReleaseCorpusFormat][number];
export type ReleaseCorpusOperation = (typeof RELEASE_CORPUS_OPERATIONS)[number];
export type ReleaseCorpusPrivacyClass = (typeof RELEASE_CORPUS_PRIVACY_CLASSES)[number];
export type ReleaseCorpusExpectedAuthority =
  (typeof RELEASE_CORPUS_EXPECTED_AUTHORITIES)[number];
export type ReleaseCorpusResourceKind = (typeof RELEASE_CORPUS_RESOURCE_KINDS)[number];

export interface ReleaseCorpusRegistryEntry {
  /** Opaque, redacted identity. It must not be a filesystem path. */
  logicalId: string;
  sha256: string;
  size: number;
  /** Relative in-game logical identifiers only; never local filesystem paths. */
  containerChain: string[];
  resourceKind: ReleaseCorpusResourceKind;
  format: ReleaseCorpusFormat;
  /** Closed observed variant enum matching the current Bridge classification boundary. */
  observedVariant: ReleaseCorpusObservedVariant;
  permittedOperations: ReleaseCorpusOperation[];
  /** Requested validation target, not authority granted by this registry. */
  expectedAuthority: ReleaseCorpusExpectedAuthority;
  privacyClass: ReleaseCorpusPrivacyClass;
}

export interface ReleaseCorpusRegistry {
  registryId: string;
  game: ReleaseCorpusGame;
  gameBuild: string;
  schemaVersion: typeof RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION;
  createdAt: string;
  entryCount: number;
  entries: ReleaseCorpusRegistryEntry[];
}

export interface ReleaseCorpusRegistryDiagnostic {
  severity: 'error';
  code: string;
  path: string;
  message: string;
}

export interface ReleaseCorpusClassificationSummary {
  formatCounts: Record<ReleaseCorpusFormat, number>;
  observedVariantCounts: Record<string, number>;
}

export type ReleaseCorpusRegistryValidation =
  | {
      ok: true;
      status: 'schema-valid';
      nativeFormatAuthority: false;
      registry: ReleaseCorpusRegistry;
      classification: ReleaseCorpusClassificationSummary;
      diagnostics: [];
    }
  | {
      ok: false;
      status: 'rejected';
      nativeFormatAuthority: false;
      classification: ReleaseCorpusClassificationSummary;
      diagnostics: ReleaseCorpusRegistryDiagnostic[];
    };

const REGISTRY_KEYS = new Set([
  'registryId',
  'game',
  'gameBuild',
  'schemaVersion',
  'createdAt',
  'entryCount',
  'entries'
]);const ENTRY_KEYS = new Set([
  'logicalId',
  'sha256',
  'size',
  'containerChain',
  'resourceKind',
  'format',
  'observedVariant',
  'permittedOperations',
  'expectedAuthority',
  'privacyClass'
]);
const FIXTURE_MARKER = /(?:^|[._-])(fixture|synthetic|mock)(?:$|[._-])/i;
const OPAQUE_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const GAME_BUILD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOGICAL_CHAIN_ITEM = /^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,255}$/;

export function validateReleaseCorpusRegistry(input: unknown): ReleaseCorpusRegistryValidation {
  const diagnostics: ReleaseCorpusRegistryDiagnostic[] = [];
  const classification = emptyClassification();

  if (!isRecord(input)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_REGISTRY_NOT_OBJECT',
      '$',
      'Release corpus registry 必须是 JSON object。'
    );
    return rejected(classification, diagnostics);
  }

  rejectUnknownKeys(input, REGISTRY_KEYS, '$', diagnostics);
  requireKeys(input, REGISTRY_KEYS, '$', diagnostics);

  validateOpaqueIdentity(input.registryId, '$.registryId', diagnostics);
  if (typeof input.registryId === 'string' && FIXTURE_MARKER.test(input.registryId)) {
    addFixtureDiagnostic(diagnostics, '$.registryId');
  }

  if (!isOneOf(input.game, RELEASE_CORPUS_GAMES)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_GAME_UNSUPPORTED',
      '$.game',
      'game 不属于已冻结枚举。'
    );
  }
  if (typeof input.gameBuild !== 'string' || !GAME_BUILD.test(input.gameBuild)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_GAME_BUILD_INVALID',
      '$.gameBuild',
      'gameBuild 必须是短、稳定且不含路径的 build 标识。'
    );
  } else if (FIXTURE_MARKER.test(input.gameBuild)) {
    addFixtureDiagnostic(diagnostics, '$.gameBuild');
  }
  // 兼容读取：接受当前 MAJOR 内的历史版本，拒绝其它。
  //
  // spec §3 对 MINOR 的定义写明「旧 schemaVersion 的 registry **仍可被读**，
  // 但新 registry 必须写新版本号」。原实现只接受 RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION
  // 一个值，于是 1.0.0 → 1.1.0 这次纯新增枚举的兼容扩展会把全部既有 registry
  // 判成 RELEASE_CORPUS_SCHEMA_VERSION_UNSUPPORTED ——那是 MAJOR 语义，不是 MINOR。
  // 实测：提升版本号后 test:release-corpus-registry 立刻以该码拒绝了它自己的
  // 合法样例 manifest。
  //
  // 判据改为「同 MAJOR 且 MINOR/PATCH 不超过当前」：同一 MAJOR 内向后兼容，
  // 而来自更高版本的 registry 仍然拒绝（它可能含本实现不认识的枚举值，
  // 放行等于静默接受未知约束）。
  if (!isReadableSchemaVersion(input.schemaVersion)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_SCHEMA_VERSION_UNSUPPORTED',
      '$.schemaVersion',
      `schemaVersion 必须是与 ${RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION} 同 MAJOR 且不高于它的版本。`
    );
  }
  if (!isRfc3339(input.createdAt)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_CREATED_AT_INVALID',
      '$.createdAt',
      'createdAt 必须是带时区的 RFC 3339 时间。'
    );
  }

  const entryCountIsValid = Number.isSafeInteger(input.entryCount)
    && (input.entryCount as number) > 0;
  if (!entryCountIsValid) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_ENTRY_COUNT_INVALID',
      '$.entryCount',
      'entryCount 必须是正的安全整数。'
    );
  } else if ((input.entryCount as number) > RELEASE_CORPUS_MAX_ENTRIES) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_ENTRY_LIMIT_EXCEEDED',
      '$.entryCount',
      `单个 registry shard 最多允许 ${RELEASE_CORPUS_MAX_ENTRIES} 条 entry。`
    );
  }

  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_ENTRIES_INVALID',
      '$.entries',
      'entries 必须是非空数组。'
    );
  } else {
    if (entryCountIsValid && input.entryCount !== input.entries.length) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_ENTRY_COUNT_MISMATCH',
        '$.entryCount',
        'entryCount 必须严格等于 entries.length。'
      );
    }
    if (input.entries.length > RELEASE_CORPUS_MAX_ENTRIES) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_ENTRY_LIMIT_EXCEEDED',
        '$.entries',
        `单个 registry shard 最多允许 ${RELEASE_CORPUS_MAX_ENTRIES} 条 entry；超出时必须分片。`
      );
    } else {
      const logicalIds = new Set<string>();
      const hashes = new Set<string>();
      input.entries.forEach((entry, index) => {
        validateEntry(entry, index, diagnostics, classification, logicalIds, hashes);
      });
      for (const format of RELEASE_CORPUS_FORMATS) {
        if (classification.formatCounts[format] === 0) {
          addDiagnostic(
            diagnostics,
            'RELEASE_CORPUS_FORMAT_COVERAGE_MISSING',
            '$.entries',
            `registry 必须包含 ${format} 分类。`
          );
        }
      }
    }
  }

  if (diagnostics.length > 0) return rejected(classification, diagnostics);
  return {
    ok: true,
    status: 'schema-valid',
    nativeFormatAuthority: false,
    registry: input as unknown as ReleaseCorpusRegistry,
    classification,
    diagnostics: []
  };
}

function validateEntry(
  input: unknown,
  index: number,
  diagnostics: ReleaseCorpusRegistryDiagnostic[],
  classification: ReleaseCorpusClassificationSummary,
  logicalIds: Set<string>,
  hashes: Set<string>
): void {
  const path = `$.entries[${index}]`;
  if (!isRecord(input)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_ENTRY_NOT_OBJECT',
      path,
      'entry 必须是 JSON object。'
    );
    return;
  }

  rejectUnknownKeys(input, ENTRY_KEYS, path, diagnostics);
  requireKeys(input, ENTRY_KEYS, path, diagnostics);

  validateOpaqueIdentity(input.logicalId, `${path}.logicalId`, diagnostics);
  if (typeof input.logicalId === 'string') {
    if (FIXTURE_MARKER.test(input.logicalId)) addFixtureDiagnostic(diagnostics, `${path}.logicalId`);
    if (logicalIds.has(input.logicalId)) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_LOGICAL_ID_DUPLICATE',
        `${path}.logicalId`,
        'logicalId 必须在 registry 内唯一。'
      );
    } else {
      logicalIds.add(input.logicalId);
    }
  }

  if (typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_SHA256_INVALID',
      `${path}.sha256`,
      'sha256 必须是小写 64 位十六进制摘要。'
    );
  } else if (hashes.has(input.sha256)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_SHA256_DUPLICATE',
      `${path}.sha256`,
      'sha256 必须在 registry 内唯一。'
    );
  } else {
    hashes.add(input.sha256);
  }

  if (!Number.isSafeInteger(input.size) || (input.size as number) <= 0) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_SIZE_INVALID',
      `${path}.size`,
      'size 必须是正的安全整数。'
    );
  }

  validateContainerChain(input.containerChain, `${path}.containerChain`, diagnostics);

  if (!isOneOf(input.resourceKind, RELEASE_CORPUS_RESOURCE_KINDS)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_RESOURCE_KIND_UNKNOWN',
      `${path}.resourceKind`,
      'resourceKind 不属于已冻结枚举。'
    );
  }

  const format = isOneOf(input.format, RELEASE_CORPUS_FORMATS) ? input.format : undefined;
  if (format === undefined) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_FORMAT_UNKNOWN',
      `${path}.format`,
      'format 只允许 DFLT、BND4 或 KRAK。'
    );
  } else {
    classification.formatCounts[format] += 1;
  }

  if (format === undefined || !isObservedVariantForFormat(input.observedVariant, format)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_OBSERVED_VARIANT_UNKNOWN',
      `${path}.observedVariant`,
      'observedVariant 不属于对应 format 的已冻结 Bridge 分类枚举。'
    );
  } else {
    classification.observedVariantCounts[input.observedVariant]
      = (classification.observedVariantCounts[input.observedVariant] ?? 0) + 1;
  }

  validateOperations(input.permittedOperations, `${path}.permittedOperations`, diagnostics);

  if (input.expectedAuthority === 'fixture-confirmed') {
    addFixtureDiagnostic(diagnostics, `${path}.expectedAuthority`);
  } else if (!isOneOf(input.expectedAuthority, RELEASE_CORPUS_EXPECTED_AUTHORITIES)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_EXPECTED_AUTHORITY_UNKNOWN',
      `${path}.expectedAuthority`,
      'expectedAuthority 不属于 release corpus 允许的 authority 枚举。'
    );
  }

  if (input.privacyClass === 'synthetic-fixture') {
    addFixtureDiagnostic(diagnostics, `${path}.privacyClass`);
  } else if (!isOneOf(input.privacyClass, RELEASE_CORPUS_PRIVACY_CLASSES)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_PRIVACY_CLASS_UNKNOWN',
      `${path}.privacyClass`,
      'privacyClass 不属于已冻结枚举。'
    );
  }
}

function validateContainerChain(
  input: unknown,
  path: string,
  diagnostics: ReleaseCorpusRegistryDiagnostic[]
): void {
  if (!Array.isArray(input) || input.length === 0) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_CONTAINER_CHAIN_INVALID',
      path,
      'containerChain 必须是非空的相对逻辑标识数组。'
    );
    return;
  }
  const seen = new Set<string>();
  input.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item === 'string' && looksLikeForbiddenPathOrUri(item)) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_CONTAINER_REFERENCE_FORBIDDEN',
        itemPath,
        'containerChain 禁止包含绝对路径、drive-relative 路径、UNC 或 URI scheme。'
      );
    }
    if (typeof item !== 'string'
      || !LOGICAL_CHAIN_ITEM.test(item)
      || hasNonCanonicalPathSegment(item)) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_CONTAINER_CHAIN_INVALID',
        itemPath,
        'containerChain 元素必须是规范化的相对逻辑标识。'
      );
      return;
    }
    if (seen.has(item)) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_CONTAINER_CHAIN_DUPLICATE',
        itemPath,
        'containerChain 不得包含重复元素。'
      );
    } else {
      seen.add(item);
    }
  });
}

function validateOperations(
  input: unknown,
  path: string,
  diagnostics: ReleaseCorpusRegistryDiagnostic[]
): void {
  if (!Array.isArray(input) || input.length === 0) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_OPERATIONS_INVALID',
      path,
      'permittedOperations 必须是非空数组。'
    );
    return;
  }
  const seen = new Set<string>();
  let hasClassify = false;
  input.forEach((operation, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isOneOf(operation, RELEASE_CORPUS_OPERATIONS)) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_OPERATION_UNKNOWN',
        itemPath,
        'permitted operation 不属于已冻结枚举。'
      );
      return;
    }
    if (operation === 'classify') hasClassify = true;
    if (seen.has(operation)) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_OPERATION_DUPLICATE',
        itemPath,
        'permittedOperations 不得重复。'
      );
    } else {
      seen.add(operation);
    }
  });
  if (!hasClassify) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_CLASSIFY_OPERATION_REQUIRED',
      path,
      '每个 release corpus entry 都必须允许 classify。'
    );
  }
}

function validateOpaqueIdentity(
  input: unknown,
  path: string,
  diagnostics: ReleaseCorpusRegistryDiagnostic[]
): void {
  if (typeof input !== 'string' || !OPAQUE_ID.test(input) || looksLikeForbiddenPathOrUri(input)) {
    addDiagnostic(
      diagnostics,
      'RELEASE_CORPUS_IDENTITY_INVALID',
      path,
      'identity 必须是脱敏、无路径的稳定标识。'
    );
  }
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: ReleaseCorpusRegistryDiagnostic[]
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_UNKNOWN_FIELD',
        `${path}.[unknown-field]`,
        'registry 包含未知字段，已失败关闭。'
      );
    }
  }
}

function requireKeys(
  input: Record<string, unknown>,
  required: ReadonlySet<string>,
  path: string,
  diagnostics: ReleaseCorpusRegistryDiagnostic[]
): void {
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      addDiagnostic(
        diagnostics,
        'RELEASE_CORPUS_REQUIRED_FIELD_MISSING',
        `${path}.${key}`,
        'registry 缺少必填字段。'
      );
    }
  }
}

function isObservedVariantForFormat(
  input: unknown,
  format: ReleaseCorpusFormat
): input is ReleaseCorpusObservedVariant {
  return typeof input === 'string'
    && (RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT[format] as readonly string[]).includes(input);
}

function isOneOf<const T extends readonly string[]>(input: unknown, allowed: T): input is T[number] {
  return typeof input === 'string' && (allowed as readonly string[]).includes(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isRfc3339(input: unknown): input is string {
  return typeof input === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)
    && !Number.isNaN(Date.parse(input));
}

function looksLikeForbiddenPathOrUri(input: string): boolean {
  const normalized = input.replaceAll('\\', '/');
  return normalized.startsWith('/')
    || /(?:^|\/)[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized);
}

function hasNonCanonicalPathSegment(input: string): boolean {
  return input.replaceAll('\\', '/').split('/').some((segment) => segment === ''
    || segment === '.'
    || segment === '..');
}

function emptyClassification(): ReleaseCorpusClassificationSummary {
  return {
    formatCounts: { DFLT: 0, BND4: 0, KRAK: 0 },
    observedVariantCounts: {}
  };
}

function rejected(
  classification: ReleaseCorpusClassificationSummary,
  diagnostics: ReleaseCorpusRegistryDiagnostic[]
): ReleaseCorpusRegistryValidation {
  return {
    ok: false,
    status: 'rejected',
    nativeFormatAuthority: false,
    classification,
    diagnostics
  };
}

function addFixtureDiagnostic(
  diagnostics: ReleaseCorpusRegistryDiagnostic[],
  path: string
): void {
  addDiagnostic(
    diagnostics,
    'RELEASE_CORPUS_FIXTURE_MASQUERADE_FORBIDDEN',
    path,
    'synthetic/fixture 元数据不得冒充 release corpus。'
  );
}

function addDiagnostic(
  diagnostics: ReleaseCorpusRegistryDiagnostic[],
  code: string,
  path: string,
  message: string
): void {
  diagnostics.push({ severity: 'error', code, path, message });
}
