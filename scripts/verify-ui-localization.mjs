import { readFile } from 'node:fs/promises';

const sources = [
  ['AI 侧边栏文案', await readFile(new URL('../packages/core/src/ai/assistantSession.ts', import.meta.url), 'utf8')]
];

const forbidden = [
  /\bProvider\b/,
  /\bFull permission\b/i,
  /\bFiles mode\b/i,
  /\bWorkspace \(overlay\)/i,
  /\bBase \(readonly\)/i,
  /\bCurrent context\b/i,
  /\bNo diagnostics\b/i,
  /\bSafe tools\b/i,
  /\bText editor\b/i,
  /\bText preview\b/i,
  /\bNative inspect\b/i,
  /\bEvidence index\b/i,
  /\blocal draft\b/i,
  /\bneeds config\b/i,
  /当前是 plan 模式/,
  /当前是 normal 模式/,
  /在 staging 中/
];

const failures = [];
for (const [name, source] of sources) {
  for (const pattern of forbidden) {
    if (pattern.test(source)) failures.push(`${name}: ${pattern}`);
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    message: '简体中文界面术语静态检查通过',
    checkedTerms: forbidden.length
  }, null, 2));
}
