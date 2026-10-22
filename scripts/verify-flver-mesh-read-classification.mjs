import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const bridge = process.env.SF_TEST_BRIDGE_DLL;
if (!bridge) throw new Error('SF_TEST_BRIDGE_DLL must name a locally built framework-dependent Bridge DLL');
const dotnet = process.env.SOULFORGE_DOTNET ?? 'dotnet';
function fixture(indexCount = 3, positionType = 2) {
  const bytes = Buffer.alloc(330);
  bytes.write('FLVER\0'); bytes.write('L\0', 6);
  const i32 = (at, value) => bytes.writeInt32LE(value, at);
  i32(8, 0x20014); i32(12, 288); i32(16, 42); i32(32, 1); i32(36, 1); i32(64, 1); i32(68, 1);
  bytes.writeUInt8(16, 72); i32(80, 1); i32(84, 1);
  for (const at of [52, 56, 60]) bytes.writeFloatLE(1, at);
  // One mesh, one FaceSet, one position-only vertex buffer.
  i32(128 + 16, -1); i32(128 + 32, 1); i32(128 + 36, 280); i32(128 + 40, 1); i32(128 + 44, 276);
  i32(176 + 8, indexCount); i32(176 + 12, 36); i32(176 + 24, 16);
  i32(208 + 8, 12); i32(208 + 12, 3); i32(208 + 24, 36);
  i32(240, 1); i32(240 + 12, 256); i32(256 + 8, positionType);
  bytes.writeFloatLE(1, 300); bytes.writeFloatLE(1, 316);
  bytes.writeUInt16LE(0, 324); bytes.writeUInt16LE(1, 326); bytes.writeUInt16LE(2, 328);
  return bytes;
}
const directory = await mkdtemp(join(tmpdir(), 'sf-flver-read-classification-'));
try {
  const read = async (name, bytes, options) => {
    const path = join(directory, name + '.flver');
    await writeFile(path, bytes);
    const processResult = spawnSync(dotnet, [resolve(bridge), 'read-flver-mesh', path, '--options', JSON.stringify(options)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (processResult.error) throw processResult.error;
    return JSON.parse(processResult.stdout);
  };
  const empty = await read('empty', fixture(0), {});
  assert.equal(empty.diagnostics[0].code, 'FLVER_MESH_EMPTY_TOPOLOGY');
  assert.equal(empty.parseStatus, 'partial');
  assert.equal(empty.data.geometryEmpty, true);
  const degenerateBytes = fixture();
  degenerateBytes.fill(0, 324, 330);
  const degenerate = await read('degenerate', degenerateBytes, {});
  assert.equal(degenerate.diagnostics[0].code, 'FLVER_MESH_EMPTY_TOPOLOGY');
  assert.equal(degenerate.data.geometryEmpty, true);
  const unsupportedTopologyBytes = fixture();
  unsupportedTopologyBytes.writeUInt32LE(0x40000000, 176);
  const unsupportedTopology = await read('unsupported-topology', unsupportedTopologyBytes, {});
  assert.equal(unsupportedTopology.diagnostics[0].code, 'FLVER_MESH_TOPOLOGY_DECODE_UNAVAILABLE');
  const missing = await read('missing', fixture(), { meshIndex: 1 });
  assert.equal(missing.diagnostics[0].code, 'FLVER_MESH_INDEX_OUT_OF_RANGE');
  const limited = await read('limited', fixture(), { maxVertices: 2 });
  assert.equal(limited.diagnostics[0].code, 'FLVER_MESH_VERTEX_LIMIT_EXCEEDED');
  const indexLimited = await read('index-limited', fixture(), { maxIndices: 2 });
  assert.equal(indexLimited.diagnostics[0].code, 'FLVER_MESH_INDEX_LIMIT_EXCEEDED');
  const unsupported = await read('unsupported', fixture(3, 0x70), {});
  assert.equal(unsupported.diagnostics[0].code, 'FLVER_MESH_POSITION_DECODE_UNAVAILABLE');
  const normal = await read('normal', fixture(), {});
  assert.equal(normal.parseStatus, 'partial');
  assert.equal(normal.data.vertexCount, 3);
  const positions = Buffer.from(normal.data.positionsBase64, 'base64');
  assert.deepEqual(Array.from({ length: 9 }, (_, index) => positions.readFloatLE(index * 4)), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  console.log(JSON.stringify({ status: 'passed', cases: ['empty-topology', 'degenerate-topology', 'unsupported-topology', 'missing-index', 'vertex-limit', 'index-limit', 'unsupported-position', 'hand-derived-triangle'] }));
} finally { await rm(directory, { recursive: true, force: true }); }
