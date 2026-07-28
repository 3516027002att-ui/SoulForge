import {
  RELEASE_CORPUS_MAX_ENTRIES,
  RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT,
  validateReleaseCorpusRegistry
} from '../bridge/releaseCorpusRegistry.js';

const expectedObservedVariants = {
  DFLT: [
    'DCX_DFLT_10000_24_9',
    'DCX_DFLT_10000_44_9',
    'DCX_DFLT_11000_44_8',
    'DCX_DFLT_11000_44_9',
    'DCX_DFLT_11000_44_9_15'
  ],
  BND4: ['BND4_40_24'],
  KRAK: ['DCX_KRAK_6', 'DCX_KRAK_9']
} as const;

if (JSON.stringify(RELEASE_CORPUS_OBSERVED_VARIANTS_BY_FORMAT)
  !== JSON.stringify(expectedObservedVariants)) {
  throw new Error('release corpus observedVariant enum drifted from the reviewed Bridge boundary');
}

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
    gameBuild: '1.06',
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
        observedVariant: 'DCX_DFLT_11000_44_9',
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
        observedVariant: 'DCX_KRAK_9',
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

function assertStructuredDiagnostics(
  diagnostics: Array<{ severity: string; code: string; path: string; message: string }>,
  caseName: string
): void {
  if (diagnostics.length === 0) throw new Error(`${caseName} returned no diagnostics`);
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
