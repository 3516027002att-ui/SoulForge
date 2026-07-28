import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  RELEASE_MANIFEST_RELATIVE_PATH,
  createReleaseComplianceManifest,
  loadReleasePolicy,
  serializeReleaseManifest
} from './release-compliance-lib.mjs';

const root = resolve(import.meta.dirname, '..');
const { policy, findings: policyFindings } = loadReleasePolicy(root);
const manifest = await createReleaseComplianceManifest(root, policy);
const errors = [...policyFindings, ...manifest.diagnostics].filter((item) => item.severity === 'error');
if (errors.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    code: 'RELEASE_MANIFEST_GENERATION_FAILED',
    findings: errors
  }, null, 2));
  process.exitCode = 1;
} else {
  const outputPath = resolve(root, RELEASE_MANIFEST_RELATIVE_PATH);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeReleaseManifest(manifest), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    status: 'partial',
    message: 'release compliance manifest 已生成。',
    output: RELEASE_MANIFEST_RELATIVE_PATH,
    dependencyCount: manifest.licenses.packageCount,
    licenseTextCoverage: manifest.licenses.textCoverage,
    artifactCount: manifest.artifacts.fileCount,
    artifactFingerprint: manifest.artifacts.aggregateSha256,
    authority: manifest.authority,
    nonClaim: '许可证 metadata inventory 与 unsigned build fingerprint 不等于签名发行通过。'
  }, null, 2));
}
