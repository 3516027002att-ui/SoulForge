import { createHash } from 'node:crypto';
import type { IndexedFile } from '@soulforge/shared';

/**
 * 24.4 G-1 types — single source of truth for fingerprint schema.
 * Do not duplicate or diverge this schema elsewhere (5.6 §2).
 */
export interface FileFingerprintV1 {
  relativePath: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  fileIdentity: string | null; // volume+fileId, null => warm reuse must FAIL
  pathSourceGeneration: number;
}

export interface PersistedHashV1 extends FileFingerprintV1 {
  sha256: string;
  lastVerifiedAtUtc: string;
  fingerprintStoreGeneration: number;
}

export interface WorkspaceScanGeneration {
  workspaceId: string;
  workspaceSessionGeneration: number; // per open increment, NOT persisted
  fingerprintStoreGeneration: number; // schema/root change only
  abort: AbortController;
}

export interface FingerprintContinuityV1 {
  workspacePersistentIdentityHash: string;
  volumeIdentity: string;
  usnJournalId: string | null;
  lastConsumedUsn: string | null;
  watcherEpoch: string;
  cleanShutdown: boolean;
  continuity: 'PROVEN' | 'UNKNOWN';
  unknownReason: 'FIRST_OPEN' | 'JOURNAL_UNAVAILABLE' | 'JOURNAL_ID_CHANGED' | 'JOURNAL_GAP' | 'WATCHER_OVERFLOW' | 'UNCLEAN_SHUTDOWN' | null;
}

export interface HashContinuationV1 {
  workspaceId: string;
  workspaceSessionGeneration: number;
  fingerprint: FileFingerprintV1;
  offset: number;
  openHandle: import('node:fs/promises').FileHandle | null;
  incrementalHasher: ReturnType<typeof createHash> | null;
  queuedSequence: number;
}

export function makeWorkspacePersistentIdentityHash(args: { workspaceId: string; game: string; physicalOverlayRootHash: string; physicalBaseRootHash?: string }): string {
  const h = createHash('sha256');
  h.update(args.workspaceId);
  h.update('\0'); h.update(args.game);
  h.update('\0'); h.update(args.physicalOverlayRootHash);
  if (args.physicalBaseRootHash) { h.update('\0'); h.update(args.physicalBaseRootHash); }
  return h.digest('hex');
}

export function fingerprintEquals(a: FileFingerprintV1, b: FileFingerprintV1): boolean {
  return a.relativePath === b.relativePath
    && a.size === b.size
    && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs
    && a.fileIdentity === b.fileIdentity
    && a.pathSourceGeneration === b.pathSourceGeneration;
}

export function makeFileFingerprint(args: {
  relativePath: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  fileIdentity: string | null;
  pathSourceGeneration: number;
}): FileFingerprintV1 {
  return {
    relativePath: args.relativePath,
    size: args.size,
    mtimeNs: args.mtimeNs,
    ctimeNs: args.ctimeNs,
    fileIdentity: args.fileIdentity,
    pathSourceGeneration: args.pathSourceGeneration,
  };
}

export function canReusePersistedHash(args: {
  fingerprint: FileFingerprintV1;
  persisted: PersistedHashV1 | undefined;
  currentStoreGeneration: number;
  continuity: FingerprintContinuityV1;
  workspaceIdentityMatches: boolean;
}): { reuse: boolean; reason: string } {
  if (!args.persisted) return { reuse: false, reason: 'no-persisted' };
  if (!args.workspaceIdentityMatches) return { reuse: false, reason: 'workspace-mismatch' };
  if (args.continuity.continuity !== 'PROVEN') return { reuse: false, reason: `continuity-${args.continuity.continuity}` };
  if (args.persisted.fingerprintStoreGeneration !== args.currentStoreGeneration) return { reuse: false, reason: 'store-generation-mismatch' };
  if (args.persisted.fileIdentity === null) return { reuse: false, reason: 'fileIdentity-null' };
  if (!fingerprintEquals(args.fingerprint, {
    relativePath: args.persisted.relativePath,
    size: args.persisted.size,
    mtimeNs: args.persisted.mtimeNs,
    ctimeNs: args.persisted.ctimeNs,
    fileIdentity: args.persisted.fileIdentity,
    pathSourceGeneration: args.persisted.pathSourceGeneration,
  })) return { reuse: false, reason: 'fingerprint-mismatch' };
  return { reuse: true, reason: 'hit' };
}

export function normalizeMtimeNs(stat: { mtimeNs?: bigint; mtimeMs: number }): string {
  if (typeof stat.mtimeNs === 'bigint') return stat.mtimeNs.toString();
  return String(BigInt(Math.trunc(stat.mtimeMs * 1_000_000)));
}
export function normalizeCtimeNs(stat: { ctimeNs?: bigint; ctimeMs: number; birthtimeMs?: number }): string {
  if (typeof stat.ctimeNs === 'bigint') return stat.ctimeNs.toString();
  const ms = typeof stat.ctimeMs === 'number' ? stat.ctimeMs : (stat.birthtimeMs ?? 0);
  return String(BigInt(Math.trunc(ms * 1_000_000)));
}
export function fileIdentityFromStat(stat: { dev?: number | bigint; ino?: number | bigint }): string | null {
  if (stat.dev !== undefined && stat.ino !== undefined) return `${String(stat.dev)}:${String(stat.ino)}`;
  return null;
}

/** For tests: build a persisted entry quickly */
export function toPersistedHash(fp: FileFingerprintV1, sha256: string, storeGen: number): PersistedHashV1 {
  return { ...fp, sha256, lastVerifiedAtUtc: new Date().toISOString(), fingerprintStoreGeneration: storeGen };
}
