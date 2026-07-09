import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditLogEntry, AuditLogStore } from '@soulforge/shared';

export class MemoryAuditLogStore implements AuditLogStore {
  private readonly entries: AuditLogEntry[] = [];

  append(entry: AuditLogEntry): void {
    this.entries.push(entry);
  }

  list(filter?: {
    transactionId?: string;
    operationId?: string;
    patchId?: string;
    limit?: number;
  }): AuditLogEntry[] {
    let items = [...this.entries];
    if (filter?.transactionId) {
      items = items.filter((entry) => entry.transactionId === filter.transactionId);
    }
    if (filter?.operationId) {
      items = items.filter((entry) => entry.operationId === filter.operationId);
    }
    if (filter?.patchId) {
      items = items.filter((entry) => entry.patchId === filter.patchId);
    }
    if (filter?.limit !== undefined) {
      items = items.slice(-filter.limit);
    }
    return items;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * JSONL audit log on disk (SQLite-ready interface, file-backed).
 */
export class JsonlAuditLogStore implements AuditLogStore {
  private readonly cache: AuditLogEntry[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  append(entry: AuditLogEntry): void {
    this.cache.push(entry);
    // Fire-and-forget sync write is intentional for scaffold simplicity;
    // callers that need durability should await flush().
    void this.persistLine(entry);
  }

  async appendAsync(entry: AuditLogEntry): Promise<void> {
    this.cache.push(entry);
    await this.persistLine(entry);
  }

  list(filter?: {
    transactionId?: string;
    operationId?: string;
    patchId?: string;
    limit?: number;
  }): AuditLogEntry[] {
    let items = [...this.cache];
    if (filter?.transactionId) {
      items = items.filter((entry) => entry.transactionId === filter.transactionId);
    }
    if (filter?.operationId) {
      items = items.filter((entry) => entry.operationId === filter.operationId);
    }
    if (filter?.patchId) {
      items = items.filter((entry) => entry.patchId === filter.patchId);
    }
    if (filter?.limit !== undefined) {
      items = items.slice(-filter.limit);
    }
    return items;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.cache.push(JSON.parse(line) as AuditLogEntry);
      }
    } catch {
      // missing file is fine
    }
    this.loaded = true;
  }

  private async persistLine(entry: AuditLogEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export function createAuditEntry(
  partial: Omit<AuditLogEntry, 'entryId' | 'timestamp' | 'diagnostics' | 'affectedResources' | 'confirmationReceipts'> & {
    diagnostics?: AuditLogEntry['diagnostics'];
    affectedResources?: string[];
    confirmationReceipts?: AuditLogEntry['confirmationReceipts'];
    timestamp?: string;
  }
): AuditLogEntry {
  return {
    entryId: randomUUID(),
    timestamp: partial.timestamp ?? new Date().toISOString(),
    actor: partial.actor,
    eventKind: partial.eventKind,
    affectedResources: partial.affectedResources ?? [],
    diagnostics: partial.diagnostics ?? [],
    confirmationReceipts: partial.confirmationReceipts ?? [],
    ...(partial.operationId !== undefined ? { operationId: partial.operationId } : {}),
    ...(partial.transactionId !== undefined ? { transactionId: partial.transactionId } : {}),
    ...(partial.toolCallId !== undefined ? { toolCallId: partial.toolCallId } : {}),
    ...(partial.patchId !== undefined ? { patchId: partial.patchId } : {}),
    ...(partial.validationResult !== undefined ? { validationResult: partial.validationResult } : {}),
    ...(partial.commitResult !== undefined ? { commitResult: partial.commitResult } : {}),
    ...(partial.rollbackResult !== undefined ? { rollbackResult: partial.rollbackResult } : {}),
    ...(partial.details !== undefined ? { details: partial.details } : {})
  };
}

export async function writeAuditSnapshot(filePath: string, entries: readonly AuditLogEntry[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}
