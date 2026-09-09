import { createHash } from 'node:crypto';

export type Matrix4 = number[];
export type Vec3 = [number, number, number];

export interface CoordinateProfile {
  profileId: string;
  units: 'native' | 'meters' | 'unknown';
  handedness: 'right' | 'left' | 'unknown';
  upAxis: 'x' | 'y' | 'z' | 'unknown';
  forwardAxis: string;
  eulerOrder: string;
  angleUnit: 'degrees' | 'radians';
  nativeToBlender: Matrix4;
  blenderToNative: Matrix4;
  profileHash: string;
}

const EPSILON = 1e-10;

export function identityMatrix4(): Matrix4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function assertMatrix4(matrix: readonly number[], name = 'matrix'): Matrix4 {
  if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) {
    throw new Error(`SCENE_MATRIX_INVALID: ${name}`);
  }
  return [...matrix];
}

export function multiplyMatrix4(left: readonly number[], right: readonly number[]): Matrix4 {
  const a = assertMatrix4(left, 'left');
  const b = assertMatrix4(right, 'right');
  const output = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let inner = 0; inner < 4; inner += 1) output[row * 4 + column]! += a[row * 4 + inner]! * b[inner * 4 + column]!;
    }
  }
  return output;
}

export function invertMatrix4(input: readonly number[]): Matrix4 {
  const matrix = assertMatrix4(input);
  const augmented = Array.from({ length: 4 }, (_, row) => [
    matrix[row * 4]!, matrix[row * 4 + 1]!, matrix[row * 4 + 2]!, matrix[row * 4 + 3]!,
    ...(row === 0 ? [1, 0, 0, 0] : row === 1 ? [0, 1, 0, 0] : row === 2 ? [0, 0, 1, 0] : [0, 0, 0, 1])
  ]);
  for (let column = 0; column < 4; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 4; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    const pivotValue = augmented[pivot]![column]!;
    if (!Number.isFinite(pivotValue) || Math.abs(pivotValue) <= EPSILON) throw new Error('SCENE_MATRIX_SINGULAR');
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const row = augmented[column]!;
    for (let index = 0; index < 8; index += 1) row[index] = row[index]! / pivotValue;
    for (let other = 0; other < 4; other += 1) {
      if (other === column) continue;
      const factor = augmented[other]![column]!;
      if (Math.abs(factor) <= EPSILON) continue;
      for (let index = 0; index < 8; index += 1) augmented[other]![index] = augmented[other]![index]! - factor * row[index]!;
    }
  }
  const inverse = augmented.map((row) => row.slice(4));
  return assertMatrix4(inverse.flat(), 'inverse');
}

export function matrixResidual(left: readonly number[], right: readonly number[]): number {
  const a = assertMatrix4(left, 'left');
  const b = assertMatrix4(right, 'right');
  return Math.max(...a.map((value, index) => Math.abs(value - b[index]!)));
}

export function determinantLinear3(matrix: readonly number[]): number {
  const m = assertMatrix4(matrix);
  return m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!)
    - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!)
    + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
}

export function transformPoint(matrix: readonly number[], point: Vec3): Vec3 {
  const m = assertMatrix4(matrix);
  if (point.some((value) => !Number.isFinite(value))) throw new Error('SCENE_POINT_INVALID');
  const x = m[0]! * point[0] + m[1]! * point[1] + m[2]! * point[2] + m[3]!;
  const y = m[4]! * point[0] + m[5]! * point[1] + m[6]! * point[2] + m[7]!;
  const z = m[8]! * point[0] + m[9]! * point[1] + m[10]! * point[2] + m[11]!;
  const w = m[12]! * point[0] + m[13]! * point[1] + m[14]! * point[2] + m[15]!;
  if (!Number.isFinite(w) || Math.abs(w) <= EPSILON) throw new Error('SCENE_PROJECTIVE_POINT_INVALID');
  return [x / w, y / w, z / w];
}

export function transformNormal(matrix: readonly number[], normal: Vec3): Vec3 {
  const inverse = invertMatrix4(matrix);
  const x = inverse[0]! * normal[0] + inverse[4]! * normal[1] + inverse[8]! * normal[2];
  const y = inverse[1]! * normal[0] + inverse[5]! * normal[1] + inverse[9]! * normal[2];
  const z = inverse[2]! * normal[0] + inverse[6]! * normal[1] + inverse[10]! * normal[2];
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= EPSILON) throw new Error('SCENE_NORMAL_INVALID');
  return [x / length, y / length, z / length];
}

export function convertNativeMatrixToBlender(profile: CoordinateProfile, nativeMatrix: readonly number[]): Matrix4 {
  const c = profile.nativeToBlender;
  return multiplyMatrix4(multiplyMatrix4(c, nativeMatrix), profile.blenderToNative);
}

export function convertBlenderMatrixToNative(profile: CoordinateProfile, blenderMatrix: readonly number[]): Matrix4 {
  return multiplyMatrix4(multiplyMatrix4(profile.blenderToNative, blenderMatrix), profile.nativeToBlender);
}

export function createCoordinateProfile(input: Omit<CoordinateProfile, 'blenderToNative' | 'profileHash'>): CoordinateProfile {
  const nativeToBlender = assertMatrix4(input.nativeToBlender, 'nativeToBlender');
  const blenderToNative = invertMatrix4(nativeToBlender);
  const residual = matrixResidual(multiplyMatrix4(nativeToBlender, blenderToNative), identityMatrix4());
  if (residual > 1e-7) throw new Error(`SCENE_PROFILE_INVERSE_RESIDUAL: ${residual}`);
  const profileHash = createHash('sha256').update(JSON.stringify({ ...input, nativeToBlender }), 'utf8').digest('hex');
  return { ...input, nativeToBlender, blenderToNative, profileHash };
}

export function assertTrsRepresentable(matrix: readonly number[]): { translation: Vec3; scale: Vec3; determinant: number } {
  const m = assertMatrix4(matrix);
  if (Math.abs(m[12]!) > 1e-8 || Math.abs(m[13]!) > 1e-8 || Math.abs(m[14]!) > 1e-8 || Math.abs(m[15]! - 1) > 1e-8) {
    throw new Error('TRANSFORM_NOT_REPRESENTABLE: projective matrix');
  }
  const columns: Vec3[] = [[m[0]!, m[4]!, m[8]!], [m[1]!, m[5]!, m[9]!], [m[2]!, m[6]!, m[10]!]];
  const scale = columns.map((column) => Math.hypot(...column)) as Vec3;
  if (scale.some((value) => value <= EPSILON)) throw new Error('TRANSFORM_NOT_REPRESENTABLE: zero scale');
  const normalized = columns.map((column, index) => column.map((value) => value / scale[index]!) as Vec3);
  const shear = Math.max(
    Math.abs(normalized[0]![0] * normalized[1]![0] + normalized[0]![1] * normalized[1]![1] + normalized[0]![2] * normalized[1]![2]),
    Math.abs(normalized[0]![0] * normalized[2]![0] + normalized[0]![1] * normalized[2]![1] + normalized[0]![2] * normalized[2]![2]),
    Math.abs(normalized[1]![0] * normalized[2]![0] + normalized[1]![1] * normalized[2]![1] + normalized[1]![2] * normalized[2]![2])
  );
  if (shear > 1e-6) throw new Error(`TRANSFORM_NOT_REPRESENTABLE: shear=${shear}`);
  return { translation: [m[3]!, m[7]!, m[11]!], scale, determinant: determinantLinear3(m) };
}

export function reverseTriangleWinding(indices: readonly number[], matrix: readonly number[]): number[] {
  if (indices.length % 3 !== 0 || indices.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('SCENE_INDEX_BUFFER_INVALID');
  const output = [...indices];
  if (determinantLinear3(matrix) < 0) for (let index = 0; index < output.length; index += 3) [output[index + 1], output[index + 2]] = [output[index + 2]!, output[index + 1]!];
  return output;
}
