#!/usr/bin/env node
/**
 * 跨机复现比对工具（REL-B / W-REL-B-CORPUS-02）。
 *
 * 给定入库的 corpus manifest（默认 testdata/corpus/sekiro-1.6.corpus-manifest.json）
 * 与一台机器的 corpus 根（SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT，
 * 或首个位置参数），扫描全部 .dcx，逐文件：
 *
 *   1. 计算 sha256 / size；
 *   2. 用 Bridge read-dcx-document 分类（format / observedVariant，换算约定见
 *      packages/core/src/bridge/releaseCorpusRegistry.spec.md §4，闭集来自 frozen
 *      schema x-constants，未识别变体失败关闭）；
 *   3. 按 sha256 匹配 manifest 条目，比对 size / format / observedVariant。
 *
 * 成功条件：manifest 每条唯一内容至少被一个文件匹配，且无 sha256/size/分类不一致、
 * 无未识别 Bridge variant、无缺失条目。否则 exit=1 并输出结构化诊断。
 *
 * 未匹配到 manifest 的文件（例如第二台机器独有的 mod）以 extraFiles 报告，
 * 不构成失败——manifest 不要求 corpus 恰好等于清单。
 *
 * 用法：
 *   node scripts/with-local-has-game-env.mjs node scripts/verify-corpus-manifest.mjs
 *   node scripts/verify-corpus-manifest.mjs <corpusRoot> [--manifest <path>]
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

/**
 * corpus 根解析。与 verify-native-dcx-documents.mjs 采用同一口径，理由见那里的
 * 长注释：SOULFORGE_NATIVE_FIXTURE_ROOT / SOULFORGE_SEKIRO_GAME_ROOT 在本仓库
 * 是**游戏根**（has-game-registry.json 的 localPath 全部以 `mods/` 开头），
 * 而本脚本需要的是 Mod 语料根。
 *
 * 不下沉的后果（实测）：经 with-local-has-game-env 跑时扫整个游戏根 8065 个
 * .dcx，extraFiles 里塞满 chr/shader/font 等根本不属于 corpus manifest 覆盖面的
 * 文件。虽然 status 仍是 matched（本脚本容忍 extra），但 filesScanned 与
 * extraFiles 两个数字失去意义，读者无法从输出判断 corpus 是否真的对齐。
 * 下沉后：filesScanned 214、extraFiles 0、matchedEntries 214。
 *
 * 显式传参时不下沉——那是调用方明确指定的目录。
 */
const corpusRoot = (() => {
  if (process.argv[2]) return resolve(process.argv[2]);
  const envRoot = process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
    ?? process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (!envRoot) return resolve('mods');
  const base = resolve(envRoot);
  const modsUnder = join(base, 'mods');
  return existsSync(modsUnder) ? modsUnder : base;
})();
const manifestArgIndex = process.argv.indexOf('--manifest');
const manifestPath = resolve(
  manifestArgIndex >= 0 && process.argv[manifestArgIndex + 1]
    ? process.argv[manifestArgIndex + 1]
    : 'testdata/corpus/sekiro-1.6.corpus-manifest.json'
);
const executable = resolve('bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe');

const frozenSchema = JSON.parse(await readFile(
  resolve('packages/core/src/bridge/releaseCorpusRegistry.schema.json'),
  'utf8'
));
const frozenVariantsByFormat = frozenSchema?.['x-constants']?.observedVariantsByFormat;
if (!frozenVariantsByFormat?.DFLT || !frozenVariantsByFormat?.BND4 || !frozenVariantsByFormat?.KRAK) {
  fail('CORPUS_MANIFEST_SCHEMA_MISSING', 'frozen schema x-constants 缺失；无法对账。', { ok: false });
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  fail('CORPUS_MANIFEST_INVALID', `manifest 读取/解析失败：${error.message}`);
}
if (manifest?.schemaVersion !== '1.0.0' || !Array.isArray(manifest.entries)) {
  fail('CORPUS_MANIFEST_INVALID', 'manifest schema 不受支持。');
}
const entriesByHash = new Map();
for (const entry of manifest.entries) {
  if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    fail('CORPUS_MANIFEST_INVALID', `manifest 条目 sha256 非法：${entry.logicalId}`);
  }
  if (entriesByHash.has(entry.sha256)) {
    fail('CORPUS_MANIFEST_INVALID', `manifest 存在重复 sha256：${entry.sha256.slice(0, 12)}`);
  }
  entriesByHash.set(entry.sha256, entry);
}

const files = await walkDcx(corpusRoot);
const unmatched = new Set(entriesByHash.keys());
const mismatches = [];
const extraFiles = [];
const unrecognizedVariants = new Set();
let filesScanned = files.length;
let uniqueContentFiles = 0;
let matchedEntries = 0;
const matchedHashes = new Set();

for (const file of files) {
  const rel = relative(corpusRoot, file).replaceAll('\\', '/');
  let hash;
  let size;
  try {
    size = statSync(file).size;
    hash = await sha256File(file);
  } catch (error) {
    fail('CORPUS_MANIFEST_FILE_UNREADABLE', `无法读取 ${rel}：${error.message}`);
  }
  const entry = entriesByHash.get(hash);
  if (entry === undefined) {
    extraFiles.push(rel);
    continue;
  }
  if (!matchedHashes.has(hash)) {
    matchedHashes.add(hash);
    uniqueContentFiles += 1;
  }
  if (size !== entry.size) {
    mismatches.push({ file: rel, field: 'size', manifest: entry.size, actual: size });
  }
  const classification = classifyViaBridge(file, rel);
  if (classification.unavailable) {
    mismatches.push({ file: rel, field: 'classification', manifest: entry.observedVariant, actual: classification.unavailable });
    continue;
  }
  if (classification.unrecognizedVariant) {
    unrecognizedVariants.add(classification.variant);
    mismatches.push({ file: rel, field: 'observedVariant', manifest: entry.observedVariant, actual: `<unrecognized ${classification.variant}>` });
    continue;
  }
  if (classification.format !== entry.format) {
    mismatches.push({ file: rel, field: 'format', manifest: entry.format, actual: classification.format });
  }
  if (classification.observedVariant !== entry.observedVariant) {
    mismatches.push({ file: rel, field: 'observedVariant', manifest: entry.observedVariant, actual: classification.observedVariant });
  }
  unmatched.delete(hash);
  matchedEntries += 1;
}

const missing = [...unmatched];
const ok = matchedHashes.size === manifest.entryCount
  && missing.length === 0
  && mismatches.length === 0
  && unrecognizedVariants.size === 0;

const report = {
  ok,
  status: ok ? 'matched' : 'failed',
  manifest: manifestPath,
  manifestEntryCount: manifest.entryCount,
  filesScanned,
  uniqueContentFiles,
  matchedEntries,
  missingEntries: missing,
  mismatches,
  unrecognizedVariants: [...unrecognizedVariants],
  extraFiles,
  summary: manifest.summary
};
if (!ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));

function classifyViaBridge(file, rel) {
  const result = spawnSync(executable, ['read-dcx-document', file], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000
  });
  if (result.error || result.status !== 0) {
    return { unavailable: 'bridge-read-failed' };
  }
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    return { unavailable: 'bridge-response-invalid' };
  }
  const data = envelope.data;
  if (envelope.parseStatus === 'failed' || !data || data.format !== 'DCX') {
    return { unavailable: 'bridge-rejected' };
  }
  if (data.compressionFormat === 'KRAK') {
    if (typeof data.variant !== 'string') return { unavailable: 'missing-variant' };
    const observedVariant = `DCX_${data.variant}`;
    if (!frozenVariantsByFormat.KRAK.includes(observedVariant)) {
      return { unrecognizedVariant: true, variant: data.variant };
    }
    return { format: 'KRAK', observedVariant };
  }
  if (data.compressionFormat !== 'DFLT' || typeof data.variant !== 'string') {
    return { unavailable: 'unsupported-compression' };
  }
  if (data.nested?.format === 'BND4') {
    const observedVariant = 'BND4_40_24';
    if (!frozenVariantsByFormat.BND4.includes(observedVariant)) {
      return { unrecognizedVariant: true, variant: observedVariant };
    }
    if (!frozenVariantsByFormat.DFLT.includes(`DCX_${data.variant}`)) {
      return { unrecognizedVariant: true, variant: data.variant };
    }
    return { format: 'BND4', observedVariant };
  }
  const observedVariant = `DCX_${data.variant}`;
  if (!frozenVariantsByFormat.DFLT.includes(observedVariant)) {
    return { unrecognizedVariant: true, variant: data.variant };
  }
  return { format: 'DFLT', observedVariant };
}

async function walkDcx(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walkDcx(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.dcx') output.push(path);
  }
  return output;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code, message }, null, 2));
  process.exit(1);
}
