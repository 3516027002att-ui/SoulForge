/** Scene scaffold owns presentation only. Asset authority remains scene-ir. */
export function createSceneEnvironment(
  three: typeof import('three'),
  input: { nativeFlverCoordinateSpace?: boolean; showSceneGuides?: boolean }
) {
  const scene = new three.Scene();
  scene.background = new three.Color(0x151922);
  const camera = new three.PerspectiveCamera(55, 1, 0.1, 50_000);
  const root = new three.Group();
  if (input.nativeFlverCoordinateSpace) root.scale.set(1, 1, -1);
  scene.add(root);
  scene.add(new three.AmbientLight(0xffffff, 0.72));
  const hemisphere = new three.HemisphereLight(0xcfe2ff, 0x493d35, 0.62);
  hemisphere.position.set(0, 100, 0);
  scene.add(hemisphere);
  const key = new three.DirectionalLight(0xffffff, 0.95);
  key.position.set(40, 80, 20);
  scene.add(key);
  const fill = new three.DirectionalLight(0xaecbff, 0.28);
  fill.position.set(-40, 25, -30);
  scene.add(fill);
  const grid = input.showSceneGuides === false ? null : new three.GridHelper(200, 20, 0x3a4150, 0x2a303c);
  const axes = input.showSceneGuides === false ? null : new three.AxesHelper(10);
  if (grid) scene.add(grid);
  if (axes) scene.add(axes);
  const markerGroup = new three.Group();
  const highlightGroup = new three.Group();
  scene.add(markerGroup, highlightGroup);
  return { scene, camera, root, markerGroup, highlightGroup, guides: [grid, axes].filter((guide) => guide !== null) };
}
