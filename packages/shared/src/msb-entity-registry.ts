/**
 * Sekiro MSB 实体类型注册表（跨 C#/TS 的权威投影）。
 *
 * 全集 = 9 个真实地图（m10, m11, m11_01, m11_02, m13, m15, m17, m20, m25）的实体类型并集，
 * 由独立枚举（output/msb-analysis/full_parse.mjs，gitignored）产出，并经 Bridge 偏移表驱动
 * parser 在 9 图全量 smoke 中交叉验证：注册表不得多出或遗漏任何真实出现的类型。
 *
 * 布局对照 SoulsFormats MSBS（仅格式对照，不复制其实现）：文件由 8 个连续 param 组成，
 * 条目偏移绝对化。各家族 type 判别字段偏移（相对条目起点）：
 *   Model  : type@+0x08
 *   Part   : type@+0x08
 *   Region : type@+0x08
 *   Event  : type@+0x0C
 *   Route  : type@+0x10
 * TypeId 0xFFFFFFFF（即 -1）为 Other 哨兵值，属注册表内类型。
 *
 * 「PartsReference 族」：Sekiro MSB 二进制没有独立 reference param（SoulsFormats MSBS
 * 同样只读 8 个 param，无 PartsReference 类）。part 对 model/part 的引用是 Part 条目内
 * 字段：ModelIndex@+0x10（引用 MODEL_PARAM_ST 条目索引）、sibRel@+0x18（可选引用另一
 * part 名）、typeData 内按名引用。引用类型由引用方 part type 决定，故注册表将其列为
 * 派生族（derivedFrom='part'），复用 part 族枚举，不另设判别字段。
 */

export type MsbEntityFamilyKey = 'model' | 'part' | 'region' | 'event' | 'route' | 'partsReference';

export interface MsbEntityFamilyDef {
  label: string;
  paramName: string;
  /** 判别字段相对条目起点的字节偏移。派生族不设判别字段时省略。 */
  typeOffset?: number;
  types: Record<number, string>;
}

export interface MsbPartsReferenceFamilyDef {
  label: string;
  paramName: string;
  derivedFrom: 'part';
  note: string;
}

export const SEKIRO_MSB_ENTITY_TYPE_REGISTRY = {
  schemaVersion: 1,
  game: 'sekiro',
  resourceKind: 'map',
  corpus: ['m10', 'm11', 'm11_01', 'm11_02', 'm13', 'm15', 'm17', 'm20', 'm25'],
  families: {
    model: {
      label: 'Model 族',
      paramName: 'MODEL_PARAM_ST',
      typeOffset: 0x08,
      types: {
        0: 'MapPiece',
        1: 'Object',
        2: 'Enemy',
        4: 'Player',
        5: 'Collision'
      }
    },
    part: {
      label: 'Part 族',
      paramName: 'PARTS_PARAM_ST',
      typeOffset: 0x08,
      types: {
        0: 'MapPiece',
        1: 'Object',
        2: 'Enemy',
        4: 'Player',
        5: 'Collision',
        9: 'DummyObject',
        10: 'DummyEnemy',
        11: 'ConnectCollision'
      }
    },
    region: {
      label: 'Region 族',
      paramName: 'POINT_PARAM_ST',
      typeOffset: 0x08,
      types: {
        0: 'Logic',
        1: 'InvasionPoint',
        2: 'EnvironmentMapPoint',
        4: 'Sound',
        5: 'SFX',
        6: 'WindSFX',
        8: 'SpawnPoint',
        11: 'PatrolRoute',
        13: 'WarpPoint',
        14: 'ActivationArea',
        15: 'Event',
        17: 'EnvironmentMapEffectBox',
        18: 'WindArea',
        20: 'MufflingBox',
        21: 'MufflingPortal',
        23: 'SoundSpaceOverride',
        24: 'MufflingPlane',
        25: 'PartsGroupArea',
        26: 'AutoDrawGroupPoint',
        '-1': 'Other'
      }
    },
    event: {
      label: 'Event 族',
      paramName: 'EVENT_PARAM_ST',
      typeOffset: 0x0c,
      types: {
        4: 'Treasure',
        5: 'Generator',
        7: 'ObjAct',
        9: 'MapOffset',
        14: 'PatrolInfo',
        15: 'PlatoonInfo',
        17: 'ResourceItemInfo',
        18: 'GrassLodParam',
        20: 'SkitInfo',
        21: 'PlacementGroup',
        22: 'PartsGroup',
        23: 'Talk',
        24: 'AutoDrawGroupCollision',
        '-1': 'Other'
      }
    },
    route: {
      label: 'Route 族',
      paramName: 'ROUTE_PARAM_ST',
      typeOffset: 0x10,
      types: {
        3: 'MufflingPortalLink',
        4: 'MufflingBoxLink'
      }
    },
    partsReference: {
      label: 'PartsReference 族（派生：part→model/part 引用层）',
      paramName: 'PARTS_PARAM_ST',
      derivedFrom: 'part',
      note: 'Sekiro MSB 无独立 reference param；引用由 Part 条目字段承载（ModelIndex@+0x10、sibRel@+0x18、typeData 按名引用），类型随引用方 part type。'
    }
  }
} as const;

export type MsbEntityTypeRegistry = typeof SEKIRO_MSB_ENTITY_TYPE_REGISTRY;

const FAMILY_TYPES: Record<MsbEntityFamilyKey, Record<number, string> | undefined> = {
  model: SEKIRO_MSB_ENTITY_TYPE_REGISTRY.families.model.types,
  part: SEKIRO_MSB_ENTITY_TYPE_REGISTRY.families.part.types,
  region: SEKIRO_MSB_ENTITY_TYPE_REGISTRY.families.region.types,
  event: SEKIRO_MSB_ENTITY_TYPE_REGISTRY.families.event.types,
  route: SEKIRO_MSB_ENTITY_TYPE_REGISTRY.families.route.types,
  partsReference: SEKIRO_MSB_ENTITY_TYPE_REGISTRY.families.part.types
};

/** 家族在注册表内是否有对应类型判别。 */
export function isRegisteredMsbFamily(family: string): family is MsbEntityFamilyKey {
  return Object.prototype.hasOwnProperty.call(SEKIRO_MSB_ENTITY_TYPE_REGISTRY.families, family);
}

/**
 * 判断 family+typeId 是否属于注册表。
 * typeId 以有符号 32 位归一化（0xFFFFFFFF → -1）。
 */
export function isRegisteredMsbType(family: MsbEntityFamilyKey, typeId: number): boolean {
  const types = FAMILY_TYPES[family];
  if (!types) return false;
  const normalized = normalizeMsbTypeId(typeId);
  return Object.prototype.hasOwnProperty.call(types, normalized);
}

/** 返回 family+typeId 的类型名；未注册返回 undefined。 */
export function lookupMsbTypeName(family: MsbEntityFamilyKey, typeId: number): string | undefined {
  const types = FAMILY_TYPES[family];
  if (!types) return undefined;
  return types[normalizeMsbTypeId(typeId)];
}

/** 0xFFFFFFFF（uint32）归一化为有符号 -1，便于与 C# int 一致。 */
export function normalizeMsbTypeId(typeId: number): number {
  if (typeId === 0xffffffff || typeId === -1) return -1;
  return Math.trunc(typeId);
}
