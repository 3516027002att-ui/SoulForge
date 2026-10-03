import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { triangleFlver } from './mapFixtureHelpers.mjs';
import { mapValidationProducer } from './mapValidationProducer.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function twoTriangleFlver() {
  // Extend the maintained independent fixture to two disjoint triangles.
  const dataStart = 284, bytes = triangleFlver(dataStart + 6 * 12 + 6 * 2);
  bytes.writeInt32LE(84, 16); // Declared data bytes: six positions and six uint16 indices.
  bytes.writeInt32LE(6, 184); // FaceSet index count.
  bytes.writeInt32LE(72, 188); // FaceSet index offset within data.
  bytes.writeInt32LE(6, 220); // VertexBuffer vertex count.
  bytes.writeInt32LE(72, 232); // VertexBuffer byte length.
  const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [2, 0, 0], [3, 0, 0], [2, 1, 0]];
  vertices.flat().forEach((value, index) => bytes.writeFloatLE(value, dataStart + index * 4));
  [0, 1, 2, 3, 4, 5].forEach((value, index) => bytes.writeUInt16LE(value, dataStart + 72 + index * 2));
  return bytes;
}

const { dll, dotnet, skip } = mapValidationProducer();
test('actual native JSON counter preserves default lengths, exceptions, thresholds and bounded chunk shrink', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-map-json-byte-count-'));
  const producer = resolve(dll);
  let producerHash;
  try {
    producerHash = hash(await readFile(producer));
    const two = twoTriangleFlver(), one = Buffer.from(two);
    one.writeInt32LE(3, 184); // Same six-vertex layout, only the first triangle is selected.
    const shared = Buffer.from(two);
    [2, 1, 3].forEach((value, index) => shared.writeUInt16LE(value, 284 + 72 + 6 + index * 2));
    const twoPath = join(root, 'two.flver'), onePath = join(root, 'one.flver'), sharedPath = join(root, 'shared.flver');
    await writeFile(twoPath, two); await writeFile(onePath, one); await writeFile(sharedPath, shared);
    await writeFile(join(root, 'Program.cs'), await readFile(new URL('./mapJsonByteCountProbe.cs', import.meta.url)));
    await writeFile(join(root, 'Probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseAppHost>false</UseAppHost><SelfContained>false</SelfContained><NuGetAudit>false</NuGetAudit><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup></Project>');
    const build = spawnSync(dotnet, ['build', join(root, 'Probe.csproj'), '-c', 'Release', '--nologo'], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, DOTNET_CLI_HOME: join(root, 'dotnet-home'),
        DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1' }
    });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const run = spawnSync(dotnet, [join(root, 'bin/Release/net10.0/Probe.dll'), producer, twoPath, onePath, sharedPath],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const report = JSON.parse(run.stdout.trim());
    assert.equal(report.passed, true);
    assert.equal(report.producerHash, producerHash);
    assert.equal(report.buildChunk, 'executed');
    assert.deepEqual(report.controls.map(control => control.kind), [
      'two-triangle-one-prefix-shrink', 'opaque-continuation-no-skip-or-replay', 'one-triangle-serialized-budget-failure',
      'shared-triangle-first-seen-order'
    ]);
    assert.ok(report.controls.every(control => control.passed));
    assert.equal(hash(await readFile(twoPath)), hash(two));
    assert.equal(hash(await readFile(onePath)), hash(one));
    assert.equal(hash(await readFile(sharedPath)), hash(shared));
    console.log(run.stdout.trim());
  } finally {
    try {
      if (producerHash !== undefined)
        assert.equal(hash(await readFile(producer)), producerHash, 'Compiled producer changed during fixture');
    }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
