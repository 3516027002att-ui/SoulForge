#!/usr/bin/env node
/**
 * Verify the first-party HKS reader against every locally available current
 * Sekiro script.  This is a native corpus check, not a release fixture: when
 * the game corpus is absent it reports not-attempted and does not claim
 * coverage.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
const corpusRoot = process.env.SOULFORGE_HKS_CORPUS_ROOT?.trim()
  || (gameRoot ? join(gameRoot, 'action', 'script') : null);
const bridge = process.env.SOULFORGE_BRIDGE_PATH?.trim()
  || join(root, 'bridge', 'SoulForge.Bridge', 'bin', 'Debug', 'net10.0', 'win-x64', 'SoulForge.Bridge.exe');

if (!corpusRoot || !existsSync(corpusRoot)) {
  console.log(JSON.stringify({
    ok: true,
    status: 'not-attempted',
    code: 'HKS_CORPUS_ROOT_UNAVAILABLE',
    corpusRoot
  }));
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

function read(path) {
  const result = spawnSync(bridge, ['read-hks-source', path, '{}'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      SOULFORGE_DSLUADECOMPILER_PATH: join(root, 'forbidden', 'DSLuaDecompiler.exe'),
      SOULFORGE_TAE_TEMPLATE_PATH: join(root, 'forbidden', 'TAE.Template.SDT.xml'),
      SOULFORGE_EMEDF_PATH: join(root, 'forbidden', 'sekiro-common.emedf.json')
    }
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout ?? '').trim();
  if (!stdout) throw new Error(`Bridge 没有返回 JSON：${result.stderr ?? ''}`);
  return JSON.parse(stdout);
}

const files = collect(resolve(corpusRoot));
const failures = [];
let functions = 0;
let instructions = 0;
let unknownOpcodes = 0;
for (const path of files) {
  let response;
  try {
    response = read(path);
  } catch (error) {
    failures.push({ path, code: 'HKS_BRIDGE_PROTOCOL_FAILED', message: error instanceof Error ? error.message : String(error) });
    continue;
  }
  const data = response.data;
  const coverage = data?.coverage;
  const unknown = Array.isArray(coverage?.unknownOpcodes) ? coverage.unknownOpcodes : [];
  const sourceText = typeof data?.sourceText === 'string' ? data.sourceText : '';
  functions += Number.isInteger(coverage?.functionCount) ? coverage.functionCount : 0;
  instructions += Number.isInteger(coverage?.instructionCount) ? coverage.instructionCount : 0;
  unknownOpcodes += unknown.length;
  if (response.parseStatus === 'failed' || !data || sourceText.trim().length === 0 || unknown.length > 0) {
    failures.push({
      path,
      diagnostics: response.diagnostics ?? [],
      unknownOpcodes: unknown,
      sourceBytes: Buffer.byteLength(sourceText, 'utf8')
    });
  }
}

const result = {
  ok: failures.length === 0,
  status: failures.length === 0 ? 'verified-observed' : 'failed',
  corpusRoot,
  files: files.length,
  functions,
  instructions,
  unknownOpcodes,
  failures
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 2;
