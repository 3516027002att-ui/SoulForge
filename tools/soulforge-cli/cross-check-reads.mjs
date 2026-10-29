#!/usr/bin/env node
/**
 * 全文件读取对拍：把 SoulForge 的资源读取与参考 CLI（SoulsFormats 适配器）
 * 的输出对齐到同一张表，逐文件给出判定。
 *
 * 对照口径（三列，缺一列就说明这一侧没有可比的输出）：
 *   1. 磁盘真值   —— 直接对工作区文件算 size/sha256；
 *   2. SoulForge —— `search_resources` 分页清单里的 size/sha256/kind；
 *   3. 参考 CLI   —— `soulsformats entries` 的 status 与 binder 条目（ordinal/
 *                    id/name/bytes/sha256）。
 *
 * 判定规则是显式的：哈希或字节数不一致即 mismatch；一侧能读另一侧说不支持
 * 记 coverage-gap（不是 mismatch，但必须列出来）；两侧都不是 binder 记
 * not-a-binder。
 *
 * 用法：
 *   node tools/soulforge-cli/cross-check-reads.mjs --workspace "<mods>" --base "<gameRoot>"
 *      [--out output/cross-check] [--limit N] [--no-reference] [--filter substr]
 *
 * 退出码：0 无 mismatch；2 存在 mismatch；1 用法/环境错误。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const SKIP_DIRS = new Set(['.soulforge', 'staging', 'backups', 'recovery']);

/** 点目录（`.soulforge`、`.smithbox` 等）是工具元数据，不是工作区资源。 */
function isToolMetadataDir(name) {
  return name.startsWith('.');
}

function parseArgs(argv) {
  const options = {
    workspace: null,
    base: null,
    out: join(REPO_ROOT, 'output', 'cross-check'),
    limit: 0,
    filter: null,
    reference: true,
    refcli: join(REPO_ROOT, 'Reference tools', 'cli', 'refcli.mjs')
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace') options.workspace = argv[++index];
    else if (arg === '--base') options.base = argv[++index];
    else if (arg === '--out') options.out = resolve(argv[++index]);
    else if (arg === '--limit') options.limit = Number(argv[++index] ?? 0);
    else if (arg === '--filter') options.filter = argv[++index];
    else if (arg === '--no-reference') options.reference = false;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('见文件头注释。\n');
      process.exit(0);
    } else {
      process.stderr.write(`未知参数: ${arg}\n`);
      process.exit(1);
    }
  }
  if (!options.workspace) {
    process.stderr.write('需要 --workspace <mods 目录>\n');
    process.exit(1);
  }
  return options;
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || isToolMetadataDir(entry.name)) continue;
        visit(join(dir, entry.name));
        continue;
      }
      if (isToolMetadataDir(entry.name)) continue;
      files.push(join(dir, entry.name));
    }
  };
  visit(root);
  return files.map((file) => relative(root, file).split(sep).join('/')).sort();
}

function hashFile(path) {
  const buffer = readFileSync(path);
  return { size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function parseJsonOutput(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 收集 SoulForge 的分页资源清单。 */
async function collectSoulForgeInventory(options) {
  const items = new Map();
  const storageRoot = join(REPO_ROOT, 'output', 'cli-storage');
  mkdirSync(storageRoot, { recursive: true });
  let cursor = null;
  for (let page = 0; page < 200; page += 1) {
    const args = [
      join(REPO_ROOT, 'tools', 'soulforge-cli', 'sfcli.mjs'),
      '--workspace', options.workspace,
      ...(options.base ? ['--base', options.base] : []),
      '--mode', 'plan', '--json', '--quiet',
      'call', '--stdin', 'search_resources'
    ];
    const payload = JSON.stringify(cursor ? { cursor, limit: 200 } : { limit: 200 });
    const result = await run(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { SF_E2E_WORKSPACE_STORAGE_ROOT: storageRoot },
      stdin: payload,
      timeoutMs: 900_000
    });
    const envelope = parseJsonOutput(result.stdout);
    if (!envelope || envelope.ok !== true) {
      return { ok: false, error: envelope?.error ?? result.stderr.slice(0, 400), items };
    }
    const record = envelope.data?.record ?? {};
    for (const match of Array.isArray(record.matches) ? record.matches : []) {
      const item = match?.item ?? match;
      if (!item?.relativePath) continue;
      items.set(String(item.relativePath), {
        relativePath: String(item.relativePath),
        sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
        size: typeof item.size === 'number' ? item.size : null,
        resourceKind: typeof item.resourceKind === 'string' ? item.resourceKind : null
      });
    }
    const next = envelope.pagination?.cursors?.nextCursor;
    if (!next || envelope.pagination?.truncated !== true) return { ok: true, items };
    cursor = next;
  }
  return { ok: true, items };
}

/** 参考 CLI：列出 binder 条目（非 binder 会返回 unsupported）。 */
async function probeReference(options, relPath) {
  const result = await run(process.execPath, [
    options.refcli, 'soulsformats', 'entries', '--input', relPath, '--source', 'workspace'
  ], { cwd: dirname(options.refcli), timeoutMs: 120_000 });
  const envelope = parseJsonOutput(result.stdout);
  if (!envelope) {
    return { status: 'error', code: 'CLI_OUTPUT_UNPARSABLE', entries: null, cleanup: null };
  }
  const codes = Array.isArray(envelope.diagnostics)
    ? envelope.diagnostics.map((entry) => String(entry?.code ?? 'DIAGNOSTIC'))
    : [];
  let entries = null;
  const artifact = (envelope.artifacts ?? []).find((item) => item.relativePath === 'entries.json');
  if (artifact?.path && existsSync(artifact.path)) {
    try {
      const parsed = JSON.parse(readFileSync(artifact.path, 'utf8'));
      const list = Array.isArray(parsed.entries) ? parsed.entries : [];
      entries = {
        count: list.length,
        sha256: artifact.sha256 ?? null,
        first: list.slice(0, 3).map((entry) => ({
          ordinal: entry.ordinal ?? null,
          name: entry.name ?? entry.fullName ?? null,
          bytes: entry.bytes ?? entry.size ?? null,
          sha256: entry.sha256 ?? null
        }))
      };
    } catch {
      entries = null;
    }
  }
  return { status: String(envelope.status ?? 'unknown'), codes, entries, cleanup: envelope.resultDir ?? null };
}

function cleanupResultDir(resultDir) {
  if (typeof resultDir !== 'string' || resultDir.length === 0) return;
  const resolved = resolve(resultDir);
  const boundary = resolve(REPO_ROOT, 'Reference tools', 'results');
  if (!resolved.startsWith(boundary + sep)) return;
  rmSync(resolved, { recursive: true, force: true });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace)) {
    process.stderr.write(`工作区不存在: ${workspace}\n`);
    process.exit(1);
  }

  const allFiles = walkFiles(workspace).filter((file) => !options.filter || file.includes(options.filter));
  const files = options.limit > 0 ? allFiles.slice(0, options.limit) : allFiles;
  process.stderr.write(`工作区文件: ${allFiles.length}，本次检查: ${files.length}\n`);

  const disk = new Map();
  for (const file of files) disk.set(file, hashFile(join(workspace, file)));

  process.stderr.write('采集 SoulForge 资源清单…\n');
  const inventory = await collectSoulForgeInventory({ ...options, workspace });
  if (!inventory.ok) {
    process.stderr.write(`SoulForge 清单失败: ${JSON.stringify(inventory.error)}\n`);
    process.exit(1);
  }
  process.stderr.write(`SoulForge 清单条目: ${inventory.items.size}\n`);

  const rows = [];
  let index = 0;
  for (const file of files) {
    index += 1;
    const truth = disk.get(file);
    const found = inventory.items.get(file) ?? null;
    const row = {
      file,
      disk: truth,
      soulforge: found,
      reference: null,
      verdict: null,
      notes: []
    };
    if (!found) row.notes.push('SoulForge 清单缺少该文件');
    else {
      if (found.sha256 !== truth.sha256) row.notes.push('sha256 不一致');
      if (found.size !== truth.size) row.notes.push(`size 不一致 (${found.size} vs ${truth.size})`);
    }
    if (options.reference) {
      const probe = await probeReference(options, file);
      row.reference = probe;
      cleanupResultDir(probe.cleanup);
    }
    const identityOk = found && found.sha256 === truth.sha256 && found.size === truth.size;
    const refStatus = row.reference?.status ?? null;
    const artifactLike = /\.(?:bak|orig|tmp|rej)$/i.test(file);
    if (!identityOk) row.verdict = artifactLike && !found ? 'artifact-excluded' : 'mismatch';
    else if (refStatus === 'ok' && !row.reference.entries) row.verdict = 'mismatch';
    else if (refStatus === 'ok') row.verdict = 'identity+entries';
    else if (refStatus === 'unsupported') row.verdict = 'identity-only';
    else if (refStatus === null) row.verdict = 'identity-only';
    else row.verdict = 'reference-error';
    rows.push(row);
    if (index % 25 === 0) process.stderr.write(`  ${index}/${files.length}\n`);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    workspace,
    files: rows.length,
    identityMatch: rows.filter((row) => row.verdict !== 'mismatch' && row.verdict !== 'reference-error').length,
    mismatch: rows.filter((row) => row.verdict === 'mismatch').length,
    referenceError: rows.filter((row) => row.verdict === 'reference-error').length,
    withEntries: rows.filter((row) => row.verdict === 'identity+entries').length,
    artifactExcluded: rows.filter((row) => row.verdict === 'artifact-excluded').length,
    identityOnly: rows.filter((row) => row.verdict === 'identity-only').length
  };

  mkdirSync(options.out, { recursive: true });
  const stamp = summary.generatedAt.replaceAll(':', '-');
  const jsonPath = join(options.out, `reads-${stamp}.json`);
  writeFileSync(jsonPath, `${JSON.stringify({ summary, rows }, null, 2)}\n`, 'utf8');

  const lines = [
    `# 全文件读取对拍（${summary.generatedAt}）`,
    '',
    `- 工作区：\`${workspace}\``,
    `- 文件数：${summary.files}`,
    `- 身份一致：${summary.identityMatch}`,
    `- 不一致：${summary.mismatch}`,
    `- 参考侧条目可比：${summary.withEntries}`,
    `- 仅身份可比（参考非 binder）：${summary.identityOnly}`,
    `- 参考侧错误：${summary.referenceError}`,
    ''
  ];
  const bad = rows.filter((row) => row.verdict === 'mismatch' || row.verdict === 'reference-error');
  if (bad.length > 0) {
    lines.push('## 需要处理的文件', '');
    for (const row of bad) {
      lines.push(`- \`${row.file}\` — ${row.verdict}: ${row.notes.join('；') || row.reference?.codes?.join(',') || '未知'}`);
    }
    lines.push('');
  }
  const binders = rows.filter((row) => row.verdict === 'identity+entries');
  if (binders.length > 0) {
    lines.push('## 参考 side 可列条目（binder）', '');
    for (const row of binders) {
      lines.push(`- \`${row.file}\` — entries=${row.reference.entries.count}`);
    }
    lines.push('');
  }
  const mdPath = join(options.out, `reads-${stamp}.md`);
  writeFileSync(mdPath, `\uFEFF${lines.join('\n')}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({ ...summary, jsonPath, mdPath }, null, 2)}\n`);
  process.exit(summary.mismatch > 0 || summary.referenceError > 0 ? 2 : 0);
}

await main();
