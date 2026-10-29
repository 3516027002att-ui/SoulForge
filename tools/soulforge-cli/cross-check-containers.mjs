#!/usr/bin/env node
/**
 * 容器条目对拍：SoulForge `list_container_entries` vs 参考 CLI（SoulsFormats）
 * 的 `entries` 操作，逐容器比较成员数量、ordinal/id/size 序列和名字归属。
 *
 * 为什么单独一个脚本：文件级对拍（cross-check-reads.mjs）只能证明"外层字节
 * 读得对"，容器里的成员清单是另一层读取能力 —— 之前 TypeScript 侧根本没有入口，
 * 89 个 binder、15,546 个成员对模型不可见。这个脚本把新入口的输出固定成可比较
 * 的口径：
 *
 *   1. SoulForge 侧走 production 模块 `listContainerEntries`（与 Agent 工具同一
 *      条代码路径），条目名是"容器根之后的相对路径"；
 *   2. 参考侧走 `refcli soulsformats entries`，条目名是打包机原始全名。
 *
 * 因此名字比较判的是**归属**：参考名的规范化尾部必须等于 SoulForge 名字，而不是
 * 字符串相等。id 与 size 必须逐条相等，数量必须相等。
 *
 * 用法：
 *   node tools/soulforge-cli/cross-check-containers.mjs --workspace "<mods>" --base "<gameRoot>"
 *     [--out output/cross-check] [--limit N] [--filter substr] [--no-reference]
 *
 * 退出码：0 无 mismatch；2 存在 mismatch；1 用法/环境错误。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const REFERENCE_CLI = join(REPO_ROOT, 'Reference tools', 'cli', 'refcli.mjs');
const REFERENCE_RESULTS = join(REPO_ROOT, 'Reference tools', 'results');
const CORE_DIST = join(REPO_ROOT, 'packages', 'core', 'dist');

/** Sekiro 里由 BND 承载的资源；扩展名决定"这是容器"。 */
const BINDER_HINTS = [
  '.anibnd', '.chrbnd', '.behbnd', '.objbnd', '.parambnd', '.msgbnd',
  '.texbnd', '.sblytbnd', '.talkesdbnd', '.mapbnd', '.chkbnd', '.ffxbnd',
  '.luabnd', '.bnd'
];

function parseArgs(argv) {
  const options = { workspace: null, base: null, out: 'output/cross-check/containers', limit: null, filter: null, reference: true, hashes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} 需要参数`);
      index += 1;
      return value;
    };
    if (arg === '--workspace') options.workspace = next();
    else if (arg === '--base') options.base = next();
    else if (arg === '--out') options.out = next();
    else if (arg === '--limit') options.limit = Number.parseInt(next(), 10);
    else if (arg === '--filter') options.filter = next();
    else if (arg === '--no-reference') options.reference = false;
    else if (arg === '--hashes') options.hashes = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('见文件头注释。\n');
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  if (!options.workspace) throw new Error('缺少 --workspace');
  return options;
}

function isBinderPath(filePath) {
  const lower = filePath.toLowerCase();
  return BINDER_HINTS.some((hint) => lower.includes(`${hint}.`) || lower.endsWith(hint));
}

function collectBinders(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'staging' || entry.name === 'backups' || entry.name === 'recovery') continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isBinderPath(entry.name)) continue;
      found.push(absolute);
    }
  };
  walk(root);
  return found.sort((left, right) => left.localeCompare(right));
}

function runReferenceEntries(filePath) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [REFERENCE_CLI, 'soulsformats', 'entries', '--input', filePath], {
      cwd: REPO_ROOT,
      windowsHide: true
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', (error) => resolvePromise({ ok: false, code: 'REFERENCE_SPAWN_FAILED', message: String(error) }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.status !== 'ok') {
          resolvePromise({ ok: false, code: parsed.code ?? parsed.status ?? 'REFERENCE_FAILED', message: parsed.message ?? '' });
          return;
        }
        const artifact = (parsed.artifacts ?? []).find((item) => item.relativePath === 'entries.json');
        if (!artifact) {
          resolvePromise({ ok: false, code: 'REFERENCE_ARTIFACT_MISSING', message: 'entries.json 未生成' });
          return;
        }
        const payload = JSON.parse(readFileSync(artifact.path, 'utf8'));
        // 结果目录用完即删，避免像 decode 那样把 Reference tools/results 撑爆。
        const resultDir = dirname(artifact.path);
        if (resultDir.startsWith(REFERENCE_RESULTS)) rmSync(resultDir, { recursive: true, force: true });
        resolvePromise({ ok: true, entries: payload.entries ?? [], formatLayer: payload.formatLayer ?? null });
      } catch (error) {
        resolvePromise({ ok: false, code: 'REFERENCE_PARSE_FAILED', message: String(error) });
      }
    });
  });
}

/** 参考名是打包机全名，取与 production 相同的规范化尾部做归属判断。 */
function referenceTail(name) {
  const segments = String(name ?? '').replaceAll('\\', '/').split('/').filter(Boolean);
  const anchor = segments.findIndex((segment) => /^INTERROOT_(?:win64|x64|win32)$/iu.test(segment));
  const dataIndex = segments.findIndex((segment) => segment.toLowerCase() === 'data');
  const start = anchor >= 0 ? anchor + 1 : dataIndex >= 0 && dataIndex < segments.length - 1 ? dataIndex + 1 : segments.length - 1;
  const tail = segments.slice(start);
  return tail.length > 0 ? tail.join('/') : String(name ?? '');
}

function toRelative(root, filePath) {
  const rel = relative(root, filePath);
  return rel.split(sep).join('/');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) throw new Error(`工作区不存在: ${workspace}`);
  const base = options.base ? resolve(options.base) : null;
  if (options.reference && !existsSync(REFERENCE_CLI)) throw new Error(`参考 CLI 不存在: ${REFERENCE_CLI}`);

  const { listContainerEntries } = await import(`file:///${CORE_DIST.replaceAll('\\', '/')}/editing/containerEntries.js`);
  const edit = {
    session: { layers: { overlayRoot: workspace, baseRoot: base }, meta: { workspaceId: 'cross-check' } },
    allowedRoots: () => (base ? [workspace, base] : [workspace]),
    oodleRuntimeRoot: undefined
  };

  let binders = collectBinders(workspace);
  if (options.filter) binders = binders.filter((item) => item.toLowerCase().includes(options.filter.toLowerCase()));
  if (Number.isFinite(options.limit)) binders = binders.slice(0, options.limit);

  const rows = [];
  for (const filePath of binders) {
    const relPath = toRelative(workspace, filePath);
    const soulforge = await listContainerEntries({ edit, file: filePath, includeContentHashes: options.hashes });
    if (!soulforge.ok) {
      rows.push({ relativePath: relPath, verdict: 'soulforge-error', error: soulforge.error });
      continue;
    }
    if (!options.reference) {
      rows.push({ relativePath: relPath, verdict: 'soulforge-only', soulforge: { entryCount: soulforge.entryCount, command: soulforge.command } });
      continue;
    }
    const reference = await runReferenceEntries(filePath);
    if (!reference.ok) {
      rows.push({
        relativePath: relPath,
        verdict: 'reference-error',
        soulforge: { entryCount: soulforge.entryCount, command: soulforge.command },
        error: { code: reference.code, message: reference.message }
      });
      continue;
    }
    const problems = [];
    if (reference.entries.length !== soulforge.entries.length) {
      problems.push({ kind: 'count', soulforge: soulforge.entries.length, reference: reference.entries.length });
    }
    const limit = Math.min(reference.entries.length, soulforge.entries.length);
    let hashMatches = 0;
    let hashMissing = 0;
    for (let index = 0; index < limit; index += 1) {
      const left = soulforge.entries[index];
      const right = reference.entries[index];
      if (right.ordinal !== undefined && right.ordinal !== index) {
        problems.push({ kind: 'ordinal', index, reference: right.ordinal });
      }
      if (right.id !== undefined && right.id !== null && left.id !== null && right.id !== left.id) {
        problems.push({ kind: 'id', index, soulforge: left.id, reference: right.id });
      }
      if (typeof right.size === 'number' && left.size !== null && right.size !== left.size) {
        problems.push({ kind: 'size', index, soulforge: left.size, reference: right.size });
      }
      const tail = referenceTail(right.name);
      if (tail !== left.name && !tail.endsWith(`/${left.name}`) && !tail.endsWith(left.name)) {
        problems.push({ kind: 'name', index, soulforge: left.name, referenceTail: tail });
      }
      // 成员字节身份：Bridge 的 contentHash 必须是条目解压后内容的 SHA-256，
      // 与参考 CLI 逐条相同才算"读到的成员就是这一个"。
      if (options.hashes && typeof right.sha256 === 'string') {
        if (left.contentHash === null) hashMissing += 1;
        else if (left.contentHash !== right.sha256) {
          problems.push({ kind: 'contentHash', index, soulforge: left.contentHash, reference: right.sha256 });
        } else hashMatches += 1;
      }
      if (problems.length >= 8) break;
    }
    rows.push({
      relativePath: relPath,
      verdict: problems.length === 0 ? 'parity' : 'mismatch',
      formatLayer: reference.formatLayer,
      soulforge: {
        command: soulforge.command,
        entryCount: soulforge.entryCount,
        compressionFormat: soulforge.compressionFormat,
        extensions: soulforge.extensions.slice(0, 8)
      },
      reference: { entryCount: reference.entries.length },
      ...(options.hashes ? { hashMatches, hashMissing } : {}),
      ...(problems.length > 0 ? { problems } : {})
    });
  }

  const counts = {};
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1;
  const totalEntries = rows.reduce((sum, row) => sum + (row.soulforge?.entryCount ?? 0), 0);
  const hashMatches = rows.reduce((sum, row) => sum + (row.hashMatches ?? 0), 0);
  const hashMissing = rows.reduce((sum, row) => sum + (row.hashMissing ?? 0), 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    workspace,
    base,
    containers: rows.length,
    members: totalEntries,
    ...(options.hashes ? { hashMatches, hashMissing } : {}),
    verdicts: counts,
    mismatch: counts.mismatch ?? 0
  };

  const outDir = resolve(REPO_ROOT, options.out);
  mkdirSync(outDir, { recursive: true });
  const stamp = summary.generatedAt.replaceAll(':', '-');
  const jsonPath = join(outDir, `containers-${stamp}.json`);
  writeFileSync(jsonPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`, 'utf8');
  const md = [
    `# 容器条目对拍（${summary.generatedAt}）`,
    '',
    `- 工作区：\`${workspace}\``,
    `- 容器数：${summary.containers}`,
    `- 成员总数：${summary.members}`,
    ...(options.hashes ? [`- 成员 SHA-256：一致 ${hashMatches}，缺失 ${hashMissing}`] : []),
    `- 判定：${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join('，') || '无'}`,
    '',
    '| 容器 | 判定 | SoulForge 成员 | 参考成员 |',
    '| --- | --- | --- | --- |'
  ];
  for (const row of rows.slice(0, 400)) {
    md.push(`| ${row.relativePath} | ${row.verdict} | ${row.soulforge?.entryCount ?? '-'} | ${row.reference?.entryCount ?? '-'} |`);
  }
  const mdPath = join(outDir, `containers-${stamp}.md`);
  writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({ ...summary, jsonPath, mdPath }, null, 2)}\n`);
  if ((counts.mismatch ?? 0) > 0) process.exit(2);
  const errors = (counts['soulforge-error'] ?? 0) + (counts['reference-error'] ?? 0);
  if (errors > 0) process.stdout.write(`注意：${errors} 个容器有一侧失败（见 ${jsonPath}）。\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
