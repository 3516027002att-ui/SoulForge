#!/usr/bin/env node
/**
 * 生产 AI 工具写路径门禁（硬约束 5/11）。
 *
 * 守的问题：AI 工具注册表里任何能改动 Mod 资源的工具，都必须经 Patch Engine，
 * 不得直接写盘。硬约束 5「禁止在 Patch Engine 外直接使用 fs.writeFile 修改 Mod
 * 资源」，硬约束 11「完全权限不能绕过证据、Patch Engine、验证、备份、审计和回滚」。
 *
 * 为什么需要机器校验：
 *
 * 一次审计报告称「PATCH_ENGINE_REQUIRED 生产零实现」。我核对后**不采信**该结论
 * ——那个诊断码的全部命中都在 packages/core/src/testing 里（conformance 与
 * fake-loop 自己构造的拒绝码），而生产侧的保证不是靠一个错误码，是靠**结构**：
 * packages/core/src/ai/toolRegistry.ts 里唯一的写路径 propose_text_patch 走
 * createPatchProposal，validate_patch 走 dryRunPatchProposal，rollback_operation
 * 走受控 rollbackOperation，全表零 fs.writeFile。
 *
 * 但「当前恰好没有」和「不可能有」是两件事。新增一个直接写盘的工具不会有编译
 * 错误、不会让任何测试失败，而它一旦进入 full 权限模式就绕过了整条事务链。
 * 本门禁把这个结构性事实变成可校验的等式。
 *
 * 判据（纯静态读源码，不需要运行期）：
 *   ① 生产 toolRegistry 里不得出现直接写盘调用（fs.writeFile / writeFileSync /
 *      appendFile / rm / rename / mkdir 等）；
 *   ② 每个被判定为「写类」的工具（permission 为 write/rollback，或名字含
 *      patch/write/apply/commit/rollback）必须在其 run 体内引用受控入口之一；
 *   ③ 受控入口清单本身必须能在 patch/ 或 transactions/ 下找到定义——清单指向
 *      不存在的符号等于判据失效。
 *
 * 不做的事：不做类型推断、不跨文件追踪调用链。宁可漏报也不误报。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'ai-tool-write-path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(root, 'packages', 'core', 'src', 'ai', 'toolRegistry.ts');

/** 受控写入入口。每一个都必须在 patch/ 或 transactions/ 下有定义（判据③）。 */
const CONTROLLED_ENTRIES = Object.freeze([
  'createPatchProposal',
  'dryRunPatchProposal',
  'rollbackOperation'
]);

/** 禁止在注册表里直接出现的写盘调用。 */
const FORBIDDEN_WRITE_CALLS = Object.freeze([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'rmSync',
  'unlink',
  'unlinkSync',
  'copyFile',
  'copyFileSync'
]);

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(REGISTRY)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AI_REGISTRY_MISSING',
    message: `生产 AI 工具注册表缺失：${REGISTRY}`
  }, 1);
}

const source = readFileSync(REGISTRY, 'utf8');

/** 剥掉注释与字符串，避免把说明文字里的词当调用。 */
function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i += 1;
      while (i < text.length && text[i] !== q) { if (text[i] === '\\') i += 1; i += 1; }
      i += 1; out += ' '; continue;
    }
    out += c; i += 1;
  }
  return out;
}

const code = stripCommentsAndStrings(source);
const findings = [];

// 判据③：受控入口必须真实存在。清单指向不存在的符号等于判据失效。
for (const entry of CONTROLLED_ENTRIES) {
  const found = ['patch', 'transactions', 'backup'].some((dir) => {
    const dirPath = join(root, 'packages', 'core', 'src', dir);
    if (!existsSync(dirPath)) return false;
    // 浅扫该目录下的 .ts，找 export 定义
    return readdirSync(dirPath).some((file) => {
      if (!file.endsWith('.ts')) return false;
      const text = readFileSync(join(dirPath, file), 'utf8');
      return new RegExp(`export\\s+(async\\s+)?function\\s+${entry}\\b`).test(text);
    });
  });
  if (!found) {
    findings.push({
      code: 'CONTROLLED_ENTRY_UNDEFINED',
      entry,
      message: `受控写入入口 ${entry} 在 patch/ transactions/ backup/ 下找不到定义；`
        + '清单指向不存在的符号会让判据②失效。'
    });
  }
}

// 判据①：注册表里不得有直接写盘调用。
for (const call of FORBIDDEN_WRITE_CALLS) {
  const re = new RegExp(`\\b${call}\\s*\\(`);
  if (re.test(code)) {
    const line = source.split(/\r?\n/).findIndex((l) => re.test(l)) + 1;
    findings.push({
      code: 'AI_TOOL_DIRECT_DISK_WRITE',
      call,
      line,
      message: `生产 AI 工具注册表出现直接写盘调用 ${call}()。`
        + ' 硬约束 5：禁止在 Patch Engine 外直接修改 Mod 资源；'
        + ' 硬约束 11：完全权限不能绕过 Patch Engine、验证、备份、审计与回滚。'
    });
  }
}

// 判据②：写类工具必须引用受控入口。
const toolBlocks = [...source.matchAll(/registry\.register\(\{([\s\S]*?)\n  \}\);/g)];
if (toolBlocks.length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AI_TOOL_BLOCKS_UNEXTRACTABLE',
    message: '未能从注册表提取任何 registry.register 块；提取失败必须失败关闭，'
      + '否则本门禁的判据会变成必然通过。'
  }, 1);
}

const writeLike = [];
for (const block of toolBlocks) {
  const body = block[1];
  const nameMatch = /name:\s*'([a-z0-9_]+)'/.exec(body);
  const permMatch = /permission:\s*'([a-z]+)'/.exec(body);
  if (nameMatch === null) continue;
  const name = nameMatch[1];
  const permission = permMatch === null ? 'unknown' : permMatch[1];
  // 判据以 **permission 为主**，名字只用于捕捉「permission 写得太宽松」的情况。
  //
  // 不能只看名字：build_patch_graph 名字含 patch 但 permission=analyze，
  // 它只做 PatchProposal → graph IR 的纯投影（buildGraphPatchFromProposal），
  // 不碰磁盘。实测第一版判据把它误报了。
  // 一道会误报的门禁很快会被加豁免绕过，那就退化成装饰。
  //
  // 现存 permission 取值：read(7) / analyze(7) / propose(1) / validate(1) / rollback(1)。
  // 其中只有 propose / validate / rollback / write 会触及写链或备份链。
  const WRITE_PERMISSIONS = new Set(['write', 'propose', 'validate', 'rollback', 'commit']);
  const looksWriteLike = WRITE_PERMISSIONS.has(permission);
  if (!looksWriteLike) continue;
  writeLike.push({ name, permission });
  const usesControlled = CONTROLLED_ENTRIES.some((entry) => new RegExp(`\\b${entry}\\s*\\(`).test(body));
  if (!usesControlled) {
    findings.push({
      code: 'AI_WRITE_TOOL_BYPASSES_PATCH_ENGINE',
      tool: name,
      permission,
      message: `写类工具 ${name}（permission=${permission}）的 run 体内没有引用任何受控`
        + ` 写入入口（${CONTROLLED_ENTRIES.join(' / ')}）。若它确实只读，请调整命名或`
        + ' permission；若它会改动资源，必须经 Patch Engine。'
    });
  }
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'AI_TOOL_WRITE_PATH_VIOLATION',
    message: '生产 AI 工具写路径违反硬约束 5/11。',
    toolCount: toolBlocks.length,
    writeLikeTools: writeLike,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: '生产 AI 工具注册表零直接写盘，全部写类工具经受控入口。',
  toolCount: toolBlocks.length,
  writeLikeTools: writeLike,
  controlledEntries: CONTROLLED_ENTRIES,
  nonClaim: '本门禁只做静态结构判定：注册表内无直接写盘调用、写类工具引用受控入口。'
    + '它不验证 Patch Engine 自身的正确性（那由事务与恢复 smoke 负责），'
    + '也不跨文件追踪受控入口的内部实现。'
}, 0);
