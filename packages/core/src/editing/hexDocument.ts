/**
 * Safe Hex document model — virtualized page access over owned bytes.
 * Mutations produce EditorMutation-compatible payloads; no filesystem I/O.
 */

import { createHash } from 'node:crypto';

export interface HexPage {
  offset: number;
  length: number;
  bytesBase64: string;
}

export interface HexBytePatch {
  offset: number;
  oldBytesBase64: string;
  newBytesBase64: string;
}

export interface HexSearchHit {
  offset: number;
  length: number;
}

export interface HexSearchResult {
  queryBase64: string;
  hits: HexSearchHit[];
  truncated: boolean;
  scannedBytes: number;
}

export interface HexJumpResult {
  ok: boolean;
  offset: number;
  pageIndex: number;
  page?: HexPage;
  code?: string;
  message?: string;
}

export interface HexDiffSpan {
  offset: number;
  length: number;
  leftBase64: string;
  rightBase64: string;
}

export interface HexDiffResult {
  equal: boolean;
  leftSize: number;
  rightSize: number;
  spans: HexDiffSpan[];
  truncated: boolean;
}


export class HexDocument {
  private bytes: Buffer;
  readonly pageSize: number;

  constructor(bytes: Buffer, pageSize = 256) {
    if (pageSize < 16 || pageSize > 4096) throw new Error('HEX_PAGE_SIZE_INVALID');
    this.bytes = Buffer.from(bytes);
    this.pageSize = pageSize;
  }

  get byteLength(): number {
    return this.bytes.length;
  }

  get contentHash(): string {
    return createHash('sha256').update(this.bytes).digest('hex');
  }

  pageCount(): number {
    return Math.max(1, Math.ceil(this.bytes.length / this.pageSize));
  }

  readPage(pageIndex: number): HexPage {
    if (pageIndex < 0 || pageIndex >= this.pageCount()) {
      throw new Error('HEX_PAGE_OUT_OF_RANGE');
    }
    const offset = pageIndex * this.pageSize;
    const slice = this.bytes.subarray(offset, Math.min(offset + this.pageSize, this.bytes.length));
    return {
      offset,
      length: slice.length,
      bytesBase64: Buffer.from(slice).toString('base64')
    };
  }

  applyPatch(patch: HexBytePatch): { ok: true; contentHash: string } | { ok: false; code: string; message: string } {
    let oldBytes: Buffer;
    let newBytes: Buffer;
    try {
      oldBytes = Buffer.from(patch.oldBytesBase64, 'base64');
      newBytes = Buffer.from(patch.newBytesBase64, 'base64');
    } catch {
      return { ok: false, code: 'HEX_PATCH_BASE64_INVALID', message: 'Hex patch base64 无效。' };
    }
    if (oldBytes.length === 0 || oldBytes.length !== newBytes.length) {
      return { ok: false, code: 'HEX_PATCH_LENGTH_MISMATCH', message: 'Hex patch 新旧长度必须相同且非空。' };
    }
    if (patch.offset < 0 || patch.offset + oldBytes.length > this.bytes.length) {
      return { ok: false, code: 'HEX_PATCH_OUT_OF_RANGE', message: 'Hex patch 超出文档范围。' };
    }
    const current = this.bytes.subarray(patch.offset, patch.offset + oldBytes.length);
    if (!current.equals(oldBytes)) {
      return { ok: false, code: 'HEX_PATCH_STALE', message: '目标字节已变化，拒绝覆盖。' };
    }
    newBytes.copy(this.bytes, patch.offset);
    return { ok: true, contentHash: this.contentHash };
  }

  size(): number {
    return this.bytes.length;
  }

  jumpTo(offset: number): HexJumpResult {
    if (!Number.isInteger(offset)) {
      return { ok: false, offset: 0, pageIndex: 0, page: this.readPage(0), message: "offset must be an integer" };
    }
    if (this.bytes.length === 0) {
      return { ok: false, offset: 0, pageIndex: 0, page: this.readPage(0), message: "document is empty" };
    }
    if (offset < 0 || offset >= this.bytes.length) {
      return { ok: false, offset: 0, pageIndex: 0, page: this.readPage(0), message: "offset out of range" };
    }
    const pageIndex = Math.floor(offset / this.pageSize);
    return { ok: true, offset, pageIndex, page: this.readPage(pageIndex) };
  }

  findBytes(query: Buffer | Uint8Array | string, options: { fromOffset?: number; maxHits?: number } = {}): HexSearchResult {
    const needle = typeof query === "string"
      ? Buffer.from(query, "base64")
      : Buffer.from(query);
    if (needle.length === 0) {
      return { queryBase64: "", hits: [], truncated: false, scannedBytes: 0 };
    }
    const fromOffset = Math.max(0, options.fromOffset ?? 0);
    const maxHits = Math.max(1, options.maxHits ?? 256);
    const hits: HexSearchHit[] = [];
    let cursor = fromOffset;
    while (cursor <= this.bytes.length - needle.length) {
      const found = this.bytes.indexOf(needle, cursor);
      if (found < 0) break;
      hits.push({ offset: found, length: needle.length });
      if (hits.length >= maxHits) {
        return {
          queryBase64: needle.toString("base64"),
          hits,
          truncated: true,
          scannedBytes: this.bytes.length - fromOffset
        };
      }
      cursor = found + 1;
    }
    return {
      queryBase64: needle.toString("base64"),
      hits,
      truncated: false,
      scannedBytes: this.bytes.length - fromOffset
    };
  }

  findAscii(text: string, options: { fromOffset?: number; maxHits?: number; caseInsensitive?: boolean } = {}): HexSearchResult {
    if (typeof text !== "string" || text.length === 0) {
      return { queryBase64: "", hits: [], truncated: false, scannedBytes: 0 };
    }
    if (options.caseInsensitive) {
      const fromOffset = Math.max(0, options.fromOffset ?? 0);
      const maxHits = Math.max(1, options.maxHits ?? 256);
      const hay = this.bytes.toString("latin1").toLowerCase();
      const needle = text.toLowerCase();
      const hits: HexSearchHit[] = [];
      let cursor = fromOffset;
      while (cursor <= hay.length - needle.length) {
        const found = hay.indexOf(needle, cursor);
        if (found < 0) break;
        hits.push({ offset: found, length: needle.length });
        if (hits.length >= maxHits) {
          return {
            queryBase64: Buffer.from(text, "utf8").toString("base64"),
            hits,
            truncated: true,
            scannedBytes: this.bytes.length - fromOffset
          };
        }
        cursor = found + 1;
      }
      return {
        queryBase64: Buffer.from(text, "utf8").toString("base64"),
        hits,
        truncated: false,
        scannedBytes: this.bytes.length - fromOffset
      };
    }
    return this.findBytes(Buffer.from(text, "utf8"), options);
  }

  diffAgainst(other: Buffer | Uint8Array | HexDocument, options: { maxSpans?: number } = {}): HexDiffResult {
    const right = other instanceof HexDocument
      ? other.snapshot()
      : (Buffer.isBuffer(other) ? other : Buffer.from(other));
    const left = this.bytes;
    const maxSpans = Math.max(1, options.maxSpans ?? 256);
    const spans: HexDiffSpan[] = [];
    const limit = Math.max(left.length, right.length);
    let i = 0;
    while (i < limit && spans.length < maxSpans) {
      if (i < left.length && i < right.length && left[i] === right[i]) {
        i += 1;
        continue;
      }
      const startOffset = i;
      while (i < limit) {
        const same = i < left.length && i < right.length && left[i] === right[i];
        if (same) break;
        i += 1;
      }
      const length = i - startOffset;
      const leftSlice = i <= left.length ? left.subarray(startOffset, Math.min(i, left.length)) : Buffer.alloc(0);
      const rightSlice = i <= right.length ? right.subarray(startOffset, Math.min(i, right.length)) : Buffer.alloc(0);
      // For divergent tails beyond one side, still capture available bytes.
      const leftBytes = left.subarray(startOffset, Math.min(startOffset + length, left.length));
      const rightBytes = right.subarray(startOffset, Math.min(startOffset + length, right.length));
      spans.push({
        offset: startOffset,
        length,
        leftBase64: leftBytes.toString('base64'),
        rightBase64: rightBytes.toString('base64')
      });
    }
    return {
      equal: spans.length === 0 && left.length === right.length,
      leftSize: left.length,
      rightSize: right.length,
      spans,
      truncated: i < limit
    };
  }

  snapshot(): Buffer {
    return Buffer.from(this.bytes);
  }
}
