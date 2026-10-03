import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('native publish rejects incompatible host and target instead of reusing a stale library', async () => {
  const dotnet = process.env.SOULFORGE_DOTNET || 'dotnet';
  const result = spawnSync(dotnet, ['msbuild', resolve('bridge/SoulForge.Bridge/SoulForge.Bridge.csproj'),
    '-t:PublishFirstPartyHksNative', '-p:OS=Windows_NT', '-p:RuntimeIdentifier=linux-x64', '-nologo'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'unsupported cross-target publish must fail');
  assert.match(result.stdout + result.stderr, /FIRST_PARTY_HKS_NATIVE_CROSS_TARGET_UNSUPPORTED/);
});

test('first-party HKS native build produces an isolated Linux ELF library', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-linux-hks-build-'));
  try {
    const result = spawnSync(process.execPath, [resolve('scripts/build-first-party-hksc-native.mjs'), '--output', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(join(root, 'libSoulForge.Hksc.Native.so'));
    assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    assert.equal(bytes[4], 2, 'ELF64 target');
    assert.equal(bytes.readUInt16LE(16), 3, 'shared object');
    assert.equal(bytes.readUInt16LE(18), 62, 'x86-64 machine');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows native build creates a fresh x64 DLL when the caller PATH nearly fills cmd capacity', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-windows-hks-long-path-'));
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const callerPath = process.env[pathKey] ?? '';
  let longPath = callerPath;
  for (let index = 0; longPath.length < 7_900; index += 1) {
    longPath += ';' + join(root, `unused-caller-tool-${index}`);
  }
  const env = { ...process.env, [pathKey]: longPath };
  try {
    const output = join(root, 'SoulForge.Hksc.Native.dll');
    await assert.rejects(readFile(output), { code: 'ENOENT' }, 'the build must start without a reusable DLL');
    const result = spawnSync(process.execPath, [resolve('scripts/build-first-party-hksc-native.mjs'), '--output', root], {
      env, encoding: 'utf8', timeout: 120_000
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const bytes = await readFile(output);
    assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt32LE(pe), 0x00004550, 'PE signature');
    assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'x64 target');
    assert.ok(bytes.readUInt16LE(pe + 22) & 0x2000, 'DLL image');
    assert.equal(process.env[pathKey], callerPath, 'the caller environment must remain unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed production ABI compiles both wire formats and rejects malformed source', { skip: !['linux', 'win32'].includes(process.platform) }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-linux-hks-runtime-'));
  const dotnet = process.env.SOULFORGE_DOTNET || 'dotnet';
  const env = { ...process.env, DOTNET_CLI_HOME: join(root, 'dotnet-home'),
    NUGET_PACKAGES: join(root, 'nuget-packages'), NUGET_HTTP_CACHE_PATH: join(root, 'nuget-http'),
    NUGET_PLUGINS_CACHE_PATH: join(root, 'nuget-plugins') };
  try {
    const source = resolve('bridge/SoulForge.Bridge/FirstParty').replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    await writeFile(join(root, 'Fixture.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Compile Include="${source}/HksNativeCompiler.cs" Link="HksNativeCompiler.cs" /><Compile Include="${source}/HksSemanticService.cs" Link="HksSemanticService.cs" /><Compile Include="${source}/HksDecompiler/**/*.cs" /></ItemGroup></Project>`);
    await writeFile(join(root, 'Program.cs'), `using System.Text;
if(!HksNativeCompiler.IsAvailable) throw new Exception("Native compiler unavailable");
foreach(var lua50 in new[]{false,true}) {
 if(!HksNativeCompiler.TryCompile(Encoding.UTF8.GetBytes("function update(arg) return 42 end"),out var bytes,out var error,out var code,lua50)) throw new Exception(code+":"+error);
 if(bytes.Length<16 || bytes[0]!=0x1b || Encoding.ASCII.GetString(bytes,1,3)!="Lua" || bytes[4]!=(lua50?0x50:0x51)) throw new Exception("Wrong bytecode format");
 if(HksNativeCompiler.TryCompile(Encoding.UTF8.GetBytes("function broken("),out var invalid,out _,out var failure,lua50) || invalid.Length!=0 || failure!="HKS_COMPILER_FAILED") throw new Exception("Malformed source accepted");
 Console.WriteLine(lua50?"Lua50 verified":"HKS verified");
}
if(!HksNativeCompiler.TryCompile(Encoding.UTF8.GetBytes("return \\\"日本\\\""),out var japanese,out var encodingError,out _,true)) throw new Exception(encodingError);
var hex=Convert.ToHexString(japanese);
if(!hex.Contains("93FA967B") || hex.Contains("E697A5E69CAC")) throw new Exception("Lua50 strings are not CP932");
var read=HksSemanticService.Read(japanese);
if(!read.Ok || read.SourceText?.Contains("日本")!=true) throw new Exception("CP932 reader round-trip failed: "+read.SourceText+read.Message);
var invalidEncoding=(byte[])japanese.Clone();
for(var i=0;i<invalidEncoding.Length-3;i++) if(invalidEncoding[i]==0x93&&invalidEncoding[i+1]==0xfa&&invalidEncoding[i+2]==0x96&&invalidEncoding[i+3]==0x7b) {invalidEncoding[i]=0x81;invalidEncoding[i+1]=0x20;break;}
if(HksSemanticService.Read(invalidEncoding).Ok) throw new Exception("Malformed CP932 accepted");
if(HksNativeCompiler.TryCompile(Encoding.UTF8.GetBytes("return \\\"😀\\\""),out var unsupported,out _,out var unsupportedCode,true) || unsupported.Length!=0 || unsupportedCode!="HKS_COMPILER_FAILED") throw new Exception("Unrepresentable CP932 string accepted");
Console.WriteLine("CP932 verified");`);
    const build = spawnSync(dotnet, ['build', join(root, 'Fixture.csproj'), '-c', 'Release', '--nologo'], { env, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const output = join(root, 'bin/Release/net10.0');
    const native = spawnSync(process.execPath, [resolve('scripts/build-first-party-hksc-native.mjs'), '--output', output], { env, encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    const runtime = spawnSync(dotnet, [join(output, 'Fixture.dll')], { env, encoding: 'utf8' });
    assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
    assert.match(runtime.stdout, /HKS verified/); assert.match(runtime.stdout, /Lua50 verified/);
    assert.match(runtime.stdout, /CP932 verified/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
