import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const handoffPath = resolve(root, 'docs/V0_5_IMPLEMENTATION_HANDOFF.md');
const readmePath = resolve(root, 'README.md');
const bridgeReadmePath = resolve(root, 'bridge/SoulForge.Bridge/README.md');

const [handoff, readme, bridgeReadme] = await Promise.all([
  readFile(handoffPath, 'utf8'),
  readFile(readmePath, 'utf8'),
  readFile(bridgeReadmePath, 'utf8')
]);

const sectionStart = handoff.indexOf('## 42. 最终执行检查表');
const sectionEnd = handoff.indexOf('## 43. 实施进度记录');
const failures = [];

if (sectionStart < 0 || sectionEnd <= sectionStart) {
  failures.push('无法定位第 42 节最终执行检查表。');
}

const checklist = sectionStart >= 0 && sectionEnd > sectionStart
  ? handoff.slice(sectionStart, sectionEnd)
  : '';
const currentHandoff = sectionEnd > 0 ? handoff.slice(0, sectionEnd) : handoff;
const taskLines = checklist.split(/\r?\n/).filter((line) => /^- \[[ x]\] /.test(line));
const forbiddenCheckedEvidence = /partial|candidate|fixture-confirmed|blocked|skipped|unverified|unsupported|未完|未验证|未实现|跳过|仍需|不得当作|无 env|未配置/i;

for (const line of taskLines) {
  if (line.startsWith('- [x] ') && forbiddenCheckedEvidence.test(line)) {
    failures.push(`完成项含未完成证据：${line}`);
  }
}

if (!checklist.includes('`[x]` 仅表示该条目按交接书定义完整通过')) {
  failures.push('第 42 节缺少复选框状态语义。');
}
if (!checklist.includes('- [ ] 最终 V0.5 release criteria 全绿')) {
  failures.push('最终 V0.5 release criteria 必须保持未勾选，直到完整发布门禁通过。');
}

for (const stale of [
  '没有 desktop production caller',
  '两套注册表仍并存，desktop 使用旧 registry',
  'AI 固定 plan mode',
  '当前桌面 AI 模式由 main 锁定为计划模式',
  'KRAK 依赖合法 Oodle，当前成功路径未验证'
]) {
  if (currentHandoff.includes(stale)) {
    failures.push(`交接书当前权威章节仍含已过时状态：${stale}`);
  }
}

for (const required of [
  '唯一生产 typed registry',
  'grant mode/scope 在 main fail-closed 校验',
  '1 个 registry/hash 绑定真实 KRAK 解压正向样本已验证'
]) {
  if (!currentHandoff.includes(required)) {
    failures.push(`交接书当前权威章节缺少已验证状态：${required}`);
  }
}

if (/^\s*-\s*$/m.test(handoff)) {
  failures.push('交接书实施记录含空白列表项。');
}

for (const stale of [
  '- SQLite runtime authority。',
  '- Bridge daemon。',
  '截至 2026-07-15 当前工作树',
  'KRAK/Oodle 真实成功路径，以及 KRAK 内 BND4 corpus。',
  '真实模型服务桌面生产接线、持久 grant、Context Broker、AI retention 和出站审计。'
]) {
  if (readme.includes(stale)) failures.push(`README 仍含已过时状态：${stale}`);
}
for (const required of [
  '桌面生产接线、持久 grant、Context Broker、AI retention 和出站审计后端已接',
  '1 个 registry/hash 绑定的真实 Oodle/KRAK 解压正向样本'
]) {
  if (!readme.includes(required)) failures.push(`README 缺少当前能力边界：${required}`);
}
if (bridgeReadme.includes('现有格式能力仍只有受限检查、synthetic 样本验证和候选导出')) {
  failures.push('Bridge README 仍把已存在的 native 子能力描述为仅候选导出。');
}
if (bridgeReadme.includes('KRAK/Oodle 成功路径尚未验证')) {
  failures.push('Bridge README 仍把已验证的登记 KRAK 解压正向路径描述为未验证。');
}
if (!bridgeReadme.includes('真实 Oodle/KRAK 解压成功路径已验证')) {
  failures.push('Bridge README 缺少登记 KRAK 解压正向证据。');
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    message: '实施进度与概览文档完整性门禁通过',
    checklistItems: taskLines.length,
    checkedItems: taskLines.filter((line) => line.startsWith('- [x] ')).length,
    uncheckedItems: taskLines.filter((line) => line.startsWith('- [ ] ')).length
  }, null, 2));
}
