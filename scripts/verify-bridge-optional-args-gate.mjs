#!/usr/bin/env node
/**
 * Bridge 可选参数守卫门禁。
 *
 * 守的问题:`BridgeCommandService.ExecuteAsync` 的 `options` 形参默认值是
 * `default(JsonElement)`,其 `ValueKind` 为 `Undefined`。对 Undefined 调
 * `TryGetProperty` 抛 `InvalidOperationException`
 * ("Operation is not valid due to the current state of the object.")。
 *
 * ── 这个缺陷实际造成过什么 ──
 *
 * 2026-08-09 用户报「打开 PARAM 全是空列表」。表面看像 PARAM 解析能力缺失,
 * 实测根因是 `read-param-document` 分支里两行裸 `TryGetProperty("rowPage"...)`:
 * 调用方不传 `commandOptions` 时必然抛异常。而该分支的 catch 只捕获
 * `InvalidDataException / NotSupportedException / IOException`,于是异常逃到
 * 守护进程兜底,被压成一句无出处的 `BRIDGE_REQUEST_FAILED`。
 *
 * 修好后同一批 param 立刻读出:AttackElementCorrectParam 56 行、
 * EquipParamGoods 590 行、BehaviorParam 5275 行 —— 解析能力一直是好的。
 *
 * 「不传可选参数就崩」这类缺陷不会被类型系统发现(C# 的可选形参合法)、
 * 不会有编译警告,而且症状指向完全错误的方向。
 *
 * 判据(静态读 C# 源码):
 *   ① 不得出现裸 `options.TryGetProperty(...)` —— 必须先经 ValueKind 守卫,
 *      或走 OptionInt 这类安全读取器;
 *   ② 安全读取器必须真的检查 ValueKind(否则它只是换了个名字的裸调用);
 *   ③ 守护进程兜底 catch 必须带上异常**类型名**:只回 ex.Message 时
 *      InvalidOperationException 的默认文案既看不出类型也看不出出处,
 *      本次排查就是被它挡了一轮;
 *   ④ 提取失败必须失败关闭 —— 扫不到任何 TryGetProperty 说明匹配规则坏了,
 *      此时判据①会零样本恒真。
 *
 * 不做的事:不验证各命令的分页语义是否正确(那由对应 smoke 负责),
 * 不做 C# 语义分析,只按行做结构判定 —— 宁可漏报也不误报。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'bridge-optional-args';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = join(root, 'bridge', 'SoulForge.Bridge', 'BridgeCommandService.cs');
const HOST = join(root, 'bridge', 'SoulForge.Bridge', 'BridgeDaemonHost.cs');

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

for (const [name, path] of [['BridgeCommandService.cs', SERVICE], ['BridgeDaemonHost.cs', HOST]]) {
  if (!existsSync(path)) {
    report({
      ok: false, gate: LABEL, status: 'failed', code: 'SOURCE_MISSING',
      message: `缺少 ${name}:${path}`
    }, 1);
  }
}

const serviceLines = readFileSync(SERVICE, 'utf8').split(/\r?\n/);
const hostSource = readFileSync(HOST, 'utf8');
const findings = [];

/** 剥掉行内注释,避免把注释里提到的调用当真实调用。 */
function stripComment(line) {
  const at = line.indexOf('//');
  return at >= 0 ? line.slice(0, at) : line;
}

// 判据①:扫所有 options.TryGetProperty 调用点。
const callSites = [];
serviceLines.forEach((raw, index) => {
  const line = stripComment(raw);
  if (!/\boptions\s*\.\s*TryGetProperty\s*\(/.test(line)) return;
  const lineNumber = index + 1;
  // 守卫可以在同一行,也可以在紧邻的前几行(多行条件表达式)。
  const window = serviceLines
    .slice(Math.max(0, index - 4), index + 1)
    .map(stripComment)
    .join(' ');
  const guarded = /options\s*\.\s*ValueKind\s*==\s*JsonValueKind\.Object/.test(window)
    || /\boptionsIsObject\b/.test(window)
    || /\boptionsObject\b/.test(window);
  callSites.push({ lineNumber, guarded, text: raw.trim().slice(0, 110) });
  if (!guarded) {
    findings.push({
      code: 'UNGUARDED_TRYGETPROPERTY',
      line: lineNumber,
      text: raw.trim().slice(0, 140),
      message: `第 ${lineNumber} 行对 options 裸调 TryGetProperty，未见 ValueKind 守卫。`
        + ' options 的默认值是 default(JsonElement)（ValueKind=Undefined），'
        + '对它调 TryGetProperty 抛 InvalidOperationException —— 调用方不传'
        + ' commandOptions 时该命令必然失败，且症状会指向完全错误的方向。'
    });
  }
});

// 判据④:提取失败必须失败关闭。
if (callSites.length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_CALL_SITES_FOUND',
    message: '在 BridgeCommandService.cs 里扫不到任何 options.TryGetProperty 调用点。'
      + ' 匹配规则坏掉时判据①会零样本恒真，故必须失败关闭。'
      + '（若确实已全部改走安全读取器，请同步更新本门禁的判据。）'
  }, 1);
}

// 判据②:安全读取器必须真的检查 ValueKind。
const serviceSource = serviceLines.join('\n');
const readerMatch = /int OptionInt\(string name, int fallback\)\s*\{([\s\S]*?)\n        \}/.exec(serviceSource);
if (!readerMatch) {
  findings.push({
    code: 'OPTION_READER_MISSING',
    message: '找不到 OptionInt 安全读取器。判据②无从校验；'
      + '若改用了别的读取器，请同步更新本门禁。'
  });
} else if (!/optionsIsObject/.test(readerMatch[1]) || !/ValueKind/.test(readerMatch[1])) {
  findings.push({
    code: 'OPTION_READER_UNGUARDED',
    body: readerMatch[1].trim().slice(0, 200),
    message: 'OptionInt 内部没有检查 optionsIsObject / ValueKind —— '
      + '那它只是换了个名字的裸调用，判据①会被它绕过。'
  });
}

// 判据③:兜底 catch 必须带异常类型名。
const fallbackMatch = /catch \(Exception ex\)\s*\{([\s\S]*?)BRIDGE_REQUEST_FAILED([\s\S]*?)\n        \}/
  .exec(hostSource);
if (!fallbackMatch) {
  findings.push({
    code: 'FALLBACK_CATCH_NOT_FOUND',
    message: '在 BridgeDaemonHost.cs 里找不到回 BRIDGE_REQUEST_FAILED 的兜底 catch；'
      + '判据③无从校验，失败关闭。'
  });
} else {
  const body = fallbackMatch[1] + fallbackMatch[2];
  if (!/ex\.GetType\(\)\.Name/.test(body)) {
    findings.push({
      code: 'FALLBACK_CATCH_DROPS_TYPE',
      message: '兜底 catch 没有带上 ex.GetType().Name。只回 ex.Message 时，'
        + 'InvalidOperationException 的默认文案是「Operation is not valid due to '
        + 'the current state of the object.」——既看不出类型也看不出出处。'
        + ' 本次 PARAM 排查就被它挡了一轮：症状指向「PARAM 解析能力缺失」，'
        + '真实原因是分页参数缺守卫。兜底 catch 的职责是不让进程崩，'
        + '不是让原因消失。'
    });
  }
  if (!/StackTrace/.test(body)) {
    findings.push({
      code: 'FALLBACK_CATCH_DROPS_ORIGIN',
      message: '兜底 catch 没有带上任何堆栈信息。异常类型能说明「是什么」，'
        + '但说明不了「在哪」——本次是靠加了 SoulForge 栈帧才定位到具体行号。'
    });
  }
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'BRIDGE_OPTIONAL_ARGS_VIOLATION',
    message: 'Bridge 可选参数守卫不完整，或兜底 catch 丢弃了异常出处。',
    callSiteCount: callSites.length,
    guardedCount: callSites.filter((entry) => entry.guarded).length,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  message: `${callSites.length} 处 options.TryGetProperty 全部有 ValueKind 守卫；`
    + '安全读取器自身检查 ValueKind；守护进程兜底 catch 带异常类型与堆栈出处。',
  callSiteCount: callSites.length,
  callSites: callSites.map((entry) => ({ line: entry.lineNumber, text: entry.text })),
  nonClaim: '本门禁只做按行的结构判定：调用点是否有守卫、读取器是否检查 ValueKind、'
    + '兜底 catch 是否带类型与堆栈。它不验证各命令的分页语义正确性（那由对应 smoke '
    + '负责），不做 C# 语义分析，也不覆盖 options 之外其他 JsonElement 的同类风险。'
}, 0);
