export const C0000_COMPATIBILITY_PART_SLOTS = ['bd', 'am', 'lg'] as const;
export const C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT = 12;

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
  for (const [origin, names] of [
    ['overlay', overlayNames],
    ['base', baseNames]
  ] as const) {
    for (const name of names.filter((candidate) => pattern.test(candidate)).sort(compareNames)) {
      const identity = name.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      planned.push({ origin, name });
      if (planned.length >= safeLimit) return planned;
    }
  }
  return planned;
}
