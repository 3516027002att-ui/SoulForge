import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditInstallerCompliance,
  auditPackageTree,
  auditReleaseCompliance,
  installerArtifactName,
  loadReleasePolicy,
  UNPACKED_DIRECTORY_RELATIVE_PATH
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

const electronBuilderConfig = JSON.parse(
  readFileSync(resolve(root, 'apps/desktop/electron-builder.json'), 'utf8')
);
const desktopPkg = JSON.parse(
  readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')
);
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const installerRelativePath = `apps/desktop/release/${installerArtifactName(electronBuilderConfig, desktopPkg)}`;
const packageTree = auditPackageTree({
  root,
  unpackedDir: UNPACKED_DIRECTORY_RELATIVE_PATH,
  lock,
  executableName: `${electronBuilderConfig.productName}.exe`
});
const installerAudit = await auditInstallerCompliance({ root, installerRelativePath });

const findings = [
  ...policyFindings,
  ...audit.findings,
  ...packageTree.diagnostics,
  ...installerAudit.diagnostics
];
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
    ? '发行内容、许可证 inventory、构建指纹、package tree 与 installer 记录门禁通过（partial）。'
    : '发行合规门禁失败。',
  trackedFileCount: trackedPaths.length,
  dependencyCount: audit.expected.licenses.packageCount,
  licenseExpressions: audit.expected.licenses.licenseExpressions,
  licenseTextCoverage: audit.expected.licenses.textCoverage,
  artifactCount: audit.expected.artifacts.fileCount,
  artifactFingerprint: audit.expected.artifacts.aggregateSha256,
  manifestSha256: audit.manifestSha256,
  packageTree: {
    status: packageTree.status,
    fileCount: packageTree.fileCount,
    byteCount: packageTree.byteCount,
    asarEntryCount: packageTree.asarEntryCount,
    missingRequired: packageTree.missingRequired,
    missingRecommended: packageTree.missingRecommended,
    forbiddenHits: packageTree.forbiddenHits,
    optionalNotInstalledPresent: packageTree.optionalNotInstalledPresent
  },
  installer: {
    relativePath: installerRelativePath,
    status: installerAudit.status,
    installerManifestSha256: installerAudit.installerManifestSha256,
    artifact: installerAudit.expected.installer,
    sourceFingerprint: installerAudit.expected.sourceManifest?.artifactFingerprint ?? null,
    optionalNotInstalledCount: installerAudit.expected.optionalNotInstalledCount
  },
  findings,
  nonClaim: '本门禁不证明 third-party notice 文本完整、NSIS 安装/升级/卸载、外部分发或真实游戏验收。'
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
