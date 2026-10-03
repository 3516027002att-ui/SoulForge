/** A malformed/replayed page must terminate one model, never occupy a loader forever. */
export class MapPageProgress {
  private readonly cursors = new Set<string>();
  private session: string | null = null;
  private pages = 0;
  private wireCharacters = 0;
  private complete = false;
  private readonly maxPages: number;
  private readonly maxWireCharacters: number;
  constructor(options: { maxPages?: number; maxWireCharacters?: number } = {}) {
    this.maxPages = options.maxPages ?? 4096;
    this.maxWireCharacters = options.maxWireCharacters ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1 || !Number.isSafeInteger(this.maxWireCharacters) || this.maxWireCharacters < 1) throw new Error('MAP_STATIC_PAGE_BUDGET_INVALID');
  }
  accept(page: { sessionToken?: string | null; nextCursor?: string | null; complete?: boolean; chunks?: unknown[] } | null | undefined, retainedResponse: unknown = page): void {
    if (!page || this.complete) throw new Error('MAP_STATIC_PAGE_INVALID');
    if (++this.pages > this.maxPages) throw new Error('MAP_STATIC_PAGE_LIMIT');
    if (page.sessionToken) {
      if (this.session && page.sessionToken !== this.session) throw new Error('MAP_STATIC_SESSION_CHANGED');
      this.session = page.sessionToken;
    }
    if (page.complete !== true && !page.nextCursor) throw new Error('MAP_STATIC_PAGE_INCOMPLETE');
    if (page.complete === true && page.nextCursor) throw new Error('MAP_STATIC_COMPLETE_HAS_CURSOR');
    if (page.nextCursor) {
      if (this.cursors.has(page.nextCursor)) throw new Error('MAP_STATIC_CURSOR_REPEATED');
      this.cursors.add(page.nextCursor);
    }
    // Count the full returned envelope before chunks/diagnostics are retained,
    // including data URI textures, nested materials, metadata and cursors.
    // Counting only *Base64 properties allowed PNG preview tokens to bypass
    // the accumulated model budget on every page.
    const serialized = JSON.stringify(retainedResponse);
    if (typeof serialized !== 'string') throw new Error('MAP_STATIC_PAGE_INVALID');
    this.wireCharacters += serialized.length;
    if (this.wireCharacters > this.maxWireCharacters) throw new Error('MAP_STATIC_MODEL_WIRE_LIMIT');
    this.complete = page.complete === true;
  }
}
