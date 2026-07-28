import type {
  ParamDefDocument,
  ParamMetadataDefinition,
  ParamMetadataDefinitionKey,
  ParamMetadataDigest,
  ParamMetadataOverlay,
  ParamMetadataPackage,
  ParamMetadataTrustPolicy
} from '@soulforge/shared';
import {
  applyParamMetadataOverlay,
  computeParamMetadataDefinitionDigest,
  computeParamMetadataDigest,
  computeParamMetadataPackageDigest,
  matchParamMetadataPackage,
  PARAM_METADATA_MAX_CANONICAL_UTF8_BYTES,
  PARAM_METADATA_MAX_DEFINITIONS,
  PARAM_METADATA_MAX_DIAGNOSTICS,
  PARAM_METADATA_MAX_OVERLAY_OPERATIONS,
  PARAM_METADATA_MAX_TOTAL_ENUMS,
  PARAM_METADATA_MAX_TOTAL_ENUM_VALUES,
  PARAM_METADATA_MAX_TOTAL_FIELDS,
  PARAM_METADATA_MAX_TRUST_ENTRIES,
  validateParamMetadataPackage
} from '../param/paramMetadata.js';
import {
  PARAMDEF_MAX_ENUMS,
  PARAMDEF_MAX_ENUM_VALUES,
  PARAMDEF_MAX_FIELDS
} from '../param/paramdefLayout.js';

function main(): void {
  const fixture = buildFixture();
  expectRejected(
    validateParamMetadataPackage({ source: { kind: Object.create(null) } }),
    'PARAM_METADATA_SOURCE_KIND_INVALID'
  );
  const hostilePrimitive = createThrowingPrimitive();
  expectRejected(
    validateParamMetadataPackage({
      ...fixture.package,
      source: { ...fixture.package.source, kind: hostilePrimitive }
    }),
    'PARAM_METADATA_SOURCE_KIND_INVALID'
  );
  assertSpdxExpressions(fixture);
  assertDiagnosticLimit(fixture);
  const matched = matchParamMetadataPackage(fixture.package, fixture.key, fixture.policy);
  if (!matched.ok
    || matched.authority !== 'fixture-confirmed'
    || matched.nativeFormatAuthority !== false) {
    throw new Error(`expected exact fixture match: ${JSON.stringify(matched)}`);
  }

  const mismatchCases: Array<[string, ParamMetadataDefinitionKey, string]> = [
    ['game', { ...fixture.key, game: 'othergame' }, 'PARAM_METADATA_GAME_MISMATCH'],
    ['gameBuild', { ...fixture.key, gameBuild: 'build-2' }, 'PARAM_METADATA_GAME_BUILD_MISMATCH'],
    ['typeName', { ...fixture.key, typeName: 'OTHER_PARAM_ST' }, 'PARAM_METADATA_TYPE_NAME_MISMATCH'],
    ['dataVersion', { ...fixture.key, dataVersion: 8 }, 'PARAM_METADATA_DATA_VERSION_MISMATCH'],
    ['rowDataSize', { ...fixture.key, rowDataSize: 17 }, 'PARAM_METADATA_ROW_DATA_SIZE_MISMATCH']
  ];
  for (const [, descriptor, code] of mismatchCases) {
    expectRejected(matchParamMetadataPackage(fixture.package, descriptor, fixture.policy), code);
  }
  expectRejected(
    matchParamMetadataPackage(
      fixture.package,
      { ...fixture.key, dataVersion: hostilePrimitive } as unknown as ParamMetadataDefinitionKey,
      fixture.policy
    ),
    'PARAM_METADATA_DEFINITION_KEY_INVALID'
  );

  const duplicate = resignPackage({
    ...clone(fixture.package),
    definitions: [
      clone(fixture.package.definitions[0]!),
      clone(fixture.package.definitions[0]!)
    ]
  });
  expectRejected(
    matchParamMetadataPackage(duplicate, fixture.key, trustPolicyFor(duplicate)),
    'PARAM_METADATA_DEFINITION_DUPLICATE'
  );
  const keyDriftInput = clone(fixture.package);
  keyDriftInput.definitions[0]!.document.version += 1;
  const keyDrift = resignPackage(keyDriftInput);
  expectRejected(
    matchParamMetadataPackage(keyDrift, fixture.key, trustPolicyFor(keyDrift)),
    'PARAM_METADATA_DEFINITION_KEY_DRIFT'
  );

  const unsupportedSchema = resignPackage({
    ...clone(fixture.package),
    schemaVersion: 2
  } as unknown as ParamMetadataPackage);
  expectRejected(
    matchParamMetadataPackage(unsupportedSchema, fixture.key, trustPolicyFor(unsupportedSchema)),
    'PARAM_METADATA_SCHEMA_UNSUPPORTED'
  );

  const packageDigestTamper = clone(fixture.package);
  packageDigestTamper.packageVersion = '1.0.1';
  expectRejected(
    matchParamMetadataPackage(packageDigestTamper, fixture.key, fixture.policy),
    'PARAM_METADATA_PACKAGE_DIGEST_MISMATCH'
  );
  const branchRevision = resignPackage({
    ...clone(fixture.package),
    source: { ...fixture.package.source, revision: 'git:master' }
  });
  expectRejected(
    matchParamMetadataPackage(branchRevision, fixture.key, trustPolicyFor(branchRevision)),
    'PARAM_METADATA_SOURCE_REVISION_NOT_IMMUTABLE'
  );
  const localSource = resignPackage({
    ...clone(fixture.package),
    source: { ...fixture.package.source, identity: 'C:\\private\\paramdex' }
  });
  expectRejected(
    matchParamMetadataPackage(localSource, fixture.key, trustPolicyFor(localSource)),
    'PARAM_METADATA_SOURCE_IDENTITY_INVALID'
  );
  for (const identity of [
    '\\\\server\\share\\paramdex',
    'file:///private/paramdex',
    '../paramdex',
    '.\\paramdex',
    'relative/paramdex',
    'relative\\paramdex'
  ]) {
    const forbiddenSource = resignPackage({
      ...clone(fixture.package),
      source: { ...fixture.package.source, identity }
    });
    expectRejected(
      matchParamMetadataPackage(forbiddenSource, fixture.key, trustPolicyFor(forbiddenSource)),
      'PARAM_METADATA_SOURCE_IDENTITY_INVALID'
    );
  }
  for (const identity of ['https://example.invalid/metadata', 'user.metadata.snapshot']) {
    const portableSource = resignPackage({
      ...clone(fixture.package),
      source: { ...fixture.package.source, kind: 'user-supplied', identity }
    });
    const portableMatch = matchParamMetadataPackage(
      portableSource,
      fixture.key,
      trustPolicyFor(portableSource)
    );
    if (!portableMatch.ok || portableMatch.nativeFormatAuthority !== false) {
      throw new Error(`expected portable source identity: ${JSON.stringify(portableMatch)}`);
    }
  }

  expectMissingManifestField(fixture, 'source', 'PARAM_METADATA_SOURCE_MISSING');
  expectMissingManifestField(fixture, 'license', 'PARAM_METADATA_LICENSE_MISSING');
  expectMissingManifestField(
    fixture,
    'packageDigest',
    'PARAM_METADATA_PACKAGE_DIGEST_INVALID'
  );
  const missingSourceDigest = clone(fixture.package) as unknown as Record<string, unknown>;
  delete (missingSourceDigest.source as Record<string, unknown>).contentDigest;
  expectRejected(
    matchParamMetadataPackage(missingSourceDigest, fixture.key, fixture.policy),
    'PARAM_METADATA_SOURCE_DIGEST_INVALID'
  );
  const missingLicenseDigest = clone(fixture.package) as unknown as Record<string, unknown>;
  delete (missingLicenseDigest.license as Record<string, unknown>).textDigest;
  expectRejected(
    matchParamMetadataPackage(missingLicenseDigest, fixture.key, fixture.policy),
    'PARAM_METADATA_LICENSE_TEXT_DIGEST_INVALID'
  );
  const missingSpdx = clone(fixture.package) as unknown as Record<string, unknown>;
  delete (missingSpdx.license as Record<string, unknown>).spdxExpression;
  expectRejected(
    matchParamMetadataPackage(missingSpdx, fixture.key, fixture.policy),
    'PARAM_METADATA_LICENSE_SPDX_INVALID'
  );
  const missingDefinitionDigest = clone(fixture.package) as unknown as Record<string, unknown>;
  delete ((missingDefinitionDigest.definitions as Array<Record<string, unknown>>)[0]!).definitionDigest;
  expectRejected(
    matchParamMetadataPackage(missingDefinitionDigest, fixture.key, fixture.policy),
    'PARAM_METADATA_DEFINITION_DIGEST_INVALID'
  );
  expectRejected(
    matchParamMetadataPackage(fixture.package, fixture.key, undefined),
    'PARAM_METADATA_TRUST_POLICY_REQUIRED'
  );
  expectRejected(
    matchParamMetadataPackage(
      fixture.package,
      fixture.key,
      { ...fixture.policy, trustedPackages: [] }
    ),
    'PARAM_METADATA_TRUST_POLICY_EMPTY'
  );

  assertMalformedDefinitionFailsClosed(fixture, null, 'PARAMDEF_FIELD_NOT_OBJECT');
  assertMalformedDefinitionFailsClosed(
    fixture,
    { ...fixture.definition.document.fields[0], id: 42 },
    'PARAMDEF_VALUE_TYPE_INVALID'
  );
  assertMalformedDefinitionFailsClosed(
    fixture,
    { ...fixture.definition.document.fields[0], unexpectedLayout: true },
    'PARAMDEF_UNKNOWN_FIELD'
  );
  assertSparseArraysFailClosed(fixture);
  assertBoundedCollections(fixture);
  assertSnapshotFailuresAreStructured(fixture);

  const overlay: ParamMetadataOverlay = {
    schemaVersion: 1,
    overlayId: 'user.param-labels',
    overlayVersion: '1.0.0',
    origin: 'user',
    basePackageDigest: fixture.package.packageDigest,
    target: fixture.key,
    expectedBaseDefinitionDigest: fixture.definition.definitionDigest,
    operations: [
      { kind: 'set-field-description', fieldId: 'hp', value: 'User-facing HP note' },
      { kind: 'set-enum-value-label', enumId: 'hp_kind', valueId: 100, label: 'User default' }
    ]
  };
  const applied = applyParamMetadataOverlay(fixture.package, overlay, fixture.policy);
  if (!applied.ok
    || applied.nativeFormatAuthority !== false
    || applied.document.fields[0]?.description !== 'User-facing HP note'
    || applied.document.enums?.[0]?.values[1]?.label !== 'User default'
    || applied.effectiveDefinitionDigest === applied.baseDefinitionDigest) {
    throw new Error(`expected display-only overlay application: ${JSON.stringify(applied)}`);
  }
  if (fixture.definition.document.fields[0]?.description !== undefined) {
    throw new Error('overlay mutated the trusted base definition');
  }
  assertSuccessfulSnapshotsAreIsolatedAndFrozen();

  expectRejected(
    applyParamMetadataOverlay(
      fixture.package,
      { ...overlay, basePackageDigest: otherDigest('stale-package') },
      fixture.policy
    ),
    'PARAM_METADATA_OVERLAY_STALE_PACKAGE'
  );
  expectRejected(
    applyParamMetadataOverlay(
      fixture.package,
      { ...overlay, expectedBaseDefinitionDigest: otherDigest('stale-definition') },
      fixture.policy
    ),
    'PARAM_METADATA_OVERLAY_STALE_DEFINITION'
  );
  expectRejected(
    applyParamMetadataOverlay(
      fixture.package,
      {
        ...overlay,
        operations: [
          { kind: 'set-field-description', fieldId: 'hp', value: 'First' },
          { kind: 'set-field-description', fieldId: 'hp', value: 'Second' }
        ]
      },
      fixture.policy
    ),
    'PARAM_METADATA_OVERLAY_TARGET_DUPLICATE'
  );
  expectRejected(
    applyParamMetadataOverlay(
      fixture.package,
      {
        ...overlay,
        operations: [{ kind: 'set-field-description', fieldId: 'missing', value: 'No target' }]
      },
      fixture.policy
    ),
    'PARAM_METADATA_OVERLAY_FIELD_MISSING'
  );
  expectRejected(
    applyParamMetadataOverlay(
      fixture.package,
      {
        ...overlay,
        operations: [{ kind: 'set-enum-display-name', enumId: 'missing', value: 'No target' }]
      },
      fixture.policy
    ),
    'PARAM_METADATA_OVERLAY_ENUM_MISSING'
  );
  expectRejected(
    applyParamMetadataOverlay(
      fixture.package,
      {
        ...overlay,
        operations: [
          { kind: 'set-field-offset', fieldId: 'hp', offset: 6 }
        ]
      },
      fixture.policy
    ),
    'PARAM_METADATA_OVERLAY_IDENTITY_LAYOUT_MUTATION'
  );
  expectRejected(
    applyParamMetadataOverlay(
      fixture.package,
      {
        ...overlay,
        operations: [
          { kind: 'set-field-description', fieldId: hostilePrimitive, value: 'Attempt' }
        ]
      },
      fixture.policy
    ),
    'PARAM_METADATA_OVERLAY_TARGET_INVALID'
  );
  expectRejected(
    applyParamMetadataOverlay(
      fixture.package,
      {
        ...overlay,
        operations: [
          { kind: 'set-field-description', fieldId: 'hp', value: 'Attempt', offset: 6 }
        ]
      },
      fixture.policy
    ),
    'PARAM_METADATA_OVERLAY_IDENTITY_LAYOUT_MUTATION'
  );

  console.log(JSON.stringify({
    ok: true,
    status: 'fixture-confirmed',
    nativeFormatAuthority: false,
    packageId: fixture.package.packageId,
    strictMatchKey: ['game', 'gameBuild', 'typeName', 'dataVersion', 'rowDataSize'],
    mismatchCases: mismatchCases.map(([name]) => name),
    provenanceAndTrustFailureCases: 15,
    portableSourceIdentityCases: 2,
    hostilePrimitiveCases: 4,
    spdxPositiveCases: 5,
    spdxNegativeCases: 9,
    malformedNestedCases: 3,
    sparseArrayCases: 6,
    boundedCollectionCases: 9,
    snapshotFailureCases: 9,
    aggregateSerializationBudgetCases: 1,
    diagnosticLimitCases: 1,
    immutableSnapshotCases: 3,
    overlayFailureCases: 7,
    nonClaims: [
      'No Paramdex data is bundled or redistributed.',
      'Synthetic metadata does not establish native PARAM authority.'
    ]
  }, null, 2));
}

function createThrowingPrimitive(): object {
  return {
    [Symbol.toPrimitive](): never {
      throw new Error('primitive conversion must not run');
    },
    toString(): never {
      throw new Error('toString must not run');
    },
    valueOf(): never {
      throw new Error('valueOf must not run');
    }
  };
}

function assertSuccessfulSnapshotsAreIsolatedAndFrozen(): void {
  const validationFixture = buildFixture();
  const validated = validateParamMetadataPackage(validationFixture.package);
  if (!validated.ok) {
    throw new Error(`expected validation snapshot: ${JSON.stringify(validated)}`);
  }
  const validatedDigest = validated.package.packageDigest;
  const validatedFieldName = validated.package.definitions[0]!.document.fields[0]!.name;
  assertCallerInputRemainsMutable(validationFixture.package, 'validatePackage');
  validationFixture.package.packageVersion = 'caller-mutated';
  validationFixture.package.definitions[0]!.document.fields[0]!.name = 'Caller mutation';
  if (validated.package.packageVersion !== '1.0.0'
    || validated.package.definitions[0]!.document.fields[0]!.name !== validatedFieldName
    || validated.package.packageDigest !== validatedDigest
    || computeParamMetadataPackageDigest(validated.package) !== validatedDigest
    || validated.nativeFormatAuthority !== false) {
    throw new Error('validatePackage success escaped its isolated digest-preserving snapshot');
  }
  assertDeepFrozen(validated, '$validation');
  assertMutationRejectedOrIgnored(
    'validation result status',
    () => validated.status,
    () => {
      (validated as unknown as { status: string }).status = 'mutated';
    },
    'schema-valid'
  );
  assertMutationRejectedOrIgnored(
    'validation nested field name',
    () => validated.package.definitions[0]!.document.fields[0]!.name,
    () => {
      validated.package.definitions[0]!.document.fields[0]!.name = 'Returned mutation';
    },
    validatedFieldName
  );

  const matchFixture = buildFixture();
  const matched = matchParamMetadataPackage(
    matchFixture.package,
    matchFixture.key,
    matchFixture.policy
  );
  if (!matched.ok) throw new Error(`expected match snapshot: ${JSON.stringify(matched)}`);
  const matchedDigest = matched.definition.definitionDigest;
  const matchedFieldName = matched.definition.document.fields[0]!.name;
  assertCallerInputRemainsMutable(matchFixture.package, 'matchPackage');
  matchFixture.package.definitions[0]!.definitionDigest = otherDigest('caller-match-mutation');
  matchFixture.package.definitions[0]!.document.fields[0]!.name = 'Caller mutation';
  if (matched.definition.definitionDigest !== matchedDigest
    || matched.definition.document.fields[0]!.name !== matchedFieldName
    || computeParamMetadataDefinitionDigest(matched.definition) !== matchedDigest
    || matched.authority !== 'fixture-confirmed'
    || matched.nativeFormatAuthority !== false) {
    throw new Error('match success escaped its isolated authority-preserving snapshot');
  }
  assertDeepFrozen(matched, '$match');
  assertMutationRejectedOrIgnored(
    'match nested definition digest',
    () => matched.definition.definitionDigest,
    () => {
      matched.definition.definitionDigest = otherDigest('returned-match-mutation');
    },
    matchedDigest
  );

  const overlayFixture = buildFixture();
  const overlay: ParamMetadataOverlay = {
    schemaVersion: 1,
    overlayId: 'user.immutable-param-labels',
    overlayVersion: '1.0.0',
    origin: 'user',
    basePackageDigest: overlayFixture.package.packageDigest,
    target: clone(overlayFixture.key),
    expectedBaseDefinitionDigest: overlayFixture.definition.definitionDigest,
    operations: [
      { kind: 'set-field-description', fieldId: 'hp', value: 'Immutable overlay note' }
    ]
  };
  const applied = applyParamMetadataOverlay(
    overlayFixture.package,
    overlay,
    overlayFixture.policy
  );
  if (!applied.ok) throw new Error(`expected overlay snapshot: ${JSON.stringify(applied)}`);
  const appliedAuthority = applied.authority;
  const baseDigest = applied.baseDefinitionDigest;
  const effectiveDigest = applied.effectiveDefinitionDigest;
  const effectiveKey = clone(overlayFixture.key);
  const appliedDescription = applied.document.fields[0]!.description;
  assertCallerInputRemainsMutable(overlayFixture.package, 'applyOverlay package');
  if (Object.isFrozen(overlay) || Object.isFrozen(overlay.operations[0]!)) {
    throw new Error('applyOverlay froze the caller overlay');
  }
  overlayFixture.package.packageDigest = otherDigest('caller-overlay-package-mutation');
  overlayFixture.package.definitions[0]!.document.fields[0]!.name = 'Caller mutation';
  (overlay.operations[0] as { kind: 'set-field-description'; fieldId: string; value: string }).value =
    'Caller overlay mutation';
  overlay.target.typeName = 'CALLER_MUTATION_PARAM_ST';
  if (applied.document.fields[0]!.description !== appliedDescription
    || applied.baseDefinitionDigest !== baseDigest
    || applied.effectiveDefinitionDigest !== effectiveDigest
    || computeParamMetadataDefinitionDigest({ key: effectiveKey, document: applied.document })
      !== effectiveDigest
    || applied.authority !== appliedAuthority
    || appliedAuthority !== 'fixture-confirmed'
    || applied.nativeFormatAuthority !== false) {
    throw new Error('overlay success escaped its isolated authority-preserving snapshot');
  }
  assertDeepFrozen(applied, '$overlayResult');
  assertMutationRejectedOrIgnored(
    'overlay nested field description',
    () => applied.document.fields[0]!.description,
    () => {
      applied.document.fields[0]!.description = 'Returned overlay mutation';
    },
    appliedDescription
  );
  const appliedFieldCount = applied.document.fields.length;
  assertMutationRejectedOrIgnored(
    'overlay document field array',
    () => applied.document.fields.length,
    () => {
      applied.document.fields.push(clone(applied.document.fields[0]!));
    },
    appliedFieldCount
  );
}

function assertSnapshotFailuresAreStructured(fixture: ReturnType<typeof buildFixture>): void {
  const throwingGetter = (): never => {
    throw new Error('snapshot must not invoke accessors');
  };

  const packageInput = clone(fixture.package) as unknown as Record<string, unknown>;
  Object.defineProperty(packageInput, 'packageId', { enumerable: true, get: throwingGetter });
  expectRejected(
    validateParamMetadataPackage(packageInput),
    'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED'
  );

  const descriptor = clone(fixture.key) as unknown as Record<string, unknown>;
  Object.defineProperty(descriptor, 'typeName', { enumerable: true, get: throwingGetter });
  expectRejected(
    matchParamMetadataPackage(
      fixture.package,
      descriptor as unknown as ParamMetadataDefinitionKey,
      fixture.policy
    ),
    'PARAM_METADATA_DEFINITION_KEY_SNAPSHOT_FAILED'
  );

  const trustPolicy = clone(fixture.policy) as unknown as Record<string, unknown>;
  Object.defineProperty(trustPolicy, 'trustedPackages', { enumerable: true, get: throwingGetter });
  expectRejected(
    matchParamMetadataPackage(fixture.package, fixture.key, trustPolicy),
    'PARAM_METADATA_TRUST_POLICY_SNAPSHOT_FAILED'
  );

  const overlay: Record<string, unknown> = {
    schemaVersion: 1,
    overlayId: 'user.snapshot-failure',
    overlayVersion: '1.0.0',
    origin: 'user',
    basePackageDigest: fixture.package.packageDigest,
    target: fixture.key,
    expectedBaseDefinitionDigest: fixture.definition.definitionDigest,
    operations: []
  };
  Object.defineProperty(overlay, 'operations', { enumerable: true, get: throwingGetter });
  expectRejected(
    applyParamMetadataOverlay(fixture.package, overlay, fixture.policy),
    'PARAM_METADATA_OVERLAY_SNAPSHOT_FAILED'
  );

  const customArrayProperty = clone(fixture.package);
  Object.defineProperty(customArrayProperty.definitions, 'notContentAddressed', {
    configurable: true,
    enumerable: true,
    value: 'must be rejected',
    writable: true
  });
  expectRejected(
    validateParamMetadataPackage(customArrayProperty),
    'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED'
  );

  let proxyTrapCount = 0;
  const proxyTarget = clone(fixture.package);
  const proxiedPackage = new Proxy(proxyTarget, {
    ownKeys(target) {
      proxyTrapCount += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      proxyTrapCount += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    }
  });
  expectRejected(
    validateParamMetadataPackage(proxiedPackage),
    'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED'
  );
  if (proxyTrapCount !== 0) {
    throw new Error(`snapshot invoked ${proxyTrapCount} untrusted proxy traps before rejection`);
  }

  const hiddenAccessorPackage = clone(fixture.package) as unknown as Record<string, unknown>;
  Object.defineProperty(hiddenAccessorPackage, 'hiddenAccessor', {
    configurable: true,
    enumerable: false,
    get: throwingGetter
  });
  expectRejected(
    validateParamMetadataPackage(hiddenAccessorPackage),
    'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED'
  );

  const explicitUndefinedPackage = clone(fixture.package) as unknown as Record<string, unknown>;
  explicitUndefinedPackage.notCanonical = undefined;
  expectRejected(
    validateParamMetadataPackage(explicitUndefinedPackage),
    'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED'
  );

  const aggregateTextPackage = clone(fixture.package) as unknown as Record<string, unknown>;
  const repeatedText = 'x'.repeat(1024 * 1024);
  aggregateTextPackage.notCanonical = new Array(
    Math.floor(PARAM_METADATA_MAX_CANONICAL_UTF8_BYTES / (1024 * 1024)) + 1
  ).fill(repeatedText);
  expectRejected(
    validateParamMetadataPackage(aggregateTextPackage),
    'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED'
  );
}

function assertCallerInputRemainsMutable(input: ParamMetadataPackage, label: string): void {
  const nested = input.definitions[0]!.document.fields[0]!;
  if (Object.isFrozen(input)
    || Object.isFrozen(input.definitions)
    || Object.isFrozen(input.definitions[0]!)
    || Object.isFrozen(input.definitions[0]!.document)
    || Object.isFrozen(input.definitions[0]!.document.fields)
    || Object.isFrozen(nested)) {
    throw new Error(`${label} froze caller-owned input`);
  }
}

function assertDeepFrozen(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (!Object.isFrozen(value)) throw new Error(`${path} is not frozen`);
  for (const key of Reflect.ownKeys(value)) {
    assertDeepFrozen(
      (value as Record<PropertyKey, unknown>)[key],
      `${path}.${String(key)}`,
      seen
    );
  }
}

function assertMutationRejectedOrIgnored<T>(
  label: string,
  read: () => T,
  mutate: () => void,
  expected: T
): void {
  try {
    mutate();
  } catch {
    // Strict-mode writes to frozen snapshots are expected to throw.
  }
  if (!Object.is(read(), expected)) {
    throw new Error(`${label} changed a frozen snapshot`);
  }
}

function assertSpdxExpressions(fixture: ReturnType<typeof buildFixture>): void {
  const validExpressions = [
    'MIT',
    'MIT OR Apache-2.0',
    '(MIT OR Apache-2.0) AND LicenseRef-User-Data',
    'GPL-2.0-only WITH Classpath-exception-2.0',
    'DocumentRef-upstream:LicenseRef-Custom'
  ];
  for (const spdxExpression of validExpressions) {
    const metadataPackage = resignPackage({
      ...clone(fixture.package),
      license: { ...fixture.package.license, spdxExpression }
    });
    const result = matchParamMetadataPackage(
      metadataPackage,
      fixture.key,
      trustPolicyFor(metadataPackage)
    );
    if (!result.ok || result.nativeFormatAuthority !== false) {
      throw new Error(`expected valid SPDX expression ${spdxExpression}: ${JSON.stringify(result)}`);
    }
  }

  const invalidExpressions = [
    'NOT A LICENSE',
    'MIT AND',
    'AND MIT',
    'MIT OR OR Apache-2.0',
    'MIT WITH',
    '(MIT OR Apache-2.0',
    'MIT Apache-2.0',
    'MIT WITH LicenseRef-Not-An-Exception'
  ];
  for (const spdxExpression of invalidExpressions) {
    const metadataPackage = resignPackage({
      ...clone(fixture.package),
      license: { ...fixture.package.license, spdxExpression }
    });
    expectRejected(
      matchParamMetadataPackage(
        metadataPackage,
        fixture.key,
        trustPolicyFor(metadataPackage)
      ),
      'PARAM_METADATA_LICENSE_SPDX_INVALID'
    );
  }

  const invalidTrust: ParamMetadataTrustPolicy = clone(fixture.policy);
  invalidTrust.trustedPackages[0]!.licenseSpdxExpression = 'NOT A LICENSE';
  expectRejected(
    matchParamMetadataPackage(fixture.package, fixture.key, invalidTrust),
    'PARAM_METADATA_TRUST_ENTRY_SPDX_INVALID'
  );
}

function assertDiagnosticLimit(fixture: ReturnType<typeof buildFixture>): void {
  const input = clone(fixture.package) as unknown as Record<string, unknown>;
  for (let index = 0; index < PARAM_METADATA_MAX_DIAGNOSTICS + 64; index += 1) {
    input[`unknownDiagnostic${index}`] = true;
  }
  const result = validateParamMetadataPackage(input);
  if (result.ok || result.diagnostics.length !== PARAM_METADATA_MAX_DIAGNOSTICS) {
    throw new Error(`metadata diagnostic cap was not enforced: ${JSON.stringify(result)}`);
  }
  if (!result.diagnostics.some((diagnostic) => diagnostic.code === 'PARAM_METADATA_UNKNOWN_FIELD')) {
    throw new Error('metadata diagnostic cap hid every original validation error');
  }
  const sentinels = result.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'PARAM_METADATA_DIAGNOSTIC_LIMIT_REACHED'
  );
  if (sentinels.length !== 1
    || result.diagnostics[result.diagnostics.length - 1]?.code
      !== 'PARAM_METADATA_DIAGNOSTIC_LIMIT_REACHED') {
    throw new Error(`metadata diagnostic sentinel was not unique and terminal: ${JSON.stringify(sentinels)}`);
  }
}

function assertSparseArraysFailClosed(fixture: ReturnType<typeof buildFixture>): void {
  const sparseDefinitions = clone(fixture.package);
  sparseDefinitions.definitions = sparseArray<ParamMetadataDefinition>();
  expectRejected(
    validateParamMetadataPackage(resignPackage(sparseDefinitions)),
    'PARAM_METADATA_DEFINITION_ARRAY_SPARSE'
  );

  const sparseFields = clone(fixture.package);
  sparseFields.definitions[0]!.document.fields = sparseArray<ParamDefDocument['fields'][number]>();
  expectRejected(
    validateParamMetadataPackage(resignPackage(sparseFields)),
    'PARAMDEF_FIELD_ARRAY_SPARSE'
  );

  const sparseEnums = clone(fixture.package);
  sparseEnums.definitions[0]!.document.enums = sparseArray<
    NonNullable<ParamDefDocument['enums']>[number]
  >();
  expectRejected(
    validateParamMetadataPackage(resignPackage(sparseEnums)),
    'PARAMDEF_ENUM_ARRAY_SPARSE'
  );

  const sparseEnumValues = clone(fixture.package);
  sparseEnumValues.definitions[0]!.document.enums![0]!.values = sparseArray<
    NonNullable<ParamDefDocument['enums']>[number]['values'][number]
  >();
  expectRejected(
    validateParamMetadataPackage(resignPackage(sparseEnumValues)),
    'PARAMDEF_ENUM_VALUE_ARRAY_SPARSE'
  );

  const sparseTrust: ParamMetadataTrustPolicy = {
    ...fixture.policy,
    trustedPackages: sparseArray<ParamMetadataTrustPolicy['trustedPackages'][number]>()
  };
  expectRejected(
    matchParamMetadataPackage(fixture.package, fixture.key, sparseTrust),
    'PARAM_METADATA_TRUST_ENTRY_ARRAY_SPARSE'
  );

  const sparseOverlay: ParamMetadataOverlay = {
    schemaVersion: 1,
    overlayId: 'user.sparse-operations',
    overlayVersion: '1.0.0',
    origin: 'user',
    basePackageDigest: fixture.package.packageDigest,
    target: fixture.key,
    expectedBaseDefinitionDigest: fixture.definition.definitionDigest,
    operations: sparseArray<ParamMetadataOverlay['operations'][number]>()
  };
  expectRejected(
    applyParamMetadataOverlay(fixture.package, sparseOverlay, fixture.policy),
    'PARAM_METADATA_OVERLAY_OPERATION_ARRAY_SPARSE'
  );
}

function sparseArray<T>(): T[] {
  return new Array<T>(1);
}

function assertBoundedCollections(fixture: ReturnType<typeof buildFixture>): void {
  const tooManyDefinitions = clone(fixture.package);
  tooManyDefinitions.definitions = new Array(PARAM_METADATA_MAX_DEFINITIONS + 1)
    .fill(fixture.definition);
  expectRejected(
    validateParamMetadataPackage(tooManyDefinitions),
    'PARAM_METADATA_DEFINITION_LIMIT_EXCEEDED'
  );

  const tooManyFields = clone(fixture.package);
  tooManyFields.definitions[0]!.document.fields = new Array(PARAMDEF_MAX_FIELDS + 1)
    .fill(fixture.definition.document.fields[0]!);
  expectRejected(validateParamMetadataPackage(tooManyFields), 'PARAMDEF_FIELD_LIMIT_EXCEEDED');

  const tooManyEnums = clone(fixture.package);
  tooManyEnums.definitions[0]!.document.enums = new Array(PARAMDEF_MAX_ENUMS + 1)
    .fill(fixture.definition.document.enums![0]!);
  expectRejected(validateParamMetadataPackage(tooManyEnums), 'PARAMDEF_ENUM_LIMIT_EXCEEDED');

  const tooManyEnumValues = clone(fixture.package);
  tooManyEnumValues.definitions[0]!.document.enums![0]!.values = new Array(
    PARAMDEF_MAX_ENUM_VALUES + 1
  ).fill(fixture.definition.document.enums![0]!.values[0]!);
  expectRejected(
    validateParamMetadataPackage(tooManyEnumValues),
    'PARAMDEF_ENUM_VALUE_LIMIT_EXCEEDED'
  );

  const aggregateFields = clone(fixture.package);
  const fullFields = Array.from({ length: PARAMDEF_MAX_FIELDS }, (_, index) => ({
    id: `field_${index}`,
    name: `Field ${index}`,
    type: 'u8' as const,
    offset: index,
    size: 1
  }));
  aggregateFields.definitions = new Array(
    Math.floor(PARAM_METADATA_MAX_TOTAL_FIELDS / PARAMDEF_MAX_FIELDS) + 1
  ).fill(undefined).map((_, index) => aggregateDefinition(
    fixture,
    `AGGREGATE_FIELD_PARAM_${index}`,
    PARAMDEF_MAX_FIELDS,
    fullFields,
    undefined
  ));
  expectRejected(
    validateParamMetadataPackage(aggregateFields),
    'PARAM_METADATA_TOTAL_FIELD_LIMIT_EXCEEDED'
  );

  const aggregateEnums = clone(fixture.package);
  const fullEnums = Array.from({ length: PARAMDEF_MAX_ENUMS }, (_, index) => index === 0
    ? clone(fixture.definition.document.enums![0]!)
    : { id: `enum_${index}`, name: `Enum ${index}`, values: [] });
  aggregateEnums.definitions = new Array(
    Math.floor(PARAM_METADATA_MAX_TOTAL_ENUMS / PARAMDEF_MAX_ENUMS) + 1
  ).fill(undefined).map((_, index) => aggregateDefinition(
    fixture,
    `AGGREGATE_ENUM_PARAM_${index}`,
    fixture.key.rowDataSize,
    clone(fixture.definition.document.fields),
    fullEnums
  ));
  expectRejected(
    validateParamMetadataPackage(aggregateEnums),
    'PARAM_METADATA_TOTAL_ENUM_LIMIT_EXCEEDED'
  );

  const aggregateEnumValues = clone(fixture.package);
  const fullEnumValues = Array.from({ length: PARAMDEF_MAX_ENUM_VALUES }, (_, index) => ({
    value: index,
    label: `Value ${index}`
  }));
  aggregateEnumValues.definitions = new Array(
    Math.floor(PARAM_METADATA_MAX_TOTAL_ENUM_VALUES / PARAMDEF_MAX_ENUM_VALUES) + 1
  ).fill(undefined).map((_, index) => aggregateDefinition(
    fixture,
    `AGGREGATE_ENUM_VALUE_PARAM_${index}`,
    fixture.key.rowDataSize,
    clone(fixture.definition.document.fields),
    [{ id: 'hp_kind', name: 'HP kind', values: fullEnumValues }]
  ));
  expectRejected(
    validateParamMetadataPackage(aggregateEnumValues),
    'PARAM_METADATA_TOTAL_ENUM_VALUE_LIMIT_EXCEEDED'
  );

  const tooManyTrustEntries: ParamMetadataTrustPolicy = {
    ...fixture.policy,
    trustedPackages: new Array(PARAM_METADATA_MAX_TRUST_ENTRIES + 1)
      .fill(fixture.policy.trustedPackages[0]!)
  };
  expectRejected(
    matchParamMetadataPackage(fixture.package, fixture.key, tooManyTrustEntries),
    'PARAM_METADATA_TRUST_ENTRY_LIMIT_EXCEEDED'
  );

  const overlay: ParamMetadataOverlay = {
    schemaVersion: 1,
    overlayId: 'user.too-many-operations',
    overlayVersion: '1.0.0',
    origin: 'user',
    basePackageDigest: fixture.package.packageDigest,
    target: fixture.key,
    expectedBaseDefinitionDigest: fixture.definition.definitionDigest,
    operations: new Array(PARAM_METADATA_MAX_OVERLAY_OPERATIONS + 1).fill({
      kind: 'set-definition-notes',
      value: 'bounded'
    })
  };
  expectRejected(
    applyParamMetadataOverlay(fixture.package, overlay, fixture.policy),
    'PARAM_METADATA_OVERLAY_OPERATION_LIMIT_EXCEEDED'
  );
}

function aggregateDefinition(
  fixture: ReturnType<typeof buildFixture>,
  typeName: string,
  rowDataSize: number,
  fields: ParamDefDocument['fields'],
  enums: ParamDefDocument['enums']
): ParamMetadataDefinition {
  const key: ParamMetadataDefinitionKey = {
    ...fixture.key,
    typeName,
    rowDataSize
  };
  const document: ParamDefDocument = {
    schemaVersion: 1,
    typeName,
    version: key.dataVersion,
    rowDataSize,
    origin: 'fixture',
    fields,
    ...(enums === undefined ? {} : { enums })
  };
  const payload = { key, document };
  return {
    ...payload,
    definitionDigest: computeParamMetadataDefinitionDigest(payload)
  };
}

function buildFixture(): {
  key: ParamMetadataDefinitionKey;
  definition: ParamMetadataDefinition;
  package: ParamMetadataPackage;
  policy: ParamMetadataTrustPolicy;
} {
  const key: ParamMetadataDefinitionKey = {
    game: 'sekiro',
    gameBuild: 'synthetic-build-1',
    typeName: 'SYNTHETIC_PARAM_ST',
    dataVersion: 7,
    rowDataSize: 16
  };
  const document: ParamDefDocument = {
    schemaVersion: 1,
    typeName: key.typeName,
    version: key.dataVersion,
    rowDataSize: key.rowDataSize,
    origin: 'fixture',
    fields: [
      {
        id: 'hp',
        name: 'HP',
        type: 'u16',
        offset: 0,
        size: 2,
        alignment: 2,
        min: 0,
        max: 9999,
        defaultValue: 100,
        enumRef: 'hp_kind'
      },
      { id: 'reserved', name: 'Reserved', type: 'bytes', offset: 2, size: 14 }
    ],
    enums: [
      {
        id: 'hp_kind',
        name: 'HP kind',
        values: [
          { value: 0, label: 'Empty' },
          { value: 100, label: 'Default' }
        ]
      }
    ]
  };
  const definitionPayload: Omit<ParamMetadataDefinition, 'definitionDigest'> = { key, document };
  const definition: ParamMetadataDefinition = {
    ...definitionPayload,
    definitionDigest: computeParamMetadataDefinitionDigest(definitionPayload)
  };
  const sourceDigest = computeParamMetadataDigest('synthetic metadata source v1');
  const packagePayload: Omit<ParamMetadataPackage, 'packageDigest'> = {
    schemaVersion: 1,
    packageId: 'soulforge.synthetic.param-metadata',
    packageVersion: '1.0.0',
    source: {
      kind: 'synthetic-fixture',
      identity: 'urn:soulforge:synthetic-param-metadata',
      revision: sourceDigest,
      contentDigest: sourceDigest
    },
    license: {
      spdxExpression: 'LicenseRef-SoulForge-Synthetic-Fixture',
      textDigest: computeParamMetadataDigest('Synthetic fixture data authored for SoulForge tests.'),
      redistribution: 'permitted'
    },
    definitions: [definition]
  };
  const metadataPackage: ParamMetadataPackage = {
    ...packagePayload,
    packageDigest: computeParamMetadataPackageDigest(packagePayload)
  };
  return {
    key,
    definition,
    package: metadataPackage,
    policy: trustPolicyFor(metadataPackage)
  };
}

function trustPolicyFor(metadataPackage: ParamMetadataPackage): ParamMetadataTrustPolicy {
  return {
    schemaVersion: 1,
    policyId: 'user.synthetic-param-policy',
    trustedPackages: [
      {
        packageId: metadataPackage.packageId,
        packageVersion: metadataPackage.packageVersion,
        packageDigest: metadataPackage.packageDigest,
        sourceIdentity: metadataPackage.source.identity,
        sourceRevision: metadataPackage.source.revision,
        sourceContentDigest: metadataPackage.source.contentDigest,
        licenseSpdxExpression: metadataPackage.license.spdxExpression,
        licenseTextDigest: metadataPackage.license.textDigest
      }
    ]
  };
}

function resignPackage(input: ParamMetadataPackage): ParamMetadataPackage {
  const definitions = input.definitions.map((definition) => {
    const payload = { key: definition.key, document: definition.document };
    return { ...payload, definitionDigest: computeParamMetadataDefinitionDigest(payload) };
  });
  const payload = {
    schemaVersion: input.schemaVersion,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    source: input.source,
    license: input.license,
    definitions
  };
  return {
    ...payload,
    packageDigest: computeParamMetadataPackageDigest(payload)
  };
}

function expectMissingManifestField(
  fixture: ReturnType<typeof buildFixture>,
  field: 'source' | 'license' | 'packageDigest',
  code: string
): void {
  const missing = clone(fixture.package) as unknown as Record<string, unknown>;
  delete missing[field];
  expectRejected(matchParamMetadataPackage(missing, fixture.key, fixture.policy), code);
}

function assertMalformedDefinitionFailsClosed(
  fixture: ReturnType<typeof buildFixture>,
  malformedField: unknown,
  code: string
): void {
  const malformed = clone(fixture.package) as unknown as Record<string, unknown>;
  const definitions = malformed.definitions as Array<Record<string, unknown>>;
  const document = definitions[0]!.document as Record<string, unknown>;
  document.fields = [malformedField];
  const validation = validateParamMetadataPackage(malformed);
  if (validation.ok || !validation.diagnostics.some((diagnostic) => diagnostic.code === code)) {
    throw new Error(`expected malformed definition ${code}: ${JSON.stringify(validation)}`);
  }
}

function expectRejected(
  result: {
    ok: boolean;
    nativeFormatAuthority: false;
    diagnostics: Array<{ code: string }>;
  },
  code: string
): void {
  if (result.ok
    || result.nativeFormatAuthority !== false
    || !result.diagnostics.some((diagnostic) => diagnostic.code === code)) {
    throw new Error(`expected ${code}: ${JSON.stringify(result)}`);
  }
}

function otherDigest(label: string): ParamMetadataDigest {
  return computeParamMetadataDigest(label);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

main();
