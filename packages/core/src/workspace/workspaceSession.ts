import { access, constants, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Diagnostic, OverlayLayer, WorkspaceLayers, WorkspaceSessionMeta } from '@soulforge/shared';
import { makeWorkspaceId } from './resourceUri.js';
import { isPathInside, pathsEqual, verifyPathInsideRoot } from './pathBoundary.js';

export interface OpenWorkspaceSessionOptions {
  overlayRoot: string;
  baseRoot?: string;
  stagingRoot?: string;
  game?: string;
}

export interface ResolveWritablePathResult {
  ok: boolean;
  absolutePath?: string;
  layer: OverlayLayer;
  diagnostics: Diagnostic[];
}

export interface WorkspaceSession {
  meta: WorkspaceSessionMeta;
  layers: WorkspaceLayers;
  /** Returns true when absolutePath is inside the writable overlay root. */
  isOverlayPath(absolutePath: string): boolean;
  /** Returns true when absolutePath is inside the optional base root. */
  isBasePath(absolutePath: string): boolean;
  /**
   * Resolve a path that is allowed for Patch Engine writes.
   * Base paths are always rejected; only overlay (or explicit staging) is writable.
   */
  resolveWritablePath(absolutePath: string, layer?: OverlayLayer): ResolveWritablePathResult;
  /**
   * Authoritative write check that resolves existing junctions/symbolic links.
   * Call this immediately before filesystem mutation; the synchronous method is
   * only a lexical precheck for UI and proposal construction.
   */
  resolveWritablePathSecure(absolutePath: string, layer?: OverlayLayer): Promise<ResolveWritablePathResult>;
  /** Map a relative path to the overlay absolute path. */
  toOverlayPath(relativePath: string): string;
  /** Map a relative path to the base absolute path when base exists. */
  toBasePath(relativePath: string): string | undefined;
}

/**
 * v0.5 workspace session: native ModEngine overlay is writable, optional game
 * install is read-only base. All Patch Engine writes must target overlay.
 *
 * The paths exposed through `layers` stay in the namespace selected by the
 * caller. This matters on Windows, where `realpath()` may expand an 8.3 alias
 * such as RUNNER~1 into a long path and make a valid caller-built child path
 * appear lexically unrelated. Physical paths are retained separately for
 * identity, alias detection and the authoritative reparse-point write gate.
 */
export async function openWorkspaceSession(options: OpenWorkspaceSessionOptions): Promise<WorkspaceSession> {
  const overlayRoot = resolve(options.overlayRoot);
  await assertDirectory(overlayRoot, 'overlayRoot');
  const physicalOverlayRoot = await realpath(overlayRoot);

  let baseRoot: string | undefined;
  let physicalBaseRoot: string | undefined;
  if (options.baseRoot) {
    baseRoot = resolve(options.baseRoot);
    await assertDirectory(baseRoot, 'baseRoot');
    physicalBaseRoot = await realpath(baseRoot);
    if (pathsEqual(physicalOverlayRoot, physicalBaseRoot)) {
      throw new Error('baseRoot must not be the same directory as overlayRoot.');
    }
  }

  // Staging roots are optional and may be created later by Patch Engine.
  const stagingRoot = options.stagingRoot ? resolve(options.stagingRoot) : undefined;

  const layers: WorkspaceLayers = {
    overlayRoot,
    ...(baseRoot ? { baseRoot } : {}),
    ...(stagingRoot ? { stagingRoot } : {})
  };

  const meta: WorkspaceSessionMeta = {
    // Preserve one identity for aliases that resolve to the same physical root.
    workspaceId: makeWorkspaceId(physicalOverlayRoot),
    layers,
    game: options.game ?? 'unknown',
    openedAt: new Date().toISOString(),
    baseMissing: !baseRoot
  };

  const session: WorkspaceSession = {
    meta,
    layers,
    isOverlayPath(absolutePath: string): boolean {
      return isInsideSelectedOrPhysicalRoot(overlayRoot, physicalOverlayRoot, absolutePath);
    },
    isBasePath(absolutePath: string): boolean {
      return baseRoot && physicalBaseRoot
        ? isInsideSelectedOrPhysicalRoot(baseRoot, physicalBaseRoot, absolutePath)
        : false;
    },
    resolveWritablePath(absolutePath: string, layer: OverlayLayer = 'overlay'): ResolveWritablePathResult {
      const diagnostics: Diagnostic[] = [];
      const resolved = resolve(absolutePath);

      if (layer === 'base') {
        diagnostics.push({
          severity: 'error',
          code: 'WRITE_TO_BASE_FORBIDDEN',
          message: 'Base game directory is read-only. All writes must target the Mod overlay.',
          details: { absolutePath: resolved, layer }
        });
        return { ok: false, layer, diagnostics };
      }

      if (layer === 'staging') {
        if (stagingRoot && isPathInside(stagingRoot, resolved)) {
          return { ok: true, absolutePath: resolved, layer, diagnostics };
        }
        diagnostics.push({
          severity: 'error',
          code: stagingRoot ? 'WRITE_OUTSIDE_STAGING' : 'STAGING_ROOT_NOT_CONFIGURED',
          message: stagingRoot
            ? '暂存写入必须位于当前会话的暂存根目录内。'
            : '当前工作区会话没有配置暂存根目录。',
          details: { absolutePath: resolved, stagingRoot }
        });
        return { ok: false, layer, diagnostics };
      }

      if (baseRoot
        && physicalBaseRoot
        && isInsideSelectedOrPhysicalRoot(baseRoot, physicalBaseRoot, resolved)) {
        diagnostics.push({
          severity: 'error',
          code: 'WRITE_TO_BASE_FORBIDDEN',
          message: 'Refusing to write into the read-only base game directory.',
          details: { absolutePath: resolved, baseRoot }
        });
        return { ok: false, layer: 'overlay', diagnostics };
      }

      if (!isInsideSelectedOrPhysicalRoot(overlayRoot, physicalOverlayRoot, resolved)) {
        diagnostics.push({
          severity: 'error',
          code: 'WRITE_OUTSIDE_OVERLAY',
          message: 'Writable paths must stay inside the Mod overlay root.',
          details: { absolutePath: resolved, overlayRoot }
        });
        return { ok: false, layer: 'overlay', diagnostics };
      }

      return { ok: true, absolutePath: resolved, layer: 'overlay', diagnostics };
    },
    async resolveWritablePathSecure(
      absolutePath: string,
      layer: OverlayLayer = 'overlay'
    ): Promise<ResolveWritablePathResult> {
      const lexical = session.resolveWritablePath(absolutePath, layer);
      if (!lexical.ok || !lexical.absolutePath) return lexical;

      const allowedRoot = layer === 'staging'
        ? stagingRoot
        : selectMatchingRootNamespace(
            overlayRoot,
            physicalOverlayRoot,
            lexical.absolutePath
          );
      if (!allowedRoot) return lexical;
      const verified = await verifyPathInsideRoot(allowedRoot, lexical.absolutePath);
      return verified.ok
        ? lexical
        : {
            ok: false,
            layer,
            diagnostics: [...lexical.diagnostics, ...verified.diagnostics]
          };
    },
    toOverlayPath(relativePath: string): string {
      return join(overlayRoot, normalizeRelative(relativePath));
    },
    toBasePath(relativePath: string): string | undefined {
      if (!baseRoot) return undefined;
      return join(baseRoot, normalizeRelative(relativePath));
    }
  };
  return session;
}

export function assertWritableThroughSession(
  session: WorkspaceSession | undefined,
  absolutePath: string
): Diagnostic[] {
  if (!session) return [];
  return session.resolveWritablePath(absolutePath).diagnostics;
}

export async function assertWritableThroughSessionSecure(
  session: WorkspaceSession | undefined,
  absolutePath: string
): Promise<Diagnostic[]> {
  if (!session) return [];
  return (await session.resolveWritablePathSecure(absolutePath)).diagnostics;
}

function isInsideSelectedOrPhysicalRoot(
  selectedRoot: string,
  physicalRoot: string,
  candidatePath: string
): boolean {
  return isPathInside(selectedRoot, candidatePath)
    || isPathInside(physicalRoot, candidatePath);
}

function selectMatchingRootNamespace(
  selectedRoot: string,
  physicalRoot: string,
  candidatePath: string
): string {
  return isPathInside(selectedRoot, candidatePath) ? selectedRoot : physicalRoot;
}

function normalizeRelative(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..') || normalized.length === 0) {
    throw new Error(`Relative path escapes workspace: ${relativePath}`);
  }
  return normalized;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}
