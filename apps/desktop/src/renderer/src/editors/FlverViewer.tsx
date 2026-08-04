import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  mountFlverScene,
  type FlverSceneHandle,
  type FlverSceneMesh,
  type FlverSemanticScene,
  type FlverSceneTexture
} from '../scene/threeSceneController.js';

export interface FlverViewerProps {
  sourceUri?: string;
  meshIndex?: number;
  boundingBox?: { min: number[]; max: number[] } | undefined;
  boneCount?: number;
  meshCount?: number;
  bones?: Array<{ name: string; position: [number, number, number]; parentIndex: number }> | undefined;
  textureBase64?: string | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
}

interface MeshData {
  positionsBase64: string;
  indicesBase64: string;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
  vertexCount: number;
}

interface SkeletonBone {
  name: string;
  parentIndex: number;
  translation: [number, number, number];
  rotation: [number, number, number];
}

interface DummyPoint {
  referenceId: number;
  position: [number, number, number];
}

const EMPTY_SCENE: FlverSemanticScene = {
  meshes: [],
  bounds: { min: [-50, -50, -50], max: [50, 50, 50], center: [0, 0, 0] }
};

/**
 * FLVER 3D 预览器：真实 FLVER mesh 渲染（WebGPU-first / WebGL2 fallback）。
 *
 * 权威场景是渲染器无关的语义场景（typed buffer + 变换，由 IPC readFlverMesh
 * 读入的原始数据构建），投影层（threeSceneController）只消费它并持有全部
 * renderer 对象；本组件不创建任何 THREE 对象，遵守硬约束 18。
 */
export function FlverViewer(props: FlverViewerProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<FlverSceneHandle | null>(null);
  const contentRef = useRef<FlverSemanticScene>(EMPTY_SCENE);
  const [meshData, setMeshData] = useState<MeshData | null>(null);
  const [meshError, setMeshError] = useState<string | null>(null);
  const [skeletonBones, setSkeletonBones] = useState<SkeletonBone[] | null>(null);
  const [dummyPoints, setDummyPoints] = useState<DummyPoint[] | null>(null);
  const [texture, setTexture] = useState<FlverSceneTexture | null>(null);
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const [backend, setBackend] = useState<'webgpu' | 'webgl2' | 'detecting'>('detecting');
  const [sceneError, setSceneError] = useState<string | null>(null);

  // Load dummy attachment points via IPC when sourceUri changes.
  useEffect(() => {
    if (!props.sourceUri || typeof window.soulforge.readFlverDummies !== 'function') return;
    setDummyPoints(null);
    void (async () => {
      try {
        const result = await window.soulforge.readFlverDummies(props.sourceUri!) as {
          ok: boolean;
          data?: { dummies?: Array<{ referenceId: number; position: number[] }> };
        };
        const raw = result.ok ? result.data?.dummies ?? [] : [];
        if (raw.length === 0) return;
        setDummyPoints(
          raw.map((d) => ({
            referenceId: d.referenceId,
            position: [d.position[0] ?? 0, d.position[1] ?? 0, d.position[2] ?? 0]
          }))
        );
      } catch {
        // Dummy load failed; leave markers hidden.
      }
    })();
  }, [props.sourceUri]);

  // Load skeleton hierarchy via IPC when sourceUri changes.
  // Parent-relative transforms; world transforms are projected by the scene
  // controller (renderer layer), keeping the semantic scene pure typed data.
  useEffect(() => {
    if (!props.sourceUri || typeof window.soulforge.readFlverSkeleton !== 'function') return;
    setSkeletonBones(null);
    void (async () => {
      try {
        const result = await window.soulforge.readFlverSkeleton(props.sourceUri!) as {
          ok: boolean;
          data?: { bones?: Array<{ name: string; parentIndex: number; translation: number[]; rotation: number[] }> };
        };
        const raw = result.ok ? result.data?.bones ?? [] : [];
        if (raw.length === 0) return;
        setSkeletonBones(
          raw.map((b) => ({
            name: b.name,
            parentIndex: b.parentIndex,
            translation: [b.translation[0] ?? 0, b.translation[1] ?? 0, b.translation[2] ?? 0],
            rotation: [b.rotation[0] ?? 0, b.rotation[1] ?? 0, b.rotation[2] ?? 0]
          }))
        );
      } catch {
        // Skeleton load failed; leave hierarchy hidden.
      }
    })();
  }, [props.sourceUri]);

  // Load mesh data via IPC when sourceUri or meshIndex changes.
  useEffect(() => {
    if (!props.sourceUri || typeof window.soulforge.readFlverMesh !== 'function') return;
    setMeshData(null);
    setMeshError(null);
    const idx = props.meshIndex ?? 0;
    void (async () => {
      try {
        const result = await window.soulforge.readFlverMesh(props.sourceUri!, idx) as {
          ok: boolean;
          data?: { positionsBase64?: string; indicesBase64?: string; uvsBase64?: string; normalsBase64?: string; boneWeightsBase64?: string; boneIndicesBase64?: string; vertexCount?: number };
          diagnostics?: Array<{ message: string }>;
        };
        if (result.ok && result.data?.positionsBase64) {
          setMeshData({
            positionsBase64: result.data.positionsBase64,
            indicesBase64: result.data.indicesBase64 ?? '',
            uvsBase64: result.data.uvsBase64 ?? undefined,
            normalsBase64: result.data.normalsBase64 ?? undefined,
            boneWeightsBase64: result.data.boneWeightsBase64 ?? undefined,
            boneIndicesBase64: result.data.boneIndicesBase64 ?? undefined,
            vertexCount: result.data.vertexCount ?? 0
          });
        } else {
          setMeshError(result.diagnostics?.[0]?.message ?? '网格数据不可用');
        }
      } catch (error) {
        setMeshError(error instanceof Error ? error.message : '网格加载失败');
      }
    })();
  }, [props.sourceUri, props.meshIndex]);

  // Decode texture bytes (base64 → DDS parse / RGBA fallback) into semantic form.
  // 渲染器对象（CompressedTexture / DataTexture）由投影层构造并纳入 dispose。
  useEffect(() => {
    if (!props.textureBase64) {
      setTexture(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const decoded = await decodeFlverTexture(props.textureBase64!);
      if (!cancelled) setTexture(decoded);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.textureBase64]);

  // Rebuild the renderer-independent semantic scene whenever source data changes.
  useEffect(() => {
    const scene = buildSemanticScene({
      meshData,
      meshIndex: props.meshIndex ?? 0,
      skeleton: skeletonBones ?? [],
      dummies: dummyPoints ?? [],
      boundingBox: props.boundingBox,
      texture
    });
    contentRef.current = scene;
    handleRef.current?.setScene(scene);
  }, [meshData, skeletonBones, dummyPoints, props.boundingBox, texture, props.meshIndex]);

  // Mount the Three projection layer once; later data updates flow through setScene.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await mountFlverScene({
          container,
          scene: contentRef.current,
          onSelect: (id) => {
            if (!id) {
              setSelected(null);
              return;
            }
            const label = id.startsWith('mesh-')
              ? `mesh[${id.slice('mesh-'.length)}]`
              : id;
            setSelected({ id, label });
          }
        });
        if (cancelled) {
          handle.dispose();
          return;
        }
        handleRef.current = handle;
        setBackend(handle.rendererBackend);
        // Content may have arrived while the mount promise was pending.
        handle.setScene(contentRef.current);
      } catch (error) {
        setSceneError(error instanceof Error ? error.message : 'FLVER 3D 场景初始化失败');
      }
    })();
    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  const meshLabel = `mesh[${props.meshIndex ?? 0}]`;

  return (
    <div style={{ position: 'relative', width: '100%', height: 300, background: '#1a1d23', borderRadius: 4 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div style={{
        position: 'absolute', top: 8, left: 8, color: '#8899aa', fontSize: 12,
        background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: 4
      }}>
        FLVER 3D 预览 · {props.boneCount ?? 0} bones · {props.meshCount ?? 0} meshes
        {' · '}{backend === 'detecting' ? 'backend…' : `backend ${backend}`}
        {meshData ? ` · ${meshLabel} ${meshData.vertexCount} verts` : meshError ? ` · ${meshError}` : ''}
        {sceneError ? ` · ${sceneError}` : ''}
      </div>
      {selected ? (
        <div style={{
          position: 'absolute', top: 8, right: 8, color: '#9fd0ff', fontSize: 12,
          background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: 4
        }}>
          已选择 {selected.label}
        </div>
      ) : null}
      <div style={{
        position: 'absolute', bottom: 8, left: 8, color: '#6a7686', fontSize: 11,
        background: 'rgba(0,0,0,0.45)', padding: '2px 8px', borderRadius: 4
      }}>
        点击网格选中 / 再次点击取消 · 网格数据只读
      </div>
    </div>
  );
}

function buildSemanticScene(input: {
  meshData: MeshData | null;
  meshIndex: number;
  skeleton: SkeletonBone[];
  dummies: DummyPoint[];
  boundingBox?: { min: number[]; max: number[] } | undefined;
  texture: FlverSceneTexture | null;
}): FlverSemanticScene {
  const meshes: FlverSceneMesh[] = [];
  if (input.meshData) {
    const positions = decodeFloat32Array(input.meshData.positionsBase64);
    const mesh: FlverSceneMesh = {
      id: `mesh-${input.meshIndex}`,
      label: `mesh[${input.meshIndex}]`,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      positions,
      vertexCount: input.meshData.vertexCount || positions.length / 3,
      wireframeOverlay: true
    };
    if (input.meshData.uvsBase64) mesh.uvs = decodeFloat32Array(input.meshData.uvsBase64);
    if (input.meshData.normalsBase64) mesh.normals = decodeFloat32Array(input.meshData.normalsBase64);
    if (input.meshData.indicesBase64) mesh.indices = decodeUint16Array(input.meshData.indicesBase64);
    if (input.meshData.boneWeightsBase64) {
      mesh.vertexColors = boneWeightColors(input.meshData.boneWeightsBase64, positions.length / 3);
    } else if (input.meshData.boneIndicesBase64) {
      mesh.vertexColors = boneIndexColors(input.meshData.boneIndicesBase64, positions.length / 3);
    }
    if (input.texture) mesh.texture = input.texture;
    meshes.push(mesh);
  }
  const bounds = computeSceneBounds(input.boundingBox, meshes);
  const bones = input.skeleton.map((bone, index) => ({
    id: `bone-${index}`,
    name: bone.name,
    parentIndex: bone.parentIndex,
    translation: bone.translation,
    rotation: bone.rotation
  }));
  const dummies = input.dummies.map((dummy, index) => ({
    id: `dummy-${index}`,
    referenceId: dummy.referenceId,
    position: dummy.position
  }));
  return {
    meshes,
    ...(bones.length > 0 ? { bones } : {}),
    ...(dummies.length > 0 ? { dummies } : {}),
    bounds
  };
}

function computeSceneBounds(
  boundingBox: { min: number[]; max: number[] } | undefined,
  meshes: FlverSceneMesh[]
): FlverSemanticScene['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  if (boundingBox) {
    min[0] = boundingBox.min[0] ?? 0;
    min[1] = boundingBox.min[1] ?? 0;
    min[2] = boundingBox.min[2] ?? 0;
    max[0] = boundingBox.max[0] ?? 0;
    max[1] = boundingBox.max[1] ?? 0;
    max[2] = boundingBox.max[2] ?? 0;
  }
  for (const mesh of meshes) {
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const x = mesh.positions[index] ?? 0;
      const y = mesh.positions[index + 1] ?? 0;
      const z = mesh.positions[index + 2] ?? 0;
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
  }
  if (!Number.isFinite(min[0])) {
    min[0] = -50;
    min[1] = -50;
    min[2] = -50;
    max[0] = 50;
    max[1] = 50;
    max[2] = 50;
  }
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
  };
}

function decodeFloat32Array(base64: string): Float32Array {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

function decodeUint16Array(base64: string): Uint16Array {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Uint16Array(copy);
}

// 骨权重着色：主骨权重高为红（顶点紧绑单骨），分散为蓝。4 bytes/顶点 × 4 影响。
function boneWeightColors(weightsBase64: string, vertexCount: number): Float32Array {
  const weightBytes = Uint8Array.from(atob(weightsBase64), (char) => char.charCodeAt(0));
  const colors = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const primaryWeight = (weightBytes[v * 4] ?? 0) / 255;
    colors[v * 3] = primaryWeight;
    colors[v * 3 + 1] = 0.2;
    colors[v * 3 + 2] = 1 - primaryWeight;
  }
  return colors;
}

const BONE_PALETTE: Array<[number, number, number]> = [
  [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 0.0],
  [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 0.5, 0.0], [0.5, 0.0, 1.0],
  [0.0, 1.0, 0.5], [0.5, 1.0, 0.0], [1.0, 0.0, 0.5], [0.0, 0.5, 1.0]
];

// 骨索引着色：按首个骨索引取调色板色。4 bytes/顶点 × 4 影响。
function boneIndexColors(indicesBase64: string, vertexCount: number): Float32Array {
  const indexBytes = Uint8Array.from(atob(indicesBase64), (char) => char.charCodeAt(0));
  const colors = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const boneIdx = (indexBytes[v * 4] ?? 0) % BONE_PALETTE.length;
    const color = BONE_PALETTE[boneIdx] ?? [1.0, 1.0, 1.0];
    colors[v * 3] = color[0];
    colors[v * 3 + 1] = color[1];
    colors[v * 3 + 2] = color[2];
  }
  return colors;
}

/**
 * 将 base64 纹理字节解码为语义纹理（DDS mipmaps 或 RGBA bytes）。
 * 纯数据解析（DDSLoader.parse），不创建渲染器对象。
 */
async function decodeFlverTexture(textureBase64: string): Promise<FlverSceneTexture | null> {
  try {
    const texBytes = Uint8Array.from(atob(textureBase64), (char) => char.charCodeAt(0));
    // DDS magic "DDS " (0x20534444)。
    const isDds = texBytes.length > 4
      && texBytes[0] === 0x44 && texBytes[1] === 0x44 && texBytes[2] === 0x53 && texBytes[3] === 0x20;
    if (isDds && texBytes.length > 128) {
      const ddsLoaderModule = await import('three/examples/jsm/loaders/DDSLoader.js');
      const dds = new ddsLoaderModule.DDSLoader().parse(
        texBytes.buffer.slice(texBytes.byteOffset, texBytes.byteOffset + texBytes.byteLength),
        true
      );
      return {
        kind: 'dds',
        width: dds.width,
        height: dds.height,
        mipmaps: dds.mipmaps,
        format: dds.format as import('three').CompressedPixelFormat,
        mipmapCount: dds.mipmapCount
      };
    }
    // 非 DDS / 过小：RGBA 渐变占位纹理（语义形态，投影层建 DataTexture）。
    const dv = new DataView(texBytes.buffer);
    const width = dv.getUint32(12, true) || 256;
    const height = dv.getUint32(16, true) || 256;
    const size = Math.min(256, Math.max(1, Math.min(width, height)));
    const data = new Uint8Array(size * size * 4);
    for (let index = 0; index < data.length; index += 4) {
      const x = (index / 4) % size;
      const y = Math.floor(index / 4 / size);
      data[index] = Math.floor((x / size) * 255);
      data[index + 1] = Math.floor((y / size) * 255);
      data[index + 2] = 200;
      data[index + 3] = 255;
    }
    return { kind: 'rgba', width: size, height: size, rgbaBytes: data };
  } catch {
    return null;
  }
}
