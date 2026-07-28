import { createHash } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';
import type {
  ParamDefDocument,
  ParamMetadataDefinition,
  ParamMetadataDefinitionKey,
  ParamMetadataDigest,
  ParamMetadataOverlay,
  ParamMetadataOverlayOperation,
  ParamMetadataPackage,
  ParamMetadataTrustPolicy
} from '@soulforge/shared';
import { validateParamDef } from './paramdefLayout.js';

export interface ParamMetadataDiagnostic {
  severity: 'error';
  code: string;
  path: string;
  message: string;
}

export type ParamMetadataPackageValidation =
  | {
      ok: true;
      status: 'schema-valid';
      nativeFormatAuthority: false;
      package: ParamMetadataPackage;
      diagnostics: [];
    }
  | {
      ok: false;
      status: 'rejected';
      nativeFormatAuthority: false;
      diagnostics: ParamMetadataDiagnostic[];
    };

export type ParamMetadataMatchResult =
  | {
      ok: true;
      status: 'matched';
      authority: 'fixture-confirmed' | 'partial';
      nativeFormatAuthority: false;
      definition: ParamMetadataDefinition;
      diagnostics: [];
    }
  | {
      ok: false;
      status: 'rejected';
      authority: 'unverified';
      nativeFormatAuthority: false;
      diagnostics: ParamMetadataDiagnostic[];
    };

export type ParamMetadataOverlayResult =
  | {
      ok: true;
      status: 'applied';
      authority: 'fixture-confirmed' | 'partial';
      nativeFormatAuthority: false;
      document: ParamDefDocument;
      baseDefinitionDigest: ParamMetadataDigest;
      effectiveDefinitionDigest: ParamMetadataDigest;
      diagnostics: [];
    }
  | {
      ok: false;
      status: 'rejected';
      authority: 'unverified';
      nativeFormatAuthority: false;
      diagnostics: ParamMetadataDiagnostic[];
    };

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_REVISION = /^(?:git:(?:[a-f0-9]{40}|[a-f0-9]{64})|sha256:[a-f0-9]{64})$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const MATCH_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const SPDX_LICENSE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/;
const SPDX_LICENSE_REF = /^LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]*$/;
const SPDX_DOCUMENT_LICENSE_REF = /^DocumentRef-[A-Za-z0-9][A-Za-z0-9.-]*:LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]*$/;
const SPDX_EXCEPTION_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const SPDX_OPERATORS = new Set(['AND', 'OR', 'WITH']);
const SPDX_RESERVED_IDENTIFIERS = new Set(['AND', 'OR', 'WITH', 'NOT', 'NONE', 'NOASSERTION']);
const SOURCE_KINDS = [
  'paramdex-compatible',
  'user-supplied',
  'synthetic-fixture'
] as const;
const PACKAGE_KEYS = new Set([
  'schemaVersion',
  'packageId',
  'packageVersion',
  'packageDigest',
  'source',
  'license',
  'definitions'
]);
const SOURCE_KEYS = new Set(['kind', 'identity', 'revision', 'contentDigest']);
const LICENSE_KEYS = new Set(['spdxExpression', 'textDigest', 'redistribution']);
const DEFINITION_KEYS = new Set(['key', 'definitionDigest', 'document']);
const MATCH_KEY_KEYS = new Set([
  'game',
  'gameBuild',
  'typeName',
  'dataVersion',
  'rowDataSize'
]);
const TRUST_POLICY_KEYS = new Set(['schemaVersion', 'policyId', 'trustedPackages']);
const TRUST_ENTRY_KEYS = new Set([
  'packageId',
  'packageVersion',
  'packageDigest',
  'sourceIdentity',
  'sourceRevision',
  'sourceContentDigest',
  'licenseSpdxExpression',
  'licenseTextDigest'
]);
const OVERLAY_KEYS = new Set([
  'schemaVersion',
  'overlayId',
  'overlayVersion',
  'origin',
  'basePackageDigest',
  'target',
  'expectedBaseDefinitionDigest',
  'operations'
]);

export const PARAM_METADATA_MAX_DEFINITIONS = 4_096;
export const PARAM_METADATA_MAX_TRUST_ENTRIES = 4_096;
export const PARAM_METADATA_MAX_OVERLAY_OPERATIONS = 4_096;
export const PARAM_METADATA_MAX_TOTAL_FIELDS = 131_072;
export const PARAM_METADATA_MAX_TOTAL_ENUMS = 32_768;
export const PARAM_METADATA_MAX_TOTAL_ENUM_VALUES = 524_288;
export const PARAM_METADATA_MAX_CANONICAL_UTF8_BYTES = 64 * 1024 * 1024;
export const PARAM_METADATA_MAX_DIAGNOSTICS = 256;

const PARAM_METADATA_SNAPSHOT_MAX_ARRAY_LENGTH = PARAM_METADATA_MAX_TOTAL_ENUM_VALUES + 1;
const PARAM_METADATA_SNAPSHOT_MAX_OBJECT_KEYS = 16_384;
const PARAM_METADATA_SNAPSHOT_MAX_DEPTH = 64;
const PARAM_METADATA_SNAPSHOT_MAX_NODES = 8_000_000;

/** Hashes trusted in-memory data. Untrusted external values must pass validation first. */
export function computeParamMetadataDigest(value: unknown): ParamMetadataDigest {
  const payload = canonicalJson(value);
  return `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

export function computeParamMetadataDefinitionDigest(
  definition: Omit<ParamMetadataDefinition, 'definitionDigest'> | ParamMetadataDefinition
): ParamMetadataDigest {
  const record = definition as unknown as Record<string, unknown>;
  const { definitionDigest: _ignored, ...payload } = record;
  return computeParamMetadataDigest(payload);
}

export function computeParamMetadataPackageDigest(
  metadataPackage: Omit<ParamMetadataPackage, 'packageDigest'> | ParamMetadataPackage
): ParamMetadataDigest {
  const record = metadataPackage as unknown as Record<string, unknown>;
  const { packageDigest: _ignored, ...payload } = record;
  return computeParamMetadataDigest(payload);
}

export function validateParamMetadataPackage(input: unknown): ParamMetadataPackageValidation {
  const snapshot = snapshotUntrustedInput(
    input,
    'PARAM_METADATA_PACKAGE_SNAPSHOT_FAILED',
    '$',
    'Metadata package'
  );
  if (!snapshot.ok) return rejectedPackage([snapshot.diagnostic]);

  const diagnostics: ParamMetadataDiagnostic[] = [];
  if (!isRecord(snapshot.value)) {
    add(diagnostics, 'PARAM_METADATA_PACKAGE_NOT_OBJECT', '$', 'Metadata package must be an object.');
    return rejectedPackage(diagnostics);
  }
  const packageInput = snapshot.value;

  validateExactKeys(packageInput, PACKAGE_KEYS, '$', diagnostics);
  if (packageInput.schemaVersion !== 1) {
    add(
      diagnostics,
      'PARAM_METADATA_SCHEMA_UNSUPPORTED',
      '$.schemaVersion',
      'Only metadata package schemaVersion 1 is supported.'
    );
  }
  validateStableId(packageInput.packageId, '$.packageId', 'PARAM_METADATA_PACKAGE_ID_INVALID', diagnostics);
  validateStableId(
    packageInput.packageVersion,
    '$.packageVersion',
    'PARAM_METADATA_PACKAGE_VERSION_INVALID',
    diagnostics
  );
  validateDigest(packageInput.packageDigest, '$.packageDigest', 'PARAM_METADATA_PACKAGE_DIGEST_INVALID', diagnostics);
  validateSource(packageInput.source, diagnostics);
  validateLicense(packageInput.license, diagnostics);
  validateDefinitions(packageInput.definitions, diagnostics);

  if (diagnostics.length === 0
    && typeof packageInput.packageDigest === 'string'
    && SHA256_DIGEST.test(packageInput.packageDigest)) {
    try {
      const calculated = computeParamMetadataPackageDigest(
        packageInput as unknown as ParamMetadataPackage
      );
      if (calculated !== packageInput.packageDigest) {
        add(
          diagnostics,
          'PARAM_METADATA_PACKAGE_DIGEST_MISMATCH',
          '$.packageDigest',
          'Package digest does not match the canonical manifest payload.'
        );
      }
    } catch (error) {
      add(
        diagnostics,
        'PARAM_METADATA_PACKAGE_DIGEST_UNCOMPUTABLE',
        '$.packageDigest',
        error instanceof Error ? error.message : 'Package digest could not be computed.'
      );
    }
  }

  if (diagnostics.length > 0) return rejectedPackage(diagnostics);
  return deepFreeze({
    ok: true,
    status: 'schema-valid',
    nativeFormatAuthority: false,
    package: packageInput as unknown as ParamMetadataPackage,
    diagnostics: []
  });
}

export function matchParamMetadataPackage(
  input: unknown,
  descriptor: ParamMetadataDefinitionKey,
  trustPolicy: unknown
): ParamMetadataMatchResult {
  const packageValidation = validateParamMetadataPackage(input);
  return matchValidatedParamMetadataPackage(packageValidation, descriptor, trustPolicy);
}

function matchValidatedParamMetadataPackage(
  packageValidation: ParamMetadataPackageValidation,
  descriptorInput: unknown,
  trustPolicyInput: unknown
): ParamMetadataMatchResult {
  const diagnostics = [...packageValidation.diagnostics];
  const descriptorSnapshot = snapshotUntrustedInput(
    descriptorInput,
    'PARAM_METADATA_DEFINITION_KEY_SNAPSHOT_FAILED',
    '$descriptor',
    'Definition key'
  );
  const trustPolicySnapshot: ParamMetadataSnapshotResult = trustPolicyInput === undefined
    ? { ok: true, value: undefined }
    : snapshotUntrustedInput(
        trustPolicyInput,
        'PARAM_METADATA_TRUST_POLICY_SNAPSHOT_FAILED',
        '$policy',
        'Trust policy'
      );
  if (!descriptorSnapshot.ok) appendDiagnostic(diagnostics, descriptorSnapshot.diagnostic);
  if (!trustPolicySnapshot.ok) appendDiagnostic(diagnostics, trustPolicySnapshot.diagnostic);

  const trustDiagnostics = trustPolicySnapshot.ok
    ? validateTrustPolicy(trustPolicySnapshot.value)
    : [];
  appendDiagnostics(diagnostics, trustDiagnostics);

  if (!packageValidation.ok) return rejectedMatch(diagnostics);
  const metadataPackage = packageValidation.package;
  if (trustPolicySnapshot.ok && trustDiagnostics.length === 0) {
    validatePackageTrust(
      metadataPackage,
      trustPolicySnapshot.value as ParamMetadataTrustPolicy,
      diagnostics
    );
  }

  const descriptorDiagnostics = descriptorSnapshot.ok
    ? validateDefinitionKey(descriptorSnapshot.value, '$descriptor')
    : [];
  appendDiagnostics(diagnostics, descriptorDiagnostics);
  const match = descriptorSnapshot.ok && descriptorDiagnostics.length === 0
    ? findStrictMatch(
        metadataPackage.definitions,
        descriptorSnapshot.value as unknown as ParamMetadataDefinitionKey,
        diagnostics
      )
    : undefined;

  if (diagnostics.length > 0 || match === undefined) return rejectedMatch(diagnostics);
  return deepFreeze({
    ok: true,
    status: 'matched',
    authority: metadataPackage.source.kind === 'synthetic-fixture'
      ? 'fixture-confirmed'
      : 'partial',
    nativeFormatAuthority: false,
    definition: match,
    diagnostics: []
  });
}

export function applyParamMetadataOverlay(
  packageInput: unknown,
  overlayInput: unknown,
  trustPolicy: unknown
): ParamMetadataOverlayResult {
  const overlaySnapshot = snapshotUntrustedInput(
    overlayInput,
    'PARAM_METADATA_OVERLAY_SNAPSHOT_FAILED',
    '$overlay',
    'Metadata overlay'
  );
  if (!overlaySnapshot.ok) return rejectedOverlay([overlaySnapshot.diagnostic]);

  const overlayDiagnostics = validateOverlay(overlaySnapshot.value);
  if (overlayDiagnostics.length > 0 || !isRecord(overlaySnapshot.value)) {
    return rejectedOverlay(overlayDiagnostics);
  }
  const overlay = overlaySnapshot.value as unknown as ParamMetadataOverlay;
  const packageValidation = validateParamMetadataPackage(packageInput);
  const match = matchValidatedParamMetadataPackage(packageValidation, overlay.target, trustPolicy);
  if (!match.ok || !packageValidation.ok) return rejectedOverlay(match.diagnostics);
  const metadataPackage = packageValidation.package;
  const diagnostics: ParamMetadataDiagnostic[] = [];

  if (overlay.basePackageDigest !== metadataPackage.packageDigest) {
    add(
      diagnostics,
      'PARAM_METADATA_OVERLAY_STALE_PACKAGE',
      '$overlay.basePackageDigest',
      'Overlay base package digest does not match the selected package.'
    );
  }
  if (overlay.expectedBaseDefinitionDigest !== match.definition.definitionDigest) {
    add(
      diagnostics,
      'PARAM_METADATA_OVERLAY_STALE_DEFINITION',
      '$overlay.expectedBaseDefinitionDigest',
      'Overlay base definition digest does not match the selected definition.'
    );
  }

  const document = cloneDefinition(match.definition.document);
  const lookup = buildOverlayLookup(document);
  for (let index = 0; index < overlay.operations.length; index += 1) {
    applyOverlayOperation(document, lookup, overlay.operations[index]!, index, diagnostics);
  }
  const layout = validateParamDef(document);
  for (const diagnostic of layout.diagnostics) {
    if (diagnostic.severity === 'error') {
      add(
        diagnostics,
        diagnostic.code,
        '$overlay.result',
        diagnostic.message
      );
    }
  }
  if (diagnostics.length > 0) return rejectedOverlay(diagnostics);

  return deepFreeze({
    ok: true,
    status: 'applied',
    authority: match.authority,
    nativeFormatAuthority: false,
    document,
    baseDefinitionDigest: match.definition.definitionDigest,
    effectiveDefinitionDigest: computeParamMetadataDefinitionDigest({
      key: match.definition.key,
      document
    }),
    diagnostics: []
  });
}

function validateSource(input: unknown, diagnostics: ParamMetadataDiagnostic[]): void {
  if (!isRecord(input)) {
    add(diagnostics, 'PARAM_METADATA_SOURCE_MISSING', '$.source', 'Source provenance is required.');
    return;
  }
  validateExactKeys(input, SOURCE_KEYS, '$.source', diagnostics);
  if (typeof input.kind !== 'string'
    || !(SOURCE_KINDS as readonly string[]).includes(input.kind)) {
    add(diagnostics, 'PARAM_METADATA_SOURCE_KIND_INVALID', '$.source.kind', 'Source kind is unsupported.');
  }
  if (!isValidSourceIdentity(input.identity)) {
    add(
      diagnostics,
      'PARAM_METADATA_SOURCE_IDENTITY_INVALID',
      '$.source.identity',
      'A stable non-local source identity is required.'
    );
  }
  if (typeof input.revision !== 'string' || !IMMUTABLE_REVISION.test(input.revision)) {
    add(
      diagnostics,
      'PARAM_METADATA_SOURCE_REVISION_NOT_IMMUTABLE',
      '$.source.revision',
      'Source revision must be an immutable git commit or SHA-256 digest.'
    );
  }
  validateDigest(
    input.contentDigest,
    '$.source.contentDigest',
    'PARAM_METADATA_SOURCE_DIGEST_INVALID',
    diagnostics
  );
}

function validateLicense(input: unknown, diagnostics: ParamMetadataDiagnostic[]): void {
  if (!isRecord(input)) {
    add(diagnostics, 'PARAM_METADATA_LICENSE_MISSING', '$.license', 'License provenance is required.');
    return;
  }
  validateExactKeys(input, LICENSE_KEYS, '$.license', diagnostics);
  if (!isTrimmedText(input.spdxExpression, 1, 256)
    || !isValidSpdxExpression(input.spdxExpression as string)) {
    add(
      diagnostics,
      'PARAM_METADATA_LICENSE_SPDX_INVALID',
      '$.license.spdxExpression',
      'A bounded SPDX expression or LicenseRef is required.'
    );
  }
  validateDigest(
    input.textDigest,
    '$.license.textDigest',
    'PARAM_METADATA_LICENSE_TEXT_DIGEST_INVALID',
    diagnostics
  );
  if (input.redistribution !== 'external-only' && input.redistribution !== 'permitted') {
    add(
      diagnostics,
      'PARAM_METADATA_LICENSE_REDISTRIBUTION_INVALID',
      '$.license.redistribution',
      'Redistribution policy must be explicit.'
    );
  }
}

function validateDefinitions(input: unknown, diagnostics: ParamMetadataDiagnostic[]): void {
  if (!Array.isArray(input) || input.length === 0) {
    add(
      diagnostics,
      'PARAM_METADATA_DEFINITIONS_EMPTY',
      '$.definitions',
      'At least one metadata definition is required.'
    );
    return;
  }
  if (input.length > PARAM_METADATA_MAX_DEFINITIONS) {
    add(
      diagnostics,
      'PARAM_METADATA_DEFINITION_LIMIT_EXCEEDED',
      '$.definitions',
      `At most ${PARAM_METADATA_MAX_DEFINITIONS} definitions are allowed in one package.`
    );
    return;
  }
  if (!validateDenseMetadataArray(
    input,
    '$.definitions',
    'PARAM_METADATA_DEFINITION_ARRAY_SPARSE',
    diagnostics
  )) return;
  if (!validateAggregateDefinitionLimits(input, diagnostics)) return;
  const keys = new Set<string>();
  input.forEach((value, index) => {
    const path = `$.definitions[${index}]`;
    const definitionDiagnosticStart = diagnostics.length;
    if (!isRecord(value)) {
      add(diagnostics, 'PARAM_METADATA_DEFINITION_INVALID', path, 'Definition must be an object.');
      return;
    }
    validateExactKeys(value, DEFINITION_KEYS, path, diagnostics);
    const keyDiagnostics = validateDefinitionKey(value.key, `${path}.key`);
    appendDiagnostics(diagnostics, keyDiagnostics);
    if (keyDiagnostics.length === 0) {
      const serialized = serializeKey(value.key as ParamMetadataDefinitionKey);
      if (keys.has(serialized)) {
        add(
          diagnostics,
          'PARAM_METADATA_DEFINITION_DUPLICATE',
          `${path}.key`,
          'Definition key must be unique within a package.'
        );
      }
      keys.add(serialized);
    }
    validateDigest(
      value.definitionDigest,
      `${path}.definitionDigest`,
      'PARAM_METADATA_DEFINITION_DIGEST_INVALID',
      diagnostics
    );
    validateDefinitionDocument(value, path, diagnostics);
    if (diagnostics.length === definitionDiagnosticStart
      && typeof value.definitionDigest === 'string'
      && SHA256_DIGEST.test(value.definitionDigest)) {
      try {
        const calculated = computeParamMetadataDefinitionDigest(
          value as unknown as ParamMetadataDefinition
        );
        if (calculated !== value.definitionDigest) {
          add(
            diagnostics,
            'PARAM_METADATA_DEFINITION_DIGEST_MISMATCH',
            `${path}.definitionDigest`,
            'Definition digest does not match its canonical key and document.'
          );
        }
      } catch (error) {
        add(
          diagnostics,
          'PARAM_METADATA_DEFINITION_DIGEST_UNCOMPUTABLE',
          `${path}.definitionDigest`,
          error instanceof Error ? error.message : 'Definition digest could not be computed.'
        );
      }
    }
  });
}

function validateAggregateDefinitionLimits(
  definitions: unknown[],
  diagnostics: ParamMetadataDiagnostic[]
): boolean {
  let fieldCount = 0;
  let enumCount = 0;
  let enumValueCount = 0;
  for (const definition of definitions) {
    if (!isRecord(definition) || !isRecord(definition.document)) continue;
    const { document } = definition;
    if (Array.isArray(document.fields)) {
      fieldCount += document.fields.length;
      if (fieldCount > PARAM_METADATA_MAX_TOTAL_FIELDS) {
        add(
          diagnostics,
          'PARAM_METADATA_TOTAL_FIELD_LIMIT_EXCEEDED',
          '$.definitions',
          `A package may contain at most ${PARAM_METADATA_MAX_TOTAL_FIELDS} fields in total.`
        );
        return false;
      }
    }
    if (!Array.isArray(document.enums)) continue;
    enumCount += document.enums.length;
    if (enumCount > PARAM_METADATA_MAX_TOTAL_ENUMS) {
      add(
        diagnostics,
        'PARAM_METADATA_TOTAL_ENUM_LIMIT_EXCEEDED',
        '$.definitions',
        `A package may contain at most ${PARAM_METADATA_MAX_TOTAL_ENUMS} enums in total.`
      );
      return false;
    }
    for (const enumDef of document.enums) {
      if (!isRecord(enumDef) || !Array.isArray(enumDef.values)) continue;
      enumValueCount += enumDef.values.length;
      if (enumValueCount > PARAM_METADATA_MAX_TOTAL_ENUM_VALUES) {
        add(
          diagnostics,
          'PARAM_METADATA_TOTAL_ENUM_VALUE_LIMIT_EXCEEDED',
          '$.definitions',
          `A package may contain at most ${PARAM_METADATA_MAX_TOTAL_ENUM_VALUES} enum values in total.`
        );
        return false;
      }
    }
  }
  return true;
}

function validateDefinitionDocument(
  definition: Record<string, unknown>,
  path: string,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  if (!isRecord(definition.document)) {
    add(
      diagnostics,
      'PARAM_METADATA_DEFINITION_DOCUMENT_INVALID',
      `${path}.document`,
      'Definition document must be an object.'
    );
    return;
  }
  const layout = validateParamDef(definition.document as unknown as ParamDefDocument);
  for (const diagnostic of layout.diagnostics) {
    if (diagnostic.severity === 'error') {
      add(diagnostics, diagnostic.code, `${path}.document`, diagnostic.message);
    }
  }
  if (!isRecord(definition.key)) return;
  const key = definition.key;
  const document = definition.document;
  if (key.typeName !== document.typeName
    || key.dataVersion !== document.version
    || key.rowDataSize !== document.rowDataSize) {
    add(
      diagnostics,
      'PARAM_METADATA_DEFINITION_KEY_DRIFT',
      `${path}.key`,
      'Definition key must exactly match document typeName, version, and rowDataSize.'
    );
  }
}

function validateTrustPolicy(input: unknown): ParamMetadataDiagnostic[] {
  const diagnostics: ParamMetadataDiagnostic[] = [];
  if (!isRecord(input)) {
    add(
      diagnostics,
      'PARAM_METADATA_TRUST_POLICY_REQUIRED',
      '$policy',
      'An explicit user trust policy is required.'
    );
    return diagnostics;
  }
  validateExactKeys(input, TRUST_POLICY_KEYS, '$policy', diagnostics);
  if (input.schemaVersion !== 1) {
    add(
      diagnostics,
      'PARAM_METADATA_TRUST_POLICY_SCHEMA_UNSUPPORTED',
      '$policy.schemaVersion',
      'Only trust policy schemaVersion 1 is supported.'
    );
  }
  validateStableId(
    input.policyId,
    '$policy.policyId',
    'PARAM_METADATA_TRUST_POLICY_ID_INVALID',
    diagnostics
  );
  if (!Array.isArray(input.trustedPackages) || input.trustedPackages.length === 0) {
    add(
      diagnostics,
      'PARAM_METADATA_TRUST_POLICY_EMPTY',
      '$policy.trustedPackages',
      'Trust policy must contain at least one exact package entry.'
    );
    return diagnostics;
  }
  if (input.trustedPackages.length > PARAM_METADATA_MAX_TRUST_ENTRIES) {
    add(
      diagnostics,
      'PARAM_METADATA_TRUST_ENTRY_LIMIT_EXCEEDED',
      '$policy.trustedPackages',
      `At most ${PARAM_METADATA_MAX_TRUST_ENTRIES} trust entries are allowed in one policy.`
    );
    return diagnostics;
  }
  if (!validateDenseMetadataArray(
    input.trustedPackages,
    '$policy.trustedPackages',
    'PARAM_METADATA_TRUST_ENTRY_ARRAY_SPARSE',
    diagnostics
  )) return diagnostics;
  const packageDigests = new Set<string>();
  input.trustedPackages.forEach((entry, index) => {
    const path = `$policy.trustedPackages[${index}]`;
    if (!isRecord(entry)) {
      add(diagnostics, 'PARAM_METADATA_TRUST_ENTRY_INVALID', path, 'Trust entry must be an object.');
      return;
    }
    validateExactKeys(entry, TRUST_ENTRY_KEYS, path, diagnostics);
    validateStableId(entry.packageId, `${path}.packageId`, 'PARAM_METADATA_TRUST_ENTRY_INVALID', diagnostics);
    validateStableId(
      entry.packageVersion,
      `${path}.packageVersion`,
      'PARAM_METADATA_TRUST_ENTRY_INVALID',
      diagnostics
    );
    for (const [key, value] of [
      ['packageDigest', entry.packageDigest],
      ['sourceContentDigest', entry.sourceContentDigest],
      ['licenseTextDigest', entry.licenseTextDigest]
    ] as const) {
      validateDigest(value, `${path}.${key}`, 'PARAM_METADATA_TRUST_ENTRY_DIGEST_INVALID', diagnostics);
    }
    if (!isValidSourceIdentity(entry.sourceIdentity)) {
      add(
        diagnostics,
        'PARAM_METADATA_TRUST_ENTRY_INVALID',
        `${path}.sourceIdentity`,
        'Trusted source identity is required.'
      );
    }
    if (typeof entry.sourceRevision !== 'string' || !IMMUTABLE_REVISION.test(entry.sourceRevision)) {
      add(
        diagnostics,
        'PARAM_METADATA_TRUST_ENTRY_INVALID',
        `${path}.sourceRevision`,
        'Trusted source revision must be immutable.'
      );
    }
    if (!isTrimmedText(entry.licenseSpdxExpression, 1, 256)
      || !isValidSpdxExpression(entry.licenseSpdxExpression as string)) {
      add(
        diagnostics,
        'PARAM_METADATA_TRUST_ENTRY_SPDX_INVALID',
        `${path}.licenseSpdxExpression`,
        'Trusted SPDX expression is syntactically invalid.'
      );
    }
    if (typeof entry.packageDigest === 'string') {
      if (packageDigests.has(entry.packageDigest)) {
        add(
          diagnostics,
          'PARAM_METADATA_TRUST_ENTRY_DUPLICATE',
          `${path}.packageDigest`,
          'Trusted package digest must be unique.'
        );
      }
      packageDigests.add(entry.packageDigest);
    }
  });
  return diagnostics;
}

function validatePackageTrust(
  metadataPackage: ParamMetadataPackage,
  policy: ParamMetadataTrustPolicy,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  const exact = policy.trustedPackages.find((entry) =>
    entry.packageId === metadataPackage.packageId
    && entry.packageVersion === metadataPackage.packageVersion
    && entry.packageDigest === metadataPackage.packageDigest
    && entry.sourceIdentity === metadataPackage.source.identity
    && entry.sourceRevision === metadataPackage.source.revision
    && entry.sourceContentDigest === metadataPackage.source.contentDigest
    && entry.licenseSpdxExpression === metadataPackage.license.spdxExpression
    && entry.licenseTextDigest === metadataPackage.license.textDigest
  );
  if (exact === undefined) {
    add(
      diagnostics,
      'PARAM_METADATA_PACKAGE_NOT_TRUSTED',
      '$policy.trustedPackages',
      'No exact content-addressed trust entry matches this package.'
    );
  }
}

function findStrictMatch(
  definitions: ParamMetadataDefinition[],
  descriptor: ParamMetadataDefinitionKey,
  diagnostics: ParamMetadataDiagnostic[]
): ParamMetadataDefinition | undefined {
  let candidates = definitions;
  const dimensions: Array<{
    property: keyof ParamMetadataDefinitionKey;
    code: string;
  }> = [
    { property: 'game', code: 'PARAM_METADATA_GAME_MISMATCH' },
    { property: 'gameBuild', code: 'PARAM_METADATA_GAME_BUILD_MISMATCH' },
    { property: 'typeName', code: 'PARAM_METADATA_TYPE_NAME_MISMATCH' },
    { property: 'dataVersion', code: 'PARAM_METADATA_DATA_VERSION_MISMATCH' },
    { property: 'rowDataSize', code: 'PARAM_METADATA_ROW_DATA_SIZE_MISMATCH' }
  ];
  for (const dimension of dimensions) {
    const narrowed = candidates.filter(
      (definition) => definition.key[dimension.property] === descriptor[dimension.property]
    );
    if (narrowed.length === 0) {
      add(
        diagnostics,
        dimension.code,
        `$descriptor.${dimension.property}`,
        `No definition matches ${dimension.property} exactly.`
      );
      return undefined;
    }
    candidates = narrowed;
  }
  if (candidates.length !== 1) {
    add(
      diagnostics,
      'PARAM_METADATA_MATCH_AMBIGUOUS',
      '$.definitions',
      'Strict metadata matching must resolve to exactly one definition.'
    );
    return undefined;
  }
  return candidates[0];
}

function validateDefinitionKey(input: unknown, path: string): ParamMetadataDiagnostic[] {
  const diagnostics: ParamMetadataDiagnostic[] = [];
  if (!isRecord(input)) {
    add(diagnostics, 'PARAM_METADATA_DEFINITION_KEY_INVALID', path, 'Definition key must be an object.');
    return diagnostics;
  }
  validateExactKeys(input, MATCH_KEY_KEYS, path, diagnostics);
  for (const property of ['game', 'gameBuild', 'typeName'] as const) {
    if (!isTrimmedText(input[property], 1, 128)
      || !MATCH_TEXT.test(input[property] as string)) {
      add(
        diagnostics,
        'PARAM_METADATA_DEFINITION_KEY_INVALID',
        `${path}.${property}`,
        `${property} must be an exact, bounded identifier.`
      );
    }
  }
  if (!Number.isSafeInteger(input.dataVersion)
    || (input.dataVersion as number) < 0
    || (input.dataVersion as number) > 65_535) {
    add(
      diagnostics,
      'PARAM_METADATA_DEFINITION_KEY_INVALID',
      `${path}.dataVersion`,
      'dataVersion must be an unsigned 16-bit integer.'
    );
  }
  if (!Number.isSafeInteger(input.rowDataSize)
    || (input.rowDataSize as number) <= 0
    || (input.rowDataSize as number) > 65_536) {
    add(
      diagnostics,
      'PARAM_METADATA_DEFINITION_KEY_INVALID',
      `${path}.rowDataSize`,
      'rowDataSize must be an integer between 1 and 65536.'
    );
  }
  return diagnostics;
}

function validateOverlay(input: unknown): ParamMetadataDiagnostic[] {
  const diagnostics: ParamMetadataDiagnostic[] = [];
  if (!isRecord(input)) {
    add(diagnostics, 'PARAM_METADATA_OVERLAY_NOT_OBJECT', '$overlay', 'Overlay must be an object.');
    return diagnostics;
  }
  validateExactKeys(input, OVERLAY_KEYS, '$overlay', diagnostics);
  if (input.schemaVersion !== 1) {
    add(
      diagnostics,
      'PARAM_METADATA_OVERLAY_SCHEMA_UNSUPPORTED',
      '$overlay.schemaVersion',
      'Only overlay schemaVersion 1 is supported.'
    );
  }
  validateStableId(input.overlayId, '$overlay.overlayId', 'PARAM_METADATA_OVERLAY_ID_INVALID', diagnostics);
  validateStableId(
    input.overlayVersion,
    '$overlay.overlayVersion',
    'PARAM_METADATA_OVERLAY_VERSION_INVALID',
    diagnostics
  );
  if (input.origin !== 'user') {
    add(
      diagnostics,
      'PARAM_METADATA_OVERLAY_ORIGIN_INVALID',
      '$overlay.origin',
      'Only explicit user overlays are accepted.'
    );
  }
  validateDigest(
    input.basePackageDigest,
    '$overlay.basePackageDigest',
    'PARAM_METADATA_OVERLAY_BASE_DIGEST_INVALID',
    diagnostics
  );
  validateDigest(
    input.expectedBaseDefinitionDigest,
    '$overlay.expectedBaseDefinitionDigest',
    'PARAM_METADATA_OVERLAY_DEFINITION_DIGEST_INVALID',
    diagnostics
  );
  appendDiagnostics(diagnostics, validateDefinitionKey(input.target, '$overlay.target'));
  validateOverlayOperations(input.operations, diagnostics);
  return diagnostics;
}

function validateOverlayOperations(
  input: unknown,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  if (!Array.isArray(input) || input.length === 0) {
    add(
      diagnostics,
      'PARAM_METADATA_OVERLAY_OPERATIONS_EMPTY',
      '$overlay.operations',
      'Overlay must contain at least one display-only operation.'
    );
    return;
  }
  if (input.length > PARAM_METADATA_MAX_OVERLAY_OPERATIONS) {
    add(
      diagnostics,
      'PARAM_METADATA_OVERLAY_OPERATION_LIMIT_EXCEEDED',
      '$overlay.operations',
      `At most ${PARAM_METADATA_MAX_OVERLAY_OPERATIONS} overlay operations are allowed.`
    );
    return;
  }
  if (!validateDenseMetadataArray(
    input,
    '$overlay.operations',
    'PARAM_METADATA_OVERLAY_OPERATION_ARRAY_SPARSE',
    diagnostics
  )) return;
  const targets = new Set<string>();
  input.forEach((operation, index) => {
    const path = `$overlay.operations[${index}]`;
    const diagnosticStart = diagnostics.length;
    if (!isRecord(operation)) {
      add(diagnostics, 'PARAM_METADATA_OVERLAY_OPERATION_INVALID', path, 'Operation must be an object.');
      return;
    }
    const allowed = overlayOperationKeys(operation.kind);
    if (allowed === undefined) {
      add(
        diagnostics,
        'PARAM_METADATA_OVERLAY_IDENTITY_LAYOUT_MUTATION',
        path,
        'Overlay operation is not display metadata and is forbidden.'
      );
      return;
    }
    for (const key of Object.keys(operation)) {
      if (!allowed.has(key)) {
        add(
          diagnostics,
          'PARAM_METADATA_OVERLAY_IDENTITY_LAYOUT_MUTATION',
          `${path}.${key}`,
          'Overlay operations may not contain identity or layout fields.'
        );
      }
    }
    validateOverlayOperationValues(operation, path, diagnostics);
    if (diagnostics.length !== diagnosticStart) return;
    const target = overlayOperationTarget(operation as unknown as ParamMetadataOverlayOperation);
    if (targets.has(target)) {
      add(
        diagnostics,
        'PARAM_METADATA_OVERLAY_TARGET_DUPLICATE',
        path,
        'An overlay may change each display metadata target only once.'
      );
    }
    targets.add(target);
  });
}

function validateOverlayOperationValues(
  operation: Record<string, unknown>,
  path: string,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  switch (operation.kind) {
    case 'set-definition-notes':
      validateDisplayText(operation.value, `${path}.value`, true, diagnostics);
      return;
    case 'set-field-display-name':
    case 'set-field-description':
      validateStableId(operation.fieldId, `${path}.fieldId`, 'PARAM_METADATA_OVERLAY_TARGET_INVALID', diagnostics);
      validateDisplayText(
        operation.value,
        `${path}.value`,
        operation.kind === 'set-field-description',
        diagnostics
      );
      return;
    case 'set-enum-display-name':
      validateStableId(operation.enumId, `${path}.enumId`, 'PARAM_METADATA_OVERLAY_TARGET_INVALID', diagnostics);
      validateDisplayText(operation.value, `${path}.value`, false, diagnostics);
      return;
    case 'set-enum-value-label':
      validateStableId(operation.enumId, `${path}.enumId`, 'PARAM_METADATA_OVERLAY_TARGET_INVALID', diagnostics);
      if (!Number.isSafeInteger(operation.valueId)) {
        add(
          diagnostics,
          'PARAM_METADATA_OVERLAY_TARGET_INVALID',
          `${path}.valueId`,
          'Enum value target must be an integer.'
        );
      }
      validateDisplayText(operation.label, `${path}.label`, false, diagnostics);
      return;
    default:
      return;
  }
}

function applyOverlayOperation(
  document: ParamDefDocument,
  lookup: ParamMetadataOverlayLookup,
  operation: ParamMetadataOverlayOperation,
  index: number,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  const path = `$overlay.operations[${index}]`;
  switch (operation.kind) {
    case 'set-definition-notes':
      document.notes = operation.value;
      return;
    case 'set-field-display-name': {
      const field = lookup.fields.get(operation.fieldId);
      if (field === undefined) {
        add(diagnostics, 'PARAM_METADATA_OVERLAY_FIELD_MISSING', path, 'Overlay field target does not exist.');
      } else {
        field.name = operation.value;
      }
      return;
    }
    case 'set-field-description': {
      const field = lookup.fields.get(operation.fieldId);
      if (field === undefined) {
        add(diagnostics, 'PARAM_METADATA_OVERLAY_FIELD_MISSING', path, 'Overlay field target does not exist.');
      } else {
        field.description = operation.value;
      }
      return;
    }
    case 'set-enum-display-name': {
      const enumDef = lookup.enums.get(operation.enumId);
      if (enumDef === undefined) {
        add(diagnostics, 'PARAM_METADATA_OVERLAY_ENUM_MISSING', path, 'Overlay enum target does not exist.');
      } else {
        enumDef.name = operation.value;
      }
      return;
    }
    case 'set-enum-value-label': {
      const enumDef = lookup.enums.get(operation.enumId);
      if (enumDef === undefined) {
        add(diagnostics, 'PARAM_METADATA_OVERLAY_ENUM_MISSING', path, 'Overlay enum target does not exist.');
        return;
      }
      const enumValue = lookup.enumValues.get(operation.enumId)?.get(operation.valueId);
      if (enumValue === undefined) {
        add(
          diagnostics,
          'PARAM_METADATA_OVERLAY_ENUM_VALUE_MISSING',
          path,
          'Overlay enum value target does not exist.'
        );
      } else {
        enumValue.label = operation.label;
      }
      return;
    }
  }
}

interface ParamMetadataOverlayLookup {
  fields: Map<string, ParamDefDocument['fields'][number]>;
  enums: Map<string, NonNullable<ParamDefDocument['enums']>[number]>;
  enumValues: Map<
    string,
    Map<number, NonNullable<ParamDefDocument['enums']>[number]['values'][number]>
  >;
}

function buildOverlayLookup(document: ParamDefDocument): ParamMetadataOverlayLookup {
  const fields = new Map(document.fields.map((field) => [field.id, field]));
  const enums = new Map((document.enums ?? []).map((enumDef) => [enumDef.id, enumDef]));
  const enumValues = new Map(
    (document.enums ?? []).map((enumDef) => [
      enumDef.id,
      new Map(enumDef.values.map((entry) => [entry.value, entry]))
    ])
  );
  return { fields, enums, enumValues };
}

function overlayOperationKeys(kind: unknown): ReadonlySet<string> | undefined {
  switch (kind) {
    case 'set-definition-notes':
      return new Set(['kind', 'value']);
    case 'set-field-display-name':
    case 'set-field-description':
      return new Set(['kind', 'fieldId', 'value']);
    case 'set-enum-display-name':
      return new Set(['kind', 'enumId', 'value']);
    case 'set-enum-value-label':
      return new Set(['kind', 'enumId', 'valueId', 'label']);
    default:
      return undefined;
  }
}

function overlayOperationTarget(operation: ParamMetadataOverlayOperation): string {
  switch (operation.kind) {
    case 'set-definition-notes':
      return 'definition:notes';
    case 'set-field-display-name':
      return `field:${operation.fieldId}:name`;
    case 'set-field-description':
      return `field:${operation.fieldId}:description`;
    case 'set-enum-display-name':
      return `enum:${operation.enumId}:name`;
    case 'set-enum-value-label':
      return `enum:${operation.enumId}:value:${operation.valueId}:label`;
  }
}

function validateDisplayText(
  input: unknown,
  path: string,
  allowEmpty: boolean,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  const minimum = allowEmpty ? 0 : 1;
  if (!isTrimmedText(input, minimum, 16_384)) {
    add(
      diagnostics,
      'PARAM_METADATA_OVERLAY_DISPLAY_TEXT_INVALID',
      path,
      'Display text is missing, unbounded, or contains surrounding whitespace.'
    );
  }
}

function validateExactKeys(
  input: Record<string, unknown>,
  expected: ReadonlySet<string>,
  path: string,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  for (const key of expected) {
    if (!Object.hasOwn(input, key)) {
      add(
        diagnostics,
        'PARAM_METADATA_REQUIRED_FIELD_MISSING',
        `${path}.${key}`,
        'Required metadata field is missing.'
      );
    }
  }
  for (const key of Object.keys(input)) {
    if (!expected.has(key)) {
      add(
        diagnostics,
        'PARAM_METADATA_UNKNOWN_FIELD',
        `${path}.${key}`,
        'Unknown metadata fields are rejected.'
      );
    }
  }
}

function validateDenseMetadataArray(
  input: unknown[],
  path: string,
  code: string,
  diagnostics: ParamMetadataDiagnostic[]
): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      add(
        diagnostics,
        code,
        `${path}[${index}]`,
        'Sparse arrays are not valid metadata.'
      );
      return false;
    }
  }
  return true;
}

function validateStableId(
  input: unknown,
  path: string,
  code: string,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  if (typeof input !== 'string' || !STABLE_ID.test(input)) {
    add(diagnostics, code, path, 'A stable, bounded identifier is required.');
  }
}

function validateDigest(
  input: unknown,
  path: string,
  code: string,
  diagnostics: ParamMetadataDiagnostic[]
): void {
  if (typeof input !== 'string' || !SHA256_DIGEST.test(input)) {
    add(diagnostics, code, path, 'A lowercase sha256:<64 hex> digest is required.');
  }
}

function serializeKey(key: ParamMetadataDefinitionKey): string {
  return JSON.stringify([
    key.game,
    key.gameBuild,
    key.typeName,
    key.dataVersion,
    key.rowDataSize
  ]);
}

function cloneDefinition(document: ParamDefDocument): ParamDefDocument {
  const snapshot = snapshotUntrustedInput(
    document,
    'PARAM_METADATA_DEFINITION_SNAPSHOT_FAILED',
    '$.definition.document',
    'Metadata definition'
  );
  if (!snapshot.ok || !isRecord(snapshot.value)) {
    throw new Error('Validated metadata definition could not be copied.');
  }
  return snapshot.value as unknown as ParamDefDocument;
}

type ParamMetadataSnapshotResult =
  | { ok: true; value: unknown }
  | { ok: false; diagnostic: ParamMetadataDiagnostic };

interface ParamMetadataSnapshotState {
  active: WeakSet<object>;
  nodes: number;
  canonicalUtf8Bytes: number;
}

function snapshotUntrustedInput(
  input: unknown,
  code: string,
  path: string,
  label: string
): ParamMetadataSnapshotResult {
  try {
    return {
      ok: true,
      value: clonePlainData(input, {
        active: new WeakSet<object>(),
        nodes: 0,
        canonicalUtf8Bytes: 0
      }, 0)
    };
  } catch {
    return {
      ok: false,
      diagnostic: {
        severity: 'error',
        code,
        path,
        message: `${label} could not be copied into an isolated plain-data snapshot.`
      }
    };
  }
}

function clonePlainData(
  input: unknown,
  state: ParamMetadataSnapshotState,
  depth: number
): unknown {
  state.nodes += 1;
  if (state.nodes > PARAM_METADATA_SNAPSHOT_MAX_NODES) {
    throw new Error('Metadata snapshot node limit exceeded.');
  }
  if (depth > PARAM_METADATA_SNAPSHOT_MAX_DEPTH) {
    throw new Error('Metadata snapshot depth limit exceeded.');
  }
  if (input === undefined) {
    throw new Error('Metadata snapshot cannot contain undefined values.');
  }
  if (input === null) {
    chargeCanonicalUtf8Bytes(state, 4);
    return input;
  }
  if (typeof input === 'string') {
    chargeCanonicalUtf8Bytes(state, jsonStringUtf8Bytes(input));
    return input;
  }
  if (typeof input === 'number') {
    chargeCanonicalUtf8Bytes(
      state,
      Number.isFinite(input) ? Buffer.byteLength(String(Object.is(input, -0) ? 0 : input), 'utf8') : 4
    );
    return input;
  }
  if (typeof input === 'boolean') {
    chargeCanonicalUtf8Bytes(state, input ? 4 : 5);
    return input;
  }
  if (typeof input === 'bigint') {
    chargeCanonicalUtf8Bytes(state, Buffer.byteLength(String(input), 'utf8'));
    return input;
  }
  if (nodeUtilTypes.isProxy(input)) {
    throw new Error('Metadata snapshot cannot contain proxies.');
  }
  if (typeof input === 'symbol' || typeof input === 'function') {
    chargeCanonicalUtf8Bytes(state, 2);
    return {};
  }
  if (state.active.has(input)) {
    throw new Error('Metadata snapshot cannot contain cycles.');
  }

  state.active.add(input);
  try {
    assertSnapshotOwnPropertiesAreData(input);
    if (Array.isArray(input)) {
      if (input.length > PARAM_METADATA_SNAPSHOT_MAX_ARRAY_LENGTH) {
        throw new Error('Metadata snapshot array limit exceeded.');
      }
      chargeCanonicalUtf8Bytes(state, 2 + Math.max(0, input.length - 1));
      const copy = new Array<unknown>(input.length);
      for (const key of Object.keys(input)) {
        const index = Number(key);
        if (!Number.isSafeInteger(index)
          || index < 0
          || index >= input.length
          || String(index) !== key) {
          throw new Error('Metadata snapshot arrays cannot contain custom enumerable properties.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new Error('Metadata snapshot cannot contain accessors.');
        }
        defineSnapshotProperty(copy, key, clonePlainData(descriptor.value, state, depth + 1));
      }
      return copy;
    }

    const keys = Object.keys(input);
    if (keys.length > PARAM_METADATA_SNAPSHOT_MAX_OBJECT_KEYS) {
      throw new Error('Metadata snapshot object key limit exceeded.');
    }
    chargeCanonicalUtf8Bytes(state, 2 + Math.max(0, keys.length - 1));
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      chargeCanonicalUtf8Bytes(state, jsonStringUtf8Bytes(key) + 1);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Error('Metadata snapshot cannot contain accessors.');
      }
      defineSnapshotProperty(copy, key, clonePlainData(descriptor.value, state, depth + 1));
    }
    return copy;
  } finally {
    state.active.delete(input);
  }
}

function chargeCanonicalUtf8Bytes(state: ParamMetadataSnapshotState, bytes: number): void {
  state.canonicalUtf8Bytes += bytes;
  if (state.canonicalUtf8Bytes > PARAM_METADATA_MAX_CANONICAL_UTF8_BYTES) {
    throw new Error('Metadata snapshot canonical UTF-8 budget exceeded.');
  }
}

function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += code === 0x08
        || code === 0x09
        || code === 0x0a
        || code === 0x0c
        || code === 0x0d
        ? 2
        : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function assertSnapshotOwnPropertiesAreData(input: object): void {
  const ownKeys = Reflect.ownKeys(input);
  const maximum = Array.isArray(input)
    ? PARAM_METADATA_SNAPSHOT_MAX_ARRAY_LENGTH + 1
    : PARAM_METADATA_SNAPSHOT_MAX_OBJECT_KEYS;
  if (ownKeys.length > maximum) {
    throw new Error('Metadata snapshot own-property limit exceeded.');
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor !== undefined && !('value' in descriptor)) {
      throw new Error('Metadata snapshot cannot contain accessors.');
    }
  }
}

function defineSnapshotProperty(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    deepFreeze((objectValue as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (Buffer.byteLength(serialized, 'utf8') > PARAM_METADATA_MAX_CANONICAL_UTF8_BYTES) {
    throw new Error('Canonical metadata exceeds the UTF-8 serialization budget.');
  }
  return serialized;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical metadata cannot contain non-finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) result[key] = canonicalize(entry);
    }
    return result;
  }
  throw new Error(`Canonical metadata contains unsupported value type: ${typeof value}.`);
}

type SpdxNodeKind = 'license' | 'group' | 'compound' | 'with-exception';

/**
 * Validates a dependency-free SPDX expression grammar subset. Registry
 * membership remains a user trust decision pinned by the license text digest.
 */
function isValidSpdxExpression(input: string): boolean {
  const tokenized = tokenizeSpdxExpression(input);
  if (tokenized === undefined || tokenized.length === 0) return false;
  const tokens = tokenized;
  let position = 0;

  const parsePrimary = (): SpdxNodeKind | undefined => {
    const token = tokens[position];
    if (token === '(') {
      position += 1;
      const inner = parseOr();
      if (inner === undefined || tokens[position] !== ')') return undefined;
      position += 1;
      return 'group';
    }
    if (token === undefined || !isSpdxLicenseIdentifier(token)) return undefined;
    position += 1;
    return 'license';
  };

  const parseWith = (): SpdxNodeKind | undefined => {
    const primary = parsePrimary();
    if (primary === undefined) return undefined;
    if (tokens[position] !== 'WITH') return primary;
    if (primary !== 'license') return undefined;
    position += 1;
    const exception = tokens[position];
    if (exception === undefined || !isSpdxExceptionIdentifier(exception)) return undefined;
    position += 1;
    return 'with-exception';
  };

  const parseAnd = (): SpdxNodeKind | undefined => {
    let left = parseWith();
    if (left === undefined) return undefined;
    while (tokens[position] === 'AND') {
      position += 1;
      const right = parseWith();
      if (right === undefined) return undefined;
      left = 'compound';
    }
    return left;
  };

  function parseOr(): SpdxNodeKind | undefined {
    let left = parseAnd();
    if (left === undefined) return undefined;
    while (tokens[position] === 'OR') {
      position += 1;
      const right = parseAnd();
      if (right === undefined) return undefined;
      left = 'compound';
    }
    return left;
  }

  return parseOr() !== undefined && position === tokens.length;
}

function tokenizeSpdxExpression(input: string): string[] | undefined {
  const tokens: string[] = [];
  let position = 0;
  while (position < input.length) {
    const character = input[position]!;
    if (/\s/.test(character)) {
      position += 1;
      continue;
    }
    if (character === '(' || character === ')') {
      tokens.push(character);
      position += 1;
      continue;
    }
    let end = position;
    while (end < input.length && /[A-Za-z0-9.+:-]/.test(input[end]!)) end += 1;
    if (end === position) return undefined;
    tokens.push(input.slice(position, end));
    position = end;
  }
  return tokens;
}

function isSpdxLicenseIdentifier(input: string): boolean {
  if (SPDX_RESERVED_IDENTIFIERS.has(input)) return false;
  if (input.startsWith('LicenseRef-')) return SPDX_LICENSE_REF.test(input);
  if (input.startsWith('DocumentRef-')) return SPDX_DOCUMENT_LICENSE_REF.test(input);
  return SPDX_LICENSE_ID.test(input);
}

function isSpdxExceptionIdentifier(input: string): boolean {
  return !SPDX_RESERVED_IDENTIFIERS.has(input)
    && !input.startsWith('LicenseRef-')
    && !input.startsWith('DocumentRef-')
    && !SPDX_OPERATORS.has(input)
    && SPDX_EXCEPTION_ID.test(input);
}

function isTrimmedText(input: unknown, minimum: number, maximum: number): input is string {
  return typeof input === 'string'
    && input.length >= minimum
    && input.length <= maximum
    && input === input.trim()
    && !/[\u0000-\u001f\u007f]/.test(input);
}

function isValidSourceIdentity(input: unknown): input is string {
  if (!isTrimmedText(input, 1, 512)) return false;
  const normalized = input.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || /^file:/i.test(normalized)) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)) return true;
  return STABLE_ID.test(input) && !input.includes('/') && !input.includes('\\');
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function rejectedPackage(diagnostics: ParamMetadataDiagnostic[]): ParamMetadataPackageValidation {
  return { ok: false, status: 'rejected', nativeFormatAuthority: false, diagnostics };
}

function rejectedMatch(diagnostics: ParamMetadataDiagnostic[]): ParamMetadataMatchResult {
  return {
    ok: false,
    status: 'rejected',
    authority: 'unverified',
    nativeFormatAuthority: false,
    diagnostics
  };
}

function rejectedOverlay(diagnostics: ParamMetadataDiagnostic[]): ParamMetadataOverlayResult {
  return {
    ok: false,
    status: 'rejected',
    authority: 'unverified',
    nativeFormatAuthority: false,
    diagnostics
  };
}

function add(
  diagnostics: ParamMetadataDiagnostic[],
  code: string,
  path: string,
  message: string
): void {
  appendDiagnostic(diagnostics, { severity: 'error', code, path, message });
}

function appendDiagnostics(
  diagnostics: ParamMetadataDiagnostic[],
  additions: readonly ParamMetadataDiagnostic[]
): void {
  for (const diagnostic of additions) appendDiagnostic(diagnostics, diagnostic);
}

function appendDiagnostic(
  diagnostics: ParamMetadataDiagnostic[],
  diagnostic: ParamMetadataDiagnostic
): void {
  if (diagnostics.length >= PARAM_METADATA_MAX_DIAGNOSTICS) return;
  if (diagnostics.length === PARAM_METADATA_MAX_DIAGNOSTICS - 1) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAM_METADATA_DIAGNOSTIC_LIMIT_REACHED',
      path: '$',
      message: `Metadata validation stopped reporting after ${PARAM_METADATA_MAX_DIAGNOSTICS - 1} diagnostics.`
    });
    return;
  }
  diagnostics.push(diagnostic);
}
