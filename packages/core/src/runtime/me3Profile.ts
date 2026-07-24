import { isAbsolute, resolve } from 'node:path';

export const ME3_PROFILE_VERSION = 'v1';

export interface RenderSekiroMe3ProfileOptions {
  overlayRoot: string;
  packageId: string;
}

/**
 * Render the minimal me3 v1 profile used by SoulForge.
 *
 * me3 package directories use the `source` key. Native DLL entries use
 * `path`; confusing those two fields produces a syntactically plausible but
 * ineffective profile, so the renderer owns the distinction explicitly.
 */
export function renderSekiroMe3Profile(options: RenderSekiroMe3ProfileOptions): string {
  const overlayRoot = resolve(options.overlayRoot);
  if (!isAbsolute(overlayRoot)) throw new Error('me3 package source must be absolute.');
  if (overlayRoot.includes('\0')) throw new Error('me3 package source must not contain NUL bytes.');
  const packageId = validatePackageId(options.packageId);
  const portableOverlayPath = overlayRoot.replaceAll('\\', '/');
  return [
    `profileVersion = ${tomlString(ME3_PROFILE_VERSION)}`,
    '',
    '[[supports]]',
    'game = "sekiro"',
    '',
    '[[packages]]',
    `id = ${tomlString(packageId)}`,
    `source = ${tomlString(portableOverlayPath)}`,
    ''
  ].join('\n');
}

export function assertSoulForgeMe3ProfileContract(document: string): void {
  if (!/^profileVersion\s*=\s*"v1"\s*$/m.test(document)) {
    throw new Error('me3 profileVersion v1 is missing.');
  }
  if (!/^\[\[supports\]\]\s*$/m.test(document)
    || !/^game\s*=\s*"sekiro"\s*$/m.test(document)) {
    throw new Error('me3 Sekiro support declaration is missing.');
  }
  if (!/^\[\[packages\]\]\s*$/m.test(document)
    || !/^source\s*=\s*".+"\s*$/m.test(document)) {
    throw new Error('me3 package source is missing.');
  }
  if (/^path\s*=/m.test(document)) {
    throw new Error('SoulForge package profiles must use source, not native path.');
  }
}

function validatePackageId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error('Invalid me3 package id.');
  }
  return normalized;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
