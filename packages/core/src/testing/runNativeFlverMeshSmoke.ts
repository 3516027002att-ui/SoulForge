/**
 * Native FLVER smoke: read a real Sekiro FLVER and extract mesh vertex/index data.
 * Verifies the full pipeline: extract from container → read document → extract mesh data.
 *
 * Authority: candidate — read-only, no writer or game-load verification.
 */
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const source = await resolveNativeFixture(
    process.argv[2],
    'chrbnd-primary',
    '../../mods/chr/c1020.chrbnd.dcx'
  );
  const tmp = join(tmpdir(), 'soulforge-flver-mesh-smoke');
  mkdirSync(tmp, { recursive: true });
  const out = join(tmp, 'c1020.flver');

  // Extract FLVER from container.
  const ex = await runBridge<{ contentSize?: number }>({
    command: 'extract-bnd4-child',
    filePath: source,
    allowedRoots: [source.replace(/[/\\][^/\\]+$/, '')],
    writableRoots: [tmp],
    commandOptions: { childPath: 'c1020.flver', outputPath: out },
    timeoutMs: 120_000
  });
  if (!ex.data?.contentSize) {
    console.log(JSON.stringify({ ok: true, status: 'skipped', message: 'FLVER fixture not available.' }));
    await disposeBridgeDaemonPool();
    return;
  }

  // Read FLVER document.
  const doc = await runBridge<Record<string, unknown>>({
    command: 'read-flver-document',
    filePath: out,
    allowedRoots: [tmp],
    timeoutMs: 120_000
  });
  if (doc.parseStatus === 'failed' || !doc.data) {
    throw new Error(`FLVER read failed: ${JSON.stringify(doc.diagnostics)}`);
  }
  const meshCount = (doc.data.meshCount as number) ?? 0;
  if (meshCount <= 0) throw new Error('FLVER has no meshes');

  // Extract first mesh vertex/index data.
  const mesh = await runBridge<Record<string, unknown>>({
    command: 'read-flver-mesh',
    filePath: out,
    allowedRoots: [tmp],
    timeoutMs: 120_000,
    commandOptions: { meshIndex: 0 }
  });
  if (mesh.parseStatus === 'failed' || !mesh.data) {
    throw new Error(`FLVER mesh read failed: ${JSON.stringify(mesh.diagnostics)}`);
  }

  const positionsBase64 = mesh.data.positionsBase64 as string | undefined;
  const indicesBase64 = mesh.data.indicesBase64 as string | undefined;
  const vertexCount = (mesh.data.vertexCount as number) ?? 0;

  if (!positionsBase64) throw new Error('FLVER mesh has no position data');
  if (vertexCount <= 0) throw new Error('FLVER mesh has zero vertices');

  // Verify position data size (float[3] per vertex = 12 bytes per vertex).
  const posBytes = Buffer.from(positionsBase64, 'base64');
  const expectedPosSize = vertexCount * 3 * 4; // 3 floats × 4 bytes
  if (posBytes.length !== expectedPosSize) {
    throw new Error(`Position data size mismatch: got ${posBytes.length}, expected ${expectedPosSize}`);
  }

  // Verify first few positions are finite numbers.
  const positions = new Float32Array(posBytes.buffer, posBytes.byteOffset, vertexCount * 3);
  for (let i = 0; i < Math.min(9, positions.length); i++) {
    if (!Number.isFinite(positions[i])) {
      throw new Error(`Position[${i}] is not finite: ${positions[i]}`);
    }
  }

  // Extract and verify the skeleton hierarchy (parent index + translation).
  const skeleton = await runBridge<Record<string, unknown>>({
    command: 'read-flver-skeleton',
    filePath: out,
    allowedRoots: [tmp],
    timeoutMs: 120_000
  });
  if (skeleton.parseStatus === 'failed' || !skeleton.data) {
    throw new Error(`FLVER skeleton read failed: ${JSON.stringify(skeleton.diagnostics)}`);
  }
  const skBones = (skeleton.data.bones as Array<{
    index: number; name: string; parentIndex: number; translation: number[];
  }>) ?? [];
  const skBoneCount = (skeleton.data.boneCount as number) ?? 0;
  if (skBoneCount <= 0 || skBones.length !== skBoneCount) {
    throw new Error(`FLVER skeleton bone count mismatch: boneCount=${skBoneCount}, bones=${skBones.length}`);
  }
  // Every bone must have a finite translation and a parent in [-1, boneCount).
  for (const b of skBones) {
    if (!Array.isArray(b.translation) || b.translation.length !== 3
      || !b.translation.every(Number.isFinite)) {
      throw new Error(`Bone[${b.index}] has invalid translation: ${JSON.stringify(b.translation)}`);
    }
    if (b.parentIndex < -1 || b.parentIndex >= skBoneCount) {
      throw new Error(`Bone[${b.index}] has out-of-range parentIndex: ${b.parentIndex}`);
    }
  }
  // The hierarchy must be acyclic (following parent chains terminates).
  for (let i = 0; i < skBones.length; i++) {
    const seen = new Set<number>();
    let cur = i;
    while (cur !== -1) {
      if (seen.has(cur)) throw new Error(`Bone hierarchy cycle detected at bone ${cur}`);
      seen.add(cur);
      cur = skBones[cur]?.parentIndex ?? -1;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    message: `FLVER native mesh 提取验证通过（mesh[0]: ${vertexCount} vertices, ${posBytes.length} bytes positions; skeleton: ${skBoneCount} bones）`,
    meshCount,
    vertexCount,
    positionBytes: posBytes.length,
    hasIndices: Boolean(indicesBase64),
    indexBytes: indicesBase64 ? Buffer.from(indicesBase64, 'base64').length : 0,
    samplePositions: Array.from(positions.slice(0, 9)),
    skeletonBoneCount: skBoneCount,
    skeletonRoots: skBones.filter((b) => b.parentIndex === -1).length,
    authority: 'candidate',
    roundTrip: doc.diagnostics?.map((d: { code: string }) => d.code)
  }, null, 2));

  await disposeBridgeDaemonPool();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
