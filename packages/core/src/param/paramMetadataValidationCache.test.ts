import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ParamDefDocument,
  ParamMetadataDefinition,
  ParamMetadataDefinitionKey,
  ParamMetadataPackage,
  ParamMetadataTrustPolicy
} from '@soulforge/shared';
import {
  computeParamMetadataDefinitionDigest,
  computeParamMetadataDigest,
  computeParamMetadataPackageDigest,
  matchParamMetadataPackage,
  validateParamMetadataPackage
} from './paramMetadata.js';

describe('PARAM metadata validation output cache', () => {
  it('reuses validation only for its own immutable successful output', () => {
    const first = validateParamMetadataPackage(makePackage());
    if (!first.ok) throw new Error(`fixture must validate: ${JSON.stringify(first.diagnostics)}`);

    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.package));
    assert.ok(Object.isFrozen(first.package.definitions));
    assert.ok(Object.isFrozen(first.package.definitions[0]!.document.fields[0]!));

    const packageGraph = collectObjectGraph(first.package);
    const descriptorProperty = Object.getOwnPropertyDescriptor(Object, 'getOwnPropertyDescriptor')!;
    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
    let packageDescriptorReads = 0;
    const trackedGetOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor = (target, key) => {
      if (packageGraph.has(target)) packageDescriptorReads += 1;
      return originalGetOwnPropertyDescriptor(target, key);
    };
    Object.defineProperty(Object, 'getOwnPropertyDescriptor', {
      ...descriptorProperty,
      value: trackedGetOwnPropertyDescriptor
    });
    let reused: ReturnType<typeof validateParamMetadataPackage>;
    try {
      reused = validateParamMetadataPackage(first.package);
    } finally {
      Object.defineProperty(Object, 'getOwnPropertyDescriptor', descriptorProperty);
    }

    assert.strictEqual(reused, first);
    assert.equal(packageDescriptorReads, 0, 'reusing an own output must not resnapshot its package graph');
  });

  it('does not trust a shallow-frozen external package after nested mutation', () => {
    const external = clonePackage(makePackage());
    Object.freeze(external);
    external.definitions[0]!.document.fields[0]!.name = 'Tampered after shallow freeze';

    const validation = validateParamMetadataPackage(external);
    assert.equal(validation.ok, false);
    assertDiagnostic(validation, 'PARAM_METADATA_DEFINITION_DIGEST_MISMATCH');
  });

  it('does not cache a valid external input object before that input is mutated', () => {
    const external = makePackage();
    const first = validateParamMetadataPackage(external);
    if (!first.ok) throw new Error(`fixture must validate: ${JSON.stringify(first.diagnostics)}`);

    external.definitions[0]!.document.fields[0]!.name = 'Changed after initial validation';
    const validation = validateParamMetadataPackage(external);
    assert.equal(validation.ok, false);
    assertDiagnostic(validation, 'PARAM_METADATA_DEFINITION_DIGEST_MISMATCH');
  });

  it('does not trust a deeply frozen external package with stale definition digests', () => {
    const external = clonePackage(makePackage());
    external.definitions[0]!.document.fields[0]!.name = 'Tampered before deep freeze';
    deepFreeze(external);

    const validation = validateParamMetadataPackage(external);
    assert.equal(validation.ok, false);
    assertDiagnostic(validation, 'PARAM_METADATA_DEFINITION_DIGEST_MISMATCH');
  });

  it('rejects a well-formed forged package digest on a deeply frozen external package', () => {
    const external = clonePackage(makePackage());
    external.packageDigest = `sha256:${'0'.repeat(64)}`;
    assert.notEqual(external.packageDigest, makePackage().packageDigest);
    deepFreeze(external);

    const validation = validateParamMetadataPackage(external);
    assert.equal(validation.ok, false);
    assertDiagnostic(validation, 'PARAM_METADATA_PACKAGE_DIGEST_MISMATCH');
  });

  it('continues rejecting proxy and accessor inputs instead of using a shape-based cache', () => {
    const proxy = new Proxy(makePackage(), {});
    const proxyValidation = validateParamMetadataPackage(proxy);
    assert.equal(proxyValidation.ok, false);
    assertDiagnostic(proxyValidation, 'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED');

    const accessorPackage = makePackage();
    let getterCalls = 0;
    Object.defineProperty(accessorPackage, 'packageId', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'soulforge.synthetic.param-metadata';
      }
    });
    const accessorValidation = validateParamMetadataPackage(accessorPackage);
    assert.equal(accessorValidation.ok, false);
    assertDiagnostic(accessorValidation, 'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED');
    assert.equal(getterCalls, 0);
  });

  it('rechecks each descriptor and trust policy after reusing the package validation', () => {
    const fixture = makeFixture();
    const first = validateParamMetadataPackage(fixture.package);
    if (!first.ok) throw new Error(`fixture must validate: ${JSON.stringify(first.diagnostics)}`);

    const accepted = matchParamMetadataPackage(first.package, fixture.key, fixture.policy);
    if (!accepted.ok) throw new Error(`valid fixture match failed: ${JSON.stringify(accepted.diagnostics)}`);
    assert.equal(accepted.authority, 'fixture-confirmed');
    assert.equal(accepted.nativeFormatAuthority, false);

    let descriptorGetterCalls = 0;
    const badDescriptor = { ...fixture.key };
    Object.defineProperty(badDescriptor, 'game', {
      configurable: true,
      enumerable: true,
      get() {
        descriptorGetterCalls += 1;
        return fixture.key.game;
      }
    });
    const descriptorMatch = matchParamMetadataPackage(
      first.package,
      badDescriptor as unknown as ParamMetadataDefinitionKey,
      fixture.policy
    );
    assert.equal(descriptorMatch.ok, false);
    assertDiagnostic(descriptorMatch, 'PARAM_METADATA_DEFINITION_KEY_SNAPSHOT_FAILED');
    assert.equal(descriptorGetterCalls, 0);

    let policyGetterCalls = 0;
    const badPolicy = { ...fixture.policy };
    Object.defineProperty(badPolicy, 'trustedPackages', {
      configurable: true,
      enumerable: true,
      get() {
        policyGetterCalls += 1;
        return fixture.policy.trustedPackages;
      }
    });
    const policyMatch = matchParamMetadataPackage(first.package, fixture.key, badPolicy);
    assert.equal(policyMatch.ok, false);
    assertDiagnostic(policyMatch, 'PARAM_METADATA_TRUST_POLICY_SNAPSHOT_FAILED');
    assert.equal(policyGetterCalls, 0);
  });
});

function makeFixture(): {
  key: ParamMetadataDefinitionKey;
  package: ParamMetadataPackage;
  policy: ParamMetadataTrustPolicy;
} {
  const metadataPackage = makePackage();
  return {
    key: metadataPackage.definitions[0]!.key,
    package: metadataPackage,
    policy: {
      schemaVersion: 1,
      policyId: 'user.synthetic-param-policy',
      trustedPackages: [{
        packageId: metadataPackage.packageId,
        packageVersion: metadataPackage.packageVersion,
        packageDigest: metadataPackage.packageDigest,
        sourceIdentity: metadataPackage.source.identity,
        sourceRevision: metadataPackage.source.revision,
        sourceContentDigest: metadataPackage.source.contentDigest,
        licenseSpdxExpression: metadataPackage.license.spdxExpression,
        licenseTextDigest: metadataPackage.license.textDigest
      }]
    }
  };
}

function makePackage(): ParamMetadataPackage {
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
    enums: [{
      id: 'hp_kind',
      name: 'HP kind',
      values: [
        { value: 0, label: 'Empty' },
        { value: 100, label: 'Default' }
      ]
    }]
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
  return {
    ...packagePayload,
    packageDigest: computeParamMetadataPackageDigest(packagePayload)
  };
}

function clonePackage(value: ParamMetadataPackage): ParamMetadataPackage {
  return JSON.parse(JSON.stringify(value)) as ParamMetadataPackage;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function collectObjectGraph(value: unknown, objects = new Set<object>()): Set<object> {
  if (typeof value !== 'object' || value === null || objects.has(value)) return objects;
  objects.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) collectObjectGraph(child, objects);
  return objects;
}

function assertDiagnostic(
  result: { diagnostics: Array<{ code: string }> },
  code: string
): void {
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code),
    `expected diagnostic ${code}, received ${JSON.stringify(result.diagnostics)}`);
}
