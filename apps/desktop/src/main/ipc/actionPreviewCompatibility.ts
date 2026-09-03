export const C0000_COMPATIBILITY_PART_SLOTS = ['bd', 'am', 'lg', 'hd', 'fc'] as const;
export const C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT = 12;

/**
 * c0000 的兼容预览不能把「第一个能解析的 partsbnd」当成身体。
 *
 * 这些身份来自两个独立的只读来源：
 * 1. DSAnimStudio 的 SDT NewChrAsm 配置：Head/Body/Arms/Legs 使用
 *    EquipParamProtector 行 100000/101000/102000/103000，Face 使用
 *    直接装备 FC_M_0200；
 * 2. 当前原版 EquipParamProtector 的 native read：上述四行的
 *    equipModelId / equipModelGender / headEquip..legEquip 分别解析为
 *    200/9040/9000/9000、男性模型，且槽位位标记各自唯一。
 *
 * 因此主资源名是 `hd_m_9510`、`bd_m_9040`、`am_m_9000`、
 * `lg_m_9000` 和 `fc_m_0200`。这里的优先级不是猜测，也不是按目录
 * 顺序推导；它只把成熟工具已经证明的装备身份放到有限候选队列最前面。
 * 找不到这些身份时仍允许后续候选参与只读诊断，但调用方不得把邻近
 * 候选宣称为当前装备。
 */
const C0000_COMPATIBILITY_PREFERRED_NAMES: Partial<Record<C0000CompatibilityPartSlot, readonly string[]>> = {
  bd: ['bd_m_9040.partsbnd.dcx'],
  am: ['am_m_9000.partsbnd.dcx'],
  lg: ['lg_m_9000.partsbnd.dcx'],
  hd: ['hd_m_9510.partsbnd.dcx'],
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
