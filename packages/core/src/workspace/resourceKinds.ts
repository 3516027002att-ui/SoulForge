import type { ResourceKind } from '@soulforge/shared';

export const KNOWN_RESOURCE_DIRS: readonly ResourceKind[] = [
  'event',
  'map',
  'param',
  'msg',
  'menu',
  'script',
  'action',
  'ai',
  'sfx'
] as const;

export function classifyResourceKind(relativePath: string): ResourceKind {
  const firstSegment = relativePath.replaceAll('\\', '/').split('/')[0]?.toLowerCase();

  if (firstSegment && (KNOWN_RESOURCE_DIRS as readonly string[]).includes(firstSegment)) {
    return firstSegment as ResourceKind;
  }

  return 'unknown';
}

export function isKnownResourceKind(value: string): value is ResourceKind {
  return (KNOWN_RESOURCE_DIRS as readonly string[]).includes(value);
}
