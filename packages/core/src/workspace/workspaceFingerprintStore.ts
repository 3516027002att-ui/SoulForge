import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FingerprintContinuityV1, PersistedHashV1 } from './fileFingerprint.js';

export interface LoadStoreArgs {
  workspacePersistentIdentityHash: string;
  storageRoot: string; // durableStoragePaths root
  fingerprintStoreGeneration: number; // schema generation at open time
}

export interface FingerprintStoreState {
  fingerprintStoreGeneration: number;
  hashes: Map<string, PersistedHashV1>;
  pathGenerations: Map<string, number>;
  continuity: FingerprintContinuityV1;
}

function storePath(storageRoot: string): string {
  return join(storageRoot, 'fingerprints.json');
}

export async function loadFingerprintStore(args: LoadStoreArgs): Promise<FingerprintStoreState> {
  const path = storePath(args.storageRoot);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as {
      fingerprintStoreGeneration: number;
      continuity: FingerprintContinuityV1;
      hashes: Array<PersistedHashV1>;
      pathGenerations: Record<string, number>;
    };
    // workspace identity is keyed by storageRoot itself; caller ensures exact workspace identity match.
    // If persisted workspace hash mismatches, caller discards.
    if (parsed.continuity.workspacePersistentIdentityHash !== args.workspacePersistentIdentityHash) {
      return emptyStore(args);
    }
    if (parsed.fingerprintStoreGeneration !== args.fingerprintStoreGeneration) {
      // schema/root changed -> retain pathGenerations but hashes become stale via generation check, not deletion
    }
    const hashes = new Map<string, PersistedHashV1>();
    for (const h of parsed.hashes) hashes.set(h.relativePath, h);
    const pathGenerations = new Map<string, number>(Object.entries(parsed.pathGenerations ?? {}));
    return {
      fingerprintStoreGeneration: parsed.fingerprintStoreGeneration,
      hashes,
      pathGenerations,
      continuity: parsed.continuity,
    };
  } catch {
    return emptyStore(args);
  }
}

function emptyStore(args: LoadStoreArgs): FingerprintStoreState {
  return {
    fingerprintStoreGeneration: args.fingerprintStoreGeneration,
    hashes: new Map(),
    pathGenerations: new Map(),
    continuity: {
      workspacePersistentIdentityHash: args.workspacePersistentIdentityHash,
      volumeIdentity: 'unknown',
      usnJournalId: null,
      lastConsumedUsn: null,
      watcherEpoch: '0',
      cleanShutdown: false,
      continuity: 'UNKNOWN',
      unknownReason: 'FIRST_OPEN',
    },
  };
}

export async function saveFingerprintStore(args: { storageRoot: string; state: FingerprintStoreState }): Promise<void> {
  const path = storePath(args.storageRoot);
  await mkdir(args.storageRoot, { recursive: true });
  const payload = JSON.stringify({
    fingerprintStoreGeneration: args.state.fingerprintStoreGeneration,
    continuity: args.state.continuity,
    hashes: [...args.state.hashes.values()],
    pathGenerations: Object.fromEntries(args.state.pathGenerations),
  });
  // atomic replace via write + rename pattern would be better; use simple write for now
  const tmp = path + '.tmp';
  await writeFile(tmp, payload, 'utf8');
  // fsync handled by caller transaction; attempt rename
  try {
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
  } catch {
    await writeFile(path, payload, 'utf8');
  }
}

export function getPathSourceGeneration(state: FingerprintStoreState, relativePath: string): number {
  return state.pathGenerations.get(relativePath) ?? 0;
}

export function bumpPathSourceGeneration(state: FingerprintStoreState, relativePath: string): number {
  const next = (state.pathGenerations.get(relativePath) ?? 0) + 1;
  state.pathGenerations.set(relativePath, next);
  // also invalidate old persisted hash for that path (caller will re-hash)
  return next;
}

export function verifyContinuityForReuse(continuity: FingerprintContinuityV1): boolean {
  return continuity.continuity === 'PROVEN';
}

/** After a successful full background hash of stable set, promote UNKNOWN -> PROVEN if stable */
export function promoteContinuityAfterStableHash(state: FingerprintStoreState): void {
  if (state.continuity.continuity === 'UNKNOWN') {
    state.continuity = {
      ...state.continuity,
      continuity: 'PROVEN',
      unknownReason: null,
      cleanShutdown: true,
    };
  }
}

export function markCleanShutdown(state: FingerprintStoreState, clean: boolean): void {
  state.continuity.cleanShutdown = clean;
  if (!clean) {
    state.continuity.continuity = 'UNKNOWN';
    state.continuity.unknownReason = 'UNCLEAN_SHUTDOWN';
  }
}

export function workspacePhysicalRootHash(physicalRoot: string): string {
  return createHash('sha256').update(physicalRoot).digest('hex').slice(0, 16);
}
