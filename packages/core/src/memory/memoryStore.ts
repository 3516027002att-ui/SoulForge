/**
 * Long-Term Memory Store (Codex MEMORY.md parser, serializer and search engine).
 */

import { randomUUID } from 'node:crypto';
import type { MemoryEntry, MemorySaveInput, MemoryStoreData } from './memoryTypes.js';

export interface MemoryStore {
  list(): MemoryEntry[];
  get(idOrTopic: string): MemoryEntry | undefined;
  search(query: string, limit?: number): MemoryEntry[];
  save(entry: MemorySaveInput): MemoryEntry;
  delete(idOrTopic: string): boolean;
  serializeMarkdown(): string;
  formatForSystemPrompt(maxEntries?: number): string;
}

/**
 * Parse a structured MEMORY.md markdown string into MemoryStoreData.
 *
 * Supported format:
 * # Project Long-Term Memory
 *
 * ## [topic-name] Summary title
 * <!-- tags: tag1, tag2 -->
 * Detailed notes...
 */
export function parseMemoryMarkdown(markdown: string): MemoryStoreData {
  const lines = markdown.split('\n');
  const entries: MemoryEntry[] = [];
  let currentEntry: Partial<MemoryEntry> | null = null;
  let currentBody: string[] = [];

  const flushCurrent = (): void => {
    if (currentEntry && currentEntry.topic) {
      const details = currentBody.join('\n').trim();
      entries.push({
        id: currentEntry.id ?? randomUUID(),
        topic: currentEntry.topic,
        summary: currentEntry.summary ?? currentEntry.topic,
        ...(details.length > 0 ? { details } : {}),
        tags: currentEntry.tags ?? [],
        createdAt: currentEntry.createdAt ?? new Date().toISOString(),
        updatedAt: currentEntry.updatedAt ?? new Date().toISOString()
      });
    }
    currentEntry = null;
    currentBody = [];
  };

  for (const line of lines) {
    const headingMatch = /^##\s+(?:\[(.*?)\])?\s*(.*)$/.exec(line);
    if (headingMatch) {
      flushCurrent();
      const topicTag = headingMatch[1]?.trim();
      const title = headingMatch[2]?.trim() || '';
      const topic = topicTag || title || 'general';
      const summary = title || topic;
      currentEntry = {
        topic,
        summary,
        tags: []
      };
      continue;
    }

    if (currentEntry) {
      const tagsMatch = /<!--\s*tags:\s*(.*?)\s*-->/i.exec(line);
      if (tagsMatch) {
        const parsedTags = tagsMatch[1]?.split(',').map((t) => t.trim()).filter(Boolean) ?? [];
        currentEntry.tags = [...(currentEntry.tags ?? []), ...parsedTags];
        continue;
      }
      const metaMatch = /<!--\s*id:\s*(.*?)(?:,\s*created:\s*(.*?))?(?:,\s*updated:\s*(.*?))?\s*-->/i.exec(line);
      if (metaMatch) {
        if (metaMatch[1]) currentEntry.id = metaMatch[1].trim();
        if (metaMatch[2]) currentEntry.createdAt = metaMatch[2].trim();
        if (metaMatch[3]) currentEntry.updatedAt = metaMatch[3].trim();
        continue;
      }
      currentBody.push(line);
    }
  }

  flushCurrent();

  return {
    version: 1,
    entries
  };
}

/**
 * Serialize MemoryStoreData into human-readable, editable MEMORY.md markdown.
 */
export function serializeMemoryMarkdown(data: MemoryStoreData): string {
  const parts: string[] = ['# Project Long-Term Memory\n'];
  for (const entry of data.entries) {
    parts.push(`## [${entry.topic}] ${entry.summary}`);
    const metaParts: string[] = [`id: ${entry.id}`];
    if (entry.createdAt) metaParts.push(`created: ${entry.createdAt}`);
    if (entry.updatedAt) metaParts.push(`updated: ${entry.updatedAt}`);
    parts.push(`<!-- ${metaParts.join(', ')} -->`);
    if (entry.tags && entry.tags.length > 0) {
      parts.push(`<!-- tags: ${entry.tags.join(', ')} -->`);
    }
    if (entry.details && entry.details.trim().length > 0) {
      parts.push(entry.details.trim());
    }
    parts.push('');
  }
  return parts.join('\n');
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entriesMap = new Map<string, MemoryEntry>();

  constructor(initialData?: MemoryStoreData | string) {
    if (typeof initialData === 'string') {
      const parsed = parseMemoryMarkdown(initialData);
      for (const entry of parsed.entries) {
        this.entriesMap.set(entry.id, entry);
      }
    } else if (initialData?.entries) {
      for (const entry of initialData.entries) {
        this.entriesMap.set(entry.id, entry);
      }
    }
  }

  list(): MemoryEntry[] {
    return [...this.entriesMap.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(idOrTopic: string): MemoryEntry | undefined {
    const direct = this.entriesMap.get(idOrTopic);
    if (direct) return direct;
    const lower = idOrTopic.toLowerCase();
    for (const entry of this.entriesMap.values()) {
      if (entry.topic.toLowerCase() === lower) return entry;
    }
    return undefined;
  }

  search(query: string, limit = 10): MemoryEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list().slice(0, limit);
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of this.entriesMap.values()) {
      let score = 0;
      if (entry.topic.toLowerCase() === q) score += 100;
      else if (entry.topic.toLowerCase().includes(q)) score += 50;
      if (entry.summary.toLowerCase().includes(q)) score += 30;
      if (entry.tags?.some((t) => t.toLowerCase().includes(q))) score += 25;
      if (entry.details?.toLowerCase().includes(q)) score += 10;
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  save(entry: MemorySaveInput): MemoryEntry {
    const existing = entry.id ? this.entriesMap.get(entry.id) : this.get(entry.topic);
    const now = new Date().toISOString();
    const id = existing?.id ?? entry.id ?? randomUUID();
    const saved: MemoryEntry = {
      id,
      topic: entry.topic.trim(),
      summary: entry.summary.trim(),
      ...(entry.details !== undefined ? { details: entry.details.trim() } : existing?.details ? { details: existing.details } : {}),
      tags: entry.tags ?? existing?.tags ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.entriesMap.set(id, saved);
    return saved;
  }

  delete(idOrTopic: string): boolean {
    const existing = this.get(idOrTopic);
    if (!existing) return false;
    return this.entriesMap.delete(existing.id);
  }

  serializeMarkdown(): string {
    return serializeMemoryMarkdown({
      version: 1,
      entries: this.list()
    });
  }

  formatForSystemPrompt(maxEntries = 10): string {
    const entries = this.list().slice(0, maxEntries);
    if (entries.length === 0) return '';
    const lines: string[] = ['## 项目长期记忆 (Project Long-Term Memory):'];
    for (const entry of entries) {
      const detailsSnippet = entry.details ? ` - ${entry.details.replace(/\n+/g, ' ').slice(0, 150)}` : '';
      lines.push(`- [${entry.topic}] ${entry.summary}${detailsSnippet}`);
    }
    lines.push('你可以使用 read_memory/write_memory 工具查阅或记录重要项目知识。');
    return lines.join('\n');
  }
}
