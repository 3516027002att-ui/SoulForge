import { useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  BoneTransformData,
  CharacterPreviewBundle,
  FlverPreviewMesh,
  FlverPreviewModel
} from '@soulforge/shared';
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
  /** Atomic multi-FLVER character/parts payload. Every model keeps its own skeleton namespace. */
  externalBundle?: CharacterPreviewBundle | undefined;
  /** Per-FLVER local poses keyed by CharacterPreviewBundle.models[].modelId. */
  externalSkeletonPoses?: Readonly<Record<string, BoneTransformData[]>> | undefined;
  /**
   * S17：动作预览——chrbnd 里 FLVER 的网格数据由 `read-chrbnd-flver-preview`
   * 一次性返回（base64 typed buffers），提供时不再走 readFlverMesh IPC。
   * sourceUri 仍可同时给（dummies 拉取不适用 chrbnd 场景，跳过）。
   */
  externalMeshData?: {
    positionsBase64: string;
    indicesBase64: string;
    indexSize?: number | undefined;
    uvsBase64?: string | undefined;
    normalsBase64?: string | undefined;
    boneWeightsBase64?: string | undefined;
    boneIndicesBase64?: string | undefined;
    skinningMode?: 'weighted' | 'rigid' | 'static' | undefined;
    boneIndexSpace?: 'flver-global' | 'none' | undefined;
    vertexCount: number;
  } | undefined;
  /**
   * 问题4-A：chrbnd 里 FLVER 的**全部网格**（Bridge 一次构建完整 bundle）。
   * 提供时把每个网格都投进同一个语义场景，相机框全覆盖；
   * 不播动画、不做假播放头。externalMeshData 只用于单网格回退。
   */
  externalMeshes?: Array<{
    positionsBase64: string;
    indicesBase64: string;
    indexSize?: number | undefined;
    uvsBase64?: string | undefined;
    normalsBase64?: string | undefined;
    boneWeightsBase64?: string | undefined;
    boneIndicesBase64?: string | undefined;
    skinningMode?: 'weighted' | 'rigid' | 'static' | undefined;
    boneIndexSpace?: 'flver-global' | 'none' | undefined;
    vertexCount: number;
  }> | undefined;
  /** S17：外部骨骼层级（与 externalMeshData 同源），提供时跳过 readFlverSkeleton。 */
  externalBones?: Array<{
    name: string;
    parentIndex: number;
    translation: [number, number, number];
    rotation: [number, number, number];
    scale?: [number, number, number] | undefined;
    rotationOrder?: 'YZX' | 'XYZ' | 'XZY' | undefined;
  }> | undefined;
  /** 动画播放时间点（驱动骨骼蒙皮动画位姿） */
  playbackTime?: number | undefined;
  /** 真实采样骨骼位姿（由 TAE / HKX 动画驱动） */
  externalPose?: Array<{
    translation: [number, number, number];
    rotation: [number, number, number, number] | [number, number, number];
    scale?: [number, number, number] | undefined;
  }> | undefined;
}

interface ViewerPoseState {
  playbackTime: FlverViewerProps['playbackTime'];
  externalPose: FlverViewerProps['externalPose'];
  externalSkeletonPoses: FlverViewerProps['externalSkeletonPoses'];
}

function applyViewerPose(handle: FlverSceneHandle, state: ViewerPoseState, resetIfEmpty = false): void {
  if (state.externalSkeletonPoses !== undefined) {
    handle.setSkeletonPoses?.(state.externalSkeletonPoses);
  } else if (state.externalPose?.length) {
    handle.setPose?.(state.externalPose);
  } else if (typeof state.playbackTime === 'number') {
    handle.setPlaybackTime?.(state.playbackTime);
  } else if (resetIfEmpty) {
    handle.setSkeletonPoses?.({});
  }
}

interface MeshData {
  positionsBase64: string;
  indicesBase64: string;
  indexSize?: number | undefined;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
  skinningMode?: 'weighted' | 'rigid' | 'static' | undefined;
  boneIndexSpace?: 'flver-global' | 'none' | undefined;
  vertexCount: number;
}

interface SkeletonBone {
  name: string;
  parentIndex: number;
  translation: [number, number, number];
  rotation: [number, number, number];
  scale?: [number, number, number] | undefined;
  rotationOrder?: 'YZX' | 'XYZ' | 'XZY' | undefined;
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
  const poseStateRef = useRef<ViewerPoseState>({
    playbackTime: props.playbackTime,
    externalPose: props.externalPose,
    externalSkeletonPoses: props.externalSkeletonPoses
  });
  poseStateRef.current = {
    playbackTime: props.playbackTime,
    externalPose: props.externalPose,
    externalSkeletonPoses: props.externalSkeletonPoses
  };
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
    if (props.externalBundle) {
      setDummyPoints([]);
      return;
    }
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
  }, [props.sourceUri, props.externalBundle, bridge]);

  // Load skeleton hierarchy via IPC when sourceUri changes.
  // Parent-relative transforms; world transforms are projected by the scene
  // controller (renderer layer), keeping the semantic scene pure typed data.
  // S17：externalBones（chrbnd 预览）直接使用，不走 IPC。
  useEffect(() => {
    if (props.externalBundle) {
      setSkeletonBones([]);
      return;
    }
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
          data?: { bones?: Array<{ name: string; parentIndex: number; translation: number[]; rotation: number[]; scale?: number[]; rotationOrder?: 'YZX' | 'XYZ' | 'XZY' }> };
        };
        const raw = result.ok ? result.data?.bones ?? [] : [];
        if (raw.length === 0) return;
        setSkeletonBones(
          raw.map((b) => ({
            name: b.name,
            parentIndex: b.parentIndex,
            translation: [b.translation[0] ?? 0, b.translation[1] ?? 0, b.translation[2] ?? 0],
            rotation: [b.rotation[0] ?? 0, b.rotation[1] ?? 0, b.rotation[2] ?? 0],
            scale: [b.scale?.[0] ?? 1, b.scale?.[1] ?? 1, b.scale?.[2] ?? 1],
            rotationOrder: (b.rotationOrder === 'XZY' ? 'YZX' : b.rotationOrder) ?? 'YZX'
          }))
        );
      } catch {
        // Skeleton load failed; leave hierarchy hidden.
      }
    })();
  }, [props.sourceUri, props.externalBones, props.externalBundle, bridge]);

  // Load mesh data via IPC when sourceUri or meshIndex changes.
  // S17：externalMeshData（chrbnd 预览）直接使用，不走 IPC；
  // 问题4-A：externalMeshes（chrbnd 全部网格）同样直接使用，不走 IPC。
  useEffect(() => {
    if (props.externalBundle) {
      setMeshDataList([]);
      setMeshError(null);
      return;
    }
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
          data?: { positionsBase64?: string; indicesBase64?: string; indexSize?: number; uvsBase64?: string; normalsBase64?: string; boneWeightsBase64?: string; boneIndicesBase64?: string; skinningMode?: 'weighted' | 'rigid' | 'static'; boneIndexSpace?: 'flver-global' | 'none'; vertexCount?: number };
          diagnostics?: Array<{ message: string }>;
        };
        if (result.ok && result.data?.positionsBase64) {
          setMeshDataList([{
            positionsBase64: result.data.positionsBase64,
            indicesBase64: result.data.indicesBase64 ?? '',
            indexSize: result.data.indexSize,
            ...(result.data.uvsBase64 ? { uvsBase64: result.data.uvsBase64 } : {}),
            ...(result.data.normalsBase64 ? { normalsBase64: result.data.normalsBase64 } : {}),
            ...(result.data.boneWeightsBase64 ? { boneWeightsBase64: result.data.boneWeightsBase64 } : {}),
            ...(result.data.boneIndicesBase64 ? { boneIndicesBase64: result.data.boneIndicesBase64 } : {}),
            skinningMode: result.data.skinningMode,
            boneIndexSpace: result.data.boneIndexSpace,
            vertexCount: result.data.vertexCount ?? 0
          }]);
        } else {
          setMeshError(result.diagnostics?.[0]?.message ?? '网格数据不可用');
        }
      } catch (error) {
        setMeshError(error instanceof Error ? error.message : '网格加载失败');
      }
    })();
  }, [props.sourceUri, props.meshIndex, props.externalMeshData, props.externalMeshes, props.externalBundle, bridge]);

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
    try {
      const scene = props.externalBundle
        ? buildBundleSemanticScene(props.externalBundle, props.boundingBox, texture)
        : buildSemanticScene({
            meshes: meshDataList ?? [],
            skeleton: skeletonBones ?? [],
            dummies: dummyPoints ?? [],
            boundingBox: props.boundingBox,
            texture
          });
      contentRef.current = scene;
      const handle = handleRef.current;
      if (handle) {
        handle.setScene(scene);
        applyViewerPose(handle, poseStateRef.current);
      }
      setSceneError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'FLVER 语义数据无效';
      setSceneError(message);
    }
  }, [meshDataList, skeletonBones, dummyPoints, props.boundingBox, props.externalBundle, texture]);

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
        // Pose updates can arrive before the asynchronous Three mount resolves.
        applyViewerPose(handle, poseStateRef.current);
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

  // Replay the latest pose source; multi-skeleton retargeting has priority.
  useEffect(() => {
    const handle = handleRef.current;
    if (handle) applyViewerPose(handle, poseStateRef.current, true);
  }, [props.playbackTime, props.externalPose, props.externalSkeletonPoses]);

  // 真实动画采样位姿驱动骨骼蒙皮

  // 多网格（问题4-A）：叠加字报「全部网格 + 总顶点数」，不显示假播放头。
  const summaryMeshes = props.externalBundle
    ? props.externalBundle.models.flatMap((model) => model.meshes)
    : meshDataList;
  const meshSummary = summaryMeshes && summaryMeshes.length > 0
    ? (summaryMeshes.length === 1
        ? `${summaryMeshes[0]?.vertexCount ?? 0} verts`
        : `${summaryMeshes.length} meshes · 总 ${
            summaryMeshes.reduce((sum, mesh) => sum + (mesh.vertexCount || 0), 0)
          } verts`)
    : null;

  return (
    <div className="flver-viewer" style={{ position: 'relative', width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden', background: '#1a1d23', borderRadius: 4 }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0 }} />
      <div style={{
        position: 'absolute', top: 8, left: 8, color: '#8899aa', fontSize: 12,
        background: 'rgba(0,0,0,0.5)', padding: '4px 8px', borderRadius: 4
      }}>
        FLVER 3D 预览 · {props.externalBundle?.boneCount ?? props.boneCount ?? 0} bones · {props.externalBundle?.meshCount ?? props.meshCount ?? 0} meshes
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
    const positions = decodeFloat32Array(meshData.positionsBase64, `mesh[${index}].positions`);
    const vertexCount = meshData.vertexCount || Math.floor(positions.length / 3);
    assertVertexAttributeLength(positions.length, vertexCount, 3, `mesh[${index}].positions`);
    const mesh: FlverSceneMesh = {
      id: `mesh-${index}`,
      label: `mesh[${index}]`,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      positions,
      vertexCount,
      indexSize: meshData.indexSize === 32 ? 32 : 16,
      skinningMode: meshData.skinningMode ?? (
        meshData.boneIndicesBase64 && meshData.boneWeightsBase64 ? 'weighted' : 'static'
      ),
      boneIndexSpace: meshData.boneIndexSpace ?? (
        meshData.boneIndicesBase64 && meshData.boneWeightsBase64 ? 'flver-global' : 'none'
      ),
      wireframeOverlay: false
    };
    if (meshData.uvsBase64) {
      mesh.uvs = decodeFloat32Array(meshData.uvsBase64, `mesh[${index}].uvs`);
      assertVertexAttributeLength(mesh.uvs.length, vertexCount, 2, `mesh[${index}].uvs`);
    }
    if (meshData.normalsBase64) {
      mesh.normals = decodeFloat32Array(meshData.normalsBase64, `mesh[${index}].normals`);
      assertVertexAttributeLength(mesh.normals.length, vertexCount, 3, `mesh[${index}].normals`);
    }
    if (meshData.indicesBase64) {
      mesh.indices = decodeMeshIndices(meshData.indicesBase64, mesh.indexSize, `mesh[${index}].indices`);
      assertTriangleIndices(mesh.indices, vertexCount, `mesh[${index}].indices`);
    }

    // 真正的 GPU Skinning Attributes（4 components / vertex）
    if (meshData.boneIndicesBase64) {
      mesh.skinIndices = decodeSkinIndices(meshData.boneIndicesBase64, vertexCount);
    }
    if (meshData.boneWeightsBase64) {
      mesh.skinWeights = decodeSkinWeights(meshData.boneWeightsBase64, vertexCount);
    }

    if (input.texture) mesh.texture = input.texture;
    meshes.push(mesh);
  }
  const bounds = computeSceneBounds(input.boundingBox, meshes, input.skeleton.length > 0 ? 15 : 100);
  const bones = input.skeleton.map((bone, index) => ({
    id: `bone-${index}`,
    name: bone.name,
    parentIndex: bone.parentIndex,
    translation: bone.translation,
    rotation: bone.rotation,
    scale: bone.scale ?? [1, 1, 1],
    rotationOrder: (bone.rotationOrder === 'XZY' ? 'YZX' : bone.rotationOrder) ?? 'YZX'
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
    ...(meshes.length === 0 && bones.length > 0 ? { showSkeletonMarkers: true } : {}),
    bounds
  };
}

export function buildBundleSemanticScene(
  bundle: CharacterPreviewBundle,
  boundingBox?: { min: number[]; max: number[] } | undefined,
  texture: FlverSceneTexture | null = null
): FlverSemanticScene {
  const meshes: FlverSceneMesh[] = [];
  const skeletons = bundle.models
    .filter((model) => model.bones.length > 0)
    .map((model) => ({
      id: model.modelId,
      bones: model.bones.map((bone) => ({
        id: `${model.modelId}:bone:${bone.index}`,
        index: bone.index,
        name: bone.name,
        parentIndex: bone.parentIndex,
        childIndex: bone.childIndex,
        nextSiblingIndex: bone.nextSiblingIndex,
        hierarchyId: bone.hierarchyId,
        translation: bone.translation,
        rotation: bone.rotation,
        scale: bone.scale,
        rotationOrder: (bone.rotationOrder === 'XZY' ? 'YZX' : bone.rotationOrder) as 'YZX' | 'XYZ'
      }))
    }));

  for (const model of bundle.models) {
    for (const meshData of model.meshes) {
      const skeletonId = meshData.skeletonId ?? model.modelId;
      const targetSkeleton = bundle.models.find((candidate) => candidate.modelId === skeletonId);
      const mesh = decodeBundleMesh(model, meshData, texture, targetSkeleton?.bones.length ?? model.bones.length);
      meshes.push(mesh);
    }
  }
  if (meshes.length !== bundle.meshCount) {
    throw new Error(`FLVER_BUNDLE_MESH_COUNT_MISMATCH: expected=${bundle.meshCount} actual=${meshes.length}`);
  }
  return {
    meshes,
    ...(skeletons.length > 0 ? { skeletons } : {}),
    ...(meshes.length === 0 && skeletons.length > 0 ? { showSkeletonMarkers: true } : {}),
    bounds: computeSceneBounds(boundingBox, meshes, skeletons.length > 0 ? 15 : 100)
  };
}

function decodeBundleMesh(
  model: FlverPreviewModel,
  meshData: FlverPreviewMesh,
  texture: FlverSceneTexture | null,
  targetSkeletonBoneCount: number
): FlverSceneMesh {
  const label = `${model.entry.name}:mesh[${meshData.meshIndex}]`;
  const positions = decodeFloat32Array(meshData.positionsBase64, `${label}.positions`);
  const vertexCount = meshData.vertexCount;
  assertVertexAttributeLength(positions.length, vertexCount, 3, `${label}.positions`);
  const mesh: FlverSceneMesh = {
    id: `${model.modelId}:mesh:${meshData.meshIndex}`,
    label,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    positions,
    indexSize: meshData.indexSize,
    skinningMode: meshData.skinningMode,
    boneIndexSpace: meshData.boneIndexSpace,
    skeletonId: meshData.skeletonId ?? model.modelId,
    vertexCount,
    wireframeOverlay: false
  };
  if (meshData.indicesBase64) {
    mesh.indices = decodeMeshIndices(meshData.indicesBase64, meshData.indexSize, `${label}.indices`);
    assertTriangleIndices(mesh.indices, vertexCount, `${label}.indices`);
  }
  if (meshData.uvsBase64) {
    mesh.uvs = decodeFloat32Array(meshData.uvsBase64, `${label}.uvs`);
    assertVertexAttributeLength(mesh.uvs.length, vertexCount, 2, `${label}.uvs`);
  }
  if (meshData.normalsBase64) {
    mesh.normals = decodeFloat32Array(meshData.normalsBase64, `${label}.normals`);
    assertVertexAttributeLength(mesh.normals.length, vertexCount, 3, `${label}.normals`);
  }
  const hasSkinPayload = Boolean(meshData.boneIndicesBase64 && meshData.boneWeightsBase64);
  if (meshData.skinningMode === 'static') {
    if (hasSkinPayload) throw new Error(`FLVER_STATIC_MESH_HAS_SKIN_PAYLOAD: ${label}`);
  } else {
    if (!meshData.boneIndicesBase64 || !meshData.boneWeightsBase64) {
      throw new Error(`FLVER_SKIN_BINDING_INCOMPLETE: ${label}`);
    }
    if (meshData.boneIndexSpace !== 'flver-global') {
      throw new Error(`FLVER_SKIN_INDEX_SPACE_UNSUPPORTED: ${label}`);
    }
    mesh.skinIndices = decodeSkinIndices(meshData.boneIndicesBase64, vertexCount);
    mesh.skinWeights = decodeSkinWeights(meshData.boneWeightsBase64, vertexCount);
    assertSkinIndices(mesh.skinIndices, mesh.skinWeights, targetSkeletonBoneCount, label);
  }
  if (texture) mesh.texture = texture;
  return mesh;
}

/** 把外部/IPC 返回的单个网格的 DTO 规整成内部 MeshData（问题4-A 参数复用）。 */
function toMeshData(input: {
  positionsBase64: string;
  indicesBase64: string;
  indexSize?: number | undefined;
  uvsBase64?: string | undefined;
  normalsBase64?: string | undefined;
  boneWeightsBase64?: string | undefined;
  boneIndicesBase64?: string | undefined;
  skinningMode?: 'weighted' | 'rigid' | 'static' | undefined;
  boneIndexSpace?: 'flver-global' | 'none' | undefined;
  vertexCount: number;
}): MeshData {
  return {
    positionsBase64: input.positionsBase64,
    indicesBase64: input.indicesBase64,
    indexSize: input.indexSize ?? undefined,
    uvsBase64: input.uvsBase64 ?? undefined,
    normalsBase64: input.normalsBase64 ?? undefined,
    boneWeightsBase64: input.boneWeightsBase64 ?? undefined,
    boneIndicesBase64: input.boneIndicesBase64 ?? undefined,
    skinningMode: input.skinningMode,
    boneIndexSpace: input.boneIndexSpace,
    vertexCount: input.vertexCount
  };
}

function computeSceneBounds(
  boundingBox: { min: number[]; max: number[] } | undefined,
  meshes: FlverSceneMesh[],
  emptyFallbackSpan = 100
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
    const halfSpan = emptyFallbackSpan / 2;
    min[0] = -halfSpan;
    min[1] = -halfSpan;
    min[2] = -halfSpan;
    max[0] = halfSpan;
    max[1] = halfSpan;
    max[2] = halfSpan;
  }
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
  };
}

function decodeFloat32Array(base64: string, label: string): Float32Array {
  const bytes = decodeBase64Safe(base64);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`FLVER_ATTRIBUTE_ALIGNMENT_INVALID: ${label} bytes=${bytes.byteLength}`);
  }
  const copy = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const values = new Float32Array(copy);
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(`FLVER_ATTRIBUTE_NONFINITE: ${label}`);
  }
  return values;
}

function decodeMeshIndices(base64: string, indexSize: number = 16, label = 'indices'): Uint16Array | Uint32Array {
  const bytes = decodeBase64Safe(base64);
  const width = indexSize === 32 ? Uint32Array.BYTES_PER_ELEMENT : Uint16Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength % width !== 0) {
    throw new Error(`FLVER_INDEX_ALIGNMENT_INVALID: ${label} bytes=${bytes.byteLength} width=${width}`);
  }
  const copy = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return indexSize === 32 ? new Uint32Array(copy) : new Uint16Array(copy);
}

function assertVertexAttributeLength(
  actualComponents: number,
  vertexCount: number,
  itemSize: number,
  label: string
): void {
  const expected = vertexCount * itemSize;
  if (actualComponents !== expected) {
    throw new Error(`FLVER_ATTRIBUTE_LENGTH_MISMATCH: ${label} expected=${expected} actual=${actualComponents}`);
  }
}

function assertTriangleIndices(
  indices: Uint16Array | Uint32Array,
  vertexCount: number,
  label: string
): void {
  if (indices.length % 3 !== 0) {
    throw new Error(`FLVER_TRIANGLE_LIST_LENGTH_INVALID: ${label} count=${indices.length}`);
  }
  for (const index of indices) {
    if (index >= vertexCount) {
      throw new Error(`FLVER_INDEX_OUT_OF_RANGE: ${label} index=${index} vertices=${vertexCount}`);
    }
  }
}

function decodeSkinIndices(base64: string, vertexCount: number): Uint16Array {
  const bytes = decodeBase64Safe(base64);
  const expectedBytes = vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`FLVER_SKIN_INDEX_LENGTH_MISMATCH: expected=${expectedBytes} actual=${bytes.byteLength}`);
  }
  const copy = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Uint16Array(copy);
}

function decodeSkinWeights(base64: string, vertexCount: number): Float32Array {
  const bytes = decodeBase64Safe(base64);
  const expectedBytes = vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`FLVER_SKIN_WEIGHT_LENGTH_MISMATCH: expected=${expectedBytes} actual=${bytes.byteLength}`);
  }
  const copy = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

function assertSkinIndices(
  indices: Uint16Array,
  weights: Float32Array,
  boneCount: number,
  label: string
): void {
  for (let vertex = 0; vertex < weights.length / 4; vertex += 1) {
    let sum = 0;
    for (let influence = 0; influence < 4; influence += 1) {
      const offset = vertex * 4 + influence;
      const weight = weights[offset]!;
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error(`FLVER_SKIN_WEIGHT_INVALID: ${label} vertex=${vertex}`);
      }
      sum += weight;
      if (weight > 1e-6 && indices[offset]! >= boneCount) {
        throw new Error(`FLVER_SKIN_INDEX_OUT_OF_RANGE: ${label} vertex=${vertex} bone=${indices[offset]} bones=${boneCount}`);
      }
    }
    if (!Number.isFinite(sum) || sum < 0.999 || sum > 1.001) {
      throw new Error(`FLVER_SKIN_WEIGHT_SUM_INVALID: ${label} vertex=${vertex} sum=${sum}`);
    }
  }
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
