/**
 * Strict base64 decode for raw/container write paths.
 * Node's Buffer.from(str, 'base64') is too lenient for untrusted input.
 */

export interface DecodeStrictBase64Options {
  /** When false (default), empty decoded payload fails. */
  allowEmpty?: boolean;
}

export class StrictBase64Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StrictBase64Error';
    this.code = code;
  }
}

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode base64 with strict character/length/roundtrip checks.
 */
export function decodeStrictBase64(
  input: string,
  options: DecodeStrictBase64Options = {}
): Buffer {
  const allowEmpty = options.allowEmpty === true;

  if (typeof input !== 'string') {
    throw new StrictBase64Error('BASE64_INVALID_TYPE', 'Base64 input must be a string.');
  }

  // Strip common whitespace variants that may appear in transport, then re-validate.
  const normalized = input.replace(/\s+/g, '');
  if (normalized.length === 0) {
    if (allowEmpty) return Buffer.alloc(0);
    throw new StrictBase64Error('BASE64_EMPTY', 'Empty base64 payload is not allowed.');
  }

  if (normalized.length % 4 !== 0) {
    throw new StrictBase64Error(
      'BASE64_LENGTH_INVALID',
      `Base64 length must be a multiple of 4 (got ${normalized.length}).`
    );
  }

  if (!BASE64_BODY.test(normalized)) {
    throw new StrictBase64Error(
      'BASE64_CHARSET_INVALID',
      'Base64 contains illegal characters or invalid padding.'
    );
  }

  // Padding may only appear at the end; at most two '='.
  const padIndex = normalized.indexOf('=');
  if (padIndex !== -1) {
    const pad = normalized.slice(padIndex);
    if (!/^=+$/.test(pad) || pad.length > 2) {
      throw new StrictBase64Error('BASE64_PADDING_INVALID', 'Invalid base64 padding.');
    }
    if (normalized.slice(0, padIndex).includes('=')) {
      throw new StrictBase64Error('BASE64_PADDING_INVALID', 'Padding may only appear at the end.');
    }
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(normalized, 'base64');
  } catch {
    throw new StrictBase64Error('BASE64_DECODE_FAILED', 'Base64 decode failed.');
  }

  // Round-trip normalize: re-encode and compare (standard alphabet, with padding).
  const reencoded = decoded.toString('base64');
  if (reencoded !== normalized) {
    throw new StrictBase64Error(
      'BASE64_ROUNDTRIP_MISMATCH',
      'Base64 failed normalize roundtrip check (non-canonical or corrupt input).'
    );
  }

  if (decoded.length === 0 && !allowEmpty) {
    throw new StrictBase64Error('BASE64_EMPTY_PAYLOAD', 'Decoded payload is empty.');
  }

  return decoded;
}

export function encodeBase64(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
