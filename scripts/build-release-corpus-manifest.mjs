#!/usr/bin/env node
/**
 * 把本机生成的 release corpus registry 投影为可入库的跨机复现 manifest。
 *
 * 输入：`%LOCALAPPDATA%/SoulForge/corpus-registries/v0.5/sekiro-1.6.release-corpus.json`
 * （由 corpus:build-local-release 生成，未入库）。
 * 输出：`testdata/corpus/sekiro-1.6.corpus-manifest.json`（入库元数据，仅
 * logicalId/sha256/size/containerChain/resourceKind/format/observedVariant 与汇总，
 * 不携带文件内容与本地路径）。
 *
 * 第二台机器用 scripts/verify-corpus-manifest.mjs 重建同一 registry 并比对。
 *
 * 用法：
 *   node scripts/build-release-corpus-manifest.mjs [--registry <path>] [--out <path>]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith('--') && process.argv[i + 1] !== undefined) {
    args.set(token.slice(2), process.argv[i + 1]);
    i += 1;
  }
}

const localAppData = args.get('registry')
  ?? (process.env.LOCALAPPDATA ? join(
    process.env.LOCALAPPDATA,
    'SoulForge/corpus-registries/v0.5/sekiro-1.6.release-corpus.json'
  ) : null);
const outputPath = resolve(
  repositoryRoot,
  args.get('out') ?? 'testdata/corpus/sekiro-1.6.corpus-manifest.json'
);

if (!localAppData) {
  fail(
    'CORPUS_MANIFEST_INPUT_MISSING',
    '缺少本机 registry：先运行 corpus:build-local-release 生成，或 --registry <path> 指定。'
  );
}

let registry;
try {
  registry = JSON.parse(await readFile(resolve(localAppData), 'utf8'));
} catch (error) {
  fail('CORPUS_MANIFEST_INPUT_INVALID', `registry 读取/解析失败：${error.message}`);
}
if (registry?.schemaVersion !== '1.0.0' || !Array.isArray(registry.entries)) {
  fail('CORPUS_MANIFEST_INPUT_INVALID', 'registry schema 不受支持。');
}

const entries = registry.entries.map((entry) => ({
  logicalId: entry.logicalId,
  sha256: entry.sha256,
  size: entry.size,
  containerChain: entry.containerChain,
  resourceKind: entry.resourceKind,
  format: entry.format,
  observedVariant: entry.observedVariant
})).sort((left, right) => left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0);

const formatCounts = {};
const observedVariantCounts = {};
for (const entry of entries) {
  formatCounts[entry.format] = (formatCounts[entry.format] ?? 0) + 1;
  observedVariantCounts[entry.observedVariant]
    = (observedVariantCounts[entry.observedVariant] ?? 0) + 1;
}

const manifest = {
  schemaVersion: '1.0.0',
  manifestId: registry.registryId,
  game: registry.game,
  gameBuild: registry.gameBuild,
  generatedAt: new Date().toISOString(),
  entryCount: entries.length,
  summary: {
    uniqueContentEntries: entries.length,
    formatCounts,
    observedVariantCounts
  },
  entries
};

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(outputPath, serialized, 'utf8');
console.log(JSON.stringify({
  ok: true,
  output: outputPath,
  manifestId: manifest.manifestId,
  gameBuild: manifest.gameBuild,
  entryCount: manifest.entryCount,
  summary: manifest.summary,
  note: 'manifest 只含元数据，不含文件内容与本地路径；可入库。'
}, null, 2));

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, status: 'failed', code, message }, null, 2));
  process.exit(1);
}
