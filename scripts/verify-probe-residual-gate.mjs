/**
 * 探针/临时文件零容忍门禁。
 *
 * 探针本身是合法工具：定位「某条断言到底有没有执行」时，往 scripts/ 插一个
 * `_probe*.mjs` 打印分支与 payload 是既有做法。问题出在**残留**——它们用完
 * 留在原地，而 `.gitignore` 又把 `scripts/_tmp_*` 之类忽略掉，于是 `git status`
 * 永远干净，没有任何信号提醒它们还在。实测 2026-08-02 在 scripts/ 一次清出 16 个
 * 这类文件，最早的建于半个月前，跨半个月无人发现。纯约定不带门禁 = 迟早失效。
 *
 * 所以判据是「验证时不得存在这类文件」，而不是「任何时候都不得创建」：
 * 工作时临时建一个探针完全合法，只要提交/验证前删掉。本门禁跑在 governance 层，
 * 拦的是残留，不是存在。
 *
 * 判据形态刻意是「扫实际文件名」而非「维护一份黑名单」——只迭代自己清单的门禁
 * 从不扫仓库，是已实测的假门禁形态之一。递归扫描，命中前缀 `_probe` / `_tmp`
 * 的文件或目录即违规；命中目录就报告该目录本身、不再下钻。
 *
 * 扫描范围是**整个仓库**而不只是 scripts/。原实现只扫 scripts/，而 2026-08-08 实测
 * 探针实际散落在三处：scripts/（子代理留下的 _tmp_probe_t44.mjs）、output/（8/4 那批
 * 六个 _probe_*.mjs 加两个目录，已残留四天）、packages/core/dist/（_tmpProbeHeaders
 * 的编译产物，源码早已删除、产物从 7/31 留到当天，且 dist/_tmp/ 下还藏着整条 Bridge
 * 客户端的副本）。三处都被 .gitignore 覆盖，所以「换个目录放探针」就能完全绕过旧范围
 * ——这属于门禁自己的盲区，不是纪律问题。dist 那处尤其值得记：它连源文件都没有了，
 * 靠删源码不会带走产物。
 *
 * 排除 node_modules 与 .git：前者是依赖树（第三方包里带 _tmp 前缀的文件不是我们的
 * 残留），后者是 git 内部存储。两者都不是我们能清理的对象，扫进来只会制造无法消除
 * 的假红。
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** 残留探针/临时文件的前缀。basename 以这些开头即视为残留。 */
const RESIDUAL_PREFIXES = Object.freeze(['_probe', '_tmp']);

/**
 * 不扫描的目录名。只列「不属于本仓库产出、我们无权也无法清理」的两个：
 * 依赖树与 git 内部存储。**不要**往这里加 output/ 或 dist/ 之类自己的目录——
 * 那正是本门禁要覆盖的地方，加进来等于把刚补上的盲区重新打开。
 */
const EXCLUDED_DIRS = Object.freeze(['node_modules', '.git']);

function isResidual(name) {
  return RESIDUAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const findings = [];
let scannedDirs = 0;

function scan(dir) {
  scannedDirs += 1;
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (isResidual(entry)) {
      const kind = statSync(absolute).isDirectory() ? 'directory' : 'file';
      const shown = relative(repoRoot, absolute).split('\\').join('/');
      findings.push({
        file: shown,
        kind,
        code: 'PROBE_FILE_RESIDUAL',
        message: `残留了 ${kind === 'directory' ? '临时目录' : '探针/临时文件'} ${shown}。`
          + ' 探针是合法调试工具，但用完必须删除——它被 .gitignore 忽略，不进 git status，'
          + ' 没有任何别的信号会提醒它还在。请删除后重跑。'
          + ' 若它在 dist/ 下，删源码不会带走产物，需一并清理编译产物。'
      });
      // 命中目录就报告目录本身，不再下钻：残留目录整体删掉即可，逐个列举其内容
      // 只会让诊断变长，不增加信息。
      continue;
    }
    if (statSync(absolute).isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry)) continue;
      scan(absolute);
    }
  }
}

scan(repoRoot);

// 扫描面归零即失败关闭：若 EXCLUDED_DIRS 被写坏或仓库根不可读，findings 会恒为空，
// 门禁就变成一条永远报绿的空断言。scannedDirs 是「本门禁到底看了多少目录」的可核对
// 数字，一并输出——报绿时必须能自证它真的扫了东西。
if (scannedDirs < 2) {
  console.error(JSON.stringify({
    ok: false,
    code: 'PROBE_GATE_SCAN_VACUOUS',
    message: `扫描面异常：只遍历了 ${scannedDirs} 个目录。判据无法在空扫描面上成立，`
      + '失败关闭而不是报绿。检查仓库根是否可读、EXCLUDED_DIRS 是否被写坏。',
    scannedDirs
  }, null, 2));
  process.exit(1);
}

if (findings.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    code: 'SCRIPTS_PROBE_RESIDUAL',
    message: '仓库内存在残留的探针/临时文件。它们被 gitignore，git status 看不见，'
      + '只会静默累积。验证前必须删除。',
    residualCount: findings.length,
    scannedDirs,
    findings
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  message: '仓库内无残留探针/临时文件（零容忍）',
  scannedRoot: '.',
  scannedDirs,
  excludedDirs: [...EXCLUDED_DIRS],
  prefixes: [...RESIDUAL_PREFIXES],
  note: '本门禁拦的是残留而非存在：工作时临时建探针合法，提交/验证前删掉即可'
}, null, 2));
