import type {
  FlverPreviewMesh,
  FlverPreviewVertexColorDiagnostic,
  FlverPreviewVector4Diagnostic
} from '@soulforge/shared';
import type { BufferGeometry } from 'three';
import { decodeBase64ToUint8Array } from '../utils/binary.js';

export type FlverNativeVertexDiagnosticSource = Pick<FlverPreviewMesh,
  'vertexColorStatus' | 'vertexColorFailure' | 'vertexColorDiagnostics'
  | 'tangentStatus' | 'tangentFailure' | 'tangentDiagnostics'
  | 'bitangentStatus' | 'bitangentFailure' | 'bitangentDiagnostics'>;

export interface FlverSceneVertexColorDiagnostic extends Omit<FlverPreviewVertexColorDiagnostic, 'rgbaBase64'> {
  rgba: Float32Array;
}

export interface FlverSceneVector4Diagnostic extends Omit<FlverPreviewVector4Diagnostic, 'xyzwBase64'> {
  xyzw: Float32Array;
}

export interface FlverSceneNativeVertexDiagnostics extends Pick<FlverNativeVertexDiagnosticSource,
  'vertexColorStatus' | 'vertexColorFailure' | 'tangentStatus' | 'tangentFailure'
  | 'bitangentStatus' | 'bitangentFailure'> {
  vertexColorDiagnostics?: FlverSceneVertexColorDiagnostic[] | undefined;
  tangentDiagnostics?: FlverSceneVector4Diagnostic[] | undefined;
  bitangentDiagnostics?: FlverSceneVector4Diagnostic[] | undefined;
}

function assertVector4(values: Float32Array, vertexCount: number, label: string): void {
  if (values.length !== vertexCount * 4) {
    throw new Error(`FLVER_ATTRIBUTE_LENGTH_MISMATCH: ${label} expected=${vertexCount * 4} actual=${values.length}`);
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

/** Preserve native values and gap status; these inputs do not select material behavior. */
export function decodeFlverNativeVertexDiagnostics(
  source: FlverNativeVertexDiagnosticSource,
  vertexCount: number,
  label: string
): FlverSceneNativeVertexDiagnostics {
  return {
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
    { prefix: 'vertexColor', attribute: 'soulforgeVertexColor', sets: evidence.vertexColorDiagnostics?.map(({ rgba, ...member }) => ({ member, values: rgba })) },
    { prefix: 'tangent', attribute: 'soulforgeTangent', sets: evidence.tangentDiagnostics?.map(({ xyzw, ...member }) => ({ member, values: xyzw })) },
    { prefix: 'bitangent', attribute: 'soulforgeBitangent', sets: evidence.bitangentDiagnostics?.map(({ xyzw, ...member }) => ({ member, values: xyzw })) }
  ];
  // Validate all sets before attaching any: a malformed later member must not
  // leave a seemingly complete partial diagnostic projection.
  for (const group of groups) {
    const ordinals = new Set<number>();
    for (const { member, values } of group.sets ?? []) {
      if (!Number.isInteger(member.memberOrdinal) || member.memberOrdinal < 0 || ordinals.has(member.memberOrdinal)) {
        throw new Error(`FLVER_DIAGNOSTIC_MEMBER_ORDINAL_INVALID: ${label}.${group.prefix} ordinal=${member.memberOrdinal}`);
      }
      ordinals.add(member.memberOrdinal);
      assertVector4(values, vertexCount, `${label}.${group.prefix}${member.memberOrdinal}`);
    }
  }
  for (const group of groups) {
    const status = evidence[`${group.prefix}Status` as 'vertexColorStatus' | 'tangentStatus' | 'bitangentStatus'];
    const failure = evidence[`${group.prefix}Failure` as 'vertexColorFailure' | 'tangentFailure' | 'bitangentFailure'];
    if (status !== undefined) geometry.userData[`${group.prefix}Status`] = status;
    if (failure !== undefined) geometry.userData[`${group.prefix}Failure`] = failure;
    if (group.sets !== undefined) {
      geometry.userData[`${group.prefix}Diagnostics`] = group.sets.map(({ member, values }) => {
        const attributeName = `${group.attribute}${member.memberOrdinal}`;
        geometry.setAttribute(attributeName, new three.BufferAttribute(values, 4));
        return { ...member, attributeName };
      });
    }
  }
}
