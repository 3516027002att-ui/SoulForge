/**
 * Renderer-safe binary helpers (no Node Buffer / fs).
 */

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Loose base64 sanity check for user-supplied replacement bytes. */
export function isLikelyBase64(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(trimmed);
}
