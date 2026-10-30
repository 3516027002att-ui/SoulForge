#!/usr/bin/env node
/**
 * 死表审计（#41）：把工作区库里的每张表和生产代码里的引用对上号。
 *
 * 为什么要有这个脚本：一张表"没人读"这件事无法通过读代码断言——它只会出现在
 * 动态 SQL、仓储层或某个一次性导入里。要退役 24 张表，必须先有一份可重跑的台账，
 * 否则删表迁移就是凭印象动手。
 *
 * 判定口径：
 *   - 表名从**真实建库**得到（sqlite_master），不用正则扫 DDL；
 *   - 引用只统计生产代码（packages/core/src、apps/desktop/src、bridge），排除
 *     *​.test.*、src/testing/**、dist/out/bin/obj，以及 schema/迁移文件本身；
 *   - 每条引用给出 file:line，方便逐条确认是"表名"还是同名词（例如 OpenAI 的
 *     `tool_calls` 字段、键位表里的 `text_entries`）。
 *
 * 用法：
 *   node scripts/audit-dead-tables.mjs                # 打印台账
 *   node scripts/audit-dead-tables.mjs --json         # 机器可读
 *   node scripts/audit-dead-tables.mjs --check <file> # 与登记的退役清单对齐
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkspaceDatabase } from '../packages/core/dist/storage/sqliteDatabase.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['packages/core/src', 'apps/desktop/src', 'bridge'];
const EXCLUDED_PATH = /(\\|\/)(dist|out|bin|obj|node_modules)(\\|\/)/;
const EXCLUDED_FILE = /\.test\.|sqliteSchema\.ts$|Migrations?\.ts$/;

function listProductionFiles(directory, found = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (EXCLUDED_PATH.test(path)) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'testing') continue;
      listProductionFiles(path, found);
      continue;
    }
    if (!/\.(ts|tsx|cs)$/.test(entry.name)) continue;
    if (EXCLUDED_FILE.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

function listTables() {
  const directory = mkdtempSync(join(tmpdir(), 'sf-dead-table-audit-'));
  const databasePath = join(directory, 'workspace.db');
  const database = openWorkspaceDatabase(databasePath);
  try {
    return database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function collectReferences(files, table) {
  const pattern = new RegExp(`\\b${table}\\b`);
  const references = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(table)) continue;
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index])) continue;
      references.push({
        file: relative(root, file).replaceAll('\\', '/'),
        line: index + 1,
        text: lines[index].trim().slice(0, 160)
      });
    }
  }
  return references;
}

const tables = listTables();
const files = SCAN_ROOTS.flatMap((scanRoot) => listProductionFiles(join(root, scanRoot)));

// --check 会登记一些"当前 schema 已经不再创建、只遗留在旧库里的表"：它们同样要
// 审计引用，所以把登记表里的名字并进审计集合。
const checkIndex = process.argv.indexOf('--check');
const expectedPath = checkIndex >= 0 ? process.argv[checkIndex + 1] : undefined;
const expected = expectedPath ? JSON.parse(readFileSync(resolve(root, expectedPath), 'utf8')) : undefined;
const declaredNames = [
  ...(expected?.retire ?? []).map((entry) => entry.table),
  ...(expected?.writeOnly ?? []).map((entry) => entry.table)
];
const auditNames = [...new Set([...tables, ...declaredNames])].sort();
const audit = auditNames.map((table) => {
  const references = collectReferences(files, table);
  return { table, referenceCount: references.length, references };
});

const dead = audit.filter((entry) => entry.referenceCount === 0).map((entry) => entry.table);
const referenced = audit.filter((entry) => entry.referenceCount > 0);

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tableCount: tables.length,
    scannedFiles: files.length,
    deadTables: dead,
    referencedTables: referenced
  }, null, 2)}\n`);
  process.exit(0);
}

if (checkIndex >= 0 && !expectedPath) {
  console.error(JSON.stringify({ ok: false, code: 'RETIRE_LIST_REQUIRED', message: '用法：--check <退役清单.json>' }));
  process.exit(2);
}
if (expected) {
  const declared = [...(expected.retire ?? [])].sort();
  const writeOnly = expected.writeOnly ?? [];
  // 当前 schema 不再创建 = 代码侧已退役（只剩旧库里的遗留），删表迁移用
  // DROP TABLE IF EXISTS 覆盖即可；这里与"仍有引用"分开报告。
  const notInSchema = declared.filter((table) => !tables.includes(table));
  const stillPresent = declared.filter((table) => tables.includes(table));
  const drift = stillPresent.filter((table) => !dead.includes(table));
  // 只写表不是"引用为 0"，而是"引用只出现在声明的写入方里"。只要有人新增读取，
  // 这里立刻红——否则删表迁移会连带删掉某个刚接上的读取路径。
  const writeOnlyDrift = [];
  for (const entry of writeOnly) {
    const actual = referenced.find((item) => item.table === entry.table);
    if (!actual) {
      writeOnlyDrift.push({ table: entry.table, reason: 'declared-write-only-but-dead', references: [] });
      continue;
    }
    const allowed = new Set(entry.writers ?? []);
    const unexpected = actual.references.filter((reference) => !allowed.has(reference.file));
    if (unexpected.length > 0) {
      writeOnlyDrift.push({ table: entry.table, reason: 'unexpected-reference', references: unexpected });
    }
  }
  const undeclared = dead.filter((table) => !declared.includes(table));
  const ok = drift.length === 0 && writeOnlyDrift.length === 0;
  const report = {
    ok,
    declaredRetired: declared.length,
    declaredWriteOnly: writeOnly.length,
    notInCurrentSchema: notInSchema,
    declaredButReferenced: drift.map((table) => ({
      table,
      references: referenced.find((entry) => entry.table === table)?.references ?? []
    })),
    writeOnlyDrift,
    newDeadTables: undeclared,
    nonClaim: '本脚本只做静态引用审计；运行时动态 SQL 仍以测试与实跑为准。'
  };
  if (!ok) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  tableCount: tables.length,
  scannedFiles: files.length,
  deadTableCount: dead.length,
  deadTables: dead,
  referencedTables: referenced.map((entry) => ({
    table: entry.table,
    referenceCount: entry.referenceCount,
    firstReferences: entry.references.slice(0, 3),
    bytesTouched: statSync ? undefined : undefined
  }))
}, null, 2)}\n`);
