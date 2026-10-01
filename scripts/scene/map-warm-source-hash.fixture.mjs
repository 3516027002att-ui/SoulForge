import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { mapValidationProducer } from './mapValidationProducer.mjs';

const { dll, dotnet, skip } = mapValidationProducer();
test('warm MAP hashes every current byte with bounded allocation and safe cancellation/release',
  { skip }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-map-warm-hash-'));
    try {
      // Independent minimal FLVER2, padded to expose source-sized allocation.
      // Geometry stays three vertices/one triangle; this is not a page-wide budget.
      const b = Buffer.alloc(6 * 1024 * 1024), i32 = (at, n) => b.writeInt32LE(n, at);
      const refs = 276, dataStart = 284;
      b.write('FLVER\0'); b.write('L\0', 6); i32(8, 0x20014); i32(12, dataStart); i32(16, 42);
      for (const at of [32, 36, 64, 68, 80, 84]) i32(at, 1);
      b[72] = 16; for (const at of [52, 56, 60]) b.writeFloatLE(1, at);
      i32(132, -1); i32(144, -1); i32(160, 1); i32(164, refs); i32(168, 1); i32(172, refs + 4);
      i32(184, 3); i32(188, 36); i32(200, 16); i32(216, 12); i32(220, 3); i32(232, 36);
      i32(240, 1); i32(252, 256); i32(264, 2);
      b.writeFloatLE(1, dataStart + 12); b.writeFloatLE(1, dataStart + 28);
      [0, 1, 2].forEach((n, i) => b.writeUInt16LE(n, dataStart + 36 + i * 2));
      await writeFile(join(root, 'source.flver'), b);
      await writeFile(join(root, 'Program.cs'), await readFile(new URL('./mapWarmSourceHashProbe.cs', import.meta.url)));
      await writeFile(join(root, 'Probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseAppHost>false</UseAppHost><SelfContained>false</SelfContained><NuGetAudit>false</NuGetAudit><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup></Project>');
      const build = spawnSync(dotnet, ['build', join(root, 'Probe.csproj'), '-c', 'Release', '--nologo'],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DOTNET_CLI_HOME: join(root, 'dotnet-home'),
          DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
      assert.equal(build.status, 0, build.stdout + build.stderr);
      const run = spawnSync(dotnet, [join(root, 'bin/Release/net10.0/Probe.dll'), resolve(dll), join(root, 'source.flver')],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.passed, true);
      assert.ok(report.controls.every(c => c.passed || c.status === 'not_run'));
      console.log(JSON.stringify(report));
      if (process.platform === 'linux') {
        // Failure to read observer state must release the gated native worker,
        // restore the owned source, and fail promptly rather than hanging.
        const failure = spawnSync(dotnet, [join(root, 'bin/Release/net10.0/Probe.dll'), resolve(dll),
          join(root, 'source.flver'), join(root, 'missing-proc')],
          { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
        assert.ok(failure.status !== 0 || failure.signal, 'Unavailable observer must fail closed');
        assert.notEqual(failure.error?.code, 'ETIMEDOUT', 'Observer failure left the native thread blocked');
        assert.ok(failure.stderr.includes('DirectoryNotFoundException'), failure.stderr);
        assert.deepEqual(await readFile(join(root, 'source.flver')), b, 'Observer failure must restore source bytes');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
