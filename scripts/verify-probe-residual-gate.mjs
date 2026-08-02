/**
 * 探针/临时文件零容忍门禁。
 *
 * 探针本身是合法工具：定位「某条断言到底有没有执行」时，往 scripts/ 插一个
 * `_probe*.mjs` 打印分支与 payload 是既有做法。问题出在**残留**——它们用完
 * 留在原地，而 `.gitignore` 又把 `scripts/_tmp_*` 之类忽略掉，于是 `git status`
 * 永远干净，没有任何信号提醒它们还在。实测 2026-08-02 在 scripts/ 一次清出 16 个
 * 这类文件，最早的建于半个月前，跨半个月无人发现。纯约定不带门禁 = 迟早失效。
 *
 * 所以判据是「验证时 scripts/ 下不得存在这类文件」，而不是「任何时候都不得创建」：
 * 工作时临时建一个探针完全合法，只要提交/验证前删掉。本门禁跑在 governance 层，
 * 拦的是残留，不是存在。
 *
 * 判据形态刻意是「扫 scripts/ 的实际文件名」而非「维护一份黑名单」——只迭代自己
 * 清单的门禁从不扫仓库，是已实测的假门禁形态之一。递归扫描，命中前缀 `_probe` /
 * `_tmp` 的文件或目录即违规；命中目录就报告该目录本身、不再下钻。
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const SCRIPTS_DIR = join(repoRoot, 'scripts');

/** 残留探针/临时文件的前缀。basename 以这些开头即视为残留。 */
const RESIDUAL_PREFIXES = Object.freeze(['_probe', '_tmp']);

function isResidual(name) {
  return RESIDUAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const findings = [];

function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (isResidual(entry)) {
      const kind = statSync(absolute).isDirectory() ? 'directory' : 'file';
      findings.push({
        file: relative(repoRoot, absolute).split('\\').join('/'),
        kind,
        code: 'PROBE_FILE_RESIDUAL',
        message: `scripts/ 下残留了 ${kind === 'directory' ? '临时目录' : '探针/临时文件'}。`
          + ' 探针是合法调试工具，但用完必须删除——它被 .gitignore 忽略，不进 git status，'
          + ' 没有任何别的信号会提醒它还在。请删除后重跑。'
      });
      // 命中目录就报告目录本身，不再下钻：残留目录整体删掉即可，逐个列举其内容
      // 只会让诊断变长，不增加信息。
      continue;
    }
    if (statSync(absolute).isDirectory()) {
      scan(absolute);
    }
  }
}

scan(SCRIPTS_DIR);

if (findings.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    code: 'SCRIPTS_PROBE_RESIDUAL',
    message: 'scripts/ 下存在残留的探针/临时文件。它们被 gitignore，git status 看不见，'
      + '只会静默累积。验证前必须删除。',
    residualCount: findings.length,
    findings
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  message: 'scripts/ 下无残留探针/临时文件（零容忍）',
  scannedDir: 'scripts/',
  prefixes: [...RESIDUAL_PREFIXES],
  note: '本门禁拦的是残留而非存在：工作时临时建探针合法，提交/验证前删掉即可'
}, null, 2));
