import { createHash } from 'node:crypto';

/**
 * Bind stateless cursors to host identities without putting their paths on the wire.
 * Opaque cursors are base64url JSON and can be decoded by the model, so any
 * workspace id (a file:// URL of the absolute workspace root) or source key
 * must be replaced by this digest before it enters a cursor scope.
 */
export function cursorIdentity(identity: string): string {
  return createHash('sha256').update('soulforge-cursor-identity-v1\0').update(identity).digest('hex');
}
