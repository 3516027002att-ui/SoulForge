import { writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { runBridge } from '../bridge/runBridge.js';

/**
 * FLVER → glTF 2.0 binary (.glb) 只读导出。
 *
 * glTF 是开放格式（非 FromSoftware 原生），故在 TypeScript 侧实现：复用 Bridge 已验证的
 * read-flver-mesh 提取每个网格的 positions/normals/UVs/indices，组装为单文件 GLB。
 * 仅导出几何（不含蒙皮/材质），供外部工具（Blender/three.js）查看只狼模型。
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'
const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT16 = 5123;
const COMPONENT_UINT32 = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  indices: Uint16Array | Uint32Array | null;
  indicesType: 'u16' | 'u32';
  vertexCount: number;
}

interface GltfJson {
  asset: { version: string; generator: string };
  scene: number;
  scenes: Array<{ nodes: number[] }>;
  nodes: Array<{ mesh: number; name?: string }>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number }> }>;
  accessors: Array<{
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }>;
  bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number; target?: number }>;
  buffers: Array<{ byteLength: number }>;
}

function decodeBase64(base64: string | undefined): Uint8Array {
  if (!base64) return new Uint8Array(0);
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * 将 FLVER 资源导出为 GLB 文件。返回导出统计；失败时抛出带诊断的错误。
 */
export async function exportFlverToGlb(
  sourceUri: string,
  filePath: string,
  allowedRoots: string[],
  writableRoots: string[],
  options?: { timeoutMs?: number }
): Promise<{ meshCount: number; exportedMeshes: number; byteLength: number }> {
  const timeoutMs = options?.timeoutMs ?? 120_000;

  // Enforce the writable-root boundary before writing any file.
  const resolvedOutput = resolve(filePath);
  const withinWritableRoot = writableRoots.some((root) => {
    const resolvedRoot = resolve(root);
    return resolvedOutput === resolvedRoot || resolvedOutput.startsWith(resolvedRoot + sep);
  });
  if (!withinWritableRoot) {
    throw new Error(`GLB 输出路径 ${resolvedOutput} 不在允许写入的根目录内。`);
  }

  const doc = await runBridge<Record<string, unknown>>({
    command: 'read-flver-document',
    filePath: sourceUri,
    allowedRoots,
    timeoutMs
  });
  if (doc.parseStatus === 'failed' || !doc.data) {
    throw new Error(`FLVER 文档读取失败：${JSON.stringify(doc.diagnostics)}`);
  }
  const meshCount = (doc.data.meshCount as number) ?? 0;
  if (meshCount <= 0) throw new Error('FLVER 无网格可导出。');

  // Extract each mesh's arrays via the tested read-flver-mesh command.
  const meshes: MeshArrays[] = [];
  for (let i = 0; i < meshCount; i++) {
    const mesh = await runBridge<Record<string, unknown>>({
      command: 'read-flver-mesh',
      filePath: sourceUri,
      allowedRoots,
      commandOptions: { meshIndex: i, maxVertices: 1_000_000, maxIndices: 3_000_000 },
      timeoutMs
    });
    const data = mesh.data as Record<string, unknown> | undefined;
    if (mesh.parseStatus === 'failed' || !data?.positionsBase64) continue; // skip unextractable meshes

    const positionsBytes = decodeBase64(data.positionsBase64 as string);
    const vertexCount = (data.vertexCount as number) ?? positionsBytes.byteLength / 12;
    if (vertexCount <= 0 || positionsBytes.byteLength < vertexCount * 12) continue;

    const positions = new Float32Array(positionsBytes.buffer, positionsBytes.byteOffset, vertexCount * 3);
    const normalsBytes = decodeBase64(data.normalsBase64 as string | undefined);
    const normals = normalsBytes.byteLength >= vertexCount * 12
      ? new Float32Array(normalsBytes.buffer, normalsBytes.byteOffset, vertexCount * 3)
      : null;
    const uvsBytes = decodeBase64(data.uvsBase64 as string | undefined);
    const uvs = uvsBytes.byteLength >= vertexCount * 8
      ? new Float32Array(uvsBytes.buffer, uvsBytes.byteOffset, vertexCount * 2)
      : null;
    const indexFormat = (data.indexFormat as number | undefined) ?? 16;
    const indicesBytes = decodeBase64(data.indicesBase64 as string | undefined);
    let indices: Uint16Array | Uint32Array | null = null;
    let indicesType: 'u16' | 'u32' = 'u16';
    if (indicesBytes.byteLength >= 2 && (indexFormat === 16 || indexFormat === 32)) {
      if (indexFormat === 32) {
        indices = new Uint32Array(indicesBytes.buffer, indicesBytes.byteOffset, indicesBytes.byteLength / 4);
        indicesType = 'u32';
      } else {
        indices = new Uint16Array(indicesBytes.buffer, indicesBytes.byteOffset, indicesBytes.byteLength / 2);
      }
    }

    meshes.push({ positions, normals, uvs, indices, indicesType, vertexCount });
  }

  if (meshes.length === 0) throw new Error('未能提取任何网格几何。');

  const glb = buildGlb(meshes);
  await writeFile(filePath, glb);
  return { meshCount, exportedMeshes: meshes.length, byteLength: glb.byteLength };
}

/** 将网格数组组装为 GLB 二进制。 */
export function buildGlb(meshes: MeshArrays[]): Uint8Array {
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'SoulForge' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }]
  };

  const binChunks: Uint8Array[] = [];
  let binOffset = 0;

  const addBufferView = (bytes: Uint8Array, target: number): number => {
    // Align current offset to 4 bytes for safe float/uint16 access.
    const padded = align4(binOffset);
    if (padded > binOffset) {
      binChunks.push(new Uint8Array(padded - binOffset));
      binOffset = padded;
    }
    const index = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: bytes.byteLength, target });
    binChunks.push(bytes);
    binOffset += bytes.byteLength;
    return index;
  };

  meshes.forEach((mesh, meshIndex) => {
    const attributes: Record<string, number> = {};

    // POSITION accessor (with min/max, required by glTF spec).
    const posView = addBufferView(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength), TARGET_ARRAY_BUFFER);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < mesh.vertexCount; v++) {
      for (let c = 0; c < 3; c++) {
        const val = mesh.positions[v * 3 + c] ?? 0;
        if (val < (min[c] ?? 0)) min[c] = val;
        if (val > (max[c] ?? 0)) max[c] = val;
      }
    }
    attributes.POSITION = json.accessors.length;
    json.accessors.push({ bufferView: posView, componentType: COMPONENT_FLOAT, count: mesh.vertexCount, type: 'VEC3', min, max });

    if (mesh.normals) {
      const normalView = addBufferView(new Uint8Array(mesh.normals.buffer, mesh.normals.byteOffset, mesh.normals.byteLength), TARGET_ARRAY_BUFFER);
      attributes.NORMAL = json.accessors.length;
      json.accessors.push({ bufferView: normalView, componentType: COMPONENT_FLOAT, count: mesh.vertexCount, type: 'VEC3' });
    }

    if (mesh.uvs) {
      const uvView = addBufferView(new Uint8Array(mesh.uvs.buffer, mesh.uvs.byteOffset, mesh.uvs.byteLength), TARGET_ARRAY_BUFFER);
      attributes.TEXCOORD_0 = json.accessors.length;
      json.accessors.push({ bufferView: uvView, componentType: COMPONENT_FLOAT, count: mesh.vertexCount, type: 'VEC2' });
    }

    const primitive: { attributes: Record<string, number>; indices?: number } = { attributes };
    if (mesh.indices && mesh.indices.length > 0) {
      const indexView = addBufferView(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), TARGET_ELEMENT_ARRAY_BUFFER);
      primitive.indices = json.accessors.length;
      json.accessors.push({
        bufferView: indexView,
        componentType: mesh.indicesType === 'u32' ? COMPONENT_UINT32 : COMPONENT_UINT16,
        count: mesh.indices.length,
        type: 'SCALAR'
      });
    }

    json.meshes.push({ primitives: [primitive] });
    json.nodes.push({ mesh: meshIndex, name: `mesh_${meshIndex}` });
    json.scenes[0]?.nodes.push(meshIndex);
  });

  // Assemble binary buffer.
  const binTotal = align4(binOffset);
  if (binTotal > binOffset) binChunks.push(new Uint8Array(binTotal - binOffset));
  const bin = new Uint8Array(binTotal);
  let cursor = 0;
  for (const chunk of binChunks) {
    bin.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  json.buffers[0] = { byteLength: binTotal };

  // Encode JSON chunk (padded to 4 bytes with spaces).
  const jsonText = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPadded = align4(jsonBytes.byteLength);
  const jsonChunk = new Uint8Array(jsonPadded);
  jsonChunk.set(jsonBytes, 0);
  for (let i = jsonBytes.byteLength; i < jsonPadded; i++) jsonChunk[i] = 0x20; // space padding

  // GLB container: 12-byte header + JSON chunk + BIN chunk.
  const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + bin.byteLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);
  // JSON chunk header.
  view.setUint32(12, jsonChunk.byteLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  glb.set(jsonChunk, 20);
  // BIN chunk header.
  const binHeaderOffset = 20 + jsonChunk.byteLength;
  view.setUint32(binHeaderOffset, bin.byteLength, true);
  view.setUint32(binHeaderOffset + 4, CHUNK_BIN, true);
  glb.set(bin, binHeaderOffset + 8);

  return glb;
}
