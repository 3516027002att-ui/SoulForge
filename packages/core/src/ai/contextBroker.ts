/**
 * Context Broker — controls what may leave the local workspace toward cloud models.
 *
 * Allowed: current workspace overlay + optional base (vanilla game) roots only.
 * Denied: app data, safeStorage, backups/recovery/cache, other workspaces, junction escapes,
 * and content that matches credential rules (redacted or rejected depending on mode).
 *
 * Every accepted outbound item records resource URI, layer, hash, byte count, service id,
 * agent run id, sent_at, and a redaction summary for app.db / audit consumers.
 */

import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isPathInside, verifyPathInsideRoot } from '../workspace/pathBoundary.js';
import { makeFileResourceUri, makeWorkspaceRelativePath, toPosixPath } from '../workspace/resourceUri.js';
import { redactSecrets } from '../model-services/agentLoop.js';

export type ContextBrokerLayer = 'overlay' | 'base';

export interface ContextBrokerRoots {
  overlayRoot: string;
  baseRoot?: string;
  /** Explicitly denied roots (app data, backups, recovery, cache, other workspaces). */
  forbiddenRoots?: string[];
  /** Optional app data root — always denied for outbound content. */
  appDataRoot?: string;
  /** Optional safeStorage / credentials root — always denied for outbound content. */
  safeStorageRoot?: string;
}

export interface ContextBrokerCandidate {
  /** Logical resource URI preferred for audit (file://… relative form). */
  resourceUri?: string;
  /** Absolute filesystem path; used for boundary checks only, never stored raw. */
  absolutePath?: string;
  /** Workspace-relative path when already known. */
  relativePath?: string;
  /** Hint when the caller already resolved layer. */
  layer?: ContextBrokerLayer;
  /** Free-form kind tag stored as context_kind. */
  contextKind: string;
  /** Payload body to evaluate for outbound send. */
  content: string | Buffer | Uint8Array;
  /** Optional non-secret metadata; absolute paths are stripped. */
  metadata?: Record<string, unknown>;
}

export interface ContextBrokerRedactionSummary {
  absolutePathsRemoved: boolean;
  credentialsRemoved: boolean;
  forbiddenPathRejected: boolean;
  junctionEscapeRejected: boolean;
  layer?: ContextBrokerLayer;
  byteCount: number;
  redactedSecretMatches: number;
  notes?: string[];
}

export interface OutboundContextItemRecord {
  resourceUri?: string;
  contextKind: string;
  contentHash?: string;
  redactionSummary: ContextBrokerRedactionSummary;
  payload: {
    content: string;
    relativePath?: string;
    layer?: ContextBrokerLayer;
    byteCount: number;
    metadata?: Record<string, unknown>;
  };
}

export interface ContextBrokerRejection {
  code:
    | 'CONTEXT_PATH_REQUIRED'
    | 'CONTEXT_PATH_OUTSIDE_WORKSPACE'
    | 'CONTEXT_PATH_FORBIDDEN_ROOT'
    | 'CONTEXT_JUNCTION_ESCAPE'
    | 'CONTEXT_LAYER_UNRESOLVED';
  message: string;
  resourceUri?: string;
  relativePath?: string;
  contextKind: string;
}

export interface PrepareOutboundContextInput {
  modelServiceId: string;
  agentRunId?: string;
  sentAt?: string;
  roots: ContextBrokerRoots;
  candidates: ContextBrokerCandidate[];
  /**
   * When true (default), redact secrets and keep the item.
   * When false, still redact but mark credentialsRemoved; path denials always reject.
   */
  redactCredentials?: boolean;
}

export interface PrepareOutboundContextResult {
  ok: boolean;
  agentRunId: string;
  modelServiceId: string;
  sentAt: string;
  items: OutboundContextItemRecord[];
  rejected: ContextBrokerRejection[];
  /** Ready for AppDataRepository.recordAgentRun.outboundContextItems */
  outboundContextItems: Array<{
    resourceUri?: string;
    contextKind: string;
    contentHash?: string;
    redactionSummary: unknown;
    payload: unknown;
  }>;
  audit: {
    modelServiceId: string;
    agentRunId: string;
    sentAt: string;
    itemCount: number;
    rejectedCount: number;
    totalOutboundBytes: number;
  };
}

const WINDOWS_ABS = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g;
const POSIX_ABS = /(?:^|[\s"'`=(])(\/(?:Users|home|var|tmp|opt|etc|mnt|media|root)\/[^\s"'`)]+)/g;
const FILE_URL_ABS = /file:\/\/\/[A-Za-z]:[^"'`\s]*/g;

export function createContextBroker(roots: ContextBrokerRoots) {
  return {
    roots: normalizeRoots(roots),
    prepare(input: Omit<PrepareOutboundContextInput, 'roots'>): Promise<PrepareOutboundContextResult> {
      return prepareOutboundContext({ ...input, roots });
    },
    isPathAllowed(absolutePath: string): Promise<{
      allowed: boolean;
      layer?: ContextBrokerLayer;
      relativePath?: string;
      code?: ContextBrokerRejection['code'];
      message?: string;
    }> {
      return resolveCandidateLocation(absolutePath, normalizeRoots(roots));
    }
  };
}

/**
 * Desktop/production adapter: builds outbound context from a live workspace session
 * and high-level item intents (user prompt / workspace summary / resource excerpts).
 * Rejects when any candidate is outside the current workspace boundary.
 */
export async function buildOutboundContext(input: {
  session: {
    layers: {
      overlayRoot: string;
      baseRoot?: string;
      stagingRoot?: string;
    };
    meta: {
      workspaceId: string;
    };
  };
  modelServiceId: string;
  agentRunId?: string;
  items: Array<
    | { kind: 'user_prompt'; text: string }
    | {
        kind: 'workspace_summary';
        workspaceSessionId?: string;
        fileCount?: number;
      }
    | {
        kind: 'resource_excerpt';
        absolutePath?: string;
        relativePath?: string;
        resourceUri?: string;
        content: string;
        layer?: ContextBrokerLayer;
      }
  >;
  forbiddenRoots?: string[];
  redactApiKey?: string;
  sentAt?: string;
}): Promise<{
  ok: boolean;
  agentRunId: string;
  modelServiceId: string;
  sentAt: string;
  auditRecords: OutboundContextItemRecord[];
  outboundContextItems: PrepareOutboundContextResult['outboundContextItems'];
  diagnostics: Array<{ severity: 'error'; code: string; message: string }>;
  rejected: ContextBrokerRejection[];
}> {
  const agentRunId = input.agentRunId ?? randomUUID();
  const roots: ContextBrokerRoots = {
    overlayRoot: input.session.layers.overlayRoot,
    ...(input.session.layers.baseRoot ? { baseRoot: input.session.layers.baseRoot } : {}),
    forbiddenRoots: [
      ...(input.forbiddenRoots ?? []),
      // Staging/backup/recovery are never outbound sources.
      ...(input.session.layers.stagingRoot ? [input.session.layers.stagingRoot] : [])
    ]
  };

  const candidates: ContextBrokerCandidate[] = input.items.map((item) => {
    if (item.kind === 'user_prompt') {
      return {
        contextKind: 'user-prompt',
        content: item.text,
        layer: 'overlay' as const,
        metadata: { kind: 'user_prompt' }
      };
    }
    if (item.kind === 'workspace_summary') {
      return {
        contextKind: 'workspace-session',
        content: JSON.stringify({
          workspaceSessionId: item.workspaceSessionId ?? input.session.meta.workspaceId,
          ...(item.fileCount !== undefined ? { fileCount: item.fileCount } : {})
        }),
        layer: 'overlay' as const,
        resourceUri: `workspace://${encodeURIComponent(input.session.meta.workspaceId)}`,
        metadata: { kind: 'workspace_summary' }
      };
    }
    return {
      contextKind: 'resource-excerpt',
      content: item.content,
      ...(item.absolutePath ? { absolutePath: item.absolutePath } : {}),
      ...(item.relativePath ? { relativePath: item.relativePath } : {}),
      ...(item.resourceUri ? { resourceUri: item.resourceUri } : {}),
      ...(item.layer ? { layer: item.layer } : {}),
      metadata: { kind: 'resource_excerpt' }
    };
  });

  // Extra pass: if host provided an API key, inject a synthetic redaction check content
  // only when it appears in any candidate (prepareOutboundContext already redacts secrets).
  const prepared = await prepareOutboundContext({
    modelServiceId: input.modelServiceId,
    agentRunId,
    ...(input.sentAt ? { sentAt: input.sentAt } : {}),
    roots,
    candidates
  });

  // If a raw API key still appears after redaction, fail closed.
  if (input.redactApiKey) {
    const leak = prepared.items.some((item) => {
      const serialized = JSON.stringify(item.payload);
      return serialized.includes(input.redactApiKey!);
    });
    if (leak) {
      return {
        ok: false,
        agentRunId: prepared.agentRunId,
        modelServiceId: prepared.modelServiceId,
        sentAt: prepared.sentAt,
        auditRecords: [],
        outboundContextItems: [],
        rejected: prepared.rejected,
        diagnostics: [{
          severity: 'error',
          code: 'CONTEXT_BROKER_SECRET_LEAK',
          message: 'Context Broker 检测到外发载荷仍包含 API 凭据。'
        }]
      };
    }
  }

  const diagnostics = prepared.rejected.map((item) => ({
    severity: 'error' as const,
    code: item.code,
    message: item.message
  }));

  return {
    ok: prepared.ok,
    agentRunId: prepared.agentRunId,
    modelServiceId: prepared.modelServiceId,
    sentAt: prepared.sentAt,
    auditRecords: prepared.items,
    outboundContextItems: prepared.outboundContextItems,
    rejected: prepared.rejected,
    diagnostics
  };
}

export async function prepareOutboundContext(
  input: PrepareOutboundContextInput
): Promise<PrepareOutboundContextResult> {
  const roots = normalizeRoots(input.roots);
  const agentRunId = input.agentRunId ?? randomUUID();
  const modelServiceId = input.modelServiceId;
  const sentAt = input.sentAt ?? new Date().toISOString();
  const items: OutboundContextItemRecord[] = [];
  const rejected: ContextBrokerRejection[] = [];

  for (const candidate of input.candidates) {
    const resolved = await resolveCandidate(candidate, roots);
    if (!resolved.ok) {
      const rejection: ContextBrokerRejection = {
        code: resolved.code,
        message: resolved.message,
        contextKind: candidate.contextKind
      };
      if (candidate.resourceUri !== undefined) rejection.resourceUri = candidate.resourceUri;
      const relativePath = candidate.relativePath ?? resolved.relativePath;
      if (relativePath !== undefined) rejection.relativePath = relativePath;
      rejected.push(rejection);
      continue;
    }

    const rawText = contentToString(candidate.content);
    const secretScan = countSecretMatches(rawText);
    const redactedText = redactSecrets(rawText);
    const pathStripped = stripAbsolutePaths(redactedText, roots);
    const absolutePathsRemoved = pathStripped !== redactedText;
    const credentialsRemoved = secretScan > 0 || pathStripped.includes('[REDACTED]');
    const safeMetadata = candidate.metadata
      ? (JSON.parse(stripAbsolutePaths(JSON.stringify(candidate.metadata), roots)) as Record<string, unknown>)
      : undefined;
    const outboundContent = pathStripped;
    const byteCount = Buffer.byteLength(outboundContent, 'utf8');
    const contentHash = createHash('sha256').update(outboundContent).digest('hex');
    const resourceUri = candidate.resourceUri
      ?? (resolved.relativePath ? makeFileResourceUri(resolved.relativePath) : undefined);

    const redactionSummary: ContextBrokerRedactionSummary = {
      absolutePathsRemoved,
      credentialsRemoved,
      forbiddenPathRejected: false,
      junctionEscapeRejected: false,
      layer: resolved.layer,
      byteCount,
      redactedSecretMatches: secretScan,
      ...(absolutePathsRemoved || credentialsRemoved
        ? {
            notes: [
              ...(absolutePathsRemoved ? ['absolute-paths-stripped'] : []),
              ...(credentialsRemoved ? ['credentials-redacted'] : [])
            ]
          }
        : {})
    };

    items.push({
      ...(resourceUri ? { resourceUri } : {}),
      contextKind: candidate.contextKind,
      contentHash,
      redactionSummary,
      payload: {
        content: outboundContent,
        ...(resolved.relativePath ? { relativePath: resolved.relativePath } : {}),
        layer: resolved.layer,
        byteCount,
        ...(safeMetadata ? { metadata: safeMetadata } : {})
      }
    });
  }

  const outboundContextItems = items.map((item) => ({
    ...(item.resourceUri ? { resourceUri: item.resourceUri } : {}),
    contextKind: item.contextKind,
    ...(item.contentHash ? { contentHash: item.contentHash } : {}),
    redactionSummary: {
      ...item.redactionSummary,
      modelServiceId,
      agentRunId,
      sentAt
    },
    payload: item.payload
  }));

  const totalOutboundBytes = items.reduce((sum, item) => sum + item.payload.byteCount, 0);

  return {
    ok: rejected.length === 0,
    agentRunId,
    modelServiceId,
    sentAt,
    items,
    rejected,
    outboundContextItems,
    audit: {
      modelServiceId,
      agentRunId,
      sentAt,
      itemCount: items.length,
      rejectedCount: rejected.length,
      totalOutboundBytes
    }
  };
}


export function countSecretMatches(text: string): number {
  const patterns = [
    /sk-[a-zA-Z0-9_-]{10,}/g,
    /Bearer\s+[A-Za-z0-9._\-]+/gi,
    /x-api-key["']?\s*[:=]\s*["'][^"']+["']/gi,
    /api[_-]?key["']?\s*[:=]\s*["'][^"']+["']/gi
  ];
  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return count;
}

async function resolveCandidate(
  candidate: ContextBrokerCandidate,
  roots: NormalizedRoots
): Promise<
  | { ok: true; layer: ContextBrokerLayer; relativePath?: string }
  | { ok: false; code: ContextBrokerRejection['code']; message: string; relativePath?: string }
> {
  // Pure logical candidates (no filesystem path) are allowed as session/meta context.
  if (!candidate.absolutePath && !candidate.relativePath) {
    if (candidate.contextKind === 'workspace-session' || candidate.contextKind === 'user-prompt') {
      return { ok: true, layer: 'overlay' };
    }
    return {
      ok: false,
      code: 'CONTEXT_PATH_REQUIRED',
      message: '非会话类出站上下文必须提供 absolutePath 或 relativePath。'
    };
  }

  if (candidate.absolutePath) {
    const located = await resolveCandidateLocation(candidate.absolutePath, roots);
    if (!located.allowed) {
      const failure: {
        ok: false;
        code: ContextBrokerRejection['code'];
        message: string;
        relativePath?: string;
      } = {
        ok: false,
        code: located.code ?? 'CONTEXT_PATH_OUTSIDE_WORKSPACE',
        message: located.message ?? '路径不在当前工作区 overlay/base 根内。'
      };
      if (located.relativePath !== undefined) failure.relativePath = located.relativePath;
      return failure;
    }
    const success: {
      ok: true;
      layer: ContextBrokerLayer;
      relativePath?: string;
    } = {
      ok: true,
      layer: located.layer!
    };
    if (located.relativePath !== undefined) success.relativePath = located.relativePath;
    return success;
  }

  // relativePath only — try overlay first, then base.
  const relativePath = toPosixPath(candidate.relativePath!);
  const overlayAbs = resolve(roots.overlayRoot, ...relativePath.split('/'));
  const overlayCheck = await resolveCandidateLocation(overlayAbs, roots);
  if (overlayCheck.allowed) {
    const success: {
      ok: true;
      layer: ContextBrokerLayer;
      relativePath?: string;
    } = {
      ok: true,
      layer: overlayCheck.layer!
    };
    const rel = overlayCheck.relativePath ?? relativePath;
    if (rel !== undefined) success.relativePath = rel;
    return success;
  }
  if (roots.baseRoot) {
    const baseAbs = resolve(roots.baseRoot, ...relativePath.split('/'));
    const baseCheck = await resolveCandidateLocation(baseAbs, roots);
    if (baseCheck.allowed) {
      const success: {
        ok: true;
        layer: ContextBrokerLayer;
        relativePath?: string;
      } = {
        ok: true,
        layer: baseCheck.layer!
      };
      const rel = baseCheck.relativePath ?? relativePath;
      if (rel !== undefined) success.relativePath = rel;
      return success;
    }
  }
  return {
    ok: false,
    code: overlayCheck.code ?? 'CONTEXT_PATH_OUTSIDE_WORKSPACE',
    message: overlayCheck.message ?? '相对路径不在当前工作区 overlay/base 根内。',
    relativePath
  };
}

async function resolveCandidateLocation(
  absolutePath: string,
  roots: NormalizedRoots
): Promise<{
  allowed: boolean;
  layer?: ContextBrokerLayer;
  relativePath?: string;
  code?: ContextBrokerRejection['code'];
  message?: string;
}> {
  const lexical = resolve(absolutePath);

  for (const forbidden of roots.forbiddenRoots) {
    if (isPathInside(forbidden, lexical)) {
      return {
        allowed: false,
        code: 'CONTEXT_PATH_FORBIDDEN_ROOT',
        message: '出站上下文不得包含 app data / backup / recovery / cache 或其他禁止根。'
      };
    }
  }

  const overlayBoundary = await verifyPathInsideRoot(roots.overlayRoot, lexical);
  if (overlayBoundary.ok) {
    return {
      allowed: true,
      layer: 'overlay',
      relativePath: toPosixPath(relative(roots.overlayRoot, lexical))
    };
  }
  const overlayDiag = overlayBoundary.diagnostics[0];
  if (isReparseEscape(String(overlayDiag?.code ?? ''))) {
    return {
      allowed: false,
      code: 'CONTEXT_JUNCTION_ESCAPE',
      message: overlayDiag?.message ?? '路径穿越了工作区边界（junction/symlink）。'
    };
  }

  if (roots.baseRoot) {
    const baseBoundary = await verifyPathInsideRoot(roots.baseRoot, lexical);
    if (baseBoundary.ok) {
      return {
        allowed: true,
        layer: 'base',
        relativePath: toPosixPath(relative(roots.baseRoot, lexical))
      };
    }
    const baseDiag = baseBoundary.diagnostics[0];
    if (isReparseEscape(String(baseDiag?.code ?? ''))) {
      return {
        allowed: false,
        code: 'CONTEXT_JUNCTION_ESCAPE',
        message: baseDiag?.message ?? '路径穿越了工作区边界（junction/symlink）。'
      };
    }
  }

  return {
    allowed: false,
    code: 'CONTEXT_PATH_OUTSIDE_WORKSPACE',
    message: '出站上下文只能引用当前工作区 overlay/base 根内的资源。'
  };
}

interface NormalizedRoots {
  overlayRoot: string;
  baseRoot?: string;
  forbiddenRoots: string[];
}

function normalizeRoots(roots: ContextBrokerRoots): NormalizedRoots {
  const forbidden = [
    ...(roots.forbiddenRoots ?? []),
    ...(roots.appDataRoot ? [roots.appDataRoot] : []),
    ...(roots.safeStorageRoot ? [roots.safeStorageRoot] : [])
  ].map((item) => resolve(item));

  const result: NormalizedRoots = {
    overlayRoot: resolve(roots.overlayRoot),
    forbiddenRoots: [...new Set(forbidden)]
  };
  if (roots.baseRoot) result.baseRoot = resolve(roots.baseRoot);
  return result;
}

function contentToString(content: string | Uint8Array): string {
  if (typeof content === 'string') return content;
  return Buffer.from(content).toString('utf8');
}

/**
 * Strip absolute roots from outbound text.
 * Remaining workspace-relative fragments are rewritten to POSIX so JSON excerpts
 * stay valid even when Windows roots leave backslash tails.
 */
export function stripAbsolutePaths(text: string, roots: ContextBrokerRoots): string {
  const normalized = normalizeRoots(roots);
  let out = text;

  // Prefer rewriting known workspace roots first so relative form can be restored.
  // Use stable placeholders rather than deleting roots, so free-text redaction is visible
  // while JSON excerpts still retain the relative suffix (msg/a.json).
  for (const root of [normalized.overlayRoot, normalized.baseRoot].filter(Boolean) as string[]) {
    const variants = pathVariants(root);
    for (const variant of variants) {
      if (!variant) continue;
      // Longest variants first is already handled by pathVariants uniqueness; replace all.
      out = out.split(variant).join('<workspace-root>/');
    }
  }

  // Collapse accidental double separators after placeholder injection.
  out = out.replace(/<workspace-root>\/+/g, '<workspace-root>/');

  // Normalize leftover Windows relative fragments for JSON-safe outbound content.
  out = out.replace(/\\+/g, '/');

  // Remaining absolute Windows / UNC paths become a generic placeholder.
  out = out
    .replace(/(?<![\w.-])[A-Za-z]:[\\/][^\s"']+/g, '<absolute-path>')
    .replace(/(?<![\w.-])\\\\[^\s"']+/g, '<absolute-path>');

  // Collapse any residual Windows-style separators that survived earlier passes.
  out = out.replace(/\\+/g, '/');
  return out;
}

function pathVariants(root: string): string[] {
  const resolved = resolve(root);
  const withSlash = resolved.endsWith('\\') || resolved.endsWith('/')
    ? resolved
    : resolved + sep;
  const posix = resolved.replace(/\\/g, '/');
  const posixSlash = posix.endsWith('/') ? posix : `${posix}/`;
  // JSON.stringify doubles backslashes; include escaped forms for content redaction.
  const escaped = resolved.replace(/\\/g, '\\\\');
  const escapedSlash = withSlash.replace(/\\/g, '\\\\');
  return Array.from(new Set([resolved, withSlash, posix, posixSlash, escaped, escapedSlash]));
}

function isReparseEscape(code: string | undefined): boolean {
  return code === 'WRITE_REPARSE_POINT_ESCAPE' || code === 'WRITE_ROOT_REALPATH_FAILED';
}
