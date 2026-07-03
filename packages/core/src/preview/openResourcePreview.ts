import { readFile } from 'node:fs/promises';
import type { Diagnostic, IndexedFile, ResourcePreview } from '@soulforge/shared';

export interface OpenResourcePreviewOptions {
  file: IndexedFile;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.xml',
  '.yml',
  '.yaml',
  '.lua',
  '.emevd',
  '.js',
  '.ts',
  '.csv'
]);

export async function openResourcePreview(options: OpenResourcePreviewOptions): Promise<ResourcePreview> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const diagnostics: Diagnostic[] = [];

  try {
    const buffer = await readFile(options.file.absolutePath);
    const slice = buffer.subarray(0, maxBytes);
    const truncated = buffer.byteLength > maxBytes;

    if (buffer.byteLength === 0) {
      return {
        file: options.file,
        previewKind: 'empty',
        truncated: false,
        diagnostics
      };
    }

    if (shouldPreviewAsText(options.file.extension, slice)) {
      return {
        file: options.file,
        previewKind: 'text',
        text: slice.toString('utf8'),
        truncated,
        diagnostics
      };
    }

    return {
      file: options.file,
      previewKind: 'hex',
      hex: toHexPreview(slice),
      truncated,
      diagnostics: [
        ...diagnostics,
        {
          severity: 'info',
          code: 'BINARY_PREVIEW_ONLY',
          message: 'Binary resource is shown as a limited hex preview until a parser is available.',
          sourceUri: options.file.sourceUri
        }
      ]
    };
  } catch (error) {
    return {
      file: options.file,
      previewKind: 'failed',
      truncated: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'PREVIEW_FAILED',
          message: error instanceof Error ? error.message : 'Failed to open resource preview.',
          sourceUri: options.file.sourceUri,
          details: { path: options.file.absolutePath }
        }
      ]
    };
  }
}

function shouldPreviewAsText(extension: string, buffer: Buffer): boolean {
  if (TEXT_EXTENSIONS.has(extension.toLowerCase())) return true;
  if (buffer.includes(0)) return false;

  const sampleLength = Math.min(buffer.byteLength, 512);
  if (sampleLength === 0) return true;

  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const value = buffer[index] ?? 0;
    const isPrintable = value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126) || value >= 128;
    if (!isPrintable) suspicious += 1;
  }

  return suspicious / sampleLength < 0.08;
}

function toHexPreview(buffer: Buffer): string {
  const lines: string[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += 16) {
    const row = buffer.subarray(offset, offset + 16);
    const hex = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...row]
      .map((byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}
