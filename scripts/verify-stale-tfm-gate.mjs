#!/usr/bin/env node
/**
 * 陈旧 TFM 构建产物门禁。
 *
 * 拦的是**残留**：`bridge/SoulForge.Bridge/bin/<Config>/` 下出现与当前
 * csproj 的 TargetFramework 不符的目录，说明历史上换过 TFM 而旧产物没被清掉。
 *
 * 为什么需要它（2026-08-08 实测）：清理时在 bin/Debug 下发现 net6.0（7/7 产物）
 * 与 net8.0（7/3 产物）两个目录，各 5 个文件含可执行的 SoulForge.Bridge.exe，
 * 而当前 TFM 是 net10.0。它们：
 *   · 被 .gitignore 覆盖 → git status 永远看不见
 *   · 全仓零引用 → 没有任何测试或脚本会碰它们
 *   · 却是**可执行的旧版 Bridge** → 有人手误指向它，会拿到一个月前的解析行为
 * 这与探针残留（verify-probe-residual-gate）同源：不可见、无人清、只会堆积。
 * 而这一类更危险，因为它是能跑起来的旧代码而不是死文件。
 *
 * 判据刻意**从 csproj 推导**而不是硬编码 net10.0：写死版本号的门禁在下次升级 TFM
 * 时会把新产物报成残留，然后被加豁免绕过。TargetFramework 提取失败即失败关闭——
 * 提取不到时若默认放行，这道门禁就变成一条永远报绿的空断言。
 *
 * ── 负向证明（2026-08-08 实测，四条分支逐个跑过，不是推断）──
 * 本仓库历史上约一半门禁是「没实测过会红」的假门禁，所以接线前逐条证明：
 *   ① 正向：干净树 exit 0（当时 bin 下只有 Debug/net10.0）。
 *   ② STALE_TFM_OUTPUT：植入 bin/Debug/net8.0/SoulForge.Bridge.dll → exit 1，
 *      点名该目录且 hasExecutable=true；删除后复跑回 exit 0（判别力双向成立）。
 *   ③ CSPROJ_MISSING / TFM_UNEXTRACTABLE / NO_CONFIG_DIR_SCANNED：在临时沙箱里
 *      分别构造「无 csproj」「csproj 无 TargetFramework 元素」「bin/ 存在但其下无
 *      配置目录」，三条各自 exit 1 并报出自己的码——即三道失败关闭不是装饰。
 *   ④ 多目标不得误报：<TargetFrameworks>net10.0;net8.0</TargetFrameworks> 且两个
 *      目录都在场 → exit 0。这条防的是升级 TFM 时把新产物报成残留那种误红，
 *      误红比漏拒更糟：它会诱导下一个人加豁免，把整道门禁绕过去。
 * 沙箱证明脚本是一次性的，跑完即删（留着会被 probe-residual-gate 抓成残留）；
 * 复现方法写在这里，比留一个没人跑的探针文件更可靠。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const CSPROJ = join(repoRoot, 'bridge', 'SoulForge.Bridge', 'SoulForge.Bridge.csproj');
const BIN = join(repoRoot, 'bridge', 'SoulForge.Bridge', 'bin');
const LABEL = 'stale-tfm';

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(CSPROJ)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'CSPROJ_MISSING',
    message: `未找到 csproj：${CSPROJ}。判据的唯一权威是它声明的 TargetFramework，`
      + '读不到就无法判断哪些 TFM 目录是残留，故失败关闭而不是放行。'
  }, 1);
}

const csproj = readFileSync(CSPROJ, 'utf8');
// 同时接受 TargetFramework 与 TargetFrameworks（多目标时逗号分隔）
const single = /<TargetFramework>\s*([^<\s]+)\s*<\/TargetFramework>/.exec(csproj);
const multi = /<TargetFrameworks>\s*([^<]+)\s*<\/TargetFrameworks>/.exec(csproj);
const declared = single !== null
  ? [single[1]]
  : multi !== null
    ? multi[1].split(';').map((t) => t.trim()).filter(Boolean)
    : [];

if (declared.length === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'TFM_UNEXTRACTABLE',
    message: '无法从 csproj 提取 TargetFramework(s)。提取失败必须失败关闭——'
      + '若默认放行，本门禁会变成一条永远报绿的空断言（改了 csproj 写法就静默失效）。'
  }, 1);
}

// bin/ 不存在是合法的（没构建过），不是残留
if (!existsSync(BIN)) {
  report({
    ok: true, gate: LABEL, status: 'passed',
    message: 'bin/ 不存在（尚未构建），无陈旧 TFM 产物。',
    declaredTargetFrameworks: declared
  }, 0);
}

const findings = [];
let scannedConfigs = 0;

for (const config of readdirSync(BIN)) {
  const configDir = join(BIN, config);
  if (!statSync(configDir).isDirectory()) continue;
  scannedConfigs += 1;
  for (const entry of readdirSync(configDir)) {
    const tfmDir = join(configDir, entry);
    if (!statSync(tfmDir).isDirectory()) continue;
    if (declared.includes(entry)) continue;
    // 统计里面有没有可执行产物——那决定这条残留有多危险
    let fileCount = 0;
    let hasExecutable = false;
    const walk = (dir) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        fileCount += 1;
        if (/\.(exe|dll)$/i.test(f.name)) hasExecutable = true;
      }
    };
    walk(tfmDir);
    findings.push({
      path: `bridge/SoulForge.Bridge/bin/${config}/${entry}`,
      tfm: entry,
      config,
      fileCount,
      hasExecutable,
      code: 'STALE_TFM_OUTPUT',
      message: `与 csproj 声明的 TargetFramework(${declared.join(', ')}) 不符的构建产物目录。`
        + (hasExecutable
          ? ' 它含可执行产物——那是能跑起来的旧版 Bridge，有人手误指向它会拿到旧解析行为。'
          : ' 它不含可执行产物，但仍是无人清理的堆积。')
        + ' 被 .gitignore 覆盖，git status 看不见；删除即可。'
    });
  }
}

if (scannedConfigs === 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'NO_CONFIG_DIR_SCANNED',
    message: `bin/ 存在但其下没有任何配置目录（Debug/Release）。扫描面为空时判据不成立，`
      + '失败关闭而不是报绿。',
    declaredTargetFrameworks: declared
  }, 1);
}

if (findings.length > 0) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'STALE_TFM_OUTPUT',
    message: '存在与当前 TargetFramework 不符的构建产物目录。它们被 gitignore 覆盖、'
      + '全仓零引用，只会静默堆积；含 exe/dll 的那些还是能跑起来的旧版 Bridge。',
    declaredTargetFrameworks: declared,
    scannedConfigs,
    staleCount: findings.length,
    findings
  }, 1);
}

report({
  ok: true, gate: LABEL, status: 'passed',
  message: '构建产物目录与 csproj 声明的 TargetFramework 一致，无陈旧 TFM 残留。',
  declaredTargetFrameworks: declared,
  scannedConfigs,
  note: '本门禁拦的是残留而非存在：换 TFM 时旧目录留在原地才是问题，构建本身不是。'
}, 0);
