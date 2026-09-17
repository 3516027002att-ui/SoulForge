import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assetPath,
  hashFile,
  isSha256,
  isSha512Base64,
  parseLatestYml,
  parseSha256Sums,
  readJson,
  readProjectVersion,
  releaseAssetNames,
  releaseDirectory,
  releaseTag,
  releaseVersion,
  ReleaseUpdateAssetError,
  regularFile,
  structuredError
} from './release-update-assets-lib.mjs';

const root = resolve(import.meta.dirname, '..');

try {
  const args = process.argv.slice(2);
  const project = await readProjectVersion(root);
  const version = releaseVersion(args, project.version);
  const tag = releaseTag(args, version);
  const directory = await releaseDirectory(root, args);
  const names = releaseAssetNames(version);
  const required = [names.installer, names.blockmap, names.latest, names.checksums, names.compliance, names.source];
  const files = new Map();
  for (const name of required) {
    const path = await assetPath(root, directory, name);
    const stats = await regularFile(path, name);
    files.set(name, { path, size: stats.size, sha256: await hashFile(path, 'sha256', 'hex') });
  }

  const latestSource = await readFile(files.get(names.latest).path, 'utf8');
  const latest = parseLatestYml(latestSource, names.installer);
  if (latest.version !== version || latest.path !== names.installer) {
    throw new ReleaseUpdateAssetError('RELEASE_LATEST_YML_INVALID', `latest.yml 必须声明版本 ${version} 和安装包 ${names.installer}。`, names.latest);
  }
  const installer = files.get(names.installer);
  const installerSha512 = await hashFile(installer.path, 'sha512', 'base64');
  if (!isSha512Base64(latest.sha512) || latest.sha512 !== installerSha512) {
    throw new ReleaseUpdateAssetError('RELEASE_LATEST_YML_HASH_MISMATCH', 'latest.yml 的 SHA-512 与安装包不一致。', names.latest);
  }
  if (latest.size !== installer.size) {
    throw new ReleaseUpdateAssetError('RELEASE_LATEST_YML_INVALID', 'latest.yml 的安装包大小与实际文件不一致。', names.latest);
  }

  const sums = parseSha256Sums(await readFile(files.get(names.checksums).path, 'utf8'));
  const checksumNames = [...sums.keys()].sort((left, right) => left.localeCompare(right));
  const expectedNames = [names.installer, names.blockmap, names.latest, names.compliance, names.source].sort((left, right) => left.localeCompare(right));
  if (checksumNames.length !== expectedNames.length || checksumNames.some((name, index) => name !== expectedNames[index])) {
    throw new ReleaseUpdateAssetError('RELEASE_SHA256SUMS_INVALID', 'SHA256SUMS.txt 必须且只能记录五个 Release 资产（不包含自身）。', names.checksums);
  }
  for (const name of expectedNames) {
    const actual = files.get(name).sha256;
    if (!isSha256(sums.get(name)) || sums.get(name) !== actual) {
      throw new ReleaseUpdateAssetError('RELEASE_SHA256SUMS_MISMATCH', `SHA256SUMS.txt 与资产不一致：${name}。`, names.checksums);
    }
  }

  const compliance = await readJson(files.get(names.compliance).path, 'RELEASE_COMPLIANCE_INVALID', names.compliance);
  if (compliance?.installer?.fileName !== names.installer
    || compliance?.installer?.size !== installer.size
    || typeof compliance?.installer?.sha256 !== 'string'
    || compliance.installer.sha256.toLowerCase() !== installer.sha256) {
    throw new ReleaseUpdateAssetError('RELEASE_COMPLIANCE_MISMATCH', 'release-installer-compliance.json 未绑定当前版本的安装包 hash/size。', names.compliance);
  }

  console.log(JSON.stringify({
    ok: true,
    status: 'passed',
    tag,
    version,
    fixedRepository: '3516027002att-ui/SoulForge',
    assets: required.map((name) => ({ name, size: files.get(name).size, sha256: files.get(name).sha256 })),
    latestYml: { path: latest.path, size: latest.size, sha512: latest.sha512 },
    nonClaim: '本地资产校验不证明 GitHub Release 已创建、上传成功、签名存在或跨机器安装已验收。'
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, status: 'failed', ...structuredError(error) }, null, 2));
  process.exitCode = 1;
}
