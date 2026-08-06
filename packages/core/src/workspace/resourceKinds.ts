import {
  ALL_RESOURCE_KINDS,
  KNOWN_RESOURCE_DIRS,
  type ResourceKind
} from '@soulforge/shared';

// 权威列表已下沉到 @soulforge/shared（renderer 可安全引用）；core 仅做 re-export + 分类逻辑。
export { ALL_RESOURCE_KINDS, KNOWN_RESOURCE_DIRS };

export function classifyResourceKind(relativePath: string): ResourceKind {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const firstSegment = normalized.split('/')[0];

  if (firstSegment && (KNOWN_RESOURCE_DIRS as readonly string[]).includes(firstSegment)) {
    return firstSegment as ResourceKind;
  }

  return classifyResourceKindByPath(normalized);
}

export function isKnownResourceKind(value: string): value is ResourceKind {
  return (ALL_RESOURCE_KINDS as readonly string[]).includes(value);
}

function classifyResourceKindByPath(normalizedPath: string): ResourceKind {
  if (normalizedPath.includes('/drawparam/') || normalizedPath.includes('/gameparam/')) return 'param';
  if (normalizedPath.includes('/talk/')) return 'script';

  if (normalizedPath.endsWith('.emevd.dcx') || normalizedPath.endsWith('.emevd')) return 'event';
  if (normalizedPath.endsWith('.msb.dcx') || normalizedPath.endsWith('.msb')) return 'map';
  if (normalizedPath.includes('param') && normalizedPath.endsWith('.dcx')) return 'param';
  if (normalizedPath.endsWith('.fmg.dcx') || normalizedPath.endsWith('.msgbnd.dcx')) return 'msg';
  if (normalizedPath.endsWith('.luabnd.dcx') || normalizedPath.endsWith('.lua')) return 'script';
  if (normalizedPath.endsWith('.gfx')) return 'menu';
  if (normalizedPath.endsWith('.ffxbnd.dcx')) return 'sfx';
  if (normalizedPath.endsWith('.txt') || normalizedPath.endsWith('.md') || normalizedPath.endsWith('.ini') || normalizedPath.endsWith('.cfg')) return 'other';

  return 'unknown';
}
