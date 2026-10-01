import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const producer = process.env.SF_TEST_BRIDGE_DLL;
if (!producer) throw new Error('SF_TEST_BRIDGE_DLL must name a locally built Bridge DLL');
const dotnet = process.env.SOULFORGE_DOTNET ?? 'dotnet';
const directory = await mkdtemp(join(tmpdir(), 'sf-flver-document-budget-'));
try {
  await mkdir(join(directory, 'empty-source'));
  const env = { ...process.env, DOTNET_CLI_HOME: join(directory, 'dotnet-home'), NUGET_PACKAGES: join(directory, 'packages'), DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false' };
  await writeFile(join(directory, 'Probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>');
  await writeFile(join(directory, 'Program.cs'), String.raw`
using System.Buffers.Binary;
using System.Reflection;
using System.Text.Json;

// Shared native GX bytes keep the source tiny. The parser's own document is
// constructed before measuring only the actual material projection operation.
const int materialCount = 200, gxItems = 128;
var gxOffset = 128 + materialCount * 32;
var strings = gxOffset + gxItems * 16 + 12;
var bytes = new byte[strings + 2];
void I32(int at, int value) => BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(at, 4), value);
"FLVER\0"u8.CopyTo(bytes); "L\0"u8.CopyTo(bytes.AsSpan(6));
I32(8, 0x20014); I32(12, gxOffset); I32(16, bytes.Length - gxOffset);
I32(24, materialCount); bytes[73] = 1;
for (var index = 0; index < materialCount; index++)
{
    var at = 128 + index * 32;
    I32(at, strings); I32(at + 4, strings); I32(at + 16, 4);
    I32(at + 20, gxOffset); I32(at + 24, index);
}
for (var index = 0; index < gxItems; index++)
{
    var at = gxOffset + index * 16;
    "GX00"u8.CopyTo(bytes.AsSpan(at)); I32(at + 4, 100); I32(at + 8, 16);
}
I32(strings - 12, int.MaxValue); I32(strings - 8, 100); I32(strings - 4, 12);
var assembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
var type = assembly.GetType("FlverNativeDocument", true)!;
var document = type.GetMethod("Read", BindingFlags.Public | BindingFlags.Static)!.Invoke(null, new object[] { bytes })!;
var project = type.GetMethod("GetMaterialMetadata", BindingFlags.Public | BindingFlags.Instance)!;
// Warm the shared projection path without retaining its objects.
_ = ((IEnumerable<object>)project.Invoke(document, null)!).Take(1).ToArray();
var before = GC.GetAllocatedBytesForCurrentThread();
var sample = ((IEnumerable<object>)project.Invoke(document, null)!).Take(10).ToArray();
var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
if (sample.Length != 10 || allocated > 512 * 1024)
    throw new InvalidDataException($"Sampled metadata projected too much: count={sample.Length}, allocatedBytes={allocated}");
Console.WriteLine(JsonSerializer.Serialize(new { ok = true, materials = materialCount, gxItemsPerMaterial = gxItems, sampleRows = sample.Length, allocatedBytes = allocated, maximumAllocatedBytes = 512 * 1024 }));
`);
  for (const args of [['restore', 'Probe.csproj', '--source', join(directory, 'empty-source')], ['build', 'Probe.csproj', '-c', 'Release', '--no-restore']]) {
    const result = spawnSync(dotnet, args, { env, cwd: directory, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const result = spawnSync(dotnet, [join(directory, 'bin/Release/net10.0/Probe.dll'), resolve(producer)], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(result.stdout.trim());
} finally {
  await rm(directory, { recursive: true, force: true });
}
