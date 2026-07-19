/**
 * FLVER candidate header + deeper mesh-table / faceSet / vb / layout probe smoke (synthetic only).
 */
import {
  buildSyntheticFlverHeaderFixture,
  probeFlverCandidate
} from '../scene/flverCandidate.js';

function main(): void {
  const bad = probeFlverCandidate(Buffer.from('NOTFLVER............'));
  if (bad.authority !== 'unsupported') throw new Error('expected unsupported');

  const fixture = buildSyntheticFlverHeaderFixture({
    meshCount: 2,
    materialCount: 3,
    boneCount: 4,
    layoutCount: 1
  });
  const report = probeFlverCandidate(fixture);
  if (report.authority !== 'candidate') {
    throw new Error(`expected candidate, got ${report.authority}: ${JSON.stringify(report.diagnostics)}`);
  }
  if (report.meshCount !== 2 || report.meshes.length !== 2) {
    throw new Error(`mesh rows mismatch: count=${report.meshCount} rows=${report.meshes.length}`);
  }
  if (report.materialCount !== 3 || report.boneCount !== 4) {
    throw new Error(`material/bone count mismatch: ${report.materialCount}/${report.boneCount}`);
  }

  const m0 = report.meshes[0]!;
  const m1 = report.meshes[1]!;
  if (m0.dynamic !== 0 || m1.dynamic !== 1) {
    throw new Error(`dynamic mismatch: ${m0.dynamic},${m1.dynamic}`);
  }
  if (m0.materialIndex !== 0 || m1.materialIndex !== 1) {
    throw new Error(`materialIndex mismatch: ${m0.materialIndex},${m1.materialIndex}`);
  }
  if (m0.boneCount !== 2 || m1.boneCount !== 3) {
    throw new Error(`boneCount mismatch: ${m0.boneCount},${m1.boneCount}`);
  }
  if (m0.faceSetCount !== 1 || m1.faceSetCount !== 2) {
    throw new Error(`faceSetCount mismatch: ${m0.faceSetCount},${m1.faceSetCount}`);
  }
  if (m0.vertexBufferCount !== 1 || m1.vertexBufferCount !== 1) {
    throw new Error(`vertexBufferCount mismatch: ${m0.vertexBufferCount},${m1.vertexBufferCount}`);
  }
  if (!m0.layoutSane || !m1.layoutSane) {
    throw new Error(`expected layoutSane mesh rows: ${JSON.stringify([m0.notes, m1.notes])}`);
  }
  if (!m0.faceSet0 || !m0.faceSet0.layoutSane || m0.faceSet0.indexCount !== 3) {
    throw new Error(`faceSet0 missing/insane: ${JSON.stringify(m0.faceSet0)}`);
  }
  if (!m0.vertexBuffer0 || !m0.vertexBuffer0.layoutSane || m0.vertexBuffer0.vertexSize !== 24 || m0.vertexBuffer0.vertexCount !== 3) {
    throw new Error(`vertexBuffer0 missing/insane: ${JSON.stringify(m0.vertexBuffer0)}`);
  }
  // Indices/buffer payloads are intentionally NOT decoded.
  if ((m0.faceSet0 as { indices?: unknown }).indices !== undefined) {
    throw new Error('must not decode faceSet index payload');
  }
  if (!m0.boneIndicesSample || m0.boneIndicesSample.length !== 2
      || m0.boneIndicesSample[0] !== 0 || m0.boneIndicesSample[1] !== 1) {
    throw new Error(`boneIndicesSample mismatch: ${JSON.stringify(m0.boneIndicesSample)}`);
  }
  if ((m0 as { boneMatrices?: unknown }).boneMatrices !== undefined) {
    throw new Error('must not decode bone hierarchy/matrices');
  }

  if (!report.layouts || report.layouts.length < 1) {
    throw new Error(`expected layout table sample: ${JSON.stringify(report.layouts)}`);
  }
  const layout0 = report.layouts[0]!;
  if (!layout0.layoutSane || layout0.memberCount !== 3 || layout0.members.length !== 3) {
    throw new Error(`layout0 insane: ${JSON.stringify(layout0)}`);
  }
  if (layout0.members[0]!.semantic !== 0 || layout0.members[0]!.structOffset !== 0) {
    throw new Error(`layout0 member0 Position mismatch: ${JSON.stringify(layout0.members[0])}`);
  }
  if (layout0.members[1]!.semantic !== 2 || layout0.members[1]!.structOffset !== 12) {
    throw new Error(`layout0 member1 Normal mismatch: ${JSON.stringify(layout0.members[1])}`);
  }
  if (layout0.members[2]!.semantic !== 5 || layout0.members[2]!.structOffset !== 24) {
    throw new Error(`layout0 member2 UV mismatch: ${JSON.stringify(layout0.members[2])}`);
  }
  if ((layout0 as { vertexStream?: unknown }).vertexStream !== undefined) {
    throw new Error('must not decode vertex attribute streams from layout');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'FLVER candidate header + mesh/faceSet/vb/boneIndices/layout deeper fields smoke passed',
    authority: report.authority,
    meshCount: report.meshCount,
    meshRows: report.meshes.length,
    layoutRows: report.layouts.length,
    materialCount: report.materialCount,
    boneCount: report.boneCount,
    version: report.version,
    mesh0: {
      dynamic: m0.dynamic,
      materialIndex: m0.materialIndex,
      boneCount: m0.boneCount,
      boneIndicesSample: m0.boneIndicesSample,
      faceSetCount: m0.faceSetCount,
      vertexBufferCount: m0.vertexBufferCount,
      layoutSane: m0.layoutSane,
      faceSet0: {
        flags: m0.faceSet0.flags,
        topology: m0.faceSet0.topology,
        indexCount: m0.faceSet0.indexCount,
        layoutSane: m0.faceSet0.layoutSane
      },
      vertexBuffer0: {
        bufferIndex: m0.vertexBuffer0.bufferIndex,
        layoutIndex: m0.vertexBuffer0.layoutIndex,
        vertexSize: m0.vertexBuffer0.vertexSize,
        vertexCount: m0.vertexBuffer0.vertexCount,
        layoutSane: m0.vertexBuffer0.layoutSane
      }
    },
    layout0: {
      memberCount: layout0.memberCount,
      members: layout0.members.map((m) => ({
        structOffset: m.structOffset,
        type: m.type,
        semantic: m.semantic,
        semanticIndex: m.semanticIndex
      })),
      layoutSane: layout0.layoutSane
    },
    deeperFields: [
      'boundingBoxOffset',
      'boneIndicesOffset',
      'boneIndicesSample',
      'faceSetCount',
      'faceSetOffset',
      'faceSet0.header',
      'vertexBufferCount',
      'vertexBufferOffset',
      'vertexBuffer0.header',
      'bufferLayouts.member0..N',
      'layoutSane'
    ],
    noGeometryDecode: true,
    noIndexPayloadDecode: true,
    noBoneHierarchy: true,
    noVertexStreamDecode: true,
    noWriter: true
  }, null, 2));
}

main();
