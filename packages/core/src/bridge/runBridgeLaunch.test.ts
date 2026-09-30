import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { disposeBridgeDaemonPool, runBridge } from './runBridge.js';

// These are launch-selection integration tests. Test executables record the
// actual argv selected by runBridge; they are not native parser fixtures.
// Windows selection is simulated on Linux and does not prove Windows runtime.
describe('Bridge launch selection on a Linux host', { skip: process.platform !== 'linux' }, () => {
  let scratch: string;
  const properties = ['platform', 'arch', 'resourcesPath', 'defaultApp'] as const;
  const originals = new Map(properties.map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]));
  const originalDotnet = process.env.SOULFORGE_DOTNET;

  before(async () => { scratch = await mkdtemp(join(tmpdir(), 'soulforge-launch-')); });
  after(async () => {
    await disposeBridgeDaemonPool();
    for (const key of properties) {
      const descriptor = originals.get(key);
      if (descriptor) Object.defineProperty(process, key, descriptor);
      else delete (process as unknown as Record<string, unknown>)[key];
    }
    if (originalDotnet === undefined) delete process.env.SOULFORGE_DOTNET;
    else process.env.SOULFORGE_DOTNET = originalDotnet;
    await rm(scratch, { recursive: true, force: true });
  });

  async function exercise(label: string, options: {
    platform?: 'linux' | 'win32';
    nativeBuild?: 'publish' | 'release' | 'debug';
    windowsBuild?: boolean;
    explicit?: boolean;
    packaged?: boolean;
    packagedWindowsNeighbor?: boolean;
    missingPackaged?: boolean;
  } = {}) {
    const root = join(scratch, label);
    const project = join(root, 'bridge', 'SoulForge.Bridge', 'SoulForge.Bridge.csproj');
    const receipt = join(root, 'launch.json');
    const source = join(root, 'sample.bin');
    await mkdir(dirname(project), { recursive: true });
    await writeFile(project, '<Project Sdk="Microsoft.NET.Sdk" />');
    await writeFile(source, 'launch test only');
    Object.defineProperty(process, 'platform', { configurable: true, value: options.platform ?? 'linux' });
    Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
    delete (process as unknown as Record<string, unknown>).resourcesPath;
    delete (process as unknown as Record<string, unknown>).defaultApp;

    const executable = async (path: string, marker: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ marker: ${JSON.stringify(marker)}, args: process.argv.slice(2) }));\nprocess.exit(1);\n`);
      await chmod(path, 0o755);
      return path;
    };
    const dotnet = await executable(join(root, 'dotnet-probe'), 'dotnet');
    process.env.SOULFORGE_DOTNET = dotnet;
    if (options.nativeBuild) {
      const configuration = options.nativeBuild === 'debug' ? 'Debug' : 'Release';
      await executable(join(dirname(project), 'bin', configuration, 'net10.0', 'linux-x64',
        ...(options.nativeBuild === 'publish' ? ['publish'] : []), 'SoulForge.Bridge'), 'linux');
    }
    if (options.windowsBuild) {
      await executable(join(dirname(project), 'bin', 'Release', 'net10.0', 'win-x64', 'publish', 'SoulForge.Bridge.exe'), 'windows');
    }
    let explicit: string | undefined;
    if (options.explicit) explicit = await executable(join(root, 'explicit-bridge'), 'explicit');
    if (options.packaged) {
      const resources = join(root, 'resources');
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
      Object.defineProperty(process, 'defaultApp', { configurable: true, value: false });
      if (!options.missingPackaged) await executable(join(resources, 'bridge',
        options.platform === 'win32' ? 'SoulForge.Bridge.exe' : 'SoulForge.Bridge'), 'packaged');
      if (options.packagedWindowsNeighbor) await executable(join(resources, 'bridge', 'SoulForge.Bridge.exe'), 'wrong-packaged-windows');
    }
    const result = await runBridge({
      bridgeProjectPath: project,
      ...(explicit ? { bridgeExecutablePath: explicit } : {}),
      command: 'inspect', filePath: source, allowedRoots: [root], timeoutMs: 2_000
    });
    await disposeBridgeDaemonPool();
    if (options.missingPackaged && !options.explicit) {
      assert.equal(result.parseStatus, 'failed');
      assert.ok(result.diagnostics.some((item) => item.code === 'BRIDGE_PACKAGED_EXECUTABLE_MISSING'));
      await assert.rejects(readFile(receipt), { code: 'ENOENT' });
      return undefined;
    }
    return JSON.parse(await readFile(receipt, 'utf8')) as { marker: string; args: string[] };
  }

  for (const nativeBuild of ['publish', 'release', 'debug'] as const) {
    it(`starts the Linux ${nativeBuild} apphost instead of a neighboring Windows executable`, async () => {
      const actual = await exercise(`linux-${nativeBuild}`, { nativeBuild, windowsBuild: true });
      assert.equal(actual?.marker, 'linux');
      assert.deepEqual(actual.args, ['daemon']);
    });
  }
  it('overrides Windows project defaults in the Linux dotnet fallback', async () => {
    const actual = await exercise('linux-fallback');
    assert.equal(actual?.marker, 'dotnet');
    const args = actual.args;
    assert.equal(args[args.indexOf('--runtime') + 1], 'linux-x64');
    assert.ok(args.includes('-p:SelfContained=false'));
    assert.ok(args.includes('-p:PublishSingleFile=false'));
    assert.deepEqual(args.slice(-2), ['--', 'daemon']);
  });
  it('does not compile or restore while starting the Linux NDJSON daemon', async () => {
    const actual = await exercise('linux-no-build');
    assert.equal(actual?.marker, 'dotnet');
    assert.ok(actual.args.includes('--no-build'));
    assert.ok(actual.args.includes('--no-restore'));
  });
  it('preserves Windows executable discovery', async () => {
    const actual = await exercise('windows-build', { platform: 'win32', nativeBuild: 'publish', windowsBuild: true });
    assert.equal(actual?.marker, 'windows');
    assert.deepEqual(actual.args, ['daemon']);
  });
  it('preserves the Windows dotnet fallback arguments', async () => {
    const actual = await exercise('windows-fallback', { platform: 'win32' });
    assert.equal(actual?.marker, 'dotnet');
    assert.equal(actual.args.includes('--runtime'), false);
    assert.equal(actual.args.some((arg) => arg.startsWith('-p:')), false);
    assert.deepEqual(actual.args.slice(-3), ['--no-launch-profile', '--', 'daemon']);
  });
  it('preserves an explicitly supplied executable', async () => {
    const actual = await exercise('explicit', { nativeBuild: 'publish', explicit: true });
    assert.equal(actual?.marker, 'explicit');
  });
  it('keeps packaged executable resolution ahead of source builds', async () => {
    const actual = await exercise('packaged', { nativeBuild: 'publish', packaged: true });
    assert.equal(actual?.marker, 'packaged');
  });
  it('uses the native Linux packaged apphost even beside a Windows executable', async () => {
    const actual = await exercise('packaged-platform', { packaged: true, packagedWindowsNeighbor: true });
    assert.equal(actual?.marker, 'packaged');
  });
  it('preserves Windows packaged executable selection', async () => {
    const actual = await exercise('packaged-windows', { platform: 'win32', packaged: true });
    assert.equal(actual?.marker, 'packaged');
  });
  it('fails closed when the packaged Bridge is missing', async () => {
    await exercise('packaged-missing', { nativeBuild: 'publish', packaged: true, missingPackaged: true });
  });
});
