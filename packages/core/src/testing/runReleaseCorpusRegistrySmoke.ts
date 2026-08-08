import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_CORPUS_GAMES,
  RELEASE_CORPUS_FORMATS,
  RELEASE_CORPUS_MAX_ENTRIES,
  RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT,
  RELEASE_CORPUS_OPERATIONS,
  RELEASE_CORPUS_PRIVACY_CLASSES,
  RELEASE_CORPUS_EXPECTED_AUTHORITIES,
  RELEASE_CORPUS_RESOURCE_KINDS,
  RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION,
  RELEASE_CORPUS_BRIDGE_ENVELOPE_VARIANTS,
  observedVariantToBridgeVariant,
  isBridgeEnvelopeVariant,
  validateReleaseCorpusRegistry
} from '../bridge/releaseCorpusRegistry.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const schemaPath = resolve(
  repoRoot,
  'packages/core/src/bridge/releaseCorpusRegistry.schema.json'
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  'x-constants'?: Record<string, unknown>;
  $defs?: Record<string, { enum?: string[] }>;
};
if (schema['x-constants'] === undefined) {
  throw new Error('frozen schema 缺少 x-constants 块；spec 权威不完整。');
}

const expectedObservedVariants = {
  DFLT: [
    'DCX_DFLT_10000_24_9',
    // 1.1.0 新增：游戏根语料实测 12 个文件（font/facegen/parts/shader）全部报此变体。
    // 四段写法 DCX_DFLT_10000_24_9 是历史残留；ClassifyVariant 产出五段。
    // 这份清单刻意独立于 TS 常量——它是「已人工审阅的 Bridge 边界」，
    // 变体扩张必须三处同步（schema / TS 常量 / 本清单），漂移即失败关闭。
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

if (JSON.stringify(RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT)
  !== JSON.stringify(expectedObservedVariants)) {
  throw new Error('release corpus observedVariant enum drifted from the reviewed Bridge boundary');
}

// frozen schema 同步门禁：TS 常量必须与 schema 的 x-constants 逐值一致，
// 且 schema 内部 $defs 闭集必须与 x-constants 一致（防单侧编辑）。
assertSchemaAndTsSync();

const positive = validateReleaseCorpusRegistry(buildValidManifest());
if (!positive.ok) {
  throw new Error(`valid release corpus manifest rejected: ${codes(positive)}`);
}
if (positive.nativeFormatAuthority !== false) {
  throw new Error('registry schema validation must never grant native format authority');
}
if (positive.classification.formatCounts.DFLT !== 1
  || positive.classification.formatCounts.BND4 !== 1
  || positive.classification.formatCounts.KRAK !== 1) {
  throw new Error('valid manifest classification counts are incomplete');
}

assertAllObservedVariantsAccepted();
assertSchemaVersionCompatWindow();

const shardBoundary = validateReleaseCorpusRegistry(buildShardBoundaryManifest());
if (!shardBoundary.ok) {
  throw new Error(`registry shard boundary was rejected: ${codes(shardBoundary)}`);
}
if (shardBoundary.nativeFormatAuthority !== false
  || Object.values(shardBoundary.classification.formatCounts)
    .reduce((sum, count) => sum + count, 0) !== RELEASE_CORPUS_MAX_ENTRIES) {
  throw new Error('registry shard boundary classification or authority is invalid');
}

const nativeAuthorityTarget = validateReleaseCorpusRegistry(
  mutateEntry(0, { expectedAuthority: 'native-verified' })
);
if (!nativeAuthorityTarget.ok || nativeAuthorityTarget.nativeFormatAuthority !== false) {
  throw new Error('expectedAuthority target escalated registry schema validation authority');
}

const negativeCases: Array<{
  name: string;
  input: unknown;
  expectedCode: string;
  sensitiveMarkers?: string[];
}> = [
  {
    name: 'unknown-format',
    input: mutateEntry(0, { format: 'EDGE' }),
    expectedCode: 'RELEASE_CORPUS_FORMAT_UNKNOWN'
  },
  {
    name: 'unknown-observed-variant',
    input: mutateEntry(0, { observedVariant: 'DCX_DFLT_UNKNOWN' }),
    expectedCode: 'RELEASE_CORPUS_OBSERVED_VARIANT_UNKNOWN'
  },
  {
    name: 'cross-format-observed-variant',
    input: mutateEntry(0, { observedVariant: 'DCX_KRAK_9' }),
    expectedCode: 'RELEASE_CORPUS_OBSERVED_VARIANT_UNKNOWN'
  },
  {
    name: 'duplicate-logical-id',
    input: mutateEntry(1, { logicalId: 'relb-entry-dflt-0001' }),
    expectedCode: 'RELEASE_CORPUS_LOGICAL_ID_DUPLICATE'
  },
  {
    name: 'duplicate-sha256',
    input: mutateEntry(1, { sha256: '1'.repeat(64) }),
    expectedCode: 'RELEASE_CORPUS_SHA256_DUPLICATE'
  },
  {
    name: 'missing-field',
    input: removeEntryField(0, 'observedVariant'),
    expectedCode: 'RELEASE_CORPUS_REQUIRED_FIELD_MISSING'
  },
  {
    name: 'entry-count-mismatch',
    input: mutateManifest({ entryCount: 2 }),
    expectedCode: 'RELEASE_CORPUS_ENTRY_COUNT_MISMATCH'
  },
  {
    name: 'declared-entry-limit-exceeded',
    input: mutateManifest({ entryCount: RELEASE_CORPUS_MAX_ENTRIES + 1 }),
    expectedCode: 'RELEASE_CORPUS_ENTRY_LIMIT_EXCEEDED'
  },
  {
    name: 'entry-array-limit-exceeded',
    input: buildOversizedManifest(),
    expectedCode: 'RELEASE_CORPUS_ENTRY_LIMIT_EXCEEDED'
  },
  {
    name: 'windows-absolute-path',
    input: mutateEntry(0, { containerChain: ['C:/Users/example/private/sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_REFERENCE_FORBIDDEN'
  },
  {
    name: 'posix-absolute-path',
    input: mutateEntry(0, { containerChain: ['/home/example/private/sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_REFERENCE_FORBIDDEN'
  },
  {
    name: 'windows-drive-relative-path',
    input: mutateEntry(0, { containerChain: ['C:private/sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_REFERENCE_FORBIDDEN'
  },
  {
    name: 'unc-path',
    input: mutateEntry(0, { containerChain: ['\\\\server\\share\\sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_REFERENCE_FORBIDDEN'
  },
  {
    name: 'uri-scheme',
    input: mutateEntry(0, { containerChain: ['https://example.invalid/sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_REFERENCE_FORBIDDEN'
  },
  {
    name: 'nested-uri-scheme',
    input: mutateEntry(0, { containerChain: ['opaque/https://example.invalid/sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_REFERENCE_FORBIDDEN'
  },
  {
    name: 'nested-drive-relative-path',
    input: mutateEntry(0, { containerChain: ['opaque/C:private/sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_REFERENCE_FORBIDDEN'
  },
  {
    name: 'forward-traversal',
    input: mutateEntry(0, { containerChain: ['opaque/../private/sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_CHAIN_INVALID'
  },
  {
    name: 'backslash-traversal',
    input: mutateEntry(0, { containerChain: ['opaque\\..\\private\\sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_CHAIN_INVALID'
  },
  {
    name: 'non-canonical-dot-segment',
    input: mutateEntry(0, { containerChain: ['opaque/./sample.dcx'] }),
    expectedCode: 'RELEASE_CORPUS_CONTAINER_CHAIN_INVALID'
  },
  {
    name: 'unknown-local-path-field',
    input: mutateEntry(0, { localPath: 'redacted/private/sample.dcx' }),
    expectedCode: 'RELEASE_CORPUS_UNKNOWN_FIELD'
  },
  {
    name: 'unknown-field-diagnostic-redaction',
    input: mutateEntry(0, { 'C:/Users/private-user/secret-sample.dcx': true }),
    expectedCode: 'RELEASE_CORPUS_UNKNOWN_FIELD',
    sensitiveMarkers: ['private-user', 'secret-sample.dcx']
  },
  {
    name: 'top-level-authority-masquerade',
    input: mutateManifest({ nativeFormatAuthority: true }),
    expectedCode: 'RELEASE_CORPUS_UNKNOWN_FIELD'
  },
  {
    name: 'fixture-authority-masquerade',
    input: mutateEntry(0, { expectedAuthority: 'fixture-confirmed' }),
    expectedCode: 'RELEASE_CORPUS_FIXTURE_MASQUERADE_FORBIDDEN'
  },
  {
    name: 'fixture-privacy-masquerade',
    input: mutateEntry(0, { privacyClass: 'synthetic-fixture' }),
    expectedCode: 'RELEASE_CORPUS_FIXTURE_MASQUERADE_FORBIDDEN'
  },
  {
    name: 'unknown-operation',
    input: mutateEntry(0, { permittedOperations: ['classify', 'overwrite-original'] }),
    expectedCode: 'RELEASE_CORPUS_OPERATION_UNKNOWN'
  },
  {
    name: 'missing-format-coverage',
    input: removeEntry(2),
    expectedCode: 'RELEASE_CORPUS_FORMAT_COVERAGE_MISSING'
  },
  // schemaVersion 可读性的三条拒绝方向。spec §3 只允许「同 MAJOR 且不高于当前」，
  // 更高版本可能携带本实现不认识的枚举值，放行等于静默接受未知约束。
  {
    name: 'schema-version-higher-minor',
    input: mutateManifest({ schemaVersion: '1.2.0' }),
    expectedCode: 'RELEASE_CORPUS_SCHEMA_VERSION_UNSUPPORTED'
  },
  {
    name: 'schema-version-higher-patch',
    input: mutateManifest({ schemaVersion: '1.1.1' }),
    expectedCode: 'RELEASE_CORPUS_SCHEMA_VERSION_UNSUPPORTED'
  },
  {
    name: 'schema-version-different-major',
    input: mutateManifest({ schemaVersion: '2.0.0' }),
    expectedCode: 'RELEASE_CORPUS_SCHEMA_VERSION_UNSUPPORTED'
  },
  {
    name: 'schema-version-malformed',
    input: mutateManifest({ schemaVersion: '1.1' }),
    expectedCode: 'RELEASE_CORPUS_SCHEMA_VERSION_UNSUPPORTED'
  }
];

const rejected = negativeCases.map((testCase) => {
  const result = validateReleaseCorpusRegistry(testCase.input);
  if (result.ok) throw new Error(`${testCase.name} unexpectedly passed`);
  if (result.nativeFormatAuthority !== false) {
    throw new Error(`${testCase.name} rejection escalated native authority`);
  }
  if (!result.diagnostics.some((diagnostic) => diagnostic.code === testCase.expectedCode)) {
    throw new Error(`${testCase.name} missing ${testCase.expectedCode}: ${codes(result)}`);
  }
  assertStructuredDiagnostics(result.diagnostics, testCase.name);
  const serialized = JSON.stringify(result);
  if (serialized.includes('sample.dcx')) {
    throw new Error(`${testCase.name} leaked a path or URI in diagnostics`);
  }
  for (const marker of testCase.sensitiveMarkers ?? []) {
    if (serialized.includes(marker)) {
      throw new Error(`${testCase.name} leaked sensitive input in diagnostics`);
    }
  }
  return { name: testCase.name, code: testCase.expectedCode };
});

console.log(JSON.stringify({
  ok: true,
  status: 'fixture-confirmed',
  nativeFormatAuthority: false,
  message: 'REL-B release corpus registry schema/classification harness passed on metadata-only synthetic manifests.',
  positive: positive.classification,
  rejected
}, null, 2));

function buildValidManifest(): Record<string, unknown> {
  return {
    registryId: 'relb-registry-20260725',
    game: 'sekiro',
    gameBuild: '1.6',
    schemaVersion: '1.0.0',
    createdAt: '2026-07-25T00:00:00Z',
    entryCount: 3,
    entries: [
      {
        logicalId: 'relb-entry-dflt-0001',
        sha256: '1'.repeat(64),
        size: 4096,
        containerChain: ['opaque-dcx-a'],
        resourceKind: 'event',
        format: 'DFLT',
        observedVariant: 'DCX_DFLT_11000_44_9_0',
        permittedOperations: [
          'classify',
          'read',
          'no-op-roundtrip',
          'repack',
          'reread',
          'preserve-unknown-fields'
        ],
        expectedAuthority: 'unverified',
        privacyClass: 'private-game-asset'
      },
      {
        logicalId: 'relb-entry-bnd4-0001',
        sha256: '2'.repeat(64),
        size: 8192,
        containerChain: ['opaque-dcx-a', 'opaque-bnd4-a'],
        resourceKind: 'chr',
        format: 'BND4',
        observedVariant: 'BND4_40_24',
        permittedOperations: [
          'classify',
          'read',
          'no-op-roundtrip',
          'mutate',
          'repack',
          'reread',
          'preserve-unknown-fields'
        ],
        expectedAuthority: 'unverified',
        privacyClass: 'private-game-asset'
      },
      {
        logicalId: 'relb-entry-krak-0001',
        sha256: '3'.repeat(64),
        size: 16384,
        containerChain: ['opaque-dcx-b'],
        resourceKind: 'map',
        format: 'KRAK',
        observedVariant: 'DCX_KRAK_11000_44_6_0',
        permittedOperations: ['classify', 'read', 'reread', 'preserve-unknown-fields'],
        expectedAuthority: 'unverified',
        privacyClass: 'private-game-asset'
      }
    ]
  };
}

function mutateEntry(index: number, patch: Record<string, unknown>): Record<string, unknown> {
  const manifest = buildValidManifest();
  const entries = manifest.entries as Array<Record<string, unknown>>;
  entries[index] = { ...entries[index], ...patch };
  return manifest;
}

function mutateManifest(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...buildValidManifest(), ...patch };
}

function buildOversizedManifest(): Record<string, unknown> {
  const manifest = buildValidManifest();
  const entries = manifest.entries as Array<Record<string, unknown>>;
  manifest.entries = Array.from(
    { length: RELEASE_CORPUS_MAX_ENTRIES + 1 },
    () => entries[0]
  );
  manifest.entryCount = RELEASE_CORPUS_MAX_ENTRIES + 1;
  return manifest;
}

function buildShardBoundaryManifest(): Record<string, unknown> {
  const manifest = buildValidManifest();
  const templates = manifest.entries as Array<Record<string, unknown>>;
  manifest.entries = Array.from({ length: RELEASE_CORPUS_MAX_ENTRIES }, (_, index) => {
    const ordinal = index + 1;
    const suffix = ordinal.toString().padStart(5, '0');
    return {
      ...templates[index % templates.length],
      logicalId: `relb-entry-${suffix}`,
      sha256: ordinal.toString(16).padStart(64, '0'),
      containerChain: [`opaque-container-${suffix}`]
    };
  });
  manifest.entryCount = RELEASE_CORPUS_MAX_ENTRIES;
  return manifest;
}

function assertAllObservedVariantsAccepted(): void {
  const entryIndexByFormat = { DFLT: 0, BND4: 1, KRAK: 2 } as const;
  for (const format of Object.keys(expectedObservedVariants) as Array<keyof typeof expectedObservedVariants>) {
    for (const observedVariant of expectedObservedVariants[format]) {
      const result = validateReleaseCorpusRegistry(
        mutateEntry(entryIndexByFormat[format], { observedVariant })
      );
      if (!result.ok) {
        throw new Error(`${format}/${observedVariant} was rejected: ${codes(result)}`);
      }
      if (result.nativeFormatAuthority !== false) {
        throw new Error(`${format}/${observedVariant} escalated native authority`);
      }
    }
  }
}

/**
 * schemaVersion 兼容窗口的**正向**判据（拒绝方向在 negativeCases 里）。
 *
 * spec §3 对 MINOR 的定义是兼容扩展：「旧 schemaVersion 的 registry 仍可被读，
 * 但新 registry 必须写新版本号」。两个方向都必须钉住，而且是**同一次提升**里
 * 最容易做反的一对：
 *  - 只守「恰等于当前值」→ 纯新增枚举的兼容扩展会把全部既有 registry 判成
 *    UNSUPPORTED，那是 MAJOR 语义（1.1.0 提升时实测发生过）；
 *  - 只守「同 MAJOR 就放行」→ 更高 MINOR 携带的未知枚举被静默接受。
 *
 * 判据从 RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION 推导而不是硬编码版本字面量：
 * 下次提升到 1.2.0 时这里自动跟随，不会变成一条只对 1.1.0 成立的死判据。
 */
function assertSchemaVersionCompatWindow(): void {
  const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION);
  if (current === null) {
    throw new Error(
      `RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION 不是 MAJOR.MINOR.PATCH：${RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION}`
    );
  }
  const major = Number(current[1]);
  const minor = Number(current[2]);
  const patch = Number(current[3]);

  const readable: string[] = [RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION];
  // 同 MAJOR 的每一个更低 MINOR，以及当前 MINOR 的每一个更低 PATCH，都必须仍可读。
  for (let m = 0; m < minor; m += 1) readable.push(`${major}.${m}.0`);
  for (let p = 0; p < patch; p += 1) readable.push(`${major}.${minor}.${p}`);

  for (const version of readable) {
    const result = validateReleaseCorpusRegistry(mutateManifest({ schemaVersion: version }));
    if (!result.ok) {
      throw new Error(
        `schemaVersion ${version} 应当仍可读（spec §3 MINOR 兼容扩展），实际被拒：${codes(result)}`
      );
    }
    if (result.nativeFormatAuthority !== false) {
      throw new Error(`schemaVersion ${version} escalated native authority`);
    }
  }

  // 兼容窗口本身必须非空且真的覆盖到「比当前低」的版本——否则当 MINOR/PATCH 都为 0
  // 时这个函数会退化成只测当前值一条，读起来像有覆盖而实际没有。
  if (readable.length < 2) {
    throw new Error(
      'schemaVersion 兼容窗口只含当前版本，无法证明旧版本仍可读；'
      + '若当前是首个版本（x.0.0），本判据应改为在提升后启用而不是留空转。'
    );
  }
}

/**
 * Frozen schema 同步门禁。
 *
 * (1) TS 常量与 schema `x-constants` 逐值一致——这是「冻结规格」的落点：schema
 * 是机器可读权威，TS 是它的同步投影，单侧编辑即失败关闭。
 * (2) schema 内部 `$defs` 闭集与 `x-constants` 一致——防止同一文件内部两份枚举漂移。
 * (3) observedVariant ↔ Bridge variant 约定自洽：DFLT/KRAK 全部符合 `DCX_` 前缀
 * 且去前缀后非空、无重复；BND4 恰为 `BND4_40_24`；推导出的 Bridge 信封闭集
 * 与逐值换算结果一致。
 */
function assertSchemaAndTsSync(): void {
  const x = schema['x-constants'] as {
    schemaVersion: string;
    maxEntries: number;
    games: readonly string[];
    formats: readonly string[];
    observedVariantsByFormat: Record<string, readonly string[]>;
    operations: readonly string[];
    privacyClasses: readonly string[];
    expectedAuthorities: readonly string[];
    resourceKinds: readonly string[];
  };
  const assertDeepEqual = (label: string, actual: unknown, expected: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`TS 常量与 frozen schema x-constants 漂移（${label}）：${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
  };

  assertDeepEqual('schemaVersion', RELEASE_CORPUS_REGISTRY_SCHEMA_VERSION, x.schemaVersion);
  assertDeepEqual('maxEntries', RELEASE_CORPUS_MAX_ENTRIES, x.maxEntries);
  assertDeepEqual('games', RELEASE_CORPUS_GAMES, x.games);
  assertDeepEqual('formats', RELEASE_CORPUS_FORMATS, x.formats);
  assertDeepEqual('observedVariantsByFormat', RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT, x.observedVariantsByFormat);
  assertDeepEqual('operations', RELEASE_CORPUS_OPERATIONS, x.operations);
  assertDeepEqual('privacyClasses', RELEASE_CORPUS_PRIVACY_CLASSES, x.privacyClasses);
  assertDeepEqual('expectedAuthorities', RELEASE_CORPUS_EXPECTED_AUTHORITIES, x.expectedAuthorities);
  assertDeepEqual('resourceKinds', RELEASE_CORPUS_RESOURCE_KINDS, x.resourceKinds);

  // schema 内部 $defs 闭集与 x-constants 一致。
  const defs = schema.$defs ?? {};
  const defEnum = (name: string): readonly string[] | undefined => defs[name]?.enum;
  assertDeepEqual('$defs.dfltObservedVariant', defEnum('dfltObservedVariant'), x.observedVariantsByFormat.DFLT);
  assertDeepEqual('$defs.bnd4ObservedVariant', defEnum('bnd4ObservedVariant'), x.observedVariantsByFormat.BND4);
  assertDeepEqual('$defs.krakObservedVariant', defEnum('krakObservedVariant'), x.observedVariantsByFormat.KRAK);
  assertDeepEqual('$defs.game', defEnum('game'), x.games);
  assertDeepEqual('$defs.format', defEnum('format'), x.formats);
  assertDeepEqual('$defs.operation', defEnum('operation'), x.operations);
  assertDeepEqual('$defs.privacyClass', defEnum('privacyClass'), x.privacyClasses);
  assertDeepEqual('$defs.expectedAuthority', defEnum('expectedAuthority'), x.expectedAuthorities);
  assertDeepEqual('$defs.resourceKind', defEnum('resourceKind'), x.resourceKinds);

  // observedVariant ↔ Bridge variant 约定自洽。
  const seenBridgeVariants = new Set<string>();
  for (const format of RELEASE_CORPUS_FORMATS) {
    for (const observedVariant of RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT[format]) {
      const bridgeVariant = observedVariantToBridgeVariant(format, observedVariant);
      if (format === 'BND4') {
        if (observedVariant !== 'BND4_40_24') {
          throw new Error(`BND4 observedVariant 约定破损：${observedVariant}`);
        }
        if (bridgeVariant !== null) {
          throw new Error(`BND4 observedVariant 不应映射到 DCX 信封变体：${observedVariant} -> ${bridgeVariant}`);
        }
        continue;
      }
      if (bridgeVariant === null || bridgeVariant.length === 0) {
        throw new Error(`${format}/${observedVariant} 不满足 DCX_ 前缀约定`);
      }
      if (seenBridgeVariants.has(bridgeVariant)) {
        throw new Error(`Bridge 信封变体重复：${bridgeVariant}`);
      }
      seenBridgeVariants.add(bridgeVariant);
    }
  }
  if (JSON.stringify([...RELEASE_CORPUS_BRIDGE_ENVELOPE_VARIANTS].sort())
    !== JSON.stringify([...seenBridgeVariants].sort())) {
    throw new Error('RELEASE_CORPUS_BRIDGE_ENVELOPE_VARIANTS 与逐值换算结果不一致');
  }
  for (const bridgeVariant of seenBridgeVariants) {
    if (!isBridgeEnvelopeVariant(bridgeVariant)) {
      throw new Error(`isBridgeEnvelopeVariant 未识别已冻结信封变体：${bridgeVariant}`);
    }
  }
  // 负向：确证 isBridgeEnvelopeVariant 对未冻结变体失败关闭。
  if (isBridgeEnvelopeVariant('DFLT_99999_99_9')) {
    throw new Error('isBridgeEnvelopeVariant 放过了未冻结信封变体 DFLT_99999_99_9');
  }
}

function assertStructuredDiagnostics(
  diagnostics: Array<{ severity: string; code: string; path: string; message: string }>,
  caseName: string
): void {  if (diagnostics.length === 0) throw new Error(`${caseName} returned no diagnostics`);
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== 'error'
      || diagnostic.code.length === 0
      || diagnostic.path.length === 0
      || diagnostic.message.length === 0) {
      throw new Error(`${caseName} returned a malformed structured diagnostic`);
    }
  }
}

function removeEntryField(index: number, field: string): Record<string, unknown> {
  const manifest = buildValidManifest();
  const entries = manifest.entries as Array<Record<string, unknown>>;
  delete entries[index]![field];
  return manifest;
}

function removeEntry(index: number): Record<string, unknown> {
  const manifest = buildValidManifest();
  const entries = manifest.entries as Array<Record<string, unknown>>;
  entries.splice(index, 1);
  manifest.entryCount = entries.length;
  return manifest;
}

function codes(result: { diagnostics: Array<{ code: string }> }): string {
  return result.diagnostics.map((diagnostic) => diagnostic.code).join(', ');
}
