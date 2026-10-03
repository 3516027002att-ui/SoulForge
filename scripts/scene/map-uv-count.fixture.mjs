import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { triangleFlver } from './mapFixtureHelpers.mjs';
import { mapValidationProducer } from './mapValidationProducer.mjs';

function withUv(type) {
  const base = triangleFlver(), bytes = Buffer.alloc(370);
  base.copy(bytes, 0, 0, 276);
  const i32 = (at, value) => bytes.writeInt32LE(value, at);
  i32(12, 304); i32(16, 66); i32(164, 296); i32(172, 300);
  i32(188, 60); i32(216, 20); i32(232, 60); i32(240, 2);
  i32(280, 12); i32(284, type); i32(288, 5);
  bytes.writeFloatLE(1, 324); bytes.writeFloatLE(1, 348);
  [0, 1, 2].forEach((n, i) => bytes.writeUInt16LE(n, 364 + i * 2));
  return bytes;
}
const { dll, dotnet, skip } = mapValidationProducer();
test('native zero/single/paired UV counts remain exact with bounded repeated-query allocation', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-map-uv-count-'));
  try {
    await writeFile(join(root, 'Program.cs'), await readFile(new URL('./mapUvCountProbe.cs', import.meta.url)));
    await writeFile(join(root, 'Probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseAppHost>false</UseAppHost><SelfContained>false</SelfContained><NuGetAudit>false</NuGetAudit><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup></Project>');
    const build = spawnSync(dotnet, ['build', join(root, 'Probe.csproj'), '-c', 'Release', '--nologo'],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DOTNET_CLI_HOME: join(root, 'dotnet-home'),
        DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const runs = [];
    for (const [expected, bytes] of [[0, triangleFlver()], [1, withUv(0x01)], [2, withUv(0x16)]]) {
      const path = join(root, `${expected}.flver`); await writeFile(path, bytes);
      const run = spawnSync(dotnet, [join(root, 'bin/Release/net10.0/Probe.dll'), resolve(dll), path, String(expected)],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
      runs.push(run); console.log(run.stdout.trim());
    }
    assert.ok(runs.every(run => run.status === 0), runs.map(run => run.stdout + run.stderr).join('\n'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
