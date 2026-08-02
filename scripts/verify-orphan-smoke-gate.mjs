/**
 * 孤儿 smoke 门禁。
 *
 * 补上 `verify.mjs --audit` 结构性看不见的盲区：audit 检查「每条 npm script
 * 是否登记了层级」，因此它只能发现「有 script 但没层级」，看不见「有 smoke
 * 文件但没有任何 script 引用它」——那种文件既不在 audit 视野内，也永远不会被
 * 任何验证入口执行。
 *
 * 本轮实测到 5 个这样的文件，合计 3869 行，其中 runEditorBoundedAccessSmoke.ts
 * 是 W-REL-F-SCALE-02 的有界访问验证，还被 editorCapabilityContract.ts 的注释
 * 引用为「两侧共用同一套规则」的依据。写了、被引用了、但从未运行过。
 *
 * 判定规则：`packages/core/src/testing/run*Smoke.ts` 必须能在任一 workspace 的
 * package.json scripts 里找到对应的编译产物路径（dist/testing/<name>.js）。
 * 只允许通过显式白名单排除，且必须写明理由——理由缺失即失败。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const TESTING_DIR = join(repoRoot, 'packages', 'core', 'src', 'testing');
const PACKAGE_FILES = Object.freeze([
  'package.json',
  'packages/core/package.json',
  'packages/shared/package.json',
  'apps/desktop/package.json'
]);

/**
 * 显式排除：文件名 -> 理由。空理由或未列入即视为孤儿。
 * 这里刻意不做「按前缀批量豁免」：批量豁免会让新增孤儿自动隐身。
 */
const EXCLUDED = Object.freeze({
  // 由其他 smoke 以模块方式 import 复用的共享装置，本身不是独立入口。
  // 目前为空：本轮把全部 5 个孤儿都接成了真实入口，而不是豁免掉。
});

function collectScriptText() {
  const parts = [];
  for (const relative of PACKAGE_FILES) {
    const path = join(repoRoot, relative);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    parts.push(JSON.stringify(manifest.scripts ?? {}));
  }
  return parts.join('\n');
}

const scriptText = collectScriptText();
const findings = [];
const reachable = [];

for (const fileName of readdirSync(TESTING_DIR)) {
  if (!/^run.*Smoke\.ts$/.test(fileName)) continue;
  const compiled = `dist/testing/${fileName.replace(/\.ts$/, '.js')}`;
  if (scriptText.includes(compiled)) {
    reachable.push(fileName);
    continue;
  }
  const reason = EXCLUDED[fileName];
  if (typeof reason === 'string' && reason.trim().length > 0) {
    reachable.push(fileName);
    continue;
  }
  const lineCount = readFileSync(join(TESTING_DIR, fileName), 'utf8').split('\n').length;
  findings.push({
    file: `packages/core/src/testing/${fileName}`,
    lines: lineCount,
    code: 'SMOKE_UNREACHABLE',
    message: '该 smoke 没有任何 npm script 入口，永远不会被执行；请注册 script 并登记层级，或在本门禁的 EXCLUDED 中写明理由。'
  });
}

if (findings.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    code: 'ORPHAN_SMOKE_DETECTED',
    message: '存在从未被执行的 smoke 文件。写了不跑等于没写，且会伪装成已有覆盖。',
    orphanCount: findings.length,
    orphanLines: findings.reduce((sum, item) => sum + item.lines, 0),
    findings
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  message: '全部 smoke 文件均有 npm script 入口（无孤儿）',
  reachable: reachable.length,
  excluded: Object.keys(EXCLUDED).length,
  note: '层级归属由 verify.mjs --audit 单独门禁；本门禁只保证「存在入口」这一前置条件'
}, null, 2));
