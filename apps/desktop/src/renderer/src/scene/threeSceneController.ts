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

export type RendererBackend = 'webgpu' | 'webgl2';

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
}

export interface ProxySceneHandle extends ThreeSceneHandle {
  setDrawList: (list: SceneDrawList) => void;
  /** 用真实 FLVER 网格替换某个 proxy 盒子；找不到 id 则忽略。 */
  replaceItemMesh: (id: string, mesh: FlverSceneMesh) => void;
}

export interface FlverSceneHandle extends ThreeSceneHandle {
  setScene: (scene: FlverSemanticScene) => void;
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
  vertexColors?: Float32Array;
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

/**
 * Mount a WebGPU-first proxy scene with WebGL2 fallback.
 * Selection callback receives draw-item id (part URI fragment), never paths.
 */
export async function mountThreeProxyScene(input: {
  container: HTMLElement;
  drawList: SceneDrawList;
  onSelect?: (itemId: string | null) => void;
  rendererBackend?: RendererBackend;
  rendererFactory?: (canvas: HTMLCanvasElement) => ThreeRendererLike;
  resourceAudit?: (resources: ReadonlyArray<{ dispose(): void }>) => void;
}): Promise<ProxySceneHandle> {
  const core = await mountSceneCore(input);

  const setDrawList = (list: SceneDrawList): void => {
    try {
      assertNoAbsolutePathLeak(list);
      core.clearContent();
      for (const item of list.items) {
        core.addMesh(item.id, createProxyMesh(core.three, core.track, item));
      }
      core.frameToBounds(list.bounds);
      core.setSelected(null, false);
      input.resourceAudit?.([...core.resources]);
    } catch (error) {
      // 内容构建失败（如 SCENE_ABSOLUTE_PATH_LEAK）也必须释放整个挂载：
      // rAF 循环、事件监听、renderer 与静态资源，杜绝错误路径泄漏。
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
    setDrawList,
    replaceItemMesh: (id, mesh) => {
      const previous = core.meshes.get(id);
      if (previous) {
        core.root.remove(previous);
        core.meshes.delete(id);
      }
      core.addMesh(id, createFlverMesh(core.three, core.track, mesh));
    },
    dispose: core.disposeAll
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

  const setScene = (semantic: FlverSemanticScene): void => {
    try {
      core.clearContent();
      for (const item of semantic.meshes) {
        core.addMesh(item.id, createFlverMesh(core.three, core.track, item));
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

  return {
    canvas: core.canvas,
    rendererBackend: core.rendererBackend,
    get selectedId() {
      return core.selectedId;
    },
    setSelected: (id) => core.setSelected(id),
    setScene,
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
  let controls: { update(): void; dispose(): void } | null = null;

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
    if (id) applyHighlight(id);
    if (notify) input.onSelect?.(id);
  };

  const addMesh = (id: string, object: Object3D): void => {
    object.userData.itemId = id;
    root.add(object);
    meshes.set(id, object);
  };

  const clearContent = (): void => {
    restoreEmissive();
    clearHighlightObjects();
    for (const object of meshes.values()) root.remove(object);
    meshes.clear();
    for (const object of markerGroup.children.slice()) markerGroup.remove(object);
    for (const resource of resources) resource.dispose();
    resources.length = 0;
  };

  const frameToBounds = (bounds: FlverSceneBounds): void => {
    const [cx, cy, cz] = bounds.center;
    const span = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
      20
    );
    camera.position.set(cx + span * 0.8, cy + span * 0.6, cz + span * 0.8);
    camera.lookAt(cx, cy, cz);
  };

  // Orbit controls for rotate/zoom/pan.
  void import('three/examples/jsm/controls/OrbitControls.js')
    .then((module) => {
      if (disposed) return;
      const { OrbitControls } = module as unknown as {
        OrbitControls: new (
          camera: PerspectiveCamera,
          element: HTMLElement
        ) => { enableDamping: boolean; dampingFactor: number; update(): void; dispose(): void };
      };
      const orbit = new OrbitControls(camera, canvas as unknown as HTMLElement);
      orbit.enableDamping = true;
      orbit.dampingFactor = 0.08;
      controls = orbit;
    })
    .catch(() => undefined);

  const raycaster = new three.Raycaster();
  const pointer = new three.Vector2();
  const onClick = (event: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...meshes.values()], true);
    let id: string | null = null;
    if (hits[0]) {
      id = (hits[0].object.userData.itemId as string | undefined)
        ?? (hits[0].object.parent?.userData.itemId as string | undefined)
        ?? null;
    }
    if (id === selectedId) id = null; // 再次点击同一项取消选中。
    setSelected(id);
  };
  canvas.addEventListener('click', onClick);

  const onResize = (): void => setSize();
  window.addEventListener('resize', onResize);
  setSize();

  const tick = (): void => {
    if (disposed) return;
    controls?.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  tick();

  const disposeAll = (): void => {
    disposed = true;
    cancelAnimationFrame(raf);
    canvas.removeEventListener('click', onClick);
    if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
    controls?.dispose();
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

function createProxyMesh(three: ThreeModule, track: ResourceTracker, item: SceneDrawList['items'][number]): Object3D {
  const geometry: BoxGeometry | SphereGeometry = item.primitive === 'sphere'
    ? track(new three.SphereGeometry(0.5, 12, 10))
    : track(new three.BoxGeometry(1, 1, 1));
  const material = track(new three.MeshStandardMaterial({
    color: new three.Color(item.colorRgb[0], item.colorRgb[1], item.colorRgb[2]),
    roughness: 0.65,
    metalness: 0.05
  }));
  const mesh = new three.Mesh(geometry, material);
  mesh.position.set(item.position[0], item.position[1], item.position[2]);
  mesh.rotation.set(
    (item.rotation[0] * Math.PI) / 180,
    (item.rotation[1] * Math.PI) / 180,
    (item.rotation[2] * Math.PI) / 180
  );
  mesh.scale.set(item.scale[0], item.scale[1], item.scale[2]);
  return mesh;
}

function createFlverMesh(three: ThreeModule, track: ResourceTracker, item: FlverSceneMesh): Object3D {
  const geometry = track(new three.BufferGeometry());
  geometry.setAttribute('position', new three.BufferAttribute(item.positions, 3));
  if (item.uvs) geometry.setAttribute('uv', new three.BufferAttribute(item.uvs, 2));
  if (item.normals) geometry.setAttribute('normal', new three.BufferAttribute(item.normals, 3));
  else geometry.computeVertexNormals(); // 真实法线存在时绝不覆盖（无损性）。
  if (item.indices) geometry.setIndex(new three.BufferAttribute(item.indices, 1));
  if (item.vertexColors) geometry.setAttribute('color', new three.BufferAttribute(item.vertexColors, 3));

  const texture = item.texture ? createTexture(three, track, item.texture) : null;
  const meshIndex = Number.parseInt(item.id.replace(/\D+/g, '').slice(-3) || '0', 10) || 0;
  const hue = (meshIndex * 137.508) % 360;
  const material = track(new three.MeshStandardMaterial({
    color: texture ? 0xffffff : new three.Color().setHSL(hue / 360, 0.5, 0.55),
    ...(texture ? { map: texture } : {}),
    wireframe: false,
    side: three.DoubleSide,
    flatShading: !texture,
    vertexColors: Boolean(item.vertexColors)
  }));
  const mesh = new three.Mesh(geometry, material);
  mesh.position.set(item.position[0], item.position[1], item.position[2]);
  mesh.rotation.set(
    (item.rotation[0] * Math.PI) / 180,
    (item.rotation[1] * Math.PI) / 180,
    (item.rotation[2] * Math.PI) / 180
  );
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
