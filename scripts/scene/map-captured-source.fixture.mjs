import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { triangleFlver, singleFlverBinder } from './mapFixtureHelpers.mjs';
import { mapValidationProducer } from './mapValidationProducer.mjs';

function dflt(payload) {
  const compressed = deflateSync(payload), bytes = Buffer.alloc(0x4c + compressed.length);
  bytes.write('DCX\0'); bytes.writeUInt32BE(0x10000, 4); bytes.writeUInt32BE(0x18, 8);
  bytes.writeUInt32BE(0x24, 12); bytes.writeUInt32BE(0x24, 16); bytes.writeUInt32BE(0x2c, 20);
  bytes.write('DCS\0', 0x18); bytes.writeUInt32BE(payload.length, 0x1c); bytes.writeUInt32BE(compressed.length, 0x20);
  bytes.write('DCP\0', 0x24); bytes.write('DFLT', 0x28); bytes.writeUInt32BE(0x20, 0x2c); bytes[0x30] = 9;
  bytes.writeUInt32BE(0x00010100, 0x40); bytes.write('DCA\0', 0x44); bytes.writeUInt32BE(8, 0x48);
  compressed.copy(bytes, 0x4c); return bytes;
}
const { dll, dotnet, skip } = mapValidationProducer();
test('MAP cold reopen and unknown-token fallback bind actual compressed bytes despite identical metadata',
  { skip }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-map-captured-source-'));
    try {
      const a = dflt(singleFlverBinder(triangleFlver(326, 1))), b = dflt(singleFlverBinder(triangleFlver(326, 2)));
      const size = Math.max(a.length, b.length), original = Buffer.alloc(size), replacement = Buffer.alloc(size);
      a.copy(original); b.copy(replacement);
      await writeFile(join(root, 'source.mapbnd.dcx'), original); await writeFile(join(root, 'replacement.mapbnd.dcx'), replacement);
      await writeFile(join(root, 'Program.cs'), await readFile(new URL('./mapCapturedSourceProbe.cs', import.meta.url)));
      await writeFile(join(root, 'Probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseAppHost>false</UseAppHost><SelfContained>false</SelfContained><NuGetAudit>false</NuGetAudit><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup></Project>');
      const build = spawnSync(dotnet, ['build', join(root, 'Probe.csproj'), '-c', 'Release', '--nologo'],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DOTNET_CLI_HOME: join(root, 'dotnet-home'),
          DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
      assert.equal(build.status, 0, build.stdout + build.stderr);
      for (const extension of ['mapbnd.dcx', 'flver.dcx']) {
        if (extension === 'flver.dcx') {
          const a = dflt(triangleFlver(326, 1)), b = dflt(triangleFlver(326, 2));
          const size = Math.max(a.length, b.length), original = Buffer.alloc(size), replacement = Buffer.alloc(size);
          a.copy(original); b.copy(replacement);
          await writeFile(join(root, `source.${extension}`), original);
          await writeFile(join(root, `replacement.${extension}`), replacement);
        }
        const run = spawnSync(dotnet, [join(root, 'bin/Release/net10.0/Probe.dll'), resolve(dll),
          join(root, `source.${extension}`), join(root, `replacement.${extension}`)],
          { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        console.log(run.stdout.trim());
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
