#!/usr/bin/env node
/**
 * Full first-party LuaP corpus gate.
 *
 * The source corpus is read through the production Bridge and never modified.
 * This gate intentionally does not load DSLuaDecompiler, a tool installation,
 * or any external dialect/schema path.  It is a native observation gate: a
 * successful result proves the local corpus round-trips through SoulForge's
 * own LuaP reader/compiler, not that the game has accepted the output.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { disposeBridgeDaemonPool, runBridge } from '../packages/core/dist/bridge/runBridge.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
  || process.env.SOULFORGE_SEKIRO_ROOT?.trim();
const corpusRoot = process.env.SOULFORGE_LUABND_CORPUS_ROOT?.trim()
  || (gameRoot ? join(gameRoot, 'mods', 'script') : null);
const bridge = process.env.SOULFORGE_BRIDGE_PATH?.trim()
  || join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe');
const limitRaw = Number(process.env.SOULFORGE_LUAP_CORPUS_LIMIT ?? '0');
const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? limitRaw : null;

if (!corpusRoot || !existsSync(corpusRoot)) {
  console.log(JSON.stringify({
    ok: true,
    status: 'not-attempted',
    code: 'LUAP_CORPUS_ROOT_UNAVAILABLE',
    corpusRoot
  }, null, 2));
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
    else if (entry.isFile() && /\.luabnd\.dcx$/iu.test(entry.name)) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right, 'en'));
}

function uri(file) {
  return pathToFileURL(file).href;
}

function relativeLabel(file) {
  return relative(corpusRoot, file).replaceAll('\\', '/');
}

async function bridgeJson(command, file, options) {
  const envelope = await runBridge({
    bridgeExecutablePath: bridge,
    command,
    filePath: file,
    resourceUri: uri(file),
    allowedRoots: [corpusRoot],
    commandOptions: options,
    timeoutMs: 120_000,
    maxFrameBytes: 32 * 1024 * 1024
  });
  if (envelope.parseStatus === 'failed' || !envelope.data) {
    throw new Error(`${command}: ${JSON.stringify(envelope.diagnostics ?? envelope).slice(0, 2_000)}`);
  }
  return envelope.data;
}

const forbidden = [
  'SOULFORGE_DSLUADECOMPILER_PATH',
  'SOULFORGE_TAE_TEMPLATE_PATH',
  'SOULFORGE_EMEDF_PATH',
  'SOULFORGE_YAPPED_SDT_ROOT'
];
const previous = new Map(forbidden.map((name) => [name, process.env[name]]));
for (const name of forbidden) process.env[name] = join(root, 'forbidden', `${name}.missing`);

const containers = collect(resolve(corpusRoot));
const failures = [];
let scriptsSeen = 0;
let scriptsAttempted = 0;
let scriptsCompiled = 0;
let functionCount = 0;
let instructionCount = 0;
let unknownOpcodes = 0;
let plaintextCount = 0;

try {
  outer: for (const container of containers) {
    let document;
    try {
      document = await bridgeJson('read-luabnd-document', container, {});
    } catch (error) {
      failures.push({ container: relativeLabel(container), stage: 'inventory', message: String(error?.message ?? error) });
      continue;
    }
    const scripts = Array.isArray(document.scripts) ? document.scripts : [];
    for (const entry of scripts) {
      scriptsSeen += 1;
      if (!entry?.isBytecode) {
        plaintextCount += 1;
        continue;
      }
      if (limit !== null && scriptsAttempted >= limit) break outer;
      scriptsAttempted += 1;
      const childPath = typeof entry.sanitizedName === 'string' && entry.sanitizedName.length > 0
        ? entry.sanitizedName
        : entry.name;
      try {
        const raw = await bridgeJson('read-luabnd-script', container, { childPath });
        if (typeof raw.contentBase64 !== 'string' || raw.contentBase64.length === 0) {
          throw new Error('LuaP 子项缺少 contentBase64。');
        }
        const read = await bridgeJson('read-hks-source', container, { contentBase64: raw.contentBase64 });
        const coverage = read.coverage ?? {};
        functionCount += Number.isSafeInteger(coverage.functionCount) ? coverage.functionCount : 0;
        instructionCount += Number.isSafeInteger(coverage.instructionCount) ? coverage.instructionCount : 0;
        const unknown = Array.isArray(coverage.unknownOpcodes) ? coverage.unknownOpcodes : [];
        unknownOpcodes += unknown.length;
        if (read.dialect !== 'sekiro-lua50-1.6.x'
          || read.decompiler?.provenance !== 'first-party'
          || read.compiler?.provenance !== 'first-party'
          || typeof read.sourceText !== 'string'
          || read.sourceText.trim() === ''
          || unknown.length > 0) {
          throw new Error('LuaP 读取没有返回 first-party 完整源码或出现未知 opcode。');
        }
        const compiled = await bridgeJson('compile-hks-source', container, {
          sourceText: read.sourceText,
          expectedDialect: read.dialect
        });
        if (compiled.dialect !== 'sekiro-lua50-1.6.x'
          || compiled.compiler?.provenance !== 'first-party'
          || typeof compiled.contentBase64 !== 'string'
          || compiled.contentBase64.length === 0) {
          throw new Error('LuaP 编译结果缺少 first-party dialect/provenance/字节码。');
        }
        const reread = await bridgeJson('read-hks-source', container, { contentBase64: compiled.contentBase64 });
        const rereadUnknown = Array.isArray(reread.coverage?.unknownOpcodes) ? reread.coverage.unknownOpcodes : [];
        if (reread.dialect !== 'sekiro-lua50-1.6.x'
          || reread.decompiler?.provenance !== 'first-party'
          || reread.compiler?.provenance !== 'first-party'
          || typeof reread.sourceText !== 'string'
          || reread.sourceText.trim() === ''
          || rereadUnknown.length > 0) {
          throw new Error('LuaP 编译后 Bridge 重读没有返回 first-party 完整源码或出现未知 opcode。');
        }
        scriptsCompiled += 1;
      } catch (error) {
        failures.push({
          container: relativeLabel(container),
          childPath,
          stage: 'roundtrip',
          message: String(error?.message ?? error)
        });
      }
    }
  }
} finally {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await disposeBridgeDaemonPool();
}

const result = {
  ok: failures.length === 0 && (limit === null || scriptsAttempted === limit),
  status: failures.length === 0 && (limit === null || scriptsAttempted === limit) ? 'verified-observed' : 'failed',
  corpusRoot,
  containers: containers.length,
  scriptsSeen,
  scriptsAttempted,
  scriptsCompiled,
  plaintextCount,
  functionCount,
  instructionCount,
  unknownOpcodes,
  ...(limit !== null ? { limit, limited: scriptsAttempted === limit } : {}),
  failures
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 2;
