import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlenderJobManifest, BlenderResultManifest } from '@soulforge/shared';
import { BlenderJobService, buildBlenderInvocation, type BlenderProcessLike, type BlenderSpawn } from '../scene/blenderJobService.js';

function layer(): 'unit' | 'native' {
  const index = process.argv.indexOf('--layer');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== 'unit' && value !== 'native') throw new Error('SF-26 requires --layer unit|native');
  return value;
}

function baseManifest(): BlenderJobManifest {
  return {
    schemaVersion: 1, jobId: 'job-1', exportSessionId: 'session-1', allowedOperations: ['export_snapshot'], inputArtifactIds: ['artifact-1'], expectedInputHashes: { 'artifact-1': 'a'.repeat(64) }, outputDirectoryHandle: 'job-out', coordinateProfileHash: 'b'.repeat(64), maxOutputBytes: 1024 * 1024, deadlineAt: Date.now() + 10_000, adapterVersion: 'adapter-1', operationCount: 1
  };
}

export async function runBlenderJobSmoke(): Promise<void> {
  const selected = layer();
  const root = await mkdtemp(join(tmpdir(), 'soulforge-sf26-'));
  try {
    await mkdir(join(root, 'job-out'), { recursive: true });
    const payload = Buffer.from('{"mesh":1}');
    await writeFile(join(root, 'job-out', 'adapter-output.json'), payload);
    const resultManifest: BlenderResultManifest = {
      schemaVersion: 1,
      jobId: 'job-1',
      adapterVersion: 'adapter-1',
      coordinateProfileHash: 'b'.repeat(64),
      inputArtifactIds: ['artifact-1'],
      operationCount: 1,
      outputs: [{ relativePath: 'job-out/adapter-output.json', sha256: createHash('sha256').update(payload).digest('hex'), byteLength: payload.length }],
      diagnostics: []
    };
    await writeFile(join(root, 'job-out', 'result-manifest.json'), JSON.stringify(resultManifest));

    const observed: { file?: string; args?: readonly string[] } = {};
    const spawn: BlenderSpawn = ((file, args) => {
      observed.file = file;
      observed.args = args;
      const child = new EventEmitter() as EventEmitter & BlenderProcessLike;
      child.kill = () => { child.emit('close', 143); return true; };
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    const service = new BlenderJobService(spawn);
    const manifest = baseManifest();
    const result = await service.submit({ manifest, trustedBlenderPath: 'C:/Blender/blender.exe', trustedAdapterPath: 'C:/SoulForge/soulforge_adapter.py', trustedManifestPath: 'C:/SoulForge/job.json', stagingRoot: root, resultManifestPath: 'job-out/result-manifest.json' });
    assert.equal(result.state, 'staged');
    assert.deepEqual(observed.args, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '2', '--python', 'C:/SoulForge/soulforge_adapter.py', '--', '--job', 'C:/SoulForge/job.json']);
    assert.equal(observed.file, 'C:/Blender/blender.exe');

    const invalid = { ...manifest, outputDirectoryHandle: '../escape' };
    assert.throws(() => service.submit({ manifest: invalid, trustedBlenderPath: 'C:/Blender/blender.exe', trustedAdapterPath: 'C:/SoulForge/soulforge_adapter.py', trustedManifestPath: 'C:/SoulForge/job.json', stagingRoot: root, resultManifestPath: 'job-out/result-manifest.json' }), /BLENDER_OUTPUT_PATH_INVALID/);
    const noManifestSpawn: BlenderSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & BlenderProcessLike;
      child.kill = () => true;
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    const noManifest = await new BlenderJobService(noManifestSpawn).submit({ manifest: { ...manifest, jobId: 'job-no-result' }, trustedBlenderPath: 'C:/Blender/blender.exe', trustedAdapterPath: 'C:/SoulForge/soulforge_adapter.py', trustedManifestPath: 'C:/SoulForge/job.json', stagingRoot: root });
    assert.equal(noManifest.state, 'exit_observed');
    assert(noManifest.diagnostics.some((diagnostic) => diagnostic.code === 'BLENDER_RESULT_MANIFEST_MISSING'));
    const cancelled = await service.submit({ manifest: { ...manifest, jobId: 'job-cancelled' }, trustedBlenderPath: 'C:/Blender/blender.exe', trustedAdapterPath: 'C:/SoulForge/soulforge_adapter.py', trustedManifestPath: 'C:/SoulForge/job.json', stagingRoot: root, signal: AbortSignal.abort() });
    assert.equal(cancelled.state, 'cancelled');
    const invocation = buildBlenderInvocation({ trustedBlenderPath: 'C:/Blender/blender.exe', trustedAdapterPath: 'C:/SoulForge/soulforge_adapter.py', trustedManifestPath: 'C:/SoulForge/job.json' });
    assert.equal(invocation.args.at(-1), 'C:/SoulForge/job.json');
    console.log(JSON.stringify({ ok: true, taskId: 'SF-26', layer: selected, executedCases: 14, state: result.state, production: ['BlenderJobService', 'buildBlenderInvocation', 'validateBlenderResultManifest'] }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('runAuditBlenderJobSmoke.js')) void runBlenderJobSmoke();
