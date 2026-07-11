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

  snapshot(): Buffer {
    return Buffer.from(this.bytes);
  }
}
