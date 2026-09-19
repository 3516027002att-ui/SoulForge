/**
 * Host-owned continuation state for content reference pages.
 *
 * A cursor is deliberately opaque.  The token is a random nonce bound to a
 * digest, while the store retains the complete query scope and snapshot
 * identity.  This prevents an offset-only token from being replayed against a
 * different workspace/query/source version and keeps cursor state read-only.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { NormalizedReferenceQuery } from '@soulforge/shared';
import type { DependencySummary } from '../runtime/resourceVersion.js';

export type ReferenceCursorScope = Pick<
  NormalizedReferenceQuery,
  'uri' | 'target' | 'query' | 'domain' | 'direction' | 'detail' |
  'fieldIds' | 'depth' | 'limit' | 'includeHypotheses'
>;

export interface ReferenceCursorState {
  workspaceId: string;
  scope: ReferenceCursorScope;
  rootUri: string;
  relationOffset: number;
  /** Reserved for hosts that page source shards separately. */
  sourceOffset?: number;
  /** Opaque enrichment-only scan state; result-page service must reject it. */
  sourceScanState?: unknown;
  /** Complete current bundle/provider fingerprint, not a display hash. */
  sourceVersionKey: string;
  dependencySummary: DependencySummary;
  providerRegistryDigest?: string;
  issuedAt?: number;
  expiresAt?: number;
}

export interface StoredReferenceCursor extends ReferenceCursorState {
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ReferenceCursorStoreOptions {
  /** Maximum live cursors retained by this store. */
  maxEntries?: number;
  /** Idle/lifetime bound. Cursors older than this are discarded. */
  ttlMs?: number;
  /** Clock injection makes expiry behavior deterministic in tests/hosts. */
  now?: () => number;
}

export interface ReferenceCursorStore {
  issue(state: ReferenceCursorState): string;
  /** Alias for hosts that call cursor creation `put`. */
  put(state: ReferenceCursorState): string;
  get(token: string): StoredReferenceCursor | undefined;
  delete(token: string): void;
  clear(): void;
}

const CURSOR_PREFIX = 'rf2_';
const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validState(value: unknown): value is StoredReferenceCursor {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<StoredReferenceCursor>;
  return typeof state.token === 'string'
    && state.token.startsWith(CURSOR_PREFIX)
    && typeof state.workspaceId === 'string'
    && typeof state.rootUri === 'string'
    && typeof state.sourceVersionKey === 'string'
    && typeof state.scope === 'object'
    && state.scope !== null
    && positiveSafeInteger(state.relationOffset)
    && typeof state.dependencySummary === 'object'
    && state.dependencySummary !== null
    && positiveSafeInteger(state.issuedAt)
    && positiveSafeInteger(state.expiresAt);
}

function cloneState(state: StoredReferenceCursor): StoredReferenceCursor {
  return JSON.parse(JSON.stringify(state)) as StoredReferenceCursor;
}

function tokenFor(state: ReferenceCursorState, issuedAt: number): string {
  const binding = stableJson({
    workspaceId: state.workspaceId,
    scope: state.scope,
    rootUri: state.rootUri,
    relationOffset: state.relationOffset,
    sourceOffset: state.sourceOffset,
    sourceScanState: state.sourceScanState,
    sourceVersionKey: state.sourceVersionKey,
    dependencySummary: state.dependencySummary,
    providerRegistryDigest: state.providerRegistryDigest,
    issuedAt
  });
  const digest = createHash('sha256').update(binding).digest('hex').slice(0, 24);
  return `${CURSOR_PREFIX}${randomBytes(24).toString('base64url')}_${digest}`;
}

abstract class BaseReferenceCursorStore implements ReferenceCursorStore {
  protected readonly maxEntries: number;
  protected readonly ttlMs: number;
  protected readonly now: () => number;

  constructor(options: ReferenceCursorStoreOptions = {}) {
    this.maxEntries = Number.isSafeInteger(options.maxEntries) && (options.maxEntries ?? 0) > 0
      ? options.maxEntries as number : DEFAULT_MAX_ENTRIES;
    this.ttlMs = Number.isSafeInteger(options.ttlMs) && (options.ttlMs ?? 0) > 0
      ? options.ttlMs as number : DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  protected abstract readAll(): Map<string, StoredReferenceCursor>;
  protected abstract writeAll(entries: Map<string, StoredReferenceCursor>): void;

  issue(state: ReferenceCursorState): string {
    if (!state.workspaceId || !state.rootUri || !state.sourceVersionKey || !positiveSafeInteger(state.relationOffset)) {
      throw new Error('REFERENCE_CURSOR_STATE_INVALID');
    }
    const now = Math.max(0, Math.floor(this.now()));
    const entries = this.prune(this.readAll(), now);
    const issued: StoredReferenceCursor = {
      ...state,
      token: tokenFor(state, now),
      issuedAt: now,
      expiresAt: now + this.ttlMs
    };
    entries.set(issued.token, issued);
    while (entries.size > this.maxEntries) {
      const oldest = [...entries.values()].sort((a, b) => a.issuedAt - b.issuedAt)[0];
      if (!oldest) break;
      entries.delete(oldest.token);
    }
    this.writeAll(entries);
    return issued.token;
  }

  put(state: ReferenceCursorState): string {
    return this.issue(state);
  }

  get(token: string): StoredReferenceCursor | undefined {
    if (typeof token !== 'string' || !token.startsWith(CURSOR_PREFIX)) return undefined;
    const entries = this.prune(this.readAll(), Math.max(0, Math.floor(this.now())));
    const found = entries.get(token);
    this.writeAll(entries);
    return found ? cloneState(found) : undefined;
  }

  delete(token: string): void {
    const entries = this.readAll();
    if (entries.delete(token)) this.writeAll(entries);
  }

  clear(): void {
    this.writeAll(new Map());
  }

  private prune(entries: Map<string, StoredReferenceCursor>, now: number): Map<string, StoredReferenceCursor> {
    for (const [token, entry] of entries) {
      if (!validState(entry) || entry.expiresAt <= now) entries.delete(token);
    }
    return entries;
  }
}

export class MemoryReferenceCursorStore extends BaseReferenceCursorStore {
  private entries = new Map<string, StoredReferenceCursor>();

  protected readAll(): Map<string, StoredReferenceCursor> {
    return this.entries;
  }

  protected writeAll(entries: Map<string, StoredReferenceCursor>): void {
    this.entries = entries;
  }
}

/** Default store shared by all ReferenceQueryService instances in this host. */
export function createReferenceCursorStore(options: ReferenceCursorStoreOptions = {}): ReferenceCursorStore {
  return new MemoryReferenceCursorStore(options);
}

const defaultStore = createReferenceCursorStore();
export const defaultReferenceCursorStore: ReferenceCursorStore = defaultStore;

export interface ManagedReferenceCursorStoreOptions extends ReferenceCursorStoreOptions {
  fileName?: string;
}

/**
 * JSON-backed store for a managed `.soulforge`/CLI directory.  It refreshes on
 * every operation so a one-shot CLI process can continue a cursor minted by a
 * previous process.  Writes are atomic within the managed directory.
 */
export class ManagedReferenceCursorStore extends BaseReferenceCursorStore {
  private readonly filePath: string;

  constructor(directory: string, options: ManagedReferenceCursorStoreOptions = {}) {
    super(options);
    if (!directory || directory.trim().length === 0) throw new Error('REFERENCE_CURSOR_DIRECTORY_REQUIRED');
    this.filePath = join(directory, options.fileName ?? 'reference-cursors.json');
  }

  protected readAll(): Map<string, StoredReferenceCursor> {
    try {
      if (!existsSync(this.filePath)) return new Map();
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return new Map();
      const entries = new Map<string, StoredReferenceCursor>();
      for (const value of parsed) {
        if (validState(value)) entries.set(value.token, value);
      }
      return entries;
    } catch {
      // A corrupt/stale cursor cache is equivalent to an expired cache. It
      // cannot authorize or affect any writer operation.
      return new Map();
    }
  }

  protected writeAll(entries: Map<string, StoredReferenceCursor>): void {
    const parent = dirname(this.filePath);
    if (parent) mkdirSync(parent, { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify([...entries.values()]), 'utf8');
    renameSync(tempPath, this.filePath);
  }
}

export function createManagedReferenceCursorStore(
  directory: string,
  options: ManagedReferenceCursorStoreOptions = {}
): ReferenceCursorStore {
  return new ManagedReferenceCursorStore(directory, options);
}

/** Backward/host-friendly aliases. */
export const createMemoryReferenceCursorStore = createReferenceCursorStore;
export type ReferenceCursor = StoredReferenceCursor;
