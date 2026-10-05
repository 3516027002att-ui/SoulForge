import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as three from 'three';
import { WebGPURenderer } from 'three/webgpu';
const blend = await import('../../apps/desktop/src/renderer/src/scene/nativeDiffuseBlend.ts').catch(() => ({}));
test('WebGPU native diffuse uses node material and preserves declared UV and multiply semantics', () => {
  assert.equal(typeof blend.createWebGpuDiffuseMaterial, 'function');
  const primary = new three.DataTexture(new Uint8Array([64, 128, 255, 255]), 1, 1);
  const secondary = new three.DataTexture(new Uint8Array([128, 64, 32, 128]), 1, 1);
  const material = blend.createWebGpuDiffuseMaterial({ map: primary, side: three.DoubleSide }, secondary, null, { mode: 'multiply', albedo2UvIndex: 2, blendMaskUvIndex: 1, undefinedBlendMaskValue: 0.5, enableTextureAlpha: false, multiplyBlendMaskByAlbedo2Alpha: true });
  assert.equal(material.isNodeMaterial, true);
  assert.ok(material.colorNode);
  assert.equal(material.map, primary);
  assert.equal(material.side, three.DoubleSide);
  assert.deepEqual(material.userData.soulforgeDiffuseBlend, { mode: 'multiply', albedo2UvIndex: 2, blendMaskUvIndex: 1 });
});
test('independent channel arithmetic catches a dropped secondary layer', () => {
  assert.equal(typeof blend.evaluateNativeDiffuseMultiply, 'function');
  // Native multiply = base * (4 * layer). Blend .5 * secondary alpha .5 = .25.
  assert.deepEqual(blend.evaluateNativeDiffuseMultiply([0.25, 0.5, 1], [0.5, 0.25, 0.125, 0.5], 0.5, true), [0.3125, 0.5, 0.875]);
  assert.notDeepEqual(blend.evaluateNativeDiffuseMultiply([0.25, 0.5, 1], [0.5, 0.25, 0.125, 0.5], 0.5, true), [0.25, 0.5, 1]);
});
test('actual Three TSL builder emits primary/secondary/mask sampling and declared UV attributes', () => {
  const renderer = new WebGPURenderer({ canvas: { addEventListener() {}, removeEventListener() {}, style: {}, width: 2, height: 2 } });
  // Offline shader construction: no device/context, features or GPU execution.
  renderer.hasFeature = () => false;
  const makeTexture = () => new three.DataTexture(new Uint8Array([128, 64, 32, 128]), 1, 1);
  const primary = makeTexture(), secondary = makeTexture(), mask = makeTexture();
  const geometry = new three.PlaneGeometry(1, 1);
  geometry.setAttribute('soulforgeUv1', geometry.getAttribute('uv').clone());
  geometry.setAttribute('soulforgeUv2', geometry.getAttribute('uv').clone());
  const compile = (maskTexture, multiplyMaskByAlpha) => {
    const material = blend.createWebGpuDiffuseMaterial({ map: primary }, secondary, maskTexture, { mode: 'multiply', albedo2UvIndex: 2, blendMaskUvIndex: 1, undefinedBlendMaskValue: 0.5, multiplyBlendMaskByAlbedo2Alpha: multiplyMaskByAlpha });
    const builder = renderer.backend.createNodeBuilder(new three.Mesh(geometry, material), renderer);
    builder.scene = new three.Scene();
    builder.camera = new three.PerspectiveCamera();
    builder.build();
    material.dispose();
    return builder;
  };
  const masked = compile(mask, true);
  assert.match(masked.vertexShader, /soulforgeUv2 : vec2<f32>/);
  assert.match(masked.vertexShader, /soulforgeUv1 : vec2<f32>/);
  assert.deepEqual(masked.uniforms.fragment.filter((uniform) => uniform.type === 'texture').map((uniform) => uniform.node.value), [primary, secondary, mask]);
  const diffuseAssignment = masked.fragmentShader.split('\n').find((line) => line.includes('DiffuseColor = vec4<f32>( mix('));
  assert.match(diffuseAssignment, /max\( .*\.xyz, vec3<f32>\( 0\.0 \) \) \* vec3<f32>\( 4\.0 \)/);
  assert.match(diffuseAssignment, /clamp\( \( .*\.x \* .*\.w \), 0\.0, 1\.0 \)/);
  const unmasked = compile(null, false);
  assert.deepEqual(unmasked.uniforms.fragment.filter((uniform) => uniform.type === 'texture').map((uniform) => uniform.node.value), [primary, secondary]);
  assert.doesNotMatch(unmasked.vertexShader, /soulforgeUv1 : vec2<f32>/);
  assert.match(unmasked.fragmentShader, /clamp\( 0\.5, 0\.0, 1\.0 \)/);
  geometry.dispose();
  primary.dispose(); secondary.dispose(); mask.dispose();
});
