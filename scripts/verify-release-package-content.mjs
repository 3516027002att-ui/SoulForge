import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  auditReleaseCompliance,
  loadReleasePolicy
} from './release-compliance-lib.mjs';

const root = resolve(import.meta.dirname, '..');
const { policy, findings: policyFindings } = loadReleasePolicy(root);
const git = spawnSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
  windowsHide: true
});
const trackedPaths = git.status === 0
  ? git.stdout.split('\0').filter(Boolean)
  : [];
const audit = await auditReleaseCompliance({ root, policy, trackedPaths });
const findings = [...policyFindings, ...audit.findings];
if (git.status !== 0) {
  findings.push({
    severity: 'error',
    code: 'GIT_TRACKED_FILE_SCAN_FAILED',
    path: '.git',
    message: '无法取得 git tracked file 集合。'
  });
}
const errors = findings.filter((item) => item.severity === 'error');
const result = {
  ok: errors.length === 0,
  status: errors.length === 0 ? 'partial' : 'failed',
  message: errors.length === 0
    ? '发行内容、许可证 inventory 与构建指纹门禁通过（partial）。'
    : '发行合规门禁失败。',
  trackedFileCount: trackedPaths.length,
  dependencyCount: audit.expected.licenses.packageCount,
  licenseExpressions: audit.expected.licenses.licenseExpressions,
  licenseTextCoverage: audit.expected.licenses.textCoverage,
  artifactCount: audit.expected.artifacts.fileCount,
  artifactFingerprint: audit.expected.artifacts.aggregateSha256,
  manifestSha256: audit.manifestSha256,
  findings,
  nonClaim: '本门禁不证明 third-party notice 文本完整、安装包签名、发布渠道或真实游戏验收。'
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
