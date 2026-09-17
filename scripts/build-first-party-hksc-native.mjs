import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const sourceRoot = resolve(root, 'bridge/native/hksc');
const sourceFiles = [
  'hksclib.c',
  'lapi.c',
  'lbitmap.c',
  'lcmp.c',
  'lcode.c',
  'ldebug.c',
  'ldo.c',
  'ldump.c',
  'lfunc.c',
  'lgc.c',
  'llex.c',
  'llist.c',
  'lmem.c',
  'lobject.c',
  'lopcodes.c',
  'lparser.c',
  'lprint.c',
  'lprintf.c',
  'lprintk.c',
  'lstate.c',
  'lstring.c',
  'lstruct.c',
  'ltable.c',
  'lundump.c',
  'lzio.c',
  'soulforge_hksc_bridge.c'
];

function parseOutput() {
  const index = process.argv.indexOf('--output');
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error('用法：node scripts/build-first-party-hksc-native.mjs --output <directory>');
  }
  const value = process.argv[index + 1].replace(/^\"|\"$/g, '').replace(/[\\/]+$/g, '');
  return resolve(value);
}

function findVisualStudioDevCmd() {
  const explicit = process.env.SOULFORGE_VSDEVCMD;
  const candidates = [
    explicit,
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat'
  ].filter(Boolean);
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error('FIRST_PARTY_HKS_NATIVE_TOOLCHAIN_MISSING: 未找到 Visual Studio Build Tools。');
  }
  return candidate;
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('FIRST_PARTY_HKS_NATIVE_WINDOWS_ONLY: Sekiro HKS native compiler 只为 Windows Bridge 构建。');
  }
  const outputDir = parseOutput();
  await mkdir(outputDir, { recursive: true });
  for (const file of sourceFiles) {
    if (!existsSync(join(sourceRoot, file))) {
      throw new Error(`FIRST_PARTY_HKS_NATIVE_SOURCE_MISSING: ${file}`);
    }
  }

  const temp = await mkdtemp(join(tmpdir(), 'soulforge-hksc-build-'));
  try {
    const responseFile = join(temp, 'cl.rsp');
    const commandFile = join(temp, 'build.cmd');
    const args = [
      '/nologo',
      '/LD',
      '/O2',
      '/D_CRT_SECURE_NO_WARNINGS',
      '/DLUA_BUILD_AS_DLL',
      '/DLUA_CORE',
      `/I"${sourceRoot}"`,
      `/Fe:"${join(outputDir, 'SoulForge.Hksc.Native.dll')}"`,
      ...sourceFiles.map((file) => `"${join(sourceRoot, file)}"`)
    ];
    await writeFile(responseFile, `${args.join('\r\n')}\r\n`, 'ascii');
    const devCmd = findVisualStudioDevCmd();
    await writeFile(commandFile, `@echo off\r\ncall "${devCmd}" -arch=x64\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl @"${responseFile}"\r\n`, 'ascii');
    const result = spawnSync('cmd.exe', ['/d', '/c', commandFile], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`FIRST_PARTY_HKS_NATIVE_BUILD_FAILED: cl exit ${result.status ?? 'unknown'}${result.error ? ` (${result.error.message})` : ''}`);
    }
    const output = join(outputDir, 'SoulForge.Hksc.Native.dll');
    if (!existsSync(output)) throw new Error(`FIRST_PARTY_HKS_NATIVE_OUTPUT_MISSING: ${output}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
