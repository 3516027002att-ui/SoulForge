/**
 * Three.js scene projection layer for the SoulForge renderer.
 *
 * This module is a *projection only*. It consumes renderer-independent semantic
 * scene descriptions (SceneDrawList for the MSB proxy, FlverSemanticScene for
 * real FLVER meshes) and never holds authoritative scene documents — hard
 * constraint 18: THREE.Object3D / renderer objects / React state are never the
 * authority. The semantic scenes are plain typed data owned by the caller.
 *
 * Backends: WebGPU-first with WebGL2 fallback. `rendererBackend` may be injected
 * for deterministic verification; `rendererFactory` is a headless test seam that
 * replaces GPU-backed renderer construction entirely.
 */

import type { SceneDrawList } from './sceneManifestBrowser.js';
import {
  type AuthoritativeAnimationClip,
  sampleAuthoritativePose
} from '@soulforge/shared';
import { ModelResourcePool } from './modelResourcePool.js';
import type {
  BufferGeometry,
  CompressedPixelFormat,
  CompressedTextureMipmap,
  Material,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
} from 'three';

type ThreeModule = typeof import('three');

export type RendererBackend = 'webgpu' | 'webgl2';

export type TransformMode = 'translate' | 'rotate' | 'scale';

export interface TransformChangeEvent {
  id: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export type ProxySceneRenderState = 'proxy' | 'mesh' | 'missing';

export interface ProxySceneRenderAuditItem {
  id: string;
  state: ProxySceneRenderState;
  visible: boolean;
}

/** Minimal renderer surface shared by WebGPU / WebGL2 / headless fakes. */
export interface ThreeRendererLike {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: Scene, camera: PerspectiveCamera): void;
  dispose(): void;
}

export interface ThreeSceneHandle {
  canvas: HTMLCanvasElement;
  dispose: () => void;
  setSelected: (id: string | null) => void;
  selectedId: string | null;
  rendererBackend: RendererBackend;
  setTransformMode?: (mode: TransformMode) => void;
}

export interface ProxySceneHandle extends ThreeSceneHandle {
  setDrawList: (list: SceneDrawList) => void;
  /** 用真实 FLVER 网格替换某个 proxy 盒子；找不到 id 则忽略。 */
  replaceItemMesh: (id: string, mesh: FlverSceneMesh) => void;
  /** 按 modelName 批量更新场景内所有引用该模型的 Mesh 几何体（对齐 Smithbox 几何共享池） */
  updateModelGeometry?: (modelName: string, geometryData: {
    positionsBase64: string;
    indicesBase64?: string | undefined;
    indexSize?: 16 | 32 | undefined;
    uvsBase64?: string | undefined;
    normalsBase64?: string | undefined;
    vertexCount: number;
  }) => void;
}

export interface FlverSceneHandle extends ThreeSceneHandle {
  setScene: (scene: FlverSemanticScene) => void;
  setActiveAnimationClip?: (clip: AuthoritativeAnimationClip | null) => void;
  setPlaybackTime?: (time: number) => void;
  setPose?: (pose: Array<{
    translation: [number, number, number];
    rotation: [number, number, number, number] | [number, number, number];
    scale?: [number, number, number] | undefined;
  }>) => void;
  setSkeletonPoses?: (poses: Readonly<Record<string, Array<{
    translation: [number, number, number];
    rotation: [number, number, number, number] | [number, number, number];
    scale?: [number, number, number] | undefined;
  }>>>) => void;
}

/** 未压缩 RGBA 纹理投影输入（typed bytes，不含渲染器对象）。 */
export interface FlverSceneRgbaTexture {
  kind: 'rgba';
  width: number;
  height: number;
  rgbaBytes: Uint8Array;
}

/**
 * DDS 压缩纹理投影输入。mipmap 数据来自 DDSLoader.parse（纯数据解析，
 * 渲染器无关）；`format` 是不透明格式码（three 压缩纹理格式常量），
 * 由投影层在构造 CompressedTexture 时消费。
 */
export interface FlverSceneDdsTexture {
  kind: 'dds';
  width: number;
  height: number;
  mipmaps: Array<{ data: ArrayBufferView; width: number; height: number }>;
  /** three 压缩纹理格式码（DDSLoader.parse 返回的 CompressedPixelFormat）。 */
  format: CompressedPixelFormat;
  mipmapCount: number;
}

export type FlverSceneTexture = FlverSceneRgbaTexture | FlverSceneDdsTexture;

export interface FlverSceneMesh {
  id: string;
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  positions: Float32Array;
  uvs?: Float32Array;
  normals?: Float32Array;
  indices?: Uint16Array | Uint32Array;
  indexSize?: 16 | 32;
  vertexColors?: Float32Array;
  skinIndices?: Uint16Array;
  skinWeights?: Float32Array;
  /** The FLVER-local skeleton namespace used by this mesh. */
  skeletonId?: string;
  skinningMode?: 'weighted' | 'rigid' | 'static';
  boneIndexSpace?: 'flver-global' | 'none';
  vertexCount: number;
  wireframeOverlay?: boolean;
  texture?: FlverSceneTexture;
}

export interface FlverSceneBone {
  id: string;
  index?: number;
  name: string;
  parentIndex: number;
  childIndex?: number;
  nextSiblingIndex?: number;
  hierarchyId?: string;
  translation: [number, number, number];
  rotation: [number, number, number];
  scale?: [number, number, number];
  rotationOrder?: 'YZX' | 'XYZ';
}

export interface FlverSceneSkeleton {
  id: string;
  bones: FlverSceneBone[];
}

export interface FlverSceneDummy {
  id: string;
  referenceId: number;
  position: [number, number, number];
}

export interface FlverSceneBounds {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
}

/**
 * 渲染器无关的 FLVER 语义场景：纯 typed data（float32/uint16 缓冲、数量），
 * 不含 THREE 对象、不含绝对路径。投影层只消费它，不反向拥有它。
 */
export interface FlverSemanticScene {
  meshes: FlverSceneMesh[];
  bones?: FlverSceneBone[];
  skeletons?: FlverSceneSkeleton[];
  dummies?: FlverSceneDummy[];
  /** Bone helpers are diagnostic and stay off in normal model/action previews. */
  showSkeletonMarkers?: boolean;
  bounds: FlverSceneBounds;
}

type ResourceTracker = <T extends { dispose(): void }>(resource: T) => T;

interface MountInput {
  container: HTMLElement;
  rendererBackend?: RendererBackend;
  /** Headless test seam: replaces GPU-backed renderer construction. */
  rendererFactory?: (canvas: HTMLCanvasElement) => ThreeRendererLike;
  onSelect?: (itemId: string | null) => void;
  onTransformChange?: (event: TransformChangeEvent) => void;
  /**
   * Test seam: fires with the currently tracked disposables after each content
   * build, letting headless smoke assert every resource is disposed on release.
   */
  resourceAudit?: (resources: ReadonlyArray<{ dispose(): void }>) => void;
  /** Headless lifecycle seam: records proxy → mesh replacement without becoming scene authority. */
  renderAudit?: (phase: 'content-ready' | 'mesh-ready' | 'content-cleared', items: readonly ProxySceneRenderAuditItem[]) => void;
  /** Headless functional-test seam; never used as scene authority. */
  cameraAudit?: (camera: PerspectiveCamera) => void;
}

interface SceneCore {
  three: ThreeModule;
  scene: Scene;
  camera: PerspectiveCamera;
  root: Object3D;
  markerGroup: Object3D;
  highlightGroup: Object3D;
  meshes: Map<string, Object3D>;
  instanceBatches: Map<string, InstanceBatch>;
  resources: Array<{ dispose(): void }>;
  track: ResourceTracker;
  renderer: ThreeRendererLike;
  rendererBackend: RendererBackend;
  canvas: HTMLCanvasElement;
  selectedId: string | null;
  setSelected: (id: string | null, notify?: boolean) => void;
  setTransformMode: (mode: TransformMode) => void;
  getItemRenderState: (id: string) => ProxySceneRenderState;
  addMesh: (id: string, object: Object3D) => void;
  addInstanceBatch: (
    key: string,
    items: SceneDrawList['items'],
    geometry: BufferGeometry,
    material: Material
  ) => void;
  updateInstanceBatchGeometry: (key: string, geometry: BufferGeometry, material: Material) => void;
  replaceModelGeometry: (modelName: string, geometry: BufferGeometry, material: Material) => number;
  clearContent: () => void;
  frameToBounds: (bounds: FlverSceneBounds) => void;
  disposeAll: () => void;
}

interface InstanceBinding {
  batchKey: string;
  mesh: import('three').InstancedMesh;
  instanceIndex: number;
  target: Object3D;
  worldBounds: import('three').Box3;
}

interface InstanceBatch {
  key: string;
  mesh: import('three').InstancedMesh;
  ids: string[];
  root: Object3D;
}

const HIGHLIGHT_COLOR = 0x4fa8ff;

/**
 * Deterministic backend resolution: explicit override wins; otherwise WebGPU
 * when the adapter is available, WebGL2 as the compatible fallback.
 */
export function resolveRendererBackend(
  override: RendererBackend | undefined,
  gpuAvailable: boolean
): RendererBackend {
  return override ?? (gpuAvailable ? 'webgpu' : 'webgl2');
}

/**
 * Derive a useful initial camera frame without changing the authoritative draw
 * list or hiding any entities. Large native maps occasionally contain a small
 * number of distant part placements; fitting the exact AABB makes the playable
 * cluster a few pixels wide. For sufficiently large maps, trim one percent of
 * placement centres at each axis edge for the initial camera only. Home/F keep
 * using this stable navigation frame, while every part remains rendered and
 * selectable.
 */
export function computeRobustInitialCameraBounds(list: SceneDrawList): FlverSceneBounds {
  const partPositions = list.items
    .filter((item) => item.entityKind === 'msb-part')
    .map((item) => item.position)
    .filter((position) => position.every(Number.isFinite));
  if (partPositions.length < 32) return list.bounds;

  const trim = Math.max(1, Math.floor(partPositions.length * 0.01));
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const values = partPositions.map((position) => position[axis]!).sort((a, b) => a - b);
    const low = values[trim]!;
    const high = values[values.length - trim - 1]!;
    min[axis] = Object.is(low, -0) ? 0 : low;
    max[axis] = Object.is(high, -0) ? 0 : high;
  }
  return {
    min,
    max,
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2
    ]
  };
}

export async function mountThreeProxyScene(
  input: MountInput & { drawList: SceneDrawList }
): Promise<ProxySceneHandle> {
  const core = await mountSceneCore(input);
  const resourcePool = new ModelResourcePool();
  let initialFramed = false;
  let hasContent = false;
  let activeDrawList = input.drawList;

  const emitRenderAudit = (phase: 'content-ready' | 'mesh-ready' | 'content-cleared'): void => {
    input.renderAudit?.(
      phase,
      activeDrawList.items.map((item) => ({
        id: item.id,
        state: core.getItemRenderState(item.id),
        visible: core.meshes.get(item.id)?.visible ?? false
      }))
    );
  };

  const setDrawList = (list: SceneDrawList): void => {
    try {
      assertNoAbsolutePathLeak(list);
      activeDrawList = list;
      const prevSelected = core.selectedId;
      if (hasContent) resourcePool.clear();
      core.clearContent();
      for (const batch of groupSceneDrawItems(list.items)) {
        const first = batch.items[0];
        if (!first) continue;
        const geometry = first.mesh
          ? resourcePool.getOrCreateGeometry(core.three, core.track, batch.resourceKey, first.mesh)
          : resourcePool.getPrimitiveGeometry(
              core.three,
              core.track,
              first.primitive === 'sphere' ? 'sphere' : 'box'
            );
        const material = first.mesh
          ? resourcePool.getDefaultRealMaterial(core.three, core.track)
          : resourcePool.getProxyMaterial(core.three, core.track, first.colorRgb);
        core.addInstanceBatch(batch.key, batch.items, geometry, material);
      }
      hasContent = true;
      if (!initialFramed) {
        core.frameToBounds(computeRobustInitialCameraBounds(list));
        initialFramed = true;
      }
      if (prevSelected) {
        core.setSelected(prevSelected, false);
      }
      input.resourceAudit?.([...core.resources]);
      emitRenderAudit('content-ready');
    } catch (error) {
      core.disposeAll();
      throw error;
    }
  };
  setDrawList(input.drawList);

  return {
    canvas: core.canvas,
    rendererBackend: core.rendererBackend,
    get selectedId() {
      return core.selectedId;
    },
    setSelected: (id) => core.setSelected(id),
    setTransformMode: (mode) => core.setTransformMode(mode),
    setDrawList,
    replaceItemMesh: (id, mesh) => {
      const previous = core.meshes.get(id);
      if (previous?.userData.instanceBatchKey) return;
      if (previous) {
        core.root.remove(previous);
        core.meshes.delete(id);
      }
      core.addMesh(id, createFlverMesh(core.three, core.track, mesh));
      emitRenderAudit('mesh-ready');
    },
    updateModelGeometry: (modelName, geometryData) => {
      if (!geometryData.positionsBase64 || geometryData.vertexCount <= 0) return;
      // 1. 使用共享资源池获取或创建 BufferGeometry 和 Material
      const { geometry, material } = resourcePool.updateModelGeometry(
        core.three,
        core.track,
        modelName,
        geometryData
      );

      const replaced = core.replaceModelGeometry(modelName, geometry, material);
      if (replaced === 0) {
        throw new Error(`MAP_RENDERER_MODEL_BATCH_NOT_FOUND: ${modelName}`);
      }
      emitRenderAudit('mesh-ready');
    },
    dispose: () => {
      resourcePool.clear();
      core.disposeAll();
      emitRenderAudit('content-cleared');
    }
  };
}

/**
 * Mount a WebGPU-first scene that projects real FLVER mesh geometry.
 * The semantic scene is plain typed data (vertex/index buffers, transforms),
 * never THREE objects — the projection layer owns all renderer objects and
 * releases them on dispose.
 */
export async function mountFlverScene(input: {
  container: HTMLElement;
  scene: FlverSemanticScene;
  onSelect?: (itemId: string | null) => void;
  rendererBackend?: RendererBackend;
  rendererFactory?: (canvas: HTMLCanvasElement) => ThreeRendererLike;
  resourceAudit?: (resources: ReadonlyArray<{ dispose(): void }>) => void;
}): Promise<FlverSceneHandle> {
  const core = await mountSceneCore(input);
  interface RuntimeSkeleton {
    bones: Array<import('three').Bone>;
    skeleton: import('three').Skeleton;
    initialBones: Array<{
      translation: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
    }>;
  }
  let activeSkeletons = new Map<string, RuntimeSkeleton>();

  const applyPoseLocals = (runtime: RuntimeSkeleton, pose: Array<{
    translation: [number, number, number];
    rotation: [number, number, number, number] | [number, number, number];
    scale?: [number, number, number] | undefined;
  }>): void => {
    for (let index = 0; index < runtime.bones.length && index < pose.length; index += 1) {
      const transform = pose[index];
      const bone = runtime.bones[index];
      if (!transform || !bone) continue;
      bone.position.set(transform.translation[0], transform.translation[1], transform.translation[2]);
      if (transform.rotation.length === 4) {
        bone.quaternion.set(
          transform.rotation[0],
          transform.rotation[1],
          transform.rotation[2],
          transform.rotation[3]
        );
      } else {
        bone.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2], 'YZX');
      }
      const scale = transform.scale ?? [1, 1, 1];
      bone.scale.set(scale[0], scale[1], scale[2]);
    }
  };

  const resetSkeletonLocals = (runtime: RuntimeSkeleton): void => {
    for (let index = 0; index < runtime.bones.length; index += 1) {
      const initial = runtime.initialBones[index];
      const bone = runtime.bones[index];
      if (!initial || !bone) continue;
      bone.position.set(initial.translation[0], initial.translation[1], initial.translation[2]);
      bone.quaternion.set(initial.rotation[0], initial.rotation[1], initial.rotation[2], initial.rotation[3]);
      bone.scale.set(initial.scale[0], initial.scale[1], initial.scale[2]);
    }
  };

  const syncSkeletons = (runtimes: Iterable<RuntimeSkeleton>): void => {
    const changed = [...runtimes];
    if (changed.length === 0) return;
    // Every FLVER-local skeleton shares this scene root. Propagate local
    // transforms once, then refresh only each skeleton's bone texture.
    core.root.updateMatrixWorld(true);
    for (const runtime of changed) runtime.skeleton.update();
  };

  const setScene = (semantic: FlverSemanticScene): void => {
    try {
      core.clearContent();
      activeSkeletons = new Map<string, RuntimeSkeleton>();

      const semanticSkeletons = semantic.skeletons?.length
        ? semantic.skeletons
        : (semantic.bones?.length ? [{ id: 'default', bones: semantic.bones }] : []);
      for (const semanticSkeleton of semanticSkeletons) {
        const threeBones: Array<import('three').Bone> = [];
        const initialBones: RuntimeSkeleton['initialBones'] = [];
        for (const b of semanticSkeleton.bones) {
          const bone = new core.three.Bone();
          bone.name = b.name;
          bone.position.set(b.translation[0], b.translation[1], b.translation[2]);
          bone.rotation.set(
            b.rotation[0],
            b.rotation[1],
            b.rotation[2],
            b.rotationOrder ?? 'YZX'
          );
          const scale = b.scale ?? [1, 1, 1];
          bone.scale.set(scale[0], scale[1], scale[2]);
          threeBones.push(bone);
          initialBones.push({
            translation: [b.translation[0], b.translation[1], b.translation[2]],
            rotation: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
            scale: [scale[0], scale[1], scale[2]]
          });
        }
        for (let i = 0; i < semanticSkeleton.bones.length; i++) {
          const parentIdx = semanticSkeleton.bones[i]!.parentIndex;
          if (parentIdx >= 0 && parentIdx < threeBones.length && parentIdx !== i) {
            threeBones[parentIdx]!.add(threeBones[i]!);
          } else {
            core.root.add(threeBones[i]!);
          }
        }
        // Skeleton.calculateInverses() samples bone.matrixWorld. The bones
        // have just been attached to the semantic root, so force their world
        // matrices current before capturing bind-pose inverses.
        core.root.updateMatrixWorld(true);
        const skeleton = core.track(new core.three.Skeleton(threeBones));
        activeSkeletons.set(semanticSkeleton.id, { bones: threeBones, skeleton, initialBones });
      }

      // Each FLVER mesh binds only to its own local skeleton namespace.
      for (const item of semantic.meshes) {
        const runtime = activeSkeletons.get(item.skeletonId ?? 'default');
        core.addMesh(item.id, createFlverMesh(core.three, core.track, item, runtime?.skeleton ?? null));
      }
      createMarkers(core.three, core.track, core.markerGroup, semantic);
      core.frameToBounds(semantic.bounds);
      core.setSelected(null, false);
      input.resourceAudit?.([...core.resources]);
    } catch (error) {
      core.disposeAll();
      throw error;
    }
  };

  setScene(input.scene);

  let activeClip: AuthoritativeAnimationClip | null = null;

  return {
    canvas: core.canvas,
    rendererBackend: core.rendererBackend,
    get selectedId() {
      return core.selectedId;
    },
    setSelected: (id) => core.setSelected(id),
    setScene,
    setActiveAnimationClip: (clip: AuthoritativeAnimationClip | null) => {
      activeClip = clip;
    },
    setPlaybackTime: (time: number) => {
      const runtime = activeSkeletons.get('default') ?? activeSkeletons.values().next().value as RuntimeSkeleton | undefined;
      if (!runtime) return;
      if (!activeClip || time <= 0) {
        resetSkeletonLocals(runtime);
        syncSkeletons([runtime]);
        return;
      }
      // 消费权威动画采样位姿（Havok Spline / De Boor 采样结果）
      const poses = sampleAuthoritativePose(activeClip, time, true);
      if (!poses) return;

      for (let i = 0; i < runtime.bones.length; i++) {
        const bone = runtime.bones[i];
        const pose = poses[i];
        if (!bone || !pose) continue;
        bone.position.set(pose.p[0], pose.p[1], pose.p[2]);
        bone.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
        bone.scale.set(pose.s[0], pose.s[1], pose.s[2]);
      }
      syncSkeletons([runtime]);
    },
    setPose: (pose) => {
      const runtime = activeSkeletons.get('default') ?? activeSkeletons.values().next().value as RuntimeSkeleton | undefined;
      if (runtime && pose?.length) {
        applyPoseLocals(runtime, pose);
        syncSkeletons([runtime]);
      }
    },
    setSkeletonPoses: (poses) => {
      const changed: RuntimeSkeleton[] = [];
      for (const [skeletonId, runtime] of activeSkeletons) {
        const pose = poses[skeletonId];
        if (pose?.length) applyPoseLocals(runtime, pose);
        else resetSkeletonLocals(runtime);
        changed.push(runtime);
      }
      syncSkeletons(changed);
    },
    dispose: core.disposeAll
  };
}

async function mountSceneCore(input: MountInput): Promise<SceneCore> {
  const three: ThreeModule = await import('three');
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  input.container.replaceChildren(canvas);

  let renderer: ThreeRendererLike;
  let rendererBackend: RendererBackend;
  if (input.rendererBackend) {
    rendererBackend = input.rendererBackend;
    renderer = input.rendererFactory
      ? input.rendererFactory(canvas)
      : await createRealRenderer(three, canvas, rendererBackend);
  } else {
    const { detectWebGpu } = await import('./webgpuDetect.js');
    const capability = await detectWebGpu();
    rendererBackend = resolveRendererBackend(undefined, capability.available);
    renderer = input.rendererFactory
      ? input.rendererFactory(canvas)
      : await createRealRenderer(three, canvas, rendererBackend);
  }
  renderer.setPixelRatio(Math.min(typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1, 2));

  const scene = new three.Scene();
  scene.background = new three.Color(0x1a1d23);
  const camera = new three.PerspectiveCamera(55, 1, 0.1, 50_000);
  input.cameraAudit?.(camera);
  const root = new three.Group();
  scene.add(root);
  scene.add(new three.AmbientLight(0xffffff, 0.55));
  const key = new three.DirectionalLight(0xffffff, 0.85);
  key.position.set(40, 80, 20);
  scene.add(key);

  const grid = new three.GridHelper(200, 20, 0x3a4150, 0x2a303c);
  const axes = new three.AxesHelper(10);
  scene.add(grid);
  scene.add(axes);

  const markerGroup = new three.Group();
  scene.add(markerGroup);
  const highlightGroup = new three.Group();
  scene.add(highlightGroup);

  const meshes = new Map<string, Object3D>();
  // placement -> all chunks identity: one placement has bindings for every uploaded chunk
  const instanceBindings = new Map<string, InstanceBinding>();
  const placementToAllChunkBindings = new Map<string, InstanceBinding[]>();
  const instanceBatches = new Map<string, InstanceBatch>();
  const pickables = new Set<Object3D>();
  // spatial cell index for pick: only relevant placements are tested via DDA
  const CELL_SIZE = 64; // scene world units after C_game_to_scene_root
  const spatialCellIndex = new Map<string, Set<string>>(); // cellKey -> placementIds
  const oversizedPlacements = new Set<string>();
  const placementWorldBounds = new Map<string, import('three').Box3>();
  const placementCells = new Map<string, string[]>();
  const renderStates = new Map<string, ProxySceneRenderState>();
  const resources: Array<{ dispose(): void }> = [];
  const staticResources: Array<{ dispose(): void }> = [grid.geometry, axes.geometry];
  const highlightMaterials = new Set<{ dispose(): void }>();
  const track: ResourceTracker = (resource) => {
    resources.push(resource);
    return resource;
  };

  let selectedId: string | null = null;
  let raf = 0;
  let disposed = false;

  type TransformPointer = { x: number; y: number; button: number };
  type UniversalTransformControl = {
    attach(object: Object3D): void;
    detach(): void;
    setMode(mode: TransformMode): void;
    getHelper?(): Object3D;
    addEventListener(event: string, listener: (event: unknown) => void): void;
    pointerHover(pointer: TransformPointer): void;
    pointerDown(pointer: TransformPointer): void;
    pointerMove(pointer: TransformPointer): void;
    pointerUp(pointer: TransformPointer): void;
    reset(): void;
    dispose(): void;
    axis?: string | null;
    dragging?: boolean;
    object?: Object3D;
    mode?: TransformMode;
  };

  let transformControls: UniversalTransformControl[] = [];
  let activeTransformControl: UniversalTransformControl | null = null;
  let preferredTransformMode: TransformMode = 'translate';
  let transformDragging = false;
  let pendingTransformChange: TransformChangeEvent | null = null;

  const detachUniversalControls = (): void => {
    for (const control of transformControls) control.detach();
    activeTransformControl = null;
    transformDragging = false;
  };

  const attachUniversalControls = (target: Object3D): void => {
    for (const control of transformControls) control.attach(target);
  };

  const detachSelectionTarget = (id: string | null): void => {
    if (!id) return;
    const binding = instanceBindings.get(id);
    const target = binding?.target ?? meshes.get(id);
    if (!target) return;
    if (transformControls.some((control) => control.object === target)) {
      for (const control of transformControls) control.detach();
    }
    // Instance targets are temporarily attached to root while selected. Real
    // meshes remain scene children and must not be removed on deselection.
    if (binding && binding.target.parent) binding.target.parent.remove(binding.target);
    // post-condition: old target must be detached
    if (binding && binding.target.parent !== null) {
      console.error(`[gizmo] detach failed for ${id}: parent still ${binding.target.parent?.type}`);
    }
  };

  const assertAttachedToBatchRoot = (binding: InstanceBinding): boolean => {
    const batch = instanceBatches.get(binding.batchKey);
    const batchRoot = batch?.root ?? (binding.mesh.parent as Object3D | null) ?? root;
    if (binding.target.parent !== batchRoot) {
      console.error(`[gizmo] attach assert failed: target.parent !== batch.root for ${binding.target.userData.itemId}`);
      return false;
    }
    return true;
  };

  // ---- 关卡编辑器 Free-Look Fly Camera Controller (原地转头 + 自由漫游) ----
  let yaw = 0;
  let pitch = -0.25; // 略微俯视
  let baseFlySpeed = 15;
  let isRightMouseDown = false;
  let isMiddleMouseDown = false;
  let lastPointerX = 0;
  let lastPointerY = 0;

  const updateCameraOrientation = (): void => {
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const forward = new three.Vector3(sinYaw * cosPitch, sinPitch, -cosYaw * cosPitch).normalize();
    camera.lookAt(camera.position.clone().add(forward));
    camera.updateMatrixWorld(true);
  };
  updateCameraOrientation();

  let suppressSelectionUntil = 0;

  const setSize = (): void => {
    const width = Math.max(input.container.clientWidth, 1);
    const height = Math.max(input.container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const clearHighlightObjects = (): void => {
    for (const object of highlightGroup.children.slice()) highlightGroup.remove(object);
    for (let index = resources.length - 1; index >= 0; index--) {
      const resource = resources[index];
      if (resource && highlightMaterials.has(resource)) {
        resources.splice(index, 1);
        resource.dispose();
      }
    }
    highlightMaterials.clear();
  };

  const applyHighlight = (id: string): void => {
    const object = meshes.get(id);
    if (!object) return;
    const binding = instanceBindings.get(id);
    let source: Object3D = object;
    let geometry: BufferGeometry | null = binding?.mesh.geometry ?? null;
    if (!geometry) {
      object.traverse((child) => {
        if (!geometry && (child as Mesh).isMesh) {
          geometry = (child as Mesh).geometry;
          source = child;
        }
      });
    }
    if (!geometry) return;
    const overlayMaterial = new three.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      wireframe: true,
      transparent: true,
      opacity: 0.7,
      depthTest: false
    });
    highlightMaterials.add(overlayMaterial);
    resources.push(overlayMaterial);
    const overlay = new three.Mesh(geometry, overlayMaterial);
    source.updateMatrixWorld(true);
    source.matrixWorld.decompose(overlay.position, overlay.quaternion, overlay.scale);
    overlay.userData.itemId = id;
    highlightGroup.add(overlay);
  };

  const syncHighlightTransform = (id: string): void => {
    const source = meshes.get(id);
    const overlay = highlightGroup.children[0];
    if (!source || !overlay) return;
    source.updateMatrixWorld(true);
    source.matrixWorld.decompose(overlay.position, overlay.quaternion, overlay.scale);
  };

  const setSelected = (id: string | null, notify = true): void => {
    if (selectedId === id) {
      if (id) {
        const binding = instanceBindings.get(id);
        const target = binding?.target ?? meshes.get(id);
        if (binding) {
          const placementRoot = root;
          if (binding.target.parent !== placementRoot) {
            binding.target.parent?.remove(binding.target);
            placementRoot.add(binding.target);
            binding.target.updateMatrix();
            binding.target.updateMatrixWorld(true);
          }
          // single binding invariant: target parent is root
          if (binding.target.parent !== placementRoot) return;
          if (transformControls.length > 0 && !transformControls.every((control) => control.object === binding.target)) {
            attachUniversalControls(binding.target);
          }
        } else if (target && transformControls.length > 0 && !transformControls.every((control) => control.object === target)) {
          attachUniversalControls(target);
        }
      }
      return;
    }
    // Detach old selection target from its batch root
    if (selectedId) detachSelectionTarget(selectedId);
    selectedId = id;
    clearHighlightObjects();
    if (id) {
      applyHighlight(id);
      const binding = instanceBindings.get(id);
      if (binding) {
        // 24.10 single binding: target attaches to shared placementRoot (root), not per-batch child root
        const placementRoot = root;
        const m = new three.Matrix4();
        binding.mesh.getMatrixAt(binding.instanceIndex, m);
        m.decompose(binding.target.position, binding.target.quaternion, binding.target.scale);
        binding.target.updateMatrix();
        if (binding.target.parent !== placementRoot) {
          binding.target.parent?.remove(binding.target);
          placementRoot.add(binding.target);
        }
        binding.target.updateMatrixWorld(true);
        // invariant: InstancedMesh is direct child of placementRoot with identity local matrix (single binding per spec)
        if (binding.target.parent !== placementRoot) return;
        if (transformControls.length > 0) attachUniversalControls(binding.target);
      } else {
        // Non-instanced mesh
        const target = meshes.get(id);
        if (target && transformControls.length > 0) {
          if (target.parent !== root) {
            target.parent?.remove(target);
            root.add(target);
          }
          attachUniversalControls(target);
        }
      }
    } else {
      detachUniversalControls();
    }
    if (notify) input.onSelect?.(id);
  };

  const setTransformMode = (mode: TransformMode): void => {
    // Compatibility for keyboard/legacy callers. Universal mode keeps all
    // three handle families visible; the preferred family only resolves exact
    // overlap when a pointer begins a gesture.
    preferredTransformMode = mode;
  };

  const addMesh = (id: string, object: Object3D): void => {
    object.userData.itemId = id;
    root.add(object);
    pickables.add(object);
    meshes.set(id, object);
    renderStates.set(id, 'mesh');
    if (selectedId === id && transformControls.length > 0) {
      for (const control of transformControls) control.attach(object);
    }
  };

  const updateBindingBounds = (binding: InstanceBinding): void => {
    const geometry = binding.mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    binding.target.updateMatrixWorld(true);
    if (geometry.boundingBox) {
      binding.worldBounds.copy(geometry.boundingBox).applyMatrix4(binding.target.matrixWorld);
    } else {
      binding.worldBounds.setFromCenterAndSize(
        binding.target.position,
        new three.Vector3(1, 1, 1)
      );
    }
  };

  const removePlacementSpatialIndex = (id: string): void => {
    for (const cellKey of placementCells.get(id) ?? []) {
      const placements = spatialCellIndex.get(cellKey);
      placements?.delete(id);
      if (placements && placements.size === 0) spatialCellIndex.delete(cellKey);
    }
    placementCells.delete(id);
    oversizedPlacements.delete(id);
    placementWorldBounds.delete(id);
  };

  const indexPlacementBounds = (id: string, bounds: import('three').Box3): void => {
    removePlacementSpatialIndex(id);
    if (![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) return;
    placementWorldBounds.set(id, bounds.clone());
    const minCellX = Math.floor(bounds.min.x / CELL_SIZE);
    const minCellY = Math.floor(bounds.min.y / CELL_SIZE);
    const minCellZ = Math.floor(bounds.min.z / CELL_SIZE);
    const maxCellX = Math.floor(bounds.max.x / CELL_SIZE);
    const maxCellY = Math.floor(bounds.max.y / CELL_SIZE);
    const maxCellZ = Math.floor(bounds.max.z / CELL_SIZE);
    const coveredCount = (maxCellX - minCellX + 1) * (maxCellY - minCellY + 1) * (maxCellZ - minCellZ + 1);
    if (coveredCount > 4096) {
      oversizedPlacements.add(id);
      return;
    }
    const cells: string[] = [];
    for (let cx = minCellX; cx <= maxCellX; cx += 1) {
      for (let cy = minCellY; cy <= maxCellY; cy += 1) {
        for (let cz = minCellZ; cz <= maxCellZ; cz += 1) {
          const cellKey = `${cx},${cy},${cz}`;
          const placements = spatialCellIndex.get(cellKey) ?? new Set<string>();
          placements.add(id);
          spatialCellIndex.set(cellKey, placements);
          cells.push(cellKey);
        }
      }
    }
    placementCells.set(id, cells);
  };

  const updateObjectBounds = (id: string, object: Object3D): void => {
    const box = new three.Box3();
    let foundGeometry: BufferGeometry | undefined;
    object.traverse((child) => {
      if (!foundGeometry && (child as Mesh).isMesh) foundGeometry = (child as Mesh).geometry;
    });
    object.updateMatrixWorld(true);
    const geometry = foundGeometry;
    if (geometry) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (geometry.boundingBox) box.copy(geometry.boundingBox).applyMatrix4(object.matrixWorld);
    }
    if (box.isEmpty()) box.setFromObject(object);
    if (box.isEmpty()) box.setFromCenterAndSize(object.position, new three.Vector3(1, 1, 1));
    indexPlacementBounds(id, box);
  };

  const addInstanceBatch = (
    batchKey: string,
    items: SceneDrawList['items'],
    geometry: BufferGeometry,
    material: Material
  ): void => {
    if (items.length === 0) return;
    const instanced = new three.InstancedMesh(geometry, material, items.length);
    instanced.name = batchKey;
    instanced.userData.instanceBatchKey = batchKey;
    instanced.instanceMatrix.setUsage(three.DynamicDrawUsage);
    const ids: string[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item) continue;
      const target = new three.Object3D();
      target.userData.itemId = item.id;
      target.userData.instanceBatchKey = batchKey;
      if (item.modelName) target.userData.modelName = item.modelName;
      target.position.set(item.position[0], item.position[1], item.position[2]);
      target.rotation.set(
        (item.rotation[0] * Math.PI) / 180,
        (item.rotation[1] * Math.PI) / 180,
        (item.rotation[2] * Math.PI) / 180
      );
      target.scale.set(item.scale[0], item.scale[1], item.scale[2]);
      target.updateMatrix();
      target.updateMatrixWorld(true);
      instanced.setMatrixAt(index, target.matrix);
      instanced.setColorAt(
        index,
        new three.Color(item.colorRgb[0], item.colorRgb[1], item.colorRgb[2])
      );
      ids[index] = item.id;
      const binding: InstanceBinding = {
        batchKey,
        mesh: instanced,
        instanceIndex: index,
        target,
        worldBounds: new three.Box3()
      };
      meshes.set(item.id, target);
      renderStates.set(item.id, 'proxy');
      instanceBindings.set(item.id, binding);
      // placement -> all chunks identity: append to forward table (sorted by batchKey)
      const arr = placementToAllChunkBindings.get(item.id) ?? [];
      arr.push(binding);
      arr.sort((a,b)=> a.batchKey.localeCompare(b.batchKey));
      placementToAllChunkBindings.set(item.id, arr);
      updateBindingBounds(binding);
      indexPlacementBounds(item.id, binding.worldBounds);
    }
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
    instanced.computeBoundingBox();
    instanced.computeBoundingSphere();
    // invariant: InstancedMesh parent is placement root and local matrix is identity
    instanced.matrixAutoUpdate = false;
    instanced.matrix.identity();
    instanced.updateMatrixWorld(true);
    root.add(instanced);
    instanceBatches.set(batchKey, { key: batchKey, mesh: instanced, ids, root });
  };

  const updateInstanceBatchGeometry = (
    batchKey: string,
    geometry: BufferGeometry,
    material: Material
  ): void => {
    const batch = instanceBatches.get(batchKey);
    if (!batch) return;
    batch.mesh.geometry = geometry;
    batch.mesh.material = material;
    // Real FLVER geometry uses its authored/default material rather than the
    // diagnostic proxy tint that was attached while the model was loading.
    batch.mesh.instanceColor = null;
    for (const id of batch.ids) {
      const binding = instanceBindings.get(id);
      if (binding) {
        updateBindingBounds(binding);
        indexPlacementBounds(id, binding.worldBounds);
      }
    }
    batch.mesh.computeBoundingBox();
    batch.mesh.computeBoundingSphere();
    if (selectedId && instanceBindings.get(selectedId)?.batchKey === batchKey) {
      clearHighlightObjects();
      applyHighlight(selectedId);
    }
  };

  const replaceModelGeometry = (
    modelName: string,
    geometry: BufferGeometry,
    material: Material
  ): number => {
    const modelKey = normalizeModelName(modelName);
    const batchKey = `model:${modelKey}`;
    const batches = [...instanceBatches.values()].filter((batch) => batch.key === batchKey);
    const replacements: Array<{ id: string; object: Object3D }> = [];

    // Build every real object while the proxy batch is still intact. No scene
    // mutation occurs until all placements can be represented, so a renderer
    // allocation/geometry error leaves the original proxy available.
    for (const batch of batches) {
      for (const id of batch.ids) {
        const binding = instanceBindings.get(id);
        if (!binding) continue;
        const object = new three.Mesh(geometry, material);
        object.userData.itemId = id;
        object.userData.modelName = modelName;
        object.position.copy(binding.target.position);
        object.quaternion.copy(binding.target.quaternion);
        object.scale.copy(binding.target.scale);
        replacements.push({ id, object });
      }
    }

    // A repeated READY notification updates the existing real meshes without
    // resurrecting a proxy or creating duplicate scene entities.
    if (batches.length === 0) {
      const existing = [...meshes.entries()].filter(([id, object]) => (
        renderStates.get(id) === 'mesh'
        && normalizeModelName(String(object.userData.modelName ?? '')) === modelKey
      ));
      for (const [id, object] of existing) {
        const mesh = object as Mesh;
        mesh.geometry = geometry;
        mesh.material = material;
        updateObjectBounds(id, mesh);
      }
      if (selectedId && existing.some(([id]) => id === selectedId)) {
        clearHighlightObjects();
        applyHighlight(selectedId);
      }
      return existing.length;
    }

    if (replacements.length === 0) return 0;

    const replacementIds = new Set(replacements.map(({ id }) => id));
    const selectedReplacement = selectedId !== null && replacementIds.has(selectedId);
    if (selectedReplacement) {
      detachUniversalControls();
      clearHighlightObjects();
    }

    for (const batch of batches) {
      root.remove(batch.mesh);
      instanceBatches.delete(batch.key);
      for (const id of batch.ids) {
        const binding = instanceBindings.get(id);
        if (binding?.target.parent) binding.target.parent.remove(binding.target);
        instanceBindings.delete(id);
        placementToAllChunkBindings.delete(id);
        removePlacementSpatialIndex(id);
        meshes.delete(id);
        renderStates.delete(id);
      }
    }

    // Commit the replacement as one synchronous scene operation: the old
    // InstancedMesh is removed and every real placement is added in this same
    // turn, before the next render frame can observe the scene.
    for (const { id, object } of replacements) {
      root.add(object);
      pickables.add(object);
      meshes.set(id, object);
      renderStates.set(id, 'mesh');
      updateObjectBounds(id, object);
    }

    if (selectedReplacement && selectedId) {
      const selectedObject = meshes.get(selectedId);
      if (selectedObject) {
        applyHighlight(selectedId);
        attachUniversalControls(selectedObject);
      }
    }
    return replacements.length;
  };

  const getItemRenderState = (id: string): ProxySceneRenderState => renderStates.get(id) ?? 'missing';

  const clearContent = (): void => {
    if (selectedId) detachSelectionTarget(selectedId);
    selectedId = null;
    detachUniversalControls();
    pendingTransformChange = null;
    clearHighlightObjects();
    for (const object of root.children.slice()) root.remove(object);
    meshes.clear();
    instanceBindings.clear();
    placementToAllChunkBindings.clear();
    spatialCellIndex.clear();
    placementCells.clear();
    oversizedPlacements.clear();
    placementWorldBounds.clear();
    instanceBatches.clear();
    pickables.clear();
    renderStates.clear();
    for (const object of markerGroup.children.slice()) markerGroup.remove(object);
    for (const resource of resources) resource.dispose();
    resources.length = 0;
  };

  let lastBounds: FlverSceneBounds | null = null;

  const frameToBounds = (bounds: FlverSceneBounds): void => {
    const [cx, cy, cz] = bounds.center;
    const span = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
      15
    );
    lastBounds = bounds;
    // 动态校准基准移动速度，超大地图与局部模型均能自适应
    baseFlySpeed = Math.max(10, Math.min(span * 0.12, 120));

    // 计算合理视距：俯视主要建筑群
    const dist = Math.max(span * 1.0, 16);
    camera.position.set(cx + dist, cy + dist * 0.75, cz + dist);
    camera.lookAt(cx, cy, cz);
    camera.updateMatrixWorld(true);

    // 从新相机方向反算 yaw 与 pitch，保证后续鼠标右键原地转头连续无跳变
    const dir = new three.Vector3(cx - camera.position.x, cy - camera.position.y, cz - camera.position.z).normalize();
    pitch = Math.asin(Math.max(-0.999, Math.min(0.999, dir.y)));
    yaw = Math.atan2(dir.x, -dir.z);
  };

  // 挂载 Universal Transform Gizmo。Three.js 的 TransformControls 本身一次
  // 只展示一种 mode，因此这里把三份 mode-specific control 绑定到同一个
  // semantic target：三个 helper 同时可见，pointerdown 只由命中的那一份
  // control 接管，仍然只产生一个 drag 生命周期。
  void import('three/examples/jsm/controls/TransformControls.js')
    .then((module) => {
      if (disposed) return;
      const { TransformControls } = module as unknown as {
        TransformControls: new (
          camera: PerspectiveCamera,
          element?: HTMLElement
        ) => UniversalTransformControl;
      };
      const controls = (['translate', 'rotate', 'scale'] as const).map((mode) => {
        const control = new TransformControls(camera);
        control.setMode(mode);
        const helper = control.getHelper ? control.getHelper() : (control as unknown as Object3D);
        scene.add(helper);
        return control;
      });
      transformControls = controls;

      const onObjectChange = (control: UniversalTransformControl): void => {
        if (activeTransformControl !== null && activeTransformControl !== control) return;
        const target = control.object;
        if (!target) return;
        const itemId = (target.userData.itemId as string | undefined) ?? selectedId;
        if (!itemId) return;
        // Gizmo attaches to root with single binding target; writes P'*N to all chunk bindings
        const allBindings = placementToAllChunkBindings.get(itemId);
        const binding = instanceBindings.get(itemId);
        if (allBindings && allBindings.length > 0) {
          // single binding invariant: target.parent === placementRoot (root)
          const placementRoot = root;
          if (target.parent !== placementRoot) {
            console.error(`[gizmo] objectChange: target parent mismatch for ${itemId} expected root`);
            return;
          }
          target.updateMatrix();
          // Write placementLocal P' to all chunk bindings as P'*N
          for (const b of allBindings) {
            // b stores instanceIndex for its chunk's InstancedMesh; need to compute P'*N if modelLocal available via userData
            // For proxy path, batch matrix is just P; we write target.matrix directly (no N)
            b.mesh.setMatrixAt(b.instanceIndex, target.matrix);
          }
          // mark each distinct instancedMesh needsUpdate exactly once
          const seen = new Set<import('three').InstancedMesh>();
          for (const b of allBindings) {
            updateBindingBounds(b);
            if (!seen.has(b.mesh)) {
              seen.add(b.mesh);
              b.mesh.instanceMatrix.needsUpdate = true;
            }
          }
          indexPlacementBounds(itemId, allBindings[0]!.worldBounds);
        } else if (binding) {
          const batch = instanceBatches.get(binding.batchKey);
          const batchRoot = batch?.root ?? (binding.mesh.parent as Object3D) ?? root;
          if (target.parent !== batchRoot) {
            console.error(`[gizmo] objectChange: target parent mismatch for ${itemId}`);
            return;
          }
          target.updateMatrix();
           binding.mesh.setMatrixAt(binding.instanceIndex, target.matrix);
           binding.mesh.instanceMatrix.needsUpdate = true;
           updateBindingBounds(binding);
           indexPlacementBounds(itemId, binding.worldBounds);
        } else if (renderStates.get(itemId) === 'mesh') {
           updateObjectBounds(itemId, target);
        }
        const pos: [number, number, number] = [
          Math.round(target.position.x * 1e4) / 1e4,
          Math.round(target.position.y * 1e4) / 1e4,
          Math.round(target.position.z * 1e4) / 1e4
        ];
        const rot: [number, number, number] = [
          Math.round(((target.rotation.x * 180) / Math.PI) * 1e4) / 1e4,
          Math.round(((target.rotation.y * 180) / Math.PI) * 1e4) / 1e4,
          Math.round(((target.rotation.z * 180) / Math.PI) * 1e4) / 1e4
        ];
        const scl: [number, number, number] = [
          Math.round(target.scale.x * 1e4) / 1e4,
          Math.round(target.scale.y * 1e4) / 1e4,
          Math.round(target.scale.z * 1e4) / 1e4
        ];
        syncHighlightTransform(itemId);
        pendingTransformChange = { id: itemId, position: pos, rotation: rot, scale: scl };
      };

      for (const control of controls) {
        control.addEventListener('objectChange', () => onObjectChange(control));
        control.addEventListener('dragging-changed', (event: unknown) => {
        const dragging = Boolean((event as { value?: unknown }).value);
        if (dragging) {
          transformDragging = true;
          activeTransformControl = control;
          const itemId = (control.object?.userData.itemId as string | undefined) ?? selectedId;
          const bindings = itemId
            ? (placementToAllChunkBindings.get(itemId) ?? (instanceBindings.get(itemId) ? [instanceBindings.get(itemId)!] : []))
            : [];
          for (const binding of bindings) binding.mesh.frustumCulled = false;
        } else if (activeTransformControl === control) {
          const itemId = (control.object?.userData.itemId as string | undefined) ?? selectedId;
          const bindings = itemId
            ? (placementToAllChunkBindings.get(itemId) ?? (instanceBindings.get(itemId) ? [instanceBindings.get(itemId)!] : []))
            : [];
          for (const binding of bindings) {
            updateBindingBounds(binding);
            indexPlacementBounds(itemId!, binding.worldBounds);
            binding.mesh.computeBoundingBox();
            binding.mesh.computeBoundingSphere();
            binding.mesh.frustumCulled = true;
          }
          if (itemId && renderStates.get(itemId) === 'mesh') {
            const target = meshes.get(itemId);
            if (target) updateObjectBounds(itemId, target);
          }
          transformDragging = controls.some((candidate) => Boolean(candidate.dragging));
          if (!transformDragging) {
            suppressSelectionUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 80;
            if (pendingTransformChange) input.onTransformChange?.(pendingTransformChange);
            pendingTransformChange = null;
            activeTransformControl = null;
          }
        }
        });
      }

      if (selectedId) {
        const binding = instanceBindings.get(selectedId);
        const target = binding?.target ?? meshes.get(selectedId);
        if (target) {
          if (binding) {
            const batch = instanceBatches.get(binding.batchKey);
            const batchRoot = batch?.root ?? (binding.mesh.parent as Object3D) ?? root;
            if (binding.target.parent !== batchRoot) {
              binding.target.parent?.remove(binding.target);
              batchRoot.add(binding.target);
            }
            if (assertAttachedToBatchRoot(binding)) attachUniversalControls(target);
          } else {
            attachUniversalControls(target);
          }
        }
      }
    })
    .catch(() => undefined);

  const transformPointer = (event: PointerEvent, button: number): TransformPointer => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      y: -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
      button
    };
  };

  const pickUniversalControl = (pointer: TransformPointer): UniversalTransformControl | null => {
    scene.updateMatrixWorld(true);
    const ordered = [...transformControls].sort((left, right) => (
      left.mode === preferredTransformMode ? -1 : right.mode === preferredTransformMode ? 1 : 0
    ));
    for (const control of ordered) {
      control.pointerHover(pointer);
      if (control.axis !== null && control.axis !== undefined) return control;
    }
    return null;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || activeTransformControl || transformControls.length === 0) return;
    const control = pickUniversalControl(transformPointer(event, 0));
    if (!control) return;
    activeTransformControl = control;
    control.pointerDown(transformPointer(event, 0));
    if (!control.dragging) {
      activeTransformControl = null;
      return;
    }
    if (typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activeTransformControl) {
      activeTransformControl.pointerMove(transformPointer(event, -1));
      event.preventDefault();
      return;
    }
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
      pickUniversalControl(transformPointer(event, -1));
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!activeTransformControl || event.button !== 0) return;
    const control = activeTransformControl;
    control.pointerUp(transformPointer(event, 0));
    if (typeof canvas.releasePointerCapture === 'function' && canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  };

  const onPointerCancel = (): void => {
    const control = activeTransformControl;
    if (!control) return;
    control.reset();
    pendingTransformChange = null;
    control.pointerUp({ x: 0, y: 0, button: 0 });
    activeTransformControl = null;
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  // ---- 鼠标右键原地转头与中键平移控制 ----
  const onMouseDown = (event: MouseEvent): void => {
    if (transformDragging) return;
    if (event.button === 2) {
      isRightMouseDown = true;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      canvas.focus();
    } else if (event.button === 1) {
      isMiddleMouseDown = true;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      event.preventDefault();
    }
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (transformDragging) return;
    const dx = event.movementX !== undefined && Math.abs(event.movementX) < 100
      ? event.movementX
      : (event.clientX - lastPointerX);
    const dy = event.movementY !== undefined && Math.abs(event.movementY) < 100
      ? event.movementY
      : (event.clientY - lastPointerY);
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;

    if (isRightMouseDown) {
      // 鼠标转头：灵敏度稳定，不随距离产生非线性公转
      const sensitivity = 0.0028;
      yaw -= dx * sensitivity;
      pitch -= dy * sensitivity;
      pitch = Math.max(-1.55, Math.min(1.55, pitch));
      updateCameraOrientation();
    } else if (isMiddleMouseDown) {
      // 中键屏幕空间平移
      const panSpeed = baseFlySpeed * 0.0018;
      const forward = new three.Vector3();
      camera.getWorldDirection(forward);
      const right = new three.Vector3().crossVectors(forward, new three.Vector3(0, 1, 0)).normalize();
      const up = new three.Vector3().crossVectors(right, forward).normalize();
      camera.position.addScaledVector(right, -dx * panSpeed);
      camera.position.addScaledVector(up, dy * panSpeed);
    }
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (event.button === 2) isRightMouseDown = false;
    if (event.button === 1) isMiddleMouseDown = false;
  };

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault(); // 拦截右键菜单，保障关卡漫游体验
  };

  const onWheel = (event: WheelEvent): void => {
    if (transformDragging) return;
    if (event.ctrlKey || event.altKey) {
      // 调节漫游速度
      const factor = event.deltaY < 0 ? 1.2 : 0.83;
      baseFlySpeed = Math.max(1, Math.min(baseFlySpeed * factor, 500));
    } else {
      // 滚轮前后微移
      const forward = new three.Vector3();
      camera.getWorldDirection(forward);
      const step = (event.deltaY < 0 ? 1 : -1) * (baseFlySpeed * 0.15);
      camera.position.addScaledVector(forward, step);
    }
  };

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  if (typeof window !== 'undefined') {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  // WASD 连续漫游
  const pressed = new Set<string>();
  const reusableForward = new three.Vector3();
  const reusableRight = new three.Vector3();
  const reusableUp = new three.Vector3(0, 1, 0);
  const reusableDir = new three.Vector3();
  const reusableWorldUp = new three.Vector3(0, 1, 0);

  const isTypingTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (event.shiftKey) pressed.add('shift');
    else pressed.delete('shift');
    if (key === 'shift') {
      pressed.add('shift');
      return;
    }
    if (['w','a','s','d','q','e','c',' '].includes(key)) {
      pressed.add(key === ' ' ? 'space' : key);
      event.preventDefault();
      return;
    }
    if (key === 'f') {
      // 优先聚焦当前选中的实体；未选中时聚焦全局 bounds
      if (selectedId && meshes.has(selectedId)) {
        event.preventDefault();
        const targetObj = meshes.get(selectedId)!;
        const binding = instanceBindings.get(selectedId);
        const box = binding
          ? binding.worldBounds.clone()
          : new three.Box3().setFromObject(targetObj);
        const center = new three.Vector3();
        box.getCenter(center);
        frameToBounds({
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z],
          center: [center.x, center.y, center.z]
        });
      } else if (lastBounds) {
        event.preventDefault();
        frameToBounds(lastBounds);
      }
      return;
    }
    if (key === 'r' || key === 'home') {
      if (lastBounds) { event.preventDefault(); frameToBounds(lastBounds); }
      return;
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    pressed.delete(key === ' ' ? 'space' : key);
    if (key === 'shift') pressed.delete('shift');
    if (!event.shiftKey) pressed.delete('shift');
  };
  const onWindowBlur = (): void => {
    pressed.clear();
    isRightMouseDown = false;
    isMiddleMouseDown = false;
  };
  const onDblClick = (): void => { if (lastBounds) frameToBounds(lastBounds); };
  const onCanvasClick = (): void => canvas.focus();
  canvas.tabIndex = 0;

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);
  }
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('click', onCanvasClick);

  const raycaster = new three.Raycaster();
  const pointer = new three.Vector2();
  const boundsHit = new three.Vector3();
  const onClick = (event: MouseEvent): void => {
    if ((event.button ?? 0) !== 0) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (transformDragging || now < suppressSelectionUntil) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    let id: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    // 24.13 pick: scan only relevant placements via 3D DDA + spatial cell index
    const testedPlacementIds = new Set<string>();
    // first test oversized placements once (early exit upper bound)
    for (const candidateId of oversizedPlacements) {
      const binding = instanceBindings.get(candidateId);
      if (!binding) continue;
      testedPlacementIds.add(candidateId);
      const hit = raycaster.ray.intersectBox(binding.worldBounds, boundsHit);
      if (!hit) continue;
      const distance = raycaster.ray.origin.distanceTo(hit);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        id = candidateId;
      }
    }
    // union grid bounds of populated cells
    if (spatialCellIndex.size > 0) {
      const gridBounds = new three.Box3();
      let hasGrid = false;
      for (const pid of placementWorldBounds.keys()) {
        if (oversizedPlacements.has(pid)) continue;
        const b = placementWorldBounds.get(pid);
        if (!b) continue;
        if (!hasGrid) { gridBounds.copy(b); hasGrid = true; } else gridBounds.union(b);
      }
      if (hasGrid) {
        const hitGrid = raycaster.ray.intersectBox(gridBounds, new three.Vector3());
        if (hitGrid) {
          const origin = raycaster.ray.origin.clone();
          const dir = raycaster.ray.direction.clone().normalize();
          // ray must be finite normalized
          if (Number.isFinite(dir.x) && Number.isFinite(dir.y) && Number.isFinite(dir.z)) {
            // compute t interval through grid
            let tEnter = 0, tExit = camera.far;
            const invDirX = dir.x === 0 ? Infinity : 1/dir.x;
            const invDirY = dir.y === 0 ? Infinity : 1/dir.y;
            const invDirZ = dir.z === 0 ? Infinity : 1/dir.z;
            // slab intersect already via hitGrid, reuse DDA walk from tEnter
            tEnter = Math.max(0, origin.distanceTo(hitGrid));
            // 3D DDA init
            const startPos = origin.clone().addScaledVector(dir, tEnter);
            let cx = Math.floor(startPos.x / CELL_SIZE);
            let cy = Math.floor(startPos.y / CELL_SIZE);
            let cz = Math.floor(startPos.z / CELL_SIZE);
            const stepX = dir.x >= 0 ? 1 : -1;
            const stepY = dir.y >= 0 ? 1 : -1;
            const stepZ = dir.z >= 0 ? 1 : -1;
            const nextBoundaryX = (cx + (stepX > 0 ? 1 : 0)) * CELL_SIZE;
            const nextBoundaryY = (cy + (stepY > 0 ? 1 : 0)) * CELL_SIZE;
            const nextBoundaryZ = (cz + (stepZ > 0 ? 1 : 0)) * CELL_SIZE;
            let tMaxX = dir.x === 0 ? Infinity : (nextBoundaryX - origin.x) / dir.x;
            let tMaxY = dir.y === 0 ? Infinity : (nextBoundaryY - origin.y) / dir.y;
            let tMaxZ = dir.z === 0 ? Infinity : (nextBoundaryZ - origin.z) / dir.z;
            const tDeltaX = dir.x === 0 ? Infinity : CELL_SIZE / Math.abs(dir.x);
            const tDeltaY = dir.y === 0 ? Infinity : CELL_SIZE / Math.abs(dir.y);
            const tDeltaZ = dir.z === 0 ? Infinity : CELL_SIZE / Math.abs(dir.z);
            let t = tEnter;
            const stopT = tExit;
            while (t <= stopT) {
              const cellKey = `${cx},${cy},${cz}`;
              const cellPlacements = spatialCellIndex.get(cellKey);
              if (cellPlacements) {
                for (const candidateId of cellPlacements) {
                  if (testedPlacementIds.has(candidateId)) continue;
                  testedPlacementIds.add(candidateId);
                  const binding = instanceBindings.get(candidateId);
                  if (!binding) continue;
                  const hit = raycaster.ray.intersectBox(binding.worldBounds, boundsHit);
                  if (!hit) continue;
                  if (hit.distanceTo(origin) > nearestDistance) continue;
                  // exact forward lookup: all chunk bindings for placement (placement->all chunks)
                  const allBindings = placementToAllChunkBindings.get(candidateId) ?? (binding ? [binding] : []);
                  for (const b of allBindings) {
                    // cheap AABB already; for exact triangle test would transform ray by inverse instance matrix
                    // here we keep AABB distance as proxy; real triangle BVH test would be inside loop
                  }
                  const distance = raycaster.ray.origin.distanceTo(hit);
                  if (distance < nearestDistance) {
                    nearestDistance = distance;
                    id = candidateId;
                  }
                }
              }
              const nextBoundaryT = Math.min(tMaxX, tMaxY, tMaxZ);
              if (id !== null && nearestDistance <= nextBoundaryT) break;
              if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { cx += stepX; tMaxX += tDeltaX; }
              else if (tMaxY <= tMaxX && tMaxY <= tMaxZ) { cy += stepY; tMaxY += tDeltaY; }
              else if (tMaxZ <= tMaxX && tMaxZ <= tMaxY) { cz += stepZ; tMaxZ += tDeltaZ; }
              else {
                // tie: advance all minima
                const m = nextBoundaryT;
                if (tMaxX === m) { cx += stepX; tMaxX += tDeltaX; }
                if (tMaxY === m) { cy += stepY; tMaxY += tDeltaY; }
                if (tMaxZ === m) { cz += stepZ; tMaxZ += tDeltaZ; }
              }
              t = nextBoundaryT;
              if (!Number.isFinite(t)) break;
            }
          }
        }
      }
    } else {
      // fallback: no spatial index (empty scene) — no scan
    }

    const hits = raycaster.intersectObjects([...pickables], true);
    if (hits[0] && hits[0].distance < nearestDistance) {
      let object: Object3D | null = hits[0].object;
      while (object && typeof object.userData.itemId !== 'string') object = object.parent;
      id = (object?.userData.itemId as string | undefined) ?? null;
    }
    setSelected(id);
  };
  canvas.addEventListener('click', onClick);

  const onResize = (): void => setSize();
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => setSize());
    resizeObserver.observe(input.container);
    const hostParent = input.container.parentElement;
    if (hostParent) resizeObserver.observe(hostParent);
    const columnsContainer = input.container.closest('.workbench__columns') as HTMLElement | null;
    if (columnsContainer) resizeObserver.observe(columnsContainer);
  }
  setSize();

  let lastTick = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const tick = (now?: number): void => {
    if (disposed) return;
    const current = typeof now === 'number' ? now : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let delta = (current - lastTick) / 1000;
    lastTick = current;
    if (delta > 0.1) delta = 0.1;
    if (delta < 0) delta = 0;

    if (pressed.size > 0) {
      let speed = baseFlySpeed * (pressed.has('shift') ? 3.5 : 1.0);
      camera.getWorldDirection(reusableForward);
      reusableRight.crossVectors(reusableForward, reusableWorldUp).normalize();
      reusableDir.set(0, 0, 0);

      if (pressed.has('w')) reusableDir.add(reusableForward);
      if (pressed.has('s')) reusableDir.sub(reusableForward);
      if (pressed.has('a')) reusableDir.sub(reusableRight);
      if (pressed.has('d')) reusableDir.add(reusableRight);
      if (pressed.has('q') || pressed.has('c')) reusableDir.sub(reusableUp);
      if (pressed.has('e') || pressed.has('space')) reusableDir.add(reusableUp);

      if (reusableDir.lengthSq() > 0) {
        reusableDir.normalize().multiplyScalar(speed * delta);
        camera.position.add(reusableDir);
      }
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick as FrameRequestCallback);
  };
  tick(lastTick);

  const disposeAll = (): void => {
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('dblclick', onDblClick);
    canvas.removeEventListener('click', onCanvasClick);
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    for (const control of transformControls) control.dispose();
    transformControls = [];
    clearContent();
    for (const resource of staticResources) resource.dispose();
    renderer.dispose();
    canvas.remove();
  };

  return {
    three,
    scene,
    camera,
    root,
    markerGroup,
    highlightGroup,
    meshes,
    instanceBatches,
    resources,
    track,
    renderer,
    rendererBackend,
    canvas,
    get selectedId() {
      return selectedId;
    },
    setSelected,
    setTransformMode,
    getItemRenderState,
    addMesh,
    addInstanceBatch,
    updateInstanceBatchGeometry,
    replaceModelGeometry,
    clearContent,
    frameToBounds,
    disposeAll
  };
}

async function createRealRenderer(
  three: ThreeModule,
  canvas: HTMLCanvasElement,
  backend: RendererBackend
): Promise<ThreeRendererLike> {
  if (backend === 'webgpu') {
    // three/webgpu exports WebGPURenderer as a *named* export (not default).
    const { WebGPURenderer } = await import('three/webgpu') as unknown as {
      WebGPURenderer: new (
        opts: { canvas: HTMLCanvasElement; antialias: boolean; alpha: boolean }
      ) => ThreeRendererLike & { init(): Promise<void> };
    };
    const gpuRenderer = new WebGPURenderer({ canvas, antialias: true, alpha: false });
    await gpuRenderer.init();
    return gpuRenderer;
  }
  return new three.WebGLRenderer({ canvas, antialias: true, alpha: false });
}

interface SceneDrawBatch {
  key: string;
  resourceKey: string;
  items: SceneDrawList['items'];
}

function normalizeModelName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  return base.toLowerCase().replace(/\.(flver|mapbnd)(\.dcx)?$/i, '');
}

/** 纯数据分组：同一模型的所有 placement 进入一个 GPU instance batch。 */
export function groupSceneDrawItems(items: SceneDrawList['items']): SceneDrawBatch[] {
  const batches = new Map<string, SceneDrawBatch>();
  for (const item of items) {
    const resourceKey = item.modelName
      ? normalizeModelName(item.modelName)
      : `proxy:${item.primitive}`;
    const key = item.modelName ? `model:${resourceKey}` : resourceKey;
    const existing = batches.get(key);
    if (existing) existing.items.push(item);
    else batches.set(key, { key, resourceKey, items: [item] });
  }
  return [...batches.values()];
}

function createFlverMesh(
  three: ThreeModule,
  track: ResourceTracker,
  item: FlverSceneMesh,
  skeleton: import('three').Skeleton | null = null
): Object3D {
  const geometry = track(new three.BufferGeometry());
  geometry.setAttribute('position', new three.BufferAttribute(item.positions, 3));
  if (item.uvs) geometry.setAttribute('uv', new three.BufferAttribute(item.uvs, 2));
  if (item.normals) geometry.setAttribute('normal', new three.BufferAttribute(item.normals, 3));
  else geometry.computeVertexNormals(); // 真实法线存在时绝不覆盖（无损性）。
  if (item.indices) {
    if (item.indices instanceof Uint32Array || item.indexSize === 32) {
      geometry.setIndex(new three.Uint32BufferAttribute(item.indices, 1));
    } else {
      geometry.setIndex(new three.Uint16BufferAttribute(item.indices, 1));
    }
  }
  if (item.vertexColors) geometry.setAttribute('color', new three.BufferAttribute(item.vertexColors, 3));

  // 真正的 GPU Skinning Attributes（4 components / vertex）
  if (item.skinIndices) {
    geometry.setAttribute('skinIndex', new three.Uint16BufferAttribute(item.skinIndices, 4));
  }
  if (item.skinWeights) {
    geometry.setAttribute('skinWeight', new three.Float32BufferAttribute(item.skinWeights, 4));
  }

  const texture = item.texture ? createTexture(three, track, item.texture) : null;
  const material = track(new three.MeshStandardMaterial({
    color: texture ? 0xffffff : new three.Color(0xb0b8c4),
    roughness: 0.5,
    metalness: 0.1,
    ...(texture ? { map: texture } : {}),
    wireframe: false,
    side: three.DoubleSide,
    flatShading: false,
    vertexColors: Boolean(item.vertexColors)
  }));

  const hasCompleteSkinBinding = skeleton !== null
    && item.skinningMode !== 'static'
    && item.boneIndexSpace === 'flver-global'
    && item.skinIndices !== undefined
    && item.skinWeights !== undefined
    && item.skinIndices.length === item.vertexCount * 4
    && item.skinWeights.length === item.vertexCount * 4;
  if (hasCompleteSkinBinding) {
    const skinned = new three.SkinnedMesh(geometry, material);
    skinned.position.set(item.position[0], item.position[1], item.position[2]);
    skinned.rotation.set(item.rotation[0], item.rotation[1], item.rotation[2]);
    skinned.scale.set(item.scale[0], item.scale[1], item.scale[2]);
    skinned.bind(skeleton);
    return skinned;
  }

  const mesh = new three.Mesh(geometry, material);
  mesh.position.set(item.position[0], item.position[1], item.position[2]);
  mesh.rotation.set(item.rotation[0], item.rotation[1], item.rotation[2]);
  mesh.scale.set(item.scale[0], item.scale[1], item.scale[2]);
  if (item.wireframeOverlay) {
    const wireMaterial = track(new three.MeshBasicMaterial({
      color: 0x88bbee,
      wireframe: true,
      transparent: true,
      opacity: 0.15
    }));
    const wire = new three.Mesh(geometry, wireMaterial);
    wire.position.copy(mesh.position);
    wire.rotation.copy(mesh.rotation);
    wire.scale.copy(mesh.scale);
    mesh.add(wire);
  }
  return mesh;
}

function createTexture(three: ThreeModule, track: ResourceTracker, texture: FlverSceneTexture): import('three').Texture {
  if (texture.kind === 'rgba') {
    const dataTexture = track(new three.DataTexture(texture.rgbaBytes, texture.width, texture.height, three.RGBAFormat));
    dataTexture.needsUpdate = true;
    return dataTexture;
  }
  const compressed = track(new three.CompressedTexture(
    texture.mipmaps as unknown as CompressedTextureMipmap[],
    texture.width,
    texture.height,
    texture.format,
    three.UnsignedByteType
  ));
  compressed.minFilter = texture.mipmapCount > 1 ? three.LinearMipmapLinearFilter : three.LinearFilter;
  compressed.magFilter = three.LinearFilter;
  compressed.generateMipmaps = false;
  compressed.flipY = false;
  compressed.needsUpdate = true;
  return compressed;
}

function createMarkers(
  three: ThreeModule,
  track: ResourceTracker,
  markerGroup: Object3D,
  semantic: FlverSemanticScene
): void {
  const bones = semantic.bones ?? semantic.skeletons?.[0]?.bones ?? [];
  if (semantic.showSkeletonMarkers === true && bones.length > 0) {
    const jointMaterial = track(new three.MeshBasicMaterial({ color: 0xffcc66 }));
    const jointGeometry = track(new three.SphereGeometry(0.15, 8, 8));
    const lineMaterial = track(new three.LineBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.6 }));
    const worldMatrices = new Map<number, import('three').Matrix4>();
    const computeWorld = (index: number): import('three').Matrix4 => {
      const cached = worldMatrices.get(index);
      if (cached) return cached;
      const bone = bones[index];
      if (!bone) return new three.Matrix4();
      const local = new three.Matrix4();
      local.makeRotationFromEuler(new three.Euler(
        bone.rotation[0],
        bone.rotation[1],
        bone.rotation[2],
        bone.rotationOrder ?? 'YZX'
      ));
      const scale = bone.scale ?? [1, 1, 1];
      local.scale(new three.Vector3(scale[0], scale[1], scale[2]));
      local.setPosition(bone.translation[0], bone.translation[1], bone.translation[2]);
      let world = local;
      const parent = bone.parentIndex;
      if (parent >= 0 && parent < bones.length && parent !== index) {
        world = computeWorld(parent).clone().multiply(local);
      }
      worldMatrices.set(index, world);
      return world;
    };
    const positions = bones.map((_, index) => new three.Vector3().setFromMatrixPosition(computeWorld(index)));
    for (let index = 0; index < bones.length; index++) {
      const bone = bones[index];
      const position = positions[index];
      if (!bone || !position) continue;
      const joint = new three.Mesh(jointGeometry, jointMaterial);
      joint.position.copy(position);
      markerGroup.add(joint);
      const parent = bone.parentIndex;
      const parentPosition = parent >= 0 && parent < positions.length ? positions[parent] : null;
      if (parentPosition && parent !== index) {
        const lineGeometry = track(new three.BufferGeometry().setFromPoints([position, parentPosition]));
        markerGroup.add(new three.Line(lineGeometry, lineMaterial));
      }
    }
  }

  const dummies = semantic.dummies ?? [];
  if (dummies.length > 0) {
    const dummyGeometry = track(new three.OctahedronGeometry(0.06, 0));
    for (const dummy of dummies) {
      const hue = ((dummy.referenceId * 47) % 360) / 360;
      const markerMaterial = track(new three.MeshBasicMaterial({ color: new three.Color().setHSL(hue, 0.85, 0.55) }));
      const marker = new three.Mesh(dummyGeometry, markerMaterial);
      marker.position.set(dummy.position[0], dummy.position[1], dummy.position[2]);
      markerGroup.add(marker);
    }
  }
}

function assertNoAbsolutePathLeak(list: SceneDrawList): void {
  const serialized = JSON.stringify(list);
  if (/(?:^|["'\s])(?:[A-Za-z]:[\\/]|\\\\)/.test(serialized)
    || /file:\/\/{1,3}[A-Za-z]:/i.test(serialized)
    || /\/(?:Users|home)\//i.test(serialized)) {
    throw new Error('SCENE_ABSOLUTE_PATH_LEAK');
  }
}
