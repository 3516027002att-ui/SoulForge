import type {
  FlverPreviewMesh,
  FlverPreviewVertexColorDiagnostic,
  FlverPreviewVector3Diagnostic,
  FlverPreviewVector4Diagnostic
} from '@soulforge/shared';
import type { BufferGeometry } from 'three';
import { decodeBase64ToUint8Array } from '../utils/binary.js';

export type FlverNativeVertexDiagnosticSource = Pick<FlverPreviewMesh,
  'positionStatus' | 'positionFailure' | 'positionDiagnostics'
  | 'normalStatus' | 'normalFailure' | 'normalDiagnostics'
  | 'vertexColorStatus' | 'vertexColorFailure' | 'vertexColorDiagnostics'
  | 'tangentStatus' | 'tangentFailure' | 'tangentDiagnostics'
  | 'bitangentStatus' | 'bitangentFailure' | 'bitangentDiagnostics'>;

export interface FlverSceneVertexColorDiagnostic extends Omit<FlverPreviewVertexColorDiagnostic, 'rgbaBase64'> {
  rgba: Float32Array;
}

export interface FlverSceneVector4Diagnostic extends Omit<FlverPreviewVector4Diagnostic, 'xyzwBase64'> {
  xyzw: Float32Array;
}

export interface FlverSceneVector3Diagnostic extends Omit<FlverPreviewVector3Diagnostic, 'xyzBase64' | 'normalWBase64'> {
  xyz: Float32Array;
  normalW?: Int32Array | undefined;
}

export interface FlverSceneNativeVertexDiagnostics extends Pick<FlverNativeVertexDiagnosticSource,
  'positionStatus' | 'positionFailure' | 'normalStatus' | 'normalFailure'
  | 'vertexColorStatus' | 'vertexColorFailure' | 'tangentStatus' | 'tangentFailure'
  | 'bitangentStatus' | 'bitangentFailure'> {
  positionDiagnostics?: FlverSceneVector3Diagnostic[] | undefined;
  normalDiagnostics?: FlverSceneVector3Diagnostic[] | undefined;
  vertexColorDiagnostics?: FlverSceneVertexColorDiagnostic[] | undefined;
  tangentDiagnostics?: FlverSceneVector4Diagnostic[] | undefined;
  bitangentDiagnostics?: FlverSceneVector4Diagnostic[] | undefined;
}

function assertVector4(values: Float32Array | Int32Array, vertexCount: number, label: string, itemSize = 4): void {
  if (values.length !== vertexCount * itemSize) {
    throw new Error(`FLVER_ATTRIBUTE_LENGTH_MISMATCH: ${label} expected=${vertexCount * itemSize} actual=${values.length}`);
  }
  if (!values.every(Number.isFinite)) throw new Error(`FLVER_ATTRIBUTE_NONFINITE: ${label}`);
}

function decodeVector4(base64: string, vertexCount: number, label: string): Float32Array {
  const bytes = decodeBase64ToUint8Array(base64);
  if (bytes.byteLength !== vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`FLVER_ATTRIBUTE_LENGTH_MISMATCH: ${label} expectedBytes=${vertexCount * 16} actualBytes=${bytes.byteLength}`);
  }
  const values = new Float32Array((bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assertVector4(values, vertexCount, label);
  return values;
}

function decodeVector3Member(member: FlverPreviewVector3Diagnostic, vertexCount: number, label: string): FlverSceneVector3Diagnostic {
  const { xyzBase64, normalWBase64, ...metadata } = member;
  const bytes = decodeBase64ToUint8Array(xyzBase64);
  if (bytes.byteLength !== vertexCount * 12) throw new Error(`FLVER_ATTRIBUTE_LENGTH_MISMATCH: ${label}.xyz`);
  const xyz = new Float32Array((bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assertVector4(xyz, vertexCount, `${label}.xyz`, 3);
  if (normalWBase64 === undefined) return { ...metadata, xyz };
  const wBytes = decodeBase64ToUint8Array(normalWBase64);
  if (wBytes.byteLength !== vertexCount * 4) throw new Error(`FLVER_ATTRIBUTE_LENGTH_MISMATCH: ${label}.normalW`);
  const normalW = new Int32Array((wBytes.buffer as ArrayBuffer).slice(wBytes.byteOffset, wBytes.byteOffset + wBytes.byteLength));
  return { ...metadata, xyz, normalW };
}

/** Preserve native values and gap status; these inputs do not select material behavior. */
export function decodeFlverNativeVertexDiagnostics(
  source: FlverNativeVertexDiagnosticSource,
  vertexCount: number,
  label: string
): FlverSceneNativeVertexDiagnostics {
  return {
    ...(source.positionStatus !== undefined ? { positionStatus: source.positionStatus } : {}),
    ...(source.positionFailure !== undefined ? { positionFailure: source.positionFailure } : {}),
    ...(source.positionDiagnostics !== undefined ? { positionDiagnostics: source.positionDiagnostics.map((member) => decodeVector3Member(member, vertexCount, `${label}.position${member.memberOrdinal}`)) } : {}),
    ...(source.normalStatus !== undefined ? { normalStatus: source.normalStatus } : {}),
    ...(source.normalFailure !== undefined ? { normalFailure: source.normalFailure } : {}),
    ...(source.normalDiagnostics !== undefined ? { normalDiagnostics: source.normalDiagnostics.map((member) => decodeVector3Member(member, vertexCount, `${label}.normal${member.memberOrdinal}`)) } : {}),
    ...(source.vertexColorStatus !== undefined ? { vertexColorStatus: source.vertexColorStatus } : {}),
    ...(source.vertexColorFailure !== undefined ? { vertexColorFailure: source.vertexColorFailure } : {}),
    ...(source.vertexColorDiagnostics !== undefined ? {
      vertexColorDiagnostics: source.vertexColorDiagnostics.map(({ rgbaBase64, ...member }) => ({
        ...member, rgba: decodeVector4(rgbaBase64, vertexCount, `${label}.vertexColor${member.memberOrdinal}`)
      }))
    } : {}),
    ...(source.tangentStatus !== undefined ? { tangentStatus: source.tangentStatus } : {}),
    ...(source.tangentFailure !== undefined ? { tangentFailure: source.tangentFailure } : {}),
    ...(source.tangentDiagnostics !== undefined ? {
      tangentDiagnostics: source.tangentDiagnostics.map(({ xyzwBase64, ...member }) => ({
        ...member, xyzw: decodeVector4(xyzwBase64, vertexCount, `${label}.tangent${member.memberOrdinal}`)
      }))
    } : {}),
    ...(source.bitangentStatus !== undefined ? { bitangentStatus: source.bitangentStatus } : {}),
    ...(source.bitangentFailure !== undefined ? { bitangentFailure: source.bitangentFailure } : {}),
    ...(source.bitangentDiagnostics !== undefined ? {
      bitangentDiagnostics: source.bitangentDiagnostics.map(({ xyzwBase64, ...member }) => ({
        ...member, xyzw: decodeVector4(xyzwBase64, vertexCount, `${label}.bitangent${member.memberOrdinal}`)
      }))
    } : {})
  };
}

/** Private attributes retain four components without activating Three's color/tangent shaders. */
export function attachFlverNativeVertexDiagnostics(
  three: Pick<typeof import('three'), 'BufferAttribute'>,
  geometry: BufferGeometry,
  evidence: FlverSceneNativeVertexDiagnostics,
  vertexCount: number,
  label: string
): void {
  const groups = [
    { prefix: 'position', attribute: 'soulforgePosition', itemSize: 3, sets: evidence.positionDiagnostics?.map(({ xyz, normalW, ...member }) => ({ member, values: xyz, normalW })) },
    { prefix: 'normal', attribute: 'soulforgeNormal', itemSize: 3, sets: evidence.normalDiagnostics?.map(({ xyz, normalW, ...member }) => ({ member, values: xyz, normalW })) },
    { prefix: 'vertexColor', attribute: 'soulforgeVertexColor', itemSize: 4, sets: evidence.vertexColorDiagnostics?.map(({ rgba, ...member }) => ({ member, values: rgba, normalW: undefined })) },
    { prefix: 'tangent', attribute: 'soulforgeTangent', itemSize: 4, sets: evidence.tangentDiagnostics?.map(({ xyzw, ...member }) => ({ member, values: xyzw, normalW: undefined })) },
    { prefix: 'bitangent', attribute: 'soulforgeBitangent', itemSize: 4, sets: evidence.bitangentDiagnostics?.map(({ xyzw, ...member }) => ({ member, values: xyzw, normalW: undefined })) }
  ];
  // Validate all sets before attaching any: a malformed later member must not
  // leave a seemingly complete partial diagnostic projection.
  for (const group of groups) {
    const ordinals = new Set<number>();
    for (const item of group.sets ?? []) {
      const { member, values } = item;
      if (!Number.isInteger(member.memberOrdinal) || member.memberOrdinal < 0 || ordinals.has(member.memberOrdinal)) {
        throw new Error(`FLVER_DIAGNOSTIC_MEMBER_ORDINAL_INVALID: ${label}.${group.prefix} ordinal=${member.memberOrdinal}`);
      }
      ordinals.add(member.memberOrdinal);
      assertVector4(values, vertexCount, `${label}.${group.prefix}${member.memberOrdinal}`, group.itemSize);
      if (item.normalW !== undefined) assertVector4(item.normalW, vertexCount, `${label}.${group.prefix}${member.memberOrdinal}.normalW`, 1);
    }
  }
  for (const group of groups) {
    const status = evidence[`${group.prefix}Status` as 'positionStatus' | 'normalStatus' | 'vertexColorStatus' | 'tangentStatus' | 'bitangentStatus'];
    const failure = evidence[`${group.prefix}Failure` as 'positionFailure' | 'normalFailure' | 'vertexColorFailure' | 'tangentFailure' | 'bitangentFailure'];
    if (status !== undefined) geometry.userData[`${group.prefix}Status`] = status;
    if (failure !== undefined) geometry.userData[`${group.prefix}Failure`] = failure;
    if (group.sets !== undefined) {
      geometry.userData[`${group.prefix}Diagnostics`] = group.sets.map((item) => {
        const { member, values } = item;
        const attributeName = `${group.attribute}${member.memberOrdinal}`;
        geometry.setAttribute(attributeName, new three.BufferAttribute(values, group.itemSize));
        if (item.normalW !== undefined) {
          const normalWAttributeName = `soulforgeNormalW${member.memberOrdinal}`;
          geometry.setAttribute(normalWAttributeName, new three.BufferAttribute(item.normalW, 1));
          return { ...member, attributeName, normalWAttributeName };
        }
        return { ...member, attributeName };
      });
    }
  }
}
