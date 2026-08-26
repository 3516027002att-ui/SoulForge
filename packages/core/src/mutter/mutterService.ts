import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface MutterLoadResult {
  ok: boolean;
  count: number;
  revision: number;
  code?: 'MUTTER_FILE_UNAVAILABLE' | 'MUTTER_READ_FAILED';
}

/**
 * Extract one mutter per line. Only a line fully wrapped in straight double
 * quotes is data; blank lines, headings and every other Markdown line are
 * intentionally ignored.
 */
export function parseMutterMarkdown(markdown: string): string[] {
  const entries: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length < 2 || line[0] !== '"' || line[line.length - 1] !== '"') continue;

    const value = line.slice(1, -1).trim();
    if (value.length === 0 || value.includes('\n') || value.includes('\r')) continue;
    entries.push(value);
  }
  return entries;
}

function shuffledCopy(values: readonly string[], random: () => number): string[] {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const candidate = Math.floor(random() * (index + 1));
    const swapIndex = Math.max(0, Math.min(index, candidate));
    const current = output[index];
    const swap = output[swapIndex];
    if (current === undefined || swap === undefined) continue;
    output[index] = swap;
    output[swapIndex] = current;
  }
  return output;
}

/**
 * Tiny, failure-isolated runtime for the UI-only mutter pool.
 *
 * It never talks to the Agent, RAG, Patch Engine or model-service layer. The
 * caller asks for `next()` when the UI wants another line. A shuffle bag is
 * used instead of independent random picks so a short pool does not visibly
 * repeat itself.
 */
export class MutterService {
  private entries: string[] = [];
  private queue: string[] = [];
  private revision = 0;
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private lastReturned: string | null = null;

  constructor(
    readonly filePath: string,
    private readonly random: () => number = Math.random
  ) {}

  async load(): Promise<MutterLoadResult> {
    let markdown: string;
    try {
      markdown = await readFile(this.filePath, 'utf8');
    } catch (error) {
      this.entries = [];
      this.queue = [];
      this.revision += 1;
      const code = typeof error === 'object' && error !== null
        && (error as { code?: string }).code === 'ENOENT'
        ? 'MUTTER_FILE_UNAVAILABLE'
        : 'MUTTER_READ_FAILED';
      return { ok: false, count: 0, revision: this.revision, code };
    }

    this.entries = parseMutterMarkdown(markdown);
    this.revision += 1;
    this.refillQueue();
    return { ok: true, count: this.entries.length, revision: this.revision };
  }

  next(): string | null {
    if (this.queue.length === 0) this.refillQueue();
    const value = this.queue.shift() ?? null;
    if (value !== null) this.lastReturned = value;
    return value;
  }

  snapshot(): { count: number; revision: number } {
    return { count: this.entries.length, revision: this.revision };
  }

  /**
   * Optional hot reload. fs.watch is deliberately best-effort: watcher errors
   * and malformed/missing files only empty/reload this cosmetic pool and can
   * never fail application startup.
   */
  startWatching(debounceMs = 120): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.filePath, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          void this.load();
        }, Math.max(0, debounceMs));
      });
      this.watcher.on('error', () => {
        this.stopWatching();
      });
    } catch {
      // Cosmetic feature: failure to watch must never escape to app startup.
    }
  }

  stopWatching(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  dispose(): void {
    this.stopWatching();
    this.entries = [];
    this.queue = [];
  }

  private refillQueue(): void {
    this.queue = shuffledCopy(this.entries, this.random);
    if (this.queue.length <= 1 || this.lastReturned === null || this.queue[0] !== this.lastReturned) return;

    const alternative = this.queue.findIndex((entry) => entry !== this.lastReturned);
    if (alternative <= 0) return;
    const first = this.queue[0];
    const replacement = this.queue[alternative];
    if (first === undefined || replacement === undefined) return;
    this.queue[0] = replacement;
    this.queue[alternative] = first;
  }
}
