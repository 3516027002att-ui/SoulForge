/**
 * File-backed rollout storage (append-only JSONL) plus session directory
 * helpers. Path layout mirrors Codex's sessions tree
 * (<base>/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl); the
 * base directory is always injected by the caller — desktop points it at
 * Electron userData, never at the Mod workspace (hard constraint 3).
 */

import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RolloutStorage } from './rolloutRecorder.js';
import { parseRolloutLines, type ResumedRollout } from './rolloutRecorder.js';

export class FileRolloutStorage implements RolloutStorage {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(readonly filePath: string) {}

  async appendLines(lines: string[]): Promise<void> {
    if (this.closed) throw new Error('ROLLOUT_STORAGE_CLOSED: 存储已关闭。');
    // Single-writer invariant: serialize appends; an individual failure does
    // not poison later writes (the recorder retains unwritten items).
    const operation = this.tail.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, lines.map((line) => `${line}\n`).join(''), 'utf8');
    });
    this.tail = operation;
    await operation;
  }

  async readLines(): Promise<string[]> {
    const raw = await readFile(this.filePath, 'utf8');
    return raw.split('\n').filter((line) => line.trim() !== '');
  }

  async flush(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function rolloutSessionDir(baseDir: string, date: Date = new Date()): string {
  return join(
    baseDir,
    'sessions',
    String(date.getUTCFullYear()),
    twoDigits(date.getUTCMonth() + 1),
    twoDigits(date.getUTCDate())
  );
}

export function newRolloutFilePath(baseDir: string, sessionId: string, date: Date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return join(rolloutSessionDir(baseDir, date), `rollout-${stamp}-${sessionId}.jsonl`);
}

export interface RolloutSessionSummary {
  path: string;
  fileName: string;
  sessionId: string | null;
  startedAt: string | null;
  messageCount: number;
  parseErrors: number;
  interrupted: boolean;
  compactedWindows: number;
  sizeBytes: number;
  modifiedAt: string;
}

/**
 * List rollout sessions under the base dir, newest first, bounded by `limit`.
 * Files are read fully for the summary; the bound keeps listing lazy.
 */
export async function listRolloutSessions(
  baseDir: string,
  limit = 50
): Promise<RolloutSessionSummary[]> {
  const root = join(baseDir, 'sessions');
  const files: Array<{ path: string; fileName: string; sizeBytes: number; modifiedAt: string }> = [];
  let yearDirs: string[] = [];
  try {
    yearDirs = await readdir(root);
  } catch {
    return [];
  }
  for (const year of yearDirs) {
    const yearPath = join(root, year);
    let monthDirs: string[] = [];
    try {
      monthDirs = await readdir(yearPath);
    } catch {
      continue;
    }
    for (const month of monthDirs) {
      const monthPath = join(yearPath, month);
      let dayDirs: string[] = [];
      try {
        dayDirs = await readdir(monthPath);
      } catch {
        continue;
      }
      for (const day of dayDirs) {
        const dayPath = join(monthPath, day);
        let entries: string[] = [];
        try {
          entries = await readdir(dayPath);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue;
          const filePath = join(dayPath, entry);
          try {
            const info = await stat(filePath);
            files.push({
              path: filePath,
              fileName: entry,
              sizeBytes: info.size,
              modifiedAt: new Date(info.mtimeMs).toISOString()
            });
          } catch {
            continue;
          }
        }
      }
    }
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const summaries: RolloutSessionSummary[] = [];
  for (const file of files.slice(0, limit)) {
    try {
      const storage = new FileRolloutStorage(file.path);
      const lines = await storage.readLines();
      const resumed = parseRolloutLines(lines);
      summaries.push({
        path: file.path,
        fileName: file.fileName,
        sessionId: resumed.meta?.sessionId ?? null,
        startedAt: resumed.meta?.startedAt ?? null,
        messageCount: resumed.messages.length,
        parseErrors: resumed.parseErrors,
        interrupted: resumed.interrupted,
        compactedWindows: resumed.compactedWindows,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt
      });
    } catch {
      continue;
    }
  }
  return summaries;
}

export type LoadRolloutSessionResult =
  | ({ ok: true; path: string } & ResumedRollout)
  | { ok: false; code: 'ROLLOUT_NOT_FOUND' | 'ROLLOUT_READ_FAILED'; message: string };

export async function loadRolloutSession(path: string): Promise<LoadRolloutSessionResult> {
  let lines: string[];
  try {
    const storage = new FileRolloutStorage(path);
    lines = await storage.readLines();
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') {
      return { ok: false, code: 'ROLLOUT_NOT_FOUND', message: '会话记录不存在。' };
    }
    return {
      ok: false,
      code: 'ROLLOUT_READ_FAILED',
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return { ok: true, path, ...parseRolloutLines(lines) };
}
