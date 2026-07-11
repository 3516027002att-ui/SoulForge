/**
 * Static release-content audit: ensure the repo / built desktop artifacts do not
 * ship private mods, Oodle DLLs, or obvious secret files.
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const forbiddenNamePatterns = [
  /oo2core_.*\.dll$/i,
  /\.pem$/i,
  /\.p12$/i,
  /id_rsa$/i,
  /\.env$/i,
  /api[-_]?key/i
];
const forbiddenPathFragments = [
  `${join('mods', '')}`.replace(/\\/g, '/'),
];

const findings = [];

function walk(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'bin' || entry.name === 'obj') continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      // mods/ must exist for local dev but must never be packaged as product content claim
      if (rel === 'mods') {
        findings.push({ severity: 'info', code: 'DEV_MODS_PRESENT', path: rel, message: '开发期 mods/ 存在；发行包不得包含。' });
        continue; // do not walk private corpus
      }
      walk(full, depth + 1);
      continue;
    }
    for (const pattern of forbiddenNamePatterns) {
      if (pattern.test(entry.name) || pattern.test(rel)) {
        findings.push({ severity: 'error', code: 'FORBIDDEN_RELEASE_FILE', path: rel, message: `禁止进入发行包：${entry.name}` });
      }
    }
  }
}

walk(root);

// Desktop out/ if present
const outDir = join(root, 'apps/desktop/out');
if (existsSync(outDir)) {
  walk(outDir);
}

const errors = findings.filter((f) => f.severity === 'error');
const result = {
  ok: errors.length === 0,
  message: errors.length === 0
    ? '发行内容静态审计通过（未发现 Oodle/密钥类文件；mods/ 仅记为开发资料）'
    : '发行内容静态审计失败',
  findings,
  note: '本门禁是源树/构建产物静态扫描，不是已签名安装包内容证明。'
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
