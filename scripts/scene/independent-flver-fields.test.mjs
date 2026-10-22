import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareFlverIndependentFields } from '../compare-flver-independent-fields.mjs';

test('field comparator binds producer/source receipts and localizes deliberate weight corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-independent-flver-'));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const json = (name, value) => writeFile(join(root, name), JSON.stringify(value));
  const leaf = join(root, 'native.flver'), dll = join(root, 'bridge.dll');
  const leafBytes = Buffer.from('hand-derived native fixture'), dllBytes = Buffer.from('fixture producer');
  const sourceSha256 = hash(leafBytes);
  const floats = (values) => { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, index) => bytes.writeFloatLE(value, index * 4)); return bytes.toString('base64'); };
  const shorts = (values) => { const bytes = Buffer.alloc(values.length * 2); values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2)); return bytes.toString('base64'); };
  const vertices = [[0,0,0],[1,0,0],[0,1,0]].map((Position) => ({ Position, Normal: [0,0,1], UVs: [[0,0]], Colors: [{ R: 0.5, G: 1, B: 0, A: 1 }], BoneWeights: [1,0,0,0], BoneIndices: [0,0,0,0] }));
  const mesh = { Vertices: vertices, FaceSets: [{ Flags: 'None', TriangleStrip: false, CullBackfaces: true, Indices: [0,1,2] }], MaterialIndex: 0, BoneIndices: [] };
  const fields = { Meshes: [mesh], Nodes: [{ Name: 'Root', ParentIndex: -1, Translation: [0,0,0], Rotation: [0,0,0], Scale: [1,1,1] }], Header: { BoundingBoxMin: [0,0,0], BoundingBoxMax: [1,1,0] }, Materials: [{ Name: 'cloth', MTD: 'cloth.mtd', Textures: [{ Path: 'cloth.tif', ParamName: 'g_DiffuseTexture' }] }] };
  const observations = {
    'fixture-mesh0.json': { sourcePath: leaf, parseStatus: 'partial', diagnostics: [], data: { meshIndex: 0, vertexCount: 3, materialIndex: 0, cullBackfaces: true, indexSize: 16, positionsBase64: floats([0,0,0,1,0,0,0,1,0]), normalsBase64: floats([0,0,1,0,0,1,0,0,1]), uvSetsBase64: [floats([0,0,0,0,0,0])], indicesBase64: shorts([0,1,2]), boneWeightsBase64: floats([1,0,0,0,1,0,0,0,1,0,0,0]), boneIndicesBase64: shorts(Array(12).fill(0)), vertexColorDiagnostics: [{ rgbaBase64: floats([0.5,1,0,1,0.5,1,0,1,0.5,1,0,1]) }] } },
    'fixture-skeleton.json': { sourcePath: leaf, data: { boneCount: 1, bones: [{ index: 0, name: 'Root', parentIndex: -1, translation: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }] } },
    'fixture-document.json': { sourcePath: leaf, data: { sourceHash: sourceSha256, boundingBox: { min: [0,0,0], max: [1,1,0] }, materialCount: 1, materialsTruncated: false, materials: [{ name: 'cloth', mtdPath: 'cloth.mtd' }], textureCount: 1, texturesTruncated: false, textureSlots: [{ materialIndex: 0, path: 'cloth.tif', type: 'g_DiffuseTexture' }] } }
  };
  const save = async () => {
    await json('fixture.chrbnd.fields.json', { fields: { files: [{ sha256: sourceSha256, decoded: { format: 'FLVER2', version: 0x20014, fields } }] } });
    for (const [name, value] of Object.entries(observations)) await json(name, value);
    await json('observation-manifest.json', { schemaVersion: 1, bridgeDllSha256: hash(dllBytes), observations: Object.keys(observations).map((name) => ({ name, sha256: hash(Buffer.from(JSON.stringify(observations[name]))), sourcePath: leaf, sourceSha256 })) });
  };
  const compare = () => compareFlverIndependentFields(root, root, dll);
  try {
    await writeFile(leaf, leafBytes); await writeFile(dll, dllBytes);
    await json('flver-per-mesh-inventory.json', { provider: 'hand-derived-fixture', revision: 'a'.repeat(40), license: 'CC0', independentOfSoulForge: true, resources: [{ id: 'fixture', rawLeafPath: leaf, flverSha256: sourceSha256, source: { sha256: sourceSha256 } }] });
    await save();
    assert.equal((await compare()).status, 'passed');
    observations['fixture-mesh0.json'].data.boneWeightsBase64 = floats([0.5,0,0,0,1,0,0,0,1,0,0,0]);
    await save();
    const wrongWeight = await compare();
    assert.equal(wrongWeight.status, 'failed');
    assert.equal(wrongWeight.comparisonLayer, 'bridge');
    assert.equal(wrongWeight.resources[0].meshes[0].checks.boneWeights.firstMismatch.index, 0);
    assert.equal(wrongWeight.coreLayer, 'unverified');
    assert.equal(wrongWeight.rendererLayer, 'unverified');
    mesh.FaceSets[0].Indices = [0,0,0];
    observations['fixture-mesh0.json'] = { sourcePath: leaf, parseStatus: 'partial', diagnostics: [{ code: 'FLVER_MESH_EMPTY_TOPOLOGY' }], data: { meshIndex: 0, vertexCount: 3, indexCount: 3, geometryEmpty: true } };
    await save();
    assert.equal((await compare()).status, 'passed', 'nonzero raw index count with no drawable triangles is empty');
    observations['fixture-mesh0.json'].data.meshIndex = 99;
    await save();
    assert.equal((await compare()).status, 'failed');
    observations['fixture-skeleton.json'].sourcePath = join(root, 'wrong-source.flver');
    await save();
    await assert.rejects(compare(), /BRIDGE_SOURCE_IDENTITY_MISMATCH/);
    const oldBytes = await readFile(join(root, 'fixture-mesh0.json'));
    await writeFile(join(root, 'fixture-mesh0.json'), Buffer.concat([oldBytes, Buffer.from(' ')]));
    await assert.rejects(compare(), /BRIDGE_OBSERVATION_RECEIPT_MISMATCH/);
    await writeFile(dll, 'different producer');
    await assert.rejects(compare(), /BRIDGE_OBSERVATION_PRODUCER_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
