import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('./build-first-party-hksc-native.mjs', import.meta.url), 'utf8');
const ast = ts.createSourceFile('native-build.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const discover = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'findVisualStudioDevCmd');
assert.ok(discover, 'the native builder must retain its actual toolchain discovery');
function run(env, files, execute) {
  return vm.runInNewContext(discover.getText(ast) + '\nfindVisualStudioDevCmd()', {
    process: { env }, join, existsSync: path => files.has(path), execFileSync: execute
  });
}

test('native build finds a C++ installation outside the 2022 folder through official vswhere', () => {
  const base = join('owned-installers', 'program-files-x86');
  const vswhere = join(base, 'Microsoft Visual Studio/Installer/vswhere.exe');
  const installation = join('owned-installations', '18', 'Enterprise');
  const devCmd = join(installation, 'Common7/Tools/VsDevCmd.bat');
  let observed;
  const result = run({ 'ProgramFiles(x86)': base }, new Set([vswhere, devCmd]), (file, args, options) => {
    observed = { file, args: Array.from(args), options };
    return installation + '\r\n';
  });
  assert.equal(result, devCmd);
  assert.equal(observed.file, vswhere);
  assert.deepEqual(observed.args, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.timeout, 30_000);
});

test('an explicit available developer command remains authoritative', () => {
  const explicit = join('owned', 'custom', 'VsDevCmd.bat');
  assert.equal(run({ SOULFORGE_VSDEVCMD: explicit }, new Set([explicit]), () => { throw new Error('discovery must not replace the explicit command'); }), explicit);
});

test('missing installations or failed discovery cannot become a ready C++ toolchain', () => {
  const base = 'owned-installers';
  const vswhere = join(base, 'Microsoft Visual Studio/Installer/vswhere.exe');
  for (const execute of [() => '', () => 'missing-installation', () => { throw new Error('vswhere failed'); }]) {
    assert.throws(() => run({ 'ProgramFiles(x86)': base }, new Set([vswhere]), execute), /FIRST_PARTY_HKS_NATIVE_TOOLCHAIN_MISSING/);
  }
});

test('compiler environment bounds inherited search paths without mutating caller or toolchain selection', () => {
  const prepare = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createWindowsCompilerEnvironment');
  assert.ok(prepare, 'the native compiler must prepare its own bounded environment');
  const env = Object.freeze({ SystemRoot: join('owned-system', 'Windows'),
    Path: 'caller-tool;'.repeat(1_000), PATH: 'duplicate-caller-tool;'.repeat(1_000),
    __VSCMD_PREINIT_PATH: 'previous-developer-shell-tool;'.repeat(1_000),
    SOULFORGE_VSDEVCMD: 'explicit-developer-command', VCToolsVersion: 'explicit-toolset-version',
    WindowsSDKVersion: 'explicit-sdk-version', INCLUDE: 'caller-include', LIB: 'caller-lib',
    SOULFORGE_OWNED_TEMP_TEST_MARKER: 'owned-directory-identity' });
  const child = vm.runInNewContext(prepare.getText(ast) + '\ncreateWindowsCompilerEnvironment(input)', { input: env, join });
  const paths = Object.keys(child).filter(key => key.toUpperCase() === 'PATH');
  assert.equal(paths.length, 1, 'Windows must receive one case-insensitive PATH');
  assert.ok(child[paths[0]].length < 1_000, 'leave ample cmd expansion space for the selected toolchain');
  assert.ok(child[paths[0]].split(';').includes(join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0')),
    'owned Windows process supervision must remain available');
  assert.ok(!Object.keys(child).some(key => key.toUpperCase() === '__VSCMD_PREINIT_PATH'),
    'VsDevCmd must not restore an oversized previous PATH');
  for (const key of ['SOULFORGE_VSDEVCMD', 'VCToolsVersion', 'WindowsSDKVersion', 'INCLUDE', 'LIB', 'SOULFORGE_OWNED_TEMP_TEST_MARKER']) {
    assert.equal(child[key], env[key], `${key} must remain authoritative`);
  }
  assert.equal(env.Path.length, 12_000);
  assert.equal(env.PATH.length, 22_000);
});
