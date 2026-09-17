import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const bridgeCandidates = [
  resolve(root, 'bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe'),
  resolve(root, 'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe')
];
const bridge = bridgeCandidates.find(existsSync);
const fixture = process.env.SOULFORGE_HKS_SMOKE_PATH
  ? resolve(process.env.SOULFORGE_HKS_SMOKE_PATH)
  : resolve(root, 'testdata/first-party/lua/roundtrip.lua');

function run(command, file, options) {
  if (!bridge) throw new Error('缺少 Bridge 可执行文件，请先执行 npm run bridge:build。');
  const result = spawnSync(bridge, [command, file, JSON.stringify(options)], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      SOULFORGE_DSLUADECOMPILER_PATH: resolve(root, 'does-not-exist/forbidden.exe'),
      SOULFORGE_TAE_TEMPLATE_PATH: resolve(root, 'does-not-exist/forbidden.xml'),
      SOULFORGE_EMEDF_PATH: resolve(root, 'does-not-exist/forbidden.json')
    }
  });
  if (result.error) throw result.error;
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Bridge ${command} 未返回 JSON：${result.stdout.slice(0, 500)}\n${error}`);
  }
  if (envelope.parseStatus === 'failed' || !envelope.data) {
    throw new Error(`Bridge ${command} 失败：${JSON.stringify(envelope.diagnostics ?? envelope).slice(0, 2000)}`);
  }
  return envelope;
}

if (!existsSync(fixture)) {
  console.log(JSON.stringify({ ok: true, status: 'not-attempted', reason: 'HKS fixture is unavailable', fixture }));
  process.exit(0);
}

const workspace = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'soulforge-hks-smoke-'));
try {
  const source = await readFile(fixture, 'utf8');
  const compiled = run('compile-hks-source', fixture, {
    sourceText: source,
    expectedDialect: 'sekiro-hks-1.6.x'
  });
  const contentBase64 = compiled.data.contentBase64;
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
    throw new Error('compile-hks-source 未返回编译字节。');
  }
  const binaryPath = join(workspace, 'roundtrip.hks');
  await writeFile(binaryPath, Buffer.from(contentBase64, 'base64'));
  const decompiled = run('read-hks-source', binaryPath, {});
  const view = decompiled.data;
  if (view.dialect !== 'sekiro-hks-1.6.x') throw new Error(`dialect 不匹配：${view.dialect}`);
  if (view.writeSupported !== true) throw new Error('first-party HKS 源码视图不可写。');
  if (!String(view.sourceText ?? '').includes('return')) throw new Error('反编译结果不是完整源码。');
  if (view.compiler?.provenance !== 'first-party' || view.decompiler?.provenance !== 'first-party') {
    throw new Error('Lua/HKS provenance 未标记为 first-party。');
  }
  console.log(JSON.stringify({
    ok: true,
    status: 'verified',
    dialect: view.dialect,
    sourceHash: view.sourceHash,
    compiledBytes: Buffer.byteLength(contentBase64, 'base64'),
    diagnostics: decompiled.diagnostics
  }));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
