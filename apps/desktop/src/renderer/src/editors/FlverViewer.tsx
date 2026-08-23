import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  mountFlverScene,
  type FlverSceneHandle,
  type FlverSceneMesh,
  type FlverSemanticScene,
  type FlverSceneTexture
} from '../scene/threeSceneController.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import { decodeBase64ToUint8Array } from '../utils/binary.js';

/** P3 裁定：atob 只经严格校验的出口（decodeBase64ToUint8Array）。 */
function decodeBase64Safe(base64: string): Uint8Array {
  return decodeBase64ToUint8Array(base64);
}

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
  /**
   * S17：动作预览——chrbnd 里 FLVER 的网格数据由 `read-chrbnd-flver-preview`
   * 一次性返回（base64 typed buffers），提供时不再走 readFlverMesh IPC。
   * sourceUri 仍可同时给（dummies 拉取不适用 chrbnd 场景，跳过）。
   */
  externalMeshData?: {
    positionsBase64: string;
    indicesBase64: string;
    uvsBase64?: string | undefined;
    normalsBase64?: string | undefined;
    boneWeightsBase64?: string | undefined;
    boneIndicesBase64?: string | undefined;
    vertexCount: number;
  } | undefined;
  /**
   * 问题4-A：chrbnd 里 FLVER 的**全部网格**（renderer 按 meshIndex=0..meshCount-1
   * 循环读取后拼齐）。提供时把每个网格都投进同一个语义场景，相机框全覆盖；
   * 不播动画、不做假播放头。externalMeshData 只用于单网格回退。
   */
  externalMeshes?: Array<{
    positionsBase64: string;
    indicesBase64: string;
    uvsBase64?: string | undefined;
    normalsBase64?: string | undefined;
    boneWeightsBase64?: string | undefined;
    boneIndicesBase64?: string | undefined;
    vertexCount: number;
  }> | undefined;
  /** S17：外部骨骼层级（与 externalMeshData 同源），提供时跳过 readFlverSkeleton。 */
  externalBones?: Array<{
    name: string;
    parentIndex: number;
    translation: [number, number, number];
    rotation: [number, number, number];
  }> | undefined;
  /** 动画播放时间点（驱动骨骼蒙皮动画位姿） */
  playbackTime?: number | undefined;
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
  const [meshDataList, setMeshDataList] = useState<MeshData[] | null>(null);
  const [meshError, setMeshError] = useState<string | null>(null);
  const [skeletonBones, setSkeletonBones] = useState<SkeletonBone[] | null>(null);
  const [dummyPoints, setDummyPoints] = useState<DummyPoint[] | null>(null);
  const [texture, setTexture] = useState<FlverSceneTexture | null>(null);
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const [backend, setBackend] = useState<'webgpu' | 'webgl2' | 'detecting'>('detecting');
  const [sceneError, setSceneError] = useState<string | null>(null);

  const bridge = getRendererBridge();

  // Load dummy attachment points via IPC when sourceUri changes.
  useEffect(() => {
    if (!props.sourceUri || bridge === null || typeof bridge.readFlverDummies !== 'function') return;
    setDummyPoints(null);
    void (async () => {
      try {
        const result = await bridge.readFlverDummies(props.sourceUri!) as {
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
  }, [props.sourceUri, bridge]);

  // Load skeleton hierarchy via IPC when sourceUri changes.
  // Parent-relative transforms; world transforms are projected by the scene
  // controller (renderer layer), keeping the semantic scene pure typed data.
  // S17：externalBones（chrbnd 预览）直接使用，不走 IPC。
  useEffect(() => {
    if (props.externalBones) {
      setSkeletonBones(props.externalBones);
      return;
    }
    if (!props.sourceUri || bridge === null || typeof bridge.readFlverSkeleton !== 'function') return;
    setSkeletonBones(null);
    void (async () => {
      try {
        const result = await bridge.readFlverSkeleton(props.sourceUri!) as {
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
  }, [props.sourceUri, bridge]);

  // Load mesh data via IPC when sourceUri or meshIndex changes.
  // S17：externalMeshData（chrbnd 预览）直接使用，不走 IPC；
  // 问题4-A：externalMeshes（chrbnd 全部网格）同样直接使用，不走 IPC。
  useEffect(() => {
    if (props.externalMeshes && props.externalMeshes.length > 0) {
      setMeshDataList(props.externalMeshes.map(toMeshData));
      setMeshError(null);
      return;
    }
    if (props.externalMeshData) {
      setMeshDataList([toMeshData(props.externalMeshData)]);
      setMeshError(null);
      return;
    }
    if (!props.sourceUri || bridge === null || typeof bridge.readFlverMesh !== 'function') return;
    setMeshDataList(null);
    setMeshError(null);
    const idx = props.meshIndex ?? 0;
    void (async () => {
      try {
        const result = await bridge.readFlverMesh(props.sourceUri!, idx) as {
          ok: boolean;
          data?: { positionsBase64?: string; indicesBase64?: string; uvsBase64?: string; normalsBase64?: string; boneWeightsBase64?: string; boneIndicesBase64?: string; vertexCount?: number };
          diagnostics?: Array<{ message: string }>;
        };
        if (result.ok && result.data?.positionsBase64) {
          setMeshDataList([{
            positionsBase64: result.data.positionsBase64,
            indicesBase64: result.data.indicesBase64 ?? '',
            ...(result.data.uvsBase64 ? { uvsBase64: result.data.uvsBase64 } : {}),
            ...(result.data.normalsBase64 ? { normalsBase64: result.data.normalsBase64 } : {}),
            ...(result.data.boneWeightsBase64 ? { boneWeightsBase64: result.data.boneWeightsBase64 } : {}),
            ...(result.data.boneIndicesBase64 ? { boneIndicesBase64: result.data.boneIndicesBase64 } : {}),
            vertexCount: result.data.vertexCount ?? 0
          }]);
        } else {
          setMeshError(result.diagnostics?.[0]?.message ?? '网格数据不可用');
        }
      } catch (error) {
        setMeshError(error instanceof Error ? error.message : '网格加载失败');
      }
    })();
  }, [props.sourceUri, props.meshIndex, props.externalMeshData, props.externalMeshes, bridge]);

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
      meshes: meshDataList ?? [],
      skeleton: skeletonBones ?? [],
      dummies: dummyPoints ?? [],
      boundingBox: props.boundingBox,
      texture
    });
    contentRef.current = scene;
    handleRef.current?.setScene(scene);
  }, [meshDataList, skeletonBones, dummyPoints, props.boundingBox, texture]);

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

  // 动画播放推进（驱动骨骼蒙皮动画位姿）
  useEffect(() => {
    if (typeof props.playbackTime === 'number') {
      handleRef.current?.setPlaybackTime?.(props.playbackTime);
    }
  }, [props.playbackTime]);

  // 多网格（问题4-A）：叠加字报「全部网格 + 总顶点数」，不显示假播放头。
  const meshSummary = meshDataList && meshDataList.length > 0
    ? (meshDataList.length === 1
        ? `${meshDataList[0]?.vertexCount ?? 0} verts`
        : `${meshDataList.length} meshes · 总 ${
            meshDataList.reduce((sum, mesh) => sum + (mesh.vertexCount || 0), 0)
          } verts`)
    : null;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#1a1d23', borderRadius: 4 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div style={{
        position: 'absolute', top: 8, left: 8, color: '#8899aa', fontSize: 12,
        background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: 4
      }}>
        FLVER 3D 预览 · {props.boneCount ?? 0} bones · {props.meshCount ?? 0} meshes
        {' · '}{backend === 'detecting' ? 'backend…' : `backend ${backend}`}
        {meshSummary ? ` · ${meshSummary}` : meshError ? ` · ${meshError}` : ''}
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
  meshes: MeshData[];
  skeleton: SkeletonBone[];
  dummies: DummyPoint[];
  boundingBox?: { min: number[]; max: number[] } | undefined;
  texture: FlverSceneTexture | null;
}): FlverSemanticScene {
  const meshes: FlverSceneMesh[] = [];
  for (const [index, meshData] of input.meshes.entries()) {
    const positions = decodeFloat32Array(meshData.positionsBase64);
    const mesh: FlverSceneMesh = {
      id: `mesh-${index}`,
      label: `mesh[${index}]`,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      positions,
      vertexCount: meshData.vertexCount || positions.length / 3,
      wireframeOverlay: true
    };
    if (meshData.uvsBase64) mesh.uvs = decodeFloat32Array(meshData.uvsBase64);
    if (meshData.normalsBase64) mesh.normals = decodeFloat32Array(meshData.normalsBase64);
    if (meshData.indicesBase64) mesh.indices = decodeUint16Array(meshData.indicesBase64);
    if (meshData.boneWeightsBase64) {
      mesh.vertexColors = boneWeightColors(meshData.boneWeightsBase64, positions.length / 3);
    } else if (meshData.boneIndicesBase64) {
      mesh.vertexColors = boneIndexColors(meshData.boneIndicesBase64, positions.length / 3);
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

/** 把外部/IPC 返回的单个网格的 DTO 规整成内部 MeshData（问题4-A 参数复用）。 */
function toMeshData(input: {
  positionsBase64: string;
  indicesBase64: string;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
  vertexCount: number;
}): MeshData {
  return {
    positionsBase64: input.positionsBase64,
    indicesBase64: input.indicesBase64,
    uvsBase64: input.uvsBase64 ?? undefined,
    normalsBase64: input.normalsBase64 ?? undefined,
    boneWeightsBase64: input.boneWeightsBase64 ?? undefined,
    boneIndicesBase64: input.boneIndicesBase64 ?? undefined,
    vertexCount: input.vertexCount
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
  const bytes = decodeBase64Safe(base64);
  const copy = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

function decodeUint16Array(base64: string): Uint16Array {
  const bytes = decodeBase64Safe(base64);
  const copy = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Uint16Array(copy);
}

// 骨权重着色：主骨权重高为红（顶点紧绑单骨），分散为蓝。4 bytes/顶点 × 4 影响。
function boneWeightColors(weightsBase64: string, vertexCount: number): Float32Array {
  const weightBytes = decodeBase64Safe(weightsBase64);
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
  const indexBytes = decodeBase64Safe(indicesBase64);
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
    const texBytes = decodeBase64Safe(textureBase64);
    // DDS magic "DDS " (0x20534444)。
    const isDds = texBytes.length > 4
      && texBytes[0] === 0x44 && texBytes[1] === 0x44 && texBytes[2] === 0x53 && texBytes[3] === 0x20;
    if (isDds && texBytes.length > 128) {
      const ddsLoaderModule = await import('three/examples/jsm/loaders/DDSLoader.js');
      const dds = new ddsLoaderModule.DDSLoader().parse(
        (texBytes.buffer as ArrayBuffer).slice(texBytes.byteOffset, texBytes.byteOffset + texBytes.byteLength),
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
