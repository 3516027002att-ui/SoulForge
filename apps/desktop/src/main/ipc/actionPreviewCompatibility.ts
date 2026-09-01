export const C0000_COMPATIBILITY_PART_SLOTS = ['bd', 'am', 'lg', 'hd', 'fc'] as const;
export const C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT = 12;

/**
 * c0000 的脸/头发不是 hd 部件，而是独立的 FC_M_0200 组件。它是原版
 * Wolf 的默认 face/hair 资源；不能按文件名字典序把 fc_m_0000（披风）
 * 或其它变身头部当成 c0000 的头发。
 */
const C0000_COMPATIBILITY_PREFERRED_NAMES: Partial<Record<C0000CompatibilityPartSlot, readonly string[]>> = {
  fc: ['fc_m_0200.partsbnd.dcx']
};

export type C0000CompatibilityPartSlot = typeof C0000_COMPATIBILITY_PART_SLOTS[number];
export type C0000CompatibilityCandidateOrigin = 'overlay' | 'base';

export interface C0000CompatibilityCandidateName {
  origin: C0000CompatibilityCandidateOrigin;
  name: string;
}

/**
 * TAE containers such as c0000_a07x and c0000_c1020 still animate c0000.
 * Keep non-character stems unchanged so their existing actionable not-found
 * diagnostics remain intact.
 */
export function canonicalCharacterStemForActionPath(relativePath: string): string {
  const fileName = relativePath.split(/[\\/]/).pop() ?? relativePath;
  const stem = fileName.replace(/\.(?:tae|anibnd)(?:\.dcx)?$/i, '');
  const character = /^(c\d{4})(?:_|$)/i.exec(stem)?.[1];
  return character?.toLowerCase() ?? stem;
}

/**
 * Produce a deterministic and bounded compatibility-preview search plan.
 * Overlay entries shadow same-named base entries; no path is accepted here,
 * only a single directory-entry name matching the requested body slot.
 */
export function planC0000CompatibilityCandidates(
  slot: C0000CompatibilityPartSlot,
  overlayNames: readonly string[],
  baseNames: readonly string[],
  limit = C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT
): C0000CompatibilityCandidateName[] {
  const safeLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT)
    : C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT;
  const pattern = new RegExp(`^${slot}_[^\\/]+\\.partsbnd(?:\\.dcx)?$`, 'i');
  const compareNames = (left: string, right: string): number => {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    if (a < b) return -1;
    if (a > b) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const seen = new Set<string>();
  const planned: C0000CompatibilityCandidateName[] = [];
  const sources = [
    ['overlay', overlayNames],
    ['base', baseNames]
  ] as const;
  const add = (origin: C0000CompatibilityCandidateOrigin, name: string): boolean => {
    if (!pattern.test(name)) return false;
    const identity = name.toLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity);
    planned.push({ origin, name });
    return planned.length >= safeLimit;
  };

  // A preferred native component is semantic identity, not a first-sibling
  // fallback. Check overlay first so an explicitly supplied mod component
  // still shadows the same-named base component.
  for (const preferred of C0000_COMPATIBILITY_PREFERRED_NAMES[slot] ?? []) {
    for (const [origin, names] of sources) {
      const exact = names.find((candidate) => candidate.toLowerCase() === preferred.toLowerCase());
      if (exact && add(origin, exact)) return planned;
    }
  }

  for (const [origin, names] of sources) {
    for (const name of names.filter((candidate) => pattern.test(candidate)).sort(compareNames)) {
      if (add(origin, name)) return planned;
    }
  }
  return planned;
}
