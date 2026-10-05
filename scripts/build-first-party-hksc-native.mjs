import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachOwnedTemporaryDirectory, createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';
import { createProcessCancellation, processSucceeded, runProcess } from './subprocess-control.mjs';

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
    process.env.VSINSTALLDIR ? join(process.env.VSINSTALLDIR, 'Common7/Tools/VsDevCmd.bat') : undefined,
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\Tools\\VsDevCmd.bat',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\Tools\\VsDevCmd.bat',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat'
  ].filter(Boolean);
  const candidate = candidates.find((path) => existsSync(path));
  if (candidate) return candidate;
  // Hosted images and local machines can have a newer Visual Studio layout.
  // Ask the installer for an actual C++ toolchain instead of guessing its year.
  const vswhere = [
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe') : undefined,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Microsoft Visual Studio/Installer/vswhere.exe') : undefined,
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe'
  ].filter(Boolean).find((path) => existsSync(path));
  if (vswhere) {
    try {
      const installations = execFileSync(vswhere, [
        '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath'
      ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim().split(/\r?\n/).filter(Boolean);
      const discovered = installations.map((path) => join(path, 'Common7/Tools/VsDevCmd.bat')).find((path) => existsSync(path));
      if (discovered) return discovered;
    } catch { /* Preserve the structured missing-toolchain diagnosis below. */ }
  }
  throw new Error('FIRST_PARTY_HKS_NATIVE_TOOLCHAIN_MISSING: Visual Studio C++ Build Tools were not found.');
}

function createWindowsCompilerEnvironment(env = process.env) {
  const child = { ...env };
  const systemRoot = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1]
    ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'WINDIR')?.[1];
  if (!systemRoot) throw new Error('FIRST_PARTY_HKS_NATIVE_WINDOWS_ENV_MISSING: SystemRoot was not found.');
  // VsDevCmd supplies the selected MSVC/SDK paths. Inheriting npm's and the
  // caller's tool paths can exceed cmd's 8191-character expansion limit before
  // cl even reads its response file. Change only this owned child's search path.
  for (const key of Object.keys(child)) {
    if (['PATH', '__VSCMD_PREINIT_PATH'].includes(key.toUpperCase())) delete child[key];
  }
  child.PATH = [join(systemRoot, 'System32'), systemRoot,
    join(systemRoot, 'System32/Wbem'), join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(';');
  return child;
}

async function main() {
  if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') {
    throw new Error('FIRST_PARTY_HKS_NATIVE_PLATFORM_UNSUPPORTED: HKS native build supports Windows/Linux x64.');
  }
  const outputDir = parseOutput();
  await mkdir(outputDir, { recursive: true });
  for (const file of sourceFiles) {
    if (!existsSync(join(sourceRoot, file))) {
      throw new Error(`FIRST_PARTY_HKS_NATIVE_SOURCE_MISSING: ${file}`);
    }
  }

  const workspace = await createOwnedTemporaryDirectory('hksc-build');
  const cancellation = createProcessCancellation();
  const temp = workspace.root;
  try {
    const outputOwnerIndex = process.argv.indexOf('--owned-output-root');
    const outputOwner = outputOwnerIndex < 0 ? null : await attachOwnedTemporaryDirectory(process.argv[outputOwnerIndex + 1]);
    if (outputOwner) {
      const path = relative(outputOwner.root, outputDir);
      if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('FIRST_PARTY_HKS_NATIVE_OUTPUT_OWNER_MISMATCH');
    }
    const processOwner = !outputOwner ? workspace : {
      async trackProcess(pid, options) { return Promise.all([workspace.trackProcess(pid, options), outputOwner.trackProcess(pid, options)]); }
    };
    if (process.platform === 'linux') {
      const output = join(outputDir, 'libSoulForge.Hksc.Native.so');
      const result = await runProcess({ command: process.env.SOULFORGE_CC || 'cc', args: [
        '-shared', '-fPIC', '-O2', '-fvisibility=hidden',
        '-I', sourceRoot, '-o', output,
        ...sourceFiles.map((file) => join(sourceRoot, file)), '-lm'
      ], cwd: temp, owner: processOwner, signal: cancellation.signal,
        onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk) });
      if (!processSucceeded(result) || !existsSync(output)) {
        throw new Error(`FIRST_PARTY_HKS_NATIVE_BUILD_FAILED: cc exit ${result.code} (${result.terminationReason ?? result.stderr})`);
      }
      return;
    }
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
      `/Fo"${temp}\\\\"`,
      ...sourceFiles.map((file) => `"${join(sourceRoot, file)}"`)
    ];
    await writeFile(responseFile, `${args.join('\r\n')}\r\n`, 'ascii');
    const devCmd = findVisualStudioDevCmd();
    await writeFile(commandFile, `@echo off\r\ncall "${devCmd}" -arch=x64\r\nif errorlevel 1 exit /b %errorlevel%\r\ncl @"${responseFile}"\r\n`, 'ascii');
    const result = await runProcess({ command: 'cmd.exe', args: ['/d', '/c', commandFile],
      cwd: temp,
      env: createWindowsCompilerEnvironment(),
      owner: processOwner, signal: cancellation.signal,
      onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk)
    });
    if (!processSucceeded(result)) {
      throw new Error(`FIRST_PARTY_HKS_NATIVE_BUILD_FAILED: cl exit ${result.code} (${result.terminationReason ?? result.stderr})`);
    }
    const output = join(outputDir, 'SoulForge.Hksc.Native.dll');
    if (!existsSync(output)) throw new Error(`FIRST_PARTY_HKS_NATIVE_OUTPUT_MISSING: ${output}`);
  } finally {
    cancellation.dispose();
    await workspace.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
