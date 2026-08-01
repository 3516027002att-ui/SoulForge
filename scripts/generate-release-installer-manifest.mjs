import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  INSTALLER_MANIFEST_RELATIVE_PATH,
  createInstallerComplianceManifest,
  installerArtifactName
} from './release-compliance-lib.mjs';

const root = resolve(import.meta.dirname, '..');
const desktopPkg = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'));
const electronBuilderConfig = JSON.parse(
  await readFile(resolve(root, 'apps/desktop/electron-builder.json'), 'utf8')
);
const installerRelativePath = `apps/desktop/release/${installerArtifactName(electronBuilderConfig, desktopPkg)}`;
const manifest = await createInstallerComplianceManifest({ root, installerRelativePath });
const errors = manifest.diagnostics.filter((item) => item.severity === 'error');
if (errors.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    status: 'failed',
    code: 'INSTALLER_MANIFEST_GENERATION_FAILED',
    findings: errors
  }, null, 2));
  process.exitCode = 1;
} else {
  const outputPath = resolve(root, INSTALLER_MANIFEST_RELATIVE_PATH);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    status: 'partial',
    message: 'installer compliance manifest 已生成。',
    output: INSTALLER_MANIFEST_RELATIVE_PATH,
    installer: manifest.installer,
    sourceFingerprint: manifest.sourceManifest?.artifactFingerprint ?? null,
    optionalNotInstalledCount: manifest.optionalNotInstalledCount,
    authority: manifest.authority,
    nonClaim: 'NSIS 安装包 hash 记录不证明安装/升级/卸载、外部分发或签名发布完成。'
  }, null, 2));
}
