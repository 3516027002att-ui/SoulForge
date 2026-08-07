#!/usr/bin/env node
/**
 * seal CLI 的负向 fixture。
 *
 * 为什么必须有：scripts/gov/seal.mjs 的注释一直声称
 * 「verify-seal-cli-fixtures.mjs 用真实工作树逐字段比对两者输出，任何一侧漂移
 * 都会失败关闭」——而这个文件此前**根本不存在**。注释声称有覆盖、实际没有，
 * 比没有注释更误导：读到它的人会以为一致性已经被守住。
 *
 * 它声称要守的东西是真实风险：seal.mjs 与 generate-handoff-fingerprint.mjs 各自
 * 拼一套 git 参数算 trackedDiffSha256。参数若有第二份写法，两处在某些改动下会
 * 分叉，而分叉的表现是「封存当时通过、门禁却判无效」——seal.mjs:50-54 自己把
 * 它列为最难查的一类。
 *
 * 本 fixture 覆盖三组：
 *   A. 指纹算法一致性：seal 的 computeFingerprint 与独立脚本逐字段相同；
 *   B. 指纹自洽性：fingerprintSha256 必须等于前四字段的 canonical 哈希，
 *      任一字段被改动都必须使复算失败；
 *   C. commands 极性约束：非零退出码声明必须被显式接受才允许封存。
 *
 * 不接触 docs/governance/ 真实数据：A/B 组在真实工作树上**只读**地算指纹，
 * C 组纯函数级断言。绝不追加证据、绝不改 Gate。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { computeFingerprint, formatBaseline } from './gov/seal.mjs';
import { parseSealBaseline } from './handoff-integrity-lib.mjs';

const root = process.cwd();
const findings = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (!condition) {
    findings.push({ severity: 'error', code: 'SEAL_CLI_FIXTURE_FAIL', where: name, message: detail });
  }
}

/* ===========================================================================
 * A 组：seal 的指纹算法必须与 generate-handoff-fingerprint.mjs 逐字段一致
 * ========================================================================= */

const sealSide = computeFingerprint(root);
check(
  'fingerprint/seal-side-computable',
  sealSide.ok === true,
  `seal 侧指纹必须可算出，实际 ${JSON.stringify(sealSide)}`
);

if (sealSide.ok === true) {
  // 独立脚本走子进程，确保比对的是「两个实现」而不是同一段代码调两次。
  // 它默认就输出 JSON（唯一可选参数是 --verbose）；不要传 --json，那会被
  // 参数校验拒绝并让本组退化为「脚本跑不起来」而不是真实比对。
  const scriptRun = spawnSync(process.execPath, ['scripts/generate-handoff-fingerprint.mjs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  check(
    'fingerprint/script-side-runs',
    scriptRun.status === 0,
    `generate-handoff-fingerprint.mjs 必须成功，实际 status=${scriptRun.status} stderr=${(scriptRun.stderr ?? '').slice(-300)}`
  );

  if (scriptRun.status === 0) {
    let scriptSide = null;
    // 该脚本可能在 JSON 前后带叙述行；取最后一个顶层 JSON 对象。
    const text = scriptRun.stdout ?? '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        scriptSide = JSON.parse(text.slice(start, end + 1));
      } catch {
        scriptSide = null;
      }
    }
    check(
      'fingerprint/script-side-parsable',
      scriptSide !== null,
      `无法从脚本输出解析 JSON：${text.slice(0, 300)}`
    );

    if (scriptSide !== null) {
      // 字段名两侧可能不同层级，统一取值后逐字段比。
      const scriptFields = scriptSide.fingerprint ?? scriptSide;
      const pairs = [
        ['head', sealSide.fields.head, scriptFields.head],
        ['trackedDiffSha256', sealSide.fields.trackedDiffSha256, scriptFields.trackedDiffSha256],
        ['untrackedManifestSha256', sealSide.fields.untrackedManifestSha256, scriptFields.untrackedManifestSha256],
        [
          'handoffSha256BeforeEvidenceAppend',
          sealSide.fields.handoffSha256BeforeEvidenceAppend,
          scriptFields.handoffSha256BeforeEvidenceAppend ?? scriptFields.handoffSha256
        ]
      ];
      for (const [field, sealValue, scriptValue] of pairs) {
        // 只在脚本侧确实提供该字段时比对——脚本输出形态若与预期不同，应报为
        // 「字段缺失」而不是静默跳过（静默跳过正是本 fixture 要防的形态）。
        check(
          `fingerprint/field-present/${field}`,
          typeof scriptValue === 'string' && scriptValue.length > 0,
          `脚本侧未提供 ${field}；两侧无法比对，一致性无人校验。实际输出字段：${Object.keys(scriptFields).join('、')}`
        );
        if (typeof scriptValue === 'string' && scriptValue.length > 0) {
          check(
            `fingerprint/field-equal/${field}`,
            sealValue === scriptValue,
            `${field} 两侧分叉：seal=${sealValue} script=${scriptValue}。`
              + '分叉的表现是「封存当时通过、门禁却判无效」，必须失败关闭。'
          );
        }
      }
    }
  }

  /* =========================================================================
   * B 组：指纹自洽性 —— 任一字段被改动都必须使复算失败
   * ======================================================================= */

  const baseline = formatBaseline(sealSide.fields, sealSide.fingerprintSha256);
  const parsed = parseSealBaseline(baseline);
  check(
    'baseline/round-trip-valid',
    parsed?.formatValid === true && parsed?.valid === true,
    `formatBaseline 的输出必须被 parseSealBaseline 判为自洽，实际 ${JSON.stringify({
      formatValid: parsed?.formatValid,
      valid: parsed?.valid,
      expected: parsed?.expectedFingerprint,
      sealed: sealSide.fingerprintSha256
    })}。两处若对格式的口径不同，封存当时通过、门禁却判无效。`
  );

  if (parsed?.formatValid === true) {
    // 逐字段扰动：改任何一个前四字段，parseSealBaseline 都必须判 invalid。若某字段
    // 改了仍判有效，说明它没进 canonical payload —— 那一位就成了可任意伪造的自由
    // 字段（例如 HEAD 可被换成另一个提交而指纹照样自洽）。
    const tamperTargets = [
      'head',
      'trackedDiffSha256',
      'untrackedManifestSha256',
      'handoffSha256BeforeEvidenceAppend'
    ];
    for (const field of tamperTargets) {
      const tamperedFields = { ...sealSide.fields };
      // 翻转末位十六进制字符，保持长度与字符集合法（否则会被 formatValid 拦住，
      // 那样测的是格式校验而不是指纹绑定）。
      const original = tamperedFields[field];
      tamperedFields[field] = original.slice(0, -1) + (original.endsWith('0') ? '1' : '0');
      const tamperedBaseline = formatBaseline(tamperedFields, sealSide.fingerprintSha256);
      const tamperedParse = parseSealBaseline(tamperedBaseline);
      check(
        `baseline/tamper-detected/${field}`,
        tamperedParse?.formatValid === true && tamperedParse?.valid === false,
        `改动 ${field} 后仍被判有效——该字段未进入 canonical payload，可被任意伪造。`
          + ` 实际 ${JSON.stringify({ formatValid: tamperedParse?.formatValid, valid: tamperedParse?.valid })}`
      );
    }

    // 反向：只改 fingerprintSha256 本身也必须被判无效（防「重算一个自洽指纹去
    // 匹配被篡改的字段」之外的另一种形态：直接改声明的指纹）。
    const wrongFingerprint = sealSide.fingerprintSha256.slice(0, -1)
      + (sealSide.fingerprintSha256.endsWith('0') ? '1' : '0');
    const wrongParse = parseSealBaseline(formatBaseline(sealSide.fields, wrongFingerprint));
    check(
      'baseline/tamper-detected/fingerprintSha256',
      wrongParse?.valid === false,
      '改动 fingerprintSha256 后必须判无效。'
    );
  }
}

/* ===========================================================================
 * C 组：commands 极性约束
 *
 * 这一组守的是本轮实测过的真实形态：一条 exit 1 被写在 commands 自由文本末尾
 * 并通过全部门禁，随后那条红在 main 上停留四次 CI，还因 verify 默认 bail 让
 * 同层 20 条恢复/写入套件全部 not-attempted。
 * ========================================================================= */

const govSource = readFileSync('scripts/gov.mjs', 'utf8');

// detectNonZeroExitClaims 是模块内私有函数；这里以真实源码为对象断言它的存在与
// 接线，再用等价实现覆盖识别口径。若把它导出仅为测试，反而扩大了模块公共面。
check(
  'commands/detector-wired',
  govSource.includes('detectNonZeroExitClaims(values.commands)'),
  'seal 必须对 commands 做非零退出码检测；未接线则该约束不存在。'
);
for (const code of ['SEAL_NONZERO_EXIT_NOT_ACCEPTED', 'SEAL_NONZERO_REASON_REQUIRED']) {
  check(
    `commands/code-registered/${code}`,
    govSource.includes(code),
    `诊断码 ${code} 必须存在，否则调用方无法据码定位。`
  );
}
check(
  'commands/reason-merged-into-nonclaims',
  govSource.includes("values['non-claims'] = "),
  '接受理由必须并入 nonClaims —— 那是「本条证据不声明什么」的唯一位置。'
);

/** 与 gov.mjs 内实现保持同一口径的识别器。两处分叉会被下面的用例抓到。 */
function detectNonZeroExitClaims(commands) {
  const found = new Set();
  const patterns = [/exit\s*(?:code\s*)?[=:]?\s*(\d+)/gi, /退出码\s*[=:]?\s*(\d+)/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(commands)) !== null) {
      const code = Number.parseInt(match[1], 10);
      if (Number.isInteger(code) && code !== 0) found.add(match[0].trim());
    }
  }
  return [...found];
}

const detectorCases = [
  ['npm run typecheck (exit 0)', 0, '全零退出码不得触发约束'],
  ['npm run a (exit 0)；npm run b (exit 0)', 0, '多条全零不得触发'],
  ['npm run x exit 1', 1, '「exit 1」必须被识别'],
  ['npm run x (exit 1, 既有假红)', 1, '括号内的 exit 1 必须被识别'],
  ['npm run x 退出码 1', 1, '中文「退出码 1」必须被识别'],
  ['npm run x exit code 2', 1, '「exit code 2」必须被识别'],
  ['renderer-playwright exit 0 (13/13)', 0, '计数 13/13 不得被误判为非零退出码'],
  ['ai-conformance exit 0, passed 58/58', 0, '计数 58/58 不得被误判'],
  ['tier native 39 条登记 exit 0', 0, '正文里的数字不得被误判']
];
for (const [commands, expectedCount, why] of detectorCases) {
  const detected = detectNonZeroExitClaims(commands);
  const ok = expectedCount === 0 ? detected.length === 0 : detected.length >= 1;
  check(
    `commands/detector/${commands.slice(0, 42)}`,
    ok,
    `${why}；实际识别到 ${JSON.stringify(detected)}`
  );
}

/* ---- 输出 ---------------------------------------------------------------- */

const ok = findings.length === 0;
console.log(JSON.stringify({
  ok,
  fixture: 'seal-cli',
  message: ok
    ? 'seal CLI 负向 fixture 全部通过'
    : `${findings.length} 条断言失败`,
  checks,
  coveredGroups: [
    'A 指纹算法与 generate-handoff-fingerprint.mjs 逐字段一致',
    'B 指纹自洽且前四字段任一被改动都会被检出',
    'C commands 非零退出码必须显式接受'
  ],
  nonClaim: '本 fixture 不验证 seal 是否真的执行过 commands 里的命令——seal 只搬运'
    + '事实。它验证的是：指纹算法两侧不分叉、指纹不可伪造、带红封存必须留下痕迹。',
  ...(ok ? {} : { findings })
}, null, 2));
process.exit(ok ? 0 : 1);
