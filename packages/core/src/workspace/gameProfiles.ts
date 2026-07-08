import type { ResourceKind } from '@soulforge/shared';

export type GameId = 'sekiro' | 'elden-ring' | 'dark-souls-3' | 'dark-souls-2' | 'dark-souls-1' | 'bloodborne' | 'unknown';

export interface GameProfile {
  id: GameId;
  displayName: string;
  eventExtensions: string[];
  mapExtensions: string[];
  paramExtensions: string[];
  msgExtensions: string[];
  knownResourceDirs: ResourceKind[];
  mapIdPatterns: RegExp[];
}

export interface GameInferenceResult {
  game: GameId;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
}

const COMMON_RESOURCE_DIRS: ResourceKind[] = ['event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai', 'sfx', 'chr', 'obj', 'other'];

export const GAME_PROFILES: readonly GameProfile[] = [
  {
    id: 'sekiro',
    displayName: 'Sekiro: Shadows Die Twice',
    eventExtensions: ['.emevd.dcx', '.emevd'],
    mapExtensions: ['.msb.dcx', '.msb'],
    paramExtensions: ['.parambnd.dcx', '.param', '.dcx'],
    msgExtensions: ['.msgbnd.dcx', '.fmg', '.dcx'],
    knownResourceDirs: COMMON_RESOURCE_DIRS,
    mapIdPatterns: [/m\d{2}_\d{2}_\d{2}_\d{2}/i]
  },
  {
    id: 'elden-ring',
    displayName: 'Elden Ring',
    eventExtensions: ['.emevd.dcx', '.emevd'],
    mapExtensions: ['.msb.dcx', '.msb'],
    paramExtensions: ['.parambnd.dcx', '.param', '.dcx'],
    msgExtensions: ['.msgbnd.dcx', '.fmg', '.dcx'],
    knownResourceDirs: COMMON_RESOURCE_DIRS,
    mapIdPatterns: [/m\d{2}_\d{2}_\d{2}_\d{2}/i]
  },
  {
    id: 'dark-souls-3',
    displayName: 'Dark Souls III',
    eventExtensions: ['.emevd.dcx', '.emevd'],
    mapExtensions: ['.msb.dcx', '.msb'],
    paramExtensions: ['.parambnd.dcx', '.param', '.dcx'],
    msgExtensions: ['.msgbnd.dcx', '.fmg', '.dcx'],
    knownResourceDirs: COMMON_RESOURCE_DIRS,
    mapIdPatterns: [/m\d{2}_\d{2}_\d{2}_\d{2}/i]
  },
  {
    id: 'unknown',
    displayName: 'Unknown FromSoftware Game',
    eventExtensions: ['.emevd.dcx', '.emevd'],
    mapExtensions: ['.msb.dcx', '.msb'],
    paramExtensions: ['.parambnd.dcx', '.param', '.dcx'],
    msgExtensions: ['.msgbnd.dcx', '.fmg', '.dcx'],
    knownResourceDirs: COMMON_RESOURCE_DIRS,
    mapIdPatterns: [/m\d{2}_\d{2}_\d{2}_\d{2}/i]
  }
];

export function getGameProfile(game: GameId): GameProfile {
  return GAME_PROFILES.find((profile) => profile.id === game) ?? GAME_PROFILES[GAME_PROFILES.length - 1]!;
}

export function inferGameFromWorkspace(relativePaths: readonly string[]): GameInferenceResult {
  const normalized = relativePaths.map((path) => path.toLowerCase().replaceAll('\\', '/'));
  const reasons: string[] = [];

  if (normalized.some((path) => path.includes('sekiro.exe') || path.includes('/sekiro/'))) {
    reasons.push('Workspace path hints at Sekiro.');
    return { game: 'sekiro', confidence: 'medium', reasons };
  }

  if (normalized.some((path) => path.includes('eldenring.exe') || path.includes('/elden ring/') || path.includes('/eldenring/'))) {
    reasons.push('Workspace path hints at Elden Ring.');
    return { game: 'elden-ring', confidence: 'medium', reasons };
  }

  if (normalized.some((path) => path.includes('dark souls iii') || path.includes('darksoulsiii.exe'))) {
    reasons.push('Workspace path hints at Dark Souls III.');
    return { game: 'dark-souls-3', confidence: 'medium', reasons };
  }

  const hasEvent = normalized.some((path) => path.startsWith('event/') || path.includes('.emevd'));
  const hasMap = normalized.some((path) => path.startsWith('map/') || path.includes('.msb'));
  const hasParam = normalized.some((path) => path.startsWith('param/') || path.includes('parambnd'));

  if (hasEvent && hasMap && hasParam) {
    reasons.push('Workspace has event, map, and param resources but no game-specific signature.');
    return { game: 'unknown', confidence: 'low', reasons };
  }

  reasons.push('No strong game signature found.');
  return { game: 'unknown', confidence: 'low', reasons };
}

export function extractMapIdFromPath(relativePath: string, profile: GameProfile = getGameProfile('unknown')): string | undefined {
  const normalized = relativePath.replaceAll('\\', '/');
  for (const pattern of profile.mapIdPatterns) {
    const match = pattern.exec(normalized);
    if (match?.[0]) return match[0];
  }
  return undefined;
}

export function resourceKindFromExtension(relativePath: string): ResourceKind {
  const path = relativePath.toLowerCase().replaceAll('\\', '/');
  if (path.includes('.emevd')) return 'event';
  if (path.includes('.msb')) return 'map';
  if (path.includes('parambnd') || path.endsWith('.param') || path.includes('/param/')) return 'param';
  if (path.includes('msgbnd') || path.endsWith('.fmg') || path.includes('/msg/')) return 'msg';
  if (path.includes('/chr/') || path.endsWith('.chrbnd.dcx') || path.endsWith('.anibnd.dcx')) return 'chr';
  if (path.includes('/obj/') || path.endsWith('.objbnd.dcx')) return 'obj';
  if (path.includes('/sfx/') || path.endsWith('.ffxbnd.dcx')) return 'sfx';
  if (path.includes('/menu/') || path.endsWith('.gfx')) return 'menu';
  if (path.includes('/script/') || path.endsWith('.luabnd.dcx') || path.endsWith('.lua')) return 'script';
  if (path.includes('/other/')) return 'other';
  return 'unknown';
}
