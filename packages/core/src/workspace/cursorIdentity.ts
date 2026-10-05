import { createHash } from 'node:crypto';

/** Bind stateless cursors to host identities without putting their paths on the wire. */
export function cursorIdentity(identity: string): string {
  return createHash('sha256').update('soulforge-cursor-identity-v1\0').update(identity).digest('hex');
}
