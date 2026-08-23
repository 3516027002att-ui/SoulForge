/**
 * Memory Manager for Electron Main Process.
 * Manages global and workspace-scoped memory below Electron userData.
 * Memory must never be written into a Mod workspace.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InMemoryMemoryStore, type MemoryStore } from '@soulforge/core';

class PersistentMemoryStore implements MemoryStore {
  private inner: InMemoryMemoryStore;

  constructor(initialMarkdown: string, private readonly persist: (markdown: string) => void) {
    this.inner = new InMemoryMemoryStore(initialMarkdown);
  }

  list() { return this.inner.list(); }
  get(idOrTopic: string) { return this.inner.get(idOrTopic); }
  search(query: string, limit?: number) { return this.inner.search(query, limit); }
  serializeMarkdown() { return this.inner.serializeMarkdown(); }
  formatForSystemPrompt(maxEntries?: number) { return this.inner.formatForSystemPrompt(maxEntries); }

  save(entry: Parameters<MemoryStore['save']>[0]) {
    const snapshot = this.inner.serializeMarkdown();
    const saved = this.inner.save(entry);
    try {
      this.persist(this.inner.serializeMarkdown());
      return saved;
    } catch (error) {
      this.inner = new InMemoryMemoryStore(snapshot);
      throw error;
    }
  }

  delete(idOrTopic: string): boolean {
    const snapshot = this.inner.serializeMarkdown();
    const deleted = this.inner.delete(idOrTopic);
    if (!deleted) return false;
    try {
      this.persist(this.inner.serializeMarkdown());
      return true;
    } catch (error) {
      this.inner = new InMemoryMemoryStore(snapshot);
      throw error;
    }
  }
}

export class MemoryManager {
  private readonly userDataMemoryDir: string;
  private readonly stores = new Map<string, MemoryStore>();

  constructor(userDataPath: string) {
    this.userDataMemoryDir = join(userDataPath, 'memory');
    try {
      if (!existsSync(this.userDataMemoryDir)) {
        mkdirSync(this.userDataMemoryDir, { recursive: true });
      }
    } catch {
      // Non-fatal
    }
  }

  private getGlobalMemoryFilePath(): string {
    return join(this.userDataMemoryDir, 'MEMORY.md');
  }

  private getWorkspaceMemoryFilePath(workspaceId: string): string {
    const key = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
    return join(this.userDataMemoryDir, 'workspaces', key, 'MEMORY.md');
  }

  getStore(workspaceId?: string): MemoryStore {
    const key = workspaceId ?? '__global__';
    const cached = this.stores.get(key);
    if (cached) return cached;

    const loaded = this.loadFromDisk(workspaceId);
    this.stores.set(key, loaded);
    return loaded;
  }

  private loadFromDisk(workspaceId?: string): MemoryStore {
    const targetPath = workspaceId
      ? this.getWorkspaceMemoryFilePath(workspaceId)
      : this.getGlobalMemoryFilePath();
    let markdown = '';
    if (existsSync(targetPath)) {
      try {
        markdown = readFileSync(targetPath, 'utf8');
      } catch {
        // A failed read starts empty; a later write still reports failures.
      }
    }
    return new PersistentMemoryStore(markdown, (nextMarkdown) => this.writeAtomically(targetPath, nextMarkdown));
  }

  saveToDisk(workspaceId?: string): void {
    const key = workspaceId ?? '__global__';
    const store = this.stores.get(key);
    if (!store) return;

    const targetPath = workspaceId
      ? this.getWorkspaceMemoryFilePath(workspaceId)
      : this.getGlobalMemoryFilePath();
    this.writeAtomically(targetPath, store.serializeMarkdown());
  }

  getFormattedMemoryForSystemPrompt(workspaceId?: string): string {
    const store = this.getStore(workspaceId);
    return store.formatForSystemPrompt(12);
  }

  private writeAtomically(targetPath: string, markdown: string): void {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temporaryPath = `${targetPath}.tmp-${process.pid}`;
    try {
      writeFileSync(temporaryPath, markdown, 'utf8');
      renameSync(temporaryPath, targetPath);
    } catch (error) {
      try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch { /* best effort */ }
      throw error;
    }
  }
}
