/**
 * MSB Region Shape Profiles and Dimension Contracts.
 *
 * Defines MapRegionShape discriminated union, shape profiles, dimension validation,
 * and mathematical scaling constraints per F02 / T03 / T04:
 * - Region transform model is position and rotation only; scale is strictly forbidden.
 * - MapRegionShape: point (shapeType=0), sphere (shapeType=1), cylinder (shapeType=2),
 *   box (shapeType=3), unsupported (other shape types).
 * - Sphere requires uniform scale (r' = r * s); non-uniform scale is rejected with SHAPE_OPERATION_UNSUPPORTED.
 * - Cylinder requires uniform radial scale (scaleX === scaleZ); height scales independently.
 * - Box scales along respective axes without silent axis swapping.
 * - Unknown shape types and point have no dimension edit support and fail-closed as SHAPE_OPERATION_UNSUPPORTED.
 */

export type MapRegionShapeKind = 'point' | 'sphere' | 'cylinder' | 'box' | 'unsupported';

export interface MapRegionPointShape {
  kind: 'point';
  shapeType: 0;
}

export interface MapRegionSphereShape {
  kind: 'sphere';
  shapeType: 1;
  radius: number;
}

export interface MapRegionCylinderShape {
  kind: 'cylinder';
  shapeType: 2;
  radius: number;
  height: number;
}

export interface MapRegionBoxShape {
  kind: 'box';
  shapeType: 3;
  length: number;
  width: number;
  height: number;
}

export interface MapRegionUnsupportedShape {
  kind: 'unsupported';
  shapeType: number;
  rawShapeType?: number | undefined;
  reason?: string | undefined;
}

export type MapRegionShape =
  | MapRegionPointShape
  | MapRegionSphereShape
  | MapRegionCylinderShape
  | MapRegionBoxShape
  | MapRegionUnsupportedShape;

export interface MsbShapeFieldDef {
  name: string;
  type: 'float32';
  offset: number;
  unit: string;
  allowZero: boolean;
}

export interface MsbShapeProfile {
  shapeType: number;
  kind: MapRegionShapeKind;
  name: string;
  writable: boolean;
  shapeDataPointerRule: string;
  fields: readonly MsbShapeFieldDef[];
  untouchedByteRule: string;
  basisHash: string;
  verifiedSamples: readonly string[];
}

export const POINT_SHAPE_PROFILE: MsbShapeProfile = {
  shapeType: 0,
  kind: 'point',
  name: 'Point',
  writable: false,
  shapeDataPointerRule: 'relative_int64_at_0x30_dummy_or_zero',
  fields: [],
  untouchedByteRule: 'zero_write_no_dimensions',
  basisHash: 'sha256:point-profile-v1',
  verifiedSamples: ['Env_Point000', 'Env_Point010', 'Env_Point200']
};

export const SPHERE_SHAPE_PROFILE: MsbShapeProfile = {
  shapeType: 1,
  kind: 'sphere',
  name: 'Sphere',
  writable: true,
  shapeDataPointerRule: 'relative_int64_at_0x30',
  fields: [
    { name: 'radius', type: 'float32', offset: 0, unit: 'm', allowZero: false }
  ],
  untouchedByteRule: 'exact_field_span_4_bytes',
  basisHash: 'sha256:sphere-profile-v1',
  verifiedSamples: ['synthetic-sphere-verified']
};

export const CYLINDER_SHAPE_PROFILE: MsbShapeProfile = {
  shapeType: 2,
  kind: 'cylinder',
  name: 'Cylinder',
  writable: true,
  shapeDataPointerRule: 'relative_int64_at_0x30',
  fields: [
    { name: 'radius', type: 'float32', offset: 0, unit: 'm', allowZero: false },
    { name: 'height', type: 'float32', offset: 4, unit: 'm', allowZero: false }
  ],
  untouchedByteRule: 'exact_field_span_8_bytes',
  basisHash: 'sha256:cylinder-profile-v1',
  verifiedSamples: ['event_徳川炎上_', 'WR_Rakshasa_04', 'FireMonkBattle_01']
};

export const BOX_SHAPE_PROFILE: MsbShapeProfile = {
  shapeType: 3,
  kind: 'box',
  name: 'Box',
  writable: true,
  shapeDataPointerRule: 'relative_int64_at_0x30',
  fields: [
    { name: 'length', type: 'float32', offset: 0, unit: 'm', allowZero: false },
    { name: 'width', type: 'float32', offset: 4, unit: 'm', allowZero: false },
    { name: 'height', type: 'float32', offset: 8, unit: 'm', allowZero: false }
  ],
  untouchedByteRule: 'exact_field_span_12_bytes',
  basisHash: 'sha256:box-profile-v1',
  verifiedSamples: ['event_BGM制御_荒れ寺どんでん洞窟（屋内）', 'event_徳川襲来_炎上_12', 'event_領域_ボス戦開始_子①']
};

export const MSB_SHAPE_PROFILES: Readonly<Record<number, MsbShapeProfile>> = {
  0: POINT_SHAPE_PROFILE,
  1: SPHERE_SHAPE_PROFILE,
  2: CYLINDER_SHAPE_PROFILE,
  3: BOX_SHAPE_PROFILE
};

export function getShapeProfile(shapeType: number): MsbShapeProfile | undefined {
  return MSB_SHAPE_PROFILES[shapeType];
}

export function isShapeSupported(shapeType: number): boolean {
  const profile = getShapeProfile(shapeType);
  return profile !== undefined && profile.writable;
}

/**
 * Validates a MapRegionShape against profile constraints.
 */
export function validateRegionShape(shape: MapRegionShape): {
  valid: boolean;
  code?: string;
  error?: string;
} {
  if (!shape || typeof shape !== 'object') {
    return { valid: false, code: 'SHAPE_OPERATION_UNSUPPORTED', error: 'Shape 必须是有效对象' };
  }

  switch (shape.kind) {
    case 'point':
      return { valid: true };

    case 'sphere': {
      if (typeof shape.radius !== 'number' || !Number.isFinite(shape.radius) || shape.radius <= 0) {
        return {
          valid: false,
          code: 'SHAPE_OPERATION_UNSUPPORTED',
          error: `Sphere radius 必须是有限正数，收到: ${shape.radius}`
        };
      }
      return { valid: true };
    }

    case 'cylinder': {
      if (typeof shape.radius !== 'number' || !Number.isFinite(shape.radius) || shape.radius <= 0) {
        return {
          valid: false,
          code: 'SHAPE_OPERATION_UNSUPPORTED',
          error: `Cylinder radius 必须是有限正数，收到: ${shape.radius}`
        };
      }
      if (typeof shape.height !== 'number' || !Number.isFinite(shape.height) || shape.height <= 0) {
        return {
          valid: false,
          code: 'SHAPE_OPERATION_UNSUPPORTED',
          error: `Cylinder height 必须是有限正数，收到: ${shape.height}`
        };
      }
      return { valid: true };
    }

    case 'box': {
      if (typeof shape.length !== 'number' || !Number.isFinite(shape.length) || shape.length <= 0) {
        return {
          valid: false,
          code: 'SHAPE_OPERATION_UNSUPPORTED',
          error: `Box length 必须是有限正数，收到: ${shape.length}`
        };
      }
      if (typeof shape.width !== 'number' || !Number.isFinite(shape.width) || shape.width <= 0) {
        return {
          valid: false,
          code: 'SHAPE_OPERATION_UNSUPPORTED',
          error: `Box width 必须是有限正数，收到: ${shape.width}`
        };
      }
      if (typeof shape.height !== 'number' || !Number.isFinite(shape.height) || shape.height <= 0) {
        return {
          valid: false,
          code: 'SHAPE_OPERATION_UNSUPPORTED',
          error: `Box height 必须是有限正数，收到: ${shape.height}`
        };
      }
      return { valid: true };
    }

    case 'unsupported':
    default:
      return {
        valid: false,
        code: 'SHAPE_OPERATION_UNSUPPORTED',
        error: `Shape kind ${(shape as any).kind} (shapeType: ${(shape as any).shapeType}) 不支持尺寸修改`
      };
  }
}

/**
 * Computes dimension scaling for a region shape according to strict geometric rules.
 *
 * Rules:
 * - Sphere: uniform scaling only (scaleX === scaleY === scaleZ). Non-uniform scale is rejected with SHAPE_OPERATION_UNSUPPORTED.
 * - Cylinder: radial scaling must be uniform (scaleX === scaleZ). Height (scaleY) can scale independently.
 * - Box: each dimension scales along its respective axis.
 * - Point / Unsupported: rejected with SHAPE_OPERATION_UNSUPPORTED.
 */
export function scaleRegionShape(
  current: MapRegionShape,
  scale: [number, number, number]
): MapRegionShape {
  const [sx, sy, sz] = scale;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz) || sx <= 0 || sy <= 0 || sz <= 0) {
    const err = new Error(`Scale 因子必须是有限正数: [${sx}, ${sy}, ${sz}]`);
    (err as any).code = 'SHAPE_OPERATION_UNSUPPORTED';
    throw err;
  }

  switch (current.kind) {
    case 'sphere': {
      // Sphere requires uniform scaling
      const eps = 1e-5;
      if (Math.abs(sx - sy) > eps || Math.abs(sy - sz) > eps) {
        const err = new Error(`Sphere 仅接受统一缩放，非均匀缩放已拒绝: [${sx}, ${sy}, ${sz}]`);
        (err as any).code = 'SHAPE_OPERATION_UNSUPPORTED';
        throw err;
      }
      return {
        kind: 'sphere',
        shapeType: 1,
        radius: current.radius * sx
      };
    }

    case 'cylinder': {
      // Radial scale must be uniform (scaleX === scaleZ)
      const eps = 1e-5;
      if (Math.abs(sx - sz) > eps) {
        const err = new Error(`Cylinder 径向比例必须相等 (scaleX === scaleZ)，非均匀径向缩放已拒绝: [${sx}, ${sy}, ${sz}]`);
        (err as any).code = 'SHAPE_OPERATION_UNSUPPORTED';
        throw err;
      }
      return {
        kind: 'cylinder',
        shapeType: 2,
        radius: current.radius * sx,
        height: current.height * sy
      };
    }

    case 'box': {
      return {
        kind: 'box',
        shapeType: 3,
        length: current.length * sx,
        width: current.width * sz,
        height: current.height * sy
      };
    }

    case 'point': {
      const err = new Error('Point 形状无尺寸字段，不支持缩放操作');
      (err as any).code = 'SHAPE_OPERATION_UNSUPPORTED';
      throw err;
    }

    case 'unsupported':
    default: {
      const err = new Error(`未支持或未登记 profile 的 Shape 类型无法进行尺寸运算: ${(current as any).shapeType}`);
      (err as any).code = 'SHAPE_OPERATION_UNSUPPORTED';
      throw err;
    }
  }
}

/**
 * Rejects any attempt to set scale on a Region mutation.
 * Per F02 / T03: any of scale, scaleX, scaleY, scaleZ, scaleMultiplier, scaleDelta
 * on a Region (even null, 0, or identity) must be rejected with MSB_REGION_SCALE_UNSUPPORTED.
 */
export function rejectRegionScale(mutation: Record<string, unknown>): void {
  const family = String(mutation.family ?? mutation.entityKind ?? '').toLowerCase();
  if (family === 'region') {
    const scaleKeys = ['scale', 'scaleX', 'scaleY', 'scaleZ', 'scaleMultiplier', 'scaleDelta'];
    for (const key of scaleKeys) {
      if (Object.prototype.hasOwnProperty.call(mutation, key)) {
        const err = new Error(`MSB Region 不支持 scale 字段修改 (${key})，已被安全门禁拦截。`);
        (err as any).code = 'MSB_REGION_SCALE_UNSUPPORTED';
        throw err;
      }
    }
  }
}
