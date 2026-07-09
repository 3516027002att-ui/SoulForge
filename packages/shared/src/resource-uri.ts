/**
 * Stable resource / field URI model (architecture forks #102, #104).
 *
 * Resource identity must not rely on filesystem path alone.
 * This module provides typed URIs for overlay layers, containers, symbols, versions, and hashes.
 *
 * Scaffold only — not a full native format authority parser.
 */

import type { ResourceKind } from './types.js';

/** Writable / readable overlay layers in the workspace model. */
export type OverlayLayerId = 'base' | 'overlay' | 'staging' | 'generated' | 'synthetic';

/** Stable content hash (sha256 hex). */
export type ContentHash = string;

/** Monotonic or content-derived resource version token. */
export type ResourceVersion = string;

/**
 * Symbol path within a resource (event id, param row, field chain, etc.).
 * Segments are URI-encoded when formatted.
 */
export type SymbolPath = string;

/**
 * Canonical resource identity.
 * physicalPath is workspace-relative POSIX path of the host file.
 * containerPath is optional child path inside BND/DCX/etc.
 */
export interface ResourceURI {
  scheme: 'soulforge';
  game: string;
  overlay: OverlayLayerId;
  /** Workspace-relative physical path (POSIX). */
  physicalPath: string;
  /** Optional path inside a container (BND child, nested archive, etc.). */
  containerPath?: string;
  resourceKind: ResourceKind;
  /** Optional semantic symbol path (e.g. events/1000/instructions/3). */
  symbolPath?: SymbolPath;
  version?: ResourceVersion;
  contentHash?: ContentHash;
}

/**
 * Field-level identity under a resource.
 * fieldPath uses dotted segments (row.field.sub).
 */
export interface FieldURI {
  resource: ResourceURI;
  fieldPath: string;
}

export interface CreateResourceUriInput {
  game?: string;
  overlay?: OverlayLayerId;
  physicalPath: string;
  containerPath?: string;
  resourceKind: ResourceKind;
  symbolPath?: SymbolPath;
  version?: ResourceVersion;
  contentHash?: ContentHash;
}

export interface CreateFieldUriInput extends CreateResourceUriInput {
  fieldPath: string;
}

export interface ResourceUriValidation {
  ok: boolean;
  errors: string[];
}

const OVERLAY_LAYER_IDS = new Set<OverlayLayerId>([
  'base',
  'overlay',
  'staging',
  'generated',
  'synthetic'
]);

const RESOURCE_KINDS = new Set<ResourceKind>([
  'event',
  'map',
  'param',
  'msg',
  'menu',
  'script',
  'action',
  'ai',
  'sfx',
  'chr',
  'obj',
  'other',
  'unknown'
]);

/**
 * Create a ResourceURI from structured parts.
 */
export function createResourceUri(input: CreateResourceUriInput): ResourceURI {
  const uri: ResourceURI = {
    scheme: 'soulforge',
    game: input.game ?? 'unknown',
    overlay: input.overlay ?? 'overlay',
    physicalPath: normalizePosixPath(input.physicalPath),
    resourceKind: input.resourceKind
  };
  if (input.containerPath !== undefined) uri.containerPath = normalizePosixPath(input.containerPath);
  if (input.symbolPath !== undefined) uri.symbolPath = normalizeSymbolPath(input.symbolPath);
  if (input.version !== undefined) uri.version = input.version;
  if (input.contentHash !== undefined) uri.contentHash = input.contentHash;
  return uri;
}

export function createFieldUri(input: CreateFieldUriInput): FieldURI {
  return {
    resource: createResourceUri(input),
    fieldPath: normalizeFieldPath(input.fieldPath)
  };
}

/**
 * Format ResourceURI to a stable string.
 *
 * soulforge://{game}/{overlay}/{kind}/{physicalPath}
 *   [?container=][&symbol=][&v=][&hash=]
 *
 * Uses an authority (game) so URL parsing is stable across runtimes.
 */
export function formatResourceUri(uri: ResourceURI): string {
  const path = [
    encodeURIComponent(uri.overlay),
    encodeURIComponent(uri.resourceKind),
    ...splitPathSegments(uri.physicalPath).map(encodeURIComponent)
  ].join('/');
  const base = `soulforge://${encodeURIComponent(uri.game)}/${path}`;

  const query = new URLSearchParams();
  if (uri.containerPath) query.set('container', uri.containerPath);
  if (uri.symbolPath) query.set('symbol', uri.symbolPath);
  if (uri.version) query.set('v', uri.version);
  if (uri.contentHash) query.set('hash', uri.contentHash);
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}

export function formatFieldUri(field: FieldURI): string {
  const resource = formatResourceUri(field.resource);
  const sep = resource.includes('?') ? '&' : '?';
  return `${resource}${sep}field=${encodeURIComponent(field.fieldPath)}`;
}

/**
 * Parse a soulforge ResourceURI string.
 * Throws on unrecoverable syntax errors; use validateResourceUri for soft checks.
 */
export function parseResourceUri(value: string): ResourceURI {
  const result = tryParseResourceUri(value);
  if (!result.ok || !result.uri) {
    throw new Error(result.errors.join('; ') || `Invalid ResourceURI: ${value}`);
  }
  return result.uri;
}

export function parseFieldUri(value: string): FieldURI {
  const result = tryParseFieldUri(value);
  if (!result.ok || !result.field) {
    throw new Error(result.errors.join('; ') || `Invalid FieldURI: ${value}`);
  }
  return result.field;
}

export function tryParseResourceUri(value: string): ResourceUriValidation & { uri?: ResourceURI } {
  const errors: string[] = [];
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, errors: ['URI must be a non-empty string'] };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, errors: [`URI is not a valid URL: ${value}`] };
  }

  if (url.protocol !== 'soulforge:') {
    errors.push(`Expected scheme soulforge:, got ${url.protocol}`);
  }

  // Preferred form: soulforge://{game}/{overlay}/{kind}/{physicalPath}
  // Fallback form: soulforge:/{game}/{overlay}/{kind}/{physicalPath}
  const pathParts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        errors.push(`Invalid percent-encoding in path segment: ${part}`);
        return part;
      }
    });

  let game = '';
  let overlayRaw = '';
  let kindRaw = '';
  let physicalPath = '';

  if (url.host) {
    try {
      game = decodeURIComponent(url.hostname || url.host);
    } catch {
      game = url.hostname || url.host;
      errors.push(`Invalid percent-encoding in game host: ${url.host}`);
    }
    if (pathParts.length < 3) {
      errors.push('ResourceURI requires overlay/kind/physicalPath under game host');
    }
    overlayRaw = pathParts[0] ?? '';
    kindRaw = pathParts[1] ?? '';
    physicalPath = pathParts.slice(2).join('/');
  } else {
    if (pathParts.length < 4) {
      errors.push('ResourceURI requires game/overlay/kind/physicalPath');
    }
    game = pathParts[0] ?? '';
    overlayRaw = pathParts[1] ?? '';
    kindRaw = pathParts[2] ?? '';
    physicalPath = pathParts.slice(3).join('/');
  }

  if (!OVERLAY_LAYER_IDS.has(overlayRaw as OverlayLayerId)) {
    errors.push(`Invalid overlay layer: ${overlayRaw}`);
  }
  if (!RESOURCE_KINDS.has(kindRaw as ResourceKind)) {
    errors.push(`Invalid resource kind: ${kindRaw}`);
  }
  if (!physicalPath) {
    errors.push('physicalPath is required');
  }

  const overlay = overlayRaw as OverlayLayerId;
  const resourceKind = kindRaw as ResourceKind;

  const uri: ResourceURI = {
    scheme: 'soulforge',
    game: game || 'unknown',
    overlay: OVERLAY_LAYER_IDS.has(overlay) ? overlay : 'overlay',
    physicalPath: normalizePosixPath(physicalPath || 'unknown'),
    resourceKind: RESOURCE_KINDS.has(resourceKind) ? resourceKind : 'unknown'
  };

  const container = url.searchParams.get('container');
  const symbol = url.searchParams.get('symbol');
  const version = url.searchParams.get('v');
  const hash = url.searchParams.get('hash');
  if (container) uri.containerPath = normalizePosixPath(container);
  if (symbol) uri.symbolPath = normalizeSymbolPath(symbol);
  if (version) uri.version = version;
  if (hash) uri.contentHash = hash;

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], uri };
}

export function tryParseFieldUri(value: string): ResourceUriValidation & { field?: FieldURI } {
  const resourceResult = tryParseResourceUri(value);
  if (!resourceResult.ok || !resourceResult.uri) {
    return { ok: false, errors: resourceResult.errors };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, errors: [`Invalid FieldURI URL: ${value}`] };
  }

  const fieldPath = url.searchParams.get('field');
  if (!fieldPath) {
    return { ok: false, errors: ['FieldURI requires field query parameter'] };
  }

  return {
    ok: true,
    errors: [],
    field: {
      resource: resourceResult.uri,
      fieldPath: normalizeFieldPath(fieldPath)
    }
  };
}

export function validateResourceUri(uri: ResourceURI | string): ResourceUriValidation {
  if (typeof uri === 'string') {
    const parsed = tryParseResourceUri(uri);
    return { ok: parsed.ok, errors: parsed.errors };
  }

  const errors: string[] = [];
  if (uri.scheme !== 'soulforge') errors.push('scheme must be soulforge');
  if (!uri.game) errors.push('game is required');
  if (!OVERLAY_LAYER_IDS.has(uri.overlay)) errors.push(`invalid overlay: ${uri.overlay}`);
  if (!RESOURCE_KINDS.has(uri.resourceKind)) errors.push(`invalid resourceKind: ${uri.resourceKind}`);
  if (!uri.physicalPath) errors.push('physicalPath is required');
  if (uri.physicalPath.includes('\\')) errors.push('physicalPath must use POSIX separators');
  if (uri.contentHash && !/^[a-fA-F0-9]{8,128}$/.test(uri.contentHash)) {
    errors.push('contentHash must be hex');
  }
  return { ok: errors.length === 0, errors };
}

export function validateFieldUri(field: FieldURI | string): ResourceUriValidation {
  if (typeof field === 'string') {
    const parsed = tryParseFieldUri(field);
    return { ok: parsed.ok, errors: parsed.errors };
  }
  const resourceCheck = validateResourceUri(field.resource);
  const errors = [...resourceCheck.errors];
  if (!field.fieldPath) errors.push('fieldPath is required');
  return { ok: errors.length === 0, errors };
}

/** Compare identity ignoring version/hash (stable resource key). */
export function resourceUriIdentityKey(uri: ResourceURI): string {
  return formatResourceUri({
    scheme: 'soulforge',
    game: uri.game,
    overlay: uri.overlay,
    physicalPath: uri.physicalPath,
    resourceKind: uri.resourceKind,
    ...(uri.containerPath ? { containerPath: uri.containerPath } : {}),
    ...(uri.symbolPath ? { symbolPath: uri.symbolPath } : {})
  });
}

export function isOverlayLayerId(value: string): value is OverlayLayerId {
  return OVERLAY_LAYER_IDS.has(value as OverlayLayerId);
}

function normalizePosixPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function normalizeSymbolPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

function normalizeFieldPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/').replace(/^\.+|\.+$/g, '').replace(/\.+/g, '.');
}

function splitPathSegments(pathValue: string): string[] {
  return normalizePosixPath(pathValue).split('/').filter(Boolean);
}
