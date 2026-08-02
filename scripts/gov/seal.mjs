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

export { computeFingerprint, formatBaseline, EVIDENCE };
