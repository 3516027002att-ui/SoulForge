/**
 * Three.js scene controller for MSB proxy visualization.
 * Consumes SceneDrawList only — never absolute filesystem paths.
 */

import type { SceneDrawList, SceneDrawItem } from './sceneManifestBrowser.js';

export interface ThreeSceneHandle {
  canvas: HTMLCanvasElement;
  dispose: () => void;
  setDrawList: (list: SceneDrawList) => void;
  selectedId: string | null;
}

import type {
  BoxGeometry,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  WebGLRenderer
} from 'three';

type ThreeModule = typeof import('three');

/**
 * Mount a WebGL2 proxy scene. Throws if WebGL2 unavailable.
 * Selection callback receives draw-item id (part URI fragment), never paths.
 */
export async function mountThreeProxyScene(input: {
  container: HTMLElement;
  drawList: SceneDrawList;
  onSelect?: (itemId: string | null) => void;
}): Promise<ThreeSceneHandle> {
  const three: ThreeModule = await import('three');
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  input.container.replaceChildren(canvas);

  const renderer: WebGLRenderer = new three.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new three.Scene();
  scene.background = new three.Color(0x1a1d23);

  const camera = new three.PerspectiveCamera(55, 1, 0.1, 50_000);
  const root = new three.Group();
  scene.add(root);
  scene.add(new three.AmbientLight(0xffffff, 0.55));
  const key = new three.DirectionalLight(0xffffff, 0.85);
  key.position.set(40, 80, 20);
  scene.add(key);
  scene.add(new three.GridHelper(200, 20, 0x3a4150, 0x2a303c));
  scene.add(new three.AxesHelper(10));

  const meshes = new Map<string, Object3D>();
  let selectedId: string | null = null;
  let raf = 0;
  let disposed = false;

  const setSize = (): void => {
    const width = Math.max(input.container.clientWidth, 1);
    const height = Math.max(input.container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const clearMeshes = (): void => {
    for (const object of meshes.values()) {
      root.remove(object);
      object.traverse((child: Object3D) => {
        const mesh = child as Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material as Material | Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose?.();
      });
    }
    meshes.clear();
  };

  const setDrawList = (list: SceneDrawList): void => {
    // Guard path leakage at render boundary.
    const serialized = JSON.stringify(list);
    if (/[A-Za-z]:\\/.test(serialized) || serialized.includes('/Users/')) {
      throw new Error('SCENE_ABSOLUTE_PATH_LEAK');
    }
    clearMeshes();
    for (const item of list.items) {
      const object = createProxyMesh(three, item);
      object.userData.itemId = item.id;
      root.add(object);
      meshes.set(item.id, object);
    }
    const [cx, cy, cz] = list.bounds.center;
    const span = Math.max(
      list.bounds.max[0] - list.bounds.min[0],
      list.bounds.max[1] - list.bounds.min[1],
      list.bounds.max[2] - list.bounds.min[2],
      20
    );
    camera.position.set(cx + span * 0.8, cy + span * 0.6, cz + span * 0.8);
    camera.lookAt(cx, cy, cz);
  };

  const raycaster = new three.Raycaster();
  const pointer = new three.Vector2();
  const onClick = (event: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...meshes.values()], true);
    const id = hits[0]?.object.userData.itemId as string | undefined
      ?? hits[0]?.object.parent?.userData.itemId as string | undefined
      ?? null;
    selectedId = id;
    input.onSelect?.(id);
  };
  canvas.addEventListener('click', onClick);

  const onResize = (): void => setSize();
  window.addEventListener('resize', onResize);
  setSize();
  setDrawList(input.drawList);

  const tick = (): void => {
    if (disposed) return;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  tick();

  return {
    canvas,
    get selectedId() {
      return selectedId;
    },
    setDrawList,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('resize', onResize);
      clearMeshes();
      renderer.dispose();
      canvas.remove();
    }
  };
}

function createProxyMesh(three: ThreeModule, item: SceneDrawItem): Object3D {
  const geometry: BoxGeometry | SphereGeometry = item.primitive === 'sphere'
    ? new three.SphereGeometry(0.5, 12, 10)
    : new three.BoxGeometry(1, 1, 1);
  const material: MeshStandardMaterial = new three.MeshStandardMaterial({
    color: new three.Color(item.colorRgb[0], item.colorRgb[1], item.colorRgb[2]),
    roughness: 0.65,
    metalness: 0.05
  });
  const mesh = new three.Mesh(geometry, material);
  mesh.position.set(item.position[0], item.position[1], item.position[2]);
  mesh.rotation.set(
    (item.rotation[0] * Math.PI) / 180,
    (item.rotation[1] * Math.PI) / 180,
    (item.rotation[2] * Math.PI) / 180
  );
  mesh.scale.set(item.scale[0], item.scale[1], item.scale[2]);
  mesh.userData.itemId = item.id;
  return mesh;
}
