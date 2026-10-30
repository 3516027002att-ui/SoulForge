import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = process.cwd();
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const testScripts = Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith('test'));

// 收集文档/CI 里出现的 `npm run <name>`
const referenced = new Set();
function walk(dir, depth = 0) {
  if (depth > 3) return;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'output') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, depth + 1);
      continue;
    }
    if (!/\.(md|ya?ml)$/u.test(entry.name)) continue;
    const text = readFileSync(full, 'utf8');
    for (const match of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/gu)) referenced.add(match[1]);
  }
}
for (const dir of ['.github', 'docs']) walk(join(repoRoot, dir));
for (const file of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
  try {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    for (const match of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/gu)) referenced.add(match[1]);
  } catch {
    // 文件不存在就跳过
  }
}

const referencedTestScripts = testScripts.filter((name) => referenced.has(name));
const orphanTestScripts = testScripts.filter((name) => !referenced.has(name));

console.log(JSON.stringify({
  testScripts: testScripts.length,
  referencedTestScripts: referencedTestScripts.length,
  orphanTestScripts: orphanTestScripts.length,
  referencedSample: referencedTestScripts.slice(0, 10),
  orphanSample: orphanTestScripts.slice(0, 10)
}, null, 2));
