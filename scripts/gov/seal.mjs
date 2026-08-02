/**
 * Evidence 重封存：把「跑过哪些命令、得到什么结论」固化为一条 sealed-current-run。
 *
 * 为什么必须是 CLI 而不是让 agent 手写 evidence.jsonl：
 *
 * 封存契约要求五字段指纹自洽——fingerprintSha256 必须等于前四字段的 canonical
 * payload 哈希，而 handoffSha256BeforeEvidenceAppend 顾名思义是「追加这条证据
 * 之前」的交接书哈希。手工流程是：先跑 handoff:fingerprint、把五个 64 位十六进制
 * 串抄进 JSONL、再跑门禁。抄错一位就是 EVIDENCE_SEAL_INVALID，而错在哪一位不会
 * 被指出（门禁只能说「与 canonical payload 不一致」）。
 *
 * 更致命的是顺序：证据一旦追加，交接书或治理数据再有任何改动，
 * handoffSha256BeforeEvidenceAppend 与 trackedDiffSha256 就都失效了。手工流程里
 * 「改完文件 → 算指纹 → 写证据」这三步之间任何一次补充修改都会静默毁掉封存，
 * 而失败要到下次跑门禁才暴露。
 *
 * 所以本模块把顺序固化：校验工作树干净 → 算指纹 → 追加 → 复验。任一步不成立就
 * 失败关闭，绝不写出一条自相矛盾的封存记录。
 *
 * 边界：本模块只搬运事实，不生产事实。commands / result / nonClaims 全部由调用方
 * 提供——「跑过什么、得到什么、不声明什么」只能由真正跑过命令的 agent 陈述。
 * 本模块不会替 agent 编造运行结论，也不提升任何 authority。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeHandoffFingerprintSha256 } from '../handoff-integrity-lib.mjs';

const EVIDENCE = 'docs/governance/evidence.jsonl';
const HANDOFF = 'docs/V0_5_IMPLEMENTATION_HANDOFF.md';

function git(root, args) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
}

/** git 输出转字符串并去掉尾随换行。 */
const text = (buffer) => buffer.toString('utf8').trim();

/**
 * 复算五字段指纹。
 *
 * 刻意复用 generate-handoff-fingerprint.mjs 的同一套 git 参数与
 * computeHandoffFingerprintSha256，而不是 spawn 那个脚本再解析它的 JSON：
 * 参数若有第二份写法，两处算出的 trackedDiffSha256 会在某些改动下分叉，
 * 而分叉的表现是「封存当时通过、门禁却判无效」——最难查的一类。
 *
 * 反过来说，这里必须与那个脚本保持逐参数一致。verify-seal-cli-fixtures.mjs
 * 用真实工作树逐字段比对两者输出，任何一侧漂移都会失败关闭。
 */
function computeFingerprint(root) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) {
    return { ok: false, code: 'SEAL_GIT_HEAD_UNAVAILABLE', message: '无法解析 HEAD；封存需要可复原的提交锚点。' };
  }

  const diff = git(root, [
    '-c', 'core.quotepath=true',
    'diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--diff-algorithm=myers', '--unified=3',
    '--src-prefix=a/', '--dst-prefix=b/',
    'HEAD', '--', '.', `:(top,exclude)${HANDOFF}`
  ]);
  if (diff.status !== 0) {
    return { ok: false, code: 'SEAL_GIT_DIFF_FAILED', message: '无法计算跟踪改动摘要。' };
  }

  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.status !== 0) {
    return { ok: false, code: 'SEAL_GIT_UNTRACKED_FAILED', message: '无法枚举未跟踪文件。' };
  }
  const raw = untracked.stdout;
  const paths = raw.length === 0
    ? []
    : raw.subarray(0, -1).toString('utf8').split('\0')
      .map((path) => path.replaceAll('\\', '/'))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));

  const manifest = createHash('sha256');
  for (const path of paths) {
    let content;
    try {
      content = readFileSync(join(root, ...path.split('/')));
    } catch (error) {
      return {
        ok: false,
        code: 'SEAL_UNTRACKED_READ_FAILED',
        message: `无法读取未跟踪文件 ${path}；指纹不可复算。`,
        extra: { causeCode: error.code ?? 'UNKNOWN' }
      };
    }
    manifest.update(Buffer.from(path, 'utf8'));
    manifest.update('\0');
    manifest.update(String(content.length));
    manifest.update('\0');
    manifest.update(createHash('sha256').update(content).digest('hex'));
    manifest.update('\0');
  }

  const handoff = createHash('sha256')
    .update(readFileSync(join(root, ...HANDOFF.split('/'))))
    .digest('hex');

  const fields = {
    head: text(head.stdout),
    trackedDiffSha256: createHash('sha256').update(diff.stdout).digest('hex'),
    untrackedManifestSha256: manifest.digest('hex'),
    handoffSha256BeforeEvidenceAppend: handoff
  };
  return {
    ok: true,
    fields,
    untrackedCount: paths.length,
    fingerprintSha256: computeHandoffFingerprintSha256(fields)
  };
}

/** 五字段指纹的封存基线字符串，格式必须与 parseSealBaseline 的解析口径一致。 */
function formatBaseline(fields, fingerprintSha256) {
  return `HEAD=${fields.head}; `
    + `trackedDiffSha256=${fields.trackedDiffSha256}; `
    + `untrackedManifestSha256=${fields.untrackedManifestSha256}; `
    + `handoffSha256BeforeEvidenceAppend=${fields.handoffSha256BeforeEvidenceAppend}; `
    + `fingerprintSha256=${fingerprintSha256}`;
}

/**
 * 列出封存刚刚改动、但仍未提交的治理文件。
 *
 * seal 会写 evidence.jsonl、按需写 gates.json、并把交接书重新投影，但它不提交
 * ——提交必须由调用方决定（提交信息、是否与实现改动同批）。问题是下一次 seal 的
 * 指纹锚点是 HEAD：这批改动留在工作区时，事实源 JSON 未入库而它的投影可能已经
 * 随别的提交进去了，证据链就与 HEAD 错位。
 *
 * 实测过一次：a237dce 之后 seal 写了 evidence.jsonl 与 gates.json，随后的提交
 * 只带了交接书散文，两个 JSON 一直悬在工作区。当时 seal 输出「governanceGate:
 * passed」，看不出还有未落库的东西。所以这里把它显式报出来。
 *
 * 只报告，不自动提交：seal 自作主张 commit 会把调用方尚未准备好的实现改动一起
 * 带进去，那比漏提交更难恢复。
 */
function collectUncommittedGovernanceFiles(root, candidatePaths) {
  const status = git(root, ['status', '--porcelain', '--', ...candidatePaths]);
  if (status.status !== 0) return null;
  // 不能用 text()：它会 trim，把首行前导空格吃掉（未暂存修改的状态码是 " M"），
  // 于是按固定 3 字符切片会多切一位。实测输出过 "ocs/V0_5_..." 这种缺首字母的
  // 路径——路径错了但看起来像对的，比不报更容易误导。
  return status.stdout.toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      // porcelain v1：前两列状态码 + 一个空格 + 路径；路径含特殊字符时带引号，
      // 重命名形如 `R  old -> new`（这里只取新路径）。
      const path = line.slice(3);
      const renamed = path.split(' -> ');
      return (renamed.length === 2 ? renamed[1] : path).replace(/^"|"$/g, '');
    });
}

export { computeFingerprint, formatBaseline, collectUncommittedGovernanceFiles, EVIDENCE, HANDOFF };
