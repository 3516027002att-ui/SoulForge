/**
 * Content-addressed staging area scaffold.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export interface StagingBlob {
  hash: string;
  absolutePath: string;
  byteLength: number;
}

export interface ContentAddressedStaging {
  stagingId: string;
  root: string;
  blobs: Map<string, StagingBlob>;
}

export async function createContentAddressedStaging(baseDir?: string): Promise<ContentAddressedStaging> {
  const root = await mkdtemp(join(baseDir ?? tmpdir(), 'soulforge-staging-'));
  await mkdir(join(root, 'objects'), { recursive: true });
  await mkdir(join(root, 'work'), { recursive: true });
  return {
    stagingId: randomUUID(),
    root,
    blobs: new Map()
  };
}

export async function stageBytes(
  staging: ContentAddressedStaging,
  bytes: Buffer | Uint8Array
): Promise<StagingBlob> {
  const buffer = Buffer.from(bytes);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const absolutePath = join(staging.root, 'objects', hash);
  if (!staging.blobs.has(hash)) {
    await writeFile(absolutePath, buffer);
    const blob: StagingBlob = { hash, absolutePath, byteLength: buffer.byteLength };
    staging.blobs.set(hash, blob);
    return blob;
  }
  return staging.blobs.get(hash)!;
}

export async function stageFile(
  staging: ContentAddressedStaging,
  sourcePath: string
): Promise<StagingBlob> {
  const bytes = await readFile(sourcePath);
  return stageBytes(staging, bytes);
}

export async function materializeBlob(
  staging: ContentAddressedStaging,
  hash: string,
  destinationRelativePath: string
): Promise<string> {
  const blob = staging.blobs.get(hash);
  if (!blob) throw new Error(`Unknown staging blob: ${hash}`);
  const destination = join(staging.root, 'work', destinationRelativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(blob.absolutePath, destination);
  return destination;
}

export function stagingWorkRoot(staging: ContentAddressedStaging): string {
  return join(staging.root, 'work');
}
