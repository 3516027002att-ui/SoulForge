// With `u`, valid surrogate pairs are single code points and do not match;
// lone surrogates still match and keep JSON.stringify's well-formed escaping.
const needsJsonStringEscape = /["\\\u0000-\u001f\ud800-\udfff]/u;

function countMapEnvelopeWireCharacters(envelope: unknown): number {
  let removedCharacters = 0;
  const serialized = JSON.stringify(envelope, (_key, value: unknown) => {
    // Native JSON still owns traversal, hooks, omission and unsupported-value
    // behavior. Only escape-free long string values use the allocation-saving
    // path; property keys, boxed strings and escaped text serialize normally.
    if (typeof value === 'string' && value.length >= 1024 && !needsJsonStringEscape.test(value)) {
      removedCharacters += value.length;
      return ''; // Keep the same two quote characters in the small projection.
    }
    return value;
  });
  if (typeof serialized !== 'string') throw new Error('MAP_STATIC_PAGE_INVALID');
  // Preserve the existing UTF-16 character budget, rather than changing it to
  // UTF-8 bytes. The replacer does not modify or retain the input envelope.
  return serialized.length + removedCharacters;
}

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
    this.wireCharacters += countMapEnvelopeWireCharacters(retainedResponse);
    if (this.wireCharacters > this.maxWireCharacters) throw new Error('MAP_STATIC_MODEL_WIRE_LIMIT');
    this.complete = page.complete === true;
  }
}
