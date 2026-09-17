/**
 * Development/validation-only locator for the community DSLuaDecompiler.
 *
 * This file is intentionally below `src/testing`: it is used only by local
 * differential corpus smokes.  Production reads and writes use the
 * first-party HKS Bridge and must never call this locator or inspect a user's
 * editor installation.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DS_LUA_DECOMPILER_FIXED_CANDIDATES = [
  'D:\\mystream\\Sekiro Shadows Die Twice\\tools\\DSLuaDecompiler\\DSLuaDecompiler.exe'
];

export const DS_LUA_DECOMPILER_RELATIVE_CANDIDATES = [
  'DSLuaDecompiler\\DSLuaDecompiler.exe',
  'hks解码\\DSLuaDecompiler.exe',
  'hks解码\\DSLuaDecompiler\\DSLuaDecompiler.exe'
];

export interface DsLuaDecompilerProbe {
  exePath: string | null;
  origin: 'explicit' | 'v1.1.5' | 'tools-scan' | 'legacy' | 'none';
}

function pushToolsSubdirs(roots: string[], gameRoot: string | undefined): void {
  if (!gameRoot) return;
  const toolsDir = join(gameRoot, '..', 'tools');
  try {
    roots.push(toolsDir);
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(toolsDir, entry.name));
    }
  } catch {
    // A validation tool is optional; the production path never reaches here.
  }
}

export interface DsLuaDecompilerLocatorContext {
  baseRoot?: string | null;
  overlayRoot?: string | null;
  gameRootEnv?: string | null;
}

export function locateDsLuaDecompilerSync(
  context: DsLuaDecompilerLocatorContext = {}
): DsLuaDecompilerProbe {
  const probe = (candidate: string): boolean => {
    try { return existsSync(candidate); } catch { return false; }
  };
  const explicit = process.env.SOULFORGE_DSLUADECOMPILER_PATH?.trim();
  if (explicit && probe(explicit)) return { exePath: explicit, origin: 'explicit' };
  for (const candidate of DS_LUA_DECOMPILER_FIXED_CANDIDATES) {
    if (probe(candidate)) return { exePath: candidate, origin: 'v1.1.5' };
  }
  const roots: string[] = [];
  pushToolsSubdirs(roots, context.baseRoot ?? undefined);
  const overlay = context.overlayRoot?.trim();
  if (overlay) pushToolsSubdirs(roots, join(overlay, '..', '..'));
  if (context.gameRootEnv?.trim()) pushToolsSubdirs(roots, context.gameRootEnv.trim());
  for (const root of roots) {
    for (const relative of DS_LUA_DECOMPILER_RELATIVE_CANDIDATES) {
      const candidate = join(root, relative);
      if (probe(candidate)) return { exePath: candidate, origin: 'tools-scan' };
    }
  }
  return { exePath: null, origin: 'none' };
}
