/**
 * Headless functional smoke for the Three scene projection layer
 * (threeSceneController.ts).
 *
 * Proves, without any real GPU / DOM / game assets:
 *   1. Backend selection — WebGPU-first with WebGL2 fallback (resolveRendererBackend).
 *   2. Proxy scene natural fallback: in Node navigator has no `gpu`, so the mount
 *      must select WebGL2 on its own (rendererFactory only replaces the renderer
 *      implementation, never the backend decision).
 *   3. Picking 视觉反馈 — raycaster click returns the part id, repeated clicks keep
 *      selection stable for Gizmo editing, and overlay highlighting does not mutate shared material.
 *   4. FLVER scene — real mesh + rgba texture + dummy markers projected from a
 *      renderer-independent semantic scene; diagnostic bone markers stay off by default.
 *   5. Skinning bind pose — non-origin bind transforms capture inverse bind matrices,
 *      retain skin attributes, and the Three.js skinning contract preserves/restores
 *      vertices across a pose change.
 *   6. Resource release — repeated mount/dispose leaves zero leaks; replaced scenes
 *      release their old resources; content-build failure (SCENE_ABSOLUTE_PATH_LEAK)
 *      disposes the whole mount instead of leaking.
 *
 * Deterministic seams used: `rendererBackend`, `rendererFactory`, `resourceAudit`.
 */
import * as three from 'three';
import {
  mountFlverScene,
  mountThreeProxyScene,
  resolveRendererBackend,
  type FlverSemanticScene,
  type RendererBackend,
  type ThreeRendererLike
} from './threeSceneController.js';
import type { SceneDrawList } from './sceneManifestBrowser.js';

// ---------------------------------------------------------------------------
// Tiny assertion helpers
// ---------------------------------------------------------------------------
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE_FAIL: ${message}`);
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`SMOKE_FAIL: ${message} (actual=${String(actual)} expected=${String(expected)})`);
  }
}
function resourceName(resource: { dispose(): void }): string {
  return (resource as { constructor?: { name?: string } }).constructor?.name ?? 'resource';
}

// ---------------------------------------------------------------------------
// DOM stubs (headless Node)
// ---------------------------------------------------------------------------
type UnknownHandler = (...args: unknown[]) => void;

interface DocumentLike {
  createElement(tag: string): FakeElement;
  addEventListener(type: string, handler: UnknownHandler, options?: unknown): void;
  removeEventListener(type: string, handler: UnknownHandler, options?: unknown): void;
}

const docHandlers = new Map<string, Set<UnknownHandler>>();
const windowHandlers = new Map<string, Set<UnknownHandler>>();

function addHandler(map: Map<string, Set<UnknownHandler>>, type: string, handler: UnknownHandler): void {
  let set = map.get(type);
  if (!set) {
    set = new Set<UnknownHandler>();
    map.set(type, set);
  }
  set.add(handler);
}
function removeHandler(map: Map<string, Set<UnknownHandler>>, type: string, handler: UnknownHandler): void {
  map.get(type)?.delete(handler);
}

let lastCreatedCanvas: FakeElement | null = null;

const fakeDocument: DocumentLike = {
  createElement(tag: string): FakeElement {
    const element = new FakeElement();
    if (tag === 'canvas') lastCreatedCanvas = element;
    return element;
  },
  addEventListener(type, handler, options): void {
    void options;
    addHandler(docHandlers, type, handler);
  },
  removeEventListener(type, handler, options): void {
    void options;
    removeHandler(docHandlers, type, handler);
  }
};

// Headless: 让 mountSceneCore 里的 document.createElement('canvas') 落到 fake DOM。
globalThis.document = fakeDocument as unknown as Document;

class FakeElement {
  style: Record<string, string> = {};
  clientWidth = 800;
  clientHeight = 600;
  private readonly handlers = new Map<string, Set<UnknownHandler>>();

  addEventListener(type: string, handler: UnknownHandler, options?: unknown): void {
    void options;
    addHandler(this.handlers, type, handler);
  }
  removeEventListener(type: string, handler: UnknownHandler, options?: unknown): void {
    void options;
    removeHandler(this.handlers, type, handler);
  }
  dispatch(type: string, event: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(event);
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  getRootNode(): DocumentLike {
    return fakeDocument;
  }
  focus(): void {
    /* no-op: headless */
  }
  tabIndex = 0;
  replaceChildren(): void {
    /* no-op: headless */
  }
  remove(): void {
    /* no-op: headless */
  }
}

const rafCallbacks = new Map<number, FrameRequestCallback>();
let rafSeq = 0;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
  const id = ++rafSeq;
  rafCallbacks.set(id, callback);
  return id;
}) as typeof globalThis.requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number): void => {
  rafCallbacks.delete(id);
}) as typeof globalThis.cancelAnimationFrame;

globalThis.window = {
  devicePixelRatio: 1,
  addEventListener: (type: string, handler: UnknownHandler): void => addHandler(windowHandlers, type, handler),
  removeEventListener: (type: string, handler: UnknownHandler): void => removeHandler(windowHandlers, type, handler)
} as unknown as Window & typeof globalThis;

const domGlobals = globalThis as unknown as Record<string, unknown>;
domGlobals.HTMLElement = FakeElement;
domGlobals.HTMLInputElement = class FakeInputElement extends FakeElement {};
domGlobals.HTMLTextAreaElement = class FakeTextAreaElement extends FakeElement {};

function dispatchWindow(type: string, event: unknown): void {
  for (const handler of [...(windowHandlers.get(type) ?? [])]) handler(event);
}

let frameNow = performance.now();
function pumpFrames(count: number): void {
  for (let index = 0; index < count; index++) {
    const next = [...rafCallbacks.entries()][0];
    if (!next) break;
    const [id, callback] = next;
    rafCallbacks.delete(id);
    frameNow += 16;
    callback(frameNow);
  }
}

// ---------------------------------------------------------------------------
// Dispose counting (geometry / material / texture)
// ---------------------------------------------------------------------------
const disposedSet = new Set<object>();
let totalDisposeCalls = 0;

function installDisposeCounter(): void {
  const patch = (proto: object): void => {
    const target = proto as { dispose: () => void };
    const original = target.dispose as (this: object) => void;
    target.dispose = function (this: object): void {
      disposedSet.add(this);
      totalDisposeCalls += 1;
      original.call(this);
    } as () => void;
  };
  patch(three.BufferGeometry.prototype);
  patch(three.Material.prototype);
  patch(three.Texture.prototype);
  patch(three.Skeleton.prototype);
}

// ---------------------------------------------------------------------------
// Headless fake renderer
// ---------------------------------------------------------------------------
class FakeRenderer implements ThreeRendererLike {
  readonly calls: string[] = [];
  disposed = false;
  setPixelRatio(): void {
    this.calls.push('setPixelRatio');
  }
  setSize(): void {
    this.calls.push('setSize');
  }
  render(): void {
    this.calls.push('render');
  }
  dispose(): void {
    this.disposed = true;
    this.calls.push('dispose');
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function buildProxyDrawList(): SceneDrawList {
  return {
    sourceUri: 'sf://ws/maps/m000',
    sourcePath: 'maps/m000/m000.msb',
    game: 'sekiro',
    resourceKind: 'map',
    revision: 'smoke-rev',
    schemaVersion: 2,
    mapResourceUri: 'sf://ws/maps/m000',
    authority: 'partial',
    packetId: 'smoke-packet',
    chunkIndex: 0,
    chunkCount: 1,
    totalItemCount: 1,
    itemCount: 1,
    items: [
      {
        id: 'part-000',
        label: 'c0000',
        entityKind: 'msb-part',
        primitive: 'box',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        sourceResourceUri: 'sf://ws/maps/m000/model/c0000.flver',
        colorRgb: [0.9, 0.4, 0.2]
      }
    ],
    bounds: { min: [-5, -5, -5], max: [5, 5, 5], center: [0, 0, 0] },
    diagnostics: []
  };
}

function buildModelReplacementDrawList(): SceneDrawList {
  const base = buildProxyDrawList();
  const first = base.items[0]!;
  const second = {
    ...first,
    id: 'part-001',
    position: [2, 0, 0] as [number, number, number],
    modelName: 'M000010.FLVER'
  };
  base.items = [
    { ...first, modelName: 'm000010.mapbnd.dcx' },
    second
  ];
  base.totalItemCount = 2;
  base.itemCount = 2;
  base.bounds = { min: [-5, -5, -5], max: [5, 5, 5], center: [0, 0, 0] };
  return base;
}

function buildFlverScene(): FlverSemanticScene {
  return {
    meshes: [
      {
        id: 'mesh-0',
        label: 'mesh[0]',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        indices: new Uint16Array([0, 1, 2]),
        skinIndices: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        skinWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        vertexCount: 3,
        wireframeOverlay: true,
        texture: { kind: 'rgba', width: 4, height: 4, rgbaBytes: new Uint8Array(64).fill(128) }
      }
    ],
    bones: [{ id: 'bone-0', name: 'root', parentIndex: -1, translation: [1, 0, 0], rotation: [0, 0, 0] }],
    dummies: [{ id: 'dummy-0', referenceId: 100, position: [0, 0, 0] }],
    bounds: { min: [0, 0, 0], max: [1, 1, 0], center: [0.5, 0.5, 0] }
  };
}

function testSkinningBindPose(record: (name: string) => void): void {
  const root = new three.Group();
  const bone = new three.Bone();
  bone.position.set(1, 0, 0);
  root.add(bone);
  root.updateMatrixWorld(true);

  const skeleton = new three.Skeleton([bone]);
  const geometry = new three.BufferGeometry();
  geometry.setAttribute('position', new three.Float32BufferAttribute([0, 0, 0], 3));
  geometry.setAttribute('skinIndex', new three.Uint16BufferAttribute([0, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new three.Float32BufferAttribute([1, 0, 0, 0], 4));
  const mesh = new three.SkinnedMesh(geometry, new three.MeshBasicMaterial());
  mesh.bind(skeleton);

  const bindPose = new three.Vector3(0, 0, 0);
  mesh.applyBoneTransform(0, bindPose);
  assert(bindPose.distanceTo(new three.Vector3(0, 0, 0)) < 1e-6, '非原点 bind pose 顶点保持原位');
  assert(Math.abs(skeleton.boneInverses[0]!.elements[12] + 1) < 1e-6, 'inverse bind 捕获真实骨骼 world matrix');

  bone.position.set(2, 0, 0);
  root.updateMatrixWorld(true);
  skeleton.update();
  const posed = new three.Vector3(0, 0, 0);
  mesh.applyBoneTransform(0, posed);
  assert(Math.abs(posed.x - 1) < 1e-6, '骨骼位移驱动 skin vertex');

  bone.position.set(1, 0, 0);
  root.updateMatrixWorld(true);
  skeleton.update();
  const restored = new three.Vector3(0, 0, 0);
  mesh.applyBoneTransform(0, restored);
  assert(restored.distanceTo(new three.Vector3(0, 0, 0)) < 1e-6, '恢复 bind pose 后顶点回到原位');

  geometry.dispose();
  mesh.material.dispose();
  skeleton.dispose();
  record('skinning-bind-pose-invariant');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function testBackendResolution(record: (name: string) => void): Promise<void> {
  assertEqual(resolveRendererBackend(undefined, false), 'webgl2', 'WebGPU 不可用 → WebGL2 回退');
  assertEqual(resolveRendererBackend(undefined, true), 'webgpu', 'WebGPU 可用 → WebGPU 优先');
  assertEqual(resolveRendererBackend('webgl2', true), 'webgl2', '显式覆盖优先于能力探测');
  assertEqual(resolveRendererBackend('webgpu', false), 'webgpu', '显式 WebGPU 覆盖不受能力探测影响');
  record('backend-resolution');
}

async function testProxyScene(record: (name: string) => void): Promise<void> {
  const baselineDispose = totalDisposeCalls;
  const drawList = buildProxyDrawList();
  const rendererState: { renderer: FakeRenderer | null } = { renderer: null };
  let audit: Array<{ dispose(): void }> = [];
  const selections: Array<string | null> = [];
  const container = new FakeElement();
  let mountedCamera: three.PerspectiveCamera | null = null;

  const handle = await mountThreeProxyScene({
    container: container as unknown as HTMLElement,
    drawList,
    onSelect: (id) => {
      selections.push(id);
    },
    rendererFactory: (canvas) => {
      void canvas;
      const fake = new FakeRenderer();
      rendererState.renderer = fake;
      return fake;
    },
    resourceAudit: (resources) => {
      audit = [...resources];
    },
    cameraAudit: (camera) => {
      mountedCamera = camera;
    }
  });

  // 自然回退：Node 的 navigator 无 `gpu` → mount 自行选择 WebGL2。
  const expectedFallback: RendererBackend =
    typeof navigator !== 'undefined' && 'gpu' in (navigator as object) ? 'webgpu' : 'webgl2';
  assertEqual(handle.rendererBackend, expectedFallback, 'Node 无 WebGPU → 自然回退到 WebGL2');
  const createdRenderer = rendererState.renderer;
  assert(createdRenderer !== null, '代理场景通过 rendererFactory 创建渲染器（无 GPU 依赖）');

  assertEqual(audit.length, 2, '代理内容资源 = geometry + material');
  const boxMaterial = audit.find((r) => r instanceof three.MeshStandardMaterial) as three.MeshStandardMaterial | undefined;
  assert(boxMaterial !== undefined, '代理内容包含 MeshStandardMaterial（可做 emissive 高亮）');

  // 模拟点击 box 中心：复刻控制器 frameToBounds 的相机定位，投影 box 中心到 NDC。
  const camera = new three.PerspectiveCamera(55, 800 / 600, 0.1, 50_000);
  camera.position.set(16, 12, 16);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const ndc = new three.Vector3(0, 0, 0).project(camera);
  const rect = container.getBoundingClientRect();
  const clientX = rect.left + ((ndc.x + 1) / 2) * rect.width;
  const clientY = rect.top + ((1 - ndc.y) / 2) * rect.height;

  assert(lastCreatedCanvas !== null, 'mount 已创建 canvas');
  lastCreatedCanvas.dispatch('click', { clientX, clientY });

  assertEqual(selections.length, 1, '点击发射 onSelect');
  assertEqual(selections[0] ?? null, 'part-000', 'onSelect 返回 part id');
  assertEqual(handle.selectedId, 'part-000', 'selectedId 与选中项同步');
  assertEqual(boxMaterial.emissive.getHex(), 0x000000, 'overlay 高亮不污染共享基础材质');

  // 再次点击同一项保持选中，避免 Gizmo 编辑期间选择抖动。
  lastCreatedCanvas.dispatch('click', { clientX, clientY });
  assertEqual(handle.selectedId, 'part-000', '再次点击同一项保持稳定选择');
  assertEqual(boxMaterial.emissive.getHex(), 0x000000, '重复选择不污染共享基础材质');

  // 渲染循环驱动 fake renderer（headless）。
  pumpFrames(2);
  assert((createdRenderer.calls.filter((c) => c === 'render').length) >= 2, '渲染循环驱动 fake renderer');
  assert(createdRenderer.calls.includes('setSize'), 'setSize 已按容器尺寸调用');
  assert(createdRenderer.calls.includes('setPixelRatio'), 'setPixelRatio 已调用');

  // Shift + WASD 使用同一方向与帧时间，只把位移倍率提升到 3.5x。
  assert(mountedCamera !== null, '测试 seam 捕获真实 controller camera');
  const activeCamera = mountedCamera as three.PerspectiveCamera;
  const keyboardEvent = (key: string, shiftKey: boolean): KeyboardEvent => ({
    key,
    shiftKey,
    target: lastCreatedCanvas,
    preventDefault(): void {}
  } as unknown as KeyboardEvent);
  const normalStart = activeCamera.position.clone();
  dispatchWindow('keydown', keyboardEvent('w', false));
  pumpFrames(5);
  dispatchWindow('keyup', keyboardEvent('w', false));
  const normalDistance = activeCamera.position.distanceTo(normalStart);
  const acceleratedStart = activeCamera.position.clone();
  dispatchWindow('keydown', keyboardEvent('Shift', true));
  dispatchWindow('keydown', keyboardEvent('w', true));
  pumpFrames(5);
  dispatchWindow('keyup', keyboardEvent('w', true));
  dispatchWindow('keyup', keyboardEvent('Shift', false));
  const acceleratedDistance = activeCamera.position.distanceTo(acceleratedStart);
  assert(normalDistance > 0, 'W 连续漫游产生位移');
  assert(Math.abs(acceleratedDistance / normalDistance - 3.5) < 1e-6, 'Shift+W 位移严格为普通 W 的 3.5x');

  // 全量释放：内容 + 高亮 overlay + 静态资源（grid/axes geometry）全部 dispose。
  handle.dispose();
  assert(createdRenderer.disposed, 'renderer.dispose 被调用');
  for (const resource of audit) {
    assert(disposedSet.has(resource), `代理内容已释放：${resourceName(resource)}`);
  }
  // 内容(2) + 高亮 overlay(1) + 静态(2) = 5。
  assertEqual(totalDisposeCalls - baselineDispose, 5, '释放计数=内容+overlay+静态资源，无泄漏');

  record('proxy-natural-webgl2-fallback');
  record('proxy-picking-highlight');
  record('proxy-resource-release');
  record('proxy-shift-wasd-acceleration');
}

async function testProxyModelReplacement(record: (name: string) => void): Promise<void> {
  const audits: Array<{ phase: string; items: Array<{ id: string; state: string }> }> = [];
  const handle = await mountThreeProxyScene({
    container: new FakeElement() as unknown as HTMLElement,
    drawList: buildModelReplacementDrawList(),
    rendererFactory: () => new FakeRenderer(),
    renderAudit: (phase, items) => {
      audits.push({ phase, items: items.map((item) => ({ id: item.id, state: item.state })) });
    }
  });

  const positionsBase64 = Buffer.from(new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0
  ]).buffer).toString('base64');
  const indicesBase64 = Buffer.from(new Uint16Array([0, 1, 2]).buffer).toString('base64');
  const replaced = handle.updateModelGeometry?.('map/m000010.FLVER', {
    positionsBase64,
    indicesBase64,
    indexSize: 16,
    vertexCount: 3
  }) ?? 0;
  assertEqual(replaced, 2, 'canonical modelName 命中同一 instance batch 的两个 placement');
  const ready = audits.filter((entry) => entry.phase === 'mesh-ready').at(-1);
  assert(ready !== undefined, 'model geometry replacement 发出 mesh-ready audit');
  assert(ready.items.every((item) => item.state === 'mesh'), 'replacement 后所有 placement 都是 mesh，不再是 proxy');

  handle.dispose();
  record('proxy-model-batch-replacement');
}

async function testFlverScene(record: (name: string) => void): Promise<void> {
  const scene = buildFlverScene();
  let audit1: Array<{ dispose(): void }> = [];
  let audit2: Array<{ dispose(): void }> = [];
  const rendererState: { renderer: FakeRenderer | null } = { renderer: null };
  const container = new FakeElement();

  const handle = await mountFlverScene({
    container: container as unknown as HTMLElement,
    scene,
    rendererBackend: 'webgpu',
    rendererFactory: (canvas) => {
      void canvas;
      const fake = new FakeRenderer();
      rendererState.renderer = fake;
      return fake;
    },
    resourceAudit: (resources) => {
      if (audit1.length === 0) audit1 = [...resources];
      else audit2 = [...resources];
    }
  });

  assertEqual(handle.rendererBackend, 'webgpu', 'FLVER 场景 WebGPU 覆盖路径生效');
  const createdRenderer = rendererState.renderer;
  assert(createdRenderer !== null, 'WebGPU 覆盖下仍通过 rendererFactory 注入（无 GPU 依赖）');

  // 语义场景是渲染器无关纯 typed data：可 JSON 序列化，不含 THREE 对象。
  const serialized = JSON.stringify(scene);
  assert(serialized.length > 0, 'FLVER 语义场景可序列化（renderer-independent）');

  // 真实 FLVER 网格 + RGBA 纹理被投影。
  const geometry = audit1.find((r) => r instanceof three.BufferGeometry) as three.BufferGeometry | undefined;
  assert(geometry !== undefined, 'FLVER 网格投影为 BufferGeometry');
  const positionAttribute = geometry.attributes.position;
  assert(positionAttribute !== undefined, '位置缓冲已设置');
  assertEqual(positionAttribute.count, 3, '位置缓冲保留真实顶点数');
  assert(geometry.index !== null, '索引缓冲已设置');
  const texture = audit1.find((r) => r instanceof three.DataTexture) as three.DataTexture | undefined;
  assert(texture !== undefined, 'RGBA 纹理投影为 DataTexture');
  assertEqual(texture.image.width, 4, '纹理宽度保持 4');
  assert(!audit1.some((r) => r instanceof three.SphereGeometry), '默认预览不创建黄色骨骼诊断 marker');
  assert(audit1.some((r) => r instanceof three.OctahedronGeometry), '挂点投影为 OctahedronGeometry');

  // 渲染循环驱动。
  pumpFrames(2);
  assert((createdRenderer.calls.filter((c) => c === 'render').length) >= 2, 'FLVER 渲染循环驱动');

  // 内容替换：旧资源必须全部释放。
  handle.setScene(buildFlverScene());
  for (const resource of audit1) {
    assert(disposedSet.has(resource), `替换场景释放旧内容：${resourceName(resource)}`);
  }
  assert(audit2.length > 0, '替换后再次发射资源审计');

  // 最终释放。
  handle.dispose();
  for (const resource of audit2) {
    assert(disposedSet.has(resource), `最终释放全部内容：${resourceName(resource)}`);
  }
  assert(texture !== undefined && disposedSet.has(texture), 'DataTexture 已释放');

  record('flver-webgpu-override');
  record('flver-real-mesh-texture');
  record('flver-scene-replace-release');
}

async function testMultiSkeletonPoseBatch(record: (name: string) => void): Promise<void> {
  const triangle = (id: string, skeletonId: string, x: number): FlverSemanticScene['meshes'][number] => ({
    id,
    label: id,
    position: [x, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
    skinIndices: new Uint16Array(12),
    skinWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    skeletonId,
    skinningMode: 'weighted',
    boneIndexSpace: 'flver-global',
    vertexCount: 3
  });
  const scene: FlverSemanticScene = {
    meshes: [triangle('mesh-a', 'model-a', 0), triangle('mesh-b', 'model-b', 2)],
    skeletons: [
      { id: 'model-a', bones: [{ id: 'a-root', name: 'a-root', parentIndex: -1, translation: [0, 0, 0], rotation: [0, 0, 0] }] },
      { id: 'model-b', bones: [{ id: 'b-root', name: 'b-root', parentIndex: -1, translation: [0, 0, 0], rotation: [0, 0, 0] }] }
    ],
    bounds: { min: [0, 0, 0], max: [3, 1, 0], center: [1.5, 0.5, 0] }
  };
  let audit: Array<{ dispose(): void }> = [];
  const handle = await mountFlverScene({
    container: new FakeElement() as unknown as HTMLElement,
    scene,
    rendererFactory: () => new FakeRenderer(),
    resourceAudit: (resources) => {
      audit = [...resources];
    }
  });
  const skeletons = audit.filter((resource): resource is three.Skeleton => resource instanceof three.Skeleton);
  assertEqual(skeletons.length, 2, '两个 FLVER 保持独立 skeleton namespace');

  const groupPrototype = three.Group.prototype as three.Group & {
    updateMatrixWorld(force?: boolean): void;
  };
  const originalUpdate = groupPrototype.updateMatrixWorld;
  let groupUpdates = 0;
  groupPrototype.updateMatrixWorld = function (force?: boolean): void {
    groupUpdates += 1;
    originalUpdate.call(this, force);
  };
  try {
    handle.setSkeletonPoses?.({
      'model-a': [{ translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
      'model-b': [{ translation: [4, 5, 6], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }]
    });
  } finally {
    groupPrototype.updateMatrixWorld = originalUpdate;
  }
  const byName = new Map(skeletons.map((skeleton) => [skeleton.bones[0]?.name, skeleton.bones[0]]));
  assertEqual(byName.get('a-root')?.position.x, 1, 'model-a pose 已应用');
  assertEqual(byName.get('b-root')?.position.x, 4, 'model-b pose 已应用');
  assertEqual(groupUpdates, 1, '多骨架一帧只传播一次 scene root matrix');
  handle.dispose();
  record('flver-multi-skeleton-pose-batch');
}

async function testRepeatedMountUnmount(record: (name: string) => void): Promise<void> {
  let totalTracked = 0;
  for (let cycle = 0; cycle < 5; cycle++) {
    const tracked: Array<{ dispose(): void }> = [];
    const handle = await mountFlverScene({
      container: new FakeElement() as unknown as HTMLElement,
      scene: buildFlverScene(),
      rendererBackend: cycle % 2 === 0 ? 'webgl2' : 'webgpu',
      rendererFactory: (canvas) => {
        void canvas;
        return new FakeRenderer();
      },
      resourceAudit: (resources) => {
        tracked.push(...resources);
      }
    });
    assert(handle.canvas !== null, `cycle ${cycle} 创建 canvas`);
    handle.dispose();
    totalTracked += tracked.length;
    for (const resource of tracked) {
      assert(disposedSet.has(resource), `cycle ${cycle} 内容已释放：${resourceName(resource)}`);
    }
  }
  assert(totalTracked > 0, '多次挂载追踪到内容资源');
  record('repeated-mount-unmount-no-leak');
}

async function testAbsolutePathLeakRejected(record: (name: string) => void): Promise<void> {
  const leaky = buildProxyDrawList();
  leaky.items = [{ ...(leaky.items[0] as SceneDrawList['items'][number]), sourceResourceUri: 'C:\\Users\\smoke\\fake.flver' }];
  let rejected = false;
  try {
    await mountThreeProxyScene({
      container: new FakeElement() as unknown as HTMLElement,
      drawList: leaky,
      rendererFactory: (canvas) => {
        void canvas;
        return new FakeRenderer();
      }
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === 'SCENE_ABSOLUTE_PATH_LEAK';
  }
  assert(rejected, '绝对路径泄漏被拒（负向用例）');
  assertEqual(rafCallbacks.size, 0, '内容构建失败后 rAF 循环已释放（无泄漏）');
  record('absolute-path-leak-rejected');
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  installDisposeCounter();

  const cases: string[] = [];
  const record = (name: string): void => {
    cases.push(name);
  };

  await testBackendResolution(record);
  await testProxyScene(record);
  await testProxyModelReplacement(record);
  await testFlverScene(record);
  await testMultiSkeletonPoseBatch(record);
  testSkinningBindPose(record);
  await testRepeatedMountUnmount(record);
  await testAbsolutePathLeakRejected(record);

  console.log(
    JSON.stringify(
      {
        ok: true,
        message: 'Three 场景投影层功能 smoke 通过（无 GPU / 无真实资产）',
        cases,
        backendContract: 'WebGPU-first / WebGL2 fallback',
        headless: true,
        filesystemAccess: false
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
