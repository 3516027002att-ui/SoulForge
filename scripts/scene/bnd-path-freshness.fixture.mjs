import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { triangleFlver, singleFlverBinder, dfltDcx } from './mapFixtureHelpers.mjs';
import { mapValidationProducer } from './mapValidationProducer.mjs';

const { dll, dotnet, skip } = mapValidationProducer();
test('public BND path reads and extraction verify current bytes while retaining unchanged decoded reuse', { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-bnd-path-freshness-'));
  try {
    const child = triangleFlver(326, 2);
    const a = dfltDcx(singleFlverBinder(triangleFlver(326, 1))), b = dfltDcx(singleFlverBinder(child));
    const size = Math.max(a.length, b.length), original = Buffer.alloc(size), replacement = Buffer.alloc(size);
    a.copy(original); b.copy(replacement);
    await writeFile(join(root, 'source.parambnd.dcx'), original);
    await writeFile(join(root, 'replacement.parambnd.dcx'), replacement); await writeFile(join(root, 'expected.flver'), child);
    await writeFile(join(root, 'expected.bnd'), singleFlverBinder(child));
    await writeFile(join(root, 'Program.cs'), await readFile(new URL('./bndPathFreshnessProbe.cs', import.meta.url)));
    await writeFile(join(root, 'Probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseAppHost>false</UseAppHost><SelfContained>false</SelfContained><NuGetAudit>false</NuGetAudit><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup></Project>');
    const build = spawnSync(dotnet, ['build', join(root, 'Probe.csproj'), '-c', 'Release', '--nologo'],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DOTNET_CLI_HOME: join(root, 'dotnet-home'),
        DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const runs = [];
    for (const metadataOnly of [false, true]) {
      if (metadataOnly) {
        const child = triangleFlver(326, 1), payload = singleFlverBinder(child, 'replacementFixture.flver');
        const a = dfltDcx(singleFlverBinder(child)), b = dfltDcx(payload);
        const original = Buffer.alloc(Math.max(a.length, b.length)), replacement = Buffer.alloc(original.length);
        a.copy(original); b.copy(replacement);
        await writeFile(join(root, 'source.parambnd.dcx'), original);
        await writeFile(join(root, 'replacement.parambnd.dcx'), replacement);
        await writeFile(join(root, 'expected.flver'), child); await writeFile(join(root, 'expected.bnd'), payload);
      }
      const run = spawnSync(dotnet, [join(root, 'bin/Release/net10.0/Probe.dll'), resolve(dll),
        join(root, 'source.parambnd.dcx'), join(root, 'replacement.parambnd.dcx'), join(root, 'expected.flver'),
        join(root, 'expected.bnd'), metadataOnly ? 'replacementFixture.flver' : 'allocationFixture.flver'],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
      runs.push(run);
      console.log(run.stdout.trim());
    }
    assert.ok(runs.every(run => run.status === 0), runs.map(run => run.stdout + run.stderr).join('\n'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
