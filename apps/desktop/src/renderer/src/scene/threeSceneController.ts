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
import { decodeBase64ToUint8Array } from '../utils/binary.js';
import {
  type AuthoritativeAnimationClip,
  sampleAuthoritativePose
} from '@soulforge/shared';
import { ModelResourcePool } from './modelResourcePool.js';
import type {
  BoxGeometry,
  BufferGeometry,
  CompressedPixelFormat,
  CompressedTextureMipmap,
  Material,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  SphereGeometry
} from 'three';

type ThreeModule = typeof import('three');

/** base64 → Float32Array（S23：mapbnd 提取的网格 typed buffer）。 */
function decodeBase64F32(base64: string, expectedCount: number): Float32Array {
  const bytes = decodeBase64ToUint8Array(base64);
  const view = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  return view.length >= expectedCount ? view : new Float32Array(expectedCount);
}

export type RendererBackend = 'webgpu' | 'webgl2';

export type TransformMode = 'translate' | 'rotate' | 'scale';

export interface TransformChangeEvent {
  id: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
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
  vertexCount: number;
  wireframeOverlay?: boolean;
  texture?: FlverSceneTexture;
}

export interface FlverSceneBone {
  id: string;
  name: string;
  parentIndex: number;
  translation: [number, number, number];
  rotation: [number, number, number];
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
  dummies?: FlverSceneDummy[];
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
}

interface SceneCore {
  three: ThreeModule;
  scene: Scene;
  camera: PerspectiveCamera;
  root: Object3D;
  markerGroup: Object3D;
  highlightGroup: Object3D;
  meshes: Map<string, Object3D>;
  resources: Array<{ dispose(): void }>;
  track: ResourceTracker;
  renderer: ThreeRendererLike;
  rendererBackend: RendererBackend;
  canvas: HTMLCanvasElement;
  selectedId: string | null;
  setSelected: (id: string | null, notify?: boolean) => void;
  setTransformMode: (mode: TransformMode) => void;
  addMesh: (id: string, object: Object3D) => void;
  clearContent: () => void;
  frameToBounds: (bounds: FlverSceneBounds) => void;
  disposeAll: () => void;
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

export async function mountThreeProxyScene(
  input: MountInput & { drawList: SceneDrawList }
): Promise<ProxySceneHandle> {
  const core = await mountSceneCore(input);
  const resourcePool = new ModelResourcePool();
  let initialFramed = false;

  const setDrawList = (list: SceneDrawList): void => {
    try {
      assertNoAbsolutePathLeak(list);
      const prevSelected = core.selectedId;
      core.clearContent();
      for (const item of list.items) {
        core.addMesh(item.id, createProxyMesh(core.three, core.track, item, resourcePool));
      }
      if (!initialFramed) {
        core.frameToBounds(list.bounds);
        initialFramed = true;
      }
      if (prevSelected) {
        core.setSelected(prevSelected, false);
      }
      input.resourceAudit?.([...core.resources]);
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
      if (previous) {
        core.root.remove(previous);
        core.meshes.delete(id);
      }
      core.addMesh(id, createFlverMesh(core.three, core.track, mesh));
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

      const cleanName = modelName.toLowerCase().replace(/\.mapbnd(\.dcx)?$/i, '');
      // 2. 匹配并热替换所有关联该 modelName 的 Mesh，共享 geometry 与 material
      for (const [id, meshObj] of core.meshes) {
        const mesh = meshObj as import('three').Mesh;
        const uModel = typeof mesh.userData?.modelName === 'string' ? mesh.userData.modelName.toLowerCase() : '';
        const belongs = id.toLowerCase().includes(cleanName) || uModel === cleanName || uModel.includes(cleanName);
        if (belongs && mesh.isMesh) {
          mesh.geometry = geometry;
          mesh.material = material;
        }
      }
    },
    dispose: () => {
      resourcePool.clear();
      core.disposeAll();
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
  let activeBones: Array<import('three').Bone> = [];

  let activeSkeleton: import('three').Skeleton | null = null;
  let initialBones: Array<{
    translation: [number, number, number];
    rotation: [number, number, number];
  }> = [];

  const setScene = (semantic: FlverSemanticScene): void => {
    try {
      core.clearContent();
      activeBones = [];
      activeSkeleton = null;
      initialBones = [];

      // 1. 构建 THREE.Bone 骨骼树（原生弧度，禁止额外乘 PI/180）
      let skeleton: import('three').Skeleton | null = null;
      if (semantic.bones && semantic.bones.length > 0) {
        const threeBones: Array<import('three').Bone> = [];
        for (const b of semantic.bones) {
          const bone = new core.three.Bone();
          bone.name = b.name;
          bone.position.set(b.translation[0], b.translation[1], b.translation[2]);
          bone.rotation.set(b.rotation[0], b.rotation[1], b.rotation[2]);
          threeBones.push(bone);
          initialBones.push({
            translation: [b.translation[0], b.translation[1], b.translation[2]],
            rotation: [b.rotation[0], b.rotation[1], b.rotation[2]]
          });
        }
        for (let i = 0; i < semantic.bones.length; i++) {
          const parentIdx = semantic.bones[i]!.parentIndex;
          if (parentIdx >= 0 && parentIdx < threeBones.length && parentIdx !== i) {
            threeBones[parentIdx]!.add(threeBones[i]!);
          } else {
            core.root.add(threeBones[i]!);
          }
        }
        skeleton = core.track(new core.three.Skeleton(threeBones));
        activeBones = threeBones;
        activeSkeleton = skeleton;
      }

      // 2. 创建网格（含 SkinnedMesh 绑定）
      for (const item of semantic.meshes) {
        core.addMesh(item.id, createFlverMesh(core.three, core.track, item, skeleton));
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
      if (!activeSkeleton || activeBones.length === 0) return;
      if (!activeClip || time <= 0) {
        // 重置为初始 Bind Pose
        for (let i = 0; i < activeBones.length; i++) {
          const init = initialBones[i];
          const bone = activeBones[i];
          if (init && bone) {
            bone.position.set(init.translation[0], init.translation[1], init.translation[2]);
            bone.rotation.set(init.rotation[0], init.rotation[1], init.rotation[2]);
            bone.scale.set(1, 1, 1);
          }
        }
        activeSkeleton.update();
        return;
      }
      // 消费权威动画采样位姿（Havok Spline / De Boor 采样结果）
      const poses = sampleAuthoritativePose(activeClip, time, true);
      if (!poses) return;

      for (let i = 0; i < activeBones.length; i++) {
        const bone = activeBones[i];
        const pose = poses[i];
        if (!bone || !pose) continue;
        bone.position.set(pose.p[0], pose.p[1], pose.p[2]);
        bone.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
        bone.scale.set(pose.s[0], pose.s[1], pose.s[2]);
      }
      activeSkeleton.update();
    },
    setPose: (pose) => {
      if (!activeSkeleton || activeBones.length === 0 || !pose || pose.length === 0) return;
      for (let i = 0; i < activeBones.length && i < pose.length; i++) {
        const transform = pose[i];
        const bone = activeBones[i];
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
          bone.rotation.set(
            transform.rotation[0],
            transform.rotation[1],
            transform.rotation[2]
          );
        }
        if (transform.scale) {
          bone.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
        }
      }
      activeSkeleton.update();
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

  let transformControls: {
    attach(object: Object3D): void;
    detach(): void;
    setMode(mode: 'translate' | 'rotate' | 'scale'): void;
    getHelper?(): Object3D;
    addEventListener(event: string, listener: (event: unknown) => void): void;
    dispose(): void;
    object?: Object3D;
  } | null = null;

  const setSize = (): void => {
    const width = Math.max(input.container.clientWidth, 1);
    const height = Math.max(input.container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const restoreEmissive = (): void => {
    for (const object of meshes.values()) {
      object.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const userData = material.userData as Record<string, unknown>;
          const original = userData._sfOrigEmissive;
          if (typeof original !== 'number') continue;
          (material as unknown as { emissive: { setHex(value: number): void } }).emissive.setHex(original);
          delete userData._sfOrigEmissive;
        }
      });
    }
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
    object.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const emissive = (material as { emissive?: { getHex(): number; setHex(value: number): void } }).emissive;
        if (!emissive) continue;
        const userData = material.userData as Record<string, unknown>;
        if (typeof userData._sfOrigEmissive !== 'number') userData._sfOrigEmissive = emissive.getHex();
        emissive.setHex(HIGHLIGHT_COLOR);
      }
    });
    let firstMesh: Mesh | null = (object as Mesh).isMesh ? object as Mesh : null;
    if (!firstMesh) {
      for (const child of object.children) {
        if ((child as Mesh).isMesh) {
          firstMesh = child as Mesh;
          break;
        }
      }
    }
    if (firstMesh) {
      const overlayMaterial = new three.MeshBasicMaterial({
        color: HIGHLIGHT_COLOR,
        wireframe: true,
        transparent: true,
        opacity: 0.7,
        depthTest: false
      });
      highlightMaterials.add(overlayMaterial);
      resources.push(overlayMaterial);
      const overlay = new three.Mesh(firstMesh.geometry, overlayMaterial);
      overlay.position.copy(firstMesh.position);
      overlay.rotation.copy(firstMesh.rotation);
      overlay.scale.copy(firstMesh.scale);
      highlightGroup.add(overlay);
    }
  };

  const setSelected = (id: string | null, notify = true): void => {
    selectedId = id;
    restoreEmissive();
    clearHighlightObjects();
    if (id) {
      applyHighlight(id);
      const target = meshes.get(id);
      if (target && transformControls) {
        transformControls.attach(target);
      }
    } else {
      transformControls?.detach();
    }
    if (notify) input.onSelect?.(id);
  };

  const setTransformMode = (mode: TransformMode): void => {
    if (transformControls) transformControls.setMode(mode);
  };

  const addMesh = (id: string, object: Object3D): void => {
    object.userData.itemId = id;
    root.add(object);
    meshes.set(id, object);
    if (selectedId === id && transformControls) {
      transformControls.attach(object);
    }
  };

  const clearContent = (): void => {
    transformControls?.detach();
    restoreEmissive();
    clearHighlightObjects();
    for (const object of meshes.values()) root.remove(object);
    meshes.clear();
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

  // 挂载 TransformControls (Gizmo)
  void import('three/examples/jsm/controls/TransformControls.js')
    .then((module) => {
      if (disposed) return;
      const { TransformControls } = module as unknown as {
        TransformControls: new (
          camera: PerspectiveCamera,
          element: HTMLElement
        ) => NonNullable<typeof transformControls>;
      };
      const tc = new TransformControls(camera, canvas as unknown as HTMLElement);
      const helper = tc.getHelper ? tc.getHelper() : (tc as unknown as Object3D);
      scene.add(helper);

      tc.addEventListener('objectChange', () => {
        const target = tc.object;
        if (!target) return;
        const itemId = (target.userData.itemId as string | undefined) ?? selectedId;
        if (!itemId) return;
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
        input.onTransformChange?.({ id: itemId, position: pos, rotation: rot, scale: scl });
      });

      transformControls = tc;
      if (selectedId && meshes.has(selectedId)) {
        tc.attach(meshes.get(selectedId)!);
      }
    })
    .catch(() => undefined);

  // ---- 鼠标右键原地转头与中键平移控制 ----
  const onMouseDown = (event: MouseEvent): void => {
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
        const box = new three.Box3().setFromObject(targetObj);
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
  const onClick = (event: MouseEvent): void => {
    if ((event.button ?? 0) !== 0) return; // 只响应鼠标左键选择
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...meshes.values()], true);
    let id: string | null = null;
    if (hits[0]) {
      id = (hits[0].object.userData.itemId as string | undefined)
        ?? (hits[0].object.parent?.userData.itemId as string | undefined)
        ?? null;
    }
    if (id === selectedId) id = null;
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
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('dblclick', onDblClick);
    canvas.removeEventListener('click', onCanvasClick);
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    transformControls?.dispose();
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
    addMesh,
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

/**
 * S23 去重缓存：同一 FLVER（如 m000010 的地形）被几十个 part 共享，
 * 旧实现每 instance 都 new 一个 BufferGeometry + 解一次 base64，
 * 既占显存也卡解码。现按 positionsBase64 等入参缓存同一 BufferGeometry，
 * 多实例共享 geometry（mesh 仍独立，仅共享顶点缓冲）。
 */
function createProxyMesh(
  three: ThreeModule,
  track: ResourceTracker,
  item: SceneDrawList['items'][number],
  resourcePool?: ModelResourcePool
): Object3D {
  let geometry: BufferGeometry;
  let material: Material;

  if (item.mesh) {
    const key = item.modelName
      ? item.modelName.toLowerCase().replace(/\.mapbnd(\.dcx)?$/i, '')
      : `mesh_${item.id}`;
    if (resourcePool) {
      geometry = resourcePool.getOrCreateGeometry(three, track, key, item.mesh);
      material = resourcePool.getDefaultRealMaterial(three, track);
    } else {
      geometry = track(new three.BufferGeometry());
      geometry.setAttribute(
        'position',
        new three.BufferAttribute(decodeBase64F32(item.mesh.positionsBase64, item.mesh.vertexCount * 3), 3)
      );
      if (item.mesh.indicesBase64) {
        const indexBytes = decodeBase64ToUint8Array(item.mesh.indicesBase64);
        const is32 = item.mesh.indexSize === 32;
        if (is32) {
          const view = new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, Math.floor(indexBytes.length / 4));
          geometry.setIndex(new three.Uint32BufferAttribute(view, 1));
        } else {
          const view = new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, Math.floor(indexBytes.length / 2));
          geometry.setIndex(new three.Uint16BufferAttribute(view, 1));
        }
      }
      if (item.mesh.uvsBase64) {
        geometry.setAttribute('uv', new three.BufferAttribute(decodeBase64F32(item.mesh.uvsBase64, item.mesh.vertexCount * 2), 2));
      }
      if (item.mesh.normalsBase64) {
        geometry.setAttribute('normal', new three.BufferAttribute(decodeBase64F32(item.mesh.normalsBase64, item.mesh.vertexCount * 3), 3));
      } else {
        geometry.computeVertexNormals();
      }
      material = track(new three.MeshStandardMaterial({
        color: new three.Color(0x8e97a3),
        roughness: 0.55,
        metalness: 0.12,
        side: three.DoubleSide,
        wireframe: false
      }));
    }
  } else {
    geometry = resourcePool
      ? resourcePool.getPrimitiveGeometry(three, track, item.primitive === 'sphere' ? 'sphere' : 'box')
      : (item.primitive === 'sphere'
          ? track(new three.SphereGeometry(0.5, 12, 10))
          : track(new three.BoxGeometry(1, 1, 1)));
    material = track(new three.MeshStandardMaterial({
      color: new three.Color(item.colorRgb[0], item.colorRgb[1], item.colorRgb[2]),
      roughness: 0.65,
      metalness: 0.05,
      side: three.FrontSide,
      wireframe: true,
      transparent: true,
      opacity: 0.35
    }));
  }

  const mesh = new three.Mesh(geometry, material);
  mesh.userData.itemId = item.id;
  if (item.modelName) mesh.userData.modelName = item.modelName;
  mesh.position.set(item.position[0], item.position[1], item.position[2]);
  mesh.rotation.set(
    (item.rotation[0] * Math.PI) / 180,
    (item.rotation[1] * Math.PI) / 180,
    (item.rotation[2] * Math.PI) / 180
  );
  mesh.scale.set(item.scale[0], item.scale[1], item.scale[2]);
  return mesh;
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

  if (skeleton) {
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
  const bones = semantic.bones ?? [];
  if (bones.length > 0) {
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
        'XYZ'
      ));
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
