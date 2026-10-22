const MAP_PAGE_PROGRESS_STRING_COMPACTION_THRESHOLD = 1024;
const JSON_STRING_REQUIRES_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/**
 * Count the escaped JSON content of a string without constructing its quoted
 * JSON copy. Quotes are counted by JSON.stringify's compact envelope instead.
 * The result is UTF-16 code units, matching String.length in the wire budget.
 */
function jsonEscapedContentLength(value: string): number {
  // Most long MAP strings are base64/data payload text. Keep their fast path
  // in the native regexp engine; only hand exceptional strings to the
  // code-unit counter below.
  if (!JSON_STRING_REQUIRES_ESCAPE.test(value)) return value.length;
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c
      || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      length += 2;
    } else if (code < 0x20) {
      length += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 2;
        index += 1;
      } else {
        // Modern well-formed JSON.stringify escapes an unpaired surrogate as
        // six ASCII code units; paired surrogates remain two raw code units.
        length += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      length += 6;
    } else {
      length += 1;
    }
  }
  return length;
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
    let compactedStringContentCharacters = 0;
    const serialized = JSON.stringify(retainedResponse, (_key, value: unknown) => {
      if (typeof value !== 'string' || value.length < MAP_PAGE_PROGRESS_STRING_COMPACTION_THRESHOLD) return value;
      compactedStringContentCharacters += jsonEscapedContentLength(value);
      // Keep native JSON.stringify responsible for keys, array holes,
      // undefined values, toJSON, property order and cycle detection. Only
      // omit long primitive value contents from its temporary output string.
      return '';
    });
    if (typeof serialized !== 'string') throw new Error('MAP_STATIC_PAGE_INVALID');
    this.wireCharacters += serialized.length + compactedStringContentCharacters;
    if (this.wireCharacters > this.maxWireCharacters) throw new Error('MAP_STATIC_MODEL_WIRE_LIMIT');
    this.complete = page.complete === true;
  }
}
