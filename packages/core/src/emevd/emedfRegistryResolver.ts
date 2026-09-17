/**
 * Resolve the production EMEVD semantic registry.
 *
 * Production deliberately has one source of schema truth: the versioned,
 * content-addressed SoulForge first-party package. The optional argument is
 * retained only as a compatibility boundary for old callers; it is rejected
 * with a structured diagnostic and is never read from disk.
 *
 * The C# Bridge remains the authority for native EMEVD bytes. This registry
 * only supplies the semantic instruction/argument vocabulary used by the
 * TypeScript projection and typed mutation layers.
 */

import { createSekiroFixtureEmedf, type EmedfRegistry } from './emedfSchema.js';
import {
  loadFirstPartyEmedfRegistry,
  type FirstPartySchemaDiagnostic
} from '../schema/sekiro/firstPartySchema.js';

export interface EmedfResolutionDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  details?: unknown;
}

export const EMEVD_EXTERNAL_SCHEMA_FORBIDDEN_CODE = 'EMEVD_EXTERNAL_SCHEMA_FORBIDDEN';

export type ProductionEmedfOrigin = 'first-party' | 'fixture';

export interface EmedfResolutionResult {
  registry: EmedfRegistry;
  origin: ProductionEmedfOrigin;
  instructionCount: number;
  bankCount: number;
  packageId?: string;
  packageVersion?: string;
  contentDigest?: `sha256:${string}`;
  diagnostics: EmedfResolutionDiagnostic[];
  /** True when a legacy external schema argument was explicitly rejected. */
  externalSchemaRejected?: boolean;
  /** Compatibility alias for older diagnostics consumers. */
  fallbackReason?: string;
}

function diagnosticFromFirstParty(item: FirstPartySchemaDiagnostic): EmedfResolutionDiagnostic {
  return {
    severity: item.severity,
    code: item.code,
    message: item.message
  };
}

function describeRegistry(
  registry: EmedfRegistry,
  diagnostics: EmedfResolutionDiagnostic[] = [],
  options: Pick<EmedfResolutionResult, 'externalSchemaRejected' | 'fallbackReason'> = {}
): EmedfResolutionResult {
  const bankCount = registry.banks?.length
    ?? new Set(registry.instructions.map((instruction) => instruction.bank)).size;
  return {
    registry,
    origin: registry.origin as ProductionEmedfOrigin,
    instructionCount: registry.instructions.length,
    bankCount,
    ...(registry.packageId !== undefined ? { packageId: registry.packageId } : {}),
    ...(registry.packageVersion !== undefined ? { packageVersion: registry.packageVersion } : {}),
    ...(registry.contentDigest !== undefined ? { contentDigest: registry.contentDigest } : {}),
    diagnostics,
    ...(options.externalSchemaRejected !== undefined
      ? { externalSchemaRejected: options.externalSchemaRejected }
      : {}),
    ...(options.fallbackReason !== undefined ? { fallbackReason: options.fallbackReason } : {})
  };
}

/**
 * Return the built-in SoulForge registry. `externalPath` is intentionally a
 * rejection-only compatibility input; production never scans or reads it.
 */
export function resolveEmevdRegistry(externalPath?: string | null): EmedfResolutionResult {
  const loaded = loadFirstPartyEmedfRegistry();
  if (!loaded.ok || loaded.registry === null) {
    const diagnostics = loaded.diagnostics.map(diagnosticFromFirstParty);
    const fixture = createSekiroFixtureEmedf();
    return describeRegistry(fixture, diagnostics, {
      fallbackReason: diagnostics[0]?.message ?? '内置 EMEVD schema 不可用。'
    });
  }

  // Presence of the legacy argument itself is enough to reject the old
  // contract, including an empty string. Only an omitted/null argument means
  // "use the production default".
  const externalRequested = externalPath !== undefined && externalPath !== null;
  const diagnostics: EmedfResolutionDiagnostic[] = externalRequested
    ? [{
        severity: 'error',
        code: EMEVD_EXTERNAL_SCHEMA_FORBIDDEN_CODE,
        message: '生产 EMEVD 链仅使用 SoulForge 内置 first-party schema，不接受外部 EMEDF 文件。',
        details: { suppliedPath: '[redacted]' }
      }]
    : [];
  return describeRegistry(loaded.registry, diagnostics, externalRequested
    ? { externalSchemaRejected: true }
    : {});
}
