/**
 * EMEDF registry resolution: try external DarkScript3 EMEDF JSON first,
 * fall back to the built-in fixture.
 *
 * SoulForge does NOT bundle EMEDF data. The external file is read from
 * a user-provided path (e.g. their DarkScript3 installation).
 */

import { readFileSync } from 'node:fs';
import { createSekiroFixtureEmedf, type EmedfRegistry } from './emedfSchema.js';
import { parseDs3EmedfJson } from './emedfExternalAdapter.js';

export interface EmedfResolutionResult {
  registry: EmedfRegistry;
  origin: 'fixture' | 'imported';
  /** Present when origin is 'imported'. */
  instructionCount?: number;
  bankCount?: number;
  /** Present when an external path was attempted but failed. */
  fallbackReason?: string;
}

/**
 * Resolve the EMEDF registry for EMEVD editing.
 *
 * @param externalPath Optional absolute path to a DarkScript3-format
 *   `sekiro-common.emedf.json`. When provided and readable, the imported
 *   registry is used. Otherwise the built-in fixture is returned.
 */
export function resolveEmevdRegistry(externalPath?: string | null): EmedfResolutionResult {
  if (externalPath) {
    try {
      const text = readFileSync(externalPath, 'utf-8');
      const result = parseDs3EmedfJson(text);
      if (result.ok) {
        return {
          registry: result.registry,
          origin: 'imported',
          instructionCount: result.instructionCount,
          bankCount: result.bankCount,
        };
      }
      return {
        registry: createSekiroFixtureEmedf(),
        origin: 'fixture',
        fallbackReason: `EMEDF 导入失败：${result.message}`,
      };
    } catch {
      return {
        registry: createSekiroFixtureEmedf(),
        origin: 'fixture',
        fallbackReason: `无法读取 EMEDF 文件：${externalPath}`,
      };
    }
  }

  return {
    registry: createSekiroFixtureEmedf(),
    origin: 'fixture',
  };
}