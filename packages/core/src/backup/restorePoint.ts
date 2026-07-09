/**
 * Backup / restore-point scaffold.
 */

import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export interface BackupFileEntry {
  sourcePath: string;
  backupPath: string;
  beforeHash: string;
}

export interface RestorePoint {
  restorePointId: string;
  root: string;
  createdAt: string;
  files: BackupFileEntry[];
  metadataPath: string;
}

export async function createRestorePoint(input: {
  sourcePaths: string[];
  baseDir?: string;
  label?: string;
}): Promise<RestorePoint> {
  const root = await mkdtemp(join(input.baseDir ?? tmpdir(), 'soulforge-backup-'));
  const files: BackupFileEntry[] = [];

  for (const sourcePath of input.sourcePaths) {
    const bytes = await readFile(sourcePath);
    const beforeHash = createHash('sha256').update(bytes).digest('hex');
    const backupPath = join(root, 'files', safeName(sourcePath), basename(sourcePath));
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(sourcePath, backupPath);
    files.push({ sourcePath, backupPath, beforeHash });
  }

  const restorePoint: RestorePoint = {
    restorePointId: randomUUID(),
    root,
    createdAt: new Date().toISOString(),
    files,
    metadataPath: join(root, 'restore-point.json')
  };

  await writeFile(
    restorePoint.metadataPath,
    `${JSON.stringify({
      restorePointId: restorePoint.restorePointId,
      createdAt: restorePoint.createdAt,
      label: input.label ?? null,
      files: restorePoint.files
    }, null, 2)}\n`,
    'utf8'
  );

  return restorePoint;
}

export async function restoreFromPoint(restorePoint: RestorePoint): Promise<{
  ok: boolean;
  restoredPaths: string[];
  errors: string[];
}> {
  const restoredPaths: string[] = [];
  const errors: string[] = [];

  for (const file of restorePoint.files) {
    try {
      await mkdir(dirname(file.sourcePath), { recursive: true });
      await copyFile(file.backupPath, file.sourcePath);
      restoredPaths.push(file.sourcePath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { ok: errors.length === 0, restoredPaths, errors };
}

function safeName(pathValue: string): string {
  return pathValue.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}
