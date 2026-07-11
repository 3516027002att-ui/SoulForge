/**
 * FLVER candidate header probe smoke (synthetic fixture only).
 */
import {
  buildSyntheticFlverHeaderFixture,
  probeFlverCandidate
} from '../scene/flverCandidate.js';

function main(): void {
  const bad = probeFlverCandidate(Buffer.from('NOTFLVER............'));
  if (bad.authority !== 'unsupported') throw new Error('expected unsupported');

  const fixture = buildSyntheticFlverHeaderFixture({ meshCount: 3, materialCount: 2, boneCount: 4 });
  const report = probeFlverCandidate(fixture);
  if (report.authority !== 'candidate') {
    throw new Error(`expected candidate: ${JSON.stringify(report.diagnostics)}`);
  }
  if (report.meshCount !== 3 || report.materialCount !== 2 || report.boneCount !== 4) {
    throw new Error(`counts mismatch: ${JSON.stringify(report)}`);
  }
  if (!report.meshes || report.meshes.length !== 3) {
    throw new Error(`expected 3 mesh table rows, got ${report.meshes?.length}`);
  }
  if (report.meshes[0]!.field0 !== 1 || report.meshes[2]!.field0 !== 3) {
    throw new Error(`mesh table fields unexpected: ${JSON.stringify(report.meshes)}`);
  }
  if (!report.diagnostics.some((d) => d.code === 'FLVER_MESH_TABLE_CANDIDATE')) {
    throw new Error('missing mesh table diagnostic');
  }
  if (report.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error('unexpected errors');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'FLVER candidate 头 + mesh 表探测验证通过（无完整几何/无 writer）',
    authority: report.authority,
    meshCount: report.meshCount,
    meshRows: report.meshes.length,
    materialCount: report.materialCount,
    boneCount: report.boneCount,
    version: report.version
  }, null, 2));
}

main();
