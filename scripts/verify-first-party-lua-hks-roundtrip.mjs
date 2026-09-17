#!/usr/bin/env node
/**
 * Compile every locally available current Sekiro HKS script after reading it
 * through the first-party Bridge. The original corpus is never modified.
 * The daemon transport is used because decompiled source is larger than the
 * Windows process command-line limit.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { disposeBridgeDaemonPool, runBridge } from '../packages/core/dist/bridge/runBridge.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
const corpusRoot = process.env.SOULFORGE_HKS_CORPUS_ROOT?.trim()
  || (gameRoot ? join(gameRoot, 'action', 'script') : null);
const bridge = process.env.SOULFORGE_BRIDGE_PATH?.trim()
  || join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe');

if (!corpusRoot || !existsSync(corpusRoot)) {
  console.log(JSON.stringify({ ok: true, status: 'not-attempted', code: 'HKS_CORPUS_ROOT_UNAVAILABLE', corpusRoot }));
  process.exit(0);
}
if (!existsSync(bridge)) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code: 'HKS_BRIDGE_UNAVAILABLE', bridge }));
  process.exit(2);
}

function collect(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path, result);
    else if (entry.isFile() && /\.hks$/iu.test(entry.name)) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right, 'en'));
}

async function bridgeJson(command, file, options, allowedRoots) {
  const envelope = await runBridge({
    bridgeExecutablePath: bridge,
    command,
    filePath: file,
    resourceUri: pathToFileURL(file).href,
    allowedRoots,
    commandOptions: options,
    timeoutMs: 120_000,
    maxFrameBytes: 32 * 1024 * 1024
  });
  if (envelope.parseStatus === 'failed' || !envelope.data) {
    throw new Error(`${command} 失败：${JSON.stringify(envelope.diagnostics ?? envelope).slice(0, 1_500)}`);
  }
  return envelope;
}

const files = collect(resolve(corpusRoot));
const scratch = mkdtempSync(join(tmpdir(), 'soulforge-hks-roundtrip-'));
const failures = [];
let compiled = 0;
const forbiddenEnvNames = [
  'SOULFORGE_DSLUADECOMPILER_PATH',
  'SOULFORGE_TAE_TEMPLATE_PATH',
  'SOULFORGE_EMEDF_PATH'
];
const previousEnv = new Map(forbiddenEnvNames.map((name) => [name, process.env[name]]));
for (const name of forbiddenEnvNames) process.env[name] = join(root, 'forbidden', `${name}.missing`);
try {
  for (const sourcePath of files) {
    try {
      const read = await bridgeJson('read-hks-source', sourcePath, {}, [dirname(sourcePath)]);
      const sourceText = typeof read.data.sourceText === 'string' ? read.data.sourceText : '';
      const unknown = Array.isArray(read.data.coverage?.unknownOpcodes) ? read.data.coverage.unknownOpcodes : [];
      if (!sourceText.trim() || unknown.length > 0) throw new Error('读取结果不是完整且零未知 opcode 的源码。');

      const compile = await bridgeJson('compile-hks-source', sourcePath, {
        sourceText,
        expectedDialect: 'sekiro-hks-1.6.x'
      }, [dirname(sourcePath)]);
      const base64 = compile.data.contentBase64;
      if (typeof base64 !== 'string' || base64.length === 0) throw new Error('编译结果缺少 HKS 字节码。');
      const compiledPath = join(scratch, `${String(compiled).padStart(4, '0')}.hks`);
      writeFileSync(compiledPath, Buffer.from(base64, 'base64'));
      const reread = await bridgeJson('read-hks-source', compiledPath, {}, [scratch]);
      const rereadText = typeof reread.data.sourceText === 'string' ? reread.data.sourceText : '';
      const rereadUnknown = Array.isArray(reread.data.coverage?.unknownOpcodes) ? reread.data.coverage.unknownOpcodes : [];
      if (!rereadText.trim() || rereadUnknown.length > 0) throw new Error('编译字节码 native 重读不是完整且零未知 opcode 的源码。');
      if (reread.data.dialect !== 'sekiro-hks-1.6.x'
        || reread.data.compiler?.provenance !== 'first-party'
        || reread.data.decompiler?.provenance !== 'first-party') {
        throw new Error('编译后 native 重读的 dialect/provenance 不是 first-party。');
      }
      compiled += 1;
    } catch (error) {
      failures.push({ path: sourcePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
} finally {
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
  await disposeBridgeDaemonPool();
}

const result = {
  ok: failures.length === 0,
  status: failures.length === 0 ? 'verified-observed' : 'failed',
  corpusRoot,
  files: files.length,
  compiled,
  failures
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 2;

function dirname(path) {
  return path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')));
}
