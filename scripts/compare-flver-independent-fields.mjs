import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const flatten = (values, count) => values.flatMap((value) => value.slice(0, count));
const decode = (value, type) => {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'base64');
  const size = type === 'u16' ? 2 : 4;
  if (bytes.length % size) return null;
  return Array.from({ length: bytes.length / size }, (_, index) => type === 'f32' ? bytes.readFloatLE(index * size) : type === 'u16' ? bytes.readUInt16LE(index * size) : bytes.readUInt32LE(index * size));
};

export function compareNumericField(expected, actual, tolerance = 1e-6) {
  if (!Array.isArray(actual) || expected.length !== actual.length) return { status: 'failed', reason: 'LENGTH_MISMATCH', expectedCount: expected.length, actualCount: actual?.length ?? null };
  let maximumAbsoluteError = 0;
  let mismatchCount = 0;
  let firstMismatch = null;
  for (let index = 0; index < expected.length; index++) {
    const error = Math.abs(expected[index] - actual[index]);
    maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
    if (!Number.isFinite(expected[index]) || !Number.isFinite(actual[index]) || error > tolerance) {
      mismatchCount++;
      firstMismatch ??= { index, expected: expected[index], actual: actual[index] };
    }
  }
  return { status: mismatchCount ? 'failed' : 'passed', count: expected.length, maximumAbsoluteError, tolerance, mismatchCount, firstMismatch };
}

/** The oracle exports raw fields. Adapt only documented preview contracts. */
export function expectedPreviewSkinning(vertices, mesh, version, boneCount) {
  const weights = [], indices = [];
  let rigidFallbackVertices = 0;
  for (const vertex of vertices) {
    const rawWeights = vertex.BoneWeights;
    const rawIndices = vertex.BoneIndices;
    const resolveIndex = (index) => version <= 0x2000d && mesh.BoneIndices.length ? mesh.BoneIndices[index] : index;
    if (rawWeights.reduce((sum, value) => sum + value, 0) > 1e-5) {
      for (let slot = 0; slot < 4; slot++) {
        const resolved = resolveIndex(rawIndices[slot]);
        const valid = Number.isInteger(resolved) && resolved >= 0 && resolved < boneCount && resolved <= 65535;
        weights.push(rawWeights[slot] > 1e-5 && !valid ? 0 : rawWeights[slot]);
        indices.push(rawWeights[slot] > 1e-5 && valid ? resolved : 0);
      }
    } else {
      rigidFallbackVertices++;
      weights.push(1, 0, 0, 0);
      indices.push(resolveIndex(rawIndices[0]), 0, 0, 0);
    }
  }
  return { weights, indices, rigidFallbackVertices };
}

export async function compareFlverIndependentFields(oracleDirectory, observationsDirectory, bridgeDll) {
  const inventory = await readJson(resolve(oracleDirectory, 'flver-per-mesh-inventory.json'));
  if (inventory.independentOfSoulForge !== true || !inventory.provider || !/^[a-f0-9]{40}$/.test(inventory.revision) || !inventory.license) throw new Error('INDEPENDENT_ORACLE_PROVENANCE_MISSING');
  const producerSha256 = hash(await readFile(bridgeDll));
  const comparisonScriptPath = fileURLToPath(import.meta.url);
  const checkout = spawnSync('git', ['-C', resolve(dirname(comparisonScriptPath), '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const comparisonTool = { scriptSha256: hash(await readFile(comparisonScriptPath)), checkoutCommit: checkout.status === 0 ? checkout.stdout.trim() : null };
  const manifest = await readJson(resolve(observationsDirectory, 'observation-manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.bridgeDllSha256 !== producerSha256) throw new Error('BRIDGE_OBSERVATION_PRODUCER_MISMATCH');
  const readObservation = async (name, resource) => {
    const bytes = await readFile(resolve(observationsDirectory, name));
    const receipt = manifest.observations.find((item) => item.name === name);
    if (!receipt || receipt.sha256 !== hash(bytes) || receipt.sourceSha256 !== resource.flverSha256 || resolve(receipt.sourcePath) !== resolve(resource.rawLeafPath)) throw new Error(`BRIDGE_OBSERVATION_RECEIPT_MISMATCH:${name}`);
    return JSON.parse(bytes);
  };
  const resources = [];
  for (const resource of inventory.resources) {
    const fieldReport = await readJson(resolve(oracleDirectory, `${resource.id}.chrbnd.fields.json`));
    const leaf = fieldReport.fields.files.find((file) => file.decoded?.format === 'FLVER2');
    if (!leaf || leaf.sha256 !== resource.flverSha256 || hash(await readFile(resource.rawLeafPath)) !== resource.flverSha256) throw new Error(`ORACLE_LEAF_IDENTITY_MISMATCH:${resource.id}`);
    const fields = leaf.decoded.fields;
    const meshes = [];
    for (let ordinal = 0; ordinal < fields.Meshes.length; ordinal++) {
      const mesh = fields.Meshes[ordinal];
      const observation = await readObservation(`${resource.id}-mesh${ordinal}.json`, resource);
      if (resolve(observation.sourcePath) !== resolve(resource.rawLeafPath)) throw new Error(`BRIDGE_SOURCE_IDENTITY_MISMATCH:${resource.id}:${ordinal}`);
      const data = observation.data;
      const selected = mesh.FaceSets.find((face) => face.Flags === 'None') ?? mesh.FaceSets[0];
      const identityMatches = data?.meshIndex === ordinal && data?.vertexCount === mesh.Vertices.length;
      const expectedIndices = [];
      if (selected && !selected.TriangleStrip) {
        for (let index = 0; index < selected.Indices.length; index += 3) {
          const triangle = selected.Indices.slice(index, index + 3);
          if (triangle.length !== 3) throw new Error('ORACLE_TRIANGLE_LIST_TRUNCATED');
          if (new Set(triangle).size === 3) expectedIndices.push(...triangle);
        }
      }
      if (!selected || !mesh.Vertices.length || !selected.Indices.length || (!selected.TriangleStrip && !expectedIndices.length)) {
        const classifiedEmpty = identityMatches && data?.indexCount === (selected?.Indices.length ?? 0) && data?.geometryEmpty === true && observation.parseStatus === 'partial' && observation.diagnostics.some((item) => item.code === 'FLVER_MESH_EMPTY_TOPOLOGY');
        meshes.push({ ordinal, nativeVertexCount: mesh.Vertices.length, nativeIndexCount: selected?.Indices.length ?? 0, classification: 'empty-topology', status: classifiedEmpty ? 'passed' : 'failed' });
        continue;
      }
      // This bounded real corpus contains triangle lists. Do not silently
      // create strip expectations by copying the production triangulator.
      if (selected.TriangleStrip) { meshes.push({ ordinal, status: 'unverified', reason: 'TRIANGLE_STRIP_ORACLE_NORMALIZATION_REQUIRED' }); continue; }
      const checks = {
        identity: { status: identityMatches ? 'passed' : 'failed' },
        positions: compareNumericField(flatten(mesh.Vertices.map((vertex) => vertex.Position), 3), decode(data?.positionsBase64, 'f32')),
        normals: compareNumericField(flatten(mesh.Vertices.map((vertex) => vertex.Normal), 3), decode(data?.normalsBase64, 'f32')),
        indices: compareNumericField(expectedIndices, decode(data?.indicesBase64, data?.indexSize === 32 ? 'u32' : 'u16'), 0)
      };
      const uvCount = mesh.Vertices[0].UVs.length;
      checks.uvSetCount = { status: data?.uvSetsBase64?.length === uvCount ? 'passed' : 'failed', expected: uvCount, actual: data?.uvSetsBase64?.length ?? null };
      for (let set = 0; set < uvCount; set++) checks[`uv${set}`] = compareNumericField(flatten(mesh.Vertices.map((vertex) => vertex.UVs[set]), 2), decode(data?.uvSetsBase64?.[set], 'f32'));
      const colorCount = mesh.Vertices[0].Colors.length;
      checks.vertexColorSetCount = { status: data?.vertexColorDiagnostics?.length === colorCount ? 'passed' : 'failed' };
      for (let set = 0; set < colorCount; set++) checks[`vertexColor${set}`] = compareNumericField(mesh.Vertices.flatMap((vertex) => { const color = vertex.Colors[set]; return [color.R, color.G, color.B, color.A]; }), decode(data?.vertexColorDiagnostics?.[set]?.rgbaBase64, 'f32'));
      const skinning = expectedPreviewSkinning(mesh.Vertices, mesh, leaf.decoded.version, fields.Nodes.length);
      checks.boneWeights = compareNumericField(skinning.weights, decode(data?.boneWeightsBase64, 'f32'));
      checks.boneIndices = compareNumericField(skinning.indices, decode(data?.boneIndicesBase64, 'u16'), 0);
      checks.materialIndex = { status: data?.materialIndex === mesh.MaterialIndex ? 'passed' : 'failed' };
      checks.cullBackfaces = { status: data?.cullBackfaces === selected.CullBackfaces ? 'passed' : 'failed' };
      meshes.push({ ordinal, nativeVertexCount: mesh.Vertices.length, nativeIndexCount: selected.Indices.length, displayIndexCount: expectedIndices.length, classification: 'drawable', rigidFallbackVertices: skinning.rigidFallbackVertices, status: Object.values(checks).every((check) => check.status === 'passed') ? 'passed' : 'failed', checks });
    }
    const skeletonObservation = await readObservation(`${resource.id}-skeleton.json`, resource);
    if (resolve(skeletonObservation.sourcePath) !== resolve(resource.rawLeafPath)) throw new Error(`BRIDGE_SOURCE_IDENTITY_MISMATCH:${resource.id}:skeleton`);
    const skeleton = skeletonObservation.data;
    const skeletonChecks = { boneCount: { status: skeleton?.boneCount === fields.Nodes.length ? 'passed' : 'failed' } };
    for (const [nativeName, bridgeName] of [['Translation', 'translation'], ['Rotation', 'rotation'], ['Scale', 'scale']]) skeletonChecks[bridgeName] = compareNumericField(flatten(fields.Nodes.map((node) => node[nativeName]), 3), flatten((skeleton?.bones ?? []).map((bone) => bone[bridgeName]), 3));
    skeletonChecks.parents = compareNumericField(fields.Nodes.map((node) => node.ParentIndex), (skeleton?.bones ?? []).map((bone) => bone.parentIndex), 0);
    skeletonChecks.indices = compareNumericField(fields.Nodes.map((_, index) => index), (skeleton?.bones ?? []).map((bone) => bone.index), 0);
    skeletonChecks.names = { status: fields.Nodes.every((node, index) => node.Name === skeleton?.bones?.[index]?.name) ? 'passed' : 'failed' };
    const documentObservation = await readObservation(`${resource.id}-document.json`, resource);
    if (resolve(documentObservation.sourcePath) !== resolve(resource.rawLeafPath)) throw new Error(`BRIDGE_SOURCE_IDENTITY_MISMATCH:${resource.id}:document`);
    const document = documentObservation.data;
    const documentChecks = {
      sourceHash: { status: document?.sourceHash === resource.flverSha256 ? 'passed' : 'failed' },
      boundingBox: compareNumericField([...fields.Header.BoundingBoxMin, ...fields.Header.BoundingBoxMax], [...(document?.boundingBox?.min ?? []), ...(document?.boundingBox?.max ?? [])]),
      materialCount: { status: document?.materialCount === fields.Materials.length ? 'passed' : 'failed' },
      exposedMaterialNamesAndMtd: { status: Array.isArray(document?.materials) && document.materials.length > 0 && document.materials.length <= fields.Materials.length && (document.materials.length === fields.Materials.length || document.materialsTruncated === true) && document.materials.every((material, index) => material.name === fields.Materials[index]?.Name && material.mtdPath === fields.Materials[index]?.MTD) ? 'passed' : 'failed', expectedTotalCount: fields.Materials.length, comparedCount: document?.materials?.length ?? 0, fullCoverage: document?.materialsTruncated === false && document?.materials?.length === fields.Materials.length }
    };
    const expectedTextures = fields.Materials.flatMap((material, materialIndex) => material.Textures.map((texture) => ({ materialIndex, path: texture.Path, type: texture.ParamName })));
    documentChecks.textureCount = { status: document?.textureCount === expectedTextures.length ? 'passed' : 'failed' };
    documentChecks.exposedTextureReferences = { status: Array.isArray(document?.textureSlots) && (expectedTextures.length === 0 || document.textureSlots.length > 0) && document.textureSlots.length <= expectedTextures.length && (document.textureSlots.length === expectedTextures.length || document.texturesTruncated === true) && document.textureSlots.every((texture, index) => texture.materialIndex === expectedTextures[index]?.materialIndex && texture.path === expectedTextures[index]?.path && texture.type === expectedTextures[index]?.type) ? 'passed' : 'failed', expectedTotalCount: expectedTextures.length, comparedCount: document?.textureSlots?.length ?? 0, fullCoverage: document?.texturesTruncated === false && document?.textureSlots?.length === expectedTextures.length };
    const status = meshes.every((mesh) => mesh.status === 'passed') && Object.values(skeletonChecks).every((check) => check.status === 'passed') && Object.values(documentChecks).every((check) => check.status === 'passed') ? 'passed' : 'failed';
    resources.push({ id: resource.id, sourceSha256: resource.source.sha256, flverSha256: resource.flverSha256, status, meshes, skeleton: { status: Object.values(skeletonChecks).every((check) => check.status === 'passed') ? 'passed' : 'failed', checks: skeletonChecks }, document: { checks: documentChecks } });
  }
  return { schemaVersion: 1, status: resources.every((resource) => resource.status === 'passed') ? 'passed' : 'failed', comparisonTool, oracle: { provider: inventory.provider, revision: inventory.revision, license: inventory.license, independentOfSoulForge: true }, bridgeDllSha256: producerSha256, observationsCapturedAt: manifest.capturedAt, comparisonLayer: 'bridge', coreLayer: 'unverified', rendererLayer: 'unverified', resources, unverifiedFields: ['tangents', 'computed reference FK and bind matrices', 'material and texture references beyond bounded document preview', 'MSB/TAE/HKX animation data in this FLVER report'], nonClaims: ['No copied oracle code or game payloads in product', 'External oracle shares documented format lineage; independent execution is not independent format discovery', 'Raw weights are compared after explicit rigid-zero fallback and unused-slot index projection', 'No rendered image correctness, HKX correctness or WebGPU performance parity claim'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [oracle, actual, bridgeDll, reportPath] = process.argv.slice(2);
  if (!reportPath) throw new Error('Usage: node scripts/compare-flver-independent-fields.mjs <oracle-results> <bridge-observations> <bridge.dll> <report.json>');
  const report = await compareFlverIndependentFields(oracle, actual, bridgeDll);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, drawableMeshes: report.resources.flatMap((resource) => resource.meshes).filter((mesh) => mesh.classification === 'drawable').length, emptyMeshes: report.resources.flatMap((resource) => resource.meshes).filter((mesh) => mesh.classification === 'empty-topology').length, reportPath }));
  process.exitCode = report.status === 'passed' ? 0 : 1;
}
