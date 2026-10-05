import assert from 'node:assert/strict';

/** Inspect the wire payload too: a base64 wrapper cannot conceal a host path. */
export function assertCursorPrivacy(value: unknown, forbidden: readonly string[]): number {
  let count = 0;
  const visit = (node: unknown): void => {
    if (typeof node === 'string' && node.startsWith('sf_cur_')) {
      const decoded = Buffer.from(node.slice('sf_cur_'.length), 'base64url').toString('utf8');
      JSON.parse(decoded);
      for (const identity of forbidden) assert.ok(!decoded.includes(identity), `cursor discloses ${identity}`);
      count++;
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node !== null && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(value);
  return count;
}
