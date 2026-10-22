import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, clamp, float, materialColor, max, mix, texture, vec4 } from 'three/tsl';
import type { MeshStandardMaterialParameters, Texture } from 'three';
import type { FlverSceneDiffuseBlend } from './threeSceneController.js';

/** Small native Character_AMSN multiply subset; not a general MTD interpreter. */
export function createWebGpuDiffuseMaterial(
  parameters: MeshStandardMaterialParameters,
  albedo2: Texture,
  blendMask: Texture | null,
  blend: FlverSceneDiffuseBlend
): MeshStandardNodeMaterial {
  for (const index of [blend.albedo2UvIndex, blend.blendMaskUvIndex]) {
    if (!Number.isInteger(index) || index < 0 || index > 7) throw new Error('FLVER_DIFFUSE_UV_INDEX_INVALID');
  }
  const material = new MeshStandardNodeMaterial(parameters);
  const nativeUv = (index: number) => attribute(index === 0 ? 'uv' : `soulforgeUv${index}`, 'vec2');
  const secondary = texture(albedo2, nativeUv(blend.albedo2UvIndex));
  const mask = blendMask ? texture(blendMask, nativeUv(blend.blendMaskUvIndex)).r : float(blend.undefinedBlendMaskValue);
  const weight = clamp(blend.multiplyBlendMaskByAlbedo2Alpha ? mask.mul(secondary.a) : mask, 0, 1);
  const multiplied = materialColor.rgb.mul(max(secondary.rgb, 0).mul(4));
  material.colorNode = vec4(mix(materialColor.rgb, multiplied, weight), materialColor.a);
  material.userData.soulforgeDiffuseBlend = { mode: blend.mode, albedo2UvIndex: blend.albedo2UvIndex, blendMaskUvIndex: blend.blendMaskUvIndex };
  return material;
}

/** CPU contract for independent numerical checks, not used to shade pixels. */
export function evaluateNativeDiffuseMultiply(
  primary: readonly [number, number, number],
  secondary: readonly [number, number, number, number],
  mask: number,
  multiplyMaskByAlpha: boolean
): [number, number, number] {
  const weight = Math.max(0, Math.min(1, mask * (multiplyMaskByAlpha ? secondary[3] : 1)));
  return primary.map((value, index) => value * (1 - weight + Math.max(secondary[index]!, 0) * 4 * weight)) as [number, number, number];
}
