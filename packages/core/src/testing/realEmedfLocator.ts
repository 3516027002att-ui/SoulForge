/**
 * Locate a real DarkScript3-format EMEDF JSON on the local machine.
 *
 * Shared by the imported-registry smokes (runEmevdImportedRegistryProductionSmoke,
 * runEmevdImportedCoverageSmoke) and the multi-corpus matrix so that the
 * "real imported EMEDF cross-validation" leg of W-EMEVD-FULL-01 fires from the
 * plain npm scripts when a user-provided file exists locally, instead of
 * requiring SOULFORGE_EMEDF_PATH to be set by hand.
 *
 * Lookup order:
 *   1. SOULFORGE_EMEDF_PATH env (explicit caller choice);
 *   2. common DarkScript3 / Smithbox directory candidates;
 *   3. a bounded set of user-profile subdirectories for
 *      `sekiro-common.emedf.json`.
 * Returns undefined (fail-closed) when not found.
 *
 * DarkScript3 EMEDF data is All Rights Reserved; this locator only reads a
 * user-provided local file, never bundles or commits anything.
 */
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REAL_EMEDF_CANDIDATE_PATHS = [
  'sekiro-common.emedf.json',
  'Sekiro/sekiro-common.emedf.json',
  'sekiro.emedf.json'
];

export async function searchRealEmedf(): Promise<string | undefined> {
  const explicit = process.env.SOULFORGE_EMEDF_PATH?.trim();
  if (explicit) return resolve(explicit);

  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const roots = [
    home ? join(home, 'AppData', 'Local', 'Temp') : '',
    home ? join(home, 'AppData', 'Roaming') : '',
    home ? join(home, 'Desktop') : '',
    home ? join(home, 'Documents') : '',
    home ? join(home, 'Downloads') : '',
    'D:/Repository/DarkScript3',
    'D:/Repository/Smithbox',
    'D:/Smithbox',
    'C:/Tools/Smithbox',
    'C:/DarkScript3',
    'D:/DarkScript3'
  ].filter(Boolean);
  for (const root of roots) {
    for (const rel of REAL_EMEDF_CANDIDATE_PATHS) {
      const candidate = join(root, rel);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return undefined;
}
