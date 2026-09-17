import type { ParamMetadataPackage } from '@soulforge/shared';
import {
  validateParamMetadataPackage,
  type ParamMetadataPackageValidation
} from '../../param/paramMetadata.js';
import {
  computeEmedfRegistryContentDigest,
  validateFirstPartyEmedfRegistry,
  type EmedfRegistry
} from '../../emevd/emedfSchema.js';
import {
  SOULFORGE_SEKIRO_EMEDF_PACKAGE_ID,
  SOULFORGE_SEKIRO_EMEDF_BANK_COUNT,
  SOULFORGE_SEKIRO_EMEDF_CONTENT_DIGEST,
  SOULFORGE_SEKIRO_EMEDF_INSTRUCTION_COUNT,
  SOULFORGE_SEKIRO_PARAM_DEFINITION_COUNT,
  SOULFORGE_SEKIRO_PARAM_PACKAGE_DIGEST,
  SOULFORGE_SEKIRO_PARAM_PACKAGE_ID,
  SOULFORGE_SEKIRO_PARAM_SOURCE_IDENTITY,
  SOULFORGE_SEKIRO_SCHEMA_VERSION
} from './firstPartySchemaContract.js';
import {
  FIRST_PARTY_EMEDF_REGISTRY,
  FIRST_PARTY_PARAM_METADATA_PACKAGE
} from './firstPartySchemaData.js';

export interface FirstPartySchemaDiagnostic {
  severity: 'error';
  code: string;
  message: string;
}

export type FirstPartyParamMetadataLoadResult =
  | { ok: true; package: ParamMetadataPackage; diagnostics: [] }
  | { ok: false; package: null; diagnostics: FirstPartySchemaDiagnostic[] };

export type FirstPartyEmedfLoadResult =
  | { ok: true; registry: EmedfRegistry; diagnostics: [] }
  | { ok: false; registry: null; diagnostics: FirstPartySchemaDiagnostic[] };

let paramLoad: FirstPartyParamMetadataLoadResult | undefined;
let emedfLoad: FirstPartyEmedfLoadResult | undefined;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

const firstPartyParamMetadataPackage = deepFreeze(FIRST_PARTY_PARAM_METADATA_PACKAGE);
const firstPartyEmedfRegistry = deepFreeze(FIRST_PARTY_EMEDF_REGISTRY);

/** Return the immutable bundled PARAM package after its self-check. */
export function loadFirstPartyParamMetadata(): FirstPartyParamMetadataLoadResult {
  if (paramLoad) return paramLoad;
  const validation = validateParamMetadataPackage(firstPartyParamMetadataPackage);
  const diagnostics: FirstPartySchemaDiagnostic[] = validation.ok
    ? []
    : validation.diagnostics.map((diagnostic) => ({
        severity: 'error' as const,
        code: diagnostic.code,
        message: diagnostic.message
      }));
  if (validation.ok) {
    const packageValue = validation.package;
    if (packageValue.source.kind !== 'first-party'
      || packageValue.packageId !== SOULFORGE_SEKIRO_PARAM_PACKAGE_ID
      || packageValue.packageVersion !== SOULFORGE_SEKIRO_SCHEMA_VERSION
      || packageValue.source.identity !== SOULFORGE_SEKIRO_PARAM_SOURCE_IDENTITY
      || packageValue.packageDigest !== SOULFORGE_SEKIRO_PARAM_PACKAGE_DIGEST
      || packageValue.definitions.length !== SOULFORGE_SEKIRO_PARAM_DEFINITION_COUNT
      || packageValue.definitions.some((entry) => entry.document.origin !== 'first-party')) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAM_FIRST_PARTY_SCHEMA_PROVENANCE_MISMATCH',
        message: '内置 PARAM schema 的 first-party provenance 不匹配。'
      });
    }
  }
  paramLoad = diagnostics.length === 0 && validation.ok
    ? { ok: true, package: validation.package, diagnostics: [] }
    : { ok: false, package: null, diagnostics };
  return paramLoad;
}

/** Return the immutable bundled EMEVD registry after its content self-check. */
export function loadFirstPartyEmedfRegistry(): FirstPartyEmedfLoadResult {
  if (emedfLoad) return emedfLoad;
  const validation = validateFirstPartyEmedfRegistry(firstPartyEmedfRegistry);
  const diagnostics: FirstPartySchemaDiagnostic[] = validation.ok
    ? []
    : [{ severity: 'error', code: validation.code, message: validation.message }];
  if (diagnostics.length === 0
    && (firstPartyEmedfRegistry.packageId !== SOULFORGE_SEKIRO_EMEDF_PACKAGE_ID
      || firstPartyEmedfRegistry.packageVersion !== SOULFORGE_SEKIRO_SCHEMA_VERSION
      || firstPartyEmedfRegistry.contentDigest !== SOULFORGE_SEKIRO_EMEDF_CONTENT_DIGEST
      || firstPartyEmedfRegistry.contentDigest !== computeEmedfRegistryContentDigest(firstPartyEmedfRegistry)
      || firstPartyEmedfRegistry.instructions.length !== SOULFORGE_SEKIRO_EMEDF_INSTRUCTION_COUNT
      || firstPartyEmedfRegistry.banks?.length !== SOULFORGE_SEKIRO_EMEDF_BANK_COUNT)) {
    diagnostics.push({
      severity: 'error',
      code: 'EMEDF_FIRST_PARTY_SCHEMA_PROVENANCE_MISMATCH',
      message: '内置 EMEVD schema 的 first-party provenance 不匹配。'
    });
  }
  emedfLoad = diagnostics.length === 0
    ? { ok: true, registry: firstPartyEmedfRegistry, diagnostics: [] }
    : { ok: false, registry: null, diagnostics };
  return emedfLoad;
}

export function getFirstPartyParamMetadataPackage(): ParamMetadataPackage {
  const result = loadFirstPartyParamMetadata();
  if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? '内置 PARAM schema 不可用。');
  return result.package;
}

export function getFirstPartyEmedfRegistry(): EmedfRegistry {
  const result = loadFirstPartyEmedfRegistry();
  if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? '内置 EMEVD schema 不可用。');
  return result.registry;
}

/** Exported for production loaders that must turn an internal corruption into a DTO. */
export function validateFirstPartyParamMetadata(): ParamMetadataPackageValidation {
  return validateParamMetadataPackage(firstPartyParamMetadataPackage);
}
