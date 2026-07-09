/**
 * Read helpers for Files Mode (bounded by default).
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import { probeFile, DEFAULT_PROBE_PREFIX_BYTES } from '../vfs/boundedFileProbe.js';
import { getFileCapabilities } from './fileCapabilities.js';

export interface ReadFileResourceResult {
  absolutePath: string;
  relativePath: string;
  size: number;
  mode: 'bounded' | 'full_text' | 'full_bytes';
  bytesRead: number;
  contentHash?: string;
  text?: string;
  bytesBase64?: string;
  truncated: boolean;
  diagnostics: StructuredDiagnostic[];
  nativeFormatAuthority: false;
}

export async function readFileResource(input: {
  absolutePath: string;
  relativePath: string;
  mode?: 'bounded' | 'full_text' | 'full_bytes';
  maxBytes?: number;
}): Promise<ReadFileResourceResult> {
  const mode = input.mode ?? 'bounded';
  const caps = getFileCapabilities({
    absolutePath: input.absolutePath,
    relativePath: input.relativePath
  });
  const diagnostics: StructuredDiagnostic[] = [];

  if (mode === 'bounded' || (caps.isPackedOrNative && mode !== 'full_bytes' && mode !== 'full_text')) {
    const probe = await probeFile(input.absolutePath, {
      maxPrefixBytes: input.maxBytes ?? DEFAULT_PROBE_PREFIX_BYTES,
      deferHash: caps.isPackedOrNative
    });
    if (caps.isPackedOrNative && mode !== 'bounded') {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        code: 'PACKED_READ_BOUNDED',
        message: 'Packed/native-like file defaulted to bounded read to avoid full payload load.',
        details: { relativePath: input.relativePath, nativeFormatAuthority: false }
      }));
    }
    return {
      absolutePath: input.absolutePath,
      relativePath: input.relativePath,
      size: probe.size,
      mode: 'bounded',
      bytesRead: probe.bytesRead,
      ...(probe.contentHash ? { contentHash: probe.contentHash } : {}),
      ...(caps.isTextLike && !probe.looksBinary
        ? { text: probe.prefix.toString('utf8') }
        : { bytesBase64: probe.prefix.toString('base64') }),
      truncated: probe.bytesRead < probe.size,
      diagnostics,
      nativeFormatAuthority: false
    };
  }

  if (mode === 'full_text') {
    const text = await readFile(input.absolutePath, 'utf8');
    const contentHash = createHash('sha256').update(text).digest('hex');
    return {
      absolutePath: input.absolutePath,
      relativePath: input.relativePath,
      size: Buffer.byteLength(text, 'utf8'),
      mode: 'full_text',
      bytesRead: Buffer.byteLength(text, 'utf8'),
      contentHash,
      text,
      truncated: false,
      diagnostics,
      nativeFormatAuthority: false
    };
  }

  const bytes = await readFile(input.absolutePath);
  return {
    absolutePath: input.absolutePath,
    relativePath: input.relativePath,
    size: bytes.byteLength,
    mode: 'full_bytes',
    bytesRead: bytes.byteLength,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    bytesBase64: bytes.toString('base64'),
    truncated: false,
    diagnostics,
    nativeFormatAuthority: false
  };
}
