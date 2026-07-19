import { createHash } from 'node:crypto';
import type { PatchTypedValue } from '@soulforge/shared';

/** Stable SHA-256 identity for a typed semantic value stored in entry history. */
export function hashPatchTypedValue(value: PatchTypedValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
