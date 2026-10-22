import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as three from 'three';
const base = new URL('../../apps/desktop/src/renderer/src/scene/', import.meta.url);
const load = (name) => import(new URL(name, base)).catch(() => ({}));

test('scene environment preserves independent projection/light/camera baseline', async () => {
  const { createSceneEnvironment } = await load('sceneEnvironment.ts');
  assert.equal(typeof createSceneEnvironment, 'function', 'scene construction must have its own responsibility');
  const env = createSceneEnvironment(three, { nativeFlverCoordinateSpace: true, showSceneGuides: false });
  assert.equal(env.camera.fov, 55);
  assert.equal(env.camera.near, 0.1);
  assert.equal(env.camera.far, 50_000);
  assert.deepEqual(env.root.scale.toArray(), [1, 1, -1]);
  assert.deepEqual(env.scene.children.filter((child) => child.isLight).map((child) => child.intensity), [0.72, 0.62, 0.95, 0.28]);
  assert.equal(env.scene.background.getHex(), 0x151922);
});

test('camera framing and fly movement match hand-computed numerical baseline', async () => {
  const { SceneCameraController } = await load('sceneCameraController.ts');
  assert.equal(typeof SceneCameraController, 'function', 'camera must have its own responsibility');
  const camera = new three.PerspectiveCamera(55, 1, 0.1, 50_000);
  let invalidations = 0;
  const control = new SceneCameraController(three, camera, () => invalidations++);
  control.frame({ min: [0, 0, 0], max: [20, 10, 5], center: [10, 5, 2.5] });
  assert.deepEqual(camera.position.toArray(), [30, 20, 22.5]);
  const before = camera.position.clone();
  control.move(new Set(['w']), 0.1);
  assert.ok(Math.abs(camera.position.distanceTo(before) - 1) < 1e-12);
  assert.ok(invalidations >= 2);
});

test('render loop invalidates once, caps submit cadence, and cancels on disposal', async () => {
  const { SceneRenderLoop } = await load('sceneRenderLoop.ts');
  assert.equal(typeof SceneRenderLoop, 'function', 'render loop must have its own responsibility');
  const callbacks = new Map();
  let sequence = 0;
  let renders = 0;
  let delta = 0;
  const loop = new SceneRenderLoop({ render: () => renders++, update: (dt) => { delta = dt; }, now: () => 0, schedule: (fn) => { callbacks.set(++sequence, fn); return sequence; }, cancel: (id) => callbacks.delete(id) });
  loop.start();
  assert.equal(renders, 1);
  const step = (time) => { const [id, fn] = callbacks.entries().next().value; callbacks.delete(id); fn(time); };
  step(16);
  assert.equal(renders, 1);
  loop.requestRender();
  step(32);
  assert.equal(renders, 1);
  step(48);
  assert.equal(renders, 2);
  step(1000);
  assert.equal(delta, 0.1);
  loop.dispose();
  loop.dispose();
  assert.equal(callbacks.size, 0);
});

test('resource registry releases shared content once and keeps scene guides until disposal', async () => {
  const { SceneResourceRegistry } = await load('sceneResourceRegistry.ts');
  assert.equal(typeof SceneResourceRegistry, 'function', 'resource lifecycle must have its own responsibility');
  let contentReleases = 0;
  let guideReleases = 0;
  const registry = new SceneResourceRegistry();
  const content = { dispose: () => contentReleases++ };
  registry.track(content);
  registry.track(content);
  registry.trackStatic({ dispose: () => guideReleases++ });
  registry.clearContent();
  assert.equal(contentReleases, 1);
  assert.equal(guideReleases, 0);
  registry.dispose();
  registry.dispose();
  assert.equal(guideReleases, 1);
});
