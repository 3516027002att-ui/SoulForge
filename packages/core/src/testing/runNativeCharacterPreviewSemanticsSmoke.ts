/**
 * Native character FLVER preview semantics smoke.
 *
 * This is intentionally a small real-asset contract, not a full MTD parser or
 * game-load claim. It protects the three source-backed branches used by the
 * ACTION preview:
 *   - FC_M_0210: one native MeshDecal receiver, remaining meshes surface;
 *   - BD_M_9040: ordinary Character materials stay surface and DetailBlend
 *     uses the verified UV0/UV0 sampler contract;
 *   - HD_M_9510: the native projected-decal receiver remains classified and
 *     read-only; ACTION must not inject a generic FC texture into it.
 *
 * Env: SOULFORGE_SEKIRO_GAME_ROOT or SOULFORGE_NATIVE_FIXTURE_ROOT.
 * Without a readable game root this reports an honest skip.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { disposeBridgeDaemonPool, runBridge } from '../bridge/runBridge.js';

interface PreviewTexture {
  materialIndex: number;
  textureName?: string;
  alphaMode?: string;
  mask1TextureName?: string;
  albedo2?: { textureName?: string } | null;
  diffuseBlend?: {
    mode?: string;
    albedo2UvIndex?: number;
    blendMaskUvIndex?: number;
    undefinedBlendMaskValue?: number;
    enableTextureAlpha?: boolean;
    multiplyBlendMaskByAlbedo2Alpha?: boolean;
  } | null;
}

interface PreviewMesh {
  meshIndex: number;
  materialIndex: number;
  renderMode: string;
  projectionTextureName?: string | null;
  vertexCount?: number;
  skinningMode?: 'weighted' | 'rigid' | 'static';
  skinningTransformMode?: 'absolute' | 'delta';
  boneWeightsBase64?: string;
  boneIndicesBase64?: string;
}

interface PreviewBone {
  index: number;
  parentIndex: number;
  translation: number[];
  rotation: number[];
  scale: number[];
  referenceFkMatrix: number[];
}

interface PreviewModel {
  boneCount?: number;
  bones?: PreviewBone[];
  texturePreviews?: PreviewTexture[];
  meshes?: PreviewMesh[];
}

interface PreviewEnvelope {
  models?: PreviewModel[];
}

interface PreviewCase {
  label: string;
  relativePath: string;
  options?: Record<string, unknown>;
}

const cases: PreviewCase[] = [
  {
    label: 'fc_m_0210',
    relativePath: 'parts/fc_m_0210.partsbnd.dcx'
  },
  {
    label: 'bd_m_9040',
    relativePath: 'parts/bd_m_9040.partsbnd.dcx'
  },
  {
    label: 'hd_m_9510',
    relativePath: 'parts/hd_m_9510.partsbnd.dcx'
  }
];

function gameRoot(): string {
  const cliRoot = process.argv
    .slice(2)
    .filter((argument) => argument !== '--')
    .join(' ')
    .replace(/\^/g, '')
    .trim();
  return resolve(
    cliRoot
      || process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
      || process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
      || ''
  );
}

function modelsOf(data: PreviewEnvelope | undefined): PreviewModel[] {
  return Array.isArray(data?.models) ? data.models : [];
}

function flattenMeshes(models: PreviewModel[]): PreviewMesh[] {
  return models.flatMap((model) => Array.isArray(model.meshes) ? model.meshes : []);
}

function flattenTextures(models: PreviewModel[]): PreviewTexture[] {
  return models.flatMap((model) => Array.isArray(model.texturePreviews)
    ? model.texturePreviews
    : []);
}

type Matrix4 = number[];

function multiplyMatrix4(left: Matrix4, right: Matrix4): Matrix4 {
  const result = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      let value = 0;
      for (let k = 0; k < 4; k += 1) {
        value += left[row * 4 + k]! * right[k * 4 + column]!;
      }
      result[row * 4 + column] = value;
    }
  }
  return result;
}

function scaleMatrix([x, y, z]: [number, number, number]): Matrix4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

function rotationXMatrix(angle: number): Matrix4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

function rotationZMatrix(angle: number): Matrix4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function rotationYMatrix(angle: number): Matrix4 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function translationMatrix([x, y, z]: [number, number, number]): Matrix4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function referenceLocalMatrix(bone: PreviewBone): Matrix4 {
  const translation = bone.translation as [number, number, number];
  const rotation = bone.rotation as [number, number, number];
  const scale = bone.scale as [number, number, number];
  return multiplyMatrix4(
    multiplyMatrix4(
      multiplyMatrix4(
        multiplyMatrix4(scaleMatrix(scale), rotationXMatrix(rotation[0])),
        rotationZMatrix(rotation[2])
      ),
      rotationYMatrix(rotation[1])
    ),
    translationMatrix(translation)
  );
}

function assertRealSkeleton(model: PreviewModel, label: string): void {
  const boneCount = model.boneCount;
  const bones = model.bones;
  if (typeof boneCount !== 'number' || !Number.isInteger(boneCount) || boneCount <= 0) {
    throw new Error(`${label}: missing native boneCount`);
  }
  if (!Array.isArray(bones)) throw new Error(`${label}: missing native bones`);
  const nativeBoneCount = boneCount as number;
  assert.equal(bones.length, nativeBoneCount, `${label}: bone count mismatch`);

  const state = new Uint8Array(bones.length);
  const reference = new Array<Matrix4>(bones.length);
  const resolve = (index: number): Matrix4 => {
    assert.ok(index >= 0 && index < bones.length, `${label}: invalid bone index ${index}`);
    if (state[index] === 2) return reference[index]!;
    assert.notEqual(state[index], 1, `${label}: bone hierarchy cycle at ${index}`);
    state[index] = 1;
    const bone = bones[index]!;
    assert.equal(bone.index, index, `${label}: native bone index order mismatch at ${index}`);
    assert.ok(bone.parentIndex === -1 || (bone.parentIndex >= 0 && bone.parentIndex < bones.length),
      `${label}: invalid parent for bone ${index}`);
    for (const [name, vector, expectedLength] of [
      ['translation', bone.translation, 3],
      ['rotation', bone.rotation, 3],
      ['scale', bone.scale, 3]
    ] as const) {
      assert.equal(vector.length, expectedLength, `${label}: ${name} arity for bone ${index}`);
      assert.ok(vector.every(Number.isFinite), `${label}: non-finite ${name} for bone ${index}`);
    }
    assert.equal(bone.referenceFkMatrix.length, 16, `${label}: reference FK arity for bone ${index}`);
    assert.ok(bone.referenceFkMatrix.every(Number.isFinite), `${label}: non-finite reference FK for bone ${index}`);
    const local = referenceLocalMatrix(bone);
    const expected = bone.parentIndex >= 0
      ? multiplyMatrix4(local, resolve(bone.parentIndex))
      : local;
    for (let component = 0; component < 16; component += 1) {
      const actual = bone.referenceFkMatrix[component]!;
      const tolerance = 2e-4 * Math.max(1, Math.abs(expected[component]!));
      assert.ok(Math.abs(actual - expected[component]!) <= tolerance,
        `${label}: reference FK mismatch bone=${index} component=${component} actual=${actual} expected=${expected[component]}`);
    }
    reference[index] = expected;
    state[index] = 2;
    return expected;
  };

  for (let index = 0; index < bones.length; index += 1) resolve(index);
}

function assertRealSkinning(models: PreviewModel[], label: string): void {
  for (const model of models) {
    assertRealSkeleton(model, label);
    for (const mesh of model.meshes ?? []) {
      if (typeof mesh.vertexCount !== 'number'
        || !Number.isInteger(mesh.vertexCount)
        || mesh.vertexCount <= 0) {
        throw new Error(`${label}: mesh ${mesh.meshIndex} missing vertexCount`);
      }
      const vertexCount = mesh.vertexCount as number;
      assert.ok(mesh.skinningTransformMode === 'absolute' || mesh.skinningTransformMode === 'delta',
        `${label}: mesh ${mesh.meshIndex} missing FLVER Dynamic transform mode`);
      if (mesh.skinningMode === 'weighted' || mesh.skinningMode === 'rigid') {
        assert.ok(mesh.boneWeightsBase64, `${label}: mesh ${mesh.meshIndex} missing bone weights`);
        assert.ok(mesh.boneIndicesBase64, `${label}: mesh ${mesh.meshIndex} missing bone indices`);
        const expectedWeightBytes = vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT;
        const expectedIndexBytes = vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT;
        assert.equal(Buffer.from(mesh.boneWeightsBase64!, 'base64').byteLength, expectedWeightBytes,
          `${label}: mesh ${mesh.meshIndex} weight payload length`);
        assert.equal(Buffer.from(mesh.boneIndicesBase64!, 'base64').byteLength, expectedIndexBytes,
          `${label}: mesh ${mesh.meshIndex} index payload length`);
      }
    }
  }
}

async function readCase(root: string, sample: PreviewCase): Promise<{
  label: string;
  meshCount: number;
  surfaceCount: number;
  compatibilityProjectionCount: number;
  nativeProjectionCount: number;
  textures: Array<{
    materialIndex: number;
    textureName?: string;
    alphaMode?: string;
    albedo2?: string;
    mask1?: string;
    diffuseBlend?: PreviewTexture['diffuseBlend'];
  }>;
}> {
  const filePath = join(root, sample.relativePath);
  const result = await runBridge<PreviewEnvelope>({
    command: 'read-chrbnd-flver-preview',
    filePath,
    allowedRoots: [dirname(filePath), root, join(root, 'mods', 'chr')],
    oodleRuntimeRoot: root,
    ...(sample.options ? { commandOptions: sample.options } : {}),
    timeoutMs: 120_000,
    maxFrameBytes: 32 * 1024 * 1024
  });
  assert.notEqual(result.parseStatus, 'failed', `${sample.label}: ${JSON.stringify(result.diagnostics)}`);
  const models = modelsOf(result.data);
  assert.ok(models.length > 0, `${sample.label}: preview returned no FLVER model`);
  const meshes = flattenMeshes(models);
  const textures = flattenTextures(models);
  assert.ok(meshes.length > 0, `${sample.label}: preview returned no mesh payload`);
  assertRealSkinning(models, sample.label);
  return {
    label: sample.label,
    meshCount: meshes.length,
    surfaceCount: meshes.filter((mesh) => mesh.renderMode === 'surface').length,
    compatibilityProjectionCount: meshes.filter((mesh) => mesh.renderMode === 'compatibility-projected').length,
    nativeProjectionCount: meshes.filter((mesh) => mesh.renderMode === 'projected-decal').length,
    textures: textures.map((texture) => ({
      materialIndex: texture.materialIndex,
      ...(texture.textureName ? { textureName: texture.textureName } : {}),
      ...(texture.alphaMode ? { alphaMode: texture.alphaMode } : {}),
      ...(texture.albedo2?.textureName ? { albedo2: texture.albedo2.textureName } : {}),
      ...(texture.mask1TextureName ? { mask1: texture.mask1TextureName } : {}),
      ...(texture.diffuseBlend ? { diffuseBlend: texture.diffuseBlend } : {})
    }))
  };
}

function assertContracts(summary: Awaited<ReturnType<typeof readCase>>[]): void {
  const fc = summary.find((item) => item.label === 'fc_m_0210');
  assert.ok(fc);
  assert.equal(fc.meshCount, 9);
  assert.equal(fc.surfaceCount, 8);
  assert.equal(fc.compatibilityProjectionCount, 1);
  assert.equal(fc.nativeProjectionCount, 0);
  const fcHead = fc.textures.find((texture) => texture.materialIndex === 0);
  assert.equal(fcHead?.alphaMode, 'opaque');
  assert.equal(fcHead?.albedo2, 'FC_M_0210_Damage_a');
  assert.equal(fcHead?.diffuseBlend?.albedo2UvIndex, 1);
  assert.equal(fcHead?.diffuseBlend?.blendMaskUvIndex, 0);

  const bd = summary.find((item) => item.label === 'bd_m_9040');
  assert.ok(bd);
  assert.equal(bd.meshCount, 27);
  assert.equal(bd.surfaceCount, 27);
  assert.equal(bd.compatibilityProjectionCount, 0);
  assert.equal(bd.nativeProjectionCount, 0);
  const bdTops = bd.textures.find((texture) => texture.materialIndex === 0);
  assert.equal(bdTops?.diffuseBlend?.mode, 'multiply');
  assert.equal(bdTops?.diffuseBlend?.albedo2UvIndex, 0);
  assert.equal(bdTops?.diffuseBlend?.blendMaskUvIndex, 0);
  assert.equal(bdTops?.diffuseBlend?.enableTextureAlpha, true);

  const hd = summary.find((item) => item.label === 'hd_m_9510');
  assert.ok(hd);
  assert.equal(hd.meshCount, 1);
  assert.equal(hd.surfaceCount, 0);
  assert.equal(hd.compatibilityProjectionCount, 0);
  assert.equal(hd.nativeProjectionCount, 1);
}

async function main(): Promise<void> {
  const root = gameRoot();
  if (!root || !existsSync(root)) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      reason: 'NATIVE_GAME_ROOT_UNAVAILABLE',
      message: '没有可读取的 Sekiro 游戏根目录，跳过真实角色材质预览 smoke。'
    }, null, 2));
    return;
  }

  for (const sample of cases) {
    const filePath = join(root, sample.relativePath);
    if (!existsSync(filePath)) {
      throw new Error(`NATIVE_CHARACTER_PREVIEW_SAMPLE_MISSING: ${filePath}`);
    }
  }

  const summary: Awaited<ReturnType<typeof readCase>>[] = [];
  for (const sample of cases) summary.push(await readCase(root, sample));
  assertContracts(summary);
  console.log(JSON.stringify({
    ok: true,
    status: 'PASS',
    authority: 'partial',
    samples: summary,
    nonClaims: [
      '只验证 Bridge 只读预览 payload 的 MTD4 语义投影与受控兼容投影分类。',
      '不宣称原生游戏 shader、Electron 画面、全量 MTD parser 或 game-load 完成。'
    ]
  }, null, 2));
}

main()
  .finally(() => disposeBridgeDaemonPool())
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
