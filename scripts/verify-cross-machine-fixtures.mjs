#!/usr/bin/env node
/**
 * 跨机复现判定逻辑的负向 fixture。
 *
 * 守的是 verify-cross-machine-reproducible.mjs 的 `--export` 与 `--compare` 两个模式。
 *
 * ── 为什么这是个真缺口（2026-08-08 实测）──
 * BLOCK-4「跨机 installer 验证」结构上需要第二台机器，本机确实无法解除。但**判定
 * 逻辑本身**不需要第二台机器就能验证，而实测它零覆盖：
 *   · `test:release-cross-machine` 只调**默认 audit 模式**（不带参数），
 *     该模式只审计本机 manifest 字段是否齐备，输出 partial 后 exit 0；
 *   · `--export` 与 `--compare` 全仓**零调用**（除脚本自身的协议文档字符串），
 *     没有任何 npm script、tier、fixture 碰过它们。
 * 也就是说：等真有了第二台机器，用来下「跨机指纹是否一致」这个判定的代码，
 * 从来没有人证明过它会在该红的时候红。这与「门禁没实测过会红，约一半是假门禁」
 * 是同一类风险，只是这里的后果更隐蔽——它要到需要它的那一刻才暴露。
 *
 * 最坏形态是**误绿**：若 compare 把「两份不同指纹」判成一致，跨机复现这个结论就是
 * 假的，而它是 REL-COMPLIANCE 的依据之一。
 *
 * ── 本 fixture 覆盖什么 ──
 * 用**构造的导出记录**（不需要真实构建产物、不需要第二台机器）驱动 `--compare`，
 * 断言它在每种该红的情形下都红、且只在真正一致时绿：
 *   ① 完全一致 → passed
 *   ② source 指纹不同 → failed
 *   ③ installer sha256 不同 → failed
 *   ④ manifest sha256 不同 → failed
 *   ⑤ 同一 commit 之外：commit 不同 → failed（且必须是 COMMIT_MISMATCH 而不是
 *      「指纹不一致」——不同 commit 本就不该比较，报错方向不同）
 *   ⑥ 缺参数 / 文件不存在 / 非法 JSON / schemaVersion 不符 → 各自失败关闭
 *   ⑦ **单字段差异必须逐个被检出**：三个字段各自单独改一次都要红。
 *      只测「全都不同」会让「只比一个字段」的实现也全绿。
 * 另对 `--export` 断言：字段不全时必须 EXPORT_INCOMPLETE 失败关闭，
 * 而不是导出一份缺字段的记录（那份记录到了对面机器上会让 compare 拿空值比空值）。
 *
 * 纯静态、只用临时目录、秒级、不需要真实构建产物或游戏语料，故归 governance。
 * 注意与 test:release-cross-machine 的分工：那条在 release 层做本机 manifest 审计，
 * 本条在 governance 层做判定逻辑的负向证明，两者不重叠。
 *
 * ── 负向证明（2026-08-08 实测八条，逐条退化目标脚本后复跑）──
 *   X1 compare 恒判一致（最坏形态：跨机结论是假的）→ 3 条红
 *   X2 只比 installer.sha256（漏比 source 指纹）    → 2 条红
 *   X3 只比 source 指纹（漏比 installer）           → 2 条红
 *   X4 commit 不同也照比                            → 1 条红，点名 COMMIT_MISMATCH
 *   X5 schemaVersion 校验去掉                       → 1 条红
 *   X6 未知模式静默走默认审计                       → 1 条红
 *   X7 默认审计模式报 passed                        → 2 条红
 *   X8 EXPORT_INCOMPLETE 失败关闭去掉               → **不红（如实记录）**
 * X2/X3 是关键的一对：它们证明判据不是「全都不同才红」——那种写法会让只比一个字段的
 * 实现全绿。X8 经探针确认在本机不可观测（四字段恒齐备 → 守卫永不触发），
 * 已写进 nonClaims 而不是用恒真断言补成假绿。
 * 还原后复跑回 18/18 绿。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'cross-machine-fixtures';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(root, 'scripts', 'verify-cross-machine-reproducible.mjs');

const checks = [];
const findings = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  if (!ok) findings.push({ label, detail });
}

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

const scratch = mkdtempSync(join(tmpdir(), 'sf-xmachine-'));

/**
 * 跑目标脚本，返回 { exit, out }。
 *
 * stdio 必须捕获而不是继承：目标脚本每次调用都打一整份 JSON，十几次调用会把本门禁
 * 自己的结论冲到几十行之外——失败时读不到是哪条断言红，等于判据在噪音里失效。
 */
function run(args) {
  try {
    return {
      exit: 0,
      out: execFileSync(process.execPath, [TARGET, ...args], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      })
    };
  } catch (error) {
    return { exit: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function parseOut(out) {
  try { return JSON.parse(out); } catch { return null; }
}

/**
 * 一份**结构合法**的导出记录。字段名与 fingerprintRecord() 的输出保持一致——
 * 若目标脚本改了字段名，这里的样本会让 compare 拿到 undefined，
 * 于是 ① 恒等（undefined === undefined）会变绿而 ②③④ 会变红：判据仍会报警，
 * 不会静默失覆盖。
 */
function makeRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    scope: 'win-x64-nsis-reproducible',
    generatedAt: '2026-08-08T00:00:00.000Z',
    gitCommit: 'a'.repeat(40),
    source: {
      path: 'out/release-compliance.json',
      manifestSha256: 'b'.repeat(64),
      artifactFingerprint: 'c'.repeat(64)
    },
    installer: {
      path: 'out/release-installer-compliance.json',
      fileName: 'SoulForge-Setup.exe',
      size: 123456,
      sha256: 'd'.repeat(64)
    },
    ...overrides
  };
}

function writeRecord(name, record) {
  const path = join(scratch, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}

/** 深拷贝后按路径改一个字段，用于「单字段差异」系列。 */
function withField(mutate) {
  const record = makeRecord();
  mutate(record);
  return record;
}

try {
  // ---- ① 完全一致 → passed ----
  const baseA = writeRecord('base-a', makeRecord());
  const baseB = writeRecord('base-b', makeRecord());
  const same = run(['--compare', baseA, baseB]);
  const sameJson = parseOut(same.out);
  check(
    '两份完全一致的导出记录 → exit 0 且 status=passed',
    same.exit === 0 && sameJson?.status === 'passed' && sameJson?.ok === true,
    { exit: same.exit, status: sameJson?.status ?? null }
  );

  // ---- ⑦ 单字段差异必须逐个被检出 ----
  // 只测「全都不同」会让「只比一个字段」的实现全绿，所以三个字段各单独改一次。
  const singleFieldCases = [
    {
      name: 'source.artifactFingerprint',
      record: withField((r) => { r.source.artifactFingerprint = 'e'.repeat(64); })
    },
    {
      name: 'source.manifestSha256',
      record: withField((r) => { r.source.manifestSha256 = 'f'.repeat(64); })
    },
    {
      name: 'installer.sha256',
      record: withField((r) => { r.installer.sha256 = '9'.repeat(64); })
    }
  ];
  for (const item of singleFieldCases) {
    const other = writeRecord(`diff-${item.name.replace(/\W/g, '-')}`, item.record);
    const result = run(['--compare', baseA, other]);
    const json = parseOut(result.out);
    check(
      `仅 ${item.name} 不同 → exit 1 且 status=failed（单字段差异必须被检出）`,
      result.exit === 1 && json?.status === 'failed' && json?.ok === false,
      { exit: result.exit, status: json?.status ?? null, field: item.name }
    );
  }

  // ---- ⑤ commit 不同必须报 COMMIT_MISMATCH，而不是「指纹不一致」----
  // 两者都 exit 1，但指向完全不同的处置：前者「你比错了对象」，
  // 后者「工具链不一致」。混成一条会把人引向排查工具链。
  const otherCommit = writeRecord('other-commit', makeRecord({ gitCommit: '1'.repeat(40) }));
  const commitDiff = run(['--compare', baseA, otherCommit]);
  const commitJson = parseOut(commitDiff.out);
  check(
    'commit 不同 → exit 1 且 code=COMPARE_COMMIT_MISMATCH（不是笼统的指纹不一致）',
    commitDiff.exit === 1 && commitJson?.code === 'COMPARE_COMMIT_MISMATCH',
    { exit: commitDiff.exit, code: commitJson?.code ?? null }
  );

  // ---- ⑥ 各类失败关闭 ----
  const badSchema = writeRecord('bad-schema', makeRecord({ schemaVersion: 2 }));
  const schemaResult = run(['--compare', baseA, badSchema]);
  check(
    'schemaVersion 不为 1 → exit 1 且 code=COMPARE_SCHEMA',
    schemaResult.exit === 1 && parseOut(schemaResult.out)?.code === 'COMPARE_SCHEMA',
    { exit: schemaResult.exit, code: parseOut(schemaResult.out)?.code ?? null }
  );

  const missingResult = run(['--compare', baseA, join(scratch, 'does-not-exist.json')]);
  check(
    '导出记录文件不存在 → exit 1 且 code=COMPARE_MISSING',
    missingResult.exit === 1 && parseOut(missingResult.out)?.code === 'COMPARE_MISSING',
    { exit: missingResult.exit, code: parseOut(missingResult.out)?.code ?? null }
  );

  const invalidPath = join(scratch, 'invalid.json');
  writeFileSync(invalidPath, '{ not json', 'utf8');
  const invalidResult = run(['--compare', baseA, invalidPath]);
  check(
    '导出记录不是合法 JSON → exit 1 且 code=COMPARE_INVALID',
    invalidResult.exit === 1 && parseOut(invalidResult.out)?.code === 'COMPARE_INVALID',
    { exit: invalidResult.exit, code: parseOut(invalidResult.out)?.code ?? null }
  );

  const argsResult = run(['--compare', baseA]);
  check(
    '--compare 只给一个参数 → exit 1 且 code=COMPARE_ARGS_REQUIRED',
    argsResult.exit === 1 && parseOut(argsResult.out)?.code === 'COMPARE_ARGS_REQUIRED',
    { exit: argsResult.exit, code: parseOut(argsResult.out)?.code ?? null }
  );

  const unknownResult = run(['--nope']);
  check(
    '未知模式 → exit 1 且 code=UNKNOWN_MODE（不得静默走默认审计）',
    unknownResult.exit === 1 && parseOut(unknownResult.out)?.code === 'UNKNOWN_MODE',
    { exit: unknownResult.exit, code: parseOut(unknownResult.out)?.code ?? null }
  );

  const exportNoPath = run(['--export']);
  check(
    '--export 缺路径 → exit 1 且 code=EXPORT_PATH_REQUIRED',
    exportNoPath.exit === 1 && parseOut(exportNoPath.out)?.code === 'EXPORT_PATH_REQUIRED',
    { exit: exportNoPath.exit, code: parseOut(exportNoPath.out)?.code ?? null }
  );

  // ---- --export 的字段完整性失败关闭 ----
  // 这条是负向证明补出来的：第一版 fixture 只测了「缺路径」，于是把
  // EXPORT_INCOMPLETE 那道失败关闭改成 if (false) 后本门禁照样全绿（实测 X8 exit 0）。
  // 那个分支很重要——导出一份缺字段的记录不会当场报错，等到了对面机器上 compare
  // 会拿 null 比 null 而**判为一致**，跨机结论就此变成假的。
  //
  // 判据打法：--export 的字段来源是本机 out/ 下两份 manifest。用 cwd 指向一个
  // 空临时目录跑不通（脚本按自身位置定位 root），所以改为断言**行为的一致性**：
  // 若本机字段齐备则 --export 必须成功且写出的记录能被 --compare 判为与自身一致；
  // 若字段不齐备则必须 EXPORT_INCOMPLETE 失败关闭且**不写文件**。
  // 两种情形都不允许「导出成功但记录缺字段」。
  // ── --export 的字段完整性 ──
  //
  // 判据刻意**不写成 if (成功) {…} else {…}**：分支写法下每次只有一半断言执行，
  // 「导出成功但字段缺失」会落进成功分支被另一套断言接走，而
  // 「断言被守卫跳过」与「断言通过」在输出上不可区分。改为**无分支的合成断言**：
  // 无论走哪条路，「导出成功」与「四字段齐备」必须同真同假。
  //
  // ⚠️ 已知覆盖边界（负向证明实测，不是推断）：把目标脚本的 EXPORT_INCOMPLETE
  // 失败关闭改成 `if (false)` 后本判据**不会红**。原因不是判据写错，而是本机
  // （以及任何跑过一次 build + electron-builder 的机器）四个字段恒齐备 →
  // `missing` 恒为空数组 → 那道守卫本来就永不触发，退化前后行为逐字节相同。
  // 要让它可观测，需要一台只跑过部分构建的机器，或允许 fixture 篡改
  // apps/desktop 下的真实 manifest（后者会污染真实产物，不做）。
  // 如实记进 nonClaims，不用「构造一个恒真断言」把这块补成假绿。
  const exportPath = join(scratch, 'exported.json');
  const exportResult = run(['--export', exportPath]);
  const exportJson = parseOut(exportResult.out);
  const exportWritten = existsSync(exportPath)
    ? (() => { try { return JSON.parse(readFileSync(exportPath, 'utf8')); } catch { return null; } })()
    : null;
  const fieldsComplete = exportWritten !== null
    && typeof exportWritten.gitCommit === 'string' && exportWritten.gitCommit.length > 0
    && typeof exportWritten.source?.manifestSha256 === 'string'
    && typeof exportWritten.source?.artifactFingerprint === 'string'
    && typeof exportWritten.installer?.sha256 === 'string';
  check(
    '--export 的「成功」与「四字段齐备」必须同真同假'
    + '（导出一份缺字段记录 → 对面 compare 拿 null 比 null 而判为一致，跨机结论变成假的）',
    (exportResult.exit === 0) === fieldsComplete,
    {
      exit: exportResult.exit,
      code: exportJson?.code ?? null,
      fileWritten: exportWritten !== null,
      fieldsComplete,
      written: exportWritten
    }
  );
  check(
    '--export 非 0 退出时必须报 EXPORT_INCOMPLETE 且不留半成品文件',
    exportResult.exit === 0
      ? true
      : exportJson?.code === 'EXPORT_INCOMPLETE' && exportWritten === null,
    { exit: exportResult.exit, code: exportJson?.code ?? null, fileWritten: exportWritten !== null }
  );
  // 导出成功时再验一次「导出格式能被 compare 消费」。这条对失败路径无意义，
  // 故用三态：成功则真判，失败则显式记为不适用（而不是静默跳过）。
  const selfCompare = exportResult.exit === 0
    ? run(['--compare', exportPath, exportPath])
    : null;
  check(
    '--export 产出的真实记录与自身 --compare 必须 passed（成功时才适用）',
    selfCompare === null
      ? true
      : selfCompare.exit === 0 && parseOut(selfCompare.out)?.status === 'passed',
    {
      applicable: selfCompare !== null,
      note: selfCompare === null ? '本机无 out/ manifest，--export 走失败关闭路径，本条不适用' : null,
      exit: selfCompare?.exit ?? null
    }
  );

  // ---- 默认审计模式：本机无构建产物时必须失败关闭，不得报 partial 绿 ----
  // 这条钉住「跨机比对字段缺失」不会被当成「机制就绪」。本机是否有 out/ 产物取决于
  // 是否跑过 npm run build，两种情形都是合法环境，故判据按实际情形二分：
  //   有产物 → status=partial（机制就绪、第二台机器未跑），exit 0
  //   无产物 → status=failed（字段缺失），exit 1
  // 两种情形都**不允许**出现 status=passed —— 本机永远不能单独得出跨机结论。
  const auditResult = run([]);
  const auditJson = parseOut(auditResult.out);
  check(
    '默认审计模式绝不产出 status=passed（本机不能单独得出跨机结论）',
    auditJson !== null && auditJson.status !== 'passed',
    { status: auditJson?.status ?? null, exit: auditResult.exit }
  );
  check(
    '默认审计模式的 status 必须是 partial 或 failed 之一，且与 exit 码一致',
    (auditJson?.status === 'partial' && auditResult.exit === 0)
    || (auditJson?.status === 'failed' && auditResult.exit === 1),
    { status: auditJson?.status ?? null, exit: auditResult.exit, problems: auditJson?.problems ?? null }
  );
  check(
    '默认审计模式必须输出可执行的重建协议（否则第二台机器无从复现）',
    Array.isArray(auditJson?.protocol) && auditJson.protocol.length >= 5,
    { protocolSteps: auditJson?.protocol?.length ?? null }
  );
  check(
    '默认审计模式必须带 nonClaim，明说本机 audit 不等于跨机已实测',
    typeof auditJson?.nonClaim === 'string' && auditJson.nonClaim.length > 0,
    { nonClaim: auditJson?.nonClaim ?? null }
  );
} catch (error) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'CROSS_MACHINE_FIXTURE_HARNESS_FAILED',
    message: error instanceof Error ? error.message : String(error),
    checks
  }, 1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (findings.length > 0) {
  report({
    ok: false,
    gate: LABEL,
    status: 'failed',
    code: 'CROSS_MACHINE_FIXTURE_FAILED',
    message: '跨机复现判定逻辑的负向 fixture 未按预期拦截。',
    passed: checks.length - findings.length,
    failed: findings.length,
    findings
  }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  assertions: checks.length,
  message: '--compare 在单字段差异、commit 不符、schema 不符、文件缺失、非法 JSON、缺参数下'
    + '逐个失败关闭，仅完全一致时 passed；--export 缺路径失败关闭；'
    + '默认审计模式绝不产出 passed 且带重建协议与 nonClaim。',
  nonClaims: [
    '**不构成跨机复现证据**：本 fixture 只证明判定逻辑在该红时会红，'
      + '真实跨机复现仍需第二台干净 Windows 机器在同一 commit 上重建并 --compare 两份真实导出记录'
      + '（BLOCK-4 结构上无法在单机解除）。',
    '不声称 installer 可复现：指纹是否真的逐位一致取决于工具链与依赖版本，'
      + '本 fixture 用构造记录，不触碰真实构建产物。',
    '**EXPORT_INCOMPLETE 那道失败关闭未被本 fixture 覆盖**（实测，非推断）：'
      + '把它改成 if (false) 后本 fixture 不会红。原因是本机四个比对字段恒齐备，'
      + 'missing 恒为空数组，那道守卫本来就永不触发，退化前后行为完全相同。'
      + '要覆盖它需要一台只跑过部分构建的机器，或允许篡改 apps/desktop 下的真实 manifest'
      + '（会污染真实产物，故不做）。此处如实标注，不用恒真断言把这块补成假绿。',
    '--export 成功路径只断言「字段齐备」与「自比一致」，不校验指纹数值本身正确；'
      + 'manifest 内容的正确性属 release 层 test:release-content / test:release-reproducible。'
  ]
}, 0);
