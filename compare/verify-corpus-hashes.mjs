#!/usr/bin/env node
/**
 * 语料内容哈希校验（#23）。
 *
 * `compare/corpus.json` 现在只用路径引用本机游戏目录里的文件，没有内容哈希：
 * 换机器、换游戏版本、换语言包都会拿到不同内容，对照结果无法归因。
 *
 * 这里给语料条目加一个**可选**的 `sha256` 字段，并提供校验：
 * - 声明了哈希且实际匹配 → `match`
 * - 声明了哈希但不匹配     → `diff`
 * - 没有声明哈希           → `unverified`（不是通过）
 * - 文件不存在             → `missing`
 *
 * 语料根来自 `SOULFORGE_SEKIRO_ROOT`，不写死在仓库里。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const options = { json: false, corpus: join(repoRoot, 'compare/corpus.json'), root: process.env.SOULFORGE_SEKIRO_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--corpus') options.corpus = resolve(argv[++index]);
    else if (arg === '--root') options.root = argv[++index];
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 语料条目允许两种写法：`inputs: ["a.dcx"]` 或 `inputs: [{ path: "a.dcx", sha256: "..." }]`。 */
function normalizeInput(input) {
  if (typeof input === 'string') return { path: input, sha256: undefined };
  if (input && typeof input === 'object' && typeof input.path === 'string') {
    return { path: input.path, sha256: typeof input.sha256 === 'string' ? input.sha256.toLowerCase() : undefined };
  }
  return { path: undefined, sha256: undefined };
}

const options = parseArgs(process.argv.slice(2));
const corpus = JSON.parse(readFileSync(options.corpus, 'utf8'));
const cases = Array.isArray(corpus.cases) ? corpus.cases : [];

const results = [];
for (const entry of cases) {
  for (const raw of entry.inputs ?? []) {
    const input = normalizeInput(raw);
    if (!input.path) {
      results.push({ case: caseLabel(entry), path: null, state: 'invalid' });
      continue;
    }
    const absolute = options.root ? join(resolve(options.root), input.path) : null;
    if (!absolute || !existsSync(absolute)) {
      results.push({ case: caseLabel(entry), path: input.path, state: 'missing', declared: input.sha256 ?? null });
      continue;
    }
    const actual = sha256File(absolute);
    if (!input.sha256) {
      results.push({ case: caseLabel(entry), path: input.path, state: 'unverified', actual });
      continue;
    }
    results.push({
      case: caseLabel(entry),
      path: input.path,
      state: actual === input.sha256 ? 'match' : 'diff',
      declared: input.sha256,
      actual
    });
  }
}

function caseLabel(entry) {
  return [entry.game, entry.format, entry.operation].filter(Boolean).join(':');
}

const summary = {
  corpus: options.corpus,
  root: options.root ?? null,
  inputs: results.length,
  match: results.filter((r) => r.state === 'match').length,
  diff: results.filter((r) => r.state === 'diff').length,
  unverified: results.filter((r) => r.state === 'unverified').length,
  missing: results.filter((r) => r.state === 'missing').length,
  invalid: results.filter((r) => r.state === 'invalid').length
};

if (options.json) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log(
    `语料输入 ${summary.inputs} 项：match ${summary.match} / diff ${summary.diff} / `
    + `unverified ${summary.unverified} / missing ${summary.missing} / invalid ${summary.invalid}`
  );
  for (const item of results.filter((r) => r.state === 'diff' || r.state === 'missing' || r.state === 'invalid')) {
    console.log(`  ${item.state}: ${item.case} ${item.path ?? '(no path)'}`);
  }
}

// 声明了哈希却不匹配 = 语料变了，属于必须失败；未声明只说“未验证”，不算失败。
process.exit(summary.diff > 0 || summary.invalid > 0 ? 1 : 0);
