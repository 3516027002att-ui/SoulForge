/**
 * Lightweight file probe for VFS open-time scans.
 * Never full-reads large / packed payloads just to build the tree.
 */

import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { VfsHashStatus } from '@soulforge/shared';

/** Default prefix used for binary sniff + optional partial hash. */
export const DEFAULT_PROBE_PREFIX_BYTES = 64 * 1024;

/** Files at or below this size may receive immediate full sha256. */
export const DEFAULT_SMALL_FILE_HASH_BYTES = 256 * 1024;

export interface ProbeFileOptions {
  maxPrefixBytes?: number;
  smallFileHashBytes?: number;
  /** Force skip full hash even for small files. */
  deferHash?: boolean;
}

export interface FileProbeResult {
  size: number;
  prefix: Buffer;
  bytesRead: number;
  looksBinary: boolean;
  contentHash?: string;
  hashStatus: VfsHashStatus;
}

export async function readPrefix(path: string, maxBytes: number): Promise<{
  size: number;
  prefix: Buffer;
  bytesRead: number;
}> {
  const fileStat = await stat(path);
  const size = fileStat.size;
  if (size === 0) {
    return { size: 0, prefix: Buffer.alloc(0), bytesRead: 0 };
  }

  const toRead = Math.min(size, Math.max(0, maxBytes));
  const handle = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(toRead);
    const { bytesRead } = await handle.read(prefix, 0, toRead, 0);
    return {
      size,
      prefix: prefix.subarray(0, bytesRead),
      bytesRead
    };
  } finally {
    await handle.close();
  }
}

export function detectBinaryFromPrefix(prefix: Buffer): boolean {
  if (prefix.length === 0) return false;
  // NUL in the sample is a strong binary signal.
  if (prefix.includes(0)) return true;
  // High ratio of non-printable / non-whitespace control bytes.
  let weird = 0;
  const sample = prefix.subarray(0, Math.min(prefix.length, 512));
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) weird += 1;
  }
  return sample.length > 0 && weird / sample.length > 0.3;
}

export function maybeHashSmallFile(input: {
  size: number;
  prefix: Buffer;
  bytesRead: number;
  smallFileHashBytes: number;
  deferHash?: boolean;
}): { contentHash?: string; hashStatus: VfsHashStatus } {
  if (input.deferHash) {
    return { hashStatus: 'deferred' };
  }
  if (input.size === 0) {
    return {
      contentHash: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      hashStatus: 'full'
    };
  }
  if (input.size <= input.smallFileHashBytes && input.bytesRead === input.size) {
    return {
      contentHash: createHash('sha256').update(input.prefix).digest('hex'),
      hashStatus: 'full'
    };
  }
  // Partial hash of prefix only — must not be treated as full content identity.
  return {
    contentHash: createHash('sha256').update(input.prefix).digest('hex'),
    hashStatus: input.bytesRead > 0 ? 'partial' : 'unavailable'
  };
}

export async function probeFile(
  path: string,
  options: ProbeFileOptions = {}
): Promise<FileProbeResult> {
  const maxPrefixBytes = options.maxPrefixBytes ?? DEFAULT_PROBE_PREFIX_BYTES;
  const smallFileHashBytes = options.smallFileHashBytes ?? DEFAULT_SMALL_FILE_HASH_BYTES;
  const { size, prefix, bytesRead } = await readPrefix(path, maxPrefixBytes);
  const looksBinary = detectBinaryFromPrefix(prefix);
  const hash = maybeHashSmallFile({
    size,
    prefix,
    bytesRead,
    smallFileHashBytes,
    ...(options.deferHash !== undefined ? { deferHash: options.deferHash } : {})
  });

  // Packed / large binaries: prefer deferred over claiming full hash.
  let hashStatus = hash.hashStatus;
  let contentHash = hash.contentHash;
  if (looksBinary && size > smallFileHashBytes) {
    hashStatus = 'deferred';
    contentHash = undefined;
  } else if (looksBinary && hashStatus === 'partial') {
    // Partial hash on binary is ok as sniff id but mark partial explicitly.
    hashStatus = 'partial';
  }

  const result: FileProbeResult = {
    size,
    prefix,
    bytesRead,
    looksBinary,
    hashStatus
  };
  if (contentHash !== undefined) result.contentHash = contentHash;
  return result;
}
